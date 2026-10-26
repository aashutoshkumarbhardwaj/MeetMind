# MeetMind — Meeting Memory & Interview Coach

MeetMind turns a browser-tab recording or Google Meet captions into a reviewable transcript, then creates either a meeting brief or an evidence-based post-interview review. This starter integrates proven patterns from three public projects without copying their code: tab recording/offscreen processing, a caption fallback, and a clear recorder → API → transcript → analysis pipeline.

## What is implemented

- Chrome Manifest V3 extension with explicit Start/Stop tab recording using `tabCapture`, an offscreen document, and `MediaRecorder`.
- Transcription retry and audio download backup: recorded audio is preserved if transcription fails, allowing retries or local `.webm` download without losing the recording.
- Best-effort Google Meet visible-caption capture as a fallback with mutation throttling and graceful degradation. Meet's DOM is not a stable public API; pasted transcript remains the guaranteed fallback.
- Provider-selectable transcription: Groq-hosted Whisper-compatible transcription, or local `faster-whisper`.
- Provider-selectable analysis: Groq-hosted `openai/gpt-oss-120b`, or OpenAI-compatible local/self-hosted Ollama (default example `qwen2.5:7b`).
- Interview Coach and Meeting Memory prompts with strict separation between `[Direct Evidence]`, `[AI Inference / Analysis]`, and `[Insufficient Evidence in Transcript]`.
- In-memory sliding-window rate limiting per client IP to protect upstream provider quotas and prevent DoS.
- Dual authentication support: accepts `X-API-Token` or standard `Authorization: Bearer <token>`.
- Structured logging with request IDs, response durations, and automatic secret redaction.
- Transcript editing, local extension draft persistence, local saved-session history (up to 30), last briefing persistence, and Markdown export.
- Q&A across recent saved transcripts using deterministic local keyword retrieval, with returned source excerpts and `[S1]`-style citations. No vector database or remote embedding service is required for this first version.
- Optional API token shared between the self-hosted extension and backend; mandatory at startup when `APP_ENV=production`.
- Health endpoint and environment configuration for Render.
- Stateless by design: the API handles a request and returns its result without persisting transcripts or audio on the server. Audio and transcripts are only sent to the chosen provider (Groq over HTTPS, or processed locally on the host machine).

## What it is not yet

This is a production-oriented foundation, not a fully audited public SaaS. It has not been live-tested across real meetings/browser versions in this workspace. It does not yet provide multi-user identity, per-user API credentials, persistent server-side meeting history, a durable job queue, provider-level cost controls, speaker diarization, automated retention controls for third-party providers, or full end-to-end monitoring. Session history currently lives locally in Chrome storage and Q&A performs keyword-based retrieval rather than semantic/vector retrieval. Do not expose a shared single-user `API_TOKEN` as a multi-user authentication system.

## Architecture

```text
Chrome MV3 extension
  ├─ Tab audio recording (explicit user action)
  ├─ Google Meet caption fallback (best-effort)
  └─ Editable transcript / local draft + briefing
          │ HTTPS + optional X-API-Token
          ▼
FastAPI API
  ├─ Transcription adapter: Groq OR local faster-whisper
  └─ Analysis adapter: Groq OR Ollama
          │
          ▼
Evidence-grounded Meeting Brief / Interview Review
```

### Privacy modes

| Configuration | Audio processing | Transcript analysis | Network dependency |
|---|---|---|---|
| `TRANSCRIPTION_PROVIDER=groq`, `AI_PROVIDER=groq` | Sent to Groq over HTTPS | Sent to Groq over HTTPS | Internet + Groq API key |
| `TRANSCRIPTION_PROVIDER=local`, `AI_PROVIDER=ollama` | Local `faster-whisper` on the backend host | Ollama endpoint configured by you | Can work offline after models are downloaded, if the endpoint is local and model is available |
| Mixed configuration | Determined by transcription setting | Determined by AI setting | Depends on selected providers |

Local mode means the model runs on the machine hosting the backend. If you deploy only the API to Render and select Ollama at `localhost`, that means Render's own localhost, not your laptop. For local inference on your laptop, run the backend locally and point the extension at `http://localhost:8000`. Audio still leaves the device if you choose hosted transcription.

## 1. Local setup: hosted Groq providers

Python 3.10+ recommended.

```bash
cd backend
python -m venv .venv
# macOS/Linux
source .venv/bin/activate
# Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
cp .env.example .env
```

