"""A workspace is a folder of videos; every video gets its own review folder next to it.

::

    my-renders/
    ├── launch.mp4
    ├── launch.transcript.json   (optional voice-over / subtitles, found automatically)
    ├── launch.review/           (notes.json, REVIEW.md, shots/, rounds/)
    ├── teaser.webm
    └── teaser.review/

Videos can be added by copying them into the folder or by uploading them in the browser.
Uploading a file with the name of an existing video replaces the video but keeps its review, so a new
render can be checked against the notes of the previous one.
"""

from __future__ import annotations

import io
import os
import re
import shutil
import tempfile
import threading
import zipfile
from pathlib import Path
from typing import Any, BinaryIO

from .store import ReviewStore
from .transcript import TranscriptError, load_transcript

VIDEO_EXTENSIONS = (".mp4", ".m4v", ".webm", ".mov", ".ogv", ".mkv")
TRANSCRIPT_EXTENSIONS = (".json", ".srt", ".vtt")
DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 ** 3  # 20 GB
MAX_TRANSCRIPT_BYTES = 10 * 1024 ** 2

_UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9._ ()+\-\[\]]+")
_CHUNK = 1 << 20


class WorkspaceError(ValueError):
    """Raised for invalid file names, unsupported files or failed uploads (HTTP 400)."""


def safe_video_name(name: str) -> str:
    """Turn an uploaded file name into a safe, flat file name with a video extension."""
    base = os.path.basename(str(name).replace("\\", "/")).strip()
    base = _UNSAFE_CHARS.sub("_", base).strip(" .")
    stem, ext = os.path.splitext(base)
    if not stem or ext.lower() not in VIDEO_EXTENSIONS:
        raise WorkspaceError(f"unsupported video file name {name!r} (use {', '.join(VIDEO_EXTENSIONS)})")
    if len(base) > 180:
        base = stem[: 180 - len(ext)] + ext
    return base


