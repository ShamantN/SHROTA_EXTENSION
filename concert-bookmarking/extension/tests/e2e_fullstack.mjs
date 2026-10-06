import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_PATH = path.resolve(__dirname, "..");
const FIXTURE_PATH = path.resolve(__dirname, "fixtures", "mock_youtube.html");

const PORT = 3456;
const BACKEND_URL = "http://127.0.0.1:8000";

function startMockServer() {
  const htmlContent = fs.readFileSync(FIXTURE_PATH, "utf-8");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(htmlContent);
  });
  return new Promise((resolve) => {
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`[TEST SERVER] Mock YouTube fixture running on http://127.0.0.1:${PORT}`);
      resolve(server);
    });
  });
}

async function verifyBackendAlive() {
  const res = await fetch(`${BACKEND_URL}/healthz`).catch((err) => null);
  if (!res || res.status !== 200) {
    throw new Error(`FastAPI backend is NOT reachable at ${BACKEND_URL}/healthz! Please ensure uvicorn is running.`);
  }
  const data = await res.json();
  console.log(`[BACKEND HEALTHCHECK] OK:`, data);
}

async function runFullStackIntegrationTest() {
  console.log("======================================================================");
  console.log("STARTING FULL-STACK PLAYWRIGHT CHROMIUM INTEGRATION TEST");
  console.log("======================================================================");

  await verifyBackendAlive();
  const server = await startMockServer();
  const tmpUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-fullstack-profile-"));

  let browserContext;
  try {
    console.log(`[1] Launching Chromium with extension loaded from:\n    ${EXTENSION_PATH}`);
    browserContext = await chromium.launchPersistentContext(tmpUserDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        `--no-sandbox`,
        `--disable-setuid-sandbox`,
      ],
      viewport: { width: 1280, height: 800 },
    });

    let [background] = browserContext.serviceWorkers();
    if (!background) {
      background = await browserContext.waitForEvent("serviceworker", { timeout: 4000 }).catch(() => null);
    }
    if (!background) {
      throw new Error("Extension background service worker failed to load!");
    }
    console.log(`    [SERVICE WORKER LOADED]: ${background.url()}`);

    const page = await browserContext.newPage();
    page.on("console", (msg) => console.log(`    [BROWSER CONSOLE]`, msg.text()));

    // -----------------------------------------------------------------------
    // CHECK 1: Live Fetch & Scrubber Overlay Injection
    // -----------------------------------------------------------------------
    console.log("\n[CHECK 1] Live Backend Fetch & Progress Bar Overlay Injection:");
    const testUrl = `http://127.0.0.1:${PORT}/watch?v=ed4SIvGjqNI`;
    await page.goto(testUrl, { waitUntil: "domcontentloaded" });

    const overlayLocator = page.locator(".concert-segments-overlay");
    await overlayLocator.waitFor({ state: "attached", timeout: 8000 });

    const markerCount = await page.locator(".concert-segment-marker").count();
    console.log(`    --> Live fetch successful! Rendered ${markerCount} segments.`);
    if (markerCount !== 4) {
      throw new Error(`Expected 4 markers, got ${markerCount}`);
    }

    // -----------------------------------------------------------------------
    // CHECK 2: Local Storage TTL Caching (chrome.storage.local)
    // -----------------------------------------------------------------------
    console.log("\n[CHECK 2] Verifying chrome.storage.local 24h TTL Caching:");
    const cacheEntry = await background.evaluate(async () => {
      const res = await chrome.storage.local.get("segments_ed4SIvGjqNI");
      return res["segments_ed4SIvGjqNI"];
    });

    console.log(`    --> Storage entry found:`, cacheEntry ? "YES" : "NO");
    if (!cacheEntry || !cacheEntry.cachedAt || !cacheEntry.data) {
      throw new Error("Segments were not cached in chrome.storage.local!");
    }
    console.log(`    --> Cached timestamp: ${new Date(cacheEntry.cachedAt).toISOString()}`);
    console.log(`    --> Cached version: ${cacheEntry.data.version}`);

    // Verify subsequent fetch is served directly from cache (source: "cache")
    const secondFetch = await background.evaluate(async () => {
      return await self.__handleExtensionMessage({ action: "FETCH_SEGMENTS", videoId: "ed4SIvGjqNI" });
    });

    console.log(`    --> Second fetch source: "${secondFetch.source}" (Expected: "cache")`);
    if (secondFetch.source !== "cache") {
      throw new Error(`Expected source "cache", got "${secondFetch.source}"!`);
    }

    // -----------------------------------------------------------------------
    // CHECK 3: Crowd Edit Submission -> Version Bump -> Cache Purge
    // -----------------------------------------------------------------------
    console.log("\n[CHECK 3] Submitting Crowd Revision as Trusted Contributor:");
    const editPayload = {
      action: "SUBMIT_CROWD_EDIT",
      videoId: "ed4SIvGjqNI",
      payload: {
        clientUuid: "trusted_guru_42",
        segments: [
          { start: 0.0, end: 120.0, label: "alaap", confidence: 0.99 },
          { start: 120.0, end: 240.0, label: "jod", confidence: 0.99 },
          { start: 240.0, end: 400.0, label: "vilambit_bandish", confidence: 0.99 },
          { start: 400.0, end: 582.0, label: "drut_bandish", confidence: 0.99 },
        ],
      },
    };

    const editResponse = await background.evaluate(async (payload) => {
      return await self.__handleExtensionMessage(payload);
    }, editPayload);

    console.log(`    --> Edit response status: ${editResponse.status}`);
    console.log(`    --> Edit response data:`, JSON.stringify(editResponse.data));
    if (editResponse.status !== 200 || editResponse.data.status !== "promoted_immediately") {
      throw new Error(`Crowd edit was not promoted immediately! Response: ${JSON.stringify(editResponse)}`);
    }

    const newVersion = editResponse.data.version;
    console.log(`    --> Promoted to canonical version: ${newVersion}`);

    // Verify local cache for ed4SIvGjqNI was purged on edit
    const cacheAfterEdit = await background.evaluate(async () => {
      const res = await chrome.storage.local.get("segments_ed4SIvGjqNI");
      return res["segments_ed4SIvGjqNI"];
    });
    console.log(`    --> Cache purged after edit: ${cacheAfterEdit === undefined ? "YES" : "NO"}`);
    if (cacheAfterEdit !== undefined) {
      throw new Error("Local cache was not purged upon crowd edit submission!");
    }

    // Fetch again: Should hit network, get newVersion, and re-cache
    const freshFetch = await background.evaluate(async () => {
      return await self.__handleExtensionMessage({ action: "FETCH_SEGMENTS", videoId: "ed4SIvGjqNI" });
    });

    console.log(`    --> Fresh fetch source: "${freshFetch.source}", version: ${freshFetch.data?.version}`);
    if (freshFetch.source !== "network" || freshFetch.data?.version !== newVersion) {
      throw new Error(`Fresh fetch failed to retrieve new version ${newVersion}!`);
    }

    // -----------------------------------------------------------------------
    // CHECK 4: Moderation Lock Enforcement (Strict 403 Forbidden)
    // -----------------------------------------------------------------------
    console.log("\n[CHECK 4] Testing Moderation Lock Guard on Locked Video:");
    const lockedEditPayload = {
      action: "SUBMIT_CROWD_EDIT",
      videoId: "locked_concert_999",
      payload: {
        clientUuid: "trusted_guru_42",
        segments: [{ start: 0.0, end: 1800.0, label: "alaap" }],
      },
    };

    const lockedEditResponse = await background.evaluate(async (payload) => {
      return await self.__handleExtensionMessage(payload);
    }, lockedEditPayload);

    console.log(`    --> Locked edit response status: ${lockedEditResponse.status}`);
    console.log(`    --> Detail: "${lockedEditResponse.data?.detail}"`);
    if (lockedEditResponse.status !== 403) {
      throw new Error(`Expected 403 Forbidden on locked video, got ${lockedEditResponse.status}`);
    }

    // -----------------------------------------------------------------------
    // CHECK 5: Untrusted Contributor Rejection (Strict 403 Forbidden)
    // -----------------------------------------------------------------------
    console.log("\n[CHECK 5] Testing Untrusted Contributor Submission Gating:");
    const untrustedEditPayload = {
      action: "SUBMIT_CROWD_EDIT",
      videoId: "ed4SIvGjqNI",
      payload: {
        clientUuid: "untrusted_spammer_99",
        segments: [{ start: 0.0, end: 582.0, label: "alaap" }],
      },
    };

    const untrustedEditResponse = await background.evaluate(async (payload) => {
      return await self.__handleExtensionMessage(payload);
    }, untrustedEditPayload);

    console.log(`    --> Untrusted edit response status: ${untrustedEditResponse.status}`);
    console.log(`    --> Detail: "${untrustedEditResponse.data?.detail}"`);
    if (untrustedEditResponse.status !== 403) {
      throw new Error(`Expected 403 Forbidden for untrusted contributor, got ${untrustedEditResponse.status}`);
    }

    console.log("\n======================================================================");
    console.log("ALL FULL-STACK INTEGRATION VERIFICATION CHECKS PASSED WITH ZERO DEFECTS!");
    console.log("======================================================================\n");
  } finally {
    if (browserContext) {
      await browserContext.close();
    }
    server.close();
    try {
      fs.rmSync(tmpUserDataDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

runFullStackIntegrationTest().catch((err) => {
  console.error("\n[FULL-STACK INTEGRATION TEST FAILED]:", err);
  process.exit(1);
});
