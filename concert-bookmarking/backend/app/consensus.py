"""Crowd voting, trust calculations, and consensus evaluation layer."""
import json
import logging
from typing import Tuple, Dict, Any, List
from sqlalchemy.orm import Session
from sqlalchemy import func

from .models import Video, Segment, SegmentRevision, UserTrust, Vote
from .cdn import cdn_manager

logger = logging.getLogger(__name__)

CONSENSUS_THRESHOLD = 3  # Net votes required to promote a revision
TRUSTED_SUBMITTER_THRESHOLD = 0.75  # Direct promotion threshold for trusted editors
MIN_TRUST_TO_SUBMIT = 0.20  # Minimum trust score to submit edits


def calculate_trust_score(upvotes: int, downvotes: int, submissions_count: int = 0) -> float:
    """Calculates Bayesian Laplace-smoothed trust score in range [0.0, 1.0]."""
    # Laplace smoothing: (up + 1) / (up + down + 2)
    score = (upvotes + 1.0) / (upvotes + downvotes + 2.0)
    # Small bonus for established contributors
    if submissions_count >= 5 and downvotes == 0:
        score = min(0.99, score + 0.05)
    return round(max(0.05, min(0.99, score)), 4)


def get_or_create_user_trust(db: Session, client_uuid: str) -> UserTrust:
    """Retrieve existing user trust or initialize with neutral reputation."""
    user = db.query(UserTrust).filter(UserTrust.client_uuid == client_uuid).first()
    if not user:
        user = UserTrust(
            client_uuid=client_uuid,
            upvotes=0,
            downvotes=0,
            submissions_count=0,
            trust_score=0.50,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    return user


def apply_segments_to_video(db: Session, video: Video, segments_data: List[Dict[str, Any]], source: str = "crowd") -> None:
    """Replaces current video segments with newly promoted segments."""
    # Remove existing canonical segments
    db.query(Segment).filter(Segment.video_id == video.id).delete()

    for seg in segments_data:
        new_seg = Segment(
            video_id=video.id,
            label=seg["label"],
            start_time=float(seg["start"]),
            end_time=float(seg["end"]),
            confidence=float(seg.get("confidence", 1.0)),
            source=seg.get("source", source),
        )
        db.add(new_seg)

    video.version += 1
    video.status = "ready"
    db.commit()
    db.refresh(video)

    # Invalidate cache
    cdn_manager.purge_key(f"video-{video.id}")
    logger.info(f"Updated canonical segments for video {video.id} to version {video.version}")


def record_vote(
    db: Session, client_uuid: str, video_id: str, revision_id: str, vote_val: int
) -> Tuple[Vote, bool, float]:
    """Records or updates a user vote, updates author's trust score, and checks consensus."""
    # Ensure voter exists
    get_or_create_user_trust(db, client_uuid)

    revision = db.query(SegmentRevision).filter(SegmentRevision.id == revision_id).first()
    if not revision:
        raise ValueError(f"Revision {revision_id} not found")

    author_trust = get_or_create_user_trust(db, revision.submitted_by)

    # Check for existing vote by this voter on this revision
    existing_vote = (
        db.query(Vote)
        .filter(Vote.client_uuid == client_uuid, Vote.revision_id == revision_id)
        .first()
    )

    if existing_vote:
        # Reversing or updating vote
        old_val = existing_vote.vote
        if old_val != vote_val:
            if old_val == 1:
                author_trust.upvotes = max(0, author_trust.upvotes - 1)
            elif old_val == -1:
                author_trust.downvotes = max(0, author_trust.downvotes - 1)

            if vote_val == 1:
                author_trust.upvotes += 1
            elif vote_val == -1:
                author_trust.downvotes += 1

            existing_vote.vote = vote_val
            db.commit()
            vote_record = existing_vote
    else:
        # New vote
        vote_record = Vote(
            client_uuid=client_uuid,
            video_id=video_id,
            revision_id=revision_id,
            vote=vote_val,
        )
        db.add(vote_record)

        if vote_val == 1:
            author_trust.upvotes += 1
        elif vote_val == -1:
            author_trust.downvotes += 1

        db.commit()

    # Recalculate author's trust score
    author_trust.trust_score = calculate_trust_score(
        author_trust.upvotes, author_trust.downvotes, author_trust.submissions_count
    )
    db.commit()
    db.refresh(author_trust)

    # Check if consensus threshold is reached
    consensus_reached = check_and_apply_consensus(db, video_id, revision_id)

    return vote_record, consensus_reached, author_trust.trust_score


def check_and_apply_consensus(db: Session, video_id: str, revision_id: str) -> bool:
    """Evaluates whether net votes meet consensus threshold to promote revision to canonical."""
    revision = db.query(SegmentRevision).filter(SegmentRevision.id == revision_id).first()
    if not revision or revision.status == "superseded":
        return False

    video = db.query(Video).filter(Video.id == video_id).first()
    if not video or video.is_locked:
        return False

    # Calculate net votes: sum(vote)
    net_votes = db.query(func.sum(Vote.vote)).filter(Vote.revision_id == revision_id).scalar() or 0

    if net_votes >= CONSENSUS_THRESHOLD:
        segments_data = json.loads(revision.segments_json)
        apply_segments_to_video(db, video, segments_data, source="crowd")

        # Mark this revision as canonical/active and supersede older ones
        revision.status = "promoted"
        db.query(SegmentRevision).filter(
            SegmentRevision.video_id == video_id, SegmentRevision.id != revision_id
        ).update({"status": "superseded"})
        db.commit()
        return True

    return False
