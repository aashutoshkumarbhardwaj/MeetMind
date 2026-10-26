// Browser compatibility shim for live demo / standalone testing
if (typeof chrome === "undefined" || !chrome?.storage?.local) {
  const memStore = { meetmind_api_url: "http://localhost:8000" };
  window.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (!keys) return { ...memStore };
          const res = {};
          const arr = Array.isArray(keys) ? keys : [keys];
          arr.forEach(k => { if (k in memStore) res[k] = memStore[k]; });
          return res;
        },
        set: async (obj) => { Object.assign(memStore, obj); },
        remove: async (keys) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          arr.forEach(k => delete memStore[k]);
        }
      },
      onChanged: { addListener: () => {} }
    },
    runtime: {
      sendMessage: async (msg) => {
        if (msg.type === "MEETMIND_START_RECORDING") return { ok: true };
        if (msg.type === "MEETMIND_STOP_RECORDING") return { ok: true };
        return { ok: true };
      }
    },
    tabs: {
      query: async () => [{ id: 1, title: "Google Meet | Sprint Review", url: "https://meet.google.com/abc-defg-hij" }],
      sendMessage: async () => ({
        transcript: "Omar: We need to ship the onboarding page by Friday.\nPriya: I will finalize the copy by Wednesday afternoon.\nOmar: I will fix the mobile layout and share a preview tomorrow.\nFacilitator: We agreed to remove the optional profile step from v1.\nOmar: Who is going to own the analytics decision?\nFacilitator: No one has volunteered for analytics yet."
      })
    },
    permissions: {
      contains: async () => true,
      request: async () => true
    }
  };
}

const $ = (id) => document.getElementById(id);
let latestMarkdown = "";
let recording = false;
let activeSessionId = null;
let savedSessions = [];

function updateAudioRecoveryUI(hasAudio = null) {
  if (!$("audioRecoveryRow")) return;
  if (hasAudio !== null) {
    $("audioRecoveryRow").hidden = !hasAudio || recording;
  } else {
    chrome.storage.local.get(["meetmind_has_recorded_audio"]).then(s => {
      $("audioRecoveryRow").hidden = !s.meetmind_has_recorded_audio || recording;
    });
  }
}

