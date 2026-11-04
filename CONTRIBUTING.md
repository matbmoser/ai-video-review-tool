# Contributing

Thanks for helping! Bug reports, ideas and pull requests are welcome.

## Development setup

```bash
git clone https://github.com/matbmoser/ai-video-review-tool.git
cd ai-video-review-tool
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
```

Run the tool against any video while you work on it:

```bash
video-review path/to/video.mp4 --transcript examples/transcript.json --open
```

The UI is plain HTML/CSS/JS in `src/video_review/static/`; reload the page to see changes (no build step).
Third-party browser code lives in `static/vendor/` (see its README); do not edit those files, update them.
The terminal tests need macOS or Linux and are skipped on Windows.
Set `VIDEO_REVIEW_DEBUG=1` to log every request to the terminal.

## Checks

```bash
ruff check .     # lint
pytest           # tests
```

Both run in CI on every pull request (Python 3.10–3.14 on Linux, plus macOS and Windows).

## Guidelines

- **No runtime dependencies.** The tool must keep running on a plain Python 3.10+ installation.
- **No external requests from the page.** Everything is served from the package (the CSP enforces this).
- **Keep the output format stable.** `notes.json` is read by agents and scripts. Additive changes are
  fine; anything else needs a new `schemaVersion` and a note in `CHANGELOG.md` and
  `docs/review-format.md`.
- **Tests for server and store changes.** The UI is tested by hand in Chrome, Safari and Firefox.
- **Never commit videos, review folders or secrets.** `.gitignore` covers the usual files; double-check
  `git status` before you push.

## Pull requests

1. Open an issue first for larger changes, so we can agree on the approach.
2. Keep pull requests focused; describe what changed and how you tested it.
3. Update the docs and `CHANGELOG.md` when behaviour changes.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
