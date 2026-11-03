import json

import pytest

from video_review.transcript import TranscriptError, load_transcript, parse_cues, parse_json


def test_json_list_with_short_keys():
    data = [{"id": "o2", "s": 10.8, "e": 19.5, "text": "Second"}, {"id": "o1", "s": 0.6, "e": 9.8, "text": "First"}]
    out = parse_json(json.dumps(data))
    assert [s["id"] for s in out] == ["o1", "o2"]  # sorted by start
    assert out[0] == {"id": "o1", "start": 0.6, "end": 9.8, "text": "First"}


def test_json_whisper_style_segments():
    data = {"text": "...", "segments": [{"start": 0.0, "end": 2.5, "text": "  Hello   world "}]}
    out = parse_json(json.dumps(data))
    assert out == [{"id": "1", "start": 0.0, "end": 2.5, "text": "Hello world"}]


def test_json_accepts_timestamp_strings():
    out = parse_json(json.dumps([{"start": "00:00:01.500", "end": "2.25", "text": "x"}]))
    assert out[0]["start"] == 1.5 and out[0]["end"] == 2.25


@pytest.mark.parametrize("bad", ['{"nope": 1}', '[{"text": "no times"}]', "[1, 2]", "not json"])
def test_json_rejects_bad_input(bad):
    with pytest.raises(TranscriptError):
        parse_json(bad)


def test_srt():
    srt = "1\n00:00:01,000 --> 00:00:02,500\nHello <i>there</i>\n\n2\n00:01:00,000 --> 00:01:03,000\nSecond\nline\n"
    out = parse_cues(srt)
    assert out == [
        {"id": "1", "start": 1.0, "end": 2.5, "text": "Hello there"},
        {"id": "2", "start": 60.0, "end": 63.0, "text": "Second line"},
    ]


def test_webvtt_with_header_and_cue_ids():
    vtt = ("WEBVTT\n\nNOTE a comment\n\n"
           "intro\n00:00.500 --> 00:02.000 align:start\nWelcome\n\n"
           "00:02.000 --> 00:03.000\nBye\n")
    out = parse_cues(vtt, webvtt=True)
    assert out[0] == {"id": "intro", "start": 0.5, "end": 2.0, "text": "Welcome"}
    assert out[1]["text"] == "Bye"


def test_load_by_extension(tmp_path):
    p = tmp_path / "voice.srt"
    p.write_text("1\n00:00:00,000 --> 00:00:01,000\nHi\n", encoding="utf-8")
    assert load_transcript(p)[0]["text"] == "Hi"
    with pytest.raises(TranscriptError):
        load_transcript(tmp_path / "voice.txt")
    with pytest.raises(TranscriptError):
        load_transcript(tmp_path / "missing.json")
