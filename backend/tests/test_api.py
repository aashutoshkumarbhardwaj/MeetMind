import httpx
import pytest
from fastapi.testclient import TestClient

import main


@pytest.fixture(autouse=True)
def reset_rate_limiter_and_keys(monkeypatch):
    main.rate_limiter.reset()
    # By default, mock out live external Backboard calls in unit tests for speed and isolation
    monkeypatch.setattr(main, "BACKBOARD_API_KEY", "")
    yield
    main.rate_limiter.reset()


@pytest.fixture()
def client():
    return TestClient(main.app)


def test_health_does_not_expose_secrets(client):
    response = client.get("/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert "GROQ_API_KEY" not in payload
    assert "API_TOKEN" not in payload
    assert "BACKBOARD_API_KEY" not in payload
    assert "ai_provider" in payload
    assert "transcription_provider" in payload


def test_analyze_rejects_short_transcript(client):
    response = client.post("/api/analyze", json={"transcript": "too short", "mode": "meeting"})
    assert response.status_code == 422


def test_analyze_success(client, monkeypatch):
    async def fake_model(system, prompt):
        assert "Evidence and safety rules" in prompt
        return "# Meeting Brief\n- Decision 1", "test-provider", "test-model"

    monkeypatch.setattr(main, "call_analysis_model", fake_model)
    response = client.post(
        "/api/analyze",
        json={"transcript": "This is a valid meeting transcript that is long enough to meet the thirty character limit.", "mode": "meeting"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["markdown"] == "# Meeting Brief\n- Decision 1"
    assert body["provider"] == "test-provider"
    assert body["model"] == "test-model"


def test_transcribe_rejects_unsupported_file(client):
    response = client.post(
        "/api/transcribe",
        files={"audio": ("capture.exe", b"not audio", "application/octet-stream")},
    )
    assert response.status_code == 400
    assert "Unsupported audio filename" in response.json()["detail"]


def test_transcribe_rejects_empty_file(client):
    response = client.post(
        "/api/transcribe",
        files={"audio": ("empty.webm", b"", "audio/webm")},
    )
    assert response.status_code == 400
    assert "empty" in response.json()["detail"].lower()


def test_transcribe_rejects_oversized_audio(client, monkeypatch):
    monkeypatch.setattr(main, "MAX_AUDIO_BYTES", 100)
    response = client.post(
        "/api/transcribe",
        files={"audio": ("big.webm", b"x" * 150, "audio/webm")},
    )
    assert response.status_code == 413
    assert "24 MB" in response.json()["detail"] or "upload limit" in response.json()["detail"].lower()


def test_token_is_required_when_configured(monkeypatch):
    monkeypatch.setattr(main, "API_TOKEN", "unit-test-secret")
    with pytest.raises(main.HTTPException) as exc:
        main.require_api_token(None)
    assert exc.value.status_code == 401
    main.require_api_token("unit-test-secret")
    # Verify Bearer token format also works
    main.require_api_token(None, authorization="Bearer unit-test-secret")


def test_bearer_token_authorization(monkeypatch):
    monkeypatch.setattr(main, "API_TOKEN", "bearer-test-token")
    client = TestClient(main.app)
    assert client.get("/api/auth-check", headers={"Authorization": "Bearer wrong-token"}).status_code == 401
    assert client.get("/api/auth-check", headers={"Authorization": "Bearer bearer-test-token"}).status_code == 200


def test_rate_limiter():
    limiter = main.InMemoryRateLimiter()
    # Check limit of 3 requests in a 60-second window
    allowed1, _ = limiter.check("client1", max_requests=3)
    allowed2, _ = limiter.check("client1", max_requests=3)
    allowed3, _ = limiter.check("client1", max_requests=3)
    allowed4, retry_after = limiter.check("client1", max_requests=3)

    assert allowed1 is True
    assert allowed2 is True
    assert allowed3 is True
    assert allowed4 is False
    assert retry_after > 0

    # Separate client key should not be throttled
    allowed_other, _ = limiter.check("client2", max_requests=3)
    assert allowed_other is True


def test_rate_limit_middleware_returns_429(client, monkeypatch):
    monkeypatch.setattr(main, "ANALYSIS_RATE_LIMIT_PER_MINUTE", 2)
    async def fake_model(_sys, _prompt):
        return "briefing", "provider", "model"
    monkeypatch.setattr(main, "call_analysis_model", fake_model)

    req = {"transcript": "A valid transcript meeting minimum character threshold requirements.", "mode": "meeting"}
    r1 = client.post("/api/analyze", json=req)
    r2 = client.post("/api/analyze", json=req)
    r3 = client.post("/api/analyze", json=req)

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r3.status_code == 429
    assert "Retry-After" in r3.headers


def test_interview_prompt_has_evidence_rules():
    prompt = main.build_prompt("interview", "Interviewer: Explain indexing. Candidate: It makes searches faster.")
    assert "Do not invent quotes" in prompt
    assert "[Direct Evidence]" in prompt
    assert "[AI Inference / Analysis]" in prompt
    assert "[Insufficient Evidence in Transcript]" in prompt
    assert "TRANSCRIPT BEGINS" in prompt


def test_lexical_retrieval_returns_source_citations():
    sessions = [
        main.AskSession(
            session_id="session-1",
            title="SQL interview",
            created_at="2026-10-20T10:00:00Z",
            transcript="The interviewer asked about SQL indexes. I said indexes speed up lookups but use extra storage.",
        ),
        main.AskSession(
            session_id="session-2",
            title="HR chat",
            transcript="We discussed joining dates and team collaboration.",
        ),
    ]
    sources = main.retrieve_relevant_chunks("What did I say about SQL indexes?", sessions)
    assert sources
    assert sources[0].source_id == "S1"
    assert "indexes" in sources[0].excerpt.lower()


def test_ask_returns_retrieved_source_excerpts(client, monkeypatch):
    async def fake_model(_system, _prompt):
        return "You said indexes speed up lookups but use extra storage. [S1]", "test-provider", "test-model"

    monkeypatch.setattr(main, "call_analysis_model", fake_model)
    response = client.post(
        "/api/ask",
        json={
            "question": "What did I say about SQL indexes?",
            "sessions": [
                {
                    "session_id": "s1",
                    "title": "SQL interview",
                    "created_at": "2026-10-20T10:00:00Z",
                    "transcript": "The interviewer asked about SQL indexes. I said indexes speed up lookups but use extra storage.",
                }
            ],
        },
    )
    assert response.status_code == 200
    result = response.json()
    assert "[S1]" in result["answer"]
    assert result["sources"][0]["source_id"] == "S1"
    assert "indexes" in result["sources"][0]["excerpt"].lower()


def test_ask_rejects_oversized_context(client):
    large_sessions = [
        {
            "session_id": f"s{i}",
            "title": f"Meeting {i}",
            "created_at": "2026-10-20",
            "transcript": "x" * 15000,
        }
        for i in range(17)  # 17 * 15,000 = 255,000 chars > 240,000 cap
    ]
    response = client.post(
        "/api/ask",
        json={"question": "What happened?", "sessions": large_sessions},
    )
    assert response.status_code == 413
    assert "too large" in response.json()["detail"].lower()


def test_ollama_url_normalization():
    assert main._normalize_ollama_url("http://localhost:11434") == "http://localhost:11434/v1"
    assert main._normalize_ollama_url("http://localhost:11434/") == "http://localhost:11434/v1"
    assert main._normalize_ollama_url("http://localhost:11434/v1") == "http://localhost:11434/v1"
    assert main._normalize_ollama_url("http://localhost:11434/v1/") == "http://localhost:11434/v1"


@pytest.mark.anyio
async def test_call_analysis_model_handles_timeout(monkeypatch):
    monkeypatch.setattr(main, "AI_PROVIDER", "groq")
    monkeypatch.setattr(main, "GROQ_API_KEY", "dummy-key")

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def post(self, *args, **kwargs):
            raise httpx.TimeoutException("Upstream timed out")

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    with pytest.raises(main.HTTPException) as exc:
        await main.call_analysis_model("system", "prompt")
    assert exc.value.status_code == 504
    assert "timed out" in exc.value.detail


@pytest.mark.anyio
async def test_call_analysis_model_handles_upstream_500(monkeypatch):
    monkeypatch.setattr(main, "AI_PROVIDER", "groq")
    monkeypatch.setattr(main, "GROQ_API_KEY", "dummy-key")

    class FakeResponse:
        status_code = 500
    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def post(self, *args, **kwargs):
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    with pytest.raises(main.HTTPException) as exc:
        await main.call_analysis_model("system", "prompt")
    assert exc.value.status_code == 502
    assert "Analysis provider rejected" in exc.value.detail


def test_cors_chrome_extension_origin(client):
    # Chrome extension origin with 32 characters
    origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    response = client.options(
        "/health",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == origin


@pytest.mark.anyio
async def test_backboard_integration_success(monkeypatch):
    monkeypatch.setattr(main, "BACKBOARD_API_KEY", "test-backboard-key")

    class FakeResponse:
        content = "Executive Summary:\n- Discussed scaling bottlenecks."
        thread_id = "test-thread-123"

    class FakeBackboardClient:
        def __init__(self, api_key):
            assert api_key == "test-backboard-key"
        async def send_message(self, content, memory=None):
            assert memory == "Auto"
            return FakeResponse()

    monkeypatch.setattr("backboard.BackboardClient", FakeBackboardClient)
    content, provider, model = await main.call_analysis_with_fallback("system", "transcript")
    assert "Discussed scaling bottlenecks" in content
    assert provider == "backboard"
    assert model == "backboard-memory-auto"


@pytest.mark.anyio
async def test_backboard_fallback_on_rate_limit_or_error(monkeypatch):
    monkeypatch.setattr(main, "BACKBOARD_API_KEY", "test-backboard-key")

    class FailingBackboardClient:
        def __init__(self, api_key):
            pass
        async def send_message(self, content, memory=None):
            raise Exception("Rate limit exceeded 429")

    async def fake_fallback_model(system, prompt):
        return "Fallback briefing from primary provider", "groq", "openai/gpt-oss-120b"

    monkeypatch.setattr("backboard.BackboardClient", FailingBackboardClient)
    monkeypatch.setattr(main, "call_analysis_model", fake_fallback_model)

    content, provider, model = await main.call_analysis_with_fallback("system", "transcript")
    assert content == "Fallback briefing from primary provider"
    assert provider == "groq"
    assert model == "openai/gpt-oss-120b"

