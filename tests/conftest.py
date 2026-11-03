import base64
import struct
import zlib

import pytest


def tiny_png() -> bytes:
    """A valid 1x1 PNG, generated so the tests need no binary fixtures."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    idat = zlib.compress(b"\x00\xff\x00\x00")
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


@pytest.fixture
def png_data_url() -> str:
    return "data:image/png;base64," + base64.b64encode(tiny_png()).decode()


@pytest.fixture
def note_factory(png_data_url):
    def make(note_id=1, **overrides):
        note = {
            "id": note_id,
            "time": "00:01.15",
            "seconds": 1.5,
            "frame": 45,
            "kind": "Change text",
            "status": "open",
            "text": "Make the title bigger",
            "mark": {"x": 0.25, "y": 0.5, "w": 0.2, "h": 0.1},
            "transcript": {"id": "intro", "text": "Hello and welcome."},
            "shot": png_data_url,
        }
        note.update(overrides)
        return note
    return make


@pytest.fixture
def video_file(tmp_path):
    """A fake video file: the server only streams bytes, it never decodes them."""
    path = tmp_path / "demo.mp4"
    path.write_bytes(bytes(range(256)) * 40)  # 10 240 bytes
    return path
