"""The review folder: validates notes coming from the browser and writes them to disk.

Layout of a review folder::

    <video>.review/
      notes.json        machine-readable notes (the source of truth)
      REVIEW.md         the same notes as Markdown, written for humans and AI agents
      shots/<id>.jpg    the paused frame of each note, with the mark drawn on it
      rounds/<n>/       earlier review rounds, moved here by "Start new round"

Everything written here comes from the local browser, but it is still validated strictly:
note ids are integers, coordinates are clamped to the frame, texts are length-limited and
screenshots must be real base64 JPEG/PNG/WebP data URLs.
"""

from __future__ import annotations

import base64
import binascii
import datetime as _dt
import json
import os
import re
import shutil
import tempfile
import threading
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1

#: Suggested change types shown in the UI. Any other short string is accepted as well.
KINDS = (
    "Change text",
    "Add",
    "Remove",
    "Move / resize",
    "Timing",
    "Style / color",
    "Audio / voice",
    "Other",
)
STATUSES = ("open", "done")

MAX_NOTES = 1000
MAX_TEXT_CHARS = 20_000
MAX_KIND_CHARS = 60
MAX_SHOT_BYTES = 8 * 1024 * 1024

_DATA_URL = re.compile(r"^data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=\s]+)$")
_SHOT_PATH = re.compile(r"^shots/(\d{1,6})\.(jpg|png|webp)$")
_EXT = {"jpeg": "jpg", "png": "png", "webp": "webp"}


class ReviewError(ValueError):
    """Raised for invalid review payloads (reported to the browser as HTTP 400)."""


