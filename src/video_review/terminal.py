"""An embedded terminal that runs Claude Code next to the review (macOS / Linux).

The review page shows the terminal in a drawer (xterm.js). This module starts the program in a
pseudo-terminal, keeps the recent output so the page can reconnect, and passes keystrokes and window
size changes through. Only one session runs at a time; it runs as you, in the project folder.

The program is fixed when the server starts (``--claude-command``, default ``claude``); the page cannot
choose what is executed. The terminal is only offered when the server listens on a loopback address.
"""

from __future__ import annotations

import os
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

try:  # POSIX only
    import fcntl
    import pty  # noqa: F401  (availability check)
    import struct
    import termios
except ImportError:  # pragma: no cover - Windows
    fcntl = None  # type: ignore[assignment]

MAX_BACKLOG = 2 * 1024 * 1024
_READ_SIZE = 64 * 1024

# Runs in the child: make the pseudo-terminal the controlling terminal, then become the real program.
_LAUNCHER = (
    "import fcntl, os, sys, termios\n"
    "fcntl.ioctl(0, termios.TIOCSCTTY, 0)\n"
    "os.execvp(sys.argv[1], sys.argv[1:])\n"
)


class TerminalError(RuntimeError):
    """The terminal cannot be started or used (reported to the page)."""


class TerminalSession:
    """One program running in a pseudo-terminal."""

    def __init__(self, argv: list[str], cwd: Path, cols: int = 100, rows: int = 30,
                 env: dict[str, str] | None = None) -> None:
        if fcntl is None:
            raise TerminalError("the terminal needs macOS or Linux (on Windows use WSL)")
        self.argv = argv
        self.cwd = cwd
        master, slave = os.openpty()
        _set_size(master, cols, rows)
        child_env = dict(os.environ if env is None else env)
        child_env.update({"TERM": "xterm-256color", "COLORTERM": "truecolor"})
        try:
            self.process = subprocess.Popen(
                [sys.executable, "-c", _LAUNCHER, *argv], cwd=str(cwd), env=child_env,
                stdin=slave, stdout=slave, stderr=slave, start_new_session=True, close_fds=True)
        except OSError as exc:
            os.close(master)
            os.close(slave)
            raise TerminalError(f"cannot start {argv[0]}: {exc}") from exc
        os.close(slave)
        self.fd = master
        self.started = time.time()
        self.exit_code: int | None = None
        self.bracketed_paste = False  # the program asked for bracketed paste (ESC [ ? 2004 h)
        self._buf = bytearray()
        self._total = 0  # bytes produced since start; offsets in the stream are relative to this
        self._cond = threading.Condition()
        self._reader = threading.Thread(target=self._read_loop, name="terminal-reader", daemon=True)
        self._reader.start()

    # ── output ───────────────────────────────────────────────────────────────────────────────
    def _read_loop(self) -> None:
        while True:
            try:
                chunk = os.read(self.fd, _READ_SIZE)
            except OSError:  # EIO when the program exits and the pty closes
                chunk = b""
            if not chunk:
                break
            on, off = chunk.rfind(b"\x1b[?2004h"), chunk.rfind(b"\x1b[?2004l")
            if on != off:
                self.bracketed_paste = on > off
            with self._cond:
                self._buf += chunk
                self._total += len(chunk)
                if len(self._buf) > MAX_BACKLOG:
                    del self._buf[: len(self._buf) - MAX_BACKLOG]
                self._cond.notify_all()
        code = self.process.wait()
        with self._cond:
            self.exit_code = code
            self._cond.notify_all()
        try:
            os.close(self.fd)
        except OSError:
            pass

    @property
    def running(self) -> bool:
        return self.exit_code is None

    def read(self, offset: int, timeout: float = 15.0) -> tuple[bytes, int, bool]:
        """Output after ``offset`` (waits up to ``timeout`` for new output). Returns (data, new offset, exited)."""
        with self._cond:
            if self._total <= offset and self.exit_code is None:
                self._cond.wait(timeout)
            start = self._total - len(self._buf)
            offset = max(offset, start)
            data = bytes(self._buf[offset - start:])
            return data, self._total, self.exit_code is not None

    # ── input ────────────────────────────────────────────────────────────────────────────────
    def write(self, data: bytes) -> None:
        if not self.running:
            raise TerminalError("the program has exited")
        view = memoryview(data)
        while view:
            written = os.write(self.fd, view)
            view = view[written:]

    def paste(self, text: str, submit: bool = True) -> None:
        """Type ``text`` like a paste (bracketed if the program supports it), then press Enter."""
        data = text.encode("utf-8")
        self.write(b"\x1b[200~" + data + b"\x1b[201~" if self.bracketed_paste else data)
        if submit:
            time.sleep(0.15)  # let the program process the paste before Enter submits it
            self.write(b"\r")

    def resize(self, cols: int, rows: int) -> None:
        if self.running:
            _set_size(self.fd, cols, rows)

    def stop(self, grace: float = 2.0) -> None:
        if not self.running:
            return
        try:
            os.killpg(self.process.pid, signal.SIGHUP)
        except OSError:
            pass
        deadline = time.time() + grace
        while self.running and time.time() < deadline:
            time.sleep(0.05)
        if self.running:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except OSError:
                pass


class TerminalManager:
    """Holds the (single) terminal session of the review server."""

    def __init__(self, command: str = "claude", cwd: str | Path = ".", enabled: bool = True,
                 disabled_reason: str | None = None) -> None:
        self.command = shlex.split(command, posix=os.name != "nt") if command else []
        self.cwd = Path(cwd).resolve()
        self.enabled = enabled
        self.disabled_reason = disabled_reason
        self.session: TerminalSession | None = None
        self._lock = threading.Lock()

    def unavailable_reason(self) -> str | None:
        if not self.enabled:
            return self.disabled_reason or "the terminal is turned off (--no-terminal)"
        if fcntl is None:
            return "the terminal needs macOS or Linux (on Windows run the tool in WSL)"
        if not self.command:
            return "no command configured (--claude-command)"
        if shutil.which(self.command[0]) is None:
            return (f"'{self.command[0]}' was not found. Install Claude Code "
                    "(https://claude.com/claude-code) or set --claude-command")
        if not self.cwd.is_dir():
            return f"the project folder does not exist: {self.cwd}"
        return None

    def status(self) -> dict[str, Any]:
        s = self.session
        return {
            "available": self.unavailable_reason() is None,
            "reason": self.unavailable_reason(),
            "command": " ".join(shlex.quote(a) for a in self.command),
            "cwd": str(self.cwd),
            "running": bool(s and s.running),
            "exitCode": s.exit_code if s else None,
        }

    def start(self, cols: int = 100, rows: int = 30, prompt: str | None = None) -> TerminalSession:
        reason = self.unavailable_reason()
        if reason:
            raise TerminalError(reason)
        with self._lock:
            if self.session and self.session.running:
                return self.session
            argv = list(self.command)
            if prompt:
                argv.append(prompt)  # Claude Code starts an interactive session with this first message
            self.session = TerminalSession(argv, self.cwd, cols=_clamp(cols, 20, 500), rows=_clamp(rows, 5, 200))
            return self.session

    def require(self) -> TerminalSession:
        if self.session is None:
            raise TerminalError("no terminal is running; start one first")
        return self.session

    def stop(self) -> None:
        if self.session:
            self.session.stop()

    def shutdown(self) -> None:
        self.stop()


def _clamp(value: Any, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return lo


def _set_size(fd: int, cols: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", _clamp(rows, 5, 200), _clamp(cols, 20, 500), 0, 0))
