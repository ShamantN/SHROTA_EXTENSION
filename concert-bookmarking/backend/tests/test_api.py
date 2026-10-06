"""Asynchronous API endpoint integration tests using httpx.AsyncClient."""
import json
import pytest
from httpx import AsyncClient, ASGITransport
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app.main import app
from backend.app.database import Base, get_db
from backend.app.models import Video, Segment, UserTrust
from backend.app.cdn import cdn_manager


from pathlib import Path

# Test Database setup with file-based SQLite supporting multi-thread concurrent connection pooling
TEST_DB_FILE = Path(__file__).resolve().parent / "test_api.db"
TEST_DATABASE_URL = f"sqlite:///{TEST_DB_FILE.as_posix()}"
engine = create_engine(
    TEST_DATABASE_URL,
    connect_args={"check_same_thread": False},
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def override_get_db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(autouse=True)
def setup_test_db():
    Base.metadata.create_all(bind=engine)
    app.dependency_overrides[get_db] = override_get_db
    cdn_manager.clear_purge_history()
    yield
    Base.metadata.drop_all(bind=engine)
    app.dependency_overrides.clear()
    engine.dispose()
    if TEST_DB_FILE.exists():
        try:
            TEST_DB_FILE.unlink()
        except Exception:
            pass


@pytest.mark.asyncio
async def test_get_segments_ready_state_and_cache_headers():
    """Verify ready video returns 200, segments, and required CDN cache headers."""
    # Seed DB with a ready video
    db = TestingSessionLocal()
    video = Video(
        id="live_concert_123",
        title="Ustad Rashid Khan - Live in Concert",
        duration=3600.0,
        status="ready",
        tradition="hindustani",
        version=1,
        is_locked=False,
    )
    db.add(video)
    db.commit()

    seg1 = Segment(
        video_id=video.id,
        label="alaap",
        start_time=0.0,
        end_time=600.0,
        confidence=0.98,
        source="model",
    )
    seg2 = Segment(
        video_id=video.id,
        label="drut_bandish",
        start_time=600.0,
        end_time=1800.0,
        confidence=0.92,
        source="model",
    )
    db.add_all([seg1, seg2])
    db.commit()
    db.close()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/v1/segments/live_concert_123")

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == "public, max-age=86400, s-maxage=604800, stale-while-revalidate=3600"
    assert response.headers.get("Surrogate-Key") == "video-live_concert_123 taxonomy"

    data = response.json()
    assert data["videoId"] == "live_concert_123"
    assert data["status"] == "ready"
    assert data["version"] == 1
    assert data["tradition"] == "hindustani"
    assert len(data["segments"]) == 2
    assert data["segments"][0]["label"] == "alaap"
    assert data["segments"][1]["label"] == "drut_bandish"


@pytest.mark.asyncio
async def test_get_segments_processing_state():
    """Verify processing video returns 202 Accepted with pollAfterSeconds."""
    db = TestingSessionLocal()
    video = Video(id="processing_vid", status="processing")
    db.add(video)
    db.commit()
    db.close()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/v1/segments/processing_vid")

    assert response.status_code == 202
    data = response.json()
    assert data["videoId"] == "processing_vid"
    assert data["status"] == "processing"
    assert data["pollAfterSeconds"] == 10


@pytest.mark.asyncio
async def test_get_segments_rejected_state():
    """Verify rejected video returns 422 Unprocessable Entity."""
    db = TestingSessionLocal()
    video = Video(id="rejected_vid", status="rejected")
    db.add(video)
    db.commit()
    db.close()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/v1/segments/rejected_vid")

    assert response.status_code == 422
    data = response.json()
    assert data["videoId"] == "rejected_vid"
    assert data["status"] == "rejected"
    assert data["reason"] == "classifier_negative"


@pytest.mark.asyncio
async def test_classify_positive_classical_concert():
    """Verify Indian classical concert titles/descriptions classify as processing or ready."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/v1/classify",
            json={
                "videoId": "concert_raag_yaman",
                "title": "Pt. Bhimsen Joshi - Raag Yaman Live Concert",
                "description": "Full Alaap and Vilambit Bandish rendition in Ektaal",
                "channelId": "UCsZ1Q3jB8f8N6rM1K4L5qMw",  # Darbar festival allowlisted
            },
        )

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "processing"
    assert data["tradition"] == "hindustani"
    assert data["confidence"] >= 0.85


@pytest.mark.asyncio
async def test_classify_negative_vlog():
    """Verify vlogs, interviews, or podcasts are rejected."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/v1/classify",
            json={
                "videoId": "vlog_123",
                "title": "My Daily Morning Routine Vlog in Mumbai",
                "description": "Check out my favorite food and morning coffee! Podcast interview next week.",
                "channelId": "UCrandomChannel",
            },
        )

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "rejected"
    assert data["confidence"] < 0.5


