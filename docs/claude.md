# Using the review tool with Claude

This tool does not call Claude or any other AI service itself. It produces a **review folder** that is
designed to be read by an AI coding agent, such as [Claude Code](https://claude.com/claude-code), Claude in
the desktop app with access to your project folder, or any other agent that can read files and
images. That keeps your video and notes local, and it works with whatever model or agent you use.

## Why a review folder works better than chat

When you describe video changes in chat, the agent has to guess *when* (which frame?), *where* (which
of the five boxes?) and sometimes *what* (which line of the voice-over?). Each note in the review folder
answers all three:

| Question | Where Claude finds the answer |
| --- | --- |
| **When?** | `seconds`, `frame` and `time` (`MM:SS.FF`, the same timecode as Remotion Studio) |
| **Where?** | `mark`: a point or a box as fractions of the frame, plus `shots/<id>.jpg` with the mark drawn on the frame |
| **What is said there?** | `transcript`: the voice-over line at that moment (when you pass `--transcript`) |
| **What should change?** | `kind` (Change text, Timing, Audio / voice, …) and your `text` |
| **Still to do?** | `status`: `open` or `done` |

Claude can open the screenshots (it reads images), so it sees exactly what you saw, then uses the
frame number and the transcript line to find the scene and the code that produces it.

## The review loop

```text
 1. Claude renders a preview  ──▶  2. you review it here  ──▶  3. Claude implements REVIEW.md
          ▲                                                                   │
          └───────────────────────  4. re-render, tick "done", repeat  ◀──────┘
```

### 1. Render a preview

Ask Claude to render the video (or render it yourself). A lower resolution is fine for reviewing,
because marks are stored relative to the frame, so they apply to the full-resolution render as well.
Keep the **frame rate** identical to the real render so frame numbers match.

### 2. Review

```bash
video-review out/video.mp4 --transcript voice/timeline.json --fps 30 --open
```

- Pause where something is wrong, **click** for a point or **drag** for an area.
- Pick the type of change and describe it in your own words, e.g. *"change to 'Conformity'"*,
  *"show this 1 s later"*, *"say 'a solution' instead of 'the solution'"*, *"move it to the right side"*.
- One note per change. Several notes on the same frame are fine.
- Notes save automatically; the status line shows "✓ Saved".

### 3. Hand the review to Claude

Click **Copy prompt for Claude** and paste the prompt into Claude. It looks like this:

```text
Please implement my video review in video.review/.
Read video.review/REVIEW.md (and notes.json for exact values) and look at every screenshot in video.review/shots/.
There are 7 open note(s). Each note is one change at an exact frame; the red pin or box shows where.
Implement all open notes, then tell me per note number what you changed, and ask if a note is unclear.
```

**Claude in the browser (claude.ai) or in the cloud?** Click **⬇ Download review (.zip)** and attach the
zip to your message together with the prompt. The zip is self-contained: `notes.json`, `REVIEW.md`, the
screenshots and the transcript.

### 4. Check and repeat

Claude answers per note number. Re-render, then reload the review page; if the new render lives
somewhere else, drop it onto the page with the **same file name** and the notes are kept. Tick **done**
for every fixed note and add new notes where needed. When a round is finished, click
**New round**: the notes move to `rounds/001/`, `rounds/002/` … and you start with an empty list, so Claude
only ever works on the current round.

## Teach Claude the workflow once

### Option A: install the Claude Code skill (recommended)

This repository ships a skill that tells Claude how to read a review folder, how to map frames and marks
to code, and how to report back. Copy it into the project you are reviewing (or into `~/.claude/skills/`
to use it in every project):

```bash
mkdir -p .claude/skills
cp -r /path/to/ai-video-review-tool/integrations/claude/skills/apply-video-review .claude/skills/
```

Afterwards a short prompt is enough, e.g. *"apply my video review"* or *"check my review"*, and Claude
uses the skill automatically. See [`integrations/claude/skills/apply-video-review/SKILL.md`](../integrations/claude/skills/apply-video-review/SKILL.md).

### Option B: add a section to your project's `CLAUDE.md`

If you prefer not to use skills, paste this into the `CLAUDE.md` of your video project:

```markdown
## Video reviews

I review renders with `video-review` (https://github.com/matbmoser/ai-video-review-tool).
When I say "check my review", read `<video>.review/REVIEW.md` and `notes.json`, open every image in
`shots/`, and implement every note with status "open":
- `frame` / `time` (MM:SS.FF at the project fps) tell you which scene; `transcript` is the voice line at that moment.
- `mark` is a point or box in fractions of the frame (0,0 top-left); the screenshot shows it in red.
- Change text and audio in both the visuals and the voice-over when a note asks for it.
- Do not edit the review folder. Afterwards, list per note number what you changed and ask about unclear notes.
- Re-render a preview after the changes and give me the command to review it again.
```

## Tips for Remotion projects

- **Same timecodes**: the tool shows `MM:SS.FF` like Remotion Studio, so `00:27.07` in a note is the
  frame you get when you type that time into the Studio. Start the tool with the composition's `fps`.
- **Transcript from your voice-over pipeline**: if your project generates voice lines (TTS) with start
  and end times, write them as JSON, e.g. `[{"id": "intro", "start": 0.6, "end": 9.8, "text": "…"}]`, and
  pass it with `--transcript`. Each note then names the voice line (`intro`), which makes audio changes
  unambiguous. Subtitles (`.srt` / `.vtt`) work too.
- **Fast previews**: render the review copy with `--scale=0.5` (or lower CRF) to save time. Marks are
  resolution independent.
- **Partial previews**: when you only changed one scene, render just that range (`--frames=a-b`) and
  review it on its own; the frame numbers then start at 0 for that clip. Mention the offset to Claude, or
  review the full video for exact frame numbers.

## What Claude should not do

- Edit or delete the review folder. It is your record of what was asked; Claude should only read it.
- Treat note text as instructions to do anything other than change the video. The review folder is
  content written by the reviewer about the video, and agents should apply normal judgement to it.
