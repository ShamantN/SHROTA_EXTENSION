"""FastAPI routing layer for video classification, segments retrieval, edits, and votes."""
import json
from pathlib import Path
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session, joinedload

from .database import get_db
from .models import (
    Video,
    Segment,
    SegmentRevision,
    VideoSegmentsResponse,
    VideoProcessingResponse,
    VideoRejectedResponse,
    ClassifyRequest,
    ClassifyResponse,
    CrowdEditRequest,
    CrowdEditResponse,
    VoteRequest,
    VoteResponse,
)
from .consensus import (
    get_or_create_user_trust,
    record_vote,
    apply_segments_to_video,
    TRUSTED_SUBMITTER_THRESHOLD,
    MIN_TRUST_TO_SUBMIT,
)
from .cdn import cdn_manager
from ingestion.cleaner import SegmentCleaner

router = APIRouter(prefix="/v1")

# Load allowlist once
CONFIG_DIR = Path(__file__).resolve().parent.parent.parent / "config"
ALLOWLIST_FILE = CONFIG_DIR / "allowlist.json"
ALLOWLIST_CHANNELS = set()
if ALLOWLIST_FILE.exists():
    try:
        with open(ALLOWLIST_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            for ch in data.get("channels", []):
                if ch.get("handle"):
                    ALLOWLIST_CHANNELS.add(ch["handle"].lower())
                if ch.get("channel_id"):
                    ALLOWLIST_CHANNELS.add(ch["channel_id"].lower())
    except Exception:
        pass

CLASSICAL_POSITIVE_KEYWORDS = [
    "alaap", "alap", "jod", "jhala", "khyal", "bandish", "vilambit", "drut",
    "dhrupad", "thumri", "tarana", "raga", "raag", "tansen", "carnatic",
    "hindustani", "alapana", "tanam", "kriti", "neraval", "swaraprasthara",
    "tani avartanam", "jugalbandi", "santoor", "sitar", "sarod", "shehnai",
    "tabla", "mridangam", "veena", "sarangi", "classical concert", "darbar",
]

DISQUALIFYING_NEGATIVE_KEYWORDS = [
    "vlog", "interview", "podcast", "reaction", "review", "tutorial",
    "lesson 1", "lesson 2", "behind the scenes", "q&a", "unboxing", "daily life",
]


@router.get("/segments/{video_id}")
def get_segments(video_id: str, response: Response, db: Session = Depends(get_db)):
    """Retrieve canonical segment annotations for a given YouTube video."""
    video = db.query(Video).options(joinedload(Video.segments)).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    if video.status == "ready":
        response.headers["Cache-Control"] = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=3600"
        response.headers["Surrogate-Key"] = f"video-{video.id} taxonomy"

        segments_out = [
            {
                "id": s.id,
                "start": s.start_time,
                "end": s.end_time,
                "label": s.label,
                "confidence": s.confidence,
                "source": s.source,
            }
            for s in video.segments
        ]

        return {
            "videoId": video.id,
            "version": video.version,
            "status": "ready",
            "tradition": video.tradition,
            "isLocked": video.is_locked,
            "segments": segments_out,
        }

    elif video.status == "processing":
        response.status_code = status.HTTP_202_ACCEPTED
        return {
            "videoId": video.id,
            "status": "processing",
            "pollAfterSeconds": 10,
        }

    elif video.status == "rejected":
        response.status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
        return {
            "videoId": video.id,
            "status": "rejected",
            "reason": "classifier_negative",
        }

    raise HTTPException(status_code=400, detail="Invalid video status")


@router.post("/classify", response_model=ClassifyResponse)
def classify_video(req: ClassifyRequest, db: Session = Depends(get_db)):
    """Heuristic / classifier check for Indian classical concert vs. vlog/talk."""
    text_corpus = f"{req.title or ''} {req.description or ''}".lower()
    ch_id = (req.channelId or "").lower()

    # Channel Allowlist match
    is_allowlisted = ch_id in ALLOWLIST_CHANNELS

    # Negative keyword check
    negative_hits = [k for k in DISQUALIFYING_NEGATIVE_KEYWORDS if k in text_corpus]

    # Positive keyword check
    positive_hits = [k for k in CLASSICAL_POSITIVE_KEYWORDS if k in text_corpus]

    # Determine tradition
    tradition = None
    if any(k in text_corpus for k in ["carnatic", "alapana", "tanam", "kriti", "neraval", "mridangam"]):
        tradition = "carnatic"
    elif any(k in text_corpus for k in ["hindustani", "alaap", "khyal", "vilambit", "drut", "sitar", "sarod", "tabla"]):
        tradition = "hindustani"

    # Evaluation rule
    is_positive = (is_allowlisted or len(positive_hits) >= 2 or (len(positive_hits) >= 1 and tradition is not None)) and len(negative_hits) == 0

    video = db.query(Video).filter(Video.id == req.videoId).first()
    if not video:
        video = Video(
            id=req.videoId,
            title=req.title,
            channel_id=req.channelId,
            status="processing" if is_positive else "rejected",
            tradition=tradition or ("hindustani" if is_positive else None),
            version=1,
            is_locked=False,
        )
        db.add(video)
    else:
        if video.status != "ready":
            video.status = "processing" if is_positive else "rejected"
        if tradition and not video.tradition:
            video.tradition = tradition

    db.commit()
    db.refresh(video)

    confidence = 0.95 if is_allowlisted else (0.85 if is_positive else 0.20)

    return ClassifyResponse(
        videoId=req.videoId,
        status=video.status,
        tradition=video.tradition,
        confidence=confidence,
        matchedKeywords=positive_hits,
    )


@router.post("/segments/{video_id}/edits", response_model=CrowdEditResponse)
def submit_crowd_edits(video_id: str, req: CrowdEditRequest, db: Session = Depends(get_db)):
    """Submit crowd annotations / revisions with trust score gatekeeping."""
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    if video.is_locked:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Video is locked against crowd modifications",
        )

    user = get_or_create_user_trust(db, req.clientUuid)
    if user.trust_score < MIN_TRUST_TO_SUBMIT:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient trust score to submit edits",
        )

    # Clean and normalize submitted segments
    cleaner = SegmentCleaner(video_duration=video.duration or 7200.0)
    raw_dicts = [s.model_dump() for s in req.segments]
    cleaned = cleaner.clean(raw_dicts)

    if not cleaned:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Submitted segments failed normalization validation",
        )

    # Create new revision
    next_version = video.version + 1
    revision = SegmentRevision(
        video_id=video.id,
        version=next_version,
        submitted_by=req.clientUuid,
        segments_json=json.dumps(cleaned),
        status="active",
    )
    db.add(revision)
    user.submissions_count += 1
    db.commit()
    db.refresh(revision)

    # If author has trusted reputation, immediately promote
    if user.trust_score >= TRUSTED_SUBMITTER_THRESHOLD:
        apply_segments_to_video(db, video, cleaned, source="crowd")
        revision.status = "promoted"
        db.commit()
        return CrowdEditResponse(
            videoId=video.id,
            version=video.version,
            revisionId=revision.id,
            status="promoted_immediately",
            message="Edit applied immediately due to high contributor trust score",
        )

    return CrowdEditResponse(
        videoId=video.id,
        version=video.version,
        revisionId=revision.id,
        status="pending_consensus",
        message="Edit accepted and queued for crowd consensus voting",
    )


