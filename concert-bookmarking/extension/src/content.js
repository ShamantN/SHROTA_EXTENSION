/**
 * YouTube Content Script:
 * - Single Page Application (SPA) lifecycle hook (yt-navigate-finish)
 * - Ad playback collision guard (.ad-showing / .ytp-ad-player-overlay)
 * - Overlay rendering and Scrubber synchronization
 * - Hotkeys and Action Button injection
 */

import { renderSegmentsOverlay, removeSegmentsOverlay } from "./overlay.js";
import { setupHotkeys } from "./hotkeys.js";
import { injectBookmarksButton, renderChapterDrawer } from "./ui.js";

console.log("[Concert Bookmarker] Content script loaded on:", typeof window !== "undefined" ? window.location.href : "unknown");

let currentSegments = [];
let currentVideoId = null;
let removeHotkeyListener = null;
let activeAdObserver = null;

/**
 * Extracts YouTube video ID from URL search string or location.
 */
export function getVideoId(searchString = window.location.search) {
  const params = new URLSearchParams(searchString);
  return params.get("v");
}

/**
 * Checks if YouTube is currently playing an advertisement.
 */
export function isAdPlaying(root = document) {
  if (!root) return false;
  const rootHasAd =
    root.classList?.contains("ad-showing") ||
    root.classList?.contains("ytp-ad-player-overlay");
  const adShowing = root.querySelector?.(".ad-showing");
  const adOverlay = root.querySelector?.(".ytp-ad-player-overlay");
  const adInterrupting = root.querySelector?.(".ytp-ad-player-overlay-instream-info");
  return Boolean(rootHasAd || adShowing || adOverlay || adInterrupting);
}

/**
 * Sets up a continuous MutationObserver to watch for mid-playback ads starting and stopping.
 */
export function setupContinuousAdObserver(playerContainer, onAdStart, onAdEnd) {
  if (!playerContainer || typeof MutationObserver === "undefined") return null;

  let wasAdPlaying = isAdPlaying(playerContainer);

  const observer = new MutationObserver(() => {
    const isNowAd = isAdPlaying(playerContainer);
    if (isNowAd !== wasAdPlaying) {
      wasAdPlaying = isNowAd;
      if (isNowAd) {
        onAdStart?.();
      } else {
        onAdEnd?.();
      }
    }
  });

  observer.observe(playerContainer, {
    attributes: true,
    attributeFilter: ["class"],
    childList: true,
    subtree: true,
  });

  return observer;
}

/**
 * Cleans up all previous DOM injections on SPA navigation.
 */
export function cleanupExistingInjections(root = document) {
  currentSegments = [];
  currentVideoId = null;

  if (activeAdObserver) {
    activeAdObserver.disconnect();
    activeAdObserver = null;
  }

  const progressBar = root.querySelector(".ytp-progress-bar");
  if (progressBar) {
    removeSegmentsOverlay(progressBar);
  }
  const btn = root.querySelector(".concert-bookmarks-btn");
  if (btn) btn.remove();

  const drawer = root.querySelector(".concert-chapter-drawer");
  if (drawer) drawer.remove();

  if (removeHotkeyListener) {
    removeHotkeyListener();
    removeHotkeyListener = null;
  }
}

/**
 * Helper to wait for dynamic YouTube elements to mount into the DOM.
 */
export async function waitForElement(selector, root = document, timeoutMs = 10000) {
  const existing = root.querySelector(selector);
  if (existing) return existing;

  return new Promise((resolve) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      const el = root.querySelector(selector);
      if (el) {
        clearInterval(interval);
        resolve(el);
      } else if (Date.now() - startTime > timeoutMs) {
        clearInterval(interval);
        resolve(null);
      }
    }, 200);
  });
}

/**
 * Coordinates fetching segments and rendering overlay if not in ad state.
 */
export async function initializeBookmarksForVideo(videoId, root = document) {
  if (!videoId) return;
  currentVideoId = videoId;

  const playerContainer = (await waitForElement(".html5-video-player", root)) || root;
  const progressBar = await waitForElement(".ytp-progress-bar", root);
  const videoElement = await waitForElement("video", root);

  // Ad guard: If ad is currently displaying, do not render overlay yet
  if (isAdPlaying(playerContainer)) {
    if (progressBar) removeSegmentsOverlay(progressBar);
    if (activeAdObserver) activeAdObserver.disconnect();
    activeAdObserver = setupContinuousAdObserver(
      playerContainer,
      () => {},
      () => {
        initializeBookmarksForVideo(videoId, root);
      }
    );
    return;
  }

  // Request segments from background service worker
  let response;
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    try {
      response = await chrome.runtime.sendMessage({
        action: "FETCH_SEGMENTS",
        videoId,
      });
      console.log("[CONTENT] Background response:", JSON.stringify(response));
    } catch (e) {
      console.warn("[Concert Bookmarker] Background message error:", e);
    }
  }

  if (response && response.status === "ready" && response.data?.segments) {
    currentSegments = response.data.segments;
    applyBookmarksToPlayer(progressBar, videoElement, currentSegments, root);
  } else {
    // Reset any previously cached segments in memory
    currentSegments = [];
    if (progressBar) {
      removeSegmentsOverlay(progressBar);
    }

    // If not auto-ready or not in allowlist, inject manual "Get Bookmarks" button
    const actionsBar = (await waitForElement("#top-row", root)) || root.querySelector("#actions") || root.querySelector("#menu");
    if (actionsBar) {
      injectBookmarksButton(actionsBar, async () => {
        const manualRes = await chrome.runtime.sendMessage({
          action: "FETCH_SEGMENTS",
          videoId,
        });
        if (manualRes && manualRes.data?.segments) {
          currentSegments = manualRes.data.segments;
          applyBookmarksToPlayer(progressBar, videoElement, currentSegments, root);
        }
      });
    }
  }
}

