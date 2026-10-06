"""Database models (SQLAlchemy) and API schemas (Pydantic)."""
import uuid
from datetime import datetime, timezone
from typing import List, Optional, Any, Dict, Literal
from sqlalchemy import Column, String, Float, Integer, Boolean, DateTime, ForeignKey, Text, func
from sqlalchemy.orm import relationship
from pydantic import BaseModel, Field, ConfigDict

from .database import Base


# ==========================================
# SQLAlchemy ORM Models
# ==========================================

class Video(Base):
    __tablename__ = "videos"

    id = Column(String(64), primary_key=True, index=True)  # YouTube Video ID
    title = Column(String(255), nullable=True)
    channel_id = Column(String(128), nullable=True)
    duration = Column(Float, nullable=True)
    status = Column(String(32), default="processing", nullable=False)  # processing, ready, rejected
    tradition = Column(String(64), nullable=True)  # hindustani, carnatic, etc.
    version = Column(Integer, default=1, nullable=False)
    is_locked = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    segments = relationship("Segment", back_populates="video", cascade="all, delete-orphan", order_by="Segment.start_time")
    revisions = relationship("SegmentRevision", back_populates="video", cascade="all, delete-orphan", order_by="SegmentRevision.version.desc()")


class Segment(Base):
    __tablename__ = "segments"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    video_id = Column(String(64), ForeignKey("videos.id"), nullable=False, index=True)
    label = Column(String(64), nullable=False)
    start_time = Column(Float, nullable=False)
    end_time = Column(Float, nullable=False)
    confidence = Column(Float, default=1.0, nullable=False)
    source = Column(String(32), default="model", nullable=False)  # model | crowd

    video = relationship("Video", back_populates="segments")


class SegmentRevision(Base):
    __tablename__ = "segment_revisions"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    video_id = Column(String(64), ForeignKey("videos.id"), nullable=False, index=True)
    version = Column(Integer, nullable=False)
    submitted_by = Column(String(128), nullable=False)  # client_uuid
    segments_json = Column(Text, nullable=False)  # JSON-encoded array of segments
    status = Column(String(32), default="active", nullable=False)  # active | superseded
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    video = relationship("Video", back_populates="revisions")


class UserTrust(Base):
    __tablename__ = "user_trust"

    client_uuid = Column(String(128), primary_key=True)
    upvotes = Column(Integer, default=0, nullable=False)
    downvotes = Column(Integer, default=0, nullable=False)
    submissions_count = Column(Integer, default=0, nullable=False)
    trust_score = Column(Float, default=0.5, nullable=False)


class Vote(Base):
    __tablename__ = "votes"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    client_uuid = Column(String(128), nullable=False, index=True)
    video_id = Column(String(64), ForeignKey("videos.id"), nullable=False, index=True)
    revision_id = Column(String(36), ForeignKey("segment_revisions.id"), nullable=False, index=True)
    vote = Column(Integer, nullable=False)  # 1 or -1
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


# ==========================================
# Pydantic Schemas (API Data Contracts)
# ==========================================

class SegmentPayload(BaseModel):
    start: float = Field(..., alias="start", ge=0.0)
    end: float = Field(..., alias="end", gt=0.0)
    label: str
    confidence: Optional[float] = Field(default=1.0, ge=0.0, le=1.0)
    source: Optional[str] = "crowd"

    model_config = ConfigDict(populate_by_name=True)


class SegmentResponseItem(BaseModel):
    id: str
    start: float
    end: float
    label: str
    confidence: float
    source: str

    model_config = ConfigDict(from_attributes=True)


class VideoSegmentsResponse(BaseModel):
    videoId: str
    version: int
    status: Literal["ready"] = "ready"
    tradition: Optional[str] = None
    isLocked: bool
    segments: List[SegmentResponseItem]


class VideoProcessingResponse(BaseModel):
    videoId: str
    status: Literal["processing"] = "processing"
    pollAfterSeconds: int = 10


class VideoRejectedResponse(BaseModel):
    videoId: str
    status: Literal["rejected"] = "rejected"
    reason: str


class ClassifyRequest(BaseModel):
    videoId: str
    title: Optional[str] = ""
    description: Optional[str] = ""
    channelId: Optional[str] = ""


class ClassifyResponse(BaseModel):
    videoId: str
    status: Literal["processing", "rejected", "ready"]
    tradition: Optional[str] = None
    confidence: float
    matchedKeywords: List[str] = []


class CrowdEditRequest(BaseModel):
    clientUuid: str
    segments: List[SegmentPayload]


class CrowdEditResponse(BaseModel):
    videoId: str
    version: int
    revisionId: str
    status: str
    message: str


class VoteRequest(BaseModel):
    clientUuid: str
    targetRevisionId: str
    vote: Literal[1, -1]


class VoteResponse(BaseModel):
    clientUuid: str
    targetRevisionId: str
    vote: int
    newTrustScore: float
    consensusReached: bool
    message: str
