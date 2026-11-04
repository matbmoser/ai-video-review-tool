import io
import json
import urllib.error

import pytest

from video_review import claude_api
from video_review.claude_api import ChatError, ClaudeChat, parse_sse, review_blocks
from video_review.store import ReviewStore


@pytest.fixture
def store(tmp_path, note_factory, png_data_url):
    s = ReviewStore(tmp_path / "demo.review", "demo.mp4", fps=30)
    s.save({"notes": [note_factory(1, shot=png_data_url, text="bigger title"),
                      note_factory(2, status="done", text="already fixed")]})
    return s


@pytest.fixture
def chat(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    return ClaudeChat()


def test_key_handling(chat, monkeypatch):
    assert chat.status()["configured"] is False
    with pytest.raises(ChatError):
        chat.set_key("not a key")
    chat.set_key("  sk-ant-api03-abcdefghijklmnop  ")
    status = chat.status()
    assert status["configured"] and status["source"] == "page"
    assert "sk-ant" not in json.dumps(status)  # the key never goes back to the page
    chat.forget_key()
    assert chat.status()["configured"] is False
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-from-env-0123456789")
    env_chat = ClaudeChat()
    assert env_chat.status()["source"] == "environment"
    env_chat.forget_key()  # a key from the environment is kept
    assert env_chat.status()["configured"]


def test_build_request_with_review(chat, store):
    body = chat.build_request(
        [{"role": "ai", "text": "intro"}, {"role": "user", "text": "what now?"},
         {"role": "ai", "text": "answer"}, {"role": "user", "text": "and then"}, {"role": "user", "text": "?"}],
        store, include_review=True, model="claude-opus-5-5")
    assert body["model"] == "claude-opus-5-5" and body["stream"] is True and body["system"]
    assert [m["role"] for m in body["messages"]] == ["user", "assistant", "user"]  # leading AI intro dropped
    first = body["messages"][0]["content"]
    assert "bigger title" in first[0]["text"] and "already fixed" not in first[0]["text"]  # open notes only
    images = [b for b in first if b["type"] == "image"]
    assert len(images) == 1 and images[0]["source"]["media_type"] == "image/png"
    assert first[-2]["cache_control"] == {"type": "ephemeral"}  # end of the review prefix
    assert first[-1] == {"type": "text", "text": "what now?"}
    assert body["messages"][-1]["content"][-1]["text"] == "and then\n\n?"  # merged, roles must alternate


def test_build_request_without_review_and_unknown_model(chat, store):
    body = chat.build_request([{"role": "user", "text": "hi"}], store, include_review=False, model="gpt-x")
    assert body["model"] == claude_api.DEFAULT_MODEL
    assert body["messages"] == [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]
    with pytest.raises(ChatError):
        chat.build_request([{"role": "ai", "text": "only the intro"}], store, include_review=True)
    with pytest.raises(ChatError):
        chat.build_request("nope", store, include_review=True)


def test_review_blocks_without_screenshots(tmp_path, note_factory):
    s = ReviewStore(tmp_path / "x.review", "x.mp4", fps=30)
    s.save({"notes": [note_factory(1, shot=None)]})
    blocks = review_blocks(s)
    assert len(blocks) == 1 and blocks[0]["cache_control"]


def test_parse_sse():
    events = [
        b"event: message_start\n", b'data: {"type":"message_start"}\n', b"\n",
        b'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n',
        b'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}\n',
        b'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n',
        b"data: not json\n", b'data: {"type":"message_stop"}\n',
    ]
    assert "".join(parse_sse(events)) == "Hello"
    with pytest.raises(ChatError, match="overloaded"):
        list(parse_sse([b'data: {"type":"error","error":{"message":"overloaded"}}\n']))


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def test_stream_sends_key_and_streams(chat, monkeypatch):
    seen = {}

    def fake_urlopen(request, timeout):
        seen["headers"] = dict(request.header_items())
        seen["body"] = json.loads(request.data)
        return FakeResponse(b'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n')

    monkeypatch.setattr(claude_api.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(ChatError, match="no API key"):
        list(chat.stream({"messages": []}))
    chat.set_key("sk-ant-api03-abcdefghijklmnop")
    assert list(chat.stream({"model": "m", "messages": []})) == ["ok"]
    assert seen["headers"]["X-api-key"] == "sk-ant-api03-abcdefghijklmnop"
    assert seen["headers"]["Anthropic-version"] == claude_api.API_VERSION


def test_stream_http_errors_are_readable(chat, monkeypatch):
    def fail(request, timeout):
        body = io.BytesIO(b'{"type":"error","error":{"message":"invalid x-api-key"}}')
        raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, body)

    monkeypatch.setattr(claude_api.urllib.request, "urlopen", fail)
    chat.set_key("sk-ant-api03-abcdefghijklmnop")
    with pytest.raises(ChatError) as info:
        list(chat.stream({"messages": []}))
    assert "rejected" in str(info.value) and "invalid x-api-key" in str(info.value)
    assert "sk-ant" not in str(info.value)
