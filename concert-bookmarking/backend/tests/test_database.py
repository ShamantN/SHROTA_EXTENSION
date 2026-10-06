"""Tests for database initialization, schema integrity, and ORM operations."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from backend.app.database import Base
from backend.app.models import Video, Segment, SegmentRevision, UserTrust, Vote


@pytest.fixture
def test_db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()


def test_schema_instantiation(test_db):
    """Verify tables instantiate and foreign keys / cascades work properly."""
    video = Video(
        id="dQw4w9WgXcQ",
        title="Live Hindustani Classical Concert",
        channel_id="UCsZ1Q3jB8f8N6rM1K4L5qMw",
        duration=1800.0,
        status="ready",
        tradition="hindustani",
        version=1,
        is_locked=False,
    )
    test_db.add(video)
    test_db.commit()

    # Add segments
    seg1 = Segment(
        video_id=video.id,
        label="alaap",
        start_time=0.0,
        end_time=300.0,
        confidence=0.95,
        source="model",
    )
    seg2 = Segment(
        video_id=video.id,
        label="jod",
        start_time=300.0,
        end_time=600.0,
        confidence=0.90,
        source="model",
    )
    test_db.add_all([seg1, seg2])
    test_db.commit()

    # Query back
    fetched = test_db.query(Video).filter(Video.id == "dQw4w9WgXcQ").first()
    assert fetched is not None
    assert len(fetched.segments) == 2
    assert fetched.segments[0].label == "alaap"
    assert fetched.segments[1].label == "jod"


def test_user_trust_and_votes(test_db):
    """Verify user trust records and voting associations."""
    user = UserTrust(
        client_uuid="user-1234",
        upvotes=5,
        downvotes=1,
        submissions_count=2,
        trust_score=0.8,
    )
    test_db.add(user)

    video = Video(id="vid_test_1", status="ready")
    test_db.add(video)
    test_db.commit()

    rev = SegmentRevision(
        video_id="vid_test_1",
        version=1,
        submitted_by="user-1234",
        segments_json="[]",
        status="active",
    )
    test_db.add(rev)
    test_db.commit()

    vote = Vote(
        client_uuid="voter-5678",
        video_id="vid_test_1",
        revision_id=rev.id,
        vote=1,
    )
    test_db.add(vote)
    test_db.commit()

    fetched_vote = test_db.query(Vote).filter(Vote.client_uuid == "voter-5678").first()
    assert fetched_vote is not None
    assert fetched_vote.vote == 1
    assert fetched_vote.revision_id == rev.id