function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderInlineMarkdown(text) {
  let s = escapeHtml(text);

  // Evidence and indicator badges
  s = s.replace(/\[Direct Evidence\]/gi, '<span class="badge badge-evidence"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Direct Evidence</span>');
  s = s.replace(/\[AI Inference(?:\s*\/\s*Analysis)?\]/gi, '<span class="badge badge-inference"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v2m0 16v2m-7.07-2.93 1.41-1.41M17.66 7.76l1.41-1.41M2 12h2m16 0h2m-2.93 7.07-1.41-1.41M7.76 6.34 6.34 4.93"/></svg> AI Inference</span>');
  s = s.replace(/\[Insufficient Evidence(?:\s+in\s+Transcript)?\]/gi, '<span class="badge badge-insufficient"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> Insufficient Evidence</span>');
  s = s.replace(/\[Action Item\]/gi, '<span class="badge badge-action">Action Item</span>');
  s = s.replace(/\[Decision\]/gi, '<span class="badge badge-decision">Decision</span>');

  // Inline code `code`
  s = s.replace(/`([^`]+)`/g, '<code class="briefing-code">$1</code>');

  // Bold **text** or __text__
  s = s.replace(/(\*\*|__)(.*?)\1/g, '<strong>$2</strong>');

  // Italic *text* or _text_
  s = s.replace(/(?<![*\w])(\*|_)(?!\s)([^*_]+?)(?<!\s)\1(?![*\w])/g, '<em>$2</em>');

  // Links [text](url)
  s = s.replace(/\[(.*?)\]\(((?:https?:\/\/|\/)[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="briefing-link">$1</a>');

  return s;
}

function renderMarkdownToHtml(markdown) {
  if (!markdown) return "";
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let inList = null; // 'ul' or 'ol'
  let inBlockquote = false;
  let inCodeBlock = false;
  let codeBlockContent = [];
  let inTable = false;
  let tableRows = [];

  function closeList() {
    if (inList) {
      html.push(`</${inList}>`);
      inList = null;
    }
  }

  function closeBlockquote() {
    if (inBlockquote) {
      html.push("</blockquote>");
      inBlockquote = false;
    }
  }

  function flushTable() {
    if (!inTable) return;
    inTable = false;
    if (tableRows.length === 0) return;

    let tableHtml = '<div class="table-container"><table class="briefing-table">';
    const headerRow = tableRows[0];
    const hasHeader = tableRows.length > 1;

    if (hasHeader) {
      tableHtml += '<thead><tr>';
      for (const col of headerRow) {
        tableHtml += `<th>${renderInlineMarkdown(col)}</th>`;
      }
      tableHtml += '</tr></thead>';
    }

    tableHtml += '<tbody>';
    const bodyRows = hasHeader ? tableRows.slice(1) : tableRows;
    for (const row of bodyRows) {
      tableHtml += '<tr>';
      for (const col of row) {
        tableHtml += `<td>${renderInlineMarkdown(col)}</td>`;
      }
      tableHtml += '</tr>';
    }
    tableHtml += '</tbody></table></div>';
    html.push(tableHtml);
    tableRows = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    // Code block fences ```
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        html.push(`<pre class="code-block"><code>${escapeHtml(codeBlockContent.join("\n"))}</code></pre>`);
        codeBlockContent = [];
        inCodeBlock = false;
      } else {
        closeList();
        closeBlockquote();
        flushTable();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(rawLine);
      continue;
    }

    // Horizontal Rule: ---, ***, ___
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(line)) {
      closeList();
      closeBlockquote();
      flushTable();
      html.push('<hr class="briefing-hr" />');
      continue;
    }

    // Markdown Table row
    if (line.includes("|") && line.startsWith("|")) {
      closeList();
      closeBlockquote();
      if (line.replace(/[\s|:-]/g, "") === "") {
        inTable = true;
        continue;
      }
      const cells = line.split("|").slice(1, -1).map(c => c.trim());
      if (cells.length > 0) {
        inTable = true;
        tableRows.push(cells);
        continue;
      }
    } else if (inTable) {
      flushTable();
    }

    // Headings: #, ##, ###, ####
    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      closeList();
      closeBlockquote();
      flushTable();
      const level = headerMatch[1].length;
      const title = renderInlineMarkdown(headerMatch[2]);
      html.push(`<h${level} class="briefing-h${level}">${title}</h${level}>`);
      continue;
    }

    // Blockquote: > text
    if (line.startsWith(">")) {
      closeList();
      flushTable();
      const quoteText = renderInlineMarkdown(line.replace(/^>\s?/, ""));
      if (!inBlockquote) {
        html.push('<blockquote class="briefing-quote">');
        inBlockquote = true;
      }
      html.push(`<p>${quoteText}</p>`);
      continue;
    } else if (inBlockquote) {
      closeBlockquote();
    }

    // Checklist or Task Item: - [ ] or - [x]
    const taskMatch = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (taskMatch) {
      flushTable();
      closeBlockquote();
      if (inList !== "ul") {
        closeList();
        html.push('<ul class="briefing-ul task-list">');
        inList = "ul";
      }
      const isChecked = taskMatch[1].toLowerCase() === "x";
      const taskBody = renderInlineMarkdown(taskMatch[2]);
      html.push(`<li class="task-item ${isChecked ? "checked" : ""}"><span class="task-checkbox">${isChecked ? "☑" : "☐"}</span> <span>${taskBody}</span></li>`);
      continue;
    }

    // Indented sub-bullets
    const isIndented = /^(\s{2,}|\t)[-*]\s+/.test(rawLine);
    const ulMatch = line.match(/^[-*]\s+(.*)$/);
    if (ulMatch) {
      flushTable();
      closeBlockquote();
      if (!inList) {
        html.push('<ul class="briefing-ul">');
        inList = "ul";
      }
      const itemClass = isIndented ? ' class="nested-li"' : '';
      html.push(`<li${itemClass}>${renderInlineMarkdown(ulMatch[1])}</li>`);
      continue;
    }

    // Ordered List: 1. or 2.
    const olMatch = line.match(/^(\d+)\.\s+(.*)$/);
    if (olMatch) {
      flushTable();
      closeBlockquote();
      if (inList !== "ol") {
        closeList();
        html.push('<ol class="briefing-ol">');
        inList = "ol";
      }
      html.push(`<li>${renderInlineMarkdown(olMatch[2])}</li>`);
      continue;
    }

    // Empty line -> break list / blockquote
    if (!line) {
      closeList();
      closeBlockquote();
      flushTable();
      continue;
    }

    // Regular paragraph
    closeList();
    closeBlockquote();
    flushTable();
    html.push(`<p class="briefing-p">${renderInlineMarkdown(line)}</p>`);
  }

  closeList();
  closeBlockquote();
  flushTable();
  if (inCodeBlock) {
    html.push(`<pre class="code-block"><code>${escapeHtml(codeBlockContent.join("\n"))}</code></pre>`);
  }

  return html.join("\n");
}