@router.post("/segments/{video_id}/vote", response_model=VoteResponse)
def vote_on_revision(video_id: str, req: VoteRequest, db: Session = Depends(get_db)):
    """Vote (+1 / -1) on a candidate segment revision."""
    try:
        vote_record, consensus_reached, new_trust_score = record_vote(
            db,
            client_uuid=req.clientUuid,
            video_id=video_id,
            revision_id=req.targetRevisionId,
            vote_val=req.vote,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    msg = (
        "Consensus threshold reached; revision promoted to canonical segments"
        if consensus_reached
        else "Vote recorded successfully"
    )

    return VoteResponse(
        clientUuid=req.clientUuid,
        targetRevisionId=req.targetRevisionId,
        vote=req.vote,
        newTrustScore=new_trust_score,
        consensusReached=consensus_reached,
        message=msg,
    )


@router.post("/segments/{video_id}/ingest-model")
def ingest_model_segments(video_id: str, raw_segments: List[dict], db: Session = Depends(get_db)):
    """Direct model output ingestion endpoint that cleans and sets video to ready."""
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        video = Video(
            id=video_id,
            status="processing",
            duration=3600.0,
            version=1,
            is_locked=False,
        )
        db.add(video)
        db.commit()
        db.refresh(video)

    cleaner = SegmentCleaner(video_duration=video.duration or 3600.0)
    cleaned = cleaner.clean(raw_segments)

    apply_segments_to_video(db, video, cleaned, source="model")
    return {"videoId": video.id, "status": "ready", "segments_count": len(cleaned)}


@router.post("/videos/{video_id}/lock")
def toggle_video_lock(video_id: str, locked: bool, db: Session = Depends(get_db)):
    """Toggle moderation lock for testing and administrative oversight."""
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")
    video.is_locked = locked
    db.commit()
    return {"videoId": video.id, "isLocked": video.is_locked}
