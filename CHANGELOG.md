# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- MCP server (`video-review FOLDER --mcp`) with the tools `list_video_reviews`, `get_video_review` (notes +
  screenshots) and `set_note_status`, for the Claude desktop app, Claude Code and other MCP clients.
- "Copy for Claude chat" button: copies the prompt and the whole review as text for claude.ai and the apps.
- `GET /api/videos/<v>/markdown` returns `REVIEW.md` as text.
- Documentation for every way to use the tool with Claude: Claude Code, Claude chat, Projects and MCP.
- **✦ Claude side panel** (open with "✦ Claude" or "✦ Send to Claude"): resizable by dragging, full screen,
  closable while Claude keeps running.
  - *Claude Code* tab: the `claude` CLI in an embedded terminal (xterm.js, POSIX pseudo-terminal) in the
    project folder; "Send review" starts it with the review prompt or types it into the running session;
    reconnects after a page reload. Options `--project`, `--claude-command`, `--no-terminal`.
  - *Chat (API key)* tab: a chat with Claude through the Anthropic Messages API (Deep Chat component), with
    your own key (`ANTHROPIC_API_KEY` or pasted, kept in memory only); the open notes and their
    screenshots are sent along, with prompt caching. Options `--claude-model`, `--no-chat`.
  - Only offered on localhost; every request needs a per-start token.
- Vendored xterm.js 6.0.0, @xterm/addon-fit 0.11.0 and Deep Chat 2.5.1 (MIT), see `static/vendor/README.md`.
- API chat, polished and hardened:
  - one conversation per video, kept in the browser across reloads and restarts; "＋ New chat"
  - a Claude-style layout (answers as text with an avatar, your messages as bubbles), suggestions to start,
    a strip that shows what Claude sees (open notes and screenshots) with a switch
  - syntax-coloured code (highlight.js 11.11.1, BSD-3-Clause, vendored), copy buttons for code blocks and
    answers, tables, quotes
  - retries with backoff for overloaded / rate-limited / network errors, clear errors for answers that break
    off, a note when an answer reaches the length limit, a size budget for screenshots
  - picks up a restarted server's session token by itself; error bubbles are not sent back to Claude

- **Browser version on GitHub Pages** (<https://matbmoser.github.io/ai-video-review-tool/>): the review page
  without installing anything. Videos are opened from disk and never uploaded, notes are kept in the browser,
  the review downloads as the same zip, and the chat calls the API directly with your key. Built by
  `scripts/build_pages.py` and deployed by `.github/workflows/pages.yml`.

- Chat: several conversations per video, listed under **Chats** with search, rename and delete; the
  input is locked until an API key is set; a coloured border runs around the input while Claude answers.
- Delete a video (🗑 next to the video menu), optionally with its review folder and transcript
  (`DELETE /api/videos/<v>`).
- An **Export** menu with "Copy for Claude Code", "Copy for Claude chat" and "Download review (.zip)"; a
  GitHub link in the top bar; the MIT license notice in the page.

- `DEPENDENCIES.md`: the third-party software the tool uses or ships, with versions and licenses.

### Fixed
- The browser version's chat no longer spins forever when it fails before the first word (e.g. no key).
- Full screen chat fits the window (no cut-off edge, no horizontal scrollbar).
- Long video names wrap instead of overflowing the notes panel.
- A new mark is drawn as a solid box right away (it stayed dashed until the video moved).

### Changed
- Buttons of the notes panel and the Claude panel share one size and style, so nothing jumps or wraps.
- The page talks to its storage through one backend object (the server, or the browser in the Pages version).
- The copy buttons and the zip download are in the Export menu ("Copy for Claude Code", "Copy for Claude chat").
- The Content-Security-Policy allows inline styles (needed by xterm.js and Deep Chat); scripts are still
  limited to the tool's own files.
- The server stops cleanly (and stops Claude Code) on SIGTERM and SIGHUP, not only on Ctrl+C.

## [0.1.0] - 2026-11-03

### Added
- `video-review` command: frame-accurate review of any browser-playable video on `localhost`.
- Workspaces: start the tool on a folder (or with no argument) to review all its videos, each with its own
  review folder; switch videos in the page.
- Uploads: drop a video (or use the upload button) to copy it into the workspace with a progress bar;
  re-uploading a file with the same name keeps its notes. Transcripts can be uploaded too.
- Download the review as a zip (for claude.ai or teammates), re-mark notes, touch / pen support.
- Pins (click) and boxes (drag) on the frame, change types, open/done status, autosave.
- Screenshot of every note with the mark drawn on it.
- Transcript support (JSON, Whisper JSON, SRT, WebVTT); each note links the line spoken at that moment.
- Review folder with `notes.json` (schema version 1), `REVIEW.md` for AI agents and `shots/`.
- Review rounds (`rounds/<n>/`), timeline markers, playback speed, keyboard shortcuts.
- "Copy prompt for Claude" button and a Claude Code skill (`integrations/claude/skills/apply-video-review`).
- Security hardening: loopback binding, Host/Origin checks, strict validation, CSP.
