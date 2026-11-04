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
  // the GitHub Pages version: no server, so no Claude Code terminal; the chat talks to the API directly
  const local = window.VideoReviewBrowserBackend || null;

  const ui = {
    tab: local ? "chat" : "code",
    status: null,          // GET /api/claude
    term: null, fit: null, // xterm.js
    stream: null, offset: 0, connected: false,
    input: Promise.resolve(), // keystrokes are sent one request after the other, in order
    token: "",             // per-start token of the server (refreshed if the server restarts)
    chat: null,            // the <deep-chat> of the conversation on screen
  };

  function token() { return ui.token || (review().workspace || {}).token || ""; }

  async function post(path, body, retried = false) {
    if (local) {  // only the API key exists without a server
      if (path !== "/api/claude/key") throw new Error("not available in the browser version");
      return body && body.key ? local.chat.setKey(body.key) : local.chat.forgetKey();
    }
    const res = await fetch(path, {method: "POST", body: JSON.stringify(body || {}),
      headers: {"Content-Type": "application/json", "X-Review-Token": token()}});
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && !retried) {  // the server was restarted: get its new token and try once more
      await refreshStatus().catch(() => null);
      return post(path, body, true);
    }
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  async function refreshStatus() {
    if (local) {
      ui.status = {terminal: {available: false, reason: "Claude Code needs the installed tool (pip install …)."},
        chat: local.chat.status()};
      return ui.status;
    }
    const res = await fetch("/api/claude", {cache: "no-store"});
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    ui.status = await res.json();
    if (ui.status.token) ui.token = ui.status.token;
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
      message("termMsg", `${t ? t.reason : "The server did not answer."}\nYou can still use the Chat tab, or copy the prompt with “Copy for Code”.`, "warn");
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
  // One conversation per video, kept in this browser (localStorage) so it survives reloads and restarts.
  const C = {bg: "#0e1116", panel: "#161b22", panel2: "#1c222b", line: "#2a313c", text: "#e6edf3",
    muted: "#8b949e", claude: "#d97757", user: "#262d38"};
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
  const SUGGESTIONS = [
    "Plan the changes for every open note",
    "Which notes are unclear or contradict each other?",
    "Write the Remotion code changes for the first note",
    "Rewrite the voice-over lines the notes ask to change",
  ];

  const chats = new Map();  // conversation id → <deep-chat>
  let codeTheme = "";

  function storageOk() {
    try { localStorage.setItem("video-review.probe", "1"); localStorage.removeItem("video-review.probe"); return true; } catch (_) { return false; }
  }

  function chatStyles() {
    return {
      chatStyle: {width: "100%", height: "100%", border: "none", backgroundColor: C.bg, fontFamily: FONT, fontSize: "14px"},
      messageStyles: {
        default: {
          shared: {
            outerContainer: {padding: "0 18px", marginTop: "14px"},
            bubble: {lineHeight: "1.6", fontSize: "14px", padding: "0", maxWidth: "100%", borderRadius: "0", wordBreak: "break-word"},
          },
          ai: {bubble: {backgroundColor: "transparent", color: C.text, width: "calc(100% - 40px)", maxWidth: "none"}},
          user: {bubble: {backgroundColor: C.user, color: C.text, padding: "9px 14px", borderRadius: "16px 16px 4px 16px",
            maxWidth: "82%", border: `1px solid ${C.line}`}},
        },
        error: {bubble: {backgroundColor: "#2a1215", color: "#ffb4b5", border: "1px solid #ff4d4f66", borderRadius: "10px",
          padding: "9px 14px", maxWidth: "calc(100% - 40px)", fontSize: "13px"}},
        loading: {message: {styles: {bubble: {padding: "10px 4px", backgroundColor: "transparent"}}}},
        intro: {bubble: {backgroundColor: "transparent", padding: "0", maxWidth: "100%", width: "100%"}},
      },
      avatars: {
        ai: {src: "/static/claude-avatar.svg", styles: {avatar: {width: "26px", height: "26px", marginTop: "2px"},
          container: {marginRight: "12px"}}},
        user: {styles: {container: {display: "none"}}},
      },
      inputAreaStyle: {backgroundColor: C.bg, padding: "10px 14px 14px", borderTop: "none", boxSizing: "border-box"},
      textInput: {
        placeholder: {text: "Message Claude…   (Enter sends, Shift+Enter new line)", style: {color: "#6e7681"}},
        characterLimit: 20000,
        styles: {
          container: {backgroundColor: C.panel, color: C.text, border: `1px solid ${C.line}`, borderRadius: "14px",
            boxShadow: "0 1px 0 #0004", width: "100%", boxSizing: "border-box", margin: "0", minHeight: "46px", maxHeight: "40vh"},
          text: {padding: "12px 48px 12px 14px", fontSize: "14px", lineHeight: "1.5"},
          focus: {border: `1px solid ${C.claude}99`, boxShadow: `0 0 0 3px ${C.claude}22`},
        },
      },
      submitButtonStyles: (() => {
        // one geometry for every state, so the button never jumps; centred at the bottom-right of the input
        const box = {position: "absolute", top: "auto", bottom: "8px", right: "8px", margin: "0", padding: "0", width: "30px",
          height: "30px", borderRadius: "9px", display: "flex", alignItems: "center", justifyContent: "center", opacity: "1"};
        const icon = (invert) => ({styles: {default: {width: "16px", height: "16px", strokeWidth: "2.2",
          filter: `brightness(0) invert(${invert})`}}});
        return {
          position: "inside-end",
          submit: {container: {default: {...box, backgroundColor: C.claude}, hover: {backgroundColor: "#e3896b"}}, svg: icon(1)},
          loading: {container: {default: {...box, backgroundColor: C.panel2}}},
          stop: {container: {default: {...box, backgroundColor: C.panel2, border: `1px solid ${C.line}`},
            hover: {backgroundColor: C.line}}, svg: {styles: {default: {width: "13px", height: "13px", filter: "brightness(0) invert(0.9)"}}}},
          disabled: {container: {default: {...box, backgroundColor: C.panel2}}, svg: icon(0.5)},
        };
      })(),
      scrollButton: {styles: {default: {backgroundColor: C.panel2, border: `1px solid ${C.line}`, color: C.text}}},
      auxiliaryStyle: chatCss(),
    };
  }

  /** CSS inside Deep Chat's shadow DOM: typography, code blocks, tables, copy buttons, scrollbars */
  function chatCss() {
    return `${codeTheme}
      #messages { padding-bottom: 12px; scrollbar-color: ${C.line} transparent; }
      #messages::-webkit-scrollbar { width: 10px; } #messages::-webkit-scrollbar-thumb { background: ${C.line}; border-radius: 5px; border: 3px solid ${C.bg}; }
      .ai-message-text > *:first-child, .user-message-text > *:first-child { margin-top: 0; }
      .ai-message-text > *:last-child, .user-message-text > *:last-child { margin-bottom: 0; }
      .ai-message-text p, .user-message-text p { margin: 0 0 .7em; }
      .ai-message-text h1, .ai-message-text h2, .ai-message-text h3, .ai-message-text h4 { line-height: 1.3; margin: 1.1em 0 .45em; font-weight: 650; }
      .ai-message-text h1 { font-size: 1.3em; } .ai-message-text h2 { font-size: 1.16em; } .ai-message-text h3, .ai-message-text h4 { font-size: 1.02em; }
      .ai-message-text ul, .ai-message-text ol { margin: .3em 0 .8em; padding-left: 1.4em; }
      .ai-message-text li { margin: .22em 0; } .ai-message-text li > p { margin: 0; }
      .ai-message-text strong { color: #fff; font-weight: 650; }
      .ai-message-text a, .user-message-text a { color: #79b8ff; text-decoration: none; } .ai-message-text a:hover { text-decoration: underline; }
      .ai-message-text hr { border: none; border-top: 1px solid ${C.line}; margin: 1em 0; }
      .ai-message-text blockquote { margin: .6em 0; padding: .1em 0 .1em .9em; border-left: 3px solid ${C.claude}; color: ${C.muted}; }
      .ai-message-text code, .user-message-text code { font-family: ${MONO}; font-size: .88em; background: ${C.panel2};
        border: 1px solid ${C.line}; border-radius: 5px; padding: .08em .35em; }
      .ai-message-text pre, .user-message-text pre { position: relative; margin: .7em 0 .9em; background: #0b0e13;
        border: 1px solid ${C.line}; border-radius: 10px; padding: 34px 14px 12px; overflow-x: auto; line-height: 1.5; }
      .ai-message-text pre code, .user-message-text pre code { background: none; border: none; padding: 0; font-size: 12.5px; }
      pre .code-lang { position: absolute; top: 8px; left: 14px; font: 11px ${MONO}; color: ${C.muted}; text-transform: lowercase; }
      .ai-message-text table { border-collapse: collapse; margin: .6em 0 .9em; font-size: .94em; display: block; overflow-x: auto; }
      .ai-message-text th, .ai-message-text td { border: 1px solid ${C.line}; padding: 5px 10px; text-align: left; vertical-align: top; }
      .ai-message-text th { background: ${C.panel}; font-weight: 600; }
      .vr-copy { font: 12px ${FONT}; color: ${C.muted}; background: ${C.panel}; border: 1px solid ${C.line}; border-radius: 6px;
        padding: 2px 8px; cursor: pointer; }
      .vr-copy:hover { color: ${C.text}; border-color: ${C.muted}; }
      .vr-copy.done { color: #3fb950; border-color: #3fb95066; }
      pre > .vr-copy { position: absolute; top: 6px; right: 6px; opacity: 0; transition: opacity .15s; }
      pre:hover > .vr-copy, pre > .vr-copy:focus-visible, pre > .vr-copy.done { opacity: 1; }
      .vr-actions { display: flex; gap: 6px; margin-top: 8px; opacity: 0; transition: opacity .15s; }
      .outer-message-container:hover .vr-actions, .vr-actions:focus-within { opacity: 1; }
      .vr-intro { padding: 18px 6px 4px; }
      .vr-intro h3 { margin: 0 0 6px; font-size: 17px; font-weight: 650; color: ${C.text}; }
      .vr-intro p { margin: 0 0 14px; color: ${C.muted}; line-height: 1.55; }
      .vr-suggestions { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
      .vr-suggestions .deep-chat-button.deep-chat-suggestion-button { text-align: left; font: 13px/1.4 ${FONT} !important;
        color: ${C.text} !important; background: ${C.panel} !important; border: 1px solid ${C.line} !important;
        border-radius: 10px !important; padding: 10px 12px !important; cursor: pointer; margin: 0 !important; box-shadow: none !important;
        transition: border-color .15s, background .15s; }
      .vr-suggestions .deep-chat-button.deep-chat-suggestion-button:hover { border-color: ${C.claude}aa !important; background: #d977571a !important; }
      .loading-message-dots, .deep-chat-loading-message-dots-container { --loading-message-color: ${C.claude}; --loading-message-color-fade: #d9775733; }
      .error-message-text { white-space: pre-line; }
      /* while Claude answers, a coloured border runs around the input */
      #text-input-container { transition: box-shadow .2s; }
      #text-input-container.vr-busy {
        border: 1.5px solid transparent !important;
        background: linear-gradient(${C.panel}, ${C.panel}) padding-box,
          conic-gradient(from var(--vr-angle, 0deg), ${C.claude}, #f3c7b5, #3b82f6, #a78bfa, ${C.claude}) border-box !important;
        animation: vr-spin 1.8s linear infinite, vr-glow 1.8s ease-in-out infinite;
      }
      @keyframes vr-spin { to { --vr-angle: 360deg; } }
      @keyframes vr-glow { 0%, 100% { box-shadow: 0 0 0 3px #d977571f; } 50% { box-shadow: 0 0 14px 2px #d9775744; } }
    `;
  }

  function introHtml() {
    const buttons = SUGGESTIONS.map((t) => `<button class="deep-chat-button deep-chat-suggestion-button">${t}</button>`).join("");
    return `<div class="vr-intro deep-chat-temporary-message"><h3>Ask Claude about this review</h3>
      <p>Claude sees your open notes, the frame of each note with your mark, and the voice-over line.
      Answers are per note number. Your conversations are kept in this browser: find them under Chats.</p>
      <div class="vr-suggestions">${buttons}</div></div>`;
  }

  /** add copy buttons to code blocks and to finished answers (Deep Chat re-renders while streaming) */
  function decorate(chat) {
    const root = chat.shadowRoot;
    if (!root) return;
    const copyButton = (getText, label = "Copy") => {
      const b = document.createElement("button");
      b.className = "vr-copy"; b.type = "button"; b.textContent = label;
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        try { await navigator.clipboard.writeText(getText()); b.textContent = "Copied"; b.classList.add("done"); }
        catch (_) { b.textContent = "Copy failed"; }
        setTimeout(() => { b.textContent = label; b.classList.remove("done"); }, 1400);
      });
      return b;
    };
    for (const pre of root.querySelectorAll(".ai-message-text pre, .user-message-text pre")) {
      if (pre.querySelector(":scope > .vr-copy")) continue;
      const code = pre.querySelector("code");
      const lang = code && [...code.classList].find((c) => c.startsWith("language-"));
      if (lang && !pre.querySelector(":scope > .code-lang")) {
        const tag = document.createElement("span"); tag.className = "code-lang"; tag.textContent = lang.slice(9); pre.prepend(tag);
      }
      pre.append(copyButton(() => (code || pre).innerText));
    }
    const streaming = busyOf(chat);
    const bubbles = [...root.querySelectorAll(".ai-message-text")];
    bubbles.forEach((bubble, i) => {
      if (bubble.querySelector(":scope > .vr-actions, .vr-intro") || bubble.classList.contains("error-message-text")) return;
      if (streaming && i === bubbles.length - 1) return;  // the answer is still arriving
      if (!bubble.textContent.trim()) return;
      const bar = document.createElement("div"); bar.className = "vr-actions";
      bar.append(copyButton(() => {
        const clone = bubble.cloneNode(true);
        clone.querySelectorAll(".vr-actions, .vr-copy, .code-lang").forEach((n) => n.remove());
        return clone.innerText.trim();
      }, "Copy answer"));
      bubble.append(bar);
    });
  }

  // ── conversations: several per video, listed in "Chats", stored in this browser ──────────
  // index (localStorage "video-review.chats.v2"): {chats: [{id, key, scope, video, title, renamed, created, updated, count}],
  //   active: {<scope>: id}}; the messages of a chat are stored by Deep Chat under chat.key.
  const INDEX_KEY = "video-review.chats.v2";
  function readIndex() {
    try {
      const data = JSON.parse(localStorage.getItem(INDEX_KEY) || "null");
      if (data && Array.isArray(data.chats)) return {chats: data.chats, active: data.active || {}};
    } catch (_) { /* unreadable or blocked */ }
    return {chats: [], active: {}};
  }
  function writeIndex(index) {
    try { localStorage.setItem(INDEX_KEY, JSON.stringify(index)); } catch (_) { /* full or blocked: the chat still works */ }
  }
  const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  /** the conversations belong to the review folder (two folders can have a video with the same name) */
  const scopeOf = () => ((review().config || {}).reviewPath) || review().name || "";

  function storedCount(key) {
    try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v && Array.isArray(v.messages) ? v.messages.length : 0; }
    catch (_) { return 0; }
  }

  /** adopt the one-conversation-per-video storage of the previous version */
  function migrate(index) {
    const scope = scopeOf();
    const legacy = `video-review.chat.v1:${scope}`;
    if (!scope || index.chats.some((c) => c.key === legacy) || !storedCount(legacy)) return;
    const t = Date.now();
    index.chats.push({id: newId(), key: legacy, scope, video: review().name, title: "Earlier conversation",
      renamed: false, created: t, updated: t, count: storedCount(legacy)});
    writeIndex(index);
  }

  function chatTitle(chat) {
    const first = (chat.getMessages ? chat.getMessages() : []).find((m) => m.role === "user" && m.text);
    const text = first ? first.text.replace(/\s+/g, " ").trim() : "";
    return text ? (text.length > 64 ? `${text.slice(0, 61)}…` : text) : "New conversation";
  }

  /** record a conversation in the index once it has messages (drafts are not listed) */
  function touch(chat) {
    const index = readIndex();
    const count = chat.getMessages ? chat.getMessages().length : 0;
    let entry = index.chats.find((c) => c.id === chat.dataset.id);
    if (!entry) {
      if (!count) return;
      entry = {id: chat.dataset.id, key: chat.dataset.key, scope: chat.dataset.scope, video: chat.dataset.video,
        title: "", renamed: false, created: Date.now()};
      index.chats.push(entry);
    }
    entry.count = count;
    entry.updated = Date.now();
    if (!entry.renamed) entry.title = chatTitle(chat);
    index.active[entry.scope] = entry.id;
    writeIndex(index);
    renderChatList();
  }

  function busyOf(chat) {
    const root = chat.shadowRoot;
    return !!(root && root.querySelector(".loading-submit-button, #stop-icon"));
  }

  function createChat(entry) {
    const chat = document.createElement("deep-chat");
    chat._ready = new Promise((resolve) => { chat._rendered = resolve; });
    Object.assign(chat, chatStyles());
    Object.assign(chat.dataset, {id: entry.id, key: entry.key, scope: entry.scope, video: entry.video});
    const name = entry.video;
    if (storageOk()) chat.browserStorage = {key: entry.key, maxMessages: 400};
    const showError = (text) => { chat.addMessage({error: text}); scheduleDecorate(chat); };
    const options = () => ({model: $("chatModel").value, review: $("chatReview").checked});
    chat.connect = local
      ? {stream: true, handler: local.chat.handler(name, options, showError)}
      : {url: "/api/claude/chat", stream: true};
    chat.requestBodyLimits = {maxMessages: -1};  // the API is stateless: send the whole conversation
    chat.remarkable = {html: false, breaks: false, typographer: true, langPrefix: "hljs language-", highlight: highlightCode};
    chat.introMessage = {html: introHtml()};
    chat.errorMessages = {displayServiceErrorMessages: true,
      overrides: {default: local ? "Something went wrong. Please try again."
        : "Could not reach the review server. Is video-review still running? Then try again."}};
    // read for every message: a fresh token (the server may have restarted), the model and the review switch
    if (!local) chat.requestInterceptor = async (details) => {
      await refreshStatus().catch(() => null);  // cheap and local: picks up a restarted server's token
      renderChatBar();
      details.headers = {...(details.headers || {}), "X-Review-Token": token()};
      details.body = {...details.body, video: name, ...options()};
      return details;
    };
    chat.onMessage = ({isHistory}) => { if (!isHistory) { touch(chat); scheduleDecorate(chat); } };
    chat.onError = () => scheduleDecorate(chat);
    chat.onClearMessages = () => touch(chat);
    chat.onComponentRender = () => {
      setTimeout(chat._rendered, 0);  // submitUserMessage works once the first render is done
      scheduleDecorate(chat);
      if (!chat._observer && chat.shadowRoot) {
        chat._observer = new MutationObserver(() => scheduleDecorate(chat));
        chat._observer.observe(chat.shadowRoot, {childList: true, subtree: true, attributes: true, attributeFilter: ["class", "id"]});
      }
      applyLock();
    };
    return chat;
  }

  function scheduleDecorate(chat) {
    if (chat._decorating) return;
    chat._decorating = true;
    requestAnimationFrame(() => {
      chat._observer && chat._observer.disconnect();
      try {
        decorate(chat);
        const busy = busyOf(chat);
        const box = chat.shadowRoot && chat.shadowRoot.querySelector("#text-input-container");
        if (box) box.classList.toggle("vr-busy", busy);
        if (chat === ui.chat) $("chatSend").disabled = busy || $("chatSend").dataset.blocked === "1";
      } finally {
        chat._decorating = false;
        chat._observer && chat._observer.observe(chat.shadowRoot, {childList: true, subtree: true, attributes: true, attributeFilter: ["class", "id"]});
      }
    });
  }

  function elementFor(entry) {
    let chat = chats.get(entry.id);
    if (!chat) {
      chat = createChat(entry);
      chats.set(entry.id, chat);
      $("chatHost").append(chat);
    }
    return chat;
  }

  function show(chat) {
    for (const other of chats.values()) other.hidden = other !== chat;
    ui.chat = chat;
    const index = readIndex();
    if (index.chats.some((c) => c.id === chat.dataset.id)) { index.active[chat.dataset.scope] = chat.dataset.id; writeIndex(index); }
    applyLock();
    renderChatList();
    scheduleDecorate(chat);
  }

  /** a new, empty conversation about the current video (listed once it has a message) */
  async function newChat() {
    const name = review().name;
    if (!name) return null;
    await loadLibraries();
    const current = ui.chat;
    if (current && current.dataset.scope === scopeOf() && !(current.getMessages && current.getMessages().length)) {
      show(current);  // the current one is still empty
      return current;
    }
    const chat = elementFor({id: newId(), key: `video-review.chat.v2:${newId()}`, scope: scopeOf(), video: name});
    show(chat);
    return chat;
  }

  /** the active conversation of the current video: the last one used, or a new one */
  async function currentChat() {
    const name = review().name;
    if (!name) return null;
    await loadLibraries();
    if (ui.chat && ui.chat.dataset.scope === scopeOf() && chats.has(ui.chat.dataset.id)) { show(ui.chat); return ui.chat; }
    const index = readIndex();
    migrate(index);
    const scope = scopeOf();
    const mine = readIndex().chats.filter((c) => c.scope === scope).sort((a, b) => b.updated - a.updated);
    const entry = mine.find((c) => c.id === index.active[scope]) || mine[0];
    if (!entry) return newChat();
    const chat = elementFor(entry);
    show(chat);
    return chat;
  }

  async function openChat(entry) {
    if (entry.scope !== scopeOf()) {
      const videos = ((review().workspace || {}).videos || []).map((v) => v.name);
      if (!videos.includes(entry.video)) return;
      await review().openVideo(entry.video);  // switch the review too: the chat is about that video
    }
    await loadLibraries();
    show(elementFor(entry));
    toggleList(false);
    if (ui.chat && ui.chat.focusInput && keyReady()) ui.chat.focusInput();
  }

  function deleteChat(entry) {
    if (!confirm(`Delete the conversation “${entry.title || "New conversation"}”? This cannot be undone.`)) return;
    const index = readIndex();
    index.chats = index.chats.filter((c) => c.id !== entry.id);
    if (index.active[entry.scope] === entry.id) delete index.active[entry.scope];
    writeIndex(index);
    try { localStorage.removeItem(entry.key); } catch (_) { /* blocked */ }
    const chat = chats.get(entry.id);
    if (chat) { chat.remove(); chats.delete(entry.id); }
    if (ui.chat === chat) { ui.chat = null; currentChat(); }
    renderChatList();
  }

  function renameChat(entry, row) {
    const title = row.querySelector(".title");
    const input = document.createElement("input");
    input.className = "rename"; input.value = entry.title || ""; input.maxLength = 120;
    input.setAttribute("aria-label", "Conversation name");
    title.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim()) {
        const index = readIndex();
        const e = index.chats.find((c) => c.id === entry.id);
        if (e) { e.title = input.value.trim(); e.renamed = true; writeIndex(index); }
      }
      renderChatList();
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") finish(true);
      if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (ev) => ev.stopPropagation());
  }

  function when(t) {
    const d = new Date(t), today = new Date();
    if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
    return d.toLocaleDateString([], {day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric"});
  }

  function renderChatList() {
    const index = readIndex();
    const scope = scopeOf();
    const mine = index.chats.filter((c) => c.scope === scope);
    $("chatCount").textContent = String(mine.length);
    if ($("chatList").hidden) return;
    const q = $("chatSearch").value.trim().toLowerCase();
    const match = (c) => !q || `${c.title} ${c.video}`.toLowerCase().includes(q);
    const videos = ((review().workspace || {}).videos || []).map((v) => v.name);
    const sorted = (list) => list.filter(match).sort((a, b) => b.updated - a.updated);
    const groups = [["This video", sorted(mine)], ["Other videos", sorted(index.chats.filter((c) => c.scope !== scope))]];
    const nodes = [];
    for (const [label, list] of groups) {
      if (!list.length) continue;
      nodes.push(Object.assign(document.createElement("div"), {className: "chat-group", textContent: label}));
      for (const entry of list) {
        const other = entry.scope !== scope, available = !other || videos.includes(entry.video);
        const row = document.createElement("div");
        row.className = `chat-item${ui.chat && ui.chat.dataset.id === entry.id ? " active" : ""}${available ? "" : " unavailable"}`;
        row.tabIndex = available ? 0 : -1;
        row.setAttribute("role", "button");
        const meta = document.createElement("span"); meta.className = "meta";
        const title = Object.assign(document.createElement("span"), {className: "title", textContent: entry.title || "New conversation"});
        const sub = Object.assign(document.createElement("span"), {className: "sub",
          textContent: [other ? entry.video : null, `${entry.count || 0} message${entry.count === 1 ? "" : "s"}`, when(entry.updated),
            available ? null : "not in this folder"].filter(Boolean).join(" · ")});
        meta.append(title, sub);
        const actions = document.createElement("span"); actions.className = "row-actions";
        const btn = (text, label, fn, cls = "") => {
          const b = Object.assign(document.createElement("button"), {textContent: text, title: label, className: cls});
          b.setAttribute("aria-label", label);
          b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); });
          return b;
        };
        actions.append(btn("✎", "Rename", () => renameChat(entry, row)), btn("🗑", "Delete", () => deleteChat(entry), "danger"));
        row.append(meta, actions);
        if (available) {
          row.addEventListener("click", () => openChat(entry));
          row.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target === row) openChat(entry); });
        }
        nodes.push(row);
      }
    }
    if (!nodes.length) {
      nodes.push(Object.assign(document.createElement("div"), {className: "chat-empty",
        textContent: q ? "No conversation matches." : "No conversations yet. Ask Claude something and it shows up here."}));
    }
    $("chatItems").replaceChildren(...nodes);
  }

  function toggleList(open = $("chatList").hidden) {
    $("chatList").hidden = !open;
    $("chatListBtn").setAttribute("aria-expanded", String(open));
    if (open) { renderChatList(); $("chatSearch").focus(); }
  }
  $("chatListBtn").onclick = () => toggleList();
  $("chatListClose").onclick = () => toggleList(false);
  $("chatSearch").addEventListener("input", renderChatList);
  $("chatList").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); toggleList(false); } });
  $("chatListNew").onclick = async () => { toggleList(false); const c = await newChat(); if (c && c.focusInput && keyReady()) c.focusInput(); };

  // ── API key: no key, no typing ───────────────────────────────────────────────────────────
  const keyReady = () => !!(((ui.status || {}).chat || {}).configured);
  function applyLock() {
    const locked = !keyReady();
    $("chatLock").hidden = !locked || !review().name;
    for (const chat of chats.values()) {
      if (chat.disableSubmitButton) chat.disableSubmitButton(locked);
      const input = chat.shadowRoot && chat.shadowRoot.querySelector("#text-input");
      if (input) {
        input.setAttribute("contenteditable", locked ? "false" : "true");
        input.setAttribute("deep-chat-placeholder-text", locked ? "Add your API key above to chat with Claude"
          : "Message Claude…   (Enter sends, Shift+Enter new line)");
      }
    }
  }
  $("chatLockKey").onclick = () => { $("keyForm").hidden = false; $("keyInput").focus(); };
  $("chatHost").addEventListener("click", (e) => {  // a suggestion or the input clicked without a key: point at the lock
    if (keyReady() || $("chatLock").hidden || !e.target.closest("deep-chat")) return;
    $("chatLock").classList.remove("nudge"); void $("chatLock").offsetWidth; $("chatLock").classList.add("nudge");
  });

  function renderChatBar() {
    const c = (ui.status || {}).chat || {};
    const select = $("chatModel");
    if (!select.options.length && c.models) {
      for (const m of c.models) select.append(new Option(m.name, m.id, m.id === c.model, m.id === c.model));
    }
    $("chatKeyText").textContent = c.configured ? (c.source === "environment" ? "Key from environment" : "API key set") : "Add API key";
    $("chatKeyDot").className = `dot ${c.configured ? "on" : "off"}`;
    $("chatKeyBtn").disabled = !c.enabled || c.source === "environment";
    $("keyForget").hidden = c.source !== "page";
    const ready = c.enabled && review().name;
    $("chatSend").dataset.blocked = !ready || !c.configured ? "1" : "0";
    $("chatSend").disabled = !ready || !c.configured || (ui.chat ? busyOf(ui.chat) : false);
    $("chatNew").disabled = !ready;
    $("chatListBtn").disabled = !c.enabled;
    if (!c.configured && c.enabled) $("keyForm").hidden = false;
    applyLock();
    renderContext();
    renderChatList();
  }

  function renderContext() {
    const r = review();
    const include = $("chatReview").checked;
    if (!r.name) { $("chatContext").textContent = "Open a video to chat about its review."; return; }
    const notes = r.openNotes(), shots = Math.min(r.openShots(), 20);
    $("chatContext").textContent = include
      ? `Claude sees ${notes} open note${notes === 1 ? "" : "s"}${shots ? ` and ${shots} screenshot${shots === 1 ? "" : "s"}` : ""} of ${r.name}`
      : `The review of ${r.name} is not shared: only your messages are sent`;
    $("chatContext").parentElement.classList.toggle("off", !include);
  }
  $("chatReview").onchange = renderContext;
  document.addEventListener("review:saved", () => { if (!$("paneChat").hidden) renderContext(); });

  function loadCodeTheme() {
    if (codeTheme) return Promise.resolve();
    return fetch("/static/vendor/highlight/github-dark.min.css").then((r) => r.text())
      .then((css) => { codeTheme = css.replace(/\.hljs\{[^}]*\}/, ".hljs{color:#e6edf3;background:transparent}"); })
      .catch(() => { codeTheme = " "; });
  }

  function loadLibraries() {
    ui.libs = ui.libs || (async () => {
      try {  // the spinning border of the input while Claude answers (must be registered on the document)
        CSS.registerProperty({name: "--vr-angle", syntax: "<angle>", inherits: false, initialValue: "0deg"});
      } catch (_) { /* already registered or unsupported: the border then pulses instead */ }
      if (!window.hljs) await loadScript("/static/vendor/highlight/highlight.min.js").catch(() => null);
      if (window.hljs) {  // Remotion code is mostly TSX / JSX
        window.hljs.registerAliases(["tsx", "mts", "cts"], {languageName: "typescript"});
        window.hljs.registerAliases(["jsx", "mjs", "cjs"], {languageName: "javascript"});
      }
      await Promise.all([import("/static/vendor/deep-chat/deepChat.bundle.js"), loadCodeTheme()]);
    })().catch((err) => { ui.libs = null; throw err; });
    return ui.libs;
  }

  /** syntax colours for code blocks (Deep Chat's Markdown renderer calls this; hljs escapes the code) */
  function highlightCode(code, lang) {
    const hljs = window.hljs;
    if (!hljs || !lang || !hljs.getLanguage(lang)) return "";  // "" = plain, escaped by the renderer
    try { return hljs.highlight(code, {language: lang, ignoreIllegals: true}).value; } catch (_) { return ""; }
  }

  async function showChat() {
    const c = (ui.status || {}).chat;
    renderChatBar();
    if (!c || !c.enabled) {
      message("chatMsg", c ? `The chat is off: ${c.reason}.` : "The server did not answer. Is video-review still running?", "warn");
      $("keyForm").hidden = true;
      return;
    }
    message("chatMsg", review().name ? "" : "Open or upload a video to chat about its review.");
    $("keyForm").hidden = c.configured;
    try {
      const chat = await currentChat();
      if (chat && c.configured && chat.focusInput) setTimeout(() => chat.focusInput(), 50);
    } catch (err) {
      message("chatMsg", `Could not load the chat: ${err.message}`, "error");
    }
    if (!c.configured) $("keyInput").focus();
  }

  document.addEventListener("review:video", () => {
    if (!drawer.hidden && ui.tab === "chat") showChat(); else renderChatList();
  });

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
      renderChatBar();
      const chat = await currentChat();
      if (chat && chat.focusInput) chat.focusInput();
    } catch (err) {
      message("chatMsg", err.message, "error");
    }
    renderChatBar();
  });
  $("keyForget").onclick = async () => {
    ui.status.chat = await post("/api/claude/key", {key: null}).catch(() => ui.status.chat);
    renderChatBar();
  };

  $("chatNew").onclick = async () => {
    const chat = await newChat();
    if (chat && chat.focusInput && keyReady()) chat.focusInput();
  };

  $("chatSend").onclick = async () => {
    if (!review().name || !keyReady()) return;
    await review().save();
    const chat = await currentChat();
    await chat._ready;
    if (busyOf(chat)) return;
    $("chatReview").checked = true;
    renderContext();
    const open = review().openNotes();
    chat.submitUserMessage({text: `Please go through the ${open} open note${open === 1 ? "" : "s"} of my review of `
      + `${review().name}. For each note number, tell me exactly what to change, and list the notes that are unclear.`});
  };

  // ── "✦ Send to Claude" in the notes panel ────────────────────────────────────────────────
  if (local) {  // one tab only: the chat
    $("tabCode").hidden = true;
    $("paneCode").hidden = true;
    $("tabChat").textContent = "Chat with Claude (API key)";
    $("sendClaude").title = "Open the chat with Claude (your own Anthropic API key) and send the review";
  }

  $("sendClaude").onclick = async () => {
    await openDrawer();
    const s = ui.status || {};
    if (ui.tab === "code" && !(s.terminal && s.terminal.available) && s.chat && s.chat.enabled) await selectTab("chat");
    if (ui.tab === "code") $("termSend").click();
    else if (s.chat && s.chat.configured) $("chatSend").click();
    else { $("keyForm").hidden = false; $("keyInput").focus(); }
  };

  // the session may already run (page reload): reconnect the terminal when the drawer opens
  document.addEventListener("review:ready", () => {
    const s = (review().workspace || {}).claude;
    if (s) ui.status = s;
    if (s && s.terminal && s.terminal.running) $("claudeBtn").classList.add("live");
  });
})();
