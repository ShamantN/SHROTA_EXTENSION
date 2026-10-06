/**
 * User Interface components for YouTube Concert Bookmarker:
 * - "Get Bookmarks" trigger button in YouTube action bar
 * - Interactive Scrubber Tooltip
 * - Bookmark Chapter Drawer
 */

import { formatTime, getCategoryColor } from "./overlay.js";

/**
 * Creates and injects the "Get Bookmarks" action button into YouTube metadata bar.
 */
export function injectBookmarksButton(container, onClick) {
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

/**
 * Creates an interactive floating tooltip element for scrubber hovering.
 */
export function createScrubberTooltip() {
  let tooltip = document.querySelector(".concert-scrubber-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "concert-scrubber-tooltip";
    tooltip.style.position = "absolute";
    tooltip.style.bottom = "120%";
    tooltip.style.padding = "4px 8px";
    tooltip.style.borderRadius = "4px";
    tooltip.style.backgroundColor = "rgba(15, 15, 15, 0.95)";
    tooltip.style.color = "#FFFFFF";
    tooltip.style.fontSize = "12px";
    tooltip.style.fontWeight = "500";
    tooltip.style.pointerEvents = "none";
    tooltip.style.zIndex = "100";
    tooltip.style.display = "none";
    tooltip.style.boxShadow = "0 2px 6px rgba(0,0,0,0.5)";
    document.body.appendChild(tooltip);
  }
  return tooltip;
}

/**
 * Creates and renders a chapter list drawer for bookmark quick-seeking.
 */
export function renderChapterDrawer(container, segments, onSeek) {
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
