import http.client
import io
import json
import threading
import zipfile
from urllib.parse import quote

import pytest

from video_review.server import ReviewApp, create_server, parse_range
from video_review.workspace import Workspace


@pytest.fixture
def workspace(tmp_path, video_file):
    ws = Workspace(tmp_path, fps=25, max_upload_bytes=1024 * 1024)
    (tmp_path / "demo.transcript.json").write_text(json.dumps([{"id": "1", "start": 0, "end": 1, "text": "Hi"}]),
                                                   encoding="utf-8")
    return ws


@pytest.fixture
def server(workspace):
    srv = create_server(ReviewApp(workspace), "127.0.0.1", 0)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield srv
    srv.shutdown()
    srv.server_close()


def request(srv, method, path, body=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=5)
    hdrs = {"Host": f"127.0.0.1:{srv.server_address[1]}", **(headers or {})}
    if body is not None and not isinstance(body, bytes):
        body = json.dumps(body).encode()
        hdrs.setdefault("Content-Type", "application/json")
    conn.request(method, path, body=body, headers=hdrs)
    res = conn.getresponse()
    data = res.read()
    conn.close()
    return res, data


def get_json(srv, path):
    res, body = request(srv, "GET", path)
    assert res.status == 200, body
    return json.loads(body)


def test_index_and_static(server):
    res, body = request(server, "GET", "/")
    assert res.status == 200 and b"<title>" in body
    assert "default-src 'self'" in res.getheader("Content-Security-Policy")
    res, _ = request(server, "GET", "/static/app.js")
    assert res.status == 200 and "javascript" in res.getheader("Content-Type")


@pytest.mark.parametrize("path", [
    "/static/../server.py", "/static/%2e%2e/server.py", "/media/..%2Fdemo.mp4", "/media/missing.mp4",
    "/api/videos/demo.mp4/shots/..%2F..%2Fdemo.mp4", "/api/videos/..%2Fsecret.mp4/config", "/etc/passwd",
])
def test_path_traversal_is_refused(server, path):
    res, _ = request(server, "GET", path)
    assert res.status == 404, path


def test_workspace_and_config(server):
    ws = get_json(server, "/api/workspace")
    assert [v["name"] for v in ws["videos"]] == ["demo.mp4"] and ws["uploads"] is True
    cfg = get_json(server, "/api/videos/demo.mp4/config")
    assert cfg["fps"] == 25 and cfg["transcript"][0]["text"] == "Hi" and cfg["reviewFolder"] == "demo.review"
    assert cfg["url"].startswith("/media/demo.mp4?v=")


def test_video_ranges(server, video_file):
    data = video_file.read_bytes()
    res, body = request(server, "GET", "/media/demo.mp4", headers={"Range": "bytes=100-199"})
    assert res.status == 206 and body == data[100:200]
    assert res.getheader("Content-Range") == f"bytes 100-199/{len(data)}"
    res, body = request(server, "GET", "/media/demo.mp4", headers={"Range": "bytes=-10"})
    assert res.status == 206 and body == data[-10:]
    res, _ = request(server, "GET", "/media/demo.mp4", headers={"Range": "bytes=999999-"})
    assert res.status == 416
    res, body = request(server, "GET", "/media/demo.mp4")
    assert res.status == 200 and body == data and res.getheader("Accept-Ranges") == "bytes"


def test_save_load_shot_and_export(server, note_factory):
    res, body = request(server, "POST", "/api/videos/demo.mp4/review", body={"notes": [note_factory(1)]})
    assert res.status == 200, body
    doc = get_json(server, "/api/videos/demo.mp4/review")
    assert doc["notes"][0]["shot"] == "shots/1.png"
    res, body = request(server, "GET", "/api/videos/demo.mp4/shots/1.png")
    assert res.status == 200 and body.startswith(b"\x89PNG")
    res, body = request(server, "GET", "/api/videos/demo.mp4/export")
    assert res.status == 200 and res.getheader("Content-Type") == "application/zip"
    names = zipfile.ZipFile(io.BytesIO(body)).namelist()
    assert {"demo.review/notes.json", "demo.review/REVIEW.md", "demo.review/shots/1.png",
            "demo.review/transcript.json"} <= set(names)


def test_save_rejects_bad_payloads(server, note_factory):
    res, _ = request(server, "POST", "/api/videos/demo.mp4/review", body={"notes": [note_factory(1, id=-3)]})
    assert res.status == 400
    res, _ = request(server, "POST", "/api/videos/demo.mp4/review", body=b"{",
                     headers={"Content-Type": "application/json"})
    assert res.status == 400
    res, _ = request(server, "POST", "/api/videos/demo.mp4/review", body=b"{}", headers={"Content-Type": "text/plain"})
    assert res.status == 415
    res, _ = request(server, "POST", "/api/videos/nope.mp4/review", body={"notes": []})
    assert res.status == 404


