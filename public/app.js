/* ============================================================
   Muse Chat — front-end logic
   Talks only to /api/chat and /api/config on this same origin.
   The Muse API key never appears here — it lives in the Worker.
   ============================================================ */
(() => {
  "use strict";

  /* ------------------------------------------------------------
     Customization — edit freely.
     ------------------------------------------------------------ */
  const CONFIG = {
    // How many past messages to send back as conversation context.
    historyLimit: 20,
    // Suggestion chips shown on the welcome screen.
    suggestions: [
      "Explain quantum computing like I'm five",
      "Write a Python function that checks if a string is a palindrome",
      "Draft a friendly follow-up email to a client",
      "Give me 5 weekend project ideas for a web developer",
    ],
  };

  /* ------------------------------------------------------------
     DOM references
     ------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);
  const chatEl = $("chat");
  const welcomeEl = $("welcome");
  const inputEl = $("input");
  const formEl = $("composerForm");
  const sendBtn = $("sendBtn");
  const themeBtn = $("themeBtn");
  const newChatBtn = $("newChatBtn");
  const scrollBtn = $("scrollBtn");
  const bannerEl = $("configBanner");
  const modelTagEl = $("modelTag");
  const suggestionsEl = $("suggestions");

  const ICON_COPY =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const ICON_CHECK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const ICON_RETRY =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';

  /* ------------------------------------------------------------
     State
     ------------------------------------------------------------ */
  const messages = []; // [{ role: "user" | "assistant", content }]
  let busy = false; // a request is in flight
  let controller = null; // AbortController for the in-flight request
  let stick = true; // auto-scroll while pinned to the bottom
  let lastUserText = ""; // remembered for the "Retry" button
  let session = 0; // bumped on "New chat" so stale async work is ignored

  /* ------------------------------------------------------------
     Scrolling
     ------------------------------------------------------------ */
  const atBottom = () => chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 90;

  function scrollToBottom(force = false) {
    if (force) stick = true;
    if (stick) chatEl.scrollTop = chatEl.scrollHeight;
  }

  chatEl.addEventListener("scroll", () => {
    stick = atBottom();
    scrollBtn.hidden = stick;
  });

  scrollBtn.addEventListener("click", () => {
    stick = true;
    chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: "smooth" });
    inputEl.focus();
  });

  /* ------------------------------------------------------------
     Tiny safe markdown renderer (escapes everything first)
     ------------------------------------------------------------ */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function mdToHtml(src) {
    const blocks = [];
    let text = escapeHtml(src ?? "");

    // Fenced code blocks (tolerates an unclosed fence while streaming).
    text = text.replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g, (_, code) => {
      blocks.push(`<pre class="code"><code>${code.replace(/\n$/, "")}</code></pre>`);
      return `\u0000B${blocks.length - 1}\u0000`;
    });
    // Inline code
    text = text.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
    // Bold, italic
    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
    // Links: [label](https://…)
    text = text.replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    // Headings → bold lines
    text = text.replace(/^#{1,6}\s+([^\n]+)$/gm, "<strong>$1</strong>");
    // Bullet lists → •
    text = text.replace(/^[-*+]\s+/gm, "•&nbsp;");
    // Newlines
    text = text.replace(/\n/g, "<br>");

    // Put code blocks back
    return text.replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  }

  /* ------------------------------------------------------------
     Message rendering
     ------------------------------------------------------------ */
  function addMessage(kind) {
    welcomeEl.hidden = true;
    const msg = document.createElement("div");
    msg.className = `msg msg--${kind}`;

    if (kind === "assistant") {
      const avatar = document.createElement("div");
      avatar.className = "msg__avatar";
      avatar.textContent = "✦";
      msg.appendChild(avatar);
    }

    const stack = document.createElement("div");
    stack.className = "msg__stack";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    stack.appendChild(bubble);
    msg.appendChild(stack);
    chatEl.appendChild(msg);
    return { msg, stack, bubble };
  }

  function showTyping(bubble) {
    bubble.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  }

  function addActionRow(stack) {
    const actions = document.createElement("div");
    actions.className = "msg__actions";
    stack.appendChild(actions);
    return actions;
  }

  function addCopyButton(stack, getText) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "msg__action";
    btn.innerHTML = `${ICON_COPY}<span>Copy</span>`;
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(getText());
        btn.innerHTML = `${ICON_CHECK}<span>Copied</span>`;
        setTimeout(() => (btn.innerHTML = `${ICON_COPY}<span>Copy</span>`), 1600);
      } catch {
        /* clipboard unavailable */
      }
    });
    addActionRow(stack).appendChild(btn);
  }

  function finishAssistant(ai, text, stopped) {
    ai.bubble.innerHTML = text ? mdToHtml(text) : '<span class="msg__stopped">(empty response)</span>';
    if (text) addCopyButton(ai.stack, () => text);
    if (stopped) {
      const note = document.createElement("div");
      note.className = "msg__stopped";
      note.textContent = "Stopped by you";
      ai.stack.appendChild(note);
    }
  }

  function showError(message, canRetry) {
    const { msg, stack, bubble } = addMessage("error");
    bubble.textContent = message;
    if (canRetry) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "msg__action";
      btn.style.opacity = "1";
      btn.innerHTML = `${ICON_RETRY}<span>Retry</span>`;
      btn.addEventListener("click", () => {
        msg.remove();
        ask(lastUserText, { record: false });
      });
      addActionRow(stack).appendChild(btn);
    }
    scrollToBottom();
  }

  /* ------------------------------------------------------------
     The main flow: user message → /api/chat → streamed answer
     ------------------------------------------------------------ */
  async function ask(rawText, { record = true } = {}) {
    const text = String(rawText || "").trim();
    if (!text || busy) return;
    const mySession = session;

    if (record) {
      lastUserText = text;
      messages.push({ role: "user", content: text });
      addMessage("user").bubble.textContent = text;
      scrollToBottom(true);
    }

    const ai = addMessage("assistant");
    showTyping(ai.bubble);
    scrollToBottom(true);

    setBusy(true);
    controller = new AbortController();

    let acc = "";
    let sawDone = false;

    const render = () => {
      ai.bubble.innerHTML = mdToHtml(acc) + '<span class="caret" aria-hidden="true"></span>';
      scrollToBottom();
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: messages
            .slice(-CONFIG.historyLimit)
            .map(({ role, content }) => ({ role, content })),
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        let message = `Request failed (HTTP ${res.status}).`;
        try {
          const data = await res.json();
          if (data && data.message) message = data.message;
        } catch {
          /* not JSON */
        }
        throw new Error(message);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const handleLine = (line) => {
        line = line.trim();
        if (!line.startsWith("data:")) return;
        let evt;
        try {
          evt = JSON.parse(line.slice(5).trim());
        } catch {
          return;
        }
        if (evt.type === "delta" && typeof evt.text === "string") {
          acc += evt.text;
          render();
        } else if (evt.type === "error") {
          throw new Error(evt.message || "The server reported an error.");
        } else if (evt.type === "done") {
          sawDone = true;
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          handleLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      if (buf.trim()) handleLine(buf);

      if (!sawDone && !acc) {
        throw new Error("The stream ended unexpectedly. Please try again.");
      }

      finishAssistant(ai, acc, false);
      if (acc) messages.push({ role: "assistant", content: acc });
    } catch (err) {
      if (mySession !== session) return; // chat was reset while streaming
      if (err && err.name === "AbortError") {
        // The user pressed stop — keep whatever already streamed in.
        if (acc) {
          finishAssistant(ai, acc, true);
          messages.push({ role: "assistant", content: acc });
        } else {
          ai.msg.remove();
        }
      } else {
        ai.msg.remove();
        showError(err && err.message ? err.message : "Something went wrong.", Boolean(lastUserText));
      }
    } finally {
      if (mySession === session) {
        setBusy(false);
        controller = null;
        scrollToBottom();
        inputEl.focus();
      }
    }
  }

  function setBusy(b) {
    busy = b;
    sendBtn.classList.toggle("is-busy", b);
    sendBtn.setAttribute("aria-label", b ? "Stop generating" : "Send message");
    sendBtn.title = b ? "Stop generating" : "Send";
  }

  /* ------------------------------------------------------------
     Composer
     ------------------------------------------------------------ */
  function resizeInput() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 168) + "px";
  }
  inputEl.addEventListener("input", resizeInput);

  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  inputEl.addEventListener("keydown", (e) => {
    // Enter sends on desktop keyboards; Shift+Enter makes a newline.
    // On touch devices the on-screen Enter always makes a newline.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarsePointer) {
      e.preventDefault();
      formEl.requestSubmit();
    }
  });

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) {
      controller && controller.abort(); // the send button doubles as "Stop"
      return;
    }
    const text = inputEl.value;
    if (!text.trim()) return;
    inputEl.value = "";
    resizeInput();
    ask(text);
  });

  /* ------------------------------------------------------------
     Header actions
     ------------------------------------------------------------ */
  newChatBtn.addEventListener("click", () => {
    session += 1;
    if (controller) controller.abort();
    messages.length = 0;
    lastUserText = "";
    setBusy(false);
    controller = null;
    chatEl.querySelectorAll(".msg").forEach((m) => m.remove());
    welcomeEl.hidden = false;
    stick = true;
    scrollBtn.hidden = true;
    inputEl.value = "";
    resizeInput();
    inputEl.focus();
  });

  themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("muse-theme", next);
    } catch {
      /* private mode */
    }
  });

  /* ------------------------------------------------------------
     Welcome screen + server config check
     ------------------------------------------------------------ */
  CONFIG.suggestions.forEach((text) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = text;
    chip.addEventListener("click", () => ask(text));
    suggestionsEl.appendChild(chip);
  });

  fetch("/api/config")
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => {
      if (!cfg) return;
      if (cfg.model) {
        modelTagEl.textContent = cfg.model;
        modelTagEl.hidden = false;
      }
      if (cfg.configured === false) bannerEl.hidden = false;
    })
    .catch(() => {
      /* offline? the first message will surface the error */
    });

  resizeInput();
})();
