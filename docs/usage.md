# Usage

## Install

The tool is a single Python package without dependencies.

```bash
# from GitHub, into your current Python environment
pip install "git+https://github.com/matbmoser/ai-video-review-tool.git"

# or isolated, with pipx / uv
pipx install "git+https://github.com/matbmoser/ai-video-review-tool.git"
uv tool install "git+https://github.com/matbmoser/ai-video-review-tool.git"

# or from a clone, without installing
git clone https://github.com/matbmoser/ai-video-review-tool.git
PYTHONPATH=ai-video-review-tool/src python3 -m video_review --help
```

This installs the `video-review` command (also available as `python -m video_review`).

## Start a review

```bash
video-review --open                      # the current folder: pick a video or drop one onto the page
video-review renders/ --open             # every video in renders/
video-review path/to/video.mp4 --open    # one video (the others in its folder are listed too)
```

The command prints the address (default <http://localhost:8765>) and keeps running until you press
<kbd>Ctrl</kbd>+<kbd>C</kbd>. Re-run it to continue a review: notes are loaded from the review folder.

## Videos, uploads and the workspace

The folder the tool runs in is its **workspace**. Every video in it (`.mp4`, `.m4v`, `.webm`, `.mov`,
`.ogv`, `.mkv`) shows up in the video menu at the top left, with the number of open notes, and gets its
own review folder next to it (`launch.mp4` → `launch.review/`).

- **Upload a video** with the **⬆ Upload video** button or by dropping the file anywhere on the page. It is
  copied into the workspace (with a progress bar), so it works for files from anywhere on your computer.
- **Upload a new render with the same file name** to replace the video and **keep its notes**. That is
  the quickest way to check the fixes of a round.
- **＋ Transcript** (or dropping a `.json` / `.srt` / `.vtt` file) attaches the voice-over to the current
  video. It is saved as `<video>.transcript.<ext>` next to the video and found automatically next time.
- `--no-upload` turns uploads off (for example when you share the review on a network), and
  `--max-upload-mb` limits the size of uploads (default 20 GB).

Useful options:

| Option | Use it when |
| --- | --- |
| `--fps 30` | your render is not 30 fps. Frame stepping and timecodes use this value. |
| `--transcript voice.json` | you have the voice-over or subtitles for VIDEO; every note gets the line spoken at that moment |
| `--review-dir review/` | you want the notes of VIDEO somewhere else than `<video>.review/` next to it |
| `--no-upload` | the page should not accept uploads |
| `--port 0` | port 8765 is taken (for example by a second review); a free port is picked |
| `--title "Launch video v3"` | to tell browser tabs apart |

You can re-render the video while the tool is running: reload the page to see the new render. The notes
stay, because they are stored separately.

## Leave notes

1. Pause at the frame that needs a change. Use <kbd>←</kbd> / <kbd>→</kbd> to step frame by frame, or click
   the timeline. Red ticks on the timeline show where notes are.
2. **Click** on the picture to drop a numbered pin, or **drag** to mark an area.
3. In the panel, choose the type of change and describe it. Write what you want, not only what is wrong:
   *"change the headline to 'Ship faster'"* is better than *"headline wrong"*.
4. Repeat. Notes are saved about a second after you stop typing (and when you click **Save**).

Each note shows its timecode (click it to jump back), the frame number, the transcript line and the
screenshot that was saved with it. **⌖** re-marks a note: go to any frame, then click or drag to place the
pin or box again (the text stays; time, frame, transcript line and screenshot are updated). **✕** deletes
a note. Tick **done** when a change is implemented; untick **show done** to hide finished notes. Pins and
boxes work with a mouse, a pen or a finger.

**New round** moves the current notes, `REVIEW.md` and screenshots to `rounds/<n>/` and starts an empty
list. Use it after the agent has implemented a round, so the next round only contains new feedback.

**Copy prompt for Claude** copies a short prompt that tells Claude (or another agent) where the review is
and how to apply it. **⬇ Download review (.zip)** downloads the review folder (current round, earlier
rounds and the transcript), for example to attach it to Claude on claude.ai or to send it to a teammate.
See [claude.md](claude.md).

## Transcripts

Pass a transcript to see what is being said at each moment, and to link every note to that line.

**JSON**: a list of segments, or an object with a `segments` (or `lines`) list. Each segment needs a start,
an end and a text, in seconds. `start`/`end`, `s`/`e` and `from`/`to` are accepted, and times can also be
strings like `"00:01:02.500"`. An optional `id` names the line (handy for TTS pipelines: `"intro"`, `"p3"`).

```json
[
  {"id": "intro", "start": 0.3, "end": 4.8, "text": "Meet the product that makes your team faster."},
  {"id": "feature", "start": 5.2, "end": 11.5, "text": "Everything you need, in one place."}
]
```

Whisper's JSON output (`{"segments": [{"start": …, "end": …, "text": …}]}`) works as is.

**SRT** and **WebVTT** subtitles work too:

```text
1
00:00:00,300 --> 00:00:04,800
Meet the product that makes your team faster.
```

Examples: [`examples/transcript.json`](../examples/transcript.json), [`examples/transcript.srt`](../examples/transcript.srt).

## Troubleshooting

**The video does not play.** The browser plays the file itself, so it must be a format the browser
supports: H.264/AAC MP4 works in Chrome, Edge and Safari; VP9/AV1 WebM in Chrome and Firefox. Convert
with `ffmpeg -i in.mov -c:v libx264 -pix_fmt yuv420p -c:a aac out.mp4`.

**"cannot listen on 127.0.0.1:8765".** Another review is running. Stop it or use `--port 0`.

**An upload fails.** Check the free disk space and `--max-upload-mb`. Only video files are accepted;
the file name is cleaned up (special characters become `_`).

**Frame numbers are off by one or two.** Start the tool with the exact frame rate of the render
(`--fps 25`, `--fps 29.97`, …). Browsers seek to the nearest decodable frame, so in rare cases a step
lands one frame away. The saved `frame` is always computed from the time shown on screen.

**I want to review from another device.** Run with `--host 0.0.0.0` on a trusted network and open
`http://<your computer's IP>:8765` on the other device. Anyone on that network can then open and edit the
review.

**REVIEW.md is missing or outdated.** Regenerate it from `notes.json`:
`video-review video.mp4 --export-markdown`.
