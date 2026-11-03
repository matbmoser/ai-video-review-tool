# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
