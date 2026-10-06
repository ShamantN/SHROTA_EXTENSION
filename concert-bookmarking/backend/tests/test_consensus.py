"""Tests for crowd voting, user trust calculations, and consensus promotion."""
import json
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.app.database import Base
from backend.app.models import Video, Segment, SegmentRevision, UserTrust, Vote
from backend.app.consensus import (
    calculate_trust_score,
    get_or_create_user_trust,
    record_vote,
    check_and_apply_consensus,
    apply_segments_to_video,
    CONSENSUS_THRESHOLD,
)
from backend.app.cdn import cdn_manager


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    session = TestingSessionLocal()
    cdn_manager.clear_purge_history()
    try:
        yield session
    finally:
        session.close()


def test_trust_score_calculation():
    """Verify Laplace-smoothed trust score mathematical boundaries."""
    # Neutral starting state (0, 0) -> (0 + 1) / (0 + 0 + 2) = 0.5
    assert calculate_trust_score(0, 0) == 0.5

    # High upvotes (10, 0) -> (10 + 1) / (10 + 0 + 2) = 11/12 ≈ 0.9167
    high_score = calculate_trust_score(10, 0)
    assert high_score > 0.90

    # High downvotes (0, 10) -> (0 + 1) / (0 + 10 + 2) = 1/12 ≈ 0.0833
    low_score = calculate_trust_score(0, 10)
    assert low_score < 0.10

    # Clamping boundaries
    assert calculate_trust_score(1000, 0) <= 0.99
    assert calculate_trust_score(0, 1000) >= 0.05


def test_get_or_create_user_trust(db_session):
    user = get_or_create_user_trust(db_session, "user-uuid-1")
    assert user.client_uuid == "user-uuid-1"
    assert user.trust_score == 0.50

    # Second call should fetch same instance
    user2 = get_or_create_user_trust(db_session, "user-uuid-1")
    assert user2.client_uuid == user.client_uuid


def test_voting_and_reputation_updates(db_session):
    video = Video(id="vid-consensus-1", status="ready", version=1)
    db_session.add(video)
    db_session.commit()

    author_uuid = "author-1"
    revision_segments = [
        {"start": 0.0, "end": 100.0, "label": "alaap", "confidence": 0.90},
        {"start": 100.0, "end": 200.0, "label": "jod", "confidence": 0.85},
    ]
    revision = SegmentRevision(
        video_id=video.id,
        version=2,
        submitted_by=author_uuid,
        segments_json=json.dumps(revision_segments),
        status="active",
    )
    db_session.add(revision)
    db_session.commit()

    # Voter 1 upvotes
    _, consensus, author_score = record_vote(db_session, "voter-1", video.id, revision.id, 1)
    assert consensus is False
    assert author_score > 0.50

    # Voter 2 upvotes
    _, consensus, author_score = record_vote(db_session, "voter-2", video.id, revision.id, 1)
    assert consensus is False

    # Voter 3 upvotes -> Hits threshold (3 votes) -> Consensus reached!
    _, consensus, author_score = record_vote(db_session, "voter-3", video.id, revision.id, 1)
    assert consensus is True

    # Video should now have version 2 and updated segments
    db_session.refresh(video)
    assert video.version == 2
    assert len(video.segments) == 2
    assert video.segments[0].label == "alaap"
    assert video.segments[1].label == "jod"

    # CDN purge should have recorded invalidation
    assert f"video-{video.id}" in cdn_manager.get_purged_keys()


def test_voting_reversal(db_session):
    video = Video(id="vid-rev-1", status="ready", version=1)
    db_session.add(video)
    author = get_or_create_user_trust(db_session, "author-rev")
    revision = SegmentRevision(
        video_id=video.id,
        version=2,
        submitted_by=author.client_uuid,
        segments_json="[]",
        status="active",
    )
    db_session.add(revision)
    db_session.commit()

    # Voter upvotes then changes mind to downvote
    record_vote(db_session, "fickle-voter", video.id, revision.id, 1)
    db_session.refresh(author)
    assert author.upvotes == 1
    assert author.downvotes == 0

    record_vote(db_session, "fickle-voter", video.id, revision.id, -1)
    db_session.refresh(author)
    assert author.upvotes == 0
    assert author.downvotes == 1


def test_consensus_blocked_when_video_locked(db_session):
    video = Video(id="vid-locked", status="ready", version=1, is_locked=True)
    db_session.add(video)
    revision = SegmentRevision(
        video_id=video.id,
        version=2,
        submitted_by="user-x",
        segments_json="[]",
        status="active",
    )
    db_session.add(revision)
    db_session.commit()

    # 3 voters upvote
    record_vote(db_session, "v1", video.id, revision.id, 1)
    record_vote(db_session, "v2", video.id, revision.id, 1)
    _, consensus, _ = record_vote(db_session, "v3", video.id, revision.id, 1)

    assert consensus is False
    assert video.version == 1