class ReviewStore:
    """Reads and writes one review folder. Thread-safe: saves are serialised with a lock."""

    def __init__(self, folder: str | Path, video_name: str, fps: float,
                 transcript: list[dict[str, Any]] | None = None) -> None:
        self.folder = Path(folder)
        self.video_name = video_name
        self.fps = float(fps)
        self.transcript = transcript or []
        self._lock = threading.Lock()

    # ── paths ────────────────────────────────────────────────────────────────────────────────
    @property
    def notes_path(self) -> Path:
        return self.folder / "notes.json"

    @property
    def markdown_path(self) -> Path:
        return self.folder / "REVIEW.md"

    @property
    def shots_dir(self) -> Path:
        return self.folder / "shots"

    @property
    def rounds_dir(self) -> Path:
        return self.folder / "rounds"

    def shot_file(self, name: str) -> Path | None:
        """Resolve ``shots/<id>.<ext>`` safely; returns None for anything else."""
        if not _SHOT_PATH.match(name):
            return None
        path = self.folder / name
        return path if path.is_file() else None

    # ── load / save ──────────────────────────────────────────────────────────────────────────
    def load(self) -> dict[str, Any]:
        """Return the saved review, or an empty one."""
        if not self.notes_path.is_file():
            return self._document([], saved_at=None)
        try:
            data = json.loads(self.notes_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ReviewError(f"cannot read {self.notes_path}: {exc}") from exc
        if not isinstance(data, dict) or not isinstance(data.get("notes"), list):
            raise ReviewError(f"{self.notes_path} is not a review file")
        return data

    def save(self, payload: Any) -> dict[str, Any]:
        """Validate a payload from the browser, write notes.json, REVIEW.md and the screenshots."""
        if not isinstance(payload, dict) or not isinstance(payload.get("notes"), list):
            raise ReviewError("payload must be an object with a 'notes' list")
        raw_notes = payload["notes"]
        if len(raw_notes) > MAX_NOTES:
            raise ReviewError(f"too many notes (max {MAX_NOTES})")

        with self._lock:
            self.folder.mkdir(parents=True, exist_ok=True)
            self.shots_dir.mkdir(exist_ok=True)
            notes: list[dict[str, Any]] = []
            pending: list[tuple[Path, bytes]] = []
            seen_ids = set()
            for raw in raw_notes:
                note, shot_bytes, ext = normalize_note(raw)
                if note["id"] in seen_ids:
                    raise ReviewError(f"duplicate note id {note['id']}")
                seen_ids.add(note["id"])
                if shot_bytes is not None:
                    rel = f"shots/{note['id']}.{ext}"
                    pending.append((self.folder / rel, shot_bytes))
                    note["shot"] = rel
                elif note.get("shot") and not (self.folder / note["shot"]).is_file():
                    note["shot"] = None  # the browser referenced a screenshot that no longer exists
                notes.append(note)

            for path, data in pending:
                _atomic_write(path, data)
            keep = {n["shot"] for n in notes if n.get("shot")}
            for old in self.shots_dir.iterdir():
                if old.is_file() and f"shots/{old.name}" not in keep:
                    old.unlink()

            notes.sort(key=lambda n: (n["seconds"], n["id"]))
            doc = self._document(notes, saved_at=_now())
            _atomic_write(self.notes_path, (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
            _atomic_write(self.markdown_path, render_markdown(doc).encode("utf-8"))
            return doc

    def archive(self) -> str | None:
        """Move the current round (notes, REVIEW.md, shots) to ``rounds/<n>/`` and start empty.

        Returns the name of the new round folder, or None if there was nothing to archive.
        """
        with self._lock:
            if not self.notes_path.is_file():
                return None
            self.rounds_dir.mkdir(parents=True, exist_ok=True)
            numbers = [int(p.name) for p in self.rounds_dir.iterdir() if p.is_dir() and p.name.isdigit()]
            name = f"{(max(numbers) + 1 if numbers else 1):03d}"
            target = self.rounds_dir / name
            target.mkdir()
            for item in (self.notes_path, self.markdown_path, self.shots_dir):
                if item.exists():
                    shutil.move(str(item), str(target / item.name))
            return name

    def rounds(self) -> list[str]:
        if not self.rounds_dir.is_dir():
            return []
        return sorted(p.name for p in self.rounds_dir.iterdir() if p.is_dir())

    def _document(self, notes: list[dict[str, Any]], saved_at: str | None) -> dict[str, Any]:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "video": self.video_name,
            "fps": self.fps,
            "savedAt": saved_at,
            "notes": notes,
        }


# ── validation ───────────────────────────────────────────────────────────────────────────────
def normalize_note(raw: Any) -> tuple[dict[str, Any], bytes | None, str]:
    """Validate one note. Returns (clean note, new screenshot bytes or None, screenshot extension)."""
    if not isinstance(raw, dict):
        raise ReviewError("every note must be an object")
    note_id = raw.get("id")
    if isinstance(note_id, bool) or not isinstance(note_id, int) or not 1 <= note_id <= 999_999:
        raise ReviewError("note 'id' must be an integer between 1 and 999999")

    seconds = _number(raw.get("seconds"), f"note {note_id}: 'seconds'", 0, 24 * 3600)
    frame = raw.get("frame")
    if isinstance(frame, bool) or not isinstance(frame, int) or frame < 0:
        raise ReviewError(f"note {note_id}: 'frame' must be a non-negative integer")

    mark = _mark(raw.get("mark"), note_id)
    kind = _text(raw.get("kind", "Other"), f"note {note_id}: 'kind'", MAX_KIND_CHARS) or "Other"
    text = _text(raw.get("text", ""), f"note {note_id}: 'text'", MAX_TEXT_CHARS)
    status = raw.get("status", "open")
    if status not in STATUSES:
        raise ReviewError(f"note {note_id}: 'status' must be one of {', '.join(STATUSES)}")
    timecode = _text(raw.get("time", ""), f"note {note_id}: 'time'", 32)

    transcript = None
    if isinstance(raw.get("transcript"), dict):
        t = raw["transcript"]
        transcript = {
            "id": _text(str(t.get("id", "")), f"note {note_id}: transcript id", 200),
            "text": _text(t.get("text", ""), f"note {note_id}: transcript text", MAX_TEXT_CHARS),
        }

    note: dict[str, Any] = {
        "id": note_id,
        "time": timecode,
        "seconds": round(seconds, 3),
        "frame": frame,
        "kind": kind,
        "status": status,
        "text": text,
        "mark": mark,
        "transcript": transcript,
        "shot": None,
    }

    shot = raw.get("shot")
    shot_bytes: bytes | None = None
    ext = "jpg"
    if isinstance(shot, str) and shot:
        m = _DATA_URL.match(shot)
        if m:
            try:
                shot_bytes = base64.b64decode(m.group(2), validate=False)
            except (binascii.Error, ValueError) as exc:
                raise ReviewError(f"note {note_id}: screenshot is not valid base64") from exc
            if len(shot_bytes) > MAX_SHOT_BYTES:
                raise ReviewError(f"note {note_id}: screenshot is larger than {MAX_SHOT_BYTES // (1024 * 1024)} MB")
            if not _looks_like_image(shot_bytes):
                raise ReviewError(f"note {note_id}: screenshot is not a JPEG, PNG or WebP image")
            ext = _EXT[m.group(1)]
        else:
            path = shot.split("?", 1)[0]
            pm = _SHOT_PATH.match(path)
            if not pm or int(pm.group(1)) != note_id:
                raise ReviewError(f"note {note_id}: 'shot' must be a data URL or shots/{note_id}.<ext>")
            note["shot"] = path
    elif shot not in (None, ""):
        raise ReviewError(f"note {note_id}: 'shot' must be a string")
    return note, shot_bytes, ext


def _mark(raw: Any, note_id: int) -> dict[str, float]:
    if not isinstance(raw, dict):
        raise ReviewError(f"note {note_id}: 'mark' must be an object with x and y")
    x = _number(raw.get("x"), f"note {note_id}: mark.x", 0, 1)
    y = _number(raw.get("y"), f"note {note_id}: mark.y", 0, 1)
    mark = {"x": round(x, 4), "y": round(y, 4)}
    if raw.get("w") is not None or raw.get("h") is not None:
        w = _number(raw.get("w"), f"note {note_id}: mark.w", 0, 1)
        h = _number(raw.get("h"), f"note {note_id}: mark.h", 0, 1)
        mark["w"] = round(min(w, 1 - x), 4)
        mark["h"] = round(min(h, 1 - y), 4)
    return mark


def _number(value: Any, name: str, lo: float, hi: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        raise ReviewError(f"{name} must be a number")
    if not lo <= value <= hi:
        raise ReviewError(f"{name} must be between {lo} and {hi}")
    return float(value)


def _text(value: Any, name: str, limit: int) -> str:
    if not isinstance(value, str):
        raise ReviewError(f"{name} must be a string")
    if len(value) > limit:
        raise ReviewError(f"{name} is longer than {limit} characters")
    return value.replace("\r\n", "\n").strip()


def _looks_like_image(data: bytes) -> bool:
    return (data[:3] == b"\xff\xd8\xff"
            or data[:8] == b"\x89PNG\r\n\x1a\n"
            or (data[:4] == b"RIFF" and data[8:12] == b"WEBP"))


# ── output helpers ───────────────────────────────────────────────────────────────────────────
def render_markdown(doc: dict[str, Any]) -> str:
    """Render a review document as Markdown that an AI agent can act on directly."""
    notes = doc.get("notes", [])
    open_notes = [n for n in notes if n.get("status") != "done"]
    lines = [
        f"# Video review: {doc.get('video', 'video')}",
        "",
        f"- Saved: {doc.get('savedAt') or 'not yet'}",
        f"- Frame rate: {doc.get('fps', 30):g} fps (timecodes are `MM:SS.FF`, FF = frame within the second)",
        f"- Notes: {len(notes)} ({len(open_notes)} open, {len(notes) - len(open_notes)} done)",
        "",
        "> **For the AI agent implementing these changes:** each note below is one requested change at an",
        "> exact frame. `mark` gives the position on the picture as fractions of the frame size",
        "> (0,0 = top-left, 1,1 = bottom-right); a box has a width and height, a pin is a single point.",
        "> Open the screenshot of each note to see the frame with the mark drawn on it. Implement every",
        "> note with status `open`; notes with status `done` are kept for reference only.",
        "",
    ]
    if not notes:
        lines += ["_No notes yet._", ""]
    for n in notes:
        title = f"## {n['id']} · {n.get('time') or _fmt_seconds(n['seconds'])} (frame {n['frame']}) · {n.get('kind')}"
        if n.get("status") == "done":
            title += " · done"
        lines += [title, ""]
        lines.append(f"- **Where:** {describe_mark(n['mark'])}")
        if n.get("transcript"):
            tid = n["transcript"].get("id")
            label = f"line `{tid}`" if tid else "line"
            lines.append(f"- **Spoken at this moment ({label}):** “{n['transcript'].get('text', '')}”")
        lines.append(f"- **Screenshot:** ![note {n['id']}]({n['shot']})" if n.get("shot") else "- **Screenshot:** none")
        lines += ["", "**Requested change:**", ""]
        body = n.get("text") or "_(no description; see the mark on the screenshot)_"
        lines += [_quote(body), ""]
    return "\n".join(lines).rstrip() + "\n"


def describe_mark(mark: dict[str, float]) -> str:
    x, y = mark["x"] * 100, mark["y"] * 100
    if "w" in mark:
        return (f"box from x {x:.1f}% / y {y:.1f}%, {mark['w'] * 100:.1f}% wide and "
                f"{mark['h'] * 100:.1f}% high (of the frame)")
    return f"point at x {x:.1f}% / y {y:.1f}% of the frame"


def _quote(text: str) -> str:
    return "\n".join("> " + ln if ln else ">" for ln in text.splitlines())


def _fmt_seconds(seconds: float) -> str:
    return f"{int(seconds // 60):02d}:{seconds % 60:05.2f}"


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
