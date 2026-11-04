"""The GitHub Pages build (scripts/build_pages.py): a static copy of the UI with the browser backend."""

import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_builder():
    spec = importlib.util.spec_from_file_location("build_pages", ROOT / "scripts" / "build_pages.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_build_pages(tmp_path):
    out = load_builder().build(tmp_path / "site")
    html = (out / "index.html").read_text(encoding="utf-8")
    assert 'http-equiv="Content-Security-Policy"' in html and "connect-src 'self' https://api.anthropic.com" in html
    scripts = re.findall(r'<script src="([^"]+)"', html)
    assert scripts == ["./config.js", "./browser-backend.js", "./app.js", "./claude.js"]
    assert not re.search(r'(src|href)="/(?!/)', html)  # everything relative: the site lives under /<repo>/
    assert "xterm" not in html and not (out / "vendor" / "xterm").exists()
    assert "nothing is uploaded" in html and "install the tool" in html
    for name in ("app.js", "claude.js", "browser-backend.js"):
        assert "/static/" not in (out / name).read_text(encoding="utf-8"), name
    assert (out / "vendor" / "deep-chat" / "deepChat.bundle.js").is_file()
    assert (out / ".nojekyll").is_file()


def test_config_comes_from_the_python_package(tmp_path):
    from video_review.claude_api import DEFAULT_MODEL, SYSTEM_PROMPT
    from video_review.store import KINDS

    out = load_builder().build(tmp_path / "site")
    text = (out / "config.js").read_text(encoding="utf-8")
    config = json.loads(text[text.index("{"): text.rindex("}") + 1])
    assert config["kinds"] == list(KINDS)
    assert config["systemPrompt"] == SYSTEM_PROMPT and config["defaultModel"] == DEFAULT_MODEL
