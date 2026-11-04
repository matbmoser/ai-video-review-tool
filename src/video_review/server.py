"""Local HTTP server for the review UI (Python standard library only).

Routes (``<v>`` is the URL-encoded file name of a video in the workspace)
------------------------------------------------------------------------
``GET  /``                                   the review UI
``GET  /static/<file>``                      UI assets
``GET  /api/workspace``                      workspace info and the list of videos
``PUT  /api/videos/<v>``                     upload a video (raw request body)
``GET  /media/<v>``                          a video, with HTTP range support for seeking
``GET  /api/videos/<v>/config``              fps, transcript and review folder of a video
``PUT  /api/videos/<v>/transcript``          upload a transcript (``?filename=voice.srt``)
``GET  /api/videos/<v>/review``              the saved notes (``notes.json``)
``POST /api/videos/<v>/review``              save notes + screenshots, regenerate ``REVIEW.md``
``POST /api/videos/<v>/review/archive``      move the current round to ``rounds/<n>/``
``GET  /api/videos/<v>/shots/<id>.<ext>``    a saved screenshot
``GET  /api/videos/<v>/markdown``            ``REVIEW.md`` as text (for pasting into a chat)
``GET  /api/videos/<v>/export``              the review folder as a zip file

The server binds to ``127.0.0.1`` by default, rejects requests whose ``Host`` header is not the address
it listens on (protection against DNS rebinding) and rejects cross-origin writes.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import socket
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlsplit

from . import __version__
from .store import KINDS, ReviewError, render_markdown
from .workspace import TRANSCRIPT_EXTENSIONS, VIDEO_EXTENSIONS, Workspace, WorkspaceError

STATIC_DIR = Path(__file__).resolve().parent / "static"
MAX_JSON_BYTES = 200 * 1024 * 1024
_CHUNK = 1 << 20
_LOOPBACK_NAMES = {"localhost", "127.0.0.1", "::1", "[::1]"}

for _ext, _type in ((".mp4", "video/mp4"), (".m4v", "video/mp4"), (".webm", "video/webm"),
                    (".mov", "video/quicktime"), (".ogv", "video/ogg"), (".mkv", "video/x-matroska"),
                    (".js", "text/javascript"), (".svg", "image/svg+xml"), (".vtt", "text/vtt")):
    mimetypes.add_type(_type, _ext)

_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
        "style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"
    ),
}


class ReviewApp:
    """Everything the request handler needs: the workspace and UI settings."""

    def __init__(self, workspace: Workspace, title: str | None = None) -> None:
        self.workspace = workspace
        self.title = title

    def workspace_info(self) -> dict[str, Any]:
        ws = self.workspace
        return {
            "version": __version__,
            "title": self.title,
            "workspace": ws.root.name or str(ws.root),
            "fps": ws.fps,
            "uploads": ws.uploads,
            "maxUploadBytes": ws.max_upload_bytes,
            "videoExtensions": list(VIDEO_EXTENSIONS),
            "transcriptExtensions": list(TRANSCRIPT_EXTENSIONS),
            "videos": [ws.summary(p.name) for p in ws.videos()],
        }

    def video_config(self, name: str) -> dict[str, Any]:
        ws = self.workspace
        path = ws.require(name)
        store = ws.store(name)
        tpath = ws.transcript_path(name)
        return {
            "name": name,
            "title": self.title or name,
            "url": f"/media/{quote(name)}?v={int(path.stat().st_mtime)}",
            "type": mimetypes.guess_type(name)[0],
            "fps": ws.fps,
            "kinds": list(KINDS),
            "transcript": ws.transcript(name),
            "transcriptFile": tpath.name if tpath else None,
            "reviewFolder": store.folder.name,
            "reviewPath": str(store.folder),
            "rounds": store.rounds(),
        }


def make_handler(app: ReviewApp, allowed_hosts: set | None = None) -> type:
    """Create a request handler class bound to ``app``."""
    ws = app.workspace

    class Handler(BaseHTTPRequestHandler):
        server_version = f"video-review/{__version__}"
        protocol_version = "HTTP/1.1"

        # ── dispatch ─────────────────────────────────────────────────────────────────────────
        def do_GET(self) -> None:  # noqa: N802 (http.server naming)
            self._read(head=False)

        def do_HEAD(self) -> None:  # noqa: N802
            self._read(head=True)

        def do_POST(self) -> None:  # noqa: N802
            self._write("POST")

        def do_PUT(self) -> None:  # noqa: N802
            self._write("PUT")

        def _read(self, head: bool) -> None:
            if not self._host_ok():
                return self._error(HTTPStatus.FORBIDDEN, "unexpected Host header")
            url = urlsplit(self.path)
            path = url.path
            if path in ("/", "/index.html"):
                return self._file(STATIC_DIR / "index.html", head)
            if path == "/favicon.ico":
                return self._file(STATIC_DIR / "favicon.svg", head, cache=True)
            if path.startswith("/static/"):
                target = _safe_child(STATIC_DIR, unquote(path[len("/static/"):]))
                return self._file(target, head) if target else self._not_found()
            if path == "/api/workspace":
                return self._json(app.workspace_info(), head=head)
            if path.startswith("/media/"):
                video = ws.video_path(unquote(path[len("/media/"):]))
                return self._file(video, head, ranges=True) if video else self._not_found()
            parts = _video_route(path)
            if parts is None:
                return self._not_found()
            name, rest = parts
            if ws.video_path(name) is None:
                return self._not_found()
            try:
                if rest == ["config"]:
                    return self._json(app.video_config(name), head=head)
                if rest == ["review"]:
                    return self._json(ws.store(name).load(), head=head)
                if len(rest) == 2 and rest[0] == "shots":
                    shot = ws.store(name).shot_file(f"shots/{rest[1]}")
                    return self._file(shot, head) if shot else self._not_found()
                if rest == ["markdown"]:
                    return self._bytes(render_markdown(ws.store(name).load()).encode("utf-8"),
                                       "text/markdown; charset=utf-8", head)
                if rest == ["export"]:
                    return self._bytes(ws.export_zip(name), "application/zip", head,
                                       filename=ws.store(name).folder.name + ".zip")
            except ReviewError as exc:
                return self._json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR, head=head)
            return self._not_found()

        def _write(self, method: str) -> None:
            if not self._host_ok() or not self._origin_ok():
                self._drain()
                return self._error(HTTPStatus.FORBIDDEN, "cross-origin request refused")
            url = urlsplit(self.path)
            parts = _video_route(url.path)
            if parts is None:
                self._drain()
                return self._not_found()
            name, rest = parts
            try:
                if method == "PUT" and rest == []:
                    return self._upload_video(name)
                if ws.video_path(name) is None:
                    self._drain()
                    return self._not_found()
                if method == "PUT" and rest == ["transcript"]:
                    filename = parse_qs(url.query).get("filename", ["transcript.json"])[0]
                    data = self._read_body(limit=10 * 1024 ** 2)
                    if data is None:
                        return None
                    segments = ws.save_transcript(name, filename, data)
                    return self._json({"transcript": segments, "summary": ws.summary(name)})
                if method == "POST" and rest == ["review"]:
                    body = self._read_json()
                    if body is None:
                        return None
                    return self._json(ws.store(name).save(body))
                if method == "POST" and rest == ["review", "archive"]:
                    self._drain()
                    store = ws.store(name)
                    return self._json({"archived": store.archive(), "rounds": store.rounds()})
            except (ReviewError, WorkspaceError) as exc:
                return self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            self._drain()
            return self._not_found()

        def _upload_video(self, name: str) -> None:
            length = self._content_length()
            if length is None or length > ws.max_upload_bytes:
                self.close_connection = True
                limit_mb = ws.max_upload_bytes // 1024 ** 2
                return self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                                   f"the video is larger than the upload limit of {limit_mb} MB")
            try:
                saved = ws.receive_video(name, self.rfile, length)
            except WorkspaceError as exc:
                self.close_connection = True  # the body may not have been read completely
                return self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return self._json(ws.summary(saved), HTTPStatus.CREATED)

        # ── security checks ──────────────────────────────────────────────────────────────────
        def _host_ok(self) -> bool:
            if allowed_hosts is None:
                return True
            host = (self.headers.get("Host") or "").strip().lower()
            host = host.split("]")[0] + "]" if host.startswith("[") else re.sub(r":\d+$", "", host)
            return host in allowed_hosts

        def _origin_ok(self) -> bool:
            origin = self.headers.get("Origin")
            if not origin:
                return True  # same-origin requests from curl, scripts and tests
            return urlsplit(origin).netloc.lower() == (self.headers.get("Host") or "").lower()

        # ── request bodies ───────────────────────────────────────────────────────────────────
        def _content_length(self) -> int | None:
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                return None
            return length if length >= 0 else None

        def _read_body(self, limit: int) -> bytes | None:
            length = self._content_length()
            if length is None or length > limit:
                self.close_connection = True
                self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body missing or too large")
                return None
            return self.rfile.read(length) if length else b""

        def _read_json(self) -> Any:
            raw = self._read_body(MAX_JSON_BYTES)
            if raw is None:
                return None
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/json":
                self._error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "expected application/json")
                return None
            try:
                return json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._error(HTTPStatus.BAD_REQUEST, "invalid JSON")
                return None

        def _drain(self) -> None:
            length = self._content_length() or 0
            if 0 < length <= MAX_JSON_BYTES:
                self.rfile.read(length)
            elif length:
                self.close_connection = True

        # ── responses ────────────────────────────────────────────────────────────────────────
        def _json(self, data: Any, status: HTTPStatus = HTTPStatus.OK, head: bool = False) -> None:
            self._bytes(json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8",
                        head, status=status)

        def _bytes(self, body: bytes, ctype: str, head: bool, status: HTTPStatus = HTTPStatus.OK,
                   filename: str | None = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if filename:
                self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(filename)}")
            self.end_headers()
            if not head:
                self.wfile.write(body)

        def _error(self, status: HTTPStatus, message: str) -> None:
            self._json({"error": message}, status)

        def _not_found(self) -> None:
            self._error(HTTPStatus.NOT_FOUND, "not found")

        def _file(self, path: Path | None, head: bool, cache: bool = False, ranges: bool = False) -> None:
            if path is None:
                return self._not_found()
            try:
                size = path.stat().st_size
                fh = open(path, "rb")
            except OSError:
                return self._not_found()
            with fh:
                ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
                start, end, status = 0, size - 1, HTTPStatus.OK
                rng = self.headers.get("Range") if ranges else None
                if rng:
                    parsed = parse_range(rng, size)
                    if parsed is None:
                        self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return None
                    start, end = parsed
                    status = HTTPStatus.PARTIAL_CONTENT
                length = max(0, end - start + 1)
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(length))
                if ranges:
                    self.send_header("Accept-Ranges", "bytes")
                if status == HTTPStatus.PARTIAL_CONTENT:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("Cache-Control", "max-age=3600" if cache else "no-store")
                self.end_headers()
                if head or length == 0:
                    return None
                fh.seek(start)
                left = length
                while left > 0:
                    chunk = fh.read(min(_CHUNK, left))
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        break  # the browser cancelled the request (normal while seeking)
                    left -= len(chunk)
            return None

        def end_headers(self) -> None:
            for key, value in _SECURITY_HEADERS.items():
                self.send_header(key, value)
            super().end_headers()

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            if os.environ.get("VIDEO_REVIEW_DEBUG"):
                super().log_message(format, *args)

    return Handler


def _video_route(path: str) -> tuple[str, list[str]] | None:
    """Split ``/api/videos/<name>/<rest...>`` into (name, rest). Segments are URL-decoded one by one."""
    prefix = "/api/videos/"
    if not path.startswith(prefix):
        return None
    segments = path[len(prefix):].split("/")
    if not segments or not segments[0]:
        return None
    decoded = [unquote(s) for s in segments]
    if any("/" in s or "\\" in s or s in (".", "..") for s in decoded):
        return None
    return decoded[0], [s for s in decoded[1:] if s]


def parse_range(header: str, size: int) -> tuple[int, int] | None:
    """Parse a single ``bytes=`` range. Returns (start, end) inclusive, or None if unsatisfiable."""
    m = re.fullmatch(r"\s*bytes=(\d*)-(\d*)\s*", header)
    if not m or size <= 0:
        return None
    first, last = m.groups()
    if first == "" and last == "":
        return None
    if first == "":
        suffix = int(last)
        if suffix == 0:
            return None
        return max(0, size - suffix), size - 1
    start = int(first)
    end = int(last) if last else size - 1
    if start >= size or end < start:
        return None
    return start, min(end, size - 1)


def _safe_child(root: Path, relative: str) -> Path | None:
    """Resolve ``relative`` inside ``root``; None if it escapes ``root`` or is not a file."""
    try:
        target = (root / relative).resolve()
        target.relative_to(root.resolve())
    except (ValueError, OSError):
        return None
    return target if target.is_file() else None


def allowed_hosts_for(host: str) -> set | None:
    """Host header names accepted for a bind address (None = accept any, for 0.0.0.0 / ::)."""
    host = host.lower()
    if host in ("0.0.0.0", "::", ""):
        return None
    names = {host, f"[{host}]"}
    if host in _LOOPBACK_NAMES:
        names |= _LOOPBACK_NAMES
    return names


def create_server(app: ReviewApp, host: str = "127.0.0.1", port: int = 8765) -> ThreadingHTTPServer:
    """Create (but do not start) the HTTP server. Use port 0 for a free port."""
    server_cls = _ThreadingHTTPServerV6 if ":" in host else ThreadingHTTPServer
    server = server_cls((host, port), make_handler(app, allowed_hosts_for(host)))
    server.daemon_threads = True
    return server


class _ThreadingHTTPServerV6(ThreadingHTTPServer):
    address_family = socket.AF_INET6