def test_upload_video_keeps_notes(server, workspace, note_factory):
    res, body = request(server, "PUT", f"/api/videos/{quote('new render.webm')}", body=b"\x1aE\xdf\xa3" + b"x" * 500,
                        headers={"Content-Type": "video/webm"})
    assert res.status == 201, body
    assert json.loads(body)["name"] == "new render.webm"
    assert (workspace.root / "new render.webm").stat().st_size == 504
    # replacing a video keeps its review
    request(server, "POST", "/api/videos/demo.mp4/review", body={"notes": [note_factory(1)]})
    res, body = request(server, "PUT", "/api/videos/demo.mp4", body=b"y" * 100, headers={"Content-Type": "video/mp4"})
    assert res.status == 201 and json.loads(body)["notes"] == 1
    assert (workspace.root / "demo.mp4").read_bytes() == b"y" * 100


def test_upload_rejections(server):
    res, _ = request(server, "PUT", "/api/videos/evil.exe", body=b"MZ", headers={"Content-Type": "video/mp4"})
    assert res.status == 400
    # announce a body over the limit; the server answers 413 before reading it
    conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
    conn.putrequest("PUT", "/api/videos/big.mp4", skip_host=True)
    conn.putheader("Host", f"127.0.0.1:{server.server_address[1]}")
    conn.putheader("Content-Type", "video/mp4")
    conn.putheader("Content-Length", str(1024 * 1024 + 1))
    conn.endheaders()
    assert conn.getresponse().status == 413
    conn.close()
    res, _ = request(server, "PUT", "/api/videos/x.mp4", body=b"x", headers={"Origin": "https://evil.example"})
    assert res.status == 403


def test_upload_transcript(server, workspace):
    srt = b"1\n00:00:00,000 --> 00:00:01,000\nHello\n"
    res, body = request(server, "PUT", "/api/videos/demo.mp4/transcript?filename=voice.srt", body=srt,
                        headers={"Content-Type": "application/x-subrip"})
    assert res.status == 200, body
    assert json.loads(body)["transcript"][0]["text"] == "Hello"
    assert (workspace.root / "demo.transcript.srt").exists()
    assert not (workspace.root / "demo.transcript.json").exists()  # the new transcript replaces the old one
    res, _ = request(server, "PUT", "/api/videos/demo.mp4/transcript?filename=voice.srt", body=b"garbage -->",
                     headers={"Content-Type": "application/x-subrip"})
    assert res.status == 400


def test_cross_origin_and_dns_rebinding_are_refused(server):
    res, _ = request(server, "POST", "/api/videos/demo.mp4/review", body={"notes": []},
                     headers={"Origin": "https://evil.example"})
    assert res.status == 403
    res, _ = request(server, "GET", "/api/workspace", headers={"Host": "evil.example"})
    assert res.status == 403
    res, _ = request(server, "GET", "/api/workspace", headers={"Host": f"localhost:{server.server_address[1]}"})
    assert res.status == 200


def test_archive_endpoint(server, note_factory):
    request(server, "POST", "/api/videos/demo.mp4/review", body={"notes": [note_factory(1)]})
    res, body = request(server, "POST", "/api/videos/demo.mp4/review/archive", body={})
    assert res.status == 200 and json.loads(body)["archived"] == "001"
    assert get_json(server, "/api/videos/demo.mp4/review")["notes"] == []


def test_uploads_can_be_disabled(tmp_path, video_file):
    srv = create_server(ReviewApp(Workspace(tmp_path, uploads=False)), "127.0.0.1", 0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        res, _ = request(srv, "PUT", "/api/videos/x.mp4", body=b"x", headers={"Content-Type": "video/mp4"})
        assert res.status == 400
        assert get_json(srv, "/api/workspace")["uploads"] is False
    finally:
        srv.shutdown()
        srv.server_close()


@pytest.mark.parametrize("header,size,expected", [
    ("bytes=0-9", 100, (0, 9)),
    ("bytes=90-", 100, (90, 99)),
    ("bytes=-5", 100, (95, 99)),
    ("bytes=50-500", 100, (50, 99)),
    ("bytes=-500", 100, (0, 99)),
    ("bytes=100-", 100, None),
    ("bytes=9-3", 100, None),
    ("bytes=-", 100, None),
    ("items=0-1", 100, None),
    ("bytes=0-1,5-6", 100, None),
])
def test_parse_range(header, size, expected):
    assert parse_range(header, size) == expected
