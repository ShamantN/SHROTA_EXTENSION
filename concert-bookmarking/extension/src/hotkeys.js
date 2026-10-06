/**
 * Hotkey navigation engine for YouTube concert segments.
 * Shift + N: Seek to next segment start
 * Shift + P: Seek to previous segment start
 */

/**
 * Finds the next adjacent segment boundary relative to currentTime.
 */
export function findNextSegment(currentTime, segments) {
  if (!segments || segments.length === 0) return null;
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  for (const seg of sorted) {
    if (seg.start > currentTime + 0.5) {
      return seg;
    }
  }
  return null;
}

/**
 * Finds the previous adjacent segment boundary relative to currentTime.
 * If user is > 2s into current segment, restarts current segment.
 * Otherwise, moves to previous segment start.
 */
export function findPreviousSegment(currentTime, segments) {
  if (!segments || segments.length === 0) return null;
  const sorted = [...segments].sort((a, b) => a.start - b.start);

  for (let i = sorted.length - 1; i >= 0; i--) {
    const seg = sorted[i];
    // Check if we are currently inside this segment
    if (currentTime >= seg.start && currentTime <= seg.end) {
      if (currentTime - seg.start > 2.0) {
        return seg; // Restart current segment
      } else if (i > 0) {
        return sorted[i - 1]; // Jump to previous segment
      } else {
        return seg; // Beginning of first segment
      }
    }
    // If currentTime is beyond this segment
    if (seg.start < currentTime - 0.5) {
      return seg;
    }
  }
  return sorted[0] || null;
}

/**
 * Checks whether the keyboard event target is an interactive text input.
 */
export function isTypingContext(target) {
  if (!target) return false;
  const tag = (target.tagName || "").toUpperCase();
  const isEditable =
    Boolean(target.isContentEditable) ||
    target.getAttribute?.("contenteditable") === "true" ||
    target.contentEditable === "true" ||
    target.contentEditable === true;

  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    isEditable ||
    Boolean(target.classList?.contains("yt-spec-input-shape"))
  );
}

/**
 * Attaches keyboard event listener to window.
 */
export function setupHotkeys(getVideoElement, getSegments) {
  const handler = (e) => {
    if (isTypingContext(e.target)) return;

    if (!e.shiftKey) return;

    const key = e.key.toUpperCase();
    if (key !== "N" && key !== "P") return;

    const video = typeof getVideoElement === "function" ? getVideoElement() : getVideoElement;
    if (!video) return;

    const segments = typeof getSegments === "function" ? getSegments() : getSegments;
    if (!segments || segments.length === 0) return;

    const attrTime = parseFloat(video.getAttribute?.("data-current-time"));
    const rawTime = video.currentTime;
    const currentTime = !isNaN(attrTime) ? attrTime : (!isNaN(rawTime) ? rawTime : 0);

    const seekTo = (targetTime) => {
      video.currentTime = targetTime;
      if (typeof video.setAttribute === "function") {
        video.setAttribute("data-current-time", String(targetTime));
      }
      if (typeof video.dispatchEvent === "function") {
        video.dispatchEvent(new CustomEvent("concert-seek", { detail: { time: targetTime }, bubbles: true }));
      }
    };

    if (key === "N") {
      const next = findNextSegment(currentTime, segments);
      if (next) {
        seekTo(next.start);
        e.preventDefault();
      }
    } else if (key === "P") {
      const prev = findPreviousSegment(currentTime, segments);
      if (prev) {
        seekTo(prev.start);
        e.preventDefault();
      }
    }
  };

  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}
