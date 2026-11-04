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

### Changed
- "Copy prompt for Claude" is now "Copy prompt for Claude Code" (both copy buttons stay).
- The Content-Security-Policy allows inline styles (needed by xterm.js and Deep Chat); scripts are still
  limited to the tool's own files.
- The server stops cleanly (and stops Claude Code) on SIGTERM and SIGHUP, not only on Ctrl+C.

### Fixed
- A new mark is drawn as a solid box right away (it stayed dashed until the video moved).

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