/**
 * Renders overlay, sets up hotkeys, and syncs duration changes.
 */
export function applyBookmarksToPlayer(progressBar, videoElement, segments, root = document) {
  if (!progressBar || !segments || segments.length === 0) return;

  const fallbackDuration = segments.reduce((max, s) => Math.max(max, Number(s.end) || 0), 0);
  const playerContainer = (root.querySelector && root.querySelector(".html5-video-player")) || root;

  const tryRender = () => {
    const rawDur = videoElement ? videoElement.duration : 0;
    const duration = !isNaN(rawDur) && rawDur > 0 ? rawDur : fallbackDuration;

    if (duration > 0 && !isAdPlaying(playerContainer) && !isAdPlaying(root)) {
      renderSegmentsOverlay(progressBar, segments, duration, videoElement);
    }
  };

  // Attempt immediate render
  tryRender();

  // Watch for dynamic mid-playback ads
  if (activeAdObserver) {
    activeAdObserver.disconnect();
    activeAdObserver = null;
  }
  activeAdObserver = setupContinuousAdObserver(
    playerContainer,
    () => {
      // Ad started: suppress overlay
      removeSegmentsOverlay(progressBar);
    },
    () => {
      // Ad ended: restore overlay
      tryRender();
    }
  );

  // Watch for duration changes / metadata load
  if (videoElement) {
    videoElement.removeEventListener("durationchange", tryRender);
    videoElement.addEventListener("durationchange", tryRender);
    videoElement.addEventListener("loadedmetadata", tryRender);
    videoElement.addEventListener("timeupdate", () => {
      if (!progressBar.querySelector(".concert-segments-overlay")) {
        tryRender();
      }
    });
  }

  // Setup hotkeys
  if (removeHotkeyListener) removeHotkeyListener();
  removeHotkeyListener = setupHotkeys(() => videoElement, () => segments);

  // Optionally inject quick chapter drawer
  const belowPlayer = root.querySelector("#meta") || root.querySelector("#secondary");
  if (belowPlayer) {
    renderChapterDrawer(belowPlayer, segments, (time) => {
      if (videoElement) {
        videoElement.currentTime = time;
        if (typeof videoElement.setAttribute === "function") {
          videoElement.setAttribute("data-current-time", String(time));
        }
        if (typeof videoElement.dispatchEvent === "function") {
          videoElement.dispatchEvent(new CustomEvent("concert-seek", { detail: { time }, bubbles: true }));
        }
      }
    });
  }
}

/**
 * Observes DOM mutations until ad classes disappear.
 */
export function observeAdTermination(playerContainer, onAdFinished) {
  if (!playerContainer || typeof MutationObserver === "undefined") return;

  const observer = new MutationObserver(() => {
    if (!isAdPlaying(playerContainer)) {
      observer.disconnect();
      onAdFinished();
    }
  });

  observer.observe(playerContainer, {
    attributes: true,
    attributeFilter: ["class"],
    childList: true,
    subtree: true,
  });
}

/**
 * Main lifecycle dispatcher on navigation.
 */
export function handleNavigation(root = document) {
  cleanupExistingInjections(root);
  const videoId = getVideoId();
  if (videoId) {
    initializeBookmarksForVideo(videoId, root);
  }
}

// Attach to YouTube SPA Navigation Event & direct initial load
if (typeof document !== "undefined") {
  // 1. Initial page load (direct URL navigation or refresh)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => handleNavigation(document));
  } else {
    handleNavigation(document);
  }

  // 2. YouTube SPA navigation hook
  document.addEventListener("yt-navigate-finish", () => handleNavigation(document));
  window.addEventListener("popstate", () => handleNavigation(document));

  // 3. Listen for push updates from background alarms
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === "SEGMENTS_UPDATED" && msg.videoId === currentVideoId) {
        currentSegments = msg.data.segments;
        const progressBar = document.querySelector(".ytp-progress-bar");
        const videoElement = document.querySelector("video");
        applyBookmarksToPlayer(progressBar, videoElement, currentSegments, document);
      }
    });
  }
}
