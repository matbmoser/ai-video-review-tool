import json

import pytest

from video_review.store import ReviewError, ReviewStore, describe_mark, normalize_note, render_markdown


@pytest.fixture
def store(tmp_path):
    return ReviewStore(tmp_path / "demo.review", video_name="demo.mp4", fps=30)


def test_empty_review(store):
    doc = store.load()
    assert doc["notes"] == [] and doc["savedAt"] is None and doc["fps"] == 30


def test_save_writes_notes_markdown_and_shots(store, note_factory):
    doc = store.save({"notes": [note_factory(2, seconds=5.0, frame=150), note_factory(1)]})
    assert [n["id"] for n in doc["notes"]] == [1, 2]  # sorted by time
    assert (store.folder / "shots" / "1.png").read_bytes().startswith(b"\x89PNG")
    saved = json.loads(store.notes_path.read_text(encoding="utf-8"))
    assert saved["notes"][0]["shot"] == "shots/1.png"
    assert saved["schemaVersion"] == 1 and saved["video"] == "demo.mp4"
    md = store.markdown_path.read_text(encoding="utf-8")
    assert "## 1 · 00:01.15 (frame 45) · Change text" in md
    assert "Make the title bigger" in md and "![note 1](shots/1.png)" in md


def test_resave_keeps_existing_shots_and_removes_deleted_ones(store, note_factory):
    store.save({"notes": [note_factory(1), note_factory(2)]})
    # second save: note 1 references its saved shot, note 2 was deleted
    doc = store.save({"notes": [note_factory(1, shot="shots/1.png?v=123", text="changed")]})
    assert doc["notes"][0]["shot"] == "shots/1.png"
    assert (store.folder / "shots" / "1.png").exists()
    assert not (store.folder / "shots" / "2.png").exists()


def test_reference_to_missing_shot_is_dropped(store, note_factory):
    doc = store.save({"notes": [note_factory(3, shot="shots/3.jpg")]})
    assert doc["notes"][0]["shot"] is None


@pytest.mark.parametrize("override,message", [
    ({"id": 0}, "id"),
    ({"id": "1"}, "id"),
    ({"seconds": -1}, "seconds"),
    ({"frame": 1.5}, "frame"),
    ({"mark": {"x": 2, "y": 0}}, "mark.x"),
    ({"mark": None}, "mark"),
    ({"status": "maybe"}, "status"),
    ({"text": 5}, "text"),
    ({"shot": "data:image/png;base64,bm90IGFuIGltYWdl"}, "not a JPEG"),
    ({"shot": "../../etc/passwd"}, "shot"),
    ({"shot": "shots/9.jpg"}, "shot"),  # must belong to this note
])
def test_validation_errors(note_factory, override, message):
    with pytest.raises(ReviewError, match=message):
        normalize_note(note_factory(1, **override))


def test_payload_shape_and_duplicates(store, note_factory):
    with pytest.raises(ReviewError):
        store.save([])
    with pytest.raises(ReviewError, match="duplicate"):
        store.save({"notes": [note_factory(1), note_factory(1)]})


def test_box_is_clamped_to_frame(note_factory):
    note, _, _ = normalize_note(note_factory(1, mark={"x": 0.9, "y": 0.8, "w": 0.5, "h": 0.5}))
    assert note["mark"] == {"x": 0.9, "y": 0.8, "w": 0.1, "h": 0.2}


def test_pin_mark_and_description():
    assert describe_mark({"x": 0.5, "y": 0.25}) == "point at x 50.0% / y 25.0% of the frame"
    assert "box from x 10.0% / y 20.0%, 30.0% wide" in describe_mark({"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4})


def test_archive_rounds(store, note_factory):
    assert store.archive() is None
    store.save({"notes": [note_factory(1)]})
    assert store.archive() == "001"
    assert not store.notes_path.exists()
    assert (store.rounds_dir / "001" / "notes.json").exists()
    assert (store.rounds_dir / "001" / "shots" / "1.png").exists()
    store.save({"notes": [note_factory(1)]})
    assert store.archive() == "002"
    assert store.rounds() == ["001", "002"]


def test_markdown_for_empty_and_done_notes(note_factory):
    assert "_No notes yet._" in render_markdown({"video": "v.mp4", "fps": 30, "notes": []})
    note, _, _ = normalize_note(note_factory(1, status="done", text="line one\nline two", transcript=None))
    md = render_markdown({"video": "v.mp4", "fps": 30, "notes": [note]})
    assert "· done" in md and "> line one\n> line two" in md and "1 done" in md
