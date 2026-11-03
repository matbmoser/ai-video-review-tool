import io
import os
import time

import pytest

from video_review.workspace import Workspace, WorkspaceError, safe_video_name


@pytest.mark.parametrize("raw,expected", [
    ("render.mp4", "render.mp4"),
    ("My Launch (v2).MOV", "My Launch (v2).MOV"),
    ("C:\\Users\\me\\Videos\\final.webm", "final.webm"),
    ("../../etc/clip.mp4", "clip.mp4"),
    ("weird$name!.mp4", "weird_name_.mp4"),
])
def test_safe_video_name(raw, expected):
    assert safe_video_name(raw) == expected


@pytest.mark.parametrize("raw", ["notes.txt", ".mp4", "...", "", "video.exe"])
def test_safe_video_name_rejects(raw):
    with pytest.raises(WorkspaceError):
        safe_video_name(raw)


def test_lists_videos_newest_first(tmp_path):
    for i, name in enumerate(["old.mp4", "new.webm"]):
        p = tmp_path / name
        p.write_bytes(b"x")
        os.utime(p, (time.time() + i, time.time() + i))
    (tmp_path / "notes.txt").write_text("x", encoding="utf-8")
    (tmp_path / ".hidden.mp4").write_bytes(b"x")
    ws = Workspace(tmp_path)
    assert [p.name for p in ws.videos()] == ["new.webm", "old.mp4"]
    assert ws.video_path("old.mp4") and ws.video_path("../old.mp4") is None and ws.video_path("notes.txt") is None


def test_review_dirs_and_transcripts(tmp_path, video_file):
    ws = Workspace(tmp_path)
    assert ws.review_dir("demo.mp4") == tmp_path.resolve() / "demo.review"
    assert ws.transcript("demo.mp4") == []
    (tmp_path / "demo.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\nHi\n", encoding="utf-8")
    assert ws.transcript("demo.mp4")[0]["text"] == "Hi"
    elsewhere = tmp_path / "other" / "voice.json"
    elsewhere.parent.mkdir()
    elsewhere.write_text('[{"start": 0, "end": 2, "text": "Pinned"}]', encoding="utf-8")
    ws.pin_transcript("demo.mp4", elsewhere)
    ws.pin_review_dir("demo.mp4", tmp_path / "custom")
    assert ws.transcript("demo.mp4")[0]["text"] == "Pinned"
    assert ws.store("demo.mp4").folder == (tmp_path / "custom").resolve()


def test_receive_video_streams_and_validates(tmp_path):
    ws = Workspace(tmp_path, max_upload_bytes=100)
    assert ws.receive_video("clip.mp4", io.BytesIO(b"a" * 50), 50) == "clip.mp4"
    assert (tmp_path / "clip.mp4").read_bytes() == b"a" * 50
    with pytest.raises(WorkspaceError, match="limit"):
        ws.receive_video("big.mp4", io.BytesIO(b"a" * 200), 200)
    with pytest.raises(WorkspaceError, match="interrupted"):
        ws.receive_video("short.mp4", io.BytesIO(b"a" * 10), 50)
    assert not (tmp_path / "short.mp4").exists()
    assert not [p for p in tmp_path.iterdir() if p.name.startswith(".upload-")]  # no temp files left


def test_save_transcript(tmp_path, video_file):
    ws = Workspace(tmp_path)
    segments = ws.save_transcript("demo.mp4", "voice.vtt", b"WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n")
    assert segments[0]["text"] == "Hello" and (tmp_path / "demo.transcript.vtt").exists()
    with pytest.raises(WorkspaceError):
        ws.save_transcript("demo.mp4", "voice.txt", b"x")
    with pytest.raises(KeyError):
        ws.save_transcript("missing.mp4", "voice.vtt", b"")


def test_summary_counts_open_notes(tmp_path, video_file, note_factory):
    ws = Workspace(tmp_path)
    ws.store("demo.mp4").save({"notes": [note_factory(1), note_factory(2, status="done")]})
    info = ws.summary("demo.mp4")
    assert info["notes"] == 2 and info["open"] == 1 and info["size"] == video_file.stat().st_size
