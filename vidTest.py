import sys
import uuid
from pathlib import Path

# Add concert-bookmarking directory to sys.path so backend modules import cleanly
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR / "concert-bookmarking"
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

from backend.app.database import SessionLocal, init_db
from backend.app.models import Video, Segment
from backend.app.cdn import cdn_manager

# 1. PASTE YOUR VIDEO ID AND TOTAL DURATION (in seconds) HERE:
VIDEO_ID = "ed4SIvGjqNI"
DURATION = 582.0  # 9 minutes 42 seconds = 582.0s (exact video duration)


def seed():
    # Ensure tables exist
    init_db()

    with SessionLocal() as session:
        # Check if video already exists to allow re-running without constraint conflicts
        video = session.query(Video).filter(Video.id == VIDEO_ID).first()
        if not video:
            video = Video(
                id=VIDEO_ID,
                title="Test Classical Concert",
                duration=DURATION,
                status="ready",
                tradition="hindustani",
                version=1,
                is_locked=False,
            )
            session.add(video)
        else:
            video.status = "ready"
            video.duration = DURATION
            video.version += 1
            # Clean up old segments to allow clean re-seeding
            session.query(Segment).filter(Segment.video_id == VIDEO_ID).delete()

        # Create 4 test segments across the duration:
        # Alaap: 0% -> 25%
        # Jod: 25% -> 40%
        # Vilambit Bandish: 40% -> 75%
        # Drut Bandish: 75% -> 100%
        t1 = round(DURATION * 0.25, 2)
        t2 = round(DURATION * 0.40, 2)
        t3 = round(DURATION * 0.75, 2)

        segments = [
            ("alaap", 0.0, t1),
            ("jod", t1, t2),
            ("vilambit_bandish", t2, t3),
            ("drut_bandish", t3, DURATION),
        ]

        for label, start, end in segments:
            session.add(
                Segment(
                    id=str(uuid.uuid4()),
                    video_id=VIDEO_ID,
                    label=label,
                    start_time=start,
                    end_time=end,
                    confidence=0.95,
                    source="model",
                )
            )

        session.commit()
        cdn_manager.purge_key(f"video-{VIDEO_ID}")
        print(f"\n[DONE] Successfully seeded video '{VIDEO_ID}' with 4 segments!")
        print(f"       API verification endpoint: http://127.0.0.1:8000/v1/segments/{VIDEO_ID}")


if __name__ == "__main__":
    seed()