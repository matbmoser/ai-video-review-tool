/* AI Video Review Tool – the browser-only backend (the GitHub Pages version).
 *
 * The same review page as `video-review`, without the Python server: the video is opened from your disk
 * and never uploaded, notes and screenshots are kept in this browser (IndexedDB), REVIEW.md and the zip are
 * made here, and the chat talks to the Anthropic API directly with your own key (kept in memory only).
 * The server version adds Claude Code in a terminal, the MCP server and review folders next to the video.
 *
 * Loaded before app.js; app.js and claude.js use window.VideoReviewBrowserBackend when it exists.
 * Constants shared with the Python package come from config.js (written by scripts/build_pages.py).
 */
"use strict";

(() => {
  const CFG = window.VideoReviewStatic || {};
  const KINDS = CFG.kinds || ["Change text", "Add", "Remove", "Move / resize", "Timing", "Style / color", "Audio / voice", "Other"];
  const VIDEO_EXT = [".mp4", ".m4v", ".webm", ".mov", ".ogv", ".mkv"];
  const TRANSCRIPT_EXT = [".json", ".srt", ".vtt"];
  const MAX_TEXT = 20000, MAX_SHOT = 8 * 1024 * 1024, MAX_NOTES = 1000;
  const urlFps = Number(new URL(location.href).searchParams.get("fps"));
  const FPS = urlFps >= 1 && urlFps <= 240 ? urlFps : 30;

  const files = new Map();     // video name → {file, url}   (only while the page is open)
  const shotUrls = new Map();  // "<video>\0<path>" → object URL

  // ── IndexedDB ─────────────────────────────────────────────────────────────────────────────
  // reviews: {name, doc, transcript: {filename, segments}, rounds: [{name, doc}]}
  // blobs:   "<video>\0shots/1.jpg" or "<video>\0rounds/001/shots/1.jpg" → Blob
  let dbPromise = null;
  function db() {
    dbPromise = dbPromise || new Promise((resolve, reject) => {
      const req = indexedDB.open("ai-video-review-tool", 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("reviews", {keyPath: "name"});
        req.result.createObjectStore("blobs");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error(`this browser does not allow storing the review (${req.error && req.error.message})`));
    });
    return dbPromise;
  }
  const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const finished = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error("storage aborted"));
  });

  async function getRecord(name) {
    const tx = (await db()).transaction("reviews");
    return (await done(tx.objectStore("reviews").get(name))) || {name, doc: null, transcript: null, rounds: []};
  }
  async function allRecords() {
    const tx = (await db()).transaction("reviews");
    return done(tx.objectStore("reviews").getAll());
  }
  async function getBlob(key) {
    const tx = (await db()).transaction("blobs");
    return done(tx.objectStore("blobs").get(key));
  }
  async function blobKeys(prefix) {
    const tx = (await db()).transaction("blobs");
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
    return done(tx.objectStore("blobs").getAllKeys(range));
  }
  const blobKey = (name, path) => `${name}\u0000${path}`;

  // ── helpers ───────────────────────────────────────────────────────────────────────────────
  const stem = (name) => name.replace(/\.[^.]+$/, "");
  const ext = (name) => (name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  function emptyDoc(name) { return {schemaVersion: 1, video: name, fps: FPS, savedAt: null, notes: []}; }
  function safeName(name) {
    const base = String(name || "").split(/[\\/]/).pop().replace(/[^\w.\- ()[\]]+/g, "_").replace(/^\.+/, "");
    return base.slice(-200) || "video.mp4";
  }

  function summary(name, rec) {
    const notes = (rec && rec.doc && rec.doc.notes) || [];
    const f = files.get(name);
    return {name, size: f ? f.file.size : 0, modified: f ? Math.round(f.file.lastModified / 1000) : 0,
      notes: notes.length, open: notes.filter((n) => n.status !== "done").length,
      transcript: rec && rec.transcript ? rec.transcript.filename : null, missing: !f};
  }

  // ── validation (the same rules as the Python store) ───────────────────────────────────────
  function fail(message) { throw new Error(message); }
  function number(v, label, lo, hi) {
    if (typeof v !== "number" || !Number.isFinite(v)) fail(`${label} must be a number`);
    if (v < lo || v > hi) fail(`${label} must be between ${lo} and ${hi}`);
    return v;
  }
  function text(v, label, limit) {
    if (typeof v !== "string") fail(`${label} must be a string`);
    if (v.length > limit) fail(`${label} is longer than ${limit} characters`);
    return v.replace(/\r\n/g, "\n").trim();
  }
  const round = (v, d) => Number(v.toFixed(d));

  function normalizeNote(raw) {
    if (!raw || typeof raw !== "object") fail("every note must be an object");
    const id = raw.id;
    if (!Number.isInteger(id) || id < 1 || id > 999999) fail("note 'id' must be an integer between 1 and 999999");
    const seconds = number(raw.seconds, `note ${id}: 'seconds'`, 0, 86400);
    if (!Number.isInteger(raw.frame) || raw.frame < 0) fail(`note ${id}: 'frame' must be a non-negative integer`);
    const m = raw.mark;
    if (!m || typeof m !== "object") fail(`note ${id}: 'mark' must be an object with x and y`);
    const x = number(m.x, `note ${id}: mark.x`, 0, 1), y = number(m.y, `note ${id}: mark.y`, 0, 1);
    const mark = {x: round(x, 4), y: round(y, 4)};
    if (m.w != null || m.h != null) {
      mark.w = round(Math.min(number(m.w, `note ${id}: mark.w`, 0, 1), 1 - x), 4);
      mark.h = round(Math.min(number(m.h, `note ${id}: mark.h`, 0, 1), 1 - y), 4);
    }
    const status = raw.status || "open";
    if (!["open", "done"].includes(status)) fail(`note ${id}: 'status' must be one of open, done`);
    let transcript = null;
    if (raw.transcript && typeof raw.transcript === "object") {
      transcript = {id: text(String(raw.transcript.id ?? ""), `note ${id}: transcript id`, 200),
        text: text(raw.transcript.text ?? "", `note ${id}: transcript text`, MAX_TEXT)};
    }
    return {
      id, time: text(raw.time ?? "", `note ${id}: 'time'`, 32), seconds: round(seconds, 3), frame: raw.frame,
      kind: text(raw.kind ?? "Other", `note ${id}: 'kind'`, 60) || "Other", status,
      text: text(raw.text ?? "", `note ${id}: 'text'`, MAX_TEXT), mark, transcript, shot: null,
    };
  }

  function dataUrlToBlob(url, id) {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
    if (!m) return null;
    const bin = atob(m[2].replace(/\s+/g, ""));
    if (bin.length > MAX_SHOT) fail(`note ${id}: screenshot is larger than 8 MB`);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const isImage = (bytes[0] === 0xff && bytes[1] === 0xd8) || (bytes[0] === 0x89 && bytes[1] === 0x50)
      || (bin.slice(0, 4) === "RIFF" && bin.slice(8, 12) === "WEBP");
    if (!isImage) fail(`note ${id}: screenshot is not a JPEG, PNG or WebP image`);
    return {blob: new Blob([bytes], {type: `image/${m[1]}`}), ext: {jpeg: "jpg", png: "png", webp: "webp"}[m[1]]};
  }

  // ── transcripts (the same formats as transcript.py) ──────────────────────────────────────
  const TS = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
  function timestamp(v) {
    const m = TS.exec(String(v).trim());
    if (!m) return null;
    return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
  }
  function firstNumber(raw, keys) {
    for (const k of keys) {
      const v = raw[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string") {
        const ts = timestamp(v);
        if (ts != null) return ts;
        if (v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
      }
    }
    return null;
  }
  function segment(id, start, end, t) {
    if (end < start) [start, end] = [end, start];
    return {id: String(id), start: round(start, 3), end: round(end, 3), text: String(t).split(/\s+/).filter(Boolean).join(" ")};
  }
  const sorted = (segs) => segs.sort((a, b) => a.start - b.start || a.end - b.end);
  function parseJsonTranscript(source) {
    let data;
    try { data = JSON.parse(source); } catch (err) { fail(`invalid JSON transcript: ${err.message}`); }
    if (data && !Array.isArray(data)) data = ["segments", "lines", "items"].map((k) => data[k]).find(Array.isArray) || data;
    if (!Array.isArray(data)) fail("JSON transcript must be a list of segments or contain a 'segments' list");
    return sorted(data.map((raw, i) => {
      if (!raw || typeof raw !== "object") fail(`segment ${i + 1} is not an object`);
      const start = firstNumber(raw, ["start", "s", "from", "begin"]), end = firstNumber(raw, ["end", "e", "to", "stop"]);
      if (start == null || end == null) fail(`segment ${i + 1} needs a start and an end time in seconds`);
      if (typeof (raw.text ?? "") !== "string") fail(`segment ${i + 1}: 'text' must be a string`);
      return segment(raw.id ?? i + 1, start, end, raw.text ?? "");
    }));
  }
  function parseCues(source, webvtt) {
    const out = [];
    for (const block of source.trim().split(/\r?\n\s*\r?\n/)) {
      const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      if (webvtt && /^(WEBVTT|NOTE|STYLE|REGION)/.test(lines[0])) continue;
      const k = lines.findIndex((l) => l.includes("-->"));
      if (k < 0) continue;
      const [left, right] = lines[k].split("-->");
      const start = timestamp(left), end = timestamp((right.trim().split(/\s+/)[0]) || "");
      if (start == null || end == null) fail(`bad cue timing: ${lines[k]}`);
      out.push(segment(k > 0 ? lines[0] : out.length + 1, start, end, lines.slice(k + 1).map((l) => l.replace(/<[^>]+>/g, "")).join(" ")));
    }
    return sorted(out);
  }
  function parseTranscript(filename, source) {
    const e = ext(filename);
    source = source.replace(/^﻿/, "");
    if (e === ".json") return parseJsonTranscript(source);
    if (e === ".srt") return parseCues(source, false);
    if (e === ".vtt") return parseCues(source, true);
    return fail(`unsupported transcript format '${e}' (use .json, .srt or .vtt)`);
  }

  // ── REVIEW.md (the same text as store.render_markdown) ───────────────────────────────────
  const g = (n) => String(Number(Number(n).toPrecision(6)));
  const fmtSeconds = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;
  function describeMark(m) {
    const x = (m.x * 100).toFixed(1), y = (m.y * 100).toFixed(1);
    if (m.w != null) return `box from x ${x}% / y ${y}%, ${(m.w * 100).toFixed(1)}% wide and ${(m.h * 100).toFixed(1)}% high (of the frame)`;
    return `point at x ${x}% / y ${y}% of the frame`;
  }
  function renderMarkdown(doc) {
    const notes = doc.notes || [];
    const open = notes.filter((n) => n.status !== "done");
    const lines = [
      `# Video review: ${doc.video || "video"}`, "",
      `- Saved: ${doc.savedAt || "not yet"}`,
      `- Frame rate: ${g(doc.fps ?? 30)} fps (timecodes are \`MM:SS.FF\`, FF = frame within the second)`,
      `- Notes: ${notes.length} (${open.length} open, ${notes.length - open.length} done)`, "",
      "> **For the AI agent implementing these changes:** each note below is one requested change at an",
      "> exact frame. `mark` gives the position on the picture as fractions of the frame size",
      "> (0,0 = top-left, 1,1 = bottom-right); a box has a width and height, a pin is a single point.",
      "> Open the screenshot of each note to see the frame with the mark drawn on it. Implement every",
      "> note with status `open`; notes with status `done` are kept for reference only.", "",
    ];
    if (!notes.length) lines.push("_No notes yet._", "");
    for (const n of notes) {
      let title = `## ${n.id} · ${n.time || fmtSeconds(n.seconds)} (frame ${n.frame}) · ${n.kind}`;
      if (n.status === "done") title += " · done";
      lines.push(title, "", `- **Where:** ${describeMark(n.mark)}`);
      if (n.transcript) {
        const label = n.transcript.id ? `line \`${n.transcript.id}\`` : "line";
        lines.push(`- **Spoken at this moment (${label}):** “${n.transcript.text || ""}”`);
      }
      lines.push(n.shot ? `- **Screenshot:** ![note ${n.id}](${n.shot})` : "- **Screenshot:** none");
      lines.push("", "**Requested change:**", "");
      const body = n.text || "_(no description; see the mark on the screenshot)_";
      lines.push(body.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"), "");
    }
    return `${lines.join("\n").replace(/\s+$/, "")}\n`;
  }

  // ── zip (stored, no compression: screenshots are JPEG already) ───────────────────────────
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  async function makeZip(entries) {
    const enc = new TextEncoder(), parts = [], central = [];
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    let offset = 0;
    for (const [path, content] of entries) {
      const data = typeof content === "string" ? enc.encode(content) : new Uint8Array(await content.arrayBuffer());
      const name = enc.encode(path), crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true); local.setUint16(10, time, true); local.setUint16(12, date, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      parts.push(local.buffer, name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(c.buffer, name);
      offset += 30 + name.length + data.length;
    }
    const size = central.reduce((s, b) => s + b.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, size, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], {type: "application/zip"});
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function refreshShotUrls(name, doc) {
    for (const [key, url] of shotUrls) {
      if (key.startsWith(`${name}\u0000`)) { URL.revokeObjectURL(url); shotUrls.delete(key); }
    }
    for (const n of doc.notes) {
      if (!n.shot) continue;
      const blob = await getBlob(blobKey(name, n.shot));
      if (blob) shotUrls.set(blobKey(name, n.shot), URL.createObjectURL(blob));
    }
  }

  // ── the backend used by app.js ───────────────────────────────────────────────────────────
  const backend = {
    local: true,

    async workspace() {
      const records = await allRecords();
      const byName = new Map(records.map((r) => [r.name, r]));
      const names = [...new Set([...files.keys(), ...records.filter((r) => r.doc || r.rounds.length || r.transcript).map((r) => r.name)])]
        .sort((a, b) => a.localeCompare(b));
      return {
        version: CFG.version || "", title: null, workspace: "this browser", fps: FPS, uploads: true, local: true,
        githubMark: !!CFG.githubMark,
        maxUploadBytes: Number.MAX_SAFE_INTEGER, videoExtensions: VIDEO_EXT, transcriptExtensions: TRANSCRIPT_EXT,
        videos: names.map((n) => summary(n, byName.get(n))),
      };
    },

    async config(name) {
      const rec = await getRecord(name), f = files.get(name);
      return {
        name, title: name, url: f ? f.url : null, type: f ? f.file.type || null : null, fps: (rec.doc && rec.doc.fps) || FPS,
        kinds: KINDS, transcript: rec.transcript ? rec.transcript.segments : [],
        transcriptFile: rec.transcript ? rec.transcript.filename : null,
        reviewFolder: `${stem(name)}.review`, reviewPath: `${stem(name)}.review`, rounds: rec.rounds.map((r) => r.name),
      };
    },

    async review(name) {
      const doc = (await getRecord(name)).doc || emptyDoc(name);
      await refreshShotUrls(name, doc);
      return doc;
    },

    shotUrl: (name, shot) => shotUrls.get(blobKey(name, shot)) || "",

    async save(name, payload) {
      if (!payload || !Array.isArray(payload.notes)) fail("payload must be an object with a 'notes' list");
      if (payload.notes.length > MAX_NOTES) fail(`too many notes (max ${MAX_NOTES})`);
      const rec = await getRecord(name);
      const existing = new Set(await blobKeys(blobKey(name, "shots/")));
      const notes = [], writes = [], seen = new Set();
      for (const raw of payload.notes) {
        const note = normalizeNote(raw);
        if (seen.has(note.id)) fail(`duplicate note id ${note.id}`);
        seen.add(note.id);
        const shot = typeof raw.shot === "string" ? raw.shot : "";
        const fresh = shot.startsWith("data:") ? dataUrlToBlob(shot, note.id) : null;
        if (shot.startsWith("data:") && !fresh) fail(`note ${note.id}: screenshot is not a valid image`);
        if (fresh) {
          note.shot = `shots/${note.id}.${fresh.ext}`;
          writes.push([blobKey(name, note.shot), fresh.blob]);
        } else if (shot) {
          const path = shot.split("?")[0];
          const m = /^shots\/(\d{1,6})\.(jpg|png|webp)$/.exec(path);
          if (!m || Number(m[1]) !== note.id) fail(`note ${note.id}: 'shot' must be a data URL or shots/${note.id}.<ext>`);
          note.shot = existing.has(blobKey(name, path)) ? path : null;
        }
        notes.push(note);
      }
      notes.sort((a, b) => a.seconds - b.seconds || a.id - b.id);
      const doc = {schemaVersion: 1, video: name, fps: (rec.doc && rec.doc.fps) || FPS, savedAt: now(), notes};
      const keep = new Set(notes.filter((n) => n.shot).map((n) => blobKey(name, n.shot)));
      const tx = (await db()).transaction(["reviews", "blobs"], "readwrite");
      for (const [key, blob] of writes) tx.objectStore("blobs").put(blob, key);
      for (const key of existing) if (!keep.has(key)) tx.objectStore("blobs").delete(key);
      tx.objectStore("reviews").put({...rec, doc});
      await finished(tx);
      if (writes.length || [...existing].some((k) => !keep.has(k))) await refreshShotUrls(name, doc);
      return doc;
    },

    async archive(name) {
      const rec = await getRecord(name);
      if (!rec.doc) return {archived: null, rounds: rec.rounds.map((r) => r.name)};
      const numbers = rec.rounds.map((r) => Number(r.name)).filter(Number.isFinite);
      const round = String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(3, "0");
      const keys = await blobKeys(blobKey(name, "shots/"));
      const blobs = await Promise.all(keys.map(getBlob));
      const tx = (await db()).transaction(["reviews", "blobs"], "readwrite");
      keys.forEach((key, i) => {
        const path = key.split("\u0000")[1];
        tx.objectStore("blobs").put(blobs[i], blobKey(name, `rounds/${round}/${path}`));
        tx.objectStore("blobs").delete(key);
      });
      const rounds = [...rec.rounds, {name: round, doc: rec.doc}];
      tx.objectStore("reviews").put({...rec, doc: null, rounds});
      await finished(tx);
      return {archived: round, rounds: rounds.map((r) => r.name)};
    },

    async uploadVideo(file, onProgress) {
      if (!VIDEO_EXT.includes(ext(file.name)) && !String(file.type).startsWith("video/")) fail(`${file.name} is not a video file`);
      const name = safeName(file.name);
      const old = files.get(name);
      if (old) URL.revokeObjectURL(old.url);
      files.set(name, {file, url: URL.createObjectURL(file)});
      if (onProgress) onProgress(1);
      return summary(name, await getRecord(name));
    },

    async uploadTranscript(name, file) {
      if (!TRANSCRIPT_EXT.includes(ext(file.name))) fail("transcripts must be .json, .srt or .vtt files");
      if (file.size > 10 * 1024 * 1024) fail("the transcript is larger than 10 MB");
      const source = await file.text();
      const segments = parseTranscript(file.name, source);
      const rec = await getRecord(name);
      const tx = (await db()).transaction("reviews", "readwrite");
      tx.objectStore("reviews").put({...rec, transcript: {filename: `${stem(name)}.transcript${ext(file.name)}`, segments, source}});
      await finished(tx);
      return {transcript: segments, summary: summary(name, await getRecord(name))};
    },

    async deleteVideo(name, withReview) {
      const f = files.get(name);
      if (f) { URL.revokeObjectURL(f.url); files.delete(name); }
      if (withReview) {
        const keys = await blobKeys(blobKey(name, ""));
        const tx = (await db()).transaction(["reviews", "blobs"], "readwrite");
        for (const key of keys) tx.objectStore("blobs").delete(key);
        tx.objectStore("reviews").delete(name);
        await finished(tx);
        for (const [key, url] of shotUrls) if (key.startsWith(`${name}\u0000`)) { URL.revokeObjectURL(url); shotUrls.delete(key); }
      }
      return {deleted: name, review: !!withReview};
    },

    async markdown(name) { return renderMarkdown((await getRecord(name)).doc || emptyDoc(name)); },

    async exportZip(name, filename) {
      const rec = await getRecord(name), top = `${stem(name)}.review`;
      const entries = [];
      const addRound = async (prefix, doc, shotPrefix) => {
        entries.push([`${top}/${prefix}notes.json`, `${JSON.stringify(doc, null, 2)}\n`]);
        entries.push([`${top}/${prefix}REVIEW.md`, renderMarkdown(doc)]);
        for (const n of doc.notes) {
          if (!n.shot) continue;
          const blob = await getBlob(blobKey(name, `${shotPrefix}${n.shot}`));
          if (blob) entries.push([`${top}/${prefix}${n.shot}`, blob]);
        }
      };
      if (rec.doc) await addRound("", rec.doc, "");
      for (const r of rec.rounds) await addRound(`rounds/${r.name}/`, r.doc, `rounds/${r.name}/`);
      if (rec.transcript && rec.transcript.source) entries.push([`${top}/transcript${ext(rec.transcript.filename)}`, rec.transcript.source]);
      if (!entries.length) entries.push([`${top}/REVIEW.md`, renderMarkdown(emptyDoc(name))]);
      download(await makeZip(entries), filename);
    },

    // exposed for claude.js and the tests
    renderMarkdown, parseTranscript, makeZip,
    async openReview(name) {
      const doc = (await getRecord(name)).doc || emptyDoc(name);
      return {doc, shot: async (path) => getBlob(blobKey(name, path))};
    },
  };

  // ── chat: the Anthropic Messages API, straight from the browser, with your own key ──────
  const MODELS = CFG.models || [{id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5"}];
  const RETRY = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
  let apiKey = null;  // memory only: gone when the page is closed or reloaded

  function apiError(status, detail) {
    const hints = {401: "the API key was rejected", 403: "the API key may not use this model", 404: "unknown model",
      413: "the request is too large", 429: "rate limit or quota reached", 529: "the API is overloaded, try again"};
    return `Anthropic API: ${hints[status] || `HTTP ${status}`}${detail ? ` (${detail})` : ""}`;
  }

  const toBase64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  async function reviewBlocks(name) {
    const {doc, shot} = await backend.openReview(name);
    const open = doc.notes.filter((n) => n.status !== "done");
    const blocks = [{type: "text", text: `Here is the review (open notes only):\n\n${renderMarkdown({...doc, notes: open})}`}];
    let budget = 18000000, images = 0;
    const skipped = [];
    for (const n of open) {
      if (!n.shot) continue;
      const blob = await shot(n.shot);
      if (!blob) continue;
      if (images >= 20 || blob.size > 3700000 || blob.size > budget) { skipped.push(n.id); continue; }
      budget -= blob.size; images++;
      blocks.push({type: "text", text: `Screenshot of note ${n.id} (${n.time}, frame ${n.frame}):`});
      blocks.push({type: "image", source: {type: "base64", media_type: blob.type || "image/jpeg", data: await toBase64(blob)}});
    }
    if (skipped.length) {
      blocks.push({type: "text", text: `(Screenshots of note(s) ${skipped.join(", ")} were not attached to keep the request small; ask the user to describe them if needed.)`});
    }
    blocks[blocks.length - 1].cache_control = {type: "ephemeral"};
    return blocks;
  }

  async function buildRequest(chatMessages, name, includeReview, model) {
    const messages = [];
    for (const raw of (chatMessages || []).slice(-60)) {
      if (!raw || !["user", "ai", "assistant"].includes(raw.role) || typeof raw.text !== "string" || !raw.text.trim()) continue;
      const role = raw.role === "user" ? "user" : "assistant";
      const t = raw.text.slice(0, 100000);
      if (messages.length && messages[messages.length - 1].role === role) messages[messages.length - 1].content[0].text += `\n\n${t}`;
      else messages.push({role, content: [{type: "text", text: t}]});
    }
    while (messages.length && messages[0].role !== "user") messages.shift();
    if (!messages.length) fail("no message to send");
    if (includeReview && name) messages[0].content = [...(await reviewBlocks(name)), ...messages[0].content];
    const chosen = MODELS.some((m) => m.id === model) ? model : MODELS[0].id;
    return {model: chosen, max_tokens: 8000, system: CFG.systemPrompt || "", messages, stream: true};
  }

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("stopped", "AbortError")); }, {once: true});
  });

  async function openStream(body, signal) {
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetch(CFG.apiUrl || "https://api.anthropic.com/v1/messages", {
          method: "POST", signal, body: JSON.stringify(body),
          headers: {"x-api-key": apiKey, "anthropic-version": CFG.apiVersion || "2023-06-01", "content-type": "application/json",
            "anthropic-dangerous-direct-browser-access": "true"},
        });
      } catch (err) {
        if (signal.aborted) throw err;
        if (attempt >= 4) fail("cannot reach the Anthropic API (check your connection)");
        await sleep(1000 * 2 ** (attempt - 1), signal);
        continue;
      }
      if (res.ok) return res;
      const detail = await res.json().then((j) => (j.error && j.error.message) || "").catch(() => "");
      if (!RETRY.has(res.status) || attempt >= 4) fail(apiError(res.status, detail));
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(20, after) * 1000 : 1000 * 2 ** (attempt - 1), signal);
    }
  }

  async function* textDeltas(res) {
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let buffer = "", finishedStream = false;
    for (;;) {
      const {value, done: end} = await reader.read();
      if (end) break;
      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        let event;
        try { event = JSON.parse(line.slice(5)); } catch (_) { continue; }
        if (event.type === "content_block_delta" && event.delta && event.delta.type === "text_delta") yield event.delta.text || "";
        else if (event.type === "message_delta" && event.delta) {
          if (event.delta.stop_reason === "max_tokens") yield "\n\n*(The answer reached the length limit and was cut off. Ask Claude to continue.)*";
          if (event.delta.stop_reason === "refusal") yield "\n\n*(Claude declined to continue this answer.)*";
        } else if (event.type === "message_stop") finishedStream = true;
        else if (event.type === "error") {
          const e = event.error || {};
          fail(e.type === "overloaded_error" ? "Claude is overloaded right now. Please try again in a moment." : `Anthropic API error: ${e.message || "unknown error"}`);
        }
      }
    }
    if (!finishedStream) fail("the answer was interrupted before it was complete; try again");
  }

  backend.chat = {
    status: () => ({enabled: true, reason: null, configured: !!apiKey, source: apiKey ? "page" : null,
      model: CFG.defaultModel || MODELS[0].id, models: MODELS, browser: true}),
    setKey(key) {
      key = String(key || "").trim();
      if (!key.startsWith("sk-") || key.length < 20 || key.length > 300 || /\s/.test(key)) {
        fail("that does not look like an Anthropic API key (it starts with 'sk-')");
      }
      apiKey = key;
      return backend.chat.status();
    },
    forgetKey() { apiKey = null; return backend.chat.status(); },
    /** a Deep Chat stream handler for the conversation about `name`; `showError` shows an error that happens
     *  before any text arrived (Deep Chat cannot show a stream error before the first chunk) */
    handler(name, options, showError) {
      return async (body, signals) => {
        const controller = new AbortController();
        signals.stopClicked.listener = () => controller.abort();
        let streaming = false;
        try {
          if (!apiKey) fail("No API key yet: add your Anthropic API key above to chat.");
          const {model, review} = options();
          const res = await openStream(await buildRequest(body.messages, name, review, model), controller.signal);
          signals.onOpen();
          for await (const t of textDeltas(res)) {
            if (!t) continue;
            streaming = true;
            await signals.onResponse({text: t});  // in order
          }
          signals.onClose();
        } catch (err) {
          const text = err.message || String(err);
          if (controller.signal.aborted) { signals.onClose(); return; }
          if (streaming) { await signals.onResponse({error: text}); return; }
          signals.onClose();
          showError(text);
        }
      };
    },
    buildRequest,
  };

  window.VideoReviewBrowserBackend = backend;
})();
