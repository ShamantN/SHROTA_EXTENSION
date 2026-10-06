import { describe, it, expect, beforeEach } from "vitest";
import {
  calculateSegmentGeometry,
  getCategoryColor,
  formatTime,
  renderSegmentsOverlay,
  removeSegmentsOverlay,
} from "../src/overlay.js";

describe("Overlay Math & Geometry Engine", () => {
  it("calculates exact percentage boundaries for arbitrary start/end/duration pairs", () => {
    // 0 to 60s in a 300s video -> left: 0%, width: 20%
    const geom1 = calculateSegmentGeometry(0, 60, 300);
    expect(geom1.leftPercent).toBe(0);
    expect(geom1.widthPercent).toBe(20);

    // 150 to 225s in a 300s video -> left: 50%, width: 25%
    const geom2 = calculateSegmentGeometry(150, 225, 300);
    expect(geom2.leftPercent).toBe(50);
    expect(geom2.widthPercent).toBe(25);

    // Arbitrary non-round values
    const geom3 = calculateSegmentGeometry(33.33, 99.99, 3600);
    expect(geom3.leftPercent).toBeCloseTo(0.9258, 2);
    expect(geom3.widthPercent).toBeCloseTo(1.8517, 2);
  });

  it("handles zero, negative, or invalid durations gracefully without NaN/Infinity", () => {
    const zeroDur = calculateSegmentGeometry(10, 50, 0);
    expect(zeroDur.leftPercent).toBe(0);
    expect(zeroDur.widthPercent).toBe(0);

    const negDur = calculateSegmentGeometry(10, 50, -100);
    expect(negDur.leftPercent).toBe(0);
    expect(negDur.widthPercent).toBe(0);
  });

  it("clamps boundaries when start < 0 or end > duration", () => {
    const geom = calculateSegmentGeometry(-20, 450, 300);
    expect(geom.leftPercent).toBe(0);
    expect(geom.widthPercent).toBe(100);
  });

  it("maps taxonomy keys to correct color codes and handles fallback", () => {
    expect(getCategoryColor("alaap")).toBe("#FF6B6B");
    expect(getCategoryColor("jod")).toBe("#FFA07A");
    expect(getCategoryColor("kriti")).toBe("#2A9D8F");
    expect(getCategoryColor("unknown_label")).toBe("#8E44AD");
  });

  it("formats timestamps into MM:SS and HH:MM:SS", () => {
    expect(formatTime(45)).toBe("00:45");
    expect(formatTime(125)).toBe("02:05");
    expect(formatTime(3665)).toBe("1:01:05");
  });
});

describe("Overlay DOM Rendering & Lifecycle", () => {
  let progressBar;
  let video;

  beforeEach(() => {
    document.body.innerHTML = "";
    progressBar = document.createElement("div");
    progressBar.className = "ytp-progress-bar";
    document.body.appendChild(progressBar);

    video = document.createElement("video");
    Object.defineProperty(video, "duration", { value: 600, writable: true, configurable: true });
    document.body.appendChild(video);
  });

  it("renders segment markers into progress bar with correct styles and data attributes", () => {
    const segments = [
      { start: 0, end: 120, label: "alaap" },
      { start: 120, end: 360, label: "jod" },
      { start: 360, end: 600, label: "jhala" },
    ];

    const overlay = renderSegmentsOverlay(progressBar, segments, 600, video);
    expect(overlay).not.toBeNull();
    expect(progressBar.querySelector(".concert-segments-overlay")).toBe(overlay);

    const markers = overlay.querySelectorAll(".concert-segment-marker");
    expect(markers.length).toBe(3);

    expect(markers[0].dataset.label).toBe("alaap");
    expect(markers[0].style.left).toBe("0%");
    expect(markers[0].style.width).toBe("20%");

    expect(markers[1].dataset.label).toBe("jod");
    expect(markers[1].style.left).toBe("20%");
    expect(markers[1].style.width).toBe("40%");

    expect(markers[2].dataset.label).toBe("jhala");
    expect(markers[2].style.left).toBe("60%");
    expect(markers[2].style.width).toBe("40%");
  });

  it("removes existing overlay before injecting new one", () => {
    const segments = [{ start: 0, end: 100, label: "alaap" }];
    renderSegmentsOverlay(progressBar, segments, 600, video);
    expect(progressBar.querySelectorAll(".concert-segments-overlay").length).toBe(1);

    renderSegmentsOverlay(progressBar, segments, 600, video);
    expect(progressBar.querySelectorAll(".concert-segments-overlay").length).toBe(1);

    removeSegmentsOverlay(progressBar);
    expect(progressBar.querySelectorAll(".concert-segments-overlay").length).toBe(0);
  });

  it("updates segment widths when video duration changes", () => {
    const segments = [{ start: 0, end: 100, label: "alaap" }];
    // At duration 200s, 100s is 50%
    renderSegmentsOverlay(progressBar, segments, 200, video);
    let marker = progressBar.querySelector(".concert-segment-marker");
    expect(marker.style.width).toBe("50%");

    // Duration expands to 400s -> 100s becomes 25%
    renderSegmentsOverlay(progressBar, segments, 400, video);
    marker = progressBar.querySelector(".concert-segment-marker");
    expect(marker.style.width).toBe("25%");
  });
});