@pytest.mark.asyncio
async def test_crowd_submission_and_moderation_lock():
    """Verify crowd edit rules, including moderation lock rejection (403)."""
    db = TestingSessionLocal()
    video = Video(id="locked_vid", status="ready", version=1, is_locked=True)
    user = UserTrust(client_uuid="editor_user", trust_score=0.8)
    db.add_all([video, user])
    db.commit()
    db.close()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Attempt edit on locked video -> 403
        edit_payload = {
            "clientUuid": "editor_user",
            "segments": [
                {"start": 0.0, "end": 120.0, "label": "alaap", "confidence": 0.95},
                {"start": 120.0, "end": 300.0, "label": "jod", "confidence": 0.90},
            ],
        }
        res_locked = await client.post("/v1/segments/locked_vid/edits", json=edit_payload)
        assert res_locked.status_code == 403

        # Unlock video
        res_unlock = await client.post("/v1/videos/locked_vid/lock?locked=false")
        assert res_unlock.status_code == 200

        # Now submit edit with trusted user -> Promoted immediately
        res_edit = await client.post("/v1/segments/locked_vid/edits", json=edit_payload)
        assert res_edit.status_code == 200
        edit_data = res_edit.json()
        assert edit_data["status"] == "promoted_immediately"
        assert edit_data["version"] == 2

    # Verify video was updated
    db = TestingSessionLocal()
    updated_vid = db.query(Video).filter(Video.id == "locked_vid").first()
    assert updated_vid.version == 2
    assert len(updated_vid.segments) == 2
    db.close()


@pytest.mark.asyncio
async def test_voting_endpoint():
    """Verify voting API registers vote and returns updated reputation."""
    # Seed DB with video and revision
    db = TestingSessionLocal()
    video = Video(id="vote_vid", status="ready", version=1)
    db.add(video)
    db.commit()

    author = UserTrust(client_uuid="author_x", trust_score=0.5)
    db.add(author)
    db.commit()

    from backend.app.models import SegmentRevision
    rev = SegmentRevision(
        video_id="vote_vid",
        version=2,
        submitted_by="author_x",
        segments_json=json.dumps([{"start": 0.0, "end": 50.0, "label": "alaap", "confidence": 0.9}]),
        status="active",
    )
    db.add(rev)
    db.commit()
    rev_id = rev.id
    db.close()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            "/v1/segments/vote_vid/vote",
            json={
                "clientUuid": "voter_1",
                "targetRevisionId": rev_id,
                "vote": 1,
            },
        )
        assert res.status_code == 200
        data = res.json()
        assert data["vote"] == 1
        assert data["newTrustScore"] > 0.5
        assert data["consensusReached"] is False


@pytest.mark.asyncio
async def test_sql_injection_resilience_in_video_id():
    """SQL injection strings in videoId parameter must be handled safely and return 404."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/v1/segments/test%27%20OR%201=1%20--")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_untrusted_user_edit_rejected_403():
    """User with trust score below MIN_TRUST_TO_SUBMIT (0.20) must receive 403 Forbidden."""
    db = TestingSessionLocal()
    video = Video(id="untrusted_target", status="ready", version=1, is_locked=False)
    untrusted = UserTrust(client_uuid="bad_actor", trust_score=0.10)
    db.add_all([video, untrusted])
    db.commit()
    db.close()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            "/v1/segments/untrusted_target/edits",
            json={
                "clientUuid": "bad_actor",
                "segments": [{"start": 0.0, "end": 60.0, "label": "alaap", "confidence": 0.9}],
            },
        )
    assert res.status_code == 403
    assert "Insufficient trust score" in res.json()["detail"]


@pytest.mark.asyncio
async def test_concurrent_segment_fetches():
    """Concurrent read queries must execute safely without connection exhaustion or race conditions."""
    db = TestingSessionLocal()
    video = Video(id="concurrent_vid", status="ready", version=1, is_locked=False)
    seg = Segment(video_id=video.id, label="alaap", start_time=0.0, end_time=120.0, confidence=0.95, source="model")
    db.add_all([video, seg])
    db.commit()
    db.close()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        import asyncio
        tasks = [client.get("/v1/segments/concurrent_vid") for _ in range(20)]
        responses = await asyncio.gather(*tasks)

    for r in responses:
        assert r.status_code == 200
        assert r.json()["videoId"] == "concurrent_vid"


@pytest.mark.asyncio
async def test_malformed_edit_payload_rejected():
    """Missing or empty fields in edit submission must be cleanly rejected."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post("/v1/segments/any_vid/edits", json={"invalidKey": 123})
    assert res.status_code in [400, 404, 422]


@pytest.mark.asyncio
async def test_voting_on_non_existent_revision():
    """Voting on a revision that does not exist returns 404."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            "/v1/segments/vid/vote",
            json={
                "clientUuid": "voter_x",
                "targetRevisionId": "non_existent_rev_id",
                "vote": 1,
            },
        )
    assert res.status_code == 404

