import { describe, it, expect, beforeEach } from "vitest";
import {
  isAdPlaying,
  getVideoId,
  cleanupExistingInjections,
} from "../src/content.js";
import {
  findNextSegment,
  findPreviousSegment,
  isTypingContext,
} from "../src/hotkeys.js";

describe("Content Script Lifecycle & Ad Guard", () => {
  let container;

  beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    container.className = "html5-video-player";
    document.body.appendChild(container);
  });

  it("detects when an advertisement is currently playing", () => {
    expect(isAdPlaying(container)).toBe(false);

    // YouTube ad class injected
    container.classList.add("ad-showing");
    expect(isAdPlaying(container)).toBe(true);

    container.classList.remove("ad-showing");
    expect(isAdPlaying(container)).toBe(false);

    // Overlay ad banner
    const adOverlay = document.createElement("div");
    adOverlay.className = "ytp-ad-player-overlay";
    container.appendChild(adOverlay);
    expect(isAdPlaying(container)).toBe(true);
  });

  it("extracts YouTube video IDs from search query parameter", () => {
    expect(getVideoId("?v=dQw4w9WgXcQ&t=42s")).toBe("dQw4w9WgXcQ");
    expect(getVideoId("?v=abc_123-XYZ")).toBe("abc_123-XYZ");
    expect(getVideoId("?feature=share")).toBeNull();
  });

  it("cleans up existing DOM injections on navigation", () => {
    const progressBar = document.createElement("div");
    progressBar.className = "ytp-progress-bar";
    const overlay = document.createElement("div");
    overlay.className = "concert-segments-overlay";
    progressBar.appendChild(overlay);
    container.appendChild(progressBar);

    const btn = document.createElement("button");
    btn.className = "concert-bookmarks-btn";
    container.appendChild(btn);

    const drawer = document.createElement("div");
    drawer.className = "concert-chapter-drawer";
    container.appendChild(drawer);

    expect(container.querySelector(".concert-segments-overlay")).not.toBeNull();
    expect(container.querySelector(".concert-bookmarks-btn")).not.toBeNull();
    expect(container.querySelector(".concert-chapter-drawer")).not.toBeNull();

    cleanupExistingInjections(container);

    expect(container.querySelector(".concert-segments-overlay")).toBeNull();
    expect(container.querySelector(".concert-bookmarks-btn")).toBeNull();
    expect(container.querySelector(".concert-chapter-drawer")).toBeNull();
  });
});

describe("Hotkey Navigation Math & Keyboard Context", () => {
  const segments = [
    { start: 0, end: 120, label: "alaap" },
    { start: 120, end: 300, label: "jod" },
    { start: 300, end: 500, label: "jhala" },
  ];

  it("findNextSegment seeks strictly to the next future segment start", () => {
    // Current time at 50s -> next is jod at 120s
    const next1 = findNextSegment(50, segments);
    expect(next1).toEqual(segments[1]);

    // Current time at 250s -> next is jhala at 300s
    const next2 = findNextSegment(250, segments);
    expect(next2).toEqual(segments[2]);

    // Current time at 450s -> no next segment
    const next3 = findNextSegment(450, segments);
    expect(next3).toBeNull();
  });

  it("findPreviousSegment restarts current segment or jumps to preceding segment boundary", () => {
    // Current time at 150s (30s into jod 120-300s, > 2s) -> restarts jod at 120s
    const prev1 = findPreviousSegment(150, segments);
    expect(prev1).toEqual(segments[1]);

    // Current time at 121s (only 1s into jod, <= 2s) -> jumps to preceding segment alaap at 0s
    const prev2 = findPreviousSegment(121, segments);
    expect(prev2).toEqual(segments[0]);

    // Current time at 301s (1s into jhala) -> jumps to jod at 120s
    const prev3 = findPreviousSegment(301, segments);
    expect(prev3).toEqual(segments[1]);
  });

  it("detects typing contexts to prevent hijacking hotkeys in comment/search fields", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editableDiv = document.createElement("div");
    editableDiv.contentEditable = "true";
    const normalDiv = document.createElement("div");

    expect(isTypingContext(input)).toBe(true);
    expect(isTypingContext(textarea)).toBe(true);
    expect(isTypingContext(editableDiv)).toBe(true);
    expect(isTypingContext(normalDiv)).toBe(false);
  });
});
