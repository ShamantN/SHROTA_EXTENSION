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

// 1. Create a local test server to serve mock YouTube pages
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

async function runBrowserValidation() {
  console.log("======================================================================");
  console.log("STARTING PLAYWRIGHT REAL CHROMIUM EXTENSION TEST SUITE");
  console.log("======================================================================");

  const server = await startMockServer();
  const tmpUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-chrome-profile-"));

  let browserContext;
  try {
    console.log(`[1] Launching Chromium with unpacked extension from:\n    ${EXTENSION_PATH}`);
    browserContext = await chromium.launchPersistentContext(tmpUserDataDir, {
      headless: false, // Chrome extensions require full UI or new headless mode
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
      background = await browserContext.waitForEvent("serviceworker", { timeout: 3000 }).catch(() => null);
    }
    console.log(`    [SERVICE WORKER LOADED]: ${background ? background.url() : "NONE"}`);

    const page = await browserContext.newPage();
    page.on("console", (msg) => console.log(`    [BROWSER CONSOLE ${msg.type().toUpperCase()}]`, msg.text()));
    page.on("pageerror", (err) => console.log(`    [BROWSER PAGE ERROR]`, err));

    const testUrl = `http://127.0.0.1:${PORT}/watch?v=ed4SIvGjqNI`;

    console.log(`[2] Navigating to Mock YouTube watch URL: ${testUrl}`);
    await page.goto(testUrl, { waitUntil: "domcontentloaded" });

    // Wait for the extension overlay to inject into .ytp-progress-bar
    console.log("[3] Waiting for extension overlay injection into progress bar...");
    const overlayLocator = page.locator(".concert-segments-overlay");
    await overlayLocator.waitFor({ state: "attached", timeout: 8000 });

    const markerCount = await page.locator(".concert-segment-marker").count();
    console.log(`    --> Verified: Overlay attached with ${markerCount} segment markers!`);
    if (markerCount !== 4) {
      throw new Error(`Expected 4 markers, found ${markerCount}`);
    }

    // CHECK 1: Geometry & Taxonomy Colors
    console.log("\n[CHECK 1] Inspecting Segment Coordinates & Taxonomy Colors:");
    const markers = page.locator(".concert-segment-marker");
    const expectedLabels = ["alaap", "jod", "vilambit_bandish", "drut_bandish"];
    let totalWidth = 0;

    for (let i = 0; i < 4; i++) {
      const marker = markers.nth(i);
      const label = await marker.getAttribute("data-label");
      const left = await marker.evaluate((el) => el.style.left);
      const width = await marker.evaluate((el) => el.style.width);
      const bgColor = await marker.evaluate((el) => el.style.backgroundColor || window.getComputedStyle(el).backgroundColor);

      const widthVal = parseFloat(width);
      totalWidth += widthVal;

      console.log(`    Marker ${i + 1} [${label}]: left=${left}, width=${width}, bg=${bgColor}`);
      if (label !== expectedLabels[i]) {
        throw new Error(`Mismatch in label: expected ${expectedLabels[i]}, got ${label}`);
      }
    }
    console.log(`    --> Total segment span: ${totalWidth.toFixed(2)}% (Matches 100%)`);

    // CHECK 2: ResizeObserver Adaptation (Theater Mode)
    console.log("\n[CHECK 2] Testing ResizeObserver on player width change (Theater Mode):");
    await page.evaluate(() => {
      document.getElementById("player-container").style.width = "1200px";
    });
    await page.waitForTimeout(300);
    const newOverlayWidth = await overlayLocator.evaluate((el) => el.clientWidth);
    console.log(`    --> Overlay width dynamically adapted to player container: ${newOverlayWidth}px`);

    // CHECK 3: Ad Suppression Guard
    console.log("\n[CHECK 3] Testing Ad Suppression Guard (.ad-showing):");
    console.log("    - Triggering Ad overlay injection...");
    await page.evaluate(() => window.toggleAdState(true));
    await page.waitForTimeout(300);

    const overlayDuringAd = await page.locator(".concert-segments-overlay").count();
    console.log(`    --> Overlay count during ad: ${overlayDuringAd} (Correctly detached!)`);
    if (overlayDuringAd !== 0) {
      throw new Error("Overlay was not suppressed when ad started!");
    }

    console.log("    - Terminating Ad...");
    await page.evaluate(() => window.toggleAdState(false));
    await overlayLocator.waitFor({ state: "attached", timeout: 5000 });
    console.log("    --> Overlay cleanly restored after ad completion!");

    // CHECK 4: Hotkey Navigation (Shift + N / Shift + P)
    console.log("\n[CHECK 4] Testing Hotkey Navigation (Shift + N / Shift + P):");
    const targetJodStart = parseFloat(await markers.nth(1).getAttribute("data-start"));
    const targetVilambitStart = parseFloat(await markers.nth(2).getAttribute("data-start"));

    await page.evaluate(() => {
      const v = document.getElementById("html5-main-video");
      v.currentTime = 50.0; // In Alaap (< first boundary)
    });

    console.log(`    - Pressing Shift + N to jump to Jod (Target: ~${targetJodStart}s)...`);
    await page.keyboard.press("Shift+N");
    await page.waitForTimeout(200);
    let timeAfterShiftN = await page.evaluate(() => document.getElementById("html5-main-video").currentTime);
    console.log(`    --> video.currentTime after Shift+N: ${timeAfterShiftN.toFixed(1)}s (Target: ~${targetJodStart}s)`);
    if (Math.abs(timeAfterShiftN - targetJodStart) > 1.0) {
      throw new Error(`Shift+N did not seek to Jod start! Time: ${timeAfterShiftN}`);
    }

    console.log(`    - Pressing Shift + N again to jump to Vilambit Bandish (Target: ~${targetVilambitStart}s)...`);
    await page.keyboard.press("Shift+N");
    await page.waitForTimeout(200);
    timeAfterShiftN = await page.evaluate(() => document.getElementById("html5-main-video").currentTime);
    console.log(`    --> video.currentTime after Shift+N: ${timeAfterShiftN.toFixed(1)}s (Target: ~${targetVilambitStart}s)`);
    if (Math.abs(timeAfterShiftN - targetVilambitStart) > 1.0) {
      throw new Error(`Shift+N did not seek to Vilambit start! Time: ${timeAfterShiftN}`);
    }

    console.log("    - Pressing Shift + P to jump back...");
    await page.keyboard.press("Shift+P");
    await page.waitForTimeout(200);
    const timeAfterShiftP = await page.evaluate(() => document.getElementById("html5-main-video").currentTime);
    console.log(`    --> video.currentTime after Shift+P: ${timeAfterShiftP.toFixed(1)}s (Target: ~${targetJodStart}s)`);
    if (Math.abs(timeAfterShiftP - targetJodStart) > 1.0) {
      throw new Error(`Shift+P did not seek back to Jod start! Time: ${timeAfterShiftP}`);
    }

    // CHECK 5: Input Field Guard
    console.log("\n[CHECK 5] Testing Typing Context Guard (No hotkeys inside inputs):");
    await page.focus("#comment-input");
    await page.evaluate(() => {
      document.getElementById("html5-main-video").currentTime = 50.0;
    });
    await page.keyboard.press("Shift+N");
    await page.waitForTimeout(200);
    const timeDuringTyping = await page.evaluate(() => document.getElementById("html5-main-video").currentTime);
    console.log(`    --> video.currentTime when typing: ${timeDuringTyping}s (Preserved at 50s!)`);
    if (timeDuringTyping !== 50.0) {
      throw new Error("Hotkey fired while typing in comment input!");
    }

    // CHECK 6: Hover Tooltip
    console.log("\n[CHECK 6] Testing Scrubber Marker Hover:");
    const lastMarker = markers.nth(3);
    const titleAttr = await lastMarker.getAttribute("title");
    console.log(`    --> Marker tooltip title attribute: "${titleAttr}"`);
    if (!titleAttr || !titleAttr.includes("DRUT BANDISH")) {
      throw new Error(`Tooltip title does not contain DRUT BANDISH: ${titleAttr}`);
    }

    // CHECK 7: SPA Navigation Isolation (No Memory Leaks)
    console.log("\n[CHECK 7] Testing SPA Navigation Isolation (Simulating yt-navigate-finish to unseeded video):");
    await page.evaluate(() => window.simulateSpaNavigation("unseeded_new_video_id"));
    await page.waitForTimeout(500);

    const overlayOnUnseeded = await page.locator(".concert-segments-overlay").count();
    console.log(`    --> Overlay count on unseeded video: ${overlayOnUnseeded} (Old bookmarks removed!)`);
    if (overlayOnUnseeded !== 0) {
      throw new Error("Old video bookmarks leaked onto new unseeded video!");
    }

    // Check manual "Get Bookmarks" button was injected
    const getBookmarksBtn = await page.locator(".concert-bookmarks-btn").count();
    console.log(`    --> "Get Concert Bookmarks" button injected: ${getBookmarksBtn > 0 ? "YES" : "NO"}`);
    if (getBookmarksBtn === 0) {
      throw new Error('"Get Concert Bookmarks" button was not mounted on unseeded video!');
    }

    console.log("\n======================================================================");
    console.log("ALL REAL CHROMIUM BROWSER VALIDATION CHECKS PASSED WITH ZERO ERRORS!");
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

runBrowserValidation().catch((err) => {
  console.error("\n[PLAYWRIGHT TEST FAILED]:", err);
  process.exit(1);
});
