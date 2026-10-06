/**
 * YouTube Scrubber Bar Concert Segments Overlay Engine.
 */

export const TAXONOMY_COLORS = {
  // Hindustani
  alaap: "#FF6B6B",
  jod: "#FFA07A",
  jhala: "#FFD166",
  vilambit_bandish: "#06D6A0",
  drut_bandish: "#118AB2",
  taan: "#073B4C",
  sargam: "#8338EC",
  // Carnatic
  alapana: "#E63946",
  tanam: "#F4A261",
  kriti: "#2A9D8F",
  neraval: "#457B9D",
  swaraprasthara: "#7209B7",
  tani_avartanam: "#3A0CA3",
};

export const DEFAULT_COLOR = "#8E44AD";

/**
 * Maps a musical tag label to its standardized hex color.
 */
export function getCategoryColor(label) {
  if (!label) return DEFAULT_COLOR;
  const key = label.toLowerCase().trim();
  return TAXONOMY_COLORS[key] || DEFAULT_COLOR;
}

/**
 * Calculates mathematical percentage coordinates for segment markers.
 */
export function calculateSegmentGeometry(start, end, duration) {
  if (!duration || duration <= 0) {
    return { leftPercent: 0, widthPercent: 0 };
  }

  const safeStart = Math.max(0, Math.min(start, duration));
  const safeEnd = Math.max(safeStart, Math.min(end, duration));

  const leftPercent = (safeStart / duration) * 100;
  const rawWidthPercent = ((safeEnd - safeStart) / duration) * 100;

  // Clamp to ensure width does not overflow container boundaries
  const widthPercent = Math.max(0, Math.min(100 - leftPercent, rawWidthPercent));

  return {
    leftPercent: Number(leftPercent.toFixed(4)),
    widthPercent: Number(widthPercent.toFixed(4)),
  };
}

/**
 * Formats seconds into MM:SS or HH:MM:SS string.
 */
export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Removes existing segment overlay from the DOM.
 */
export function removeSegmentsOverlay(progressBar) {
  if (!progressBar) return;
  const existing = progressBar.querySelector(".concert-segments-overlay");
  if (existing) {
    if (existing._resizeObserver) {
      existing._resizeObserver.disconnect();
    }
    existing.remove();
  }
}

/**
 * Renders or updates the visual bookmark overlay on YouTube scrubber bar.
 */
export function renderSegmentsOverlay(progressBar, segments, duration, videoElement = null) {
  if (!progressBar || !segments || segments.length === 0 || !duration || duration <= 0) {
    return null;
  }

  // Remove duplicate overlay if present
  removeSegmentsOverlay(progressBar);

  const overlayContainer = document.createElement("div");
  overlayContainer.className = "concert-segments-overlay";
  overlayContainer.style.position = "absolute";
  overlayContainer.style.top = "0";
  overlayContainer.style.left = "0";
  overlayContainer.style.width = "100%";
  overlayContainer.style.height = "100%";
  overlayContainer.style.pointerEvents = "none";
  overlayContainer.style.zIndex = "40";

  segments.forEach((seg) => {
    const { leftPercent, widthPercent } = calculateSegmentGeometry(
      seg.start,
      seg.end,
      duration
    );

    if (widthPercent <= 0) return;

    const marker = document.createElement("div");
    marker.className = "concert-segment-marker";
    marker.dataset.start = String(seg.start);
    marker.dataset.end = String(seg.end);
    marker.dataset.label = seg.label;

    const color = getCategoryColor(seg.label);

    marker.style.position = "absolute";
    marker.style.top = "0";
    marker.style.left = `${leftPercent}%`;
    marker.style.width = `${widthPercent}%`;
    marker.style.height = "100%";
    marker.style.backgroundColor = color;
    marker.style.opacity = "0.75";
    marker.style.pointerEvents = "auto";
    marker.style.cursor = "pointer";
    marker.style.boxSizing = "border-box";
    marker.style.borderRight = "1px solid rgba(0, 0, 0, 0.4)";
    marker.style.transition = "opacity 0.15s ease, transform 0.1s ease";

    marker.title = `${seg.label.replace(/_/g, " ").toUpperCase()} (${formatTime(seg.start)} - ${formatTime(seg.end)})`;

    // Seek interaction
    marker.addEventListener("click", (e) => {
      e.stopPropagation();
      if (videoElement) {
        videoElement.currentTime = seg.start;
        if (typeof videoElement.setAttribute === "function") {
          videoElement.setAttribute("data-current-time", String(seg.start));
        }
        if (typeof videoElement.dispatchEvent === "function") {
          videoElement.dispatchEvent(new CustomEvent("concert-seek", { detail: { time: seg.start }, bubbles: true }));
        }
      }
    });

    marker.addEventListener("mouseenter", () => {
      marker.style.opacity = "1.0";
      marker.style.transform = "scaleY(1.2)";
    });

    marker.addEventListener("mouseleave", () => {
      marker.style.opacity = "0.75";
      marker.style.transform = "scaleY(1.0)";
    });

    overlayContainer.appendChild(marker);
  });

  // Attach ResizeObserver to dynamically update on player container changes (theater/fullscreen)
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      // Re-trigger layout calculations if width changes
      overlayContainer.style.width = "100%";
    });
    ro.observe(progressBar);
    overlayContainer._resizeObserver = ro;
  }

  progressBar.appendChild(overlayContainer);
  return overlayContainer;
}

/**
 * Recalculates and updates segment overlay when video duration changes.
 */
export function updateSegmentsOverlay(progressBar, segments, newDuration, videoElement = null) {
  return renderSegmentsOverlay(progressBar, segments, newDuration, videoElement);
}
