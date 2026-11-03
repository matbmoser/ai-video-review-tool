import http.server
import threading

import pytest

from video_review.cli import default_review_dir, main
from video_review.store import ReviewStore


def test_missing_path(tmp_path, capsys):
    assert main([str(tmp_path / "nope.mp4")]) == 2
    assert "not found" in capsys.readouterr().err


def test_not_a_video(tmp_path, capsys):
    text = tmp_path / "notes.txt"
    text.write_text("x", encoding="utf-8")
    assert main([str(text)]) == 2
    assert "not a supported video" in capsys.readouterr().err


def test_bad_options(video_file, tmp_path, capsys):
    assert main([str(video_file), "--fps", "0"]) == 2
    bad = tmp_path / "voice.txt"
    bad.write_text("x", encoding="utf-8")
    assert main([str(video_file), "--transcript", str(bad)]) == 2
    assert "unsupported transcript format" in capsys.readouterr().err
    assert main([str(tmp_path), "--transcript", str(bad)]) == 2  # needs a video, not a folder


def test_default_review_dir(tmp_path):
    assert default_review_dir(tmp_path / "out" / "promo.mp4") == tmp_path / "out" / "promo.review"


def test_export_markdown(video_file, note_factory, capsys):
    store = ReviewStore(default_review_dir(video_file), video_name=video_file.name, fps=30)
    store.save({"notes": [note_factory(1)]})
    store.markdown_path.unlink()
    assert main([str(video_file), "--export-markdown"]) == 0
    assert store.markdown_path.exists()
    assert "wrote" in capsys.readouterr().out


@pytest.mark.parametrize("use_folder", [False, True])
def test_serves_until_interrupted(video_file, monkeypatch, capsys, use_folder):
    """Start the real server on a free port and stop it like Ctrl+C would."""
    started = threading.Event()

    def fake_serve(self):
        started.set()
        raise KeyboardInterrupt

    monkeypatch.setattr(http.server.ThreadingHTTPServer, "serve_forever", fake_serve)
    target = video_file.parent if use_folder else video_file
    assert main([str(target), "--port", "0"]) == 0
    out = capsys.readouterr().out
    assert started.is_set() and "open" in out and "stopped" in out
    assert ("?video=demo.mp4" in out) is (not use_folder)
