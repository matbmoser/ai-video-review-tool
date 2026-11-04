# Architecture

The tool is deliberately small: a Python standard-library HTTP server and a static page without a build
step. There is nothing to install besides Python, and nothing is downloaded at runtime (the two browser
libraries of the ✦ Claude panel ship with the package).

```text
src/video_review/
├── cli.py          argument parsing, start-up, --export-markdown
├── server.py       HTTP routes, range requests, security checks
├── workspace.py    the folder of videos: listing, uploads, transcripts, zip export
├── mcp.py          MCP server (JSON-RPC over stdio) for Claude: list / get reviews, set note status
├── terminal.py     the ✦ Claude panel's terminal: Claude Code in a pseudo-terminal (POSIX)
├── claude_api.py   the ✦ Claude panel's chat: Anthropic Messages API client (stdlib, streaming)
├── store.py        validation, notes.json / REVIEW.md / shots, review rounds (one store per video)
├── transcript.py   JSON / SRT / WebVTT parsing
└── static/         index.html, app.css, app.js (the review UI), claude.js (the panel), favicon, images
    └── vendor/     xterm.js + fit addon, Deep Chat (MIT, shipped as files, loaded on first use)
```

## Flow

1. `video-review [VIDEO | FOLDER]` creates a `Workspace` for the folder (one `ReviewStore` per video in
   `<video>.review/`) and starts a `ThreadingHTTPServer` on `127.0.0.1:8765`.
2. The page loads `/api/workspace` (the videos), then `/api/videos/<v>/config` (fps, transcript, change
   types) and `/api/videos/<v>/review` (saved notes), and plays `/media/<v>` with HTTP range requests so
   seeking is instant even for large files.
3. Uploads are `PUT /api/videos/<v>` with the raw file as body, streamed to a temporary file in the
   workspace and renamed into place when complete. A transcript upload is parsed before it is stored.
4. Clicking or dragging on the video creates a note. The browser draws the current frame and the mark on a
   canvas and keeps it as a JPEG data URL until the next save.
5. Saving `POST`s all notes to `/api/videos/<v>/review`. New screenshots are sent as data URLs, saved
   ones as their path (`shots/3.jpg`), so autosave stays cheap. The store validates everything, writes the screenshots,
   deletes screenshots of removed notes, and rewrites `notes.json` and `REVIEW.md` atomically.
6. `POST /api/videos/<v>/review/archive` moves the current round to `rounds/<n>/`.

## HTTP API

`<v>` is the URL-encoded file name of a video in the workspace.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | review UI |
| GET | `/static/<file>` | UI assets |
| GET | `/api/workspace` | `{version, workspace, fps, uploads, maxUploadBytes, videos: [{name, size, notes, open, transcript}]}` |
| PUT | `/api/videos/<v>` | upload a video (raw body); `201` with its summary |
| GET | `/media/<v>` | the video (supports `Range`) |
| GET | `/api/videos/<v>/config` | `{name, url, fps, kinds, transcript, transcriptFile, reviewFolder, reviewPath, rounds}` |
| PUT | `/api/videos/<v>/transcript?filename=…` | upload a transcript (`.json`, `.srt`, `.vtt`) |
| GET | `/api/videos/<v>/review` | contents of `notes.json` (or an empty review) |
| POST | `/api/videos/<v>/review` | save `{notes: [...]}`; returns the saved document, or `400 {error}` |
| POST | `/api/videos/<v>/review/archive` | start a new round; returns `{archived, rounds}` |
| GET | `/api/videos/<v>/shots/<id>.<ext>` | a saved screenshot |
| GET | `/api/videos/<v>/markdown` | `REVIEW.md` as text |
| GET | `/api/videos/<v>/export` | the review folder (and transcript) as a zip |

### ✦ Claude panel