class Workspace:
    """Lists the videos of a folder and hands out one :class:`ReviewStore` per video."""

    def __init__(self, root: str | Path, fps: float = 30.0, uploads: bool = True,
                 max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES) -> None:
        self.root = Path(root).resolve()
        self.fps = float(fps)
        self.uploads = uploads
        self.max_upload_bytes = max_upload_bytes
        self._review_dirs: dict[str, Path] = {}
        self._transcripts: dict[str, Path] = {}
        self._stores: dict[str, ReviewStore] = {}
        self._transcript_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
        self._lock = threading.Lock()

    # ── configuration from the command line ──────────────────────────────────────────────────
    def pin_review_dir(self, name: str, folder: str | Path) -> None:
        """Use ``folder`` as the review folder of video ``name`` (``--review-dir``)."""
        self._review_dirs[name] = Path(folder).resolve()

    def pin_transcript(self, name: str, path: str | Path) -> None:
        """Use ``path`` as the transcript of video ``name`` (``--transcript``)."""
        self._transcripts[name] = Path(path).resolve()

    # ── videos ───────────────────────────────────────────────────────────────────────────────
    def videos(self) -> list[Path]:
        """Video files in the workspace, newest first."""
        if not self.root.is_dir():
            return []
        files = [p for p in self.root.iterdir()
                 if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS and not p.name.startswith(".")]
        return sorted(files, key=lambda p: (-p.stat().st_mtime, p.name.lower()))

    def video_path(self, name: str) -> Path | None:
        """The video called ``name``, or None. Only plain names of existing videos resolve."""
        if not name or "/" in name or "\\" in name or name.startswith("."):
            return None
        path = self.root / name
        if path.suffix.lower() not in VIDEO_EXTENSIONS or not path.is_file():
            return None
        return path

    def require(self, name: str) -> Path:
        path = self.video_path(name)
        if path is None:
            raise KeyError(name)
        return path

    def review_dir(self, name: str) -> Path:
        return self._review_dirs.get(name) or self.root / (Path(name).stem + ".review")

    def store(self, name: str) -> ReviewStore:
        with self._lock:
            store = self._stores.get(name)
            if store is None:
                store = ReviewStore(self.review_dir(name), video_name=name, fps=self.fps)
                self._stores[name] = store
            return store

    # ── transcripts ──────────────────────────────────────────────────────────────────────────
    def transcript_path(self, name: str) -> Path | None:
        """The pinned transcript, or ``<stem>.transcript.<ext>``, ``<stem>.srt``, ``<stem>.vtt``."""
        pinned = self._transcripts.get(name)
        if pinned is not None:
            return pinned
        stem = Path(name).stem
        candidates = [self.root / f"{stem}.transcript{ext}" for ext in TRANSCRIPT_EXTENSIONS]
        candidates += [self.root / f"{stem}.srt", self.root / f"{stem}.vtt"]
        return next((p for p in candidates if p.is_file()), None)

    def transcript(self, name: str) -> list[dict[str, Any]]:
        path = self.transcript_path(name)
        if path is None or not path.is_file():
            return []
        mtime = path.stat().st_mtime
        cached = self._transcript_cache.get(str(path))
        if cached and cached[0] == mtime:
            return cached[1]
        try:
            segments = load_transcript(path)
        except TranscriptError:
            segments = []
        self._transcript_cache[str(path)] = (mtime, segments)
        return segments

    def save_transcript(self, name: str, filename: str, data: bytes) -> list[dict[str, Any]]:
        """Validate and store an uploaded transcript as ``<stem>.transcript.<ext>``."""
        self.require(name)
        if not self.uploads:
            raise WorkspaceError("uploads are disabled (--no-upload)")
        ext = Path(filename).suffix.lower()
        if ext not in TRANSCRIPT_EXTENSIONS:
            raise WorkspaceError("transcripts must be .json, .srt or .vtt files")
        if len(data) > MAX_TRANSCRIPT_BYTES:
            raise WorkspaceError("transcript is larger than 10 MB")
        stem = Path(name).stem
        target = self.root / f"{stem}.transcript{ext}"
        with tempfile.TemporaryDirectory() as tmp:  # parse before replacing anything
            probe = Path(tmp) / f"probe{ext}"
            probe.write_bytes(data)
            try:
                segments = load_transcript(probe)
            except TranscriptError as exc:
                raise WorkspaceError(str(exc)) from exc
        for other in TRANSCRIPT_EXTENSIONS:
            old = self.root / f"{stem}.transcript{other}"
            if old != target and old.is_file():
                old.unlink()
        _atomic_write(target, data)
        self._transcripts.pop(name, None)  # an uploaded transcript replaces a pinned one
        return segments

    # ── deleting ─────────────────────────────────────────────────────────────────────────────
    def delete_video(self, name: str, with_review: bool = False) -> dict[str, Any]:
        """Delete video ``name`` from the workspace; with ``with_review`` also its review folder and transcript.

        Only files the workspace manages are removed: the video itself, the review folder next to it
        (``<stem>.review/``, not one pinned with ``--review-dir``) and a transcript next to it (not one
        pinned with ``--transcript``). Deleting needs uploads to be allowed.
        """
        if not self.uploads:
            raise WorkspaceError("deleting videos is turned off for this review (--no-upload)")
        path = self.require(name)
        removed = [path.name]
        with self._lock:
            path.unlink()
            self._stores.pop(name, None)
            self._transcript_cache.pop(name, None)
        if with_review:
            folder = self.root / (Path(name).stem + ".review")
            if name not in self._review_dirs and folder.is_dir() and not folder.is_symlink():
                shutil.rmtree(folder)
                removed.append(folder.name + "/")
            if name not in self._transcripts:
                transcript = self.transcript_path(name)
                if transcript is not None and transcript.parent == self.root:
                    transcript.unlink()
                    removed.append(transcript.name)
        return {"deleted": name, "removed": removed, "review": with_review}

    # ── uploads ──────────────────────────────────────────────────────────────────────────────
    def receive_video(self, filename: str, stream: BinaryIO, length: int) -> str:
        """Stream an uploaded video of ``length`` bytes into the workspace. Returns its file name."""
        if not self.uploads:
            raise WorkspaceError("uploads are disabled (--no-upload)")
        name = safe_video_name(filename)
        if length <= 0:
            raise WorkspaceError("the upload is empty")
        if length > self.max_upload_bytes:
            limit_mb = self.max_upload_bytes // 1024 ** 2
            raise WorkspaceError(f"the video is larger than the upload limit of {limit_mb} MB")
        self.root.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".upload-", suffix=Path(name).suffix, dir=str(self.root))
        try:
            left = length
            with os.fdopen(fd, "wb") as fh:
                while left > 0:
                    chunk = stream.read(min(_CHUNK, left))
                    if not chunk:
                        raise WorkspaceError("the upload was interrupted")
                    fh.write(chunk)
                    left -= len(chunk)
            os.replace(tmp, self.root / name)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
        return name

    # ── summaries / export ───────────────────────────────────────────────────────────────────
    def summary(self, name: str) -> dict[str, Any]:
        path = self.require(name)
        stat = path.stat()
        info: dict[str, Any] = {"name": name, "size": stat.st_size, "modified": int(stat.st_mtime),
                                "notes": 0, "open": 0, "transcript": None}
        try:
            notes = self.store(name).load().get("notes", [])
            info["notes"] = len(notes)
            info["open"] = sum(1 for n in notes if n.get("status") != "done")
        except ValueError:
            pass
        tpath = self.transcript_path(name)
        if tpath is not None:
            info["transcript"] = tpath.name
        return info

    def export_zip(self, name: str) -> bytes:
        """The review folder of ``name`` (current round and earlier rounds) as a zip file."""
        store = self.store(name)
        buf = io.BytesIO()
        top = store.folder.name
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            if store.folder.is_dir():
                for path in sorted(store.folder.rglob("*")):
                    if path.is_file() and not path.name.startswith("."):
                        zf.write(path, f"{top}/{path.relative_to(store.folder).as_posix()}")
            tpath = self.transcript_path(name)
            if tpath is not None and tpath.is_file():
                zf.write(tpath, f"{top}/transcript{tpath.suffix.lower()}")
        return buf.getvalue()


def _atomic_write(path: Path, data: bytes) -> None:
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
