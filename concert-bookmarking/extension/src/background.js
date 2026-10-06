/**
 * Manifest V3 Background Service Worker:
 * - TTL-managed local caching (24-hour expiry)
 * - Ephemeral polling guard via chrome.alarms (no persistent setInterval)
 * - Message routing for content script requests
 */

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const API_BASE_URL = "http://localhost:8000";

/**
 * Checks cache for valid unexpired segments.
 */
export async function getCachedSegments(storage, videoId, now = Date.now()) {
  const key = `segments_${videoId}`;
  const record = await storage.get(key);
  const entry = record[key];

  if (entry && entry.cachedAt && now - entry.cachedAt < CACHE_TTL_MS) {
    return entry.data;
  }
  return null;
}

/**
 * Stores segment data into local storage with timestamp.
 */
export async function setCachedSegments(storage, videoId, data, now = Date.now()) {
  const key = `segments_${videoId}`;
  await storage.set({
    [key]: {
      cachedAt: now,
      data,
    },
  });
}

/**
 * Persists polling state and schedules alarm for 202 Accepted.
 */
export async function schedulePollingTask(storage, alarms, videoId, pollAfterSeconds = 10) {
  const taskKey = `poll_${videoId}`;
  const state = {
    videoId,
    pollAfterSeconds,
    scheduledAt: Date.now(),
    attempts: 0,
  };
  await storage.set({ [taskKey]: state });

  // Chrome alarms require delay in minutes
  const delayInMinutes = Math.max(0.1, pollAfterSeconds / 60);
  alarms.create(`poll_alarm_${videoId}`, { delayInMinutes });
  return state;
}

/**
 * Handles incoming segment fetch requests.
 */
export async function handleFetchSegments(storage, alarms, fetchFn, videoId) {
  // 1. Check TTL cache
  const cached = await getCachedSegments(storage, videoId);
  if (cached) {
    return { source: "cache", status: "ready", data: cached };
  }

  // 2. Network fetch
  try {
    const res = await fetchFn(`${API_BASE_URL}/v1/segments/${videoId}`, {
      cache: "no-cache",
    });

    if (res.status === 200) {
      const data = await res.json();
      await setCachedSegments(storage, videoId, data);
      return { source: "network", status: "ready", data };
    }

    if (res.status === 202) {
      const data = await res.json();
      await schedulePollingTask(storage, alarms, videoId, data.pollAfterSeconds || 10);
      return { source: "network", status: "processing", pollAfterSeconds: data.pollAfterSeconds || 10 };
    }

    if (res.status === 422) {
      const data = await res.json();
      return { source: "network", status: "rejected", reason: data.reason };
    }

    if (res.status === 404) {
      return { source: "network", status: "not_found" };
    }

    return { source: "network", status: "error", code: res.status };
  } catch (err) {
    return { source: "network", status: "network_error", error: String(err) };
  }
}

/**
 * Centralized message router.
 */
export async function handleRuntimeMessage(message, storage, alarms, fetchFn) {
  const { action, videoId, payload } = message || {};

  switch (action) {
    case "FETCH_SEGMENTS":
      return await handleFetchSegments(storage, alarms, fetchFn, videoId);

    case "CLEAR_CACHE":
      await storage.remove(`segments_${videoId}`);
      return { status: "cache_cleared" };

    case "SUBMIT_CROWD_EDIT": {
      const res = await fetchFn(`${API_BASE_URL}/v1/segments/${videoId}/edits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      // Invalidate local cache on edit
      await storage.remove(`segments_${videoId}`);
      return { status: res.status, data };
    }

    case "SUBMIT_VOTE": {
      const res = await fetchFn(`${API_BASE_URL}/v1/segments/${videoId}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      return { status: res.status, data };
    }

    default:
      return { status: "unknown_action" };
  }
}

// Runtime listeners setup for browser environment
if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  const storageAdapter = {
    get: (key) => chrome.storage.local.get(key),
    set: (obj) => chrome.storage.local.set(obj),
    remove: (key) => chrome.storage.local.remove(key),
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("[BACKGROUND] Received message:", JSON.stringify(message));
    handleRuntimeMessage(message, storageAdapter, chrome.alarms, fetch)
      .then((res) => {
        console.log("[BACKGROUND] Sending response:", JSON.stringify(res));
        sendResponse(res);
      })
      .catch((err) => {
        console.error("[BACKGROUND] Error handling message:", err);
        sendResponse({ status: "error", error: String(err) });
      });
    return true; // Keep message channel open for async response
  });

  if (typeof self !== "undefined") {
    self.__handleExtensionMessage = (message) =>
      handleRuntimeMessage(message, storageAdapter, chrome.alarms, fetch);
  }

  if (chrome.alarms?.onAlarm) {
    chrome.alarms.onAlarm.addListener(async (alarm) => {
      if (alarm.name.startsWith("poll_alarm_")) {
        const videoId = alarm.name.replace("poll_alarm_", "");
        const result = await handleFetchSegments(storageAdapter, chrome.alarms, fetch, videoId);
        if (result.status === "ready") {
          // Notify any open tab
          chrome.tabs?.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, {
                action: "SEGMENTS_UPDATED",
                videoId,
                data: result.data,
              });
            }
          });
        }
      }
    });
  }
}