Only offered when the server listens on a loopback address. `/api/workspace` returns a random `token`
(created at start-up); every request below needs it, as the `X-Review-Token` header (or `token=` for the
event stream, which `EventSource` cannot add headers to).

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/claude` | `{terminal: {available, reason, command, cwd, running, exitCode}, chat: {enabled, reason, configured, source, model, models}}` |
| POST | `/api/terminal/start` | `{cols, rows}`: start `--claude-command` in `--project` (no-op if running) |
| POST | `/api/terminal/send` | `{text, cols, rows}`: start Claude Code with `text` as first message, or paste it into the running session and press Enter |
| POST | `/api/terminal/input` | `{data}`: keystrokes from xterm.js |
| POST | `/api/terminal/resize` | `{cols, rows}` |
| POST | `/api/terminal/stop` | SIGHUP, then SIGKILL, to the program's process group |
| GET | `/api/terminal/stream?offset=N&token=…` | server-sent events: `data: <base64 output>` with `id: <offset>`, then `event: exit`. The last 2 MB are kept, so a reloaded page replays them from offset 0. |
| POST | `/api/claude/key` | `{key}` sets the API key in memory, `{key: null}` forgets it |
| POST | `/api/claude/chat` | Deep Chat request `{messages: [{role, text}], video, model, review}`; answers with server-sent events `data: {"text": …}` or `data: {"error": …}` |

The terminal is a pseudo-terminal (`os.openpty`) whose program becomes the session leader with the pty as
controlling terminal, so Claude Code's interactive UI, colors, resizing and Ctrl+C work. The chat turns
Deep Chat's messages into a Messages API request (roles alternated, the review prepended to the first user
message as text plus base64 image blocks with `cache_control`), sends it with `urllib` (which honours
`HTTPS_PROXY`) and forwards the `text_delta` events. Errors before the answer starts (HTTP 408, 409, 429,
5xx, 529 and network errors) are retried up to 4 attempts with backoff or `retry-after`; a stream that
ends without `message_stop` or with an `error` event becomes a `data: {"error": …}` event. The connection
to the API is closed as soon as the page stops an answer. Screenshots are limited to 20 images, 3.7 MB each
and 18 MB in total per request.

In the page, every video gets its own `<deep-chat>` element with Deep Chat's `browserStorage`
(`localStorage` key `video-review.chat.v1:<review folder>`). Code is coloured by highlight.js through Deep
Chat's Markdown renderer; copy buttons are added to its shadow DOM with a `MutationObserver`.

## MCP server

`video-review FOLDER --mcp` speaks the [Model Context Protocol](https://modelcontextprotocol.io) over
stdin/stdout (newline-delimited JSON-RPC 2.0, protocol versions 2024-11-05 to 2025-06-18) instead of
starting the web server. It implements `initialize`, `ping`, `tools/list` and `tools/call` with three tools:
`list_video_reviews`, `get_video_review` (text plus one image content block per screenshot, up to
`max_images`) and `set_note_status`. It uses the same `Workspace` and `ReviewStore` as the web page, logs
only to stderr, and its only write is the status of a note.

## Security model

The tool is meant to run on your own machine while you review. It still assumes that other websites
open in your browser may be hostile:

- **Loopback only by default.** It binds to `127.0.0.1`; `--host 0.0.0.0` must be chosen explicitly and
  prints a warning.
- **DNS-rebinding protection.** Requests whose `Host` header is not the bound address (or `localhost`)
  are refused with 403.
- **No cross-origin writes.** `POST` and `PUT` requests with an `Origin` other than the page's own are
  refused, and notes are only accepted as `application/json`.
- **Strict file access.** Static files are resolved inside the package's `static/` folder only; videos
  only by their plain file name inside the workspace; screenshots only by the pattern
  `shots/<digits>.<jpg|png|webp>`. Path traversal attempts return 404.
- **Safe uploads.** Uploaded file names are reduced to a plain name with a video extension, files are
  streamed to a temporary file and only renamed into place when complete, uploads are size-limited
  (`--max-upload-mb`) and can be turned off (`--no-upload`). Transcripts are parsed before they are stored.
- **Strict validation** of every saved note (see [review-format.md](review-format.md)), request body
  limit of 200 MB for JSON, screenshot limit of 8 MB.
- **Content-Security-Policy** `default-src 'self'` without inline scripts and without `eval`, plus
  `nosniff`, `no-referrer` and `frame-ancestors 'none'`. Inline *styles* are allowed because xterm.js
  and the Deep Chat web component set them.
- **The ✦ Claude panel** can run a program and spend API credits, so: it is turned off when the server is
  reachable from other machines (`--host`); every request needs the per-start token, which other
  websites cannot read (no CORS) and which forces a CORS preflight they cannot pass; the program is fixed
  on the command line (the page cannot choose what runs); the API key is held in memory only, never
  logged, never returned to the page, and only sent to `api.anthropic.com`.

## Design choices

- **Standard library only**, so it runs anywhere Python 3.10+ runs, including locked-down machines. The
  two browser libraries of the ✦ Claude panel are vendored files, not a build step.
- **Marks as fractions** of the frame, so a review of a half-resolution preview applies to the final render.
- **Markdown plus JSON**: JSON for exact values and scripts, Markdown because agents (and people) read it
  well, screenshots because agents can look at images.
- **Same timecode as Remotion Studio** (`MM:SS.FF`) so that a note can be found in the Studio directly.
