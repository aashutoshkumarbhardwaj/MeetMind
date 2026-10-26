const OFFSCREEN_PATH = "offscreen/offscreen.html";

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA", "BLOBS"],
    justification: "Capture audio from the active browser tab after the user explicitly starts recording."
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "MEETMIND_START_RECORDING") {
    (async () => {
        let tabId = message.targetTabId;
        let tabTitle = message.targetTabTitle;
        if (!tabId) {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          tabId = tab?.id;
          tabTitle = tab?.title;
        }
        if (!tabId) throw new Error("No active tab found. Please switch to your Google Meet tab.");
        await ensureOffscreenDocument();
        let streamId;
        try {
          streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
        } catch (captureErr) {
          if (captureErr.message && captureErr.message.includes("active stream")) {
            // Force reset any lingering offscreen stream and recreate offscreen document
            await chrome.runtime.sendMessage({ type: "MEETMIND_OFFSCREEN_STOP" }).catch(() => {});
            try { await chrome.offscreen.closeDocument(); } catch (_) {}
            await new Promise(r => setTimeout(r, 350));
            await ensureOffscreenDocument();
            try {
              streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
            } catch (secondErr) {
              throw new Error("Chrome tab audio is locked by an earlier stream. Please reload your Google Meet tab (Cmd+R / F5) to unlock capture.");
            }
          } else {
            throw captureErr;
          }
        }
        const settings = await chrome.storage.local.get(["meetmind_api_url", "meetmind_api_token"]);
        await chrome.runtime.sendMessage({
          type: "MEETMIND_OFFSCREEN_START",
          streamId,
          tabTitle: tabTitle || "Meeting",
          apiUrl: settings.meetmind_api_url,
          apiToken: settings.meetmind_api_token
        });
        await chrome.storage.local.set({
          meetmind_recording: true,
          meetmind_recording_title: tabTitle || "Meeting",
          meetmind_recording_started_at: new Date().toISOString(),
          meetmind_active_session_id: crypto.randomUUID(),
          meetmind_recording_status: "Recording browser tab audio…"
        });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || "Could not start recording." });
      }
    })();
    return true;
  }

  if (message?.type === "MEETMIND_STOP_RECORDING") {
    (async () => {
      try {
        await chrome.runtime.sendMessage({ type: "MEETMIND_OFFSCREEN_STOP" });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || "Could not stop recording." });
      }
    })();
    return true;
  }

  if (message?.type === "MEETMIND_RETRY_TRANSCRIPTION") {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const settings = await chrome.storage.local.get(["meetmind_api_url", "meetmind_api_token"]);
        const resp = await chrome.runtime.sendMessage({
          type: "MEETMIND_OFFSCREEN_RETRY",
          apiUrl: settings.meetmind_api_url,
          apiToken: settings.meetmind_api_token
        });
        sendResponse(resp || { ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || "Could not retry transcription." });
      }
    })();
    return true;
  }

  if (message?.type === "MEETMIND_DOWNLOAD_RECORDING") {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const resp = await chrome.runtime.sendMessage({ type: "MEETMIND_OFFSCREEN_DOWNLOAD" });
        sendResponse(resp || { ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || "Could not download recording." });
      }
    })();
    return true;
  }

  if (message?.type === "MEETMIND_OFFSCREEN_STATUS") {
    chrome.storage.local.set(message.status || {});
  }

  if (message?.type === "MEETMIND_RECORDING_FINISHED") {
    chrome.storage.local.set({
      meetmind_recording: false,
      meetmind_has_recorded_audio: true,
      meetmind_recording_status: message.error
        ? `Transcription failed: ${message.error}`
        : "Transcription ready. Review it before analysis.",
      ...(message.transcript ? { meetmind_transcript: message.transcript } : {}),
      ...(message.title ? { meetmind_recording_title: message.title } : {}),
      meetmind_last_transcribed_at: new Date().toISOString()
    });
    // Immediately release offscreen document and all associated tab audio streams
    chrome.offscreen.closeDocument().catch(() => {});
  }
});