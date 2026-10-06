"""Boundary normalization and raw model output cleaner for concert segments."""
import json
import math
from pathlib import Path
from typing import List, Dict, Any, Optional
from dataclasses import dataclass


@dataclass
class NormalizedSegment:
    start: float
    end: float
    label: str
    confidence: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "start": round(self.start, 2),
            "end": round(self.end, 2),
            "label": self.label,
            "confidence": round(self.confidence, 4),
        }


class SegmentCleaner:
    def __init__(
        self,
        video_duration: float,
        confidence_threshold: float = 0.65,
        min_duration: float = 4.0,
        snap_threshold: float = 1.5,
        taxonomy_path: Optional[str | Path] = None,
    ):
        self.video_duration = float(video_duration)
        self.confidence_threshold = float(confidence_threshold)
        self.min_duration = float(min_duration)
        self.snap_threshold = float(snap_threshold)
        
        self.canonical_tags: set = set()
        self.alias_map: Dict[str, str] = {}
        self._load_taxonomy(taxonomy_path)

    def _load_taxonomy(self, taxonomy_path: Optional[str | Path]) -> None:
        if taxonomy_path is None:
            # Default to config/taxonomy.json relative to project root
            base_dir = Path(__file__).resolve().parent.parent
            taxonomy_path = base_dir / "config" / "taxonomy.json"

        path = Path(taxonomy_path)
        if not path.exists():
            return

        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)

        traditions = data.get("traditions", {})
        for _, trad_data in traditions.items():
            tags = trad_data.get("tags", {})
            for tag_id, tag_meta in tags.items():
                self.canonical_tags.add(tag_id)
                self.alias_map[tag_id.lower()] = tag_id
                for alias in tag_meta.get("aliases", []):
                    self.alias_map[alias.lower()] = tag_id

    def translate_label(self, raw_label: str) -> Optional[str]:
        if not isinstance(raw_label, str):
            return None
        cleaned = raw_label.strip().lower()
        if cleaned in self.alias_map:
            return self.alias_map[cleaned]
        if cleaned in self.canonical_tags:
            return cleaned
        return None

    def clean(self, raw_segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if not raw_segments or not isinstance(raw_segments, list):
            return []

        # 1. Confidence Filtering & 2. Label Translation
        valid_segments: List[NormalizedSegment] = []
        for seg in raw_segments:
            if not isinstance(seg, dict):
                continue
            try:
                conf = float(seg.get("confidence", 0.0))
                start = float(seg.get("start", 0.0))
                end = float(seg.get("end", 0.0))
            except (ValueError, TypeError):
                continue

            if (
                math.isnan(conf) or math.isnan(start) or math.isnan(end) or
                math.isinf(conf) or math.isinf(start) or math.isinf(end)
            ):
                continue

            if conf < self.confidence_threshold:
                continue

            if end <= start:
                continue

            label = self.translate_label(seg.get("label", ""))
            if not label:
                continue

            valid_segments.append(
                NormalizedSegment(
                    start=round(start, 6),
                    end=round(end, 6),
                    label=label,
                    confidence=conf,
                )
            )

        if not valid_segments:
            return []

        # 3. Sort & Boundary Clamp
        clamped: List[NormalizedSegment] = []
        for s in valid_segments:
            start = max(0.0, s.start)
            end = min(self.video_duration, s.end)
            if end > start:
                clamped.append(NormalizedSegment(start=start, end=end, label=s.label, confidence=s.confidence))

        if not clamped:
            return []

        clamped.sort(key=lambda x: (x.start, x.end))

        # 6. Overlap Resolution (Deterministic confidence-weighted collision handling)
        resolved = self._resolve_overlaps(clamped)

        # 4. Boundary Snapping
        snapped = self._snap_boundaries(resolved)

        # Merge adjacent identical labels before micro-absorption
        merged = self._merge_adjacent_same_labels(snapped)

        # 5. Micro-Segment Absorption
        absorbed = self._absorb_micro_segments(merged)

        # Final pass: snap, merge adjacent same labels, and format dicts
        final_snapped = self._snap_boundaries(absorbed)
        final_merged = self._merge_adjacent_same_labels(final_snapped)

        return [s.to_dict() for s in final_merged]

    def _resolve_overlaps(self, segments: List[NormalizedSegment]) -> List[NormalizedSegment]:
        if len(segments) <= 1:
            return segments

        result: List[NormalizedSegment] = [segments[0]]
        for curr in segments[1:]:
            prev = result[-1]

            if curr.start < prev.end:
                # Collision detected
                if curr.end <= prev.end:
                    # curr is completely enclosed in prev
                    if curr.confidence > prev.confidence:
                        # curr takes precedence; split prev or replace
                        result.pop()
                        result.append(curr)
                    else:
                        # prev dominates, skip curr
                        continue
                else:
                    # Partial overlap between prev and curr
                    overlap = prev.end - curr.start
                    conf_sum = prev.confidence + curr.confidence
                    if conf_sum > 0:
                        split_point = curr.start + overlap * (prev.confidence / conf_sum)
                    else:
                        split_point = curr.start + overlap * 0.5

                    # Adjust boundaries
                    prev.end = split_point
                    curr.start = split_point

                    if curr.end > curr.start:
                        result.append(curr)
            else:
                result.append(curr)

        return result

    def _snap_boundaries(self, segments: List[NormalizedSegment]) -> List[NormalizedSegment]:
        if len(segments) <= 1:
            return segments

        for i in range(len(segments) - 1):
            gap = segments[i + 1].start - segments[i].end
            if 0.0 < gap <= self.snap_threshold:
                segments[i].end = segments[i + 1].start

        return segments

    def _merge_adjacent_same_labels(self, segments: List[NormalizedSegment]) -> List[NormalizedSegment]:
        if len(segments) <= 1:
            return segments

        merged: List[NormalizedSegment] = [segments[0]]
        for curr in segments[1:]:
            prev = merged[-1]
            if prev.label == curr.label and abs(prev.end - curr.start) <= 0.01:
                # Merge into prev with weighted confidence
                total_dur = (prev.end - prev.start) + (curr.end - curr.start)
                if total_dur > 0:
                    merged_conf = (
                        prev.confidence * (prev.end - prev.start) + curr.confidence * (curr.end - curr.start)
                    ) / total_dur
                else:
                    merged_conf = max(prev.confidence, curr.confidence)

                prev.end = max(prev.end, curr.end)
                prev.confidence = merged_conf
            else:
                merged.append(curr)

        return merged

    def _absorb_micro_segments(self, segments: List[NormalizedSegment]) -> List[NormalizedSegment]:
        if not segments:
            return []

        result = list(segments)
        changed = True

        while changed:
            changed = False
            for i, seg in enumerate(result):
                dur = seg.end - seg.start
                if dur < self.min_duration:
                    left_idx = i - 1 if i > 0 else None
                    right_idx = i + 1 if i < len(result) - 1 else None

                    left_adj = left_idx is not None and abs(result[left_idx].end - seg.start) <= self.snap_threshold
                    right_adj = right_idx is not None and abs(seg.end - result[right_idx].start) <= self.snap_threshold

                    # Check for adjacent with same label
                    if left_adj and result[left_idx].label == seg.label:
                        result[left_idx].end = seg.end
                        result.pop(i)
                        changed = True
                        break
                    elif right_adj and result[right_idx].label == seg.label:
                        result[right_idx].start = seg.start
                        result.pop(i)
                        changed = True
                        break
                    elif left_adj or right_adj:
                        # Different labels: absorb into higher confidence neighbor
                        if left_adj and right_adj:
                            if result[left_idx].confidence >= result[right_idx].confidence:
                                result[left_idx].end = seg.end
                            else:
                                result[right_idx].start = seg.start
                        elif left_adj:
                            result[left_idx].end = seg.end
                        else:
                            result[right_idx].start = seg.start
                        result.pop(i)
                        changed = True
                        break
                    else:
                        # Isolated micro-segment
                        result.pop(i)
                        changed = True
                        break

        return result
