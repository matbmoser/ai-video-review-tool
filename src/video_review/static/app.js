/* AI Video Review Tool – browser UI.
 *
 * Pick or upload a video, pause it, click on the picture to pin a change (or drag to mark an area),
 * describe the change, and the notes are saved to the video's review folder (notes.json, REVIEW.md,
 * shots/) for an AI agent. No frameworks, no build step; the DOM is built with createElement so the
 * strict Content-Security-Policy holds.
 */
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const video = $("video"), stage = $("stage"), overlay = $("overlay");
  const enc = encodeURIComponent;

  const state = {
    workspace: null,      // /api/workspace
    name: null,           // current video file name
    config: null,         // /api/videos/<name>/config
    fps: 30,
    kinds: ["Change text", "Other"],
    transcript: [],
    notes: [],
    nextId: 1,
    activeId: null,
    remarkId: null,       // note whose mark is being placed again
    drag: null,
    saving: false,
    saveTimer: null,
    dirty: false,
    uploading: false,
  };

  // ── helpers ──────────────────────────────────────────────────────────────────────────────
  /** create an element: el("div", {className: "x", onclick: fn}, child, "text") */
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === "dataset") Object.assign(node.dataset, value);
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const frameOf = (t) => Math.round(t * state.fps);

  /** MM:SS.FF – the same format as Remotion Studio (FF = frame within the second). */
  function timecode(t) {
    const f = frameOf(t), fps = Math.round(state.fps);
    const sec = Math.floor(f / fps), ff = f % fps;
    return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}.${String(ff).padStart(2, "0")}`;
  }

  function bytes(n) {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(n / 1024))} KB`;
  }

  /** the transcript line spoken at t (with a little tolerance around each line) */
  function lineAt(t) {
    const exact = state.transcript.find((l) => t >= l.start && t <= l.end);
    if (exact) return exact;
    return state.transcript.find((l) => t >= l.start - 0.3 && t <= l.end + 0.3) || null;
  }

  function setStatus(text, kind = "") {
    $("status").textContent = text;
    $("status").className = `status ${kind}`;
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {...options, headers: {"Content-Type": "application/json", ...(options.headers || {})}});
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
    return body;
  }

  const videoApi = (suffix = "") => `/api/videos/${enc(state.name)}${suffix}`;
  const shotUrl = (shot) => `${videoApi("/shots/")}${enc(shot.replace(/^shots\//, ""))}`;

  // ── workspace & video selection ──────────────────────────────────────────────────────────
  async function loadWorkspace() {
    state.workspace = await api("/api/workspace");
    const ws = state.workspace;
    for (const id of ["uploadBtn", "transcriptBtn", "emptyUpload"]) $(id).hidden = !ws.uploads;
    renderVideoSelect();
    return ws;
  }

  function renderVideoSelect() {
    const videos = state.workspace ? state.workspace.videos : [];
    const select = $("videoSelect");
    select.replaceChildren(...(videos.length
      ? videos.map((v) => el("option", {value: v.name, selected: v.name === state.name},
        `${v.name}${v.notes ? `  ·  ${v.open} open / ${v.notes}` : ""}`))
      : [el("option", {value: ""}, "No videos yet")]));
    select.disabled = !videos.length;
  }

  async function openVideo(name) {
    if (state.dirty) await save();
    video.pause();
    state.name = name;
    state.activeId = null;
    state.remarkId = null;
    updateHint();
    const url = new URL(location.href);
    if (name) url.searchParams.set("video", name); else url.searchParams.delete("video");
    history.replaceState(null, "", url);
    if (!name) {
      state.config = null; state.notes = []; state.transcript = [];
      video.removeAttribute("src"); video.load();
      showEmpty(true);
      render(); renderMarkers(); tick();
      return;
    }
    showEmpty(false);
    try {
      const [config, review] = await Promise.all([api(videoApi("/config")), api(videoApi("/review"))]);
      state.config = config;
      state.fps = config.fps || 30;
      state.kinds = config.kinds && config.kinds.length ? config.kinds : state.kinds;
      state.transcript = config.transcript || [];
      document.title = `Review · ${config.title}`;
      $("meta").textContent = [`${state.fps} fps`,
        state.transcript.length ? `${state.transcript.length} transcript lines (${config.transcriptFile})` : "no transcript"].join(" · ");
      $("folder").textContent = `Saved to ${config.reviewFolder}/ (notes.json · REVIEW.md · shots/)` +
        (config.rounds && config.rounds.length ? ` · ${config.rounds.length} earlier round(s)` : "");
      loadNotes(review);
      if (config.type) video.setAttribute("type", config.type);
      video.src = config.url;
      setStatus(review.savedAt ? `Loaded ${state.notes.length} note(s).` : "");
    } catch (err) {
      setStatus(`Could not open ${name}: ${err.message}`, "error");
    }
    renderVideoSelect();
    render(); renderMarkers(); tick();
  }

  function showEmpty(empty) {
    $("emptyStage").hidden = !empty;
    $("hint").hidden = empty;
    stage.classList.toggle("is-empty", empty);
    for (const id of ["transcriptBtn", "save", "copyPrompt", "copyChat", "exportZip", "newRound", "play", "back", "fwd"]) {
      $(id).disabled = empty;
    }
    if (empty) {
      document.title = "Video review";
      $("meta").textContent = state.workspace ? `${state.workspace.workspace}/ · no videos yet` : "";
      $("folder").textContent = "";
    }
  }

  function loadNotes(review) {
    const stamp = Date.now();
    state.notes = (review.notes || []).map((n) => ({
      ...n,
      status: n.status || "open",
      // saved shots come from the server; new shots stay as data URLs until they are saved
      preview: n.shot ? `${shotUrl(n.shot)}?v=${stamp}` : null,
    }));
    state.nextId = state.notes.reduce((m, n) => Math.max(m, n.id), 0) + 1;
  }

  $("videoSelect").onchange = (e) => openVideo(e.target.value);

  // ── uploads ──────────────────────────────────────────────────────────────────────────────
  function isVideoFile(file) {
    const exts = (state.workspace && state.workspace.videoExtensions) || [".mp4", ".webm", ".mov"];
    return file.type.startsWith("video/") || exts.some((x) => file.name.toLowerCase().endsWith(x));
  }
  function isTranscriptFile(file) {
    return [".json", ".srt", ".vtt"].some((x) => file.name.toLowerCase().endsWith(x));
  }

  /** PUT the raw file with progress (fetch has no upload progress, XMLHttpRequest does) */
  function putFile(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText || "{}"); } catch (_) { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error || `${xhr.status} ${xhr.statusText}`));
      };
      xhr.onerror = () => reject(new Error("network error"));
      xhr.send(file);
    });
  }

  function progress(fraction, text) {
    $("uploadBar").hidden = fraction == null;
    if (fraction == null) return;
    $("uploadFill").style.width = `${Math.round(fraction * 100)}%`;
    $("uploadText").textContent = text;
  }

  async function uploadVideo(file) {
    if (!state.workspace || !state.workspace.uploads) return setStatus("Uploads are disabled for this review.", "error");
    if (!isVideoFile(file)) return setStatus(`${file.name} is not a video file.`, "error");
    if (file.size > state.workspace.maxUploadBytes) return setStatus(`${file.name} is larger than the upload limit.`, "error");
    if (state.uploading) return setStatus("Another upload is still running.", "busy");
    const existing = state.workspace.videos.find((v) => v.name === file.name);
    if (existing && !confirm(`Replace ${file.name} with the new file? Its notes are kept.`)) return;
    if (state.dirty) await save();
    state.uploading = true;
    try {
      progress(0, `Uploading ${file.name}…`);
      const info = await putFile(`/api/videos/${enc(file.name)}`, file,
        (f) => progress(f, `Uploading ${file.name} · ${Math.round(f * 100)}% of ${bytes(file.size)}`));
      await loadWorkspace();
      await openVideo(info.name);
      setStatus(`✓ Uploaded ${info.name}${info.notes ? ` · ${info.notes} earlier note(s) kept` : ""}`, "ok");
    } catch (err) {
      setStatus(`Upload failed: ${err.message}`, "error");
    } finally {
      state.uploading = false;
      progress(null);
    }
  }

  async function uploadTranscript(file) {
    if (!state.name) return setStatus("Open or upload a video first, then add its transcript.", "error");
    if (!isTranscriptFile(file)) return setStatus("Transcripts must be .json, .srt or .vtt files.", "error");
    try {
      const res = await putFile(`${videoApi("/transcript")}?filename=${enc(file.name)}`, file);
      await openVideo(state.name);
      setStatus(`✓ Transcript added: ${(res.transcript || []).length} line(s). New notes are linked to the spoken line.`, "ok");
    } catch (err) {
      setStatus(`Transcript not added: ${err.message}`, "error");
    }
  }

  $("uploadBtn").onclick = () => $("uploadInput").click();
  $("emptyUpload").onclick = () => $("uploadInput").click();
  $("transcriptBtn").onclick = () => $("transcriptInput").click();
  $("uploadInput").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) uploadVideo(f); };
  $("transcriptInput").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) uploadTranscript(f); };

  // drag & drop anywhere on the page
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; dragDepth++; $("dropzone").hidden = false; });
  window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("dropzone").hidden = true; });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; $("dropzone").hidden = true;
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (isTranscriptFile(file)) uploadTranscript(file); else uploadVideo(file);
  });

  // ── playback ─────────────────────────────────────────────────────────────────────────────
  function tick() {
    const t = video.currentTime || 0;
    $("time").textContent = timecode(t);
    $("frame").textContent = state.name ? `frame ${frameOf(t)}` : "";
    $("progress").style.width = video.duration ? `${(t / video.duration) * 100}%` : "0";
    const line = lineAt(t);
    const voice = $("voice");
    voice.replaceChildren();
    if (line) voice.append(el("span", {className: "id"}, line.id), el("span", {className: "line"}, line.text));
    else if (state.name) {
      voice.append(el("i", {}, state.transcript.length ? "(nothing spoken here)"
        : "No transcript: add one with ＋ Transcript to see the voice-over here."));
    }
    drawMarks();
  }

  for (const ev of ["timeupdate", "seeked", "loadedmetadata"]) video.addEventListener(ev, tick);
  video.addEventListener("loadedmetadata", () => {
    if (video.videoWidth && video.videoHeight) stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    renderMarkers();
  });
  video.addEventListener("play", () => { $("play").textContent = "❚❚ Pause"; stage.classList.add("playing"); });
  video.addEventListener("pause", () => { $("play").textContent = "▶ Play"; stage.classList.remove("playing"); });
  video.addEventListener("error", () => {
    if (state.name) setStatus("The browser cannot play this video file. Try an H.264 MP4 or a VP9 WebM.", "error");
  });
  (function loop() { if (!video.paused) tick(); requestAnimationFrame(loop); })();

  const seek = (t) => { video.currentTime = Math.max(0, Math.min(video.duration || 0, t)); };
  const step = (d) => { video.pause(); seek(video.currentTime + d); };

  $("play").onclick = () => (video.paused ? video.play() : video.pause());
  $("back").onclick = () => step(-1 / state.fps);
  $("fwd").onclick = () => step(1 / state.fps);
  $("speed").onchange = (e) => { video.playbackRate = Number(e.target.value); };
  $("timeline").addEventListener("click", (e) => {
    if (!video.duration) return;
    const r = $("timeline").getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * video.duration);
  });

  function jumpTo(note) {
    video.pause();
    seek(note.seconds);
    state.activeId = note.id;
    render();
    const card = document.querySelector(`.note[data-id="${note.id}"]`);
    if (card) card.scrollIntoView({block: "nearest", behavior: "smooth"});
  }

  function jumpRelative(dir) {
    const t = video.currentTime, eps = 0.5 / state.fps;
    const sorted = [...state.notes].sort((a, b) => a.seconds - b.seconds);
    const target = dir > 0 ? sorted.find((n) => n.seconds > t + eps) : [...sorted].reverse().find((n) => n.seconds < t - eps);
    if (target) jumpTo(target);
  }

  document.addEventListener("keydown", (e) => {
    if (["TEXTAREA", "SELECT", "INPUT"].includes(e.target.tagName)) {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || $("coffeeDialog").open || !state.name) return;
    if (e.code === "Space") { e.preventDefault(); $("play").click(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(e.shiftKey ? -1 : -1 / state.fps); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(e.shiftKey ? 1 : 1 / state.fps); }
    else if (e.key === ",") jumpRelative(-1);
    else if (e.key === ".") jumpRelative(1);
    else if (e.key === "Escape") {
      state.drag = null; state.remarkId = null; state.activeId = null;
      updateHint(); render(); drawMarks(); setStatus("");
    }
  });

  // ── marking: click = pin, drag = box (pointer events: mouse, pen and touch) ──────────────
  function relative(e) {
    const r = stage.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !state.name || !video.readyState) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    video.pause();
    const p = relative(e);
    state.drag = {a: p, b: p};
  });
  stage.addEventListener("pointermove", (e) => {
    if (!state.drag) return;
    state.drag.b = relative(e);
    drawMarks();
  });
  stage.addEventListener("pointerup", () => {
    if (!state.drag) return;
    const {a, b} = state.drag;
    state.drag = null;
    const isBox = Math.abs(a.x - b.x) > 0.015 || Math.abs(a.y - b.y) > 0.015;
    const mark = isBox
      ? {x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y)}
      : {x: a.x, y: a.y};
    if (state.remarkId != null) remark(mark); else addNote(mark);
  });
  stage.addEventListener("pointercancel", () => { state.drag = null; drawMarks(); });

  /** time, frame and transcript line of the current position, for a new or re-marked note */
  function here() {
    const t = video.currentTime, line = lineAt(t);
    return {time: timecode(t), seconds: Number(t.toFixed(3)), frame: frameOf(t),
            transcript: line ? {id: line.id, text: line.text} : null};
  }

  function addNote(mark) {
    const note = {id: state.nextId++, ...here(), kind: state.kinds[0], status: "open", text: "", mark, shot: null};
    note.shot = snapshot(note);
    note.preview = note.shot;
    state.notes.push(note);
    state.activeId = note.id;
    render(); renderMarkers(); markDirty();
    const ta = document.querySelector(`.note[data-id="${note.id}"] textarea`);
    if (ta) { ta.focus(); ta.scrollIntoView({block: "nearest"}); }
  }

  function remark(mark) {
    const note = state.notes.find((n) => n.id === state.remarkId);
    state.remarkId = null;
    updateHint();
    if (!note) return;
    Object.assign(note, here(), {mark});
    note.shot = snapshot(note);
    note.preview = note.shot;
    state.activeId = note.id;
    render(); renderMarkers(); markDirty();
    setStatus(`Note ${note.id} moved to ${note.time}.`, "busy");
  }

  function updateHint() {
    $("hint").textContent = state.remarkId != null
      ? `Click or drag to place note ${state.remarkId} again (Esc cancels)`
      : "Pause, then click to pin a change or drag to mark an area";
    $("hint").classList.toggle("attention", state.remarkId != null);
  }

  /** the paused frame with the mark drawn on it, as a JPEG data URL */
  function snapshot(note) {
    const w = Math.min(1280, video.videoWidth || 1280);
    const h = Math.round(w * ((video.videoHeight || 720) / (video.videoWidth || 1280)));
    const c = el("canvas", {width: w, height: h});
    const g = c.getContext("2d");
    try { g.drawImage(video, 0, 0, w, h); } catch (_) { return null; }
    const m = note.mark, px = m.x * w, py = m.y * h, s = w / 960;
    g.lineWidth = 4 * s;
    g.strokeStyle = "#ff4d4f";
    if (m.w != null) {
      g.fillStyle = "rgba(255,77,79,0.10)";
      g.fillRect(px, py, m.w * w, m.h * h);
      g.strokeRect(px, py, m.w * w, m.h * h);
    }
    g.beginPath(); g.arc(px, py, 14 * s, 0, Math.PI * 2);
    g.fillStyle = "#ff4d4f"; g.fill();
    g.strokeStyle = "#fff"; g.lineWidth = 2 * s; g.stroke();
    g.fillStyle = "#fff"; g.font = `bold ${15 * s}px system-ui, sans-serif`;
    g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(String(note.id), px, py + 1);
    return c.toDataURL("image/jpeg", 0.85);
  }

  function boxElement(m, className) {
    const box = el("div", {className});
    Object.assign(box.style, {left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%`});
    return box;
  }

  function drawMarks() {
    const t = video.currentTime || 0;
    const nodes = [];
    for (const n of state.notes) {
      if (Math.abs(n.seconds - t) > 0.6 || n.id === state.remarkId) continue;
      if (n.status === "done" && !$("showDone").checked) continue;
      const done = n.status === "done" ? " done" : "";
      const pin = el("div", {className: `pin${done}`}, String(n.id));
      if (n.mark.w != null) {
        const box = boxElement(n.mark, `box${done}`);
        box.append(pin);
        nodes.push(box);
      } else {
        Object.assign(pin.style, {left: `${n.mark.x * 100}%`, top: `${n.mark.y * 100}%`});
        nodes.push(pin);
      }
    }
    if (state.drag) {
      const {a, b} = state.drag;
      nodes.push(boxElement({x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y)}, "box draft"));
    }
    overlay.replaceChildren(...nodes);
  }

  function renderMarkers() {
    const markers = $("markers");
    if (!video.duration) { markers.replaceChildren(); return; }
    markers.replaceChildren(...state.notes.map((n) => {
      const m = el("div", {className: `marker${n.status === "done" ? " done" : ""}`, title: `#${n.id} ${n.time}`});
      m.style.left = `${(n.seconds / video.duration) * 100}%`;
      return m;
    }));
  }

  // ── notes panel ──────────────────────────────────────────────────────────────────────────
  function render() {
    const list = $("list");
    const showDone = $("showDone").checked;
    const open = state.notes.filter((n) => n.status !== "done").length;
    $("count").textContent = state.notes.length ? `${state.notes.length} · ${open} open` : "";
    const visible = [...state.notes].sort((a, b) => a.seconds - b.seconds || a.id - b.id)
      .filter((n) => showDone || n.status !== "done");
    if (!state.name) {
      list.replaceChildren(el("div", {className: "empty"}, "Upload or pick a video to start reviewing."));
      return;
    }
    if (!visible.length) {
      list.replaceChildren(el("div", {className: "empty"},
        state.notes.length ? "All notes are done (tick “show done” to see them)."
          : "Pause the video and click on the picture where something should change, or drag to mark an area. Then describe the change here."));
      return;
    }
    list.replaceChildren(...visible.map(noteCard));
  }

  function noteCard(n) {
    const kinds = state.kinds.includes(n.kind) ? state.kinds : [...state.kinds, n.kind];
    const select = el("select", {"aria-label": "Type of change", onchange: (e) => { n.kind = e.target.value; markDirty(); }},
      kinds.map((k) => el("option", {value: k, selected: k === n.kind}, k)));
    const done = el("input", {type: "checkbox", checked: n.status === "done", onchange: (e) => {
      n.status = e.target.checked ? "done" : "open"; render(); renderMarkers(); drawMarks(); markDirty();
    }});
    const textarea = el("textarea", {
      value: n.text,
      placeholder: "What should change? e.g. “change the title to …”, “show this 1 s later”, “say … instead”",
      oninput: (e) => { n.text = e.target.value; markDirty(); },
      onfocus: () => { state.activeId = n.id; highlight(); },
    });
    return el("div", {className: `note${n.id === state.activeId ? " active" : ""}${n.status === "done" ? " done" : ""}`, dataset: {id: String(n.id)}},
      el("div", {className: "note-head"},
        el("span", {className: "num"}, String(n.id)),
        el("button", {className: "jump", title: "Jump to this frame", onclick: () => jumpTo(n)}, n.time),
        el("span", {className: "grow muted"}, `frame ${n.frame}`),
        el("button", {className: "icon", title: "Place this note again: click or drag on the video (at any frame)",
          "aria-label": `Re-mark note ${n.id}`, onclick: () => startRemark(n)}, "⌖"),
        el("button", {className: "icon danger", title: "Delete this note", "aria-label": `Delete note ${n.id}`, onclick: () => removeNote(n)}, "✕")),
      el("div", {className: "note-row"}, select, el("label", {className: "toggle muted"}, done, "done")),
      textarea,
      n.transcript ? el("div", {className: "said"}, `“${n.transcript.text}”`) : null,
      n.preview ? el("img", {src: n.preview, alt: `Frame ${n.frame} with mark ${n.id}`, title: "Jump to this frame",
        onclick: () => jumpTo(n)}) : null);
  }

  function startRemark(n) {
    jumpTo(n);
    state.remarkId = n.id;
    updateHint();
    drawMarks();
    setStatus(`Click or drag on the video to place note ${n.id} again. You can move to another frame first.`, "busy");
  }

  function highlight() {
    document.querySelectorAll(".note").forEach((c) => c.classList.toggle("active", Number(c.dataset.id) === state.activeId));
  }

  function removeNote(n) {
    if ((n.text || "").trim() && !confirm(`Delete note ${n.id}?`)) return;
    state.notes = state.notes.filter((x) => x !== n);
    render(); renderMarkers(); drawMarks(); markDirty();
  }

  $("showDone").onchange = () => { render(); drawMarks(); };

  // ── saving ───────────────────────────────────────────────────────────────────────────────
  function markDirty() {
    state.dirty = true;
    setStatus("Unsaved changes…", "busy");
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(save, 1200);
  }

  async function save() {
    clearTimeout(state.saveTimer);
    if (!state.name) return;
    if (state.saving) { state.saveTimer = setTimeout(save, 400); return; }
    state.saving = true;
    state.dirty = false;
    setStatus("Saving…", "busy");
    const name = state.name;
    const payload = {notes: state.notes.map(({preview, ...n}) => ({...n, shot: n.shot || null}))};
    try {
      const doc = await api(`/api/videos/${enc(name)}/review`, {method: "POST", body: JSON.stringify(payload)});
      if (name === state.name) {
        // keep what was typed meanwhile; adopt the server's screenshot paths
        const byId = new Map(doc.notes.map((n) => [n.id, n]));
        for (const n of state.notes) {
          const saved = byId.get(n.id);
          if (saved && saved.shot && n.shot && n.shot.startsWith("data:")) n.shot = saved.shot;
        }
      }
      const open = doc.notes.filter((n) => n.status !== "done").length;
      setStatus(`✓ Saved ${new Date().toLocaleTimeString()} · ${doc.notes.length} note(s), ${open} open`, "ok");
      const entry = state.workspace && state.workspace.videos.find((v) => v.name === name);
      if (entry) { entry.notes = doc.notes.length; entry.open = open; renderVideoSelect(); }
    } catch (err) {
      state.dirty = true;
      setStatus(`Save failed: ${err.message}`, "error");
    } finally {
      state.saving = false;
    }
  }

  $("save").onclick = save;
  window.addEventListener("beforeunload", (e) => {
    if (state.dirty || state.saving || state.uploading) { e.preventDefault(); e.returnValue = ""; }
  });

  $("newRound").onclick = async () => {
    if (state.dirty) await save();
    if (!state.notes.length) { setStatus("Nothing to archive yet."); return; }
    if (!confirm("Move all current notes to rounds/ and start an empty review round?")) return;
    try {
      const res = await api(videoApi("/review/archive"), {method: "POST", body: "{}"});
      state.notes = []; state.nextId = 1; state.activeId = null;
      render(); renderMarkers(); drawMarks();
      await loadWorkspace();
      setStatus(res.archived ? `Archived as rounds/${res.archived}/. New round started.` : "Nothing to archive.", "ok");
    } catch (err) {
      setStatus(`Could not start a new round: ${err.message}`, "error");
    }
  };

  $("exportZip").onclick = async () => {
    if (state.dirty) await save();
    const a = el("a", {href: videoApi("/export"), download: `${state.config.reviewFolder}.zip`});
    document.body.append(a); a.click(); a.remove();
    setStatus("Downloading the review as a zip. Attach it to Claude together with the prompt.", "ok");
  };

  $("copyPrompt").onclick = async () => {
    if (state.dirty) await save();
    const folder = state.config.reviewFolder;
    const open = state.notes.filter((n) => n.status !== "done").length;
    const prompt = [
      `Please implement my video review of ${state.name} in ${folder}/ (full path: ${state.config.reviewPath}).`,
      `Read ${folder}/REVIEW.md (and notes.json for exact values) and look at every screenshot in ${folder}/shots/.`,
      `There are ${open} open note(s). Each note is one change at an exact frame (${state.fps} fps); the red pin or box shows where.`,
      "Implement all open notes, then tell me per note number what you changed, and ask if a note is unclear.",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(prompt);
      setStatus("Prompt copied. Paste it into Claude.", "ok");
    } catch (_) {
      window.prompt("Copy this prompt:", prompt);
    }
  };

  /** prompt + REVIEW.md as text, for a Claude chat that cannot read the review folder itself */
  $("copyChat").onclick = async () => {
    if (state.dirty) await save();
    const open = state.notes.filter((n) => n.status !== "done").length;
    const withShots = state.notes.filter((n) => n.status !== "done" && n.shot).length;
    let markdown = "";
    try {
      const res = await fetch(videoApi("/markdown"));
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      markdown = await res.text();
    } catch (err) {
      setStatus(`Could not load the review text: ${err.message}`, "error");
      return;
    }
    const text = [
      `Please help me implement this review of my video ${state.name} (${state.fps} fps).`,
      `It has ${open} open note(s). Each note is one change at an exact frame; I attached the screenshots`,
      `(shots/<note number>.jpg) where a red pin or box shows the spot. Tell me per note number what to change`,
      "in the project that renders the video (or change it, if you have access), and ask if a note is unclear.",
      "",
      markdown,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setStatus(withShots
        ? `Copied. Paste it into the chat and attach the ${withShots} screenshot(s) from ${state.config.reviewFolder}/shots/ (or the zip).`
        : "Copied. Paste it into the chat.", "ok");
    } catch (_) {
      window.prompt("Copy this text:", text);
    }
  };

  // "Buy me a coffee": a modal dialog (Esc, ✕ or a click outside closes it)
  const coffee = $("coffeeDialog");
  $("coffee").onclick = () => coffee.showModal();
  $("coffeeClose").onclick = () => coffee.close();
  coffee.addEventListener("click", (e) => { if (e.target === coffee) coffee.close(); });

  // ── start-up ─────────────────────────────────────────────────────────────────────────────
  (async () => {
    try {
      const ws = await loadWorkspace();
      const wanted = new URL(location.href).searchParams.get("video");
      const names = ws.videos.map((v) => v.name);
      await openVideo(names.includes(wanted) ? wanted : names[0] || null);
    } catch (err) {
      setStatus(`Could not load the review: ${err.message}`, "error");
    }
  })();
})();
