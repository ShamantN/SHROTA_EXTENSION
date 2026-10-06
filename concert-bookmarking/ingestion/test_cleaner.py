"""Comprehensive test suite for SegmentCleaner ingestion and boundary normalization."""
import pytest
from pathlib import Path
from ingestion.cleaner import SegmentCleaner, NormalizedSegment


@pytest.fixture
def cleaner_factory():
    def _create(video_duration=600.0, **kwargs):
        return SegmentCleaner(video_duration=video_duration, **kwargs)
    return _create


class TestSegmentCleaner:
    def test_clean_input_passthrough(self, cleaner_factory):
        """Clean valid non-overlapping segments above threshold should pass through cleanly."""
        cleaner = cleaner_factory(video_duration=300.0)
        raw = [
            {"start": 0.0, "end": 60.0, "label": "alaap", "confidence": 0.95},
            {"start": 60.0, "end": 180.0, "label": "jod", "confidence": 0.88},
            {"start": 180.0, "end": 300.0, "label": "jhala", "confidence": 0.91},
        ]
        result = cleaner.clean(raw)
        assert len(result) == 3
        assert result[0] == {"start": 0.0, "end": 60.0, "label": "alaap", "confidence": 0.95}
        assert result[1] == {"start": 60.0, "end": 180.0, "label": "jod", "confidence": 0.88}
        assert result[2] == {"start": 180.0, "end": 300.0, "label": "jhala", "confidence": 0.91}

    def test_sub_threshold_confidence_dropping(self, cleaner_factory):
        """Segments with confidence below threshold (default 0.65) must be discarded."""
        cleaner = cleaner_factory(video_duration=300.0, confidence_threshold=0.65)
        raw = [
            {"start": 0.0, "end": 50.0, "label": "alaap", "confidence": 0.70},
            {"start": 60.0, "end": 100.0, "label": "jod", "confidence": 0.50},  # Drop
            {"start": 120.0, "end": 180.0, "label": "jhala", "confidence": 0.64}, # Drop
            {"start": 200.0, "end": 280.0, "label": "taan", "confidence": 0.85},
        ]
        result = cleaner.clean(raw)
        assert len(result) == 2
        assert result[0]["label"] == "alaap"
        assert result[1]["label"] == "taan"

    def test_label_translation_and_unknown_rejection(self, cleaner_factory):
        """Aliases (e.g. 'alap' -> 'alaap') should translate, and unknown labels should be rejected."""
        cleaner = cleaner_factory(video_duration=200.0)
        raw = [
            {"start": 0.0, "end": 50.0, "label": "alap", "confidence": 0.90},        # Alias -> alaap
            {"start": 50.0, "end": 100.0, "label": "unknown_noise", "confidence": 0.95}, # Unknown -> drop
            {"start": 100.0, "end": 150.0, "label": "kriti", "confidence": 0.85},     # Carnatic canonical
        ]
        result = cleaner.clean(raw)
        assert len(result) == 2
        assert result[0]["label"] == "alaap"
        assert result[1]["label"] == "kriti"

    def test_sub_second_deadband_snapping(self, cleaner_factory):
        """Gaps <= snap_threshold (default 1.5s) between adjacent segments should snap."""
        cleaner = cleaner_factory(video_duration=200.0, snap_threshold=1.5)
        raw = [
            {"start": 10.0, "end": 50.0, "label": "alaap", "confidence": 0.90},
            # Gap of 0.8s (50.0 to 50.8), should snap end of first segment to 50.8
            {"start": 50.8, "end": 100.0, "label": "jod", "confidence": 0.85},
            # Gap of 2.0s (> 1.5s), should NOT snap
            {"start": 102.0, "end": 150.0, "label": "jhala", "confidence": 0.88},
        ]
        result = cleaner.clean(raw)
        assert len(result) == 3
        assert result[0]["end"] == 50.8
        assert result[1]["start"] == 50.8
        assert result[1]["end"] == 100.0
        assert result[2]["start"] == 102.0

    def test_absorbing_micro_segments_same_label(self, cleaner_factory):
        """Micro-segment (< 4s) adjacent to a segment of the SAME label should merge into it."""
        cleaner = cleaner_factory(video_duration=200.0, min_duration=4.0)
        raw = [
            {"start": 10.0, "end": 50.0, "label": "alaap", "confidence": 0.90},
            {"start": 50.0, "end": 52.5, "label": "alaap", "confidence": 0.75}, # 2.5s micro-segment same label
            {"start": 60.0, "end": 120.0, "label": "jod", "confidence": 0.85},
        ]
        result = cleaner.clean(raw)
        assert len(result) == 2
        assert result[0]["label"] == "alaap"
        assert result[0]["start"] == 10.0
        assert result[0]["end"] == 52.5
        assert result[1]["label"] == "jod"

    def test_absorbing_micro_segments_different_label_higher_confidence(self, cleaner_factory):
        """Micro-segment (< 4s) flanked by different labels should be absorbed into higher confidence neighbor."""
        cleaner = cleaner_factory(video_duration=200.0, min_duration=4.0)
        raw = [
            {"start": 10.0, "end": 40.0, "label": "alaap", "confidence": 0.95},
            {"start": 40.0, "end": 42.0, "label": "taan", "confidence": 0.70},  # 2s micro-segment
            {"start": 42.0, "end": 80.0, "label": "jod", "confidence": 0.80},
        ]
        result = cleaner.clean(raw)
        # Left neighbor (alaap) has confidence 0.95 > Right neighbor (jod) 0.80
        # So alaap should absorb the micro-segment from 40.0 to 42.0
        assert len(result) == 2
        assert result[0]["label"] == "alaap"
        assert result[0]["start"] == 10.0
        assert result[0]["end"] == 42.0
        assert result[1]["label"] == "jod"
        assert result[1]["start"] == 42.0

    def test_isolated_micro_segment_discarded(self, cleaner_factory):
        """Isolated micro-segment (< 4s) with no touching neighbors should be discarded."""
        cleaner = cleaner_factory(video_duration=200.0, min_duration=4.0)
        raw = [
            {"start": 10.0, "end": 50.0, "label": "alaap", "confidence": 0.90},
            {"start": 70.0, "end": 72.0, "label": "taan", "confidence": 0.85},  # 2s isolated
            {"start": 90.0, "end": 140.0, "label": "jod", "confidence": 0.88},
        ]
        result = cleaner.clean(raw)
        assert len(result) == 2
        assert result[0]["label"] == "alaap"
        assert result[1]["label"] == "jod"

    def test_overlapping_segment_collision_resolution(self, cleaner_factory):
        """Overlapping segments should be deterministically split based on confidence weighting."""
        cleaner = cleaner_factory(video_duration=200.0, confidence_threshold=0.50)
        # Alaap ends at 60, jod starts at 50 -> 10s overlap
        # conf1 = 0.90, conf2 = 0.60
        # split point t = 50 + 10 * (0.90 / (0.90 + 0.60)) = 50 + 10 * 0.6 = 56.0
        raw = [
            {"start": 0.0, "end": 60.0, "label": "alaap", "confidence": 0.90},
            {"start": 50.0, "end": 120.0, "label": "jod", "confidence": 0.60},
        ]
        result = cleaner.clean(raw)
        assert len(result) == 2
        assert result[0]["label"] == "alaap"
        assert result[0]["end"] == 56.0
        assert result[1]["label"] == "jod"
        assert result[1]["start"] == 56.0
        assert result[1]["end"] == 120.0

    def test_out_of_bounds_duration_clamping(self, cleaner_factory):
        """Start < 0 should clamp to 0, End > duration should clamp to video_duration."""
        cleaner = cleaner_factory(video_duration=100.0)
        raw = [
            {"start": -15.0, "end": 40.0, "label": "alaap", "confidence": 0.88},
            {"start": 40.0, "end": 150.0, "label": "jod", "confidence": 0.92},
            {"start": 120.0, "end": 140.0, "label": "jhala", "confidence": 0.90}, # completely outside duration
        ]
        result = cleaner.clean(raw)
        assert len(result) == 2
        assert result[0]["start"] == 0.0
        assert result[0]["end"] == 40.0
        assert result[1]["start"] == 40.0
        assert result[1]["end"] == 100.0

    def test_empty_and_all_filtered_inputs(self, cleaner_factory):
        """Cleaner should gracefully handle empty inputs or all low-confidence inputs."""
        cleaner = cleaner_factory(video_duration=100.0)
        assert cleaner.clean([]) == []
        assert cleaner.clean([{"start": 0.0, "end": 10.0, "label": "alaap", "confidence": 0.1}]) == []

    def test_enclosed_segment_higher_confidence_overrides(self, cleaner_factory):
        """When an enclosed segment has higher confidence, it overrides the enclosing one."""
        cleaner = cleaner_factory(video_duration=200.0)
        raw = [
            {"start": 10.0, "end": 60.0, "label": "alaap", "confidence": 0.70},
            {"start": 20.0, "end": 50.0, "label": "jod", "confidence": 0.95},
        ]
        result = cleaner.clean(raw)
        assert len(result) == 1
        assert result[0]["label"] == "jod"
        assert result[0]["start"] == 20.0
        assert result[0]["end"] == 50.0

    def test_chained_deadband_snaps(self, cleaner_factory):
        """Chained segments separated by small gaps (< 1.5s) snap consistently."""
        cleaner = cleaner_factory(video_duration=300.0, snap_threshold=1.5)
        raw = [
            {"start": 0.0, "end": 50.0, "label": "alaap", "confidence": 0.90},
            {"start": 51.0, "end": 100.0, "label": "jod", "confidence": 0.90}, # 1.0s gap
            {"start": 101.2, "end": 150.0, "label": "jhala", "confidence": 0.90}, # 1.2s gap
        ]
        result = cleaner.clean(raw)
        assert len(result) == 3
        assert result[0]["end"] == 51.0
        assert result[1]["start"] == 51.0
        assert result[1]["end"] == 101.2
        assert result[2]["start"] == 101.2

    def test_nan_and_inf_handling(self, cleaner_factory):
        """NaN and infinite values in start, end, or confidence must be safely dropped."""
        cleaner = cleaner_factory(video_duration=200.0)
        raw = [
            {"start": float("nan"), "end": 50.0, "label": "alaap", "confidence": 0.90},
            {"start": 10.0, "end": float("inf"), "label": "jod", "confidence": 0.85},
            {"start": 20.0, "end": 80.0, "label": "jhala", "confidence": float("nan")},
            {"start": 50.0, "end": 100.0, "label": "alaap", "confidence": 0.90}, # Valid
        ]
        result = cleaner.clean(raw)
        assert len(result) == 1
        assert result[0]["label"] == "alaap"
        assert result[0]["start"] == 50.0

    def test_malformed_and_non_dict_elements(self, cleaner_factory):
        """Non-dictionary inputs or malformed types must not cause unhandled exceptions."""
        cleaner = cleaner_factory(video_duration=200.0)
        raw = [
            None,
            "not_a_dict",
            {"start": "invalid_number", "end": 50.0, "label": "alaap", "confidence": 0.9},
            {"start": 10.0, "end": 60.0, "label": 12345, "confidence": 0.9}, # non-string label
            {"start": 10.0, "end": 60.0, "label": "alaap", "confidence": 0.9}, # valid
        ]
        result = cleaner.clean(raw)
        assert len(result) == 1
        assert result[0]["label"] == "alaap"

    def test_floating_point_precision_artifacts(self, cleaner_factory):
        """Microscopic floating point precision differences must be normalized cleanly."""
        cleaner = cleaner_factory(video_duration=200.0)
        raw = [
            {"start": 0.000000000001, "end": 49.999999999999, "label": "alaap", "confidence": 0.95},
            {"start": 50.000000000001, "end": 100.000000000002, "label": "jod", "confidence": 0.90},
        ]
        result = cleaner.clean(raw)
        assert len(result) == 2
        assert result[0]["start"] == 0.0
        assert result[0]["end"] == 50.0
        assert result[1]["start"] == 50.0
        assert result[1]["end"] == 100.0

    def test_unordered_timestamp_sorting(self, cleaner_factory):
        """Segments given out of chronological order must be sorted by start time."""
        cleaner = cleaner_factory(video_duration=300.0)
        raw = [
            {"start": 180.0, "end": 300.0, "label": "jhala", "confidence": 0.90},
            {"start": 0.0, "end": 60.0, "label": "alaap", "confidence": 0.95},
            {"start": 60.0, "end": 180.0, "label": "jod", "confidence": 0.88},
        ]
        result = cleaner.clean(raw)
        assert len(result) == 3
        assert result[0]["label"] == "alaap"
        assert result[1]["label"] == "jod"
        assert result[2]["label"] == "jhala"

    def test_single_segment_full_concert(self, cleaner_factory):
        """A single continuous movement concert should normalize properly."""
        cleaner = cleaner_factory(video_duration=1800.0)
        raw = [{"start": 0.0, "end": 1800.0, "label": "alaap", "confidence": 0.98}]
        result = cleaner.clean(raw)
        assert len(result) == 1
        assert result[0]["start"] == 0.0
        assert result[0]["end"] == 1800.0

    def test_segment_extending_far_beyond_duration(self, cleaner_factory):
        """Segment with end far exceeding duration must clamp to video_duration."""
        cleaner = cleaner_factory(video_duration=600.0)
        raw = [{"start": 0.0, "end": 999999.0, "label": "alaap", "confidence": 0.95}]
        result = cleaner.clean(raw)
        assert len(result) == 1
        assert result[0]["end"] == 600.0

    def test_zero_or_negative_duration_video(self, cleaner_factory):
        """Video duration <= 0 should safely return empty result."""
        cleaner = cleaner_factory(video_duration=0.0)
        raw = [{"start": 0.0, "end": 100.0, "label": "alaap", "confidence": 0.9}]
        assert cleaner.clean(raw) == []

        cleaner_neg = cleaner_factory(video_duration=-50.0)
        assert cleaner_neg.clean(raw) == []

    def test_consecutive_chain_snaps_multi(self, cleaner_factory):
        """Chained sequence of 4 segments with 0.8s deadbands all snap contiguously."""
        cleaner = cleaner_factory(video_duration=500.0, snap_threshold=1.5)
        raw = [
            {"start": 0.0, "end": 50.0, "label": "alaap", "confidence": 0.9},
            {"start": 50.8, "end": 100.0, "label": "jod", "confidence": 0.9},
            {"start": 100.8, "end": 150.0, "label": "jhala", "confidence": 0.9},
            {"start": 150.8, "end": 200.0, "label": "vilambit_bandish", "confidence": 0.9},
        ]
        result = cleaner.clean(raw)
        assert len(result) == 4
        assert result[0]["end"] == result[1]["start"]
        assert result[1]["end"] == result[2]["start"]
        assert result[2]["end"] == result[3]["start"]

    def test_enclosed_interval_lower_confidence_dropped(self, cleaner_factory):
        """When outer segment has higher confidence than enclosed segment, enclosed is dropped."""
        cleaner = cleaner_factory(video_duration=200.0)
        raw = [
            {"start": 10.0, "end": 100.0, "label": "alaap", "confidence": 0.95},
            {"start": 30.0, "end": 60.0, "label": "jod", "confidence": 0.70},
        ]
        result = cleaner.clean(raw)
        assert len(result) == 1
        assert result[0]["label"] == "alaap"
        assert result[0]["start"] == 10.0
        assert result[0]["end"] == 100.0