function setBriefingContent(elementId, markdownText) {
  const el = $(elementId);
  if (!el) return;
  if (!markdownText) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = renderMarkdownToHtml(markdownText);
}

async function loadSettings() {
  const saved = await chrome.storage.local.get([
    "meetmind_api_url", "meetmind_api_token", "meetmind_transcript", "meetmind_mode",
    "meetmind_recording", "meetmind_recording_status", "meetmind_recording_title",
    "meetmind_last_markdown", "meetmind_last_analysis_mode", "meetmind_sessions",
    "meetmind_active_session_id", "meetmind_has_recorded_audio"
  ]);
  $("apiUrl").value = saved.meetmind_api_url || "http://localhost:8000";
  $("apiToken").value = saved.meetmind_api_token || "";
  $("transcript").value = saved.meetmind_transcript || "";
  $("mode").value = saved.meetmind_mode || "meeting";
  recording = Boolean(saved.meetmind_recording);
  activeSessionId = saved.meetmind_active_session_id || null;
  savedSessions = Array.isArray(saved.meetmind_sessions) ? saved.meetmind_sessions : [];
  renderSessions();
  renderRecordingState(saved.meetmind_recording_status, saved.meetmind_recording_title);
  updateAudioRecoveryUI(saved.meetmind_has_recorded_audio);
  latestMarkdown = saved.meetmind_last_markdown || "";
  if (latestMarkdown) {
    setBriefingContent("output", latestMarkdown);
    $("results").hidden = false;
  }
}
function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", isError);
}
function renderRecordingState(status, title) {
  $("record").textContent = recording ? "Stop recording" : "Start recording";
  $("record").classList.toggle("recording", recording);
  $("recordDot").classList.toggle("active", recording);
  $("recordTitle").textContent = recording ? "Recording in progress" : (title || "Ready to capture");
  $("recordStatus").textContent = status || (recording ? "Audio capture is active. Click Stop when finished." : "Records audio from the active browser tab only.");
  updateAudioRecoveryUI();
}
async function saveDraft() {
  await chrome.storage.local.set({
    meetmind_api_url: $("apiUrl").value.trim(),
    meetmind_api_token: $("apiToken").value,
    meetmind_transcript: $("transcript").value,
    meetmind_mode: $("mode").value
  });
}
function renderSessions() {
  const select = $("sessionSelect");
  const previous = select.value;
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = savedSessions.length ? "Choose a saved meeting/interview" : "No saved sessions yet";
  select.appendChild(placeholder);
  for (const session of savedSessions) {
    const option = document.createElement("option");
    option.value = session.id;
    const date = session.createdAt ? new Date(session.createdAt).toLocaleString() : "Undated";
    option.textContent = `${session.title || "Session"} — ${date}`;
    select.appendChild(option);
  }
  if (savedSessions.some(session => session.id === previous)) select.value = previous;
}
async function refreshSessions() {
  const saved = await chrome.storage.local.get(["meetmind_sessions"]);
  savedSessions = Array.isArray(saved.meetmind_sessions) ? saved.meetmind_sessions : [];
  renderSessions();
}
async function persistCurrentSession(markdown = latestMarkdown) {
  const saved = await chrome.storage.local.get([
    "meetmind_sessions", "meetmind_active_session_id", "meetmind_recording_title", "meetmind_recording_started_at"
  ]);
  const sessions = Array.isArray(saved.meetmind_sessions) ? saved.meetmind_sessions : [];
  activeSessionId = saved.meetmind_active_session_id || activeSessionId || crypto.randomUUID();
  const existing = sessions.find(item => item.id === activeSessionId);
  const transcript = $("transcript").value.trim();
  if (!transcript) return;
  const session = {
    id: activeSessionId,
    title: saved.meetmind_recording_title || (existing && existing.title) || ($("mode").value === "interview" ? "Interview session" : "Meeting session"),
    mode: $("mode").value,
    transcript,
    markdown: markdown || (existing && existing.markdown) || "",
    createdAt: (existing && existing.createdAt) || saved.meetmind_recording_started_at || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const next = [session, ...sessions.filter(item => item.id !== session.id)].slice(0, 30);
  await chrome.storage.local.set({ meetmind_sessions: next, meetmind_active_session_id: activeSessionId });
  savedSessions = next;
  renderSessions();
}

function apiTokenHeaders() {
  const token = $("apiToken").value.trim();
  return token ? { "X-API-Token": token } : {};
}
async function ensureBackendPermission() {
  const raw = $("apiUrl").value.trim().replace(/\/+$/, "");
  let url;
  try { url = new URL(raw); } catch { throw new Error("Enter a valid backend URL."); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Backend URL must use HTTP or HTTPS.");
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!isLocal && url.protocol !== "https:") throw new Error("Use HTTPS for a non-local backend.");
  const pattern = `${url.protocol}//${url.host}/*`;
  const hasPermission = await chrome.permissions.contains({ origins: [pattern] });
  if (!hasPermission) {
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) throw new Error("Chrome permission was not granted for this backend host.");
  }
  await saveDraft();
  return raw;
}

