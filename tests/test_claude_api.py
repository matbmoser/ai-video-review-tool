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
         {"role": "ai", "text": "answer"}, {"role": "error", "text": "overloaded"},
         {"role": "user", "text": "and then"}, {"role": "user", "text": "?"}],
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
    with pytest.raises(ChatError, match="Anthropic API error: bad"):
        list(parse_sse([b'data: {"type":"error","error":{"type":"api_error","message":"bad"}}\n']))
    with pytest.raises(ChatError, match="overloaded"):
        list(parse_sse([b'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n']))


def test_parse_sse_stop_reasons_and_interruptions():
    delta = b'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n'
    cut = list(parse_sse([delta, b'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n',
                          b'data: {"type":"message_stop"}\n']))
    assert cut[0] == "partial" and "cut off" in cut[1]
    gen = parse_sse([delta])  # the stream ends without message_stop
    assert next(gen) == "partial"
    with pytest.raises(ChatError, match="interrupted"):
        next(gen)


TEXT_OK = (b'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n'
           b'data: {"type":"message_stop"}\n')


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
        return FakeResponse(TEXT_OK)

    monkeypatch.setattr(claude_api.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(ChatError, match="No API key"):
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


def http_error(code, retry_after=None):
    headers = {"retry-after": retry_after} if retry_after else {}
    import email.message
    msg = email.message.Message()
    for k, v in headers.items():
        msg[k] = v
    return urllib.error.HTTPError("https://api", code, "x", msg, io.BytesIO(b'{"error":{"message":"busy"}}'))


def test_retries_overload_and_network_errors(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    delays = []
    chat = ClaudeChat(sleep=delays.append)
    chat.set_key("sk-ant-api03-abcdefghijklmnop")
    outcomes = [http_error(529), http_error(429, retry_after="3"), urllib.error.URLError("reset")]

    def flaky(request, timeout):
        if outcomes:
            raise outcomes.pop(0)
        return FakeResponse(TEXT_OK)

    monkeypatch.setattr(claude_api.urllib.request, "urlopen", flaky)
    assert list(chat.stream({"messages": []})) == ["ok"]
    assert delays == [1.0, 3.0, 4.0]


def test_gives_up_after_max_attempts_and_does_not_retry_client_errors(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    delays = []
    chat = ClaudeChat(sleep=delays.append)
    chat.set_key("sk-ant-api03-abcdefghijklmnop")
    calls = []

    def always(code):
        def fake(request, timeout):
            calls.append(code)
            raise http_error(code)
        return fake

    monkeypatch.setattr(claude_api.urllib.request, "urlopen", always(529))
    with pytest.raises(ChatError, match="overloaded"):
        list(chat.stream({"messages": []}))
    assert len(calls) == claude_api.MAX_ATTEMPTS
    calls.clear()
    monkeypatch.setattr(claude_api.urllib.request, "urlopen", always(400))
    with pytest.raises(ChatError, match="HTTP 400"):
        list(chat.stream({"messages": []}))
    assert calls == [400]


def test_image_budget(tmp_path, note_factory, png_data_url, monkeypatch):
    s = ReviewStore(tmp_path / "many.review", "many.mp4", fps=30)
    s.save({"notes": [note_factory(i, shot=png_data_url) for i in range(1, 5)]})
    monkeypatch.setattr(claude_api, "MAX_REVIEW_IMAGES", 2)
    blocks = review_blocks(s)
    assert sum(b["type"] == "image" for b in blocks) == 2
    assert "note(s) 3, 4" in blocks[-1]["text"] and blocks[-1]["cache_control"]
