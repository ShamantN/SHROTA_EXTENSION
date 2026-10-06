(() => {
  // src/overlay.js
  var TAXONOMY_COLORS = {
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
    tani_avartanam: "#3A0CA3"
  };
  var DEFAULT_COLOR = "#8E44AD";
  function getCategoryColor(label) {
    if (!label) return DEFAULT_COLOR;
    const key = label.toLowerCase().trim();
    return TAXONOMY_COLORS[key] || DEFAULT_COLOR;
  }
  function calculateSegmentGeometry(start, end, duration) {
    if (!duration || duration <= 0) {
      return { leftPercent: 0, widthPercent: 0 };
    }
    const safeStart = Math.max(0, Math.min(start, duration));
    const safeEnd = Math.max(safeStart, Math.min(end, duration));
    const leftPercent = safeStart / duration * 100;
    const rawWidthPercent = (safeEnd - safeStart) / duration * 100;
    const widthPercent = Math.max(0, Math.min(100 - leftPercent, rawWidthPercent));
    return {
      leftPercent: Number(leftPercent.toFixed(4)),
      widthPercent: Number(widthPercent.toFixed(4))
    };
  }
  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor(s % 3600 / 60);
    const secs = s % 60;
    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  function removeSegmentsOverlay(progressBar) {
    if (!progressBar) return;
    const existing = progressBar.querySelector(".concert-segments-overlay");
    if (existing) {
      if (existing._resizeObserver) {
        existing._resizeObserver.disconnect();
      }
      existing.remove();
    }
  }
  function renderSegmentsOverlay(progressBar, segments, duration, videoElement = null) {
    if (!progressBar || !segments || segments.length === 0 || !duration || duration <= 0) {
      return null;
    }
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
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        overlayContainer.style.width = "100%";
      });
      ro.observe(progressBar);
      overlayContainer._resizeObserver = ro;
    }
    progressBar.appendChild(overlayContainer);
    return overlayContainer;
  }

  // src/hotkeys.js
  function findNextSegment(currentTime, segments) {
    if (!segments || segments.length === 0) return null;
    const sorted = [...segments].sort((a, b) => a.start - b.start);
    for (const seg of sorted) {
      if (seg.start > currentTime + 0.5) {
        return seg;
      }
    }
    return null;
  }
  function findPreviousSegment(currentTime, segments) {
    if (!segments || segments.length === 0) return null;
    const sorted = [...segments].sort((a, b) => a.start - b.start);
    for (let i = sorted.length - 1; i >= 0; i--) {
      const seg = sorted[i];
      if (currentTime >= seg.start && currentTime <= seg.end) {
        if (currentTime - seg.start > 2) {
          return seg;
        } else if (i > 0) {
          return sorted[i - 1];
        } else {
          return seg;
        }
      }
      if (seg.start < currentTime - 0.5) {
        return seg;
      }
    }
    return sorted[0] || null;
  }
  function isTypingContext(target) {
    if (!target) return false;
    const tag = (target.tagName || "").toUpperCase();
    const isEditable = Boolean(target.isContentEditable) || target.getAttribute?.("contenteditable") === "true" || target.contentEditable === "true" || target.contentEditable === true;
    return tag === "INPUT" || tag === "TEXTAREA" || isEditable || Boolean(target.classList?.contains("yt-spec-input-shape"));
  }
  function setupHotkeys(getVideoElement, getSegments) {
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
      const currentTime = !isNaN(attrTime) ? attrTime : !isNaN(rawTime) ? rawTime : 0;
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

  // src/ui.js
  function injectBookmarksButton(container, onClick) {
    if (!container) return null;
    const existing = container.querySelector(".concert-bookmarks-btn");
    if (existing) existing.remove();
    const button = document.createElement("button");
    button.className = "concert-bookmarks-btn yt-spec-button-shape-next";
    button.innerHTML = `
    <span style="display: inline-flex; align-items: center; gap: 6px; font-weight: 500; font-size: 14px;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
      </svg>
      Get Concert Bookmarks
    </span>
  `;
    button.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
    button.style.color = "#FFFFFF";
    button.style.border = "1px solid rgba(255, 255, 255, 0.2)";
    button.style.borderRadius = "18px";
    button.style.padding = "6px 14px";
    button.style.cursor = "pointer";
    button.style.marginLeft = "8px";
    button.style.display = "inline-flex";
    button.style.alignItems = "center";
    button.style.transition = "background-color 0.2s ease";
    button.addEventListener("mouseenter", () => {
      button.style.backgroundColor = "rgba(255, 255, 255, 0.2)";
    });
    button.addEventListener("mouseleave", () => {
      button.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
    });
    button.addEventListener("click", (e) => {
      e.preventDefault();
      if (onClick) onClick();
    });
    container.appendChild(button);
    return button;
  }
  function renderChapterDrawer(container, segments, onSeek) {
    if (!container || !segments) return null;
    const existing = container.querySelector(".concert-chapter-drawer");
    if (existing) existing.remove();
    const drawer = document.createElement("div");
    drawer.className = "concert-chapter-drawer";
    drawer.style.backgroundColor = "#0F0F0F";
    drawer.style.border = "1px solid #272727";
    drawer.style.borderRadius = "8px";
    drawer.style.padding = "12px";
    drawer.style.marginTop = "12px";
    drawer.style.maxHeight = "240px";
    drawer.style.overflowY = "auto";
    const heading = document.createElement("div");
    heading.textContent = "Concert Movements & Bookmarks";
    heading.style.fontWeight = "600";
    heading.style.fontSize = "14px";
    heading.style.marginBottom = "8px";
    heading.style.color = "#FFFFFF";
    drawer.appendChild(heading);
    segments.forEach((seg) => {
      const item = document.createElement("div");
      item.className = "concert-chapter-item";
      item.style.display = "flex";
      item.style.justifyContent = "space-between";
      item.style.alignItems = "center";
      item.style.padding = "6px 8px";
      item.style.cursor = "pointer";
      item.style.borderRadius = "4px";
      item.style.transition = "background-color 0.15s ease";
      const colorDot = `<span style="display:inline-block; width:10px; height:10px; border-radius:50%; background-color:${getCategoryColor(seg.label)}; margin-right:8px;"></span>`;
      const labelSpan = `<span style="color:#F1F1F1; font-size:13px; font-weight:500;">${seg.label.replace(/_/g, " ").toUpperCase()}</span>`;
      const timeSpan = `<span style="color:#AAAAAA; font-size:12px;">${formatTime(seg.start)} - ${formatTime(seg.end)}</span>`;
      item.innerHTML = `<div style="display:flex; align-items:center;">${colorDot}${labelSpan}</div>${timeSpan}`;
      item.addEventListener("mouseenter", () => {
        item.style.backgroundColor = "#272727";
      });
      item.addEventListener("mouseleave", () => {
        item.style.backgroundColor = "transparent";
      });
      item.addEventListener("click", () => {
        if (onSeek) onSeek(seg.start);
      });
      drawer.appendChild(item);
    });
    container.appendChild(drawer);
    return drawer;
  }

  // src/content.js
  console.log("[Concert Bookmarker] Content script loaded on:", typeof window !== "undefined" ? window.location.href : "unknown");
  var currentSegments = [];
  var currentVideoId = null;
  var removeHotkeyListener = null;
  var activeAdObserver = null;
  function getVideoId(searchString = window.location.search) {
    const params = new URLSearchParams(searchString);
    return params.get("v");
  }
  function isAdPlaying(root = document) {
    if (!root) return false;
    const rootHasAd = root.classList?.contains("ad-showing") || root.classList?.contains("ytp-ad-player-overlay");
    const adShowing = root.querySelector?.(".ad-showing");
    const adOverlay = root.querySelector?.(".ytp-ad-player-overlay");
    const adInterrupting = root.querySelector?.(".ytp-ad-player-overlay-instream-info");
    return Boolean(rootHasAd || adShowing || adOverlay || adInterrupting);
  }
  function setupContinuousAdObserver(playerContainer, onAdStart, onAdEnd) {
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
      subtree: true
    });
    return observer;
  }
  function cleanupExistingInjections(root = document) {
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
  async function waitForElement(selector, root = document, timeoutMs = 1e4) {
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
  async function initializeBookmarksForVideo(videoId, root = document) {
    if (!videoId) return;
    currentVideoId = videoId;
    const playerContainer = await waitForElement(".html5-video-player", root) || root;
    const progressBar = await waitForElement(".ytp-progress-bar", root);
    const videoElement = await waitForElement("video", root);
    if (isAdPlaying(playerContainer)) {
      if (progressBar) removeSegmentsOverlay(progressBar);
      if (activeAdObserver) activeAdObserver.disconnect();
      activeAdObserver = setupContinuousAdObserver(
        playerContainer,
        () => {
        },
        () => {
          initializeBookmarksForVideo(videoId, root);
        }
      );
      return;
    }
    let response;
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      try {
        response = await chrome.runtime.sendMessage({
          action: "FETCH_SEGMENTS",
          videoId
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
      currentSegments = [];
      if (progressBar) {
        removeSegmentsOverlay(progressBar);
      }
      const actionsBar = await waitForElement("#top-row", root) || root.querySelector("#actions") || root.querySelector("#menu");
      if (actionsBar) {
        injectBookmarksButton(actionsBar, async () => {
          const manualRes = await chrome.runtime.sendMessage({
            action: "FETCH_SEGMENTS",
            videoId
          });
          if (manualRes && manualRes.data?.segments) {
            currentSegments = manualRes.data.segments;
            applyBookmarksToPlayer(progressBar, videoElement, currentSegments, root);
          }
        });
      }
    }
  }
  function applyBookmarksToPlayer(progressBar, videoElement, segments, root = document) {
    if (!progressBar || !segments || segments.length === 0) return;
    const fallbackDuration = segments.reduce((max, s) => Math.max(max, Number(s.end) || 0), 0);
    const playerContainer = root.querySelector && root.querySelector(".html5-video-player") || root;
    const tryRender = () => {
      const rawDur = videoElement ? videoElement.duration : 0;
      const duration = !isNaN(rawDur) && rawDur > 0 ? rawDur : fallbackDuration;
      if (duration > 0 && !isAdPlaying(playerContainer) && !isAdPlaying(root)) {
        renderSegmentsOverlay(progressBar, segments, duration, videoElement);
      }
    };
    tryRender();
    if (activeAdObserver) {
      activeAdObserver.disconnect();
      activeAdObserver = null;
    }
    activeAdObserver = setupContinuousAdObserver(
      playerContainer,
      () => {
        removeSegmentsOverlay(progressBar);
      },
      () => {
        tryRender();
      }
    );
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
    if (removeHotkeyListener) removeHotkeyListener();
    removeHotkeyListener = setupHotkeys(() => videoElement, () => segments);
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
  function observeAdTermination(playerContainer, onAdFinished) {
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
      subtree: true
    });
  }
  function handleNavigation(root = document) {
    cleanupExistingInjections(root);
    const videoId = getVideoId();
    if (videoId) {
      initializeBookmarksForVideo(videoId, root);
    }
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => handleNavigation(document));
    } else {
      handleNavigation(document);
    }
    document.addEventListener("yt-navigate-finish", () => handleNavigation(document));
    window.addEventListener("popstate", () => handleNavigation(document));
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
})();