Edit `.env` and set `GROQ_API_KEY`. Local development defaults to no API token. Start the API:

```bash
uvicorn main:app --reload --port 8000
```

Check `http://localhost:8000/health`. The `/docs` page is enabled in development only.

## 2. Local-only AI option

Install Ollama and pull a model supported by your machine, for example:

```bash
ollama pull qwen2.5:7b
```

Configure in `backend/.env`:

```env
APP_ENV=development
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_CHAT_MODEL=qwen2.5:7b
TRANSCRIPTION_PROVIDER=local
WHISPER_MODEL=small
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8
```

Install optional local transcription dependencies:

```bash
pip install -r requirements-local.txt
```

The first local Whisper run downloads the selected model. In local mode, the audio is processed by the backend machine; Ollama analysis is sent to the configured Ollama endpoint. Check model and memory requirements before choosing larger models.

## 3. Load and configure the Chrome extension

1. Open `chrome://extensions` in Chrome or a Chromium browser that supports Manifest V3.
2. Enable Developer mode, click **Load unpacked**, and select the `extension/` folder.
3. Open a normal HTTPS site or a Google Meet tab. Chrome blocks audio capture on restricted internal pages.
4. In the extension, set Backend URL and click **Connect backend and grant access**. Chrome will ask for host permission when needed.
5. If the backend uses `API_TOKEN`, enter the same value in Backend API token.
6. Start recording with an explicit click, then stop. Review/edit the transcript before generating a briefing.
7. Alternatively, enable Google Meet captions and use **Load Meet captions**, or paste a transcript manually.

The current recorder captures tab audio only; it does not include your microphone. Tab capture generally includes remote participants' audio, not your own mic. Consent should be obtained before recording, and company/interview rules must be followed.

## 4. Deploy the API to Render

1. Push this project to a GitHub repository.
2. Create a Render Blueprint from `render.yaml` or create a Python web service using `backend` as the root directory.
3. Set `API_TOKEN` to a long random secret. Set `GROQ_API_KEY` if using Groq for either provider. Do not commit either secret.
4. Deploy and check `/health`.
5. Paste the Render service URL in the extension and click Connect. Enter the same API token in the extension.

The included Render configuration defaults to hosted Groq transcription and analysis. Running Ollama locally on your laptop is not possible by setting `OLLAMA_BASE_URL=localhost` on Render; use the local backend for laptop inference, or configure an intentionally reachable secured inference service.

## API endpoints

- `GET /health` — non-secret runtime/provider status; liveness endpoint.
- `POST /api/transcribe` — multipart audio upload; requires `X-API-Token` when configured.
- `POST /api/analyze` — transcript and mode (`meeting` or `interview`); requires `X-API-Token` when configured.
- `POST /api/ask` — a question plus locally saved session transcripts; returns a grounded answer and the excerpts sent to the model; requires `X-API-Token` when configured.

Limits: transcripts up to 120,000 characters, audio uploads up to 24 MiB. The backend does not persist audio or transcript data. Provider terms and retention policies still apply when hosted inference is selected.

## Tests

Install the test dependencies and run the API validation/retrieval tests:

```bash
pip install -r requirements-dev.txt
pytest -q
```

These are automated unit/API contract tests, not a substitute for live-provider or real-browser end-to-end tests.

## Before public release

- Add real user authentication (OIDC/Auth0 or equivalent), per-user authorization, and user-specific provider credential storage; do not share one `API_TOKEN` across public users.
- Add distributed rate limiting, quotas, request tracing, cost budgets, and alerts at the API gateway/provider layer.
- Decide on persistent history and implement a database plus deletion/export/retention policies if needed.
- Add a durable job queue for long recordings, status polling, resumable uploads, idempotency, and retries.
- Add automated provider contract tests and browser E2E tests, then test real Meet/Zoom/Teams versions.
- Add speaker diarization only with a tested provider/model and UI that exposes attribution confidence.
- Review privacy/consent copy, dependency licenses, and all third-party provider data handling.

## Open-source project references

- [TabScribe](https://github.com/danielsemerjya/tabscribe) — MIT; recording/offscreen extension design reference.
- [TranscripTonic](https://github.com/vivek-nexus/transcriptonic) — MIT; caption-based transcript fallback reference.
- [Cognium Meet](https://github.com/cogniumhq/cognium-meet) — API/history/Ask architecture reference only; a root license file was not found during review.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for review notes. This starter does not bundle their code.