$("connect").addEventListener("click", async () => {
  try {
    await ensureBackendPermission();
    const base = $("apiUrl").value.trim().replace(/\/+$/, "");
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Health check failed (${response.status}).`);
    const status = await response.json();
    if (status.auth_enabled && !$("apiToken").value.trim()) {
      setStatus("Backend is reachable, but it requires an API token. Paste the API_TOKEN value.", true);
      return;
    }
    const authResponse = await fetch(`${base}/api/auth-check`, {
      headers: apiTokenHeaders(),
      signal: AbortSignal.timeout(15000)
    });
    if (!authResponse.ok) {
      if (authResponse.status === 401) throw new Error("Backend is reachable, but the API token is missing or incorrect.");
      throw new Error(`Backend authentication check failed (${authResponse.status}).`);
    }
    setStatus(`Connected and authenticated. AI: ${status.ai_provider}/${status.analysis_model}; transcription: ${status.transcription_provider}/${status.transcription_model}.`);
  } catch (error) {
    const msg = error.name === "TimeoutError"
      ? "Connection timed out. Check backend URL and network."
      : error.message;
    setStatus(`${msg} Check backend URL, CORS configuration, and server status.`, true);
  }
});

$("retryTranscribe").addEventListener("click", async () => {
  $("retryTranscribe").disabled = true;
  setStatus("Retrying transcription from saved audio…");
  try {
    await ensureBackendPermission();
    const result = await chrome.runtime.sendMessage({ type: "MEETMIND_RETRY_TRANSCRIPTION" });
    if (!result?.ok) throw new Error(result?.error || "Retry failed.");
    setStatus("Transcription retried successfully. Review transcript below.");
  } catch (error) {
    setStatus(`Retry failed: ${error.message}`, true);
  } finally {
    $("retryTranscribe").disabled = false;
  }
});

$("downloadAudio").addEventListener("click", async () => {
  $("downloadAudio").disabled = true;
  setStatus("Preparing audio download…");
  try {
    const result = await chrome.runtime.sendMessage({ type: "MEETMIND_DOWNLOAD_RECORDING" });
    if (!result?.ok) throw new Error(result?.error || "Download failed.");
    setStatus("Audio download started.");
  } catch (error) {
    setStatus(`Download failed: ${error.message}`, true);
  } finally {
    $("downloadAudio").disabled = false;
  }
});

const SAMPLES = {
  interview: `Interviewer: Explain the difference between a process and a thread.
Candidate: A process has its own memory space. Threads run inside a process and share its memory, but each thread has its own stack.
Interviewer: What can go wrong when two threads update the same counter?
Candidate: A race condition. The updates can overlap and one update may be lost. A mutex or another synchronization mechanism can protect the critical section.
Interviewer: What is the trade-off of using a mutex everywhere?
Candidate: It can add contention and reduce concurrency. I would lock only the shared state that needs protection and keep the critical section small.
Interviewer: Can you explain deadlock conditions?
Candidate: I remember circular wait and hold-and-wait, but I cannot confidently name all four conditions right now.`,
  meeting: `Facilitator: We need to ship the onboarding page by Friday. Priya will update the copy by Wednesday afternoon. Omar will fix the mobile layout and share a preview tomorrow. We agreed to remove the optional profile step from the first release. We still need to decide whether analytics will be enabled at launch. I will schedule a ten-minute check-in on Thursday. No one has volunteered to own the analytics decision yet.`
};

$("record").addEventListener("click", async () => {
  $("record").disabled = true;
  try {
    if (!recording) {
      await ensureBackendPermission();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await chrome.runtime.sendMessage({
        type: "MEETMIND_START_RECORDING",
        targetTabId: tab?.id,
        targetTabTitle: tab?.title || "Meeting"
      });
      if (!result?.ok) throw new Error(result?.error || "Could not start recording.");
      recording = true;
      renderRecordingState("Recording tab audio. Click Stop when finished.");
      setStatus("Recording started. Capturing browser audio from active tab.");
    } else {
      const result = await chrome.runtime.sendMessage({ type: "MEETMIND_STOP_RECORDING" });
      if (!result?.ok) throw new Error(result?.error || "Could not stop recording.");
      recording = false;
      renderRecordingState("Stopping capture and transcribing…");
      setStatus("Recording stopped. Uploading to Whisper for transcription…");
    }
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    $("record").disabled = false;
  }
});

$("capture").addEventListener("click", async () => {
  setStatus("Looking for captions on the active Meet tab…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith("https://meet.google.com/")) {
      setStatus("Open an active Google Meet call (meet.google.com) first.", true);
      return;
    }

    let result;
    try {
      result = await chrome.tabs.sendMessage(tab.id, { type: "MEETMIND_GET_CAPTIONS" });
    } catch (msgErr) {
      // If connection was lost or script not injected yet, dynamically inject content script
      if (chrome.scripting) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content.js"]
        });
        await new Promise(r => setTimeout(r, 150));
        result = await chrome.tabs.sendMessage(tab.id, { type: "MEETMIND_GET_CAPTIONS" });
      } else {
        throw msgErr;
      }
    }

    const transcript = result?.transcript || "";
    if (!transcript.trim()) {
      if (result?.captionsOn === false) {
        setStatus("Google Meet captions are OFF. Press 'c' or click [CC] in Google Meet to turn them on.", true);
      } else {
        setStatus("No captions detected yet. Turn on captions (CC in Meet) and speak to generate captions.", true);
      }
      return;
    }
    $("transcript").value = transcript;
    await saveDraft();
    const count = transcript.split("\n").filter(Boolean).length;
    setStatus(`Loaded ${count} caption line${count === 1 ? "" : "s"}. Review before generating briefing.`);
  } catch (err) {
    setStatus("Could not read captions. Make sure you are in Google Meet, turn on captions (CC), and reload the Meet tab if needed.", true);
  }
});

if ($("loadSample")) {
  $("loadSample").addEventListener("click", async () => {
    const mode = $("mode").value;
    const text = SAMPLES[mode] || SAMPLES.meeting;
    $("transcript").value = text;
    await saveDraft();
    setStatus(`Loaded sample ${mode} transcript. Click "Generate briefing" to test or submit right away!`);
  });
}

$("clear").addEventListener("click", async () => {
  if (recording) { setStatus("Stop recording before clearing the transcript.", true); return; }
  $("transcript").value = "";
  setBriefingContent("output", "");
  $("results").hidden = true;
  latestMarkdown = "";
  activeSessionId = null;
  if ($("audioRecoveryRow")) $("audioRecoveryRow").hidden = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && tab.url?.startsWith("https://meet.google.com/")) {
      await chrome.tabs.sendMessage(tab.id, { type: "MEETMIND_CLEAR_CAPTIONS" }).catch(() => {});
    }
  } catch (_) {}
  await chrome.storage.local.set({
    meetmind_transcript: "",
    meetmind_last_markdown: "",
    meetmind_active_session_id: "",
    meetmind_has_recorded_audio: false,
    meetmind_live_transcript: ""
  });
  setStatus("Current transcript and briefing cleared. Saved sessions remain until you delete them.");
});

$("analyze").addEventListener("click", async () => {
  const transcript = $("transcript").value.trim();
  if (transcript.length < 30) { setStatus("Add a longer transcript before analysis.", true); return; }
  $("analyze").disabled = true;
  setStatus("Analyzing transcript…");
  try {
    const apiUrl = await ensureBackendPermission();
    const response = await fetch(`${apiUrl}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiTokenHeaders() },
      body: JSON.stringify({ transcript, mode: $("mode").value }),
      signal: AbortSignal.timeout(120000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`);
    latestMarkdown = data.markdown || "No briefing returned.";
    setBriefingContent("output", latestMarkdown);
    $("results").hidden = false;
    await chrome.storage.local.set({
      meetmind_last_markdown: latestMarkdown,
      meetmind_last_analysis_mode: $("mode").value,
      meetmind_last_analyzed_at: new Date().toISOString()
    });
    await persistCurrentSession(latestMarkdown);
    setStatus(`Briefing ready using ${data.provider}/${data.model}. Session saved locally in this browser.`);
  } catch (error) {
    const msg = error.name === "TimeoutError"
      ? "Analysis request timed out after 120 seconds. Try a shorter transcript or faster model."
      : error.message;
    setStatus(`${msg} Check the backend URL, token, permissions, and deployment logs.`, true);
  } finally {
    $("analyze").disabled = false;
  }
});

$("download").addEventListener("click", () => {
  if (!latestMarkdown) { setStatus("Generate a briefing first.", true); return; }
  const blob = new Blob([latestMarkdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `meetmind-${$("mode").value}-brief.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("loadSession").addEventListener("click", async () => {
  const session = savedSessions.find(item => item.id === $("sessionSelect").value);
  if (!session) { setStatus("Choose a saved session first.", true); return; }
  activeSessionId = session.id;
  $("transcript").value = session.transcript || "";
  $("mode").value = session.mode || "meeting";
  latestMarkdown = session.markdown || "";
  setBriefingContent("output", latestMarkdown);
  $("results").hidden = !latestMarkdown;
  await chrome.storage.local.set({
    meetmind_active_session_id: activeSessionId,
    meetmind_transcript: $("transcript").value,
    meetmind_mode: $("mode").value,
    meetmind_last_markdown: latestMarkdown
  });
  setStatus("Loaded saved session. Review the transcript before asking or re-analyzing.");
});

$("deleteSession").addEventListener("click", async () => {
  const id = $("sessionSelect").value;
  if (!id) { setStatus("Choose a saved session to delete.", true); return; }
  savedSessions = savedSessions.filter(session => session.id !== id);
  await chrome.storage.local.set({ meetmind_sessions: savedSessions });
  if (activeSessionId === id) {
    activeSessionId = null;
    await chrome.storage.local.remove("meetmind_active_session_id");
  }
  renderSessions();
  setStatus("Saved session deleted from this browser.");
});

$("askButton").addEventListener("click", async () => {
  const question = $("askQuestion").value.trim();
  if (question.length < 3) { setStatus("Enter a specific question first.", true); return; }
  const currentTranscript = $("transcript").value.trim();
  const sessions = [...savedSessions];
  if (currentTranscript && !sessions.some(session => session.transcript === currentTranscript)) {
    sessions.unshift({
      id: activeSessionId || "current-unsaved",
      title: "Current transcript (unsaved)",
      createdAt: new Date().toISOString(),
      transcript: currentTranscript
    });
  }
  const selectedSessions = sessions.slice(0, 20).filter(session => (session.transcript || "").trim().length >= 10);
  if (!selectedSessions.length) { setStatus("Save a session or load/paste a transcript first.", true); return; }
  $("askButton").disabled = true;
  $("askOutput").hidden = false;
  $("askOutput").innerHTML = '<div class="searching-state">Searching relevant transcript excerpts…</div>';
  setStatus("Finding evidence across saved sessions…");
  try {
    const apiUrl = await ensureBackendPermission();
    const response = await fetch(`${apiUrl}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiTokenHeaders() },
      body: JSON.stringify({
        question,
        sessions: selectedSessions.map(session => ({
          session_id: String(session.id),
          title: String(session.title || "Session"),
          created_at: String(session.createdAt || ""),
          transcript: String(session.transcript || "")
        }))
      }),
      signal: AbortSignal.timeout(120000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`);
    const sources = (data.sources || []).map(source => `

[${source.source_id}] ${source.title}${source.created_at ? ` (${source.created_at})` : ""}
> ${source.excerpt}`).join("");
    const formattedAnswer = `${data.answer || "No answer returned."}${sources ? `

---
### Sources used${sources}` : ""}`;
    setBriefingContent("askOutput", formattedAnswer);
    setStatus(`Answer ready using ${data.provider}/${data.model}. Check the cited excerpts before relying on it.`);
  } catch (error) {
    setBriefingContent("askOutput", "");
    $("askOutput").hidden = true;
    const msg = error.name === "TimeoutError"
      ? "Q&A search timed out after 120 seconds. Try asking about fewer sessions."
      : error.message;
    setStatus(`${msg} Check backend URL, token, and server status.`, true);
  } finally {
    $("askButton").disabled = false;
  }
});

$("transcript").addEventListener("input", saveDraft);
$("apiUrl").addEventListener("change", saveDraft);
$("apiToken").addEventListener("change", saveDraft);
$("mode").addEventListener("change", saveDraft);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.meetmind_transcript && !$('transcript').matches(":focus")) {
    $("transcript").value = changes.meetmind_transcript.newValue || "";
  }
  if (changes.meetmind_recording) {
    recording = Boolean(changes.meetmind_recording.newValue);
    updateAudioRecoveryUI();
  }
  if (changes.meetmind_has_recorded_audio) {
    updateAudioRecoveryUI(changes.meetmind_has_recorded_audio.newValue);
  }
  if (changes.meetmind_recording_status || changes.meetmind_recording_title || changes.meetmind_recording) {
    chrome.storage.local.get(["meetmind_recording_status", "meetmind_recording_title"]).then(s => {
      renderRecordingState(s.meetmind_recording_status, s.meetmind_recording_title);
    });
  }
  if (changes.meetmind_sessions) {
    savedSessions = Array.isArray(changes.meetmind_sessions.newValue) ? changes.meetmind_sessions.newValue : [];
    renderSessions();
  }
});
loadSettings();
