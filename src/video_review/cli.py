"""Command line entry point: ``video-review [VIDEO | FOLDER] [options]``."""

from __future__ import annotations

import argparse
import sys
import threading
import webbrowser
from pathlib import Path
from urllib.parse import quote

from . import __version__
from .server import ReviewApp, create_server
from .store import ReviewError, render_markdown
from .transcript import TranscriptError, load_transcript
from .workspace import DEFAULT_MAX_UPLOAD_BYTES, VIDEO_EXTENSIONS, Workspace

EPILOG = """\
examples:
  video-review                          review the videos in the current folder (upload more in the browser)
  video-review renders/                 review the videos in renders/
  video-review out/video.mp4 --open     review one video
  video-review out/video.mp4 --transcript voice/timeline.json --fps 30
  video-review renders/ --mcp           MCP server for Claude (desktop app, Claude Code)

Each video gets a review folder next to it (<video>.review/ with notes.json, REVIEW.md and shots/).
Point your AI agent at REVIEW.md to implement the changes.
"""


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="video-review",
        description="Review videos frame by frame in the browser and save the notes for an AI agent.",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("path", nargs="?", type=Path, default=Path("."),
                   help="a video file, or a folder of videos (default: the current folder)")
    p.add_argument("-t", "--transcript", type=Path,
                   help="voice-over / subtitles (.json, .srt or .vtt) for VIDEO, linked to each note")
    p.add_argument("-o", "--review-dir", type=Path,
                   help="review folder for VIDEO (default: <video name>.review next to the video)")
    p.add_argument("--fps", type=float, default=30.0,
                   help="frame rate used for frame stepping and timecodes (default: 30, match your render)")
    p.add_argument("--title", help="title shown in the browser tab (default: the video file name)")
    p.add_argument("--host", default="127.0.0.1",
                   help="address to listen on (default: 127.0.0.1, local only; 0.0.0.0 exposes it to your network)")
    p.add_argument("-p", "--port", type=int, default=8765, help="port to listen on (default: 8765, 0 = any free port)")
    p.add_argument("--open", action="store_true", help="open the review page in your default browser")
    p.add_argument("--no-upload", action="store_true", help="do not allow uploading videos or transcripts")
    p.add_argument("--max-upload-mb", type=int, default=DEFAULT_MAX_UPLOAD_BYTES // 1024 ** 2,
                   help="largest video that can be uploaded, in MB (default: %(default)s)")
    p.add_argument("--mcp", action="store_true",
                   help="run as an MCP server on stdin/stdout instead of the web page, so Claude can read the reviews")
    p.add_argument("--export-markdown", action="store_true",
                   help="only regenerate REVIEW.md of VIDEO from its notes.json and exit")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return p


def default_review_dir(video: Path) -> Path:
    return video.with_name(video.stem + ".review")


def _fail(message: str, code: int = 2) -> int:
    print(f"error: {message}", file=sys.stderr)
    return code


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    target: Path = args.path.expanduser()
    if not 1 <= args.fps <= 240:
        return _fail("--fps must be between 1 and 240")
    if args.max_upload_mb < 1:
        return _fail("--max-upload-mb must be at least 1")

    video: Path | None = None
    if target.is_file():
        if target.suffix.lower() not in VIDEO_EXTENSIONS:
            return _fail(f"not a supported video file: {target} (use {', '.join(VIDEO_EXTENSIONS)})")
        video, root = target, target.parent
    elif target.is_dir():
        root = target
    else:
        return _fail(f"video or folder not found: {target}")
    if video is None and (args.transcript or args.review_dir or args.export_markdown):
        return _fail("--transcript, --review-dir and --export-markdown need a video file, not a folder")

    workspace = Workspace(root, fps=args.fps, uploads=not args.no_upload,
                          max_upload_bytes=args.max_upload_mb * 1024 ** 2)
    if video is not None:
        if args.review_dir:
            workspace.pin_review_dir(video.name, args.review_dir.expanduser())
        if args.transcript:
            try:
                load_transcript(args.transcript.expanduser())  # fail early with a clear message
            except TranscriptError as exc:
                return _fail(str(exc))
            workspace.pin_transcript(video.name, args.transcript.expanduser())

    if args.mcp:
        from .mcp import run as run_mcp  # stdout is the protocol channel: print nothing else
        return run_mcp(workspace)

    if args.export_markdown:
        store = workspace.store(video.name)
        try:
            doc = store.load()
        except ReviewError as exc:
            return _fail(str(exc), 1)
        store.folder.mkdir(parents=True, exist_ok=True)
        store.markdown_path.write_text(render_markdown(doc), encoding="utf-8")
        print(f"wrote {store.markdown_path}")
        return 0

    app = ReviewApp(workspace, title=args.title)
    try:
        server = create_server(app, args.host, args.port)
    except OSError as exc:
        print(f"error: cannot listen on {args.host}:{args.port}: {exc}", file=sys.stderr)
        print("hint: another review may already be running; try --port 0 for a free port", file=sys.stderr)
        return 1

    host, port = server.server_address[:2]
    shown = "localhost" if host in ("127.0.0.1", "::1") else host
    url = f"http://{'[' + shown + ']' if ':' in shown else shown}:{port}/"
    if video is not None:
        url += f"?video={quote(video.name)}"
    videos = workspace.videos()
    print(f"Video review {__version__}")
    print(f"  folder      {workspace.root} ({len(videos)} video{'s' if len(videos) != 1 else ''})")
    if video is not None:
        print(f"  video       {video.name}")
        print(f"  review dir  {workspace.review_dir(video.name)}")
        tpath = workspace.transcript_path(video.name)
        if tpath:
            print(f"  transcript  {tpath} ({len(workspace.transcript(video.name))} lines)")
    print(f"  uploads     {'off' if args.no_upload else 'on (drop a video onto the page)'}")
    print(f"  open        {url}")
    if args.host in ("0.0.0.0", "::"):
        print("  warning     listening on all interfaces: anyone on your network can open, upload and edit")
    print("Press Ctrl+C to stop.")

    if args.open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
