let mediaRecorder = null;
let chunks = [];
let activeStream = null;
let activeTabTitle = "Meeting";
let lastRecordedAudio = null;
let configuredApiUrl = "http://localhost:8000";
let configuredApiToken = "";

function notifyStatus(status) {
  return chrome.runtime.sendMessage({
    type: "MEETMIND_OFFSCREEN_STATUS",
    status
  }).catch(() => {});
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("MeetMindAudioDB", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("recordings")) {
        db.createObjectStore("recordings", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveAudioBlob(blob, mimeType, title) {
  try {
    const db = await openDB();
    const tx = db.transaction("recordings", "readwrite");
    tx.objectStore("recordings").put({
      id: "latest",
      blob,
      mimeType,
      title,
      updatedAt: Date.now()
    });
    return new Promise(resolve => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

async function getStoredAudio() {
  if (lastRecordedAudio?.blob) return lastRecordedAudio;
  try {
    const db = await openDB();
    const tx = db.transaction("recordings", "readonly");
    const req = tx.objectStore("recordings").get("latest");
    return new Promise(resolve => {
      req.onsuccess = () => {
        if (req.result?.blob) {
          lastRecordedAudio = {
            blob: req.result.blob,
            mimeType: req.result.mimeType,
            title: req.result.title
          };
          resolve(lastRecordedAudio);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "MEETMIND_OFFSCREEN_START") {
    if (message.apiUrl) configuredApiUrl = message.apiUrl;
    if (typeof message.apiToken === "string") configuredApiToken = message.apiToken;
    startRecording(message.streamId, message.tabTitle || "Meeting")
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error?.message || "Capture failed." }));
    return true;
  }
  if (message?.type === "MEETMIND_OFFSCREEN_STOP") {
    stopRecording()
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error?.message || "Stop failed." }));
    return true;
  }
  if (message?.type === "MEETMIND_OFFSCREEN_RETRY") {
    if (message.apiUrl) configuredApiUrl = message.apiUrl;
    if (typeof message.apiToken === "string") configuredApiToken = message.apiToken;
    retryUpload()
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error?.message || "Retry failed." }));
    return true;
  }
  if (message?.type === "MEETMIND_OFFSCREEN_DOWNLOAD") {
    downloadAudio()
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error?.message || "Download failed." }));
    return true;
  }
});

async function startRecording(streamId, title) {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    throw new Error("A recording is already running.");
  }
  activeTabTitle = title;
  chunks = [];
  activeStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  // Keep captured tab audio audible to the user.
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(activeStream);
  source.connect(audioContext.destination);
  window.meetmindAudioContext = audioContext;

  const preferred = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  mediaRecorder = new MediaRecorder(activeStream, { mimeType: preferred });
  mediaRecorder.addEventListener("dataavailable", event => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  });
  mediaRecorder.addEventListener("stop", async () => {
    const blob = new Blob(chunks, { type: preferred });
    chunks = [];
    lastRecordedAudio = { blob, mimeType: preferred, title: activeTabTitle };
    await saveAudioBlob(blob, preferred, activeTabTitle);

    uploadRecording(lastRecordedAudio).catch(async error => {
      await notifyStatus({
        meetmind_recording: false,
        meetmind_has_recorded_audio: true,
        meetmind_recording_status: `Transcription failed: ${error?.message || "Upload error"}. You can retry or download the recording.`,
        meetmind_recording_error: error?.message || "Upload error"
      });
      await chrome.runtime.sendMessage({
        type: "MEETMIND_RECORDING_FINISHED",
        error: error?.message || "Upload or transcription failed."
      });
    });
  });
  mediaRecorder.start(1000);
}

async function stopRecording() {
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
  } catch (_) {}
  mediaRecorder = null;

  if (activeStream) {
    try {
      activeStream.getTracks().forEach(track => {
        track.stop();
        track.enabled = false;
      });
    } catch (_) {}
    activeStream = null;
  }

  if (window.meetmindAudioContext) {
    try {
      await window.meetmindAudioContext.close();
    } catch (_) {}
    window.meetmindAudioContext = null;
  }
}

async function retryUpload() {
  const audio = await getStoredAudio();
  if (!audio?.blob) {
    throw new Error("No recorded audio available to retry. Complete a tab recording first.");
  }
  return uploadRecording(audio);
}

async function downloadAudio() {
  const audio = await getStoredAudio();
  if (!audio?.blob) {
    throw new Error("No recorded audio available to download. Complete a tab recording first.");
  }
  const url = URL.createObjectURL(audio.blob);
  const a = document.createElement("a");
  a.href = url;
  const safeTitle = (audio.title || "meeting").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  a.download = `meetmind-${safeTitle}.webm`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function uploadRecording(audioRecord) {
  const blob = audioRecord.blob;
  const title = audioRecord.title || "Meeting";
  if (blob.size < 1024) throw new Error("Recording is too short or contains no tab audio.");
  if (blob.size > 24 * 1024 * 1024) {
    throw new Error("Recording exceeds the 24 MB upload limit. Try a shorter meeting.");
  }

  const apiUrl = (configuredApiUrl || "http://localhost:8000").replace(/\/+$/, "");
  const form = new FormData();
  form.append("audio", blob, "meetmind-recording.webm");
  form.append("title", title);

  await notifyStatus({
    meetmind_recording_status: "Uploading audio for transcription…",
    meetmind_has_recorded_audio: true
  });
  const headers = configuredApiToken ? { "X-API-Token": configuredApiToken } : {};

  // Request timeout after 180 seconds
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 180000);

  try {
    const response = await fetch(`${apiUrl}/api/transcribe`, {
      method: "POST",
      headers,
      body: form,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Transcription failed (${response.status}).`);
    if (!data.transcript?.trim()) throw new Error("The transcription service returned an empty transcript.");

    await chrome.runtime.sendMessage({
      type: "MEETMIND_RECORDING_FINISHED",
      transcript: data.transcript,
      title
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      throw new Error("Transcription request timed out after 180 seconds. Try a shorter recording.");
    }
    throw error;
  }
}