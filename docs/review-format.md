# Review format

A review folder contains everything an agent needs to implement the changes. `notes.json` is the source
of truth; `REVIEW.md` is generated from it on every save.

```text
<video>.review/
├── notes.json
├── REVIEW.md
├── shots/<id>.jpg      (or .png / .webp)
└── rounds/<NNN>/       earlier rounds, same layout
```

## `notes.json`

```json
{
  "schemaVersion": 1,
  "video": "demo.webm",
  "fps": 30.0,
  "savedAt": "2026-11-03T18:21:08Z",
  "notes": [
    {
      "id": 1,
      "time": "00:02.15",
      "seconds": 2.5,
      "frame": 75,
      "kind": "Change text",
      "status": "open",
      "text": "Change the title to “Ship videos faster” and make it 20% bigger",
      "mark": {"x": 0.12, "y": 0.36, "w": 0.76, "h": 0.17},
      "transcript": {"id": "intro", "text": "Meet the product that makes your team faster."},
      "shot": "shots/1.jpg"
    }
  ]
}
```

| Field | Type | Description |
| --- | --- | --- |
| `schemaVersion` | integer | format version, currently `1` |
| `video` | string | file name of the reviewed video |
| `fps` | number | frame rate used for `frame` and `time` |
| `savedAt` | string \| null | ISO 8601 UTC time of the last save |
| `notes[].id` | integer ≥ 1 | stable note number shown in the UI and on the screenshot |
| `notes[].time` | string | `MM:SS.FF`, FF = frame within the second (Remotion Studio format) |
| `notes[].seconds` | number | position in seconds (3 decimals) |
| `notes[].frame` | integer | `round(seconds × fps)` |
| `notes[].kind` | string | change type: `Change text`, `Add`, `Remove`, `Move / resize`, `Timing`, `Style / color`, `Audio / voice`, `Other` |
| `notes[].status` | `"open"` \| `"done"` | whether the change still has to be implemented |
| `notes[].text` | string | the requested change, in the reviewer's words (may be empty) |
| `notes[].mark` | object | `{x, y}` for a pin, `{x, y, w, h}` for a box; fractions of the frame, `0,0` = top-left |
| `notes[].transcript` | object \| null | `{id, text}` of the transcript line at that moment |
| `notes[].shot` | string \| null | path of the screenshot, relative to the review folder |

Notes are sorted by time. To convert a mark to pixels of a `W × H` render: `left = x·W`, `top = y·H`,
`width = w·W`, `height = h·H`.

## `REVIEW.md`

A Markdown rendering of the same notes with a short instruction block for agents. Each note looks like:

```markdown
## 1 · 00:02.15 (frame 75) · Change text

- **Where:** box from x 12.0% / y 36.0%, 76.0% wide and 17.0% high (of the frame)
- **Spoken at this moment (line `intro`):** “Meet the product that makes your team faster.”
- **Screenshot:** ![note 1](shots/1.jpg)

**Requested change:**

> Change the title to “Ship videos faster” and make it 20% bigger
```

Done notes get `· done` in their heading. See the full example in
[`examples/sample.review/REVIEW.md`](../examples/sample.review/REVIEW.md).

## Validation

The server validates every save: integer ids (unique), times and frames ≥ 0, marks inside the frame
(boxes are clipped to it), texts up to 20 000 characters, statuses `open`/`done`, and screenshots that are
real JPEG/PNG/WebP images up to 8 MB. Invalid saves are rejected with HTTP 400 and nothing is written.
Files are written atomically, so a crash never leaves a half-written `notes.json`.
