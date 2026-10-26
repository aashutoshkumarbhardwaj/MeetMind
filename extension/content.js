// Best-effort Google Meet caption collector. Meet's DOM can change; transcript paste is the guaranteed fallback.
(() => {
  const KEY = "meetmind_live_transcript";
  let lines = [];
  let lastText = "";
  let scanTimer = null;
  let isObserverActive = true;

  function isExtensionContextValid() {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
  }

  // Known Google Meet UI and accessibility announcement phrases to reject
  const IGNORED_PHRASES = [
    "developing an extension for meet",
    "an add-on would work better",
    "developers.google.com/meet",
    "browser-extension",
    "you have joined the call",
    "you're the first one here",
    "your camera is turned on",
    "your camera is turned off",
    "your microphone is turned on",
    "your microphone is turned off",
    "your mic is muted",
    "you're muted",
    "your hand is lowered",
    "your hand is raised",
    "press the down arrow",
    "open the hover tray",
    "escape to close it",
    "meeting details",
    "people (",
    "chat with everyone",
    "turn on captions",
    "turn off captions",
    "raise hand",
    "leave call",
    "stop presenting",
    "you are presenting",
    "others can see your screen",
    "jump to latest",
    "jump to the bottom",
    "arrow_downward",
    "arrow_upward",
    "keyboard_arrow_down",
    "keyboard_arrow_up",
    "more_vert",
    "closed_captions",
    "caption settings",
    "font size",
    "font colour",
    "font color",
    "languageenglish",
    "open caption settings"
  ];

  function isSystemNotificationText(text) {
    const lower = text.toLowerCase().trim();
    if (lower === "you" || lower === "jump to the bottom" || lower === "arrow_downward") return true;
    if (lower.startsWith("languageenglish") || lower.includes("open caption settings") || (lower.includes("beta") && lower.includes("english"))) return true;
    return IGNORED_PHRASES.some(phrase => lower.includes(phrase));
  }

  function collectVisibleCaptionText() {
    try {
      const texts = [];

      // 1. Structured Google Meet caption blocks (each person's speech entry)
      const blocks = document.querySelectorAll('[jsname="YSxPC"], div.nMx22c, div.T4LgNb');
      if (blocks.length > 0) {
        for (const block of blocks) {
          if (!(block instanceof HTMLElement)) continue;
          if (block.offsetWidth === 0 && block.offsetHeight === 0) continue;
          if (block.closest('[role="dialog"], [role="menu"], [role="listbox"]')) continue;

          // Speaker name (e.g. "You", "Priya", "Alex")
          const speakerEl = block.querySelector('[data-sender-name], div.zs75Ib, div.NWx9Dd, span.jT30Ce, .poVWob');
          const speaker = speakerEl ? (speakerEl.innerText || speakerEl.getAttribute("data-sender-name") || "").trim() : "";

          // Actual spoken words container
          const textEl = block.querySelector('[jsname="tgaKEf"], div.iTTPOb, div.bh44bd');
          let speech = "";
          if (textEl) {
            speech = (textEl.innerText || textEl.textContent || "").trim();
          } else {
            // Clone block without speaker, buttons, and material icons
            const clone = block.cloneNode(true);
            clone.querySelectorAll('button, select, [role="listbox"], [role="menu"], [data-sender-name], div.zs75Ib, div.NWx9Dd, span.jT30Ce, .material-icons, .google-material-icons').forEach(n => n.remove());
            speech = (clone.innerText || clone.textContent || "").trim();
          }

          speech = speech.replace(/\s+/g, " ").trim();
          if (!speech || speech.length < 2) continue;
          if (isSystemNotificationText(speech)) continue;
          if (speaker && speech.toLowerCase() === speaker.toLowerCase()) continue;

          let cleanSpeech = speech;
          if (speaker && cleanSpeech.toLowerCase().startsWith(speaker.toLowerCase() + ":")) {
            cleanSpeech = cleanSpeech.slice(speaker.length + 1).trim();
          } else if (speaker && cleanSpeech.toLowerCase().startsWith(speaker.toLowerCase() + " ")) {
            cleanSpeech = cleanSpeech.slice(speaker.length).trim();
          }

          const formatted = speaker ? `${speaker}: ${cleanSpeech}` : cleanSpeech;
          texts.push(formatted);
        }
      }

      // 2. Fallback: Search caption overlay containers if block selectors found nothing
      if (!texts.length) {
        const containers = document.querySelectorAll('div.a4cQT, div[aria-label*="caption" i], div[aria-label*="subtitle" i]');
        for (const container of containers) {
          if (!(container instanceof HTMLElement)) continue;
          if (container.offsetWidth === 0 && container.offsetHeight === 0) continue;
          if (container.closest('[role="dialog"], [role="menu"], [role="listbox"]') || container.querySelector('[role="listbox"], [role="menu"], select')) continue;
          const raw = extractNodeText(container);
          if (!raw) continue;
          for (const line of raw.split("\n")) {
            const clean = line.replace(/\s+/g, " ").trim();
            if (clean.length < 3) continue;
            if (isSystemNotificationText(clean)) continue;
            texts.push(clean);
          }
        }
      }

      return [...new Set(texts)].slice(-20);
    } catch {
      return [];
    }
  }

  function extractNodeText(node) {
    if (!node) return "";
    let text = "";
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += " " + child.textContent + " ";
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName;
        if (['BUTTON', 'SELECT', 'I', 'SVG', 'STYLE', 'SCRIPT'].includes(tag)) continue;
        if (child.classList?.contains('material-icons') || child.classList?.contains('google-material-icons')) continue;
        text += " " + extractNodeText(child) + " ";
      }
    }
    return text.replace(/\s+/g, " ").trim();
  }

  function normalizeText(str) {
    return (str || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  }

  function appendCandidate(rawLine) {
    if (!rawLine || rawLine.length < 2) return;

    // Fix "YouTo", "YouWe", "YouIn" where speaker badge joined text without space
    let line = rawLine
      .replace(/^You([A-Z])/g, "You: $1")
      .replace(/^You\s+(?=[A-Za-z])/i, "You: ")
      .trim();

    if (lines.length === 0) {
      lines.push(line);
      return;
    }
    const last = lines[lines.length - 1];
    if (line === last) return;

    const normLine = normalizeText(line);
    const normLast = normalizeText(last);

    // If normalized new line starts with normalized last line, or contains it (progressive speech update):
    if (normLine.startsWith(normLast) || (normLast.length > 5 && normLine.includes(normLast))) {
      lines[lines.length - 1] = line;
      return;
    }

    // Check if line and last are from the same speaker and the new line continues/replaces the last line
    const colonIdx = line.indexOf(":");
    const lastColonIdx = last.indexOf(":");
    if (colonIdx > 0 && lastColonIdx > 0 && line.slice(0, colonIdx) === last.slice(0, lastColonIdx)) {
      const speechNorm = normalizeText(line.slice(colonIdx + 1));
      const lastSpeechNorm = normalizeText(last.slice(lastColonIdx + 1));
      if (speechNorm.startsWith(lastSpeechNorm) || speechNorm.length > lastSpeechNorm.length) {
        lines[lines.length - 1] = line;
        return;
      }
    }

    if (!lines.slice(-8).some(l => normalizeText(l) === normLine)) {
      lines.push(line);
    }
  }

  async function scan() {
    if (!isExtensionContextValid()) {
      teardown();
      return;
    }
    const candidates = collectVisibleCaptionText();
    const text = candidates.join("\n");
    if (!text || text === lastText) return;
    lastText = text;
    for (const line of candidates) {
      appendCandidate(line);
    }
    lines = lines.slice(-1500);
    try {
      await chrome.storage.local.set({ [KEY]: lines.join("\n") });
    } catch {
      // Silently ignore storage write failures if context was invalidated
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan().catch(() => {});
    }, 150);
  }

  let observer = null;
  let intervalId = null;

  function teardown() {
    if (!isObserverActive) return;
    isObserverActive = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
  }

  try {
    if (document.documentElement) {
      observer = new MutationObserver(() => {
        scheduleScan();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }
    intervalId = setInterval(() => {
      scheduleScan();
    }, 1000);
  } catch {
    // Fail gracefully if observing fails
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "MEETMIND_GET_CAPTIONS") {
      const candidates = collectVisibleCaptionText();
      for (const line of candidates) {
        appendCandidate(line);
      }
      const ccBtn = document.querySelector('button[aria-label*="caption" i], button[aria-label*="subtitle" i]');
      const captionsOn = ccBtn ? (ccBtn.getAttribute("aria-pressed") === "true" || ccBtn.classList.contains("active")) : null;
      sendResponse({ transcript: lines.join("\n"), captionsOn });
      return false;
    }
    if (message?.type === "MEETMIND_CLEAR_CAPTIONS") {
      lines = [];
      lastText = "";
      if (isExtensionContextValid()) {
        chrome.storage.local.set({ [KEY]: "" })
          .then(() => sendResponse({ ok: true }))
          .catch(() => sendResponse({ ok: false }));
        return true;
      }
      sendResponse({ ok: true });
      return false;
    }
  });
})();