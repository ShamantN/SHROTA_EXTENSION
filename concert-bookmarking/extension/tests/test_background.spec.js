import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getCachedSegments,
  setCachedSegments,
  schedulePollingTask,
  handleFetchSegments,
  handleRuntimeMessage,
  CACHE_TTL_MS,
} from "../src/background.js";

// Storage Mock helper
function createStorageMock() {
  const store = {};
  return {
    get: vi.fn(async (key) => ({ [key]: store[key] })),
    set: vi.fn(async (obj) => Object.assign(store, obj)),
    remove: vi.fn(async (key) => delete store[key]),
    _store: store,
  };
}

// Alarms Mock helper
function createAlarmsMock() {
  const alarms = {};
  return {
    create: vi.fn((name, info) => {
      alarms[name] = info;
    }),
    _alarms: alarms,
  };
}

describe("Background Service Worker TTL & Caching", () => {
  let storage;
  let alarms;

  beforeEach(() => {
    storage = createStorageMock();
    alarms = createAlarmsMock();
  });

  it("returns cached segment data when within 24-hour TTL", async () => {
    const videoId = "vid-cache-1";
    const sampleData = { segments: [{ start: 0, end: 100, label: "alaap" }] };
    const now = 1000000;

    await setCachedSegments(storage, videoId, sampleData, now);

    // Query 1 hour later (well within 24h)
    const cached = await getCachedSegments(storage, videoId, now + 3600 * 1000);
    expect(cached).toEqual(sampleData);
  });

  it("expires and ignores cache when older than 24-hour TTL", async () => {
    const videoId = "vid-cache-2";
    const sampleData = { segments: [{ start: 0, end: 100, label: "alaap" }] };
    const now = 1000000;

    await setCachedSegments(storage, videoId, sampleData, now);

    // Query 25 hours later -> should be expired
    const expired = await getCachedSegments(storage, videoId, now + CACHE_TTL_MS + 1000);
    expect(expired).toBeNull();
  });

  it("persists polling task and schedules alarm on 202 Accepted", async () => {
    const videoId = "vid-processing";
    const state = await schedulePollingTask(storage, alarms, videoId, 15);

    expect(state.videoId).toBe(videoId);
    expect(state.pollAfterSeconds).toBe(15);

    expect(alarms.create).toHaveBeenCalledWith("poll_alarm_vid-processing", {
      delayInMinutes: 0.25,
    });
    expect(storage.set).toHaveBeenCalled();
  });

  it("handles fetch segments correctly across cache hit, 200 ready, and 202 processing", async () => {
    const videoId = "vid-fetch-test";
    const readyPayload = { videoId, status: "ready", segments: [] };

    // 1. Cache Miss -> 200 Network Fetch
    const fetch200 = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => readyPayload,
    });

    const res1 = await handleFetchSegments(storage, alarms, fetch200, videoId);
    expect(res1.source).toBe("network");
    expect(res1.status).toBe("ready");
    expect(fetch200).toHaveBeenCalledTimes(1);

    // 2. Immediate second request -> Cache Hit
    const res2 = await handleFetchSegments(storage, alarms, fetch200, videoId);
    expect(res2.source).toBe("cache");
    expect(res2.status).toBe("ready");
    expect(fetch200).toHaveBeenCalledTimes(1); // Fetch not called again!

    // 3. Processing video -> 202 Accepted
    const fetch202 = vi.fn().mockResolvedValue({
      status: 202,
      json: async () => ({ status: "processing", pollAfterSeconds: 10 }),
    });
    const resProcessing = await handleFetchSegments(storage, alarms, fetch202, "vid-proc");
    expect(resProcessing.status).toBe("processing");
    expect(alarms.create).toHaveBeenCalledWith("poll_alarm_vid-proc", expect.any(Object));
  });

  it("routes CLEAR_CACHE and clears stored item", async () => {
    const videoId = "vid-clear-me";
    await setCachedSegments(storage, videoId, { segments: [] });

    const msgResult = await handleRuntimeMessage(
      { action: "CLEAR_CACHE", videoId },
      storage,
      alarms,
      vi.fn()
    );
    expect(msgResult.status).toBe("cache_cleared");

    const cached = await getCachedSegments(storage, videoId);
    expect(cached).toBeNull();
  });
});
