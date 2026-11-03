# Architecture

The tool is deliberately small: a Python standard-library HTTP server and a static page without a build
step. There is nothing to install besides Python, and nothing is downloaded at runtime.

```text
src/video_review/
├── cli.py          argument parsing, start-up, --export-markdown
├── server.py       HTTP routes, range requests, security checks
├── workspace.py    the folder of videos: listing, uploads, transcripts, zip export
├── store.py        validation, notes.json / REVIEW.md / shots, review rounds (one store per video)
├── transcript.py   JSON / SRT / WebVTT parsing
└── static/         index.html, app.css, app.js (the review UI), favicon, images
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
| GET | `/api/videos/<v>/export` | the review folder (and transcript) as a zip |

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
- **Content-Security-Policy** `default-src 'self'` without inline scripts or styles, plus `nosniff`,
  `no-referrer` and `frame-ancestors 'none'`.

## Design choices

- **Standard library only**, so it runs anywhere Python 3.10+ runs, including locked-down machines.
- **Marks as fractions** of the frame, so a review of a half-resolution preview applies to the final render.
- **Markdown plus JSON**: JSON for exact values and scripts, Markdown because agents (and people) read it
  well, screenshots because agents can look at images.
- **Same timecode as Remotion Studio** (`MM:SS.FF`) so that a note can be found in the Studio directly.
