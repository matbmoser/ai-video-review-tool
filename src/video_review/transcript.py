"""Load a transcript (voice-over / subtitles) so each note can be linked to the line spoken at that moment.

Supported formats
-----------------
* **JSON** - a list of segments, or an object with a ``segments`` / ``lines`` list
  (this covers Whisper output and most TTS pipelines). Each segment needs a start, an end
  and a text; the keys ``start``/``end``, ``s``/``e`` and ``from``/``to`` are accepted, in seconds.
  An optional ``id`` is kept (e.g. ``"intro"``), otherwise segments are numbered from 1.
* **SRT** - SubRip subtitles (``.srt``).
* **WebVTT** - Web subtitles (``.vtt``).

Every format is normalised to ``[{"id": str, "start": float, "end": float, "text": str}, ...]``
sorted by start time.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

Segment = dict[str, Any]

_START_KEYS = ("start", "s", "from", "begin")
_END_KEYS = ("end", "e", "to", "stop")
_TIMESTAMP = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})")


class TranscriptError(ValueError):
    """Raised when a transcript file cannot be parsed."""


def load_transcript(path: str | Path) -> list[Segment]:
    """Read and normalise a transcript file. The format is chosen by file extension."""
    p = Path(path)
    try:
        text = p.read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise TranscriptError(f"cannot read transcript {p}: {exc}") from exc
    suffix = p.suffix.lower()
    if suffix == ".json":
        return parse_json(text)
    if suffix == ".srt":
        return parse_cues(text)
    if suffix == ".vtt":
        return parse_cues(text, webvtt=True)
    raise TranscriptError(f"unsupported transcript format {suffix!r} (use .json, .srt or .vtt)")


def parse_json(text: str) -> list[Segment]:
    """Parse a JSON transcript (list of segments, or ``{"segments": [...]}`` / ``{"lines": [...]}``)."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise TranscriptError(f"invalid JSON transcript: {exc}") from exc
    if isinstance(data, dict):
        for key in ("segments", "lines", "items"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
    if not isinstance(data, list):
        raise TranscriptError("JSON transcript must be a list of segments or contain a 'segments' list")
    out: list[Segment] = []
    for i, raw in enumerate(data, start=1):
        if not isinstance(raw, dict):
            raise TranscriptError(f"segment {i} is not an object")
        start = _first_number(raw, _START_KEYS)
        end = _first_number(raw, _END_KEYS)
        if start is None or end is None:
            raise TranscriptError(f"segment {i} needs a start and an end time in seconds")
        text_value = raw.get("text", "")
        if not isinstance(text_value, str):
            raise TranscriptError(f"segment {i}: 'text' must be a string")
        out.append(_segment(raw.get("id", i), start, end, text_value))
    return _sorted(out)


def parse_cues(text: str, webvtt: bool = False) -> list[Segment]:
    """Parse SRT or WebVTT cues."""
    blocks = re.split(r"\r?\n\s*\r?\n", text.strip())
    out: list[Segment] = []
    for block in blocks:
        lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
        if not lines:
            continue
        if webvtt and (lines[0].startswith("WEBVTT") or lines[0].startswith(("NOTE", "STYLE", "REGION"))):
            continue
        timing_idx = next((k for k, ln in enumerate(lines) if "-->" in ln), None)
        if timing_idx is None:
            continue
        left, right = lines[timing_idx].split("-->", 1)
        start, end = _timestamp(left), _timestamp(right.split()[0] if right.split() else "")
        if start is None or end is None:
            raise TranscriptError(f"bad cue timing: {lines[timing_idx]!r}")
        cue_id = lines[0] if timing_idx > 0 else len(out) + 1
        body = " ".join(re.sub(r"<[^>]+>", "", ln) for ln in lines[timing_idx + 1:])
        out.append(_segment(cue_id, start, end, body))
    return _sorted(out)


def _segment(seg_id: Any, start: float, end: float, text: str) -> Segment:
    if end < start:
        start, end = end, start
    return {"id": str(seg_id), "start": round(float(start), 3), "end": round(float(end), 3),
            "text": " ".join(text.split())}


def _first_number(raw: dict[str, Any], keys: tuple) -> float | None:
    for key in keys:
        value = raw.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            ts = _timestamp(value)
            if ts is not None:
                return ts
            try:
                return float(value)
            except ValueError:
                continue
    return None


def _timestamp(value: str) -> float | None:
    m = _TIMESTAMP.search(value.strip())
    if not m:
        return None
    hours, minutes, seconds, frac = m.groups()
    return int(hours or 0) * 3600 + int(minutes) * 60 + int(seconds) + int(frac.ljust(3, "0")) / 1000


def _sorted(segments: list[Segment]) -> list[Segment]:
    return sorted(segments, key=lambda s: (s["start"], s["end"]))
