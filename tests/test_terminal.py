import sys
import time

import pytest

from video_review.terminal import TerminalError, TerminalManager

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="the terminal needs a POSIX pseudo-terminal")


def read_until(session, needle, timeout=10.0):
    """Collect output until ``needle`` shows up (or fail)."""
    data, offset, end = b"", 0, time.time() + timeout
    while time.time() < end:
        chunk, offset, exited = session.read(offset, timeout=0.5)
        data += chunk
        if needle in data:
            return data
        if exited and not chunk:
            break
    raise AssertionError(f"{needle!r} not in output: {data!r}")


@pytest.fixture
def manager(tmp_path):
    script = tmp_path / "fake-claude"
    script.write_text('#!/bin/sh\necho "started: $*"\nwhile read line; do echo "got: $line"; done\n')
    script.chmod(0o755)
    mgr = TerminalManager(str(script), tmp_path)
    yield mgr
    mgr.shutdown()


def test_unavailable_reasons(tmp_path):
    assert "turned off" in TerminalManager(enabled=False).unavailable_reason()
    missing = TerminalManager("surely-not-a-real-program-xyz", tmp_path)
    assert ("not found" if sys.platform != "win32" else "macOS or Linux") in missing.unavailable_reason()
    assert missing.status()["available"] is False
    with pytest.raises(TerminalError):
        missing.start()
    with pytest.raises(TerminalError):
        missing.require()


@posix_only
def test_start_with_prompt_input_and_stop(manager, tmp_path):
    session = manager.start(80, 24, prompt="implement my review")
    assert manager.start() is session  # one session at a time
    read_until(session, b"started: implement my review")
    session.write(b"hello\r")
    read_until(session, b"got: hello")
    session.paste("second message")  # the fake program did not ask for bracketed paste: plain text
    read_until(session, b"got: second message")
    session.resize(120, 40)
    status = manager.status()
    assert status["running"] and status["cwd"] == str(tmp_path.resolve())
    manager.stop()
    assert not session.running and manager.status()["running"] is False
    with pytest.raises(TerminalError):
        session.write(b"x")


@posix_only
def test_backlog_offsets_and_exit(tmp_path):
    script = tmp_path / "once"
    script.write_text('#!/bin/sh\necho one; echo two\n')
    script.chmod(0o755)
    mgr = TerminalManager(str(script), tmp_path)
    session = mgr.start()
    read_until(session, b"two")
    deadline = time.time() + 5
    while session.running and time.time() < deadline:
        time.sleep(0.05)
    assert session.exit_code == 0
    everything, total, exited = session.read(0, timeout=0)
    assert exited and b"one" in everything and total == len(everything)
    rest, _, _ = session.read(total - 5, timeout=0)
    assert rest == everything[-5:]


@posix_only
def test_bracketed_paste_when_the_program_asks_for_it(tmp_path):
    script = tmp_path / "paste"
    # announce bracketed paste mode, then dump the 39 bytes of the paste + Enter
    script.write_text("#!/bin/sh\nstty raw -echo\nprintf '\\033[?2004hready\\n'\nhead -c 39 | tr '\\033\\r' 'E_'\n")
    script.chmod(0o755)
    mgr = TerminalManager(str(script), tmp_path)
    try:
        session = mgr.start()
        read_until(session, b"ready")
        assert session.bracketed_paste
        session.paste("hi there" + " " * 18)
        out = read_until(session, b"E[201~_")
        assert b"E[200~hi there" in out
    finally:
        mgr.shutdown()
