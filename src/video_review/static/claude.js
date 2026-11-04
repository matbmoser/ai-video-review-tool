/* AI Video Review Tool – the ✦ Claude drawer.
 *
 * Two ways to hand the review to Claude, side by side with the video:
 *   • Claude Code: the real `claude` CLI in a terminal (xterm.js), running in the project folder on this
 *     machine. "Send review" starts it with the review prompt, or types the prompt into the running session.
 *   • Chat (API key): a chat (Deep Chat, an open-source chat component) that talks to Claude through the
 *     local server with your own Anthropic API key. The server adds the open notes and their screenshots.
 *
 * The drawer can be resized by dragging its left edge, made full screen and closed; Claude keeps running
 * while it is closed. Libraries are loaded on first use only.
 */
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const review = () => window.VideoReview;
  const drawer = $("drawer");
  const MIN_W = 340, DEFAULT_W = 620;

  const ui = {
    tab: "code",
    status: null,          // GET /api/claude
    term: null, fit: null, // xterm.js
    stream: null, offset: 0, connected: false,
    input: Promise.resolve(), // keystrokes are sent one request after the other, in order
    chat: null,            // <deep-chat>
  };

  function token() { return (review().workspace || {}).token || ""; }

  async function post(path, body) {
    const res = await fetch(path, {method: "POST", body: JSON.stringify(body || {}),
      headers: {"Content-Type": "application/json", "X-Review-Token": token()}});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  async function refreshStatus() {
    const res = await fetch("/api/claude");
    ui.status = await res.json();
    return ui.status;
  }

  function message(id, text, kind = "") {
    const box = $(id);
    box.hidden = !text;
    box.textContent = text || "";
    box.className = `pane-msg ${kind}`;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`cannot load ${src}`));
      document.head.append(s);
    });
  }

  // ── drawer: open / close / resize / full screen ──────────────────────────────────────────
  function storedWidth() {
    try { return Number(localStorage.getItem("video-review.drawer-width")) || DEFAULT_W; } catch (_) { return DEFAULT_W; }
  }
  function setWidth(px, persist = true) {
    const w = Math.round(Math.max(MIN_W, Math.min(window.innerWidth - 160, px)));
    document.documentElement.style.setProperty("--drawer-w", `${w}px`);
    if (persist) { try { localStorage.setItem("video-review.drawer-width", String(w)); } catch (_) { /* private mode */ } }
    fitSoon();
  }

  async function openDrawer(tab) {
    drawer.hidden = false;
    document.body.classList.add("drawer-open");
    $("claudeBtn").setAttribute("aria-expanded", "true");
    setWidth(storedWidth(), false);
    await refreshStatus().catch(() => null);
    await selectTab(tab || ui.tab);
  }

  function closeDrawer() {
    drawer.hidden = true;
    document.body.classList.remove("drawer-open", "drawer-full");
    $("drawerFull").setAttribute("aria-pressed", "false");
    $("claudeBtn").setAttribute("aria-expanded", "false");
  }

  function toggleFull() {
    const full = document.body.classList.toggle("drawer-full");
    $("drawerFull").setAttribute("aria-pressed", String(full));
    $("drawerFull").textContent = full ? "⤡" : "⤢";
    $("drawerFull").title = full ? "Back to the side panel" : "Full screen";
    fitSoon();
  }

  $("claudeBtn").onclick = () => (drawer.hidden ? openDrawer() : closeDrawer());
  $("drawerClose").onclick = closeDrawer;
  $("drawerFull").onclick = toggleFull;

  const handle = $("drawerResize");
  handle.addEventListener("pointerdown", (e) => {
    if (document.body.classList.contains("drawer-full")) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const move = (ev) => setWidth(window.innerWidth - ev.clientX, false);
    const up = (ev) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      setWidth(window.innerWidth - ev.clientX);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  handle.addEventListener("dblclick", () => setWidth(DEFAULT_W));
  handle.addEventListener("keydown", (e) => {
    const current = drawer.getBoundingClientRect().width;
    if (e.key === "ArrowLeft") { e.preventDefault(); setWidth(current + 40); }
    if (e.key === "ArrowRight") { e.preventDefault(); setWidth(current - 40); }
  });
  window.addEventListener("resize", () => { if (!drawer.hidden) setWidth(drawer.getBoundingClientRect().width, false); });

  async function selectTab(tab) {
    ui.tab = tab;
    $("tabCode").setAttribute("aria-selected", String(tab === "code"));
    $("tabChat").setAttribute("aria-selected", String(tab === "chat"));
    $("paneCode").hidden = tab !== "code";
    $("paneChat").hidden = tab !== "chat";
    if (tab === "code") await showTerminal(); else await showChat();
  }
  $("tabCode").onclick = () => selectTab("code");
  $("tabChat").onclick = () => selectTab("chat");

  // ── Claude Code in a terminal ────────────────────────────────────────────────────────────
  let fitTimer = null;
  function fitSoon() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      if (!ui.fit || $("paneCode").hidden || drawer.hidden) return;
      try { ui.fit.fit(); } catch (_) { /* not visible yet */ }
    }, 60);
  }

  /** create the terminal once (concurrent callers share the same promise) */
  function ensureTerminal() {
    ui.termReady = ui.termReady || createTerminal().catch((err) => { ui.termReady = null; throw err; });
    return ui.termReady;
  }

  async function createTerminal() {
    if (!window.Terminal) await loadScript("/static/vendor/xterm/xterm.js");
    if (!window.FitAddon) await loadScript("/static/vendor/xterm/addon-fit.js");
    const term = new window.Terminal({
      cursorBlink: true, convertEol: false, scrollback: 5000, allowProposedApi: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace', fontSize: 13,
      theme: {background: "#0b0e13", foreground: "#e6edf3", cursor: "#ff4d4f", selectionBackground: "#3b82f655"},
    });
    ui.fit = new window.FitAddon.FitAddon();
    term.loadAddon(ui.fit);
    term.open($("term"));
    term.onData((data) => {
      ui.input = ui.input.then(() => post("/api/terminal/input", {data})).catch(() => null);
    });
    let resizeTimer = null;
    term.onResize(({cols, rows}) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => post("/api/terminal/resize", {cols, rows}).catch(() => null), 120);
    });
    new ResizeObserver(fitSoon).observe($("term"));
    ui.term = term;
    fitSoon();
    return term;
  }

  function size() {
    if (ui.fit) { try { ui.fit.fit(); } catch (_) { /* hidden */ } }
    return ui.term ? {cols: ui.term.cols, rows: ui.term.rows} : {cols: 100, rows: 30};
  }

  function renderTerminalBar() {
    const t = (ui.status || {}).terminal || {};
    $("termInfo").textContent = t.available
      ? `${t.command} · ${t.cwd}${t.running ? " · running" : ""}`
      : "Claude Code is not available";
    $("termInfo").title = t.cwd || "";
    $("termStart").hidden = !t.available || t.running;
    $("termStop").hidden = !t.running;
    $("termSend").disabled = !t.available || !review().name;
  }

  async function showTerminal() {
    const t = (ui.status || {}).terminal;
    renderTerminalBar();
    if (!t || !t.available) {
      message("termMsg", `${t ? t.reason : "The server did not answer."}\nYou can still use the Chat tab, or copy the prompt with “Copy prompt for Claude Code”.`, "warn");
      $("term").hidden = true;
      return;
    }
    $("term").hidden = false;
    await ensureTerminal();
    if (t.running) {
      message("termMsg", "");
      connect();
    } else if (!ui.connected) {
      message("termMsg", `Press “Send review” to start Claude Code in ${t.cwd} with your review, or “Start” for an empty session.`);
    }
    fitSoon();
    ui.term.focus();
  }

  function connect() {
    if (ui.stream) return;
    const source = new EventSource(`/api/terminal/stream?offset=${ui.offset}&token=${encodeURIComponent(token())}`);
    ui.stream = source;
    ui.connected = true;
    source.onmessage = (e) => {
      const bin = atob(e.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      ui.term.write(bytes);
      ui.offset = Number(e.lastEventId) || ui.offset + bytes.length;
    };
    source.addEventListener("exit", async (e) => {
      disconnect();
      $("claudeBtn").classList.remove("live");
      ui.term.write(`\r\n\x1b[2m[Claude Code exited with code ${e.data}. Press “Start” or “Send review” to start it again.]\x1b[0m\r\n`);
      await refreshStatus().catch(() => null);
      renderTerminalBar();
    });
    source.onerror = () => {
      // dropped (server restart, sleep): reconnect from the last offset while the session is running
      disconnect();
      setTimeout(async () => {
        const s = await refreshStatus().catch(() => null);
        renderTerminalBar();
        if (s && s.terminal.running && !drawer.hidden) connect();
      }, 1500);
    };
  }

  function disconnect() {
    if (ui.stream) ui.stream.close();
    ui.stream = null;
    ui.connected = false;
  }

  async function startTerminal(prompt) {
    await ensureTerminal();
    ui.status = ui.status || {};
    const wasRunning = (ui.status.terminal || {}).running;
    if (!wasRunning) { disconnect(); ui.offset = 0; ui.term.reset(); }
    try {
      ui.status.terminal = prompt
        ? await post("/api/terminal/send", {text: prompt, ...size()})
        : await post("/api/terminal/start", size());
      message("termMsg", "");
      $("claudeBtn").classList.add("live");
      connect();
      ui.term.focus();
    } catch (err) {
      message("termMsg", `Could not start Claude Code: ${err.message}`, "error");
    }
    renderTerminalBar();
  }

  $("termStart").onclick = () => startTerminal(null);
  $("termStop").onclick = async () => {
    if (!confirm("Stop Claude Code? The conversation in the terminal ends.")) return;
    await post("/api/terminal/stop").catch(() => null);
    await refreshStatus().catch(() => null);
    renderTerminalBar();
  };
  $("termSend").onclick = async () => {
    if (!review().name) return;
    await review().save();
    await startTerminal(review().codePrompt(" "));
    review().setStatus("Review sent to Claude Code. Follow along in the ✦ Claude panel.", "ok");
  };

  // ── chat through the Anthropic API (Deep Chat) ───────────────────────────────────────────
  const CHAT_STYLE = {
    chatStyle: {width: "100%", height: "100%", border: "none", backgroundColor: "#0e1116",
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif', fontSize: "14px"},
    messageStyles: {
      default: {
        shared: {bubble: {maxWidth: "92%", lineHeight: "1.45", padding: "8px 12px"}},
        user: {bubble: {backgroundColor: "#3b82f6", color: "#ffffff"}},
        ai: {bubble: {backgroundColor: "#1c222b", color: "#e6edf3", border: "1px solid #2a313c"}},
      },
      intro: {bubble: {backgroundColor: "#161b22", color: "#8b949e", border: "1px dashed #2a313c", maxWidth: "100%"}},
      error: {bubble: {backgroundColor: "#3a1416", color: "#ffb4b5"}},
      loading: {message: {styles: {bubble: {backgroundColor: "#1c222b"}}}},
    },
    inputAreaStyle: {backgroundColor: "#161b22", borderTop: "1px solid #2a313c"},
    textInput: {
      placeholder: {text: "Ask Claude about this review…", style: {color: "#8b949e"}},
      styles: {container: {backgroundColor: "#0e1116", color: "#e6edf3", border: "1px solid #2a313c",
        boxShadow: "none", width: "82%"}, text: {padding: "10px 12px"}},
    },
    submitButtonStyles: {submit: {container: {default: {backgroundColor: "transparent"}},
      svg: {styles: {default: {filter: "invert(55%) sepia(72%) saturate(2900%) hue-rotate(205deg)"}}}}},
    auxiliaryStyle: "::-webkit-scrollbar { width: 8px; } ::-webkit-scrollbar-thumb { background: #2a313c; border-radius: 4px; }"
      + " a { color: #60a5fa; } pre { background: #0b0e13; padding: 8px; border-radius: 6px; overflow: auto; }",
  };

  function renderChatBar() {
    const c = (ui.status || {}).chat || {};
    const select = $("chatModel");
    if (!select.options.length && c.models) {
      for (const m of c.models) select.append(new Option(m.name, m.id, m.id === c.model, m.id === c.model));
    }
    $("chatKeyBtn").textContent = c.configured ? (c.source === "environment" ? "Key: ANTHROPIC_API_KEY" : "Key: set") : "Set API key";
    $("chatKeyBtn").disabled = !c.enabled || c.source === "environment";
    $("keyForget").hidden = c.source !== "page";
    $("chatSend").disabled = !c.enabled || !c.configured || !review().name;
  }

  function ensureChat() {
    ui.chatReady = ui.chatReady || createChat().catch((err) => { ui.chatReady = null; throw err; });
    return ui.chatReady;
  }

  async function createChat() {
    await import("/static/vendor/deep-chat/deepChat.bundle.js");
    const chat = document.createElement("deep-chat");
    Object.assign(chat, CHAT_STYLE);
    chat.connect = {url: "/api/claude/chat", stream: true, headers: {"X-Review-Token": token()}};
    chat.requestBodyLimits = {maxMessages: -1};  // send the whole conversation, the API is stateless
    chat.remarkable = {html: false, breaks: true};
    chat.introMessage = {text: "Ask anything about the review of the current video. With “include review” on, "
      + "Claude gets the open notes and their screenshots with your first message. “Send review” asks for a plan per note."};
    // the current video, model and review switch are read for every message
    chat.requestInterceptor = (details) => {
      details.body = {...details.body, video: review().name || "", model: $("chatModel").value,
        review: $("chatReview").checked};
      return details;
    };
    $("chatHost").replaceChildren(chat);
    ui.chat = chat;
    return chat;
  }

  async function showChat() {
    const c = (ui.status || {}).chat;
    renderChatBar();
    if (!c || !c.enabled) {
      message("chatMsg", c ? `The chat is off: ${c.reason}.` : "The server did not answer.", "warn");
      $("keyForm").hidden = true;
      return;
    }
    message("chatMsg", "");
    $("keyForm").hidden = c.configured;
    try {
      await ensureChat();
    } catch (err) {
      message("chatMsg", `Could not load the chat: ${err.message}`, "error");
    }
    if (!c.configured) $("keyInput").focus();
  }

  $("chatKeyBtn").onclick = () => { $("keyForm").hidden = !$("keyForm").hidden; if (!$("keyForm").hidden) $("keyInput").focus(); };
  $("keyForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = $("keyInput").value.trim();
    if (!key) return;
    try {
      ui.status.chat = await post("/api/claude/key", {key});
      $("keyInput").value = "";
      $("keyForm").hidden = true;
      message("chatMsg", "");
    } catch (err) {
      message("chatMsg", err.message, "error");
    }
    renderChatBar();
  });
  $("keyForget").onclick = async () => {
    ui.status.chat = await post("/api/claude/key", {key: null}).catch(() => ui.status.chat);
    $("keyForm").hidden = ui.status.chat.configured;
    renderChatBar();
  };

  $("chatSend").onclick = async () => {
    if (!review().name) return;
    await review().save();
    const chat = await ensureChat();
    $("chatReview").checked = true;
    const open = review().openNotes();
    chat.submitUserMessage({text: `Please go through the ${open} open note(s) of my review of ${review().name} `
      + "and tell me per note number what to change, and which notes are unclear."});
  };

  // ── "✦ Send to Claude" in the notes panel ────────────────────────────────────────────────
  $("sendClaude").onclick = async () => {
    await openDrawer();
    const s = ui.status || {};
    if (ui.tab === "code" && !(s.terminal && s.terminal.available) && s.chat && s.chat.enabled) await selectTab("chat");
    if (ui.tab === "code") $("termSend").click();
    else if (s.chat && s.chat.configured) $("chatSend").click();
    else $("keyInput").focus();
  };

  // the session may already run (page reload): reconnect the terminal when the drawer opens
  document.addEventListener("review:ready", () => {
    const s = (review().workspace || {}).claude;
    if (s) ui.status = s;
    if (s && s.terminal && s.terminal.running) $("claudeBtn").classList.add("live");
  });
})();
