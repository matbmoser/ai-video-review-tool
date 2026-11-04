import io
import json

import pytest

from video_review.mcp import McpServer
from video_review.workspace import Workspace


@pytest.fixture
def mcp(tmp_path, video_file, note_factory):
    ws = Workspace(tmp_path, fps=30)
    ws.store("demo.mp4").save({"notes": [note_factory(1), note_factory(2, status="done", text="Already fixed")]})
    return McpServer(ws)


def call(server, name, arguments=None, msg_id=1):
    res = server.handle({"jsonrpc": "2.0", "id": msg_id, "method": "tools/call",
                         "params": {"name": name, "arguments": arguments or {}}})
    assert "result" in res, res
    return res["result"]


def test_initialize_and_list_tools(mcp):
    res = mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                      "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t"}}})
    info = res["result"]
    assert info["protocolVersion"] == "2025-06-18" and "tools" in info["capabilities"]
    assert info["serverInfo"]["name"] == "video-review" and "video reviews" in info["instructions"]
    old = mcp.handle({"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}})
    assert old["result"]["protocolVersion"] == "2025-06-18"  # falls back to the newest supported version
    assert mcp.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    tools = mcp.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/list"})["result"]["tools"]
    assert {t["name"] for t in tools} == {"list_video_reviews", "get_video_review", "set_note_status"}


def test_list_video_reviews(mcp):
    result = call(mcp, "list_video_reviews")
    assert not result["isError"] and "demo.mp4: 1 open of 2 note(s)" in result["content"][0]["text"]


def test_get_video_review_returns_text_and_images(mcp):
    result = call(mcp, "get_video_review")  # single video: the name may be omitted
    text = result["content"][0]["text"]
    assert "## Note 1 · 00:01.15 (frame 45) · Change text · open" in text
    assert "Make the title bigger" in text and "Hello and welcome." in text and "Already fixed" not in text
    images = [c for c in result["content"] if c["type"] == "image"]
    assert len(images) == 1 and images[0]["mimeType"] == "image/png"

    everything = call(mcp, "get_video_review", {"video": "demo.mp4", "include_done": True, "include_images": False})
    assert "Already fixed" in everything["content"][0]["text"]
    assert not [c for c in everything["content"] if c["type"] == "image"]


def test_set_note_status(mcp):
    result = call(mcp, "set_note_status", {"video": "demo.mp4", "note_id": 1, "status": "done"})
    assert not result["isError"]
    doc = mcp.workspace.store("demo.mp4").load()
    assert [n["status"] for n in doc["notes"]] == ["done", "done"]
    assert doc["notes"][0]["shot"] == "shots/1.png"  # screenshots survive the re-save
    assert call(mcp, "set_note_status", {"video": "demo.mp4", "note_id": 9, "status": "done"})["isError"]


def test_tool_errors_are_reported_to_the_model(mcp):
    assert call(mcp, "get_video_review", {"video": "../secret.mp4"})["isError"]
    assert call(mcp, "get_video_review", {"unexpected": 1})["isError"]
    res = mcp.handle({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "rm_rf", "arguments": {}}})
    assert res["error"]["code"] == -32602
    assert mcp.handle({"jsonrpc": "2.0", "id": 6, "method": "resources/list"})["error"]["code"] == -32601


def test_serve_over_stdio(mcp):
    lines = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "ping"},
    ]
    stdin = io.StringIO("\n".join(json.dumps(m) for m in lines) + "\nnot json\n")
    stdout = io.StringIO()
    mcp.serve(stdin, stdout)
    replies = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert [r.get("id") for r in replies] == [1, 2, None]
    assert replies[0]["result"]["protocolVersion"] == "2024-11-05" and replies[1]["result"] == {}
    assert replies[2]["error"]["code"] == -32700
