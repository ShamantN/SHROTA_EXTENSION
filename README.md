# SHROTA: YouTube Indian Classical Concert Auto-Bookmarking System

An automated bookmarking, chaptering, and navigation system for Indian Classical music concerts on YouTube. The system features a **Manifest V3 Chrome Extension** integrated with a **FastAPI backend** and a specialized **boundary normalization engine** to overlay accurate movements (e.g., Alaap, Jod, Vilambit Bandish, Drut Bandish) directly onto YouTube's video player.

---

## 🌟 Key Features

- **Dynamic Scrubber Overlay:** Paints standardized, color-coded musical movements onto the YouTube progress bar (Hindustani and Carnatic taxonomy).
- **Interactive Tooltips & Seeking:** Hover over any movement to see timestamps and label; click any segment to jump straight to that movement.
- **Fast Hotkey Navigation:**
  - `Shift + N`: Seek to the next musical movement boundary.
  - `Shift + P`: Seek to the previous movement boundary.
  - *Typing Guard:* Hotkeys are suppressed when typing comments or searching.
- **Ad Collision Guard:** Dynamically detects mid-roll ads via `MutationObserver` to suppress bookmarks during ads and cleanly restore them once the ad ends.
- **Client TTL Caching:** Uses `chrome.storage.local` with a 24-hour TTL to eliminate redundant network roundtrips.
- **Crowd Consensus & Reputation Engine:** Supports crowd edits, revision voting, and Bayesian Laplace-smoothed trust scoring.

---

## 🏗️ Architecture

```text
SHROTA/
├── vidTest.py                     # Video seeder / processor script
├── concert-bookmarking/
│   ├── backend/                   # FastAPI REST API & database layer
│   │   ├── app/                   # API routes, models, consensus engine, CDN purge
│   │   ├── tests/                 # Backend pytest test suite
│   │   ├── requirements.txt       # Python dependencies
│   │   └── Dockerfile
│   ├── config/
│   │   ├── allowlist.json         # Channel allowlist configuration
│   │   └── taxonomy.json          # Movement categories & taxonomy colors
│   ├── ingestion/
│   │   ├── cleaner.py             # Boundary normalization & smoothing algorithm
│   │   └── test_cleaner.py        # Ingestion test suite
│   └── extension/                 # Manifest V3 Chrome Extension
│       ├── dist/                  # Bundled scripts (loaded by Chrome)
│       ├── src/                   # Source code (content, background, overlay, hotkeys, UI)
│       ├── tests/                 # Vitest and Playwright E2E browser tests
│       └── manifest.json          # Extension configuration
```

---

## 🚀 Quick Start & Usage

### 1. Install Backend Dependencies & Start Server
```powershell
cd concert-bookmarking
pip install -r backend/requirements.txt
uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
```
Verify the server is running at [http://127.0.0.1:8000/healthz](http://127.0.0.1:8000/healthz).

### 2. Load the Extension into Google Chrome
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Turn **Developer mode** **ON** (top right).
3. Click **Load unpacked** (top left).
4. Select the directory:
   ```text
   <path-to-repo>/concert-bookmarking/extension
   ```

### 3. Test on YouTube
Open the pre-seeded classical concert:
👉 [https://www.youtube.com/watch?v=ed4SIvGjqNI](https://www.youtube.com/watch?v=ed4SIvGjqNI)
- The colored movement segments appear on the progress bar.
- Use `Shift + N` / `Shift + P` to navigate between Alaap, Jod, Vilambit Bandish, and Drut Bandish.

### 4. Adding/Testing Any New Video
Open `vidTest.py`, enter the new YouTube video ID and duration (in seconds), and run:
```powershell
python vidTest.py
```
Refresh the YouTube page in Chrome to see the new bookmarks!

---

## 🧪 Testing

- **Backend & Normalization Tests:**
  ```powershell
  python -m pytest -v
  ```
- **Extension Unit Tests:**
  ```powershell
  cd concert-bookmarking/extension
  npm test
  ```
- **Real Chromium E2E Browser Tests:**
  ```powershell
  cd concert-bookmarking/extension
  node tests/e2e_playwright.mjs
  node tests/e2e_fullstack.mjs
  ```
