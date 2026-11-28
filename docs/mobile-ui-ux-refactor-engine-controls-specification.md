> **Status: design reference only.** This spec was written against a layout
> this repository never had (`src/styles/mobile-ergonomic.css`,
> `src/ui/mobile-shell.ts`, `#engine-drawer`, `#report-modal`, …), so its code
> blocks are not a drop-in replacement for `index.html`. The parts that fit the
> real app — the Gemini/ChatGPT obsidian studio palette, the header runtime pill,
> the iridescent processing sweep and the non-dimming mobile engine sheet — are
> implemented in `src/studio-ai.css` and the `#enginePill` wiring in
> `src/main.ts`.

# Agent Implementation Spec: Gemini / ChatGPT AI Studio UI & Mobile-First Engine Controls (`remove-photo-bg`)

## 1. Repository & Engine Controls Trace

Based on the `octoborg-x/remove-photo-bg` codebase architecture (`index.html`, `src/main.ts`, `src/asset-cache.ts`, `public/inference-worker.js`, and `public/sw.js`), the application is a zero-upload, browser-native background remover powered by ONNX Runtime Web and a classic Web Worker.

### 1.1 Control-to-Engine Wiring Map

Every UI control binds directly to URL query parameters, `localStorage` persistence, Service Worker asset caching, or `postMessage` payloads sent to `public/inference-worker.js`. **All existing DOM IDs, `data-*` attributes, and ARIA roles must be preserved so `npm run test:browser` (Puppeteer) and `scripts/run-smoke.mjs` remain 100% green.**

| UI Control / Feature | Current State & DOM Binding | Engine / Worker Behavior | Mobile & AI Studio UX Upgrade |
| :--- | :--- | :--- | :--- |
| **Image Input / Dropzone** | `<input type="file">` + Drag/Drop zone | Decodes image to `ImageBitmap` / `ImageData` and posts to `/inference-worker.js`. | Clean ChatGPT/Gemini-inspired centered prompt card with subtle radial ambient glow; fades out smoothly once loaded. |
| **Primary Action (`Remove background`)** | Primary CTA button | Triggers `inference-worker.js` pipeline (`queued` → `runtime` → `cache-check` → `downloading` → `creating-session` → `ready`). | Integrated into a floating, pill-shaped AI command dock (`#212121` / `#131314`) at the bottom thumb zone. |
| **Model & Runtime Selector** | Combined dropdown (`model_512_int8_fp16`, `int0_fp16`, `int0_fp32` + `Runtime: CPU (WASM)` / `GPU (WebGPU)`) | Sets `VITE_ASSET_BASE` fetch target via `sw.js` and passes `provider` (`webgpu` \| `wasm`) to `InferenceSession.create()`. | Gemini-style model selector pill in the top header (`BiRefNet · WebGPU ▾`) opening a non-dimming floating overlay card over the stage. |
| **Mask Threshold & Feather** | Range sliders (`0–100%` threshold, `0–64px` box-blur feather) | Runs post-processing alpha-matte pass in-memory without re-running ONNX inference; persists in `localStorage`. | Placed inside the floating overlay sheet (`z-index: 60`) directly over the inference stage with zero backdrop dimming so live edge updates remain crystal clear. |
| **Export Format & Download** | Radio group (`PNG`, `JPG`, `WebP`) + single `<a>` download link | Re-encodes cached mask/composited canvas on change (`image/png`, `image/jpeg` on white, `image/webp`). | Compact pill switcher + circular icon download button inside the bottom AI command bar. |
| **Before / After Split Compare** | Dual-layer canvas / image comparison | Composites original input (`#original-canvas`) beneath/clipped against cutout (`#preview-canvas`). | Smooth 60fps touch-draggable vertical split scrubber (`pointerdown`/`pointermove` + keyboard arrows). |
| **Quality Problem Reporter** | `"Report a quality problem"` trigger + feedback form | Captures current model, runtime, threshold/feather settings, and optional note without uploading image pixels. | 30%-opacity flag icon in the top-right stage corner; smoothly expands on hover/focus (`opacity: 1`) and opens a non-dimming floating feedback sheet. |

---

## 2. Gemini / ChatGPT AI Console & Processing Motion Design System

1. **Gemini / ChatGPT Dark Studio Palette & Surfaces:**
   * Uses Gemini's signature deep obsidian canvas (`#131314`), elevated matte containers (`#1e1f20`), crisp `1px solid rgba(255, 255, 255, 0.08)` hairline borders, soft pill controls (`border-radius: 9999px`), and a restrained Gemini/ChatGPT AI accent spectrum (`#8ab4f8` → `#c58af9` → `#7ee787`).
   * **Atmospheric Studio Entrance:** Opening the console runs a gentle `cubic-bezier(0.22, 1, 0.36, 1)` fade-in and micro-scale reveal across the header, stage, and floating command bar.

2. **Gemini / ChatGPT Image Processing Animation (`is-processing`):**
   * While inference is running (`shell.setProcessing(true)`), the image viewport activates an AI-native visual state modeled after Gemini image generation & ChatGPT vision scanning:
     * **Iridescent Shimmer Sweep:** A soft, multi-stop Gemini/ChatGPT gradient sheen (`rgba(138, 180, 248, 0.16)`, `rgba(197, 138, 249, 0.22)`, `rgba(56, 189, 248, 0.14)`) glides diagonally across the image with a subtle luminous laser scanline (`2px` glowing edge).
     * **Breathing Border Aura:** The stage border pulses softly with an indigo-violet-cyan AI glow while the status pill displays a twinkling 4-point Gemini AI spark icon and shimmer-animated status typography (`"Removing background…"`).
     * When inference finishes (`shell.setProcessing(false)`), the shimmer fades out smoothly and the cutout + draggable split handle fade in.

3. **Non-Dimming, High-`z-index` Floating Overlays Over Main Inference Stage:**
   * On mobile (`< 768px`) and desktop, expanding or showing menus (`#engine-drawer` and `#report-modal`) renders as a floating matte AI card positioned directly over the main image inference viewport (`z-index: 60`) **without dimming, blurring, or altering the brightness/opacity of the image or any other element on the page**.

4. **Universal Ease Fade In/Out (`ui-fade` / `ui-sheet`):**
   * Every show/hide element (empty prompt, canvas viewport, split handle, report button, status pill, cellular toast, error banner, drawers) uses smooth `opacity`, `visibility`, and `transform` ease transitions (`0.28s–0.34s`).

---

## 3. Target Mobile AI Console Wireframe

```
┌─────────────────────────────────────────┐
│ [✦] RemoveBG  [BiRefNet · WebGPU ▾]     │  <- 52px Gemini/ChatGPT Matte Top Bar (z-index: 20)
├─────────────────────────────────────────┤
│                                  [🚩]   │  <- 30% opacity flag -> expands on hover
│      ╭───────────────────────────╮      │
│      │ ░░░ AI Shimmer Scan ░░░░  │      │  <- Main Inference Stage (z-index: 1, NEVER dimmed)
│      │      ORIGINAL ┃ CUTOUT    │      │     Iridescent Gemini/ChatGPT processing sweep
│  ┌───┴───────────────┃───────────┴───┐  │
│  │ Engine & Mask                [✕]  │  │  <- Floating Overlay Card (z-index: 60)
│  │ [Lite ▾] [Auto ▾]  Edge / Feather │  │     Positioned over inference stage, zero dim
│  └───────────────────────────────────┘  │
│             [ ✦ Removing... ]           │  <- Twinkling AI Spark Status Pill
├─────────────────────────────────────────┤
│  ╭───────────────────────────────────╮  │
│  │ [🖼]  [ PNG | JPG | WebP ] [⚙][✨] │  │  <- Floating Gemini/ChatGPT Pill Command Bar
│  ╰───────────────────────────────────╯  │
└─────────────────────────────────────────┘
```

---

## 4. Agent Implementation Instructions & Complete Code

Apply the following three files so the console matches the Gemini / ChatGPT AI studio aesthetic and processing animations while preserving every existing TypeScript hook and Puppeteer test selector.

### Step 1: Update `index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#131314" />
    <title>Remove BG — Private In-Browser AI Studio</title>
    <link rel="stylesheet" href="/src/styles/mobile-ergonomic.css" />
  </head>
  <body class="app-shell">
    <!-- Gemini / ChatGPT Style Minimal Header -->
    <header class="top-bar studio-stagger-1" role="banner">
      <div class="brand">
        <!-- 4-Point AI Spark Emblem -->
        <svg class="icon icon-ai-spark" viewBox="0 0 24 24" aria-hidden="true">
          <defs>
            <linearGradient id="ai-spark-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#8ab4f8" />
              <stop offset="50%" stop-color="#c58af9" />
              <stop offset="100%" stop-color="#6ee7b7" />
            </linearGradient>
          </defs>
          <path
            fill="url(#ai-spark-grad)"
            d="M12 2C12.4 7.2 16.8 11.6 22 12C16.8 12.4 12.4 16.8 12 22C11.6 16.8 7.2 12.4 2 12C7.2 11.6 11.6 7.2 12 2Z"
          />
        </svg>
        <span class="brand-name">RemoveBG</span>
        <span class="privacy-badge" title="100% On-Device Processing" aria-label="On-device privacy lock">
          <svg class="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          <span class="hide-mobile">On-Device</span>
        </span>
      </div>

      <div class="top-actions">
        <!-- Gemini-Style Model & Runtime Selector Pill -->
        <button
          type="button"
          id="engine-drawer-trigger"
          class="ai-model-pill"
          aria-expanded="false"
          aria-controls="engine-drawer"
          aria-label="Engine and mask settings"
          title="Model, Runtime & Mask Controls"
        >
          <span class="status-dot" aria-hidden="true"></span>
          <span id="runtime-badge-label" class="pill-label">WebGPU</span>
          <svg class="icon-xs text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>
    </header>

    <!-- Main Focal Inference Stage (Never dimmed when menus expand) -->
    <main class="stage-area studio-stagger-2" id="drop-zone">
      <input
        type="file"
        id="file-input"
        accept="image/png,image/jpeg,image/webp"
        class="sr-only"
        aria-label="Select photo"
      />

      <!-- Empty State: Gemini / ChatGPT Greeting & Drop Card -->
      <label for="file-input" id="empty-prompt" class="upload-hero ui-fade" data-visible="true" tabindex="0">
        <div class="ai-ambient-orb" aria-hidden="true"></div>
        <div class="upload-icon-ring">
          <svg class="icon-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
            <rect x="3" y="3" width="18" height="18" rx="5" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </div>
        <h1 class="hero-title">Drop a photo to isolate subject</h1>
        <p class="hero-sub">Runs locally via WebGPU &bull; Zero cloud uploads</p>
      </label>

      <!-- Active Canvas Viewport + Touch-Draggable Before/After Split -->
      <div id="canvas-viewport" class="canvas-viewport ui-fade" data-visible="false" aria-hidden="true">
        <div id="compare-stage" class="compare-stage" style="--split: 50%;">
          <!-- Layer 1: Processed Cutout Canvas -->
          <canvas id="preview-canvas" class="compare-layer compare-after" aria-label="Processed image preview"></canvas>

          <!-- Layer 2: Original Source Canvas (Clipped by --split) -->
          <div class="compare-before-clip" aria-hidden="true">
            <canvas id="original-canvas" class="compare-layer compare-before"></canvas>
          </div>

          <!-- Gemini / ChatGPT AI Processing Scan & Shimmer Overlay -->
          <div id="ai-processing-overlay" class="ai-processing-overlay ui-fade" data-visible="false" aria-hidden="true">
            <div class="ai-shimmer-veil"></div>
            <div class="ai-scan-beam"></div>
          </div>

          <!-- Touch-Draggable Vertical Split Handle -->
          <div
            id="compare-divider"
            class="compare-divider ui-fade"
            data-visible="false"
            role="slider"
            tabindex="0"
            aria-label="Drag to compare original and cutout"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow="50"
          >
            <div class="compare-line"></div>
            <div class="compare-knob">
              <svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
                <polyline points="8 7 3 12 8 17" />
                <polyline points="16 7 21 12 16 17" />
              </svg>
            </div>
          </div>
        </div>

        <!-- Discreet Quality Report Button: 30% Opacity Icon, Expands Text on Hover -->
        <button
          type="button"
          id="report-quality-btn"
          class="report-expand-btn ui-fade"
          data-visible="false"
          aria-label="Report a quality problem"
          aria-haspopup="dialog"
          aria-controls="report-modal"
        >
          <svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
            <line x1="4" y1="22" x2="4" y2="15" />
          </svg>
          <span class="report-expand-text">Report a quality problem</span>
        </button>
      </div>

      <!-- Floating Gemini / ChatGPT AI Status Pill -->
      <div id="status-pill" class="status-pill ui-fade" data-visible="true" role="status" aria-live="polite">
        <div class="ai-thinking-spinner" id="ai-thinking-spinner" aria-hidden="true">
          <svg class="icon-xs spark-pulse" viewBox="0 0 24 24">
            <path
              fill="url(#ai-spark-grad)"
              d="M12 2C12.4 7.2 16.8 11.6 22 12C16.8 12.4 12.4 16.8 12 22C11.6 16.8 7.2 12.4 2 12C7.2 11.6 11.6 7.2 12 2Z"
            />
          </svg>
          <svg id="progress-ring" class="progress-ring" viewBox="0 0 24 24">
            <circle class="ring-track" cx="12" cy="12" r="9" />
            <circle id="progress-ring-bar" class="ring-fill" cx="12" cy="12" r="9" />
          </svg>
        </div>
        <span id="status-text" class="status-label">Ready</span>
      </div>

      <!-- Cellular / Data-Saver Compact Confirmation Toast -->
      <div
        id="cellular-prompt"
        class="cellular-toast ui-fade"
        data-visible="false"
        aria-hidden="true"
        role="alertdialog"
        aria-labelledby="cellular-title"
      >
        <div class="cellular-info">
          <strong id="cellular-title">Download AI model (~68.5 MB)?</strong>
          <label class="remember-check">
            <input type="checkbox" id="remember-cellular" />
            <span>Remember</span>
          </label>
        </div>
        <div class="cellular-actions">
          <button type="button" id="confirm-download-btn" class="btn-ai-pill-sm">Download</button>
        </div>
      </div>

      <!-- Plain-Language Error Banner -->
      <div id="error-banner" class="error-toast ui-fade" data-visible="false" aria-hidden="true" role="alert">
        <span id="error-message">Engine did not start</span>
        <button type="button" id="retry-btn" class="icon-btn-sm" aria-label="Retry">
          <svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>
    </main>

    <!-- Gemini / ChatGPT Floating Command Dock -->
    <footer class="bottom-dock studio-stagger-3" role="contentinfo">
      <div class="ai-command-capsule">
        <!-- Upload Photo Icon Button -->
        <label
          for="file-input"
          class="capsule-icon-btn"
          aria-label="Upload new photo"
          title="New Photo"
          role="button"
          tabindex="0"
        >
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
            <rect x="3" y="3" width="18" height="18" rx="4" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </label>

        <!-- Compact Format Switcher -->
        <div id="format-group" class="segmented-pill" role="radiogroup" aria-label="Export format">
          <label class="seg-option">
            <input type="radio" name="export-format" value="png" checked />
            <span>PNG</span>
          </label>
          <label class="seg-option">
            <input type="radio" name="export-format" value="jpeg" />
            <span>JPG</span>
          </label>
          <label class="seg-option">
            <input type="radio" name="export-format" value="webp" />
            <span>WebP</span>
          </label>
        </div>

        <!-- Edge & Mask Sliders Quick Trigger -->
        <button
          type="button"
          id="quick-refine-btn"
          class="capsule-icon-btn"
          aria-label="Refine mask edges"
          title="Refine Edges"
        >
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
            <line x1="4" y1="21" x2="4" y2="14" />
            <line x1="4" y1="10" x2="4" y2="3" />
            <line x1="12" y1="21" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12" y2="3" />
            <line x1="20" y1="21" x2="20" y2="16" />
            <line x1="20" y1="12" x2="20" y2="3" />
            <line x1="1" y1="14" x2="7" y2="14" />
            <line x1="9" y1="8" x2="15" y2="8" />
            <line x1="17" y1="16" x2="23" y2="16" />
          </svg>
        </button>

        <!-- Download Result Icon Button -->
        <a
          id="download-link"
          class="capsule-icon-btn disabled"
          download="cutout.png"
          aria-label="Download cutout"
          aria-disabled="true"
          title="Save Image"
        >
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </a>

        <!-- Primary AI Run Action Pill (ChatGPT / Gemini Send Style) -->
        <button
          type="button"
          id="remove-btn"
          class="ai-run-btn"
          aria-label="Remove background"
          disabled
        >
          <svg class="icon-sm" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C12.4 7.2 16.8 11.6 22 12C16.8 12.4 12.4 16.8 12 22C11.6 16.8 7.2 12.4 2 12C7.2 11.6 11.6 7.2 12 2Z" />
          </svg>
          <span class="run-label">Cut Out</span>
        </button>
      </div>

      <!-- Minimal Legal Footer Links (Preserved for Phase 3 Audit) -->
      <nav class="micro-legal" aria-label="Legal and privacy">
        <a href="/PRIVACY.md">Privacy</a>
        <span>&bull;</span>
        <a href="/MODEL_CARD.md">Model</a>
        <span>&bull;</span>
        <a href="/THIRD_PARTY_LEGAL_NOTICES.md">Notices</a>
      </nav>
    </footer>

    <!-- Non-Dimming Transparent Tap-Outside Catch Layer (Never dims or alters page elements) -->
    <div id="drawer-backdrop" class="drawer-backdrop ui-fade" data-visible="false" aria-hidden="true"></div>

    <!-- Floating Overlay Menu: Engine Controls, Edge Refine & Processing Log (Positioned over main inference stage) -->
    <aside
      id="engine-drawer"
      class="bottom-sheet ui-sheet"
      data-visible="false"
      aria-hidden="true"
      role="dialog"
      aria-modal="false"
      aria-labelledby="drawer-title"
    >
      <div class="sheet-handle-bar" id="sheet-drag-handle">
        <span class="sheet-pill"></span>
      </div>

      <div class="sheet-header">
        <h2 id="drawer-title">Engine &amp; Mask</h2>
        <button type="button" id="close-drawer-btn" class="icon-btn-sm" aria-label="Close panel">
          <svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div class="sheet-body">
        <div class="control-grid">
          <div class="control-cell">
            <label for="model-select" class="micro-label">Model</label>
            <select id="model-select" class="compact-select">
              <option value="model_512_int8_fp16">Lite (68 MB)</option>
              <option value="model_512_int0_fp16">Balanced (99 MB)</option>
              <option value="model_512_int0_fp32">Pro FP32 (194 MB)</option>
            </select>
          </div>

          <div class="control-cell">
            <label for="provider-select" class="micro-label">Runtime</label>
            <select id="provider-select" class="compact-select">
              <option value="auto">Auto (GPU)</option>
              <option value="webgpu">WebGPU</option>
              <option value="wasm">CPU (WASM)</option>
            </select>
          </div>
        </div>

        <div class="slider-stack">
          <div class="slider-row">
            <div class="slider-meta">
              <label for="threshold-input" class="micro-label">Edge Cut</label>
              <output id="threshold-value" for="threshold-input">0%</output>
            </div>
            <input type="range" id="threshold-input" min="0" max="100" value="0" />
          </div>

          <div class="slider-row">
            <div class="slider-meta">
              <label for="feather-input" class="micro-label">Feather</label>
              <output id="feather-value" for="feather-input">0px</output>
            </div>
            <input type="range" id="feather-input" min="0" max="64" value="0" />
          </div>
        </div>

        <details id="log-panel" class="telemetry-details">
          <summary>Console Log</summary>
          <pre id="run-log" class="run-log" aria-live="off"></pre>
        </details>
      </div>
    </aside>

    <!-- Floating Overlay Menu: Quality Problem Reporter (Positioned over main inference stage, zero dim) -->
    <aside
      id="report-modal"
      class="bottom-sheet ui-sheet"
      data-visible="false"
      aria-hidden="true"
      role="dialog"
      aria-modal="false"
      aria-labelledby="report-modal-title"
    >
      <div class="sheet-handle-bar">
        <span class="sheet-pill"></span>
      </div>

      <div class="sheet-header">
        <h2 id="report-modal-title">Report a quality problem</h2>
        <button type="button" id="close-report-btn" class="icon-btn-sm" aria-label="Close quality report">
          <svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <form id="quality-report-form" class="sheet-body">
        <p class="report-privacy-note">
          Your photo is <strong>never</strong> uploaded. Only engine telemetry (model, runtime, edge settings) is included.
        </p>

        <div class="issue-chip-group" role="group" aria-label="Issue category">
          <label class="issue-chip">
            <input type="radio" name="issue-type" value="rough-edges" checked />
            <span>Rough edges</span>
          </label>
          <label class="issue-chip">
            <input type="radio" name="issue-type" value="missing-subject" />
            <span>Cut subject</span>
          </label>
          <label class="issue-chip">
            <input type="radio" name="issue-type" value="leftover-bg" />
            <span>Leftover BG</span>
          </label>
          <label class="issue-chip">
            <input type="radio" name="issue-type" value="glass-hair" />
            <span>Glass / Hair</span>
          </label>
        </div>

        <textarea
          id="report-notes"
          class="report-textarea"
          rows="2"
          placeholder="Optional details (e.g., lighting, object type)..."
          aria-label="Additional details"
        ></textarea>

        <div class="report-footer-actions">
          <span id="report-telemetry-preview" class="telemetry-tag">model_512_int8_fp16 &bull; webgpu</span>
          <button type="submit" id="submit-report-btn" class="btn-ai-pill-sm">Send Report</button>
        </div>
      </form>
    </aside>

    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

### Step 2: Update `src/styles/mobile-ergonomic.css` (Gemini / ChatGPT Studio Surfaces & AI Processing Sweep)

```css
:root {
  /* Gemini / ChatGPT Dark Studio Tokens */
  --bg-app: #131314;
  --bg-surface: #1e1f20;
  --bg-elevated: #282a2c;
  --bg-hover: #333537;
  --border-hairline: rgba(255, 255, 255, 0.09);
  --border-strong: rgba(255, 255, 255, 0.18);
  --text-primary: #e3e3e3;
  --text-muted: #9aa0a6;
  --ai-blue: #8ab4f8;
  --ai-purple: #c58af9;
  --ai-mint: #6ee7b7;
  --ai-gradient: linear-gradient(135deg, #8ab4f8 0%, #c58af9 55%, #6ee7b7 100%);
  --radius-pill: 9999px;
  --radius-card: 20px;
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --ease-studio: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-fade: cubic-bezier(0.4, 0, 0.2, 1);
}

*,
*::before,
*::after {
  box-sizing: border-box;
  -webkit-tap-highlight-color: transparent;
}

html,
body.app-shell {
  margin: 0;
  padding: 0;
  height: 100dvh;
  max-height: 100dvh;
  overflow: hidden;
  background: var(--bg-app);
  color: var(--text-primary);
  font-family: "Google Sans", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
  display: flex;
  flex-direction: column;
}

/* =========================================================
   STUDIO OPENING ATMOSPHERIC FADE ENTRANCE
   ========================================================= */
@keyframes studioBackdropFade {
  0% {
    opacity: 0;
    filter: blur(8px);
  }
  100% {
    opacity: 1;
    filter: blur(0);
  }
}

@keyframes studioElementRise {
  0% {
    opacity: 0;
    transform: translateY(10px) scale(0.985);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

body.app-shell {
  animation: studioBackdropFade 0.8s var(--ease-studio) both;
}

.studio-stagger-1 {
  animation: studioElementRise 0.65s var(--ease-studio) 0.06s both;
}

.studio-stagger-2 {
  animation: studioElementRise 0.75s var(--ease-studio) 0.14s both;
}

.studio-stagger-3 {
  animation: studioElementRise 0.65s var(--ease-studio) 0.22s both;
}

/* =========================================================
   UNIVERSAL EASE FADE IN / OUT FOR ALL HIDE/SHOW ELEMENTS
   ========================================================= */
.ui-fade {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: scale(0.985);
  transition:
    opacity 0.28s var(--ease-fade),
    transform 0.28s var(--ease-fade),
    visibility 0s linear 0.28s;
}

.ui-fade[data-visible="true"] {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: scale(1);
  transition:
    opacity 0.32s var(--ease-fade),
    transform 0.32s var(--ease-fade),
    visibility 0s linear 0s;
}

.ui-sheet {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateY(14px) scale(0.97);
  transition:
    opacity 0.28s var(--ease-studio),
    transform 0.32s var(--ease-studio),
    visibility 0s linear 0.32s;
}

.ui-sheet[data-visible="true"] {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: translateY(0) scale(1);
  transition:
    opacity 0.32s var(--ease-studio),
    transform 0.34s var(--ease-studio),
    visibility 0s linear 0s;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* Icons */
.icon { width: 20px; height: 20px; flex-shrink: 0; }
.icon-sm { width: 16px; height: 16px; flex-shrink: 0; }
.icon-xs { width: 13px; height: 13px; flex-shrink: 0; }
.icon-lg { width: 30px; height: 30px; flex-shrink: 0; }
.text-muted { color: var(--text-muted); }

/* 1. Gemini / ChatGPT Clean 52px Top Bar */
.top-bar {
  position: relative;
  z-index: 20;
  height: 52px;
  padding: 0 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-app);
  flex-shrink: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  font-size: 1rem;
  letter-spacing: -0.015em;
  color: var(--text-primary);
}

.privacy-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: var(--radius-pill);
  background: var(--bg-surface);
  border: 1px solid var(--border-hairline);
  color: var(--text-muted);
  font-size: 0.7rem;
  font-weight: 500;
}

.ai-model-pill {
  height: 36px;
  padding: 0 12px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-hairline);
  background: var(--bg-surface);
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s var(--ease-fade), border-color 0.2s var(--ease-fade);
}

.ai-model-pill:hover {
  background: var(--bg-elevated);
  border-color: var(--border-strong);
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ai-mint);
  box-shadow: 0 0 8px rgba(110, 231, 183, 0.5);
}

/* 2. Focal Stage Area (Never dimmed when menus expand) */
.stage-area {
  position: relative;
  z-index: 1;
  flex: 1 1 auto;
  min-height: 0;
  margin: 4px 12px 8px;
  border-radius: var(--radius-card);
  border: 1px solid var(--border-hairline);
  background-color: #18191b;
  background-image:
    linear-gradient(45deg, #1f2023 25%, transparent 25%),
    linear-gradient(-45deg, #1f2023 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #1f2023 75%),
    linear-gradient(-45deg, transparent 75%, #1f2023 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  transition: border-color 0.35s var(--ease-fade), box-shadow 0.35s var(--ease-fade);
}

.stage-area.drag-over {
  border-color: var(--ai-blue);
  box-shadow: inset 0 0 0 1.5px var(--ai-blue);
}

/* Breathing AI Aura while processing an image */
@keyframes aiStageAura {
  0%, 100% {
    border-color: rgba(138, 180, 248, 0.35);
    box-shadow: inset 0 0 28px rgba(138, 180, 248, 0.08), 0 0 24px rgba(197, 138, 249, 0.12);
  }
  50% {
    border-color: rgba(197, 138, 249, 0.65);
    box-shadow: inset 0 0 42px rgba(197, 138, 249, 0.14), 0 0 32px rgba(138, 180, 248, 0.18);
  }
}

.stage-area.is-processing {
  animation: aiStageAura 2.4s ease-in-out infinite;
}

/* Gemini / ChatGPT Empty Prompt Surface */
.upload-hero {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
  cursor: pointer;
  background: var(--bg-surface);
  z-index: 2;
  overflow: hidden;
}

.ai-ambient-orb {
  position: absolute;
  width: 240px;
  height: 240px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(138, 180, 248, 0.14) 0%, rgba(197, 138, 249, 0.08) 45%, transparent 72%);
  pointer-events: none;
  filter: blur(18px);
}

.upload-icon-ring {
  position: relative;
  width: 60px;
  height: 60px;
  border-radius: 18px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-hairline);
  color: var(--ai-blue);
  display: grid;
  place-items: center;
  margin-bottom: 14px;
  transition: transform 0.25s var(--ease-studio), border-color 0.25s var(--ease-fade);
}

.upload-hero:hover .upload-icon-ring {
  transform: translateY(-2px) scale(1.04);
  border-color: rgba(138, 180, 248, 0.4);
}

.hero-title {
  position: relative;
  margin: 0 0 6px;
  font-size: 1.12rem;
  font-weight: 500;
  letter-spacing: -0.015em;
  background: linear-gradient(90deg, #f1f3f4 0%, #c8d7f5 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.hero-sub {
  position: relative;
  margin: 0;
  font-size: 0.78rem;
  color: var(--text-muted);
}

/* =========================================================
   TOUCH-DRAGGABLE BEFORE/AFTER SPLIT & AI SCAN ANIMATION
   ========================================================= */
.canvas-viewport {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3;
}

.compare-stage {
  position: relative;
  display: inline-grid;
  place-items: center;
  max-width: 100%;
  max-height: 100%;
  touch-action: none;
  user-select: none;
  border-radius: 12px;
  overflow: hidden;
}

.compare-layer {
  grid-area: 1 / 1;
  max-width: 100%;
  max-height: calc(100dvh - 172px);
  object-fit: contain;
  display: block;
}

.compare-before-clip {
  grid-area: 1 / 1;
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  clip-path: inset(0 calc(100% - var(--split, 50%)) 0 0);
  will-change: clip-path;
}

/* Gemini / ChatGPT Image Processing Shimmer & Laser Sweep */
@keyframes aiDiagonalShimmer {
  0% {
    background-position: -180% 0;
  }
  100% {
    background-position: 180% 0;
  }
}

@keyframes aiVerticalScan {
  0% {
    top: -6%;
    opacity: 0;
  }
  15% {
    opacity: 1;
  }
  85% {
    opacity: 1;
  }
  100% {
    top: 104%;
    opacity: 0;
  }
}

.ai-processing-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 6;
  overflow: hidden;
}

.ai-shimmer-veil {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    115deg,
    rgba(138, 180, 248, 0.04) 20%,
    rgba(138, 180, 248, 0.22) 38%,
    rgba(197, 138, 249, 0.28) 50%,
    rgba(110, 231, 183, 0.18) 62%,
    rgba(138, 180, 248, 0.04) 80%
  );
  background-size: 250% 100%;
  animation: aiDiagonalShimmer 2.1s linear infinite;
  mix-blend-mode: screen;
}

.ai-scan-beam {
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent 0%, #8ab4f8 25%, #c58af9 50%, #6ee7b7 75%, transparent 100%);
  box-shadow:
    0 0 14px 2px rgba(197, 138, 249, 0.65),
    0 -14px 24px rgba(138, 180, 248, 0.28);
  animation: aiVerticalScan 2.2s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite;
}

/* Split Divider */
.compare-divider {
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--split, 50%);
  width: 44px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ew-resize;
  touch-action: none;
  z-index: 8;
  will-change: left;
}

.compare-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1.5px;
  background: rgba(255, 255, 255, 0.88);
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.6);
}

.compare-knob {
  position: relative;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: rgba(30, 31, 32, 0.92);
  backdrop-filter: blur(8px);
  border: 1.5px solid rgba(255, 255, 255, 0.85);
  color: #fff;
  display: grid;
  place-items: center;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
  transition: transform 0.18s var(--ease-studio), background 0.18s var(--ease-fade);
}

.compare-divider:active .compare-knob,
.compare-divider.is-dragging .compare-knob {
  transform: scale(1.14);
  background: var(--bg-elevated);
  border-color: var(--ai-blue);
}

/* =========================================================
   DISCREET QUALITY REPORT BUTTON (30% OPACITY -> EXPAND ON HOVER)
   ========================================================= */
.report-expand-btn {
  position: absolute;
  top: 10px;
  right: 10px;
  height: 34px;
  padding: 0 9px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-hairline);
  background: rgba(30, 31, 32, 0.85);
  backdrop-filter: blur(10px);
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  gap: 0;
  cursor: pointer;
  z-index: 10;
  overflow: hidden;
  opacity: 0.3;
  transition:
    opacity 0.28s var(--ease-fade),
    padding 0.3s var(--ease-studio),
    gap 0.3s var(--ease-studio),
    border-color 0.25s var(--ease-fade);
}

.report-expand-btn[data-visible="false"] {
  opacity: 0;
}

.report-expand-btn[data-visible="true"]:hover,
.report-expand-btn[data-visible="true"]:focus-visible {
  opacity: 1;
  padding: 0 12px 0 10px;
  gap: 7px;
  border-color: var(--border-strong);
}

.report-expand-text {
  max-width: 0;
  opacity: 0;
  white-space: nowrap;
  font-size: 0.74rem;
  font-weight: 500;
  overflow: hidden;
  transition:
    max-width 0.32s var(--ease-studio),
    opacity 0.24s var(--ease-fade);
}

.report-expand-btn:hover .report-expand-text,
.report-expand-btn:focus-visible .report-expand-text {
  max-width: 180px;
  opacity: 1;
}

/* =========================================================
   GEMINI / CHATGPT AI STATUS PILL (TWINKLING SPARK + SHIMMER TEXT)
   ========================================================= */
@keyframes sparkTwinkle {
  0%, 100% {
    transform: scale(0.9) rotate(0deg);
    opacity: 0.85;
  }
  50% {
    transform: scale(1.18) rotate(12deg);
    opacity: 1;
  }
}

@keyframes textShimmer {
  0% {
    background-position: -150% center;
  }
  100% {
    background-position: 150% center;
  }
}

.status-pill {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%) scale(0.96);
  max-width: calc(100% - 24px);
  padding: 6px 14px 6px 10px;
  border-radius: var(--radius-pill);
  background: rgba(30, 31, 32, 0.9);
  backdrop-filter: blur(12px);
  border: 1px solid var(--border-hairline);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 0.76rem;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  z-index: 9;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}

.status-pill[data-visible="true"] {
  transform: translateX(-50%) scale(1);
}

.ai-thinking-spinner {
  position: relative;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
}

.spark-pulse {
  position: relative;
  z-index: 2;
}

.status-pill.is-spinning .spark-pulse {
  animation: sparkTwinkle 1.4s ease-in-out infinite;
}

.status-pill.is-spinning .status-label {
  background: linear-gradient(90deg, #9aa0a6 0%, #e3e3e3 35%, #c58af9 50%, #8ab4f8 65%, #9aa0a6 100%);
  background-size: 200% auto;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: textShimmer 2s linear infinite;
}

.progress-ring {
  position: absolute;
  inset: 0;
  width: 18px;
  height: 18px;
  transform: rotate(-90deg);
}

.ring-track {
  fill: none;
  stroke: rgba(255, 255, 255, 0.1);
  stroke-width: 2;
}

.ring-fill {
  fill: none;
  stroke: var(--ai-blue);
  stroke-width: 2;
  stroke-dasharray: 56.5;
  stroke-dashoffset: 56.5;
  transition: stroke-dashoffset 0.25s var(--ease-fade);
}

.status-pill.is-spinning .progress-ring {
  animation: spin 1.4s linear infinite;
}

.status-pill.is-spinning .ring-fill {
  stroke-dashoffset: 40;
}

@keyframes spin {
  to { transform: rotate(270deg); }
}

/* Cellular & Error Toasts */
.cellular-toast,
.error-toast {
  position: absolute;
  top: 10px;
  left: 10px;
  right: 10px;
  padding: 10px 14px;
  border-radius: 16px;
  background: var(--bg-surface);
  border: 1px solid var(--border-hairline);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 0.8rem;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  z-index: 15;
}

.error-toast {
  border-color: rgba(242, 139, 130, 0.4);
  background: #2c1b1e;
  color: #f28b82;
}

.cellular-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.remember-check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.72rem;
  color: var(--text-muted);
}

.btn-ai-pill-sm {
  height: 34px;
  padding: 0 14px;
  border-radius: var(--radius-pill);
  border: none;
  background: #e3e3e3;
  color: #131314;
  font-weight: 600;
  font-size: 0.78rem;
  cursor: pointer;
  transition: background 0.2s var(--ease-fade), transform 0.15s var(--ease-studio);
}

.btn-ai-pill-sm:hover {
  background: #ffffff;
}

/* =========================================================
   3. GEMINI / CHATGPT FLOATING COMMAND CAPSULE DOCK
   ========================================================= */
.bottom-dock {
  position: relative;
  z-index: 20;
  flex-shrink: 0;
  background: var(--bg-app);
  padding: 4px 12px calc(8px + var(--safe-bottom));
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ai-command-capsule {
  height: 54px;
  padding: 5px 6px;
  border-radius: var(--radius-pill);
  background: var(--bg-surface);
  border: 1px solid var(--border-hairline);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

.capsule-icon-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--text-primary);
  display: grid;
  place-items: center;
  text-decoration: none;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.2s var(--ease-fade), opacity 0.2s var(--ease-fade);
}

.capsule-icon-btn:hover:not(.disabled) {
  background: var(--bg-elevated);
}

.capsule-icon-btn.disabled,
.capsule-icon-btn[aria-disabled="true"] {
  opacity: 0.32;
  pointer-events: none;
}

.segmented-pill {
  flex: 1;
  min-width: 0;
  height: 36px;
  padding: 3px;
  border-radius: var(--radius-pill);
  background: var(--bg-app);
  border: 1px solid var(--border-hairline);
  display: grid;
  grid-template-columns: repeat(3, 1fr);
}

.seg-option {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-pill);
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
  transition: background 0.2s var(--ease-fade), color 0.2s var(--ease-fade);
}

.seg-option input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.seg-option:has(input:checked) {
  background: var(--bg-elevated);
  color: var(--text-primary);
}

.seg-option:has(input:disabled) {
  opacity: 0.35;
  cursor: not-allowed;
}

/* Primary ChatGPT / Gemini High-Contrast Run Pill */
.ai-run-btn {
  height: 42px;
  padding: 0 14px;
  border-radius: var(--radius-pill);
  border: none;
  background: #e3e3e3;
  color: #131314;
  font-size: 0.84rem;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex-shrink: 0;
  cursor: pointer;
  transition:
    opacity 0.25s var(--ease-fade),
    transform 0.15s var(--ease-studio),
    background 0.2s var(--ease-fade);
}

.ai-run-btn:hover:not(:disabled) {
  background: #ffffff;
}

.ai-run-btn:active:not(:disabled) {
  transform: scale(0.96);
}

.ai-run-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.micro-legal {
  display: flex;
  justify-content: center;
  gap: 8px;
  font-size: 0.68rem;
  color: var(--text-muted);
}

.micro-legal a {
  color: var(--text-muted);
  text-decoration: none;
  transition: color 0.2s var(--ease-fade);
}

.micro-legal a:hover {
  color: var(--text-primary);
}

/* =========================================================
   4. FLOATING OVERLAY MENUS OVER MAIN INFERENCE STAGE
      - High z-index (z-index: 60) positioned directly over image
      - ZERO backdrop dimming or filter on any element on page
   ========================================================= */
.drawer-backdrop {
  position: fixed;
  inset: 0;
  background: transparent;
  backdrop-filter: none;
  z-index: 45;
}

.bottom-sheet {
  position: fixed;
  left: 16px;
  right: 16px;
  bottom: calc(86px + var(--safe-bottom));
  max-height: 58dvh;
  background: rgba(30, 31, 32, 0.94);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--border-strong);
  border-radius: 22px;
  padding: 8px 16px 16px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45);
}

.sheet-handle-bar {
  display: flex;
  justify-content: center;
  padding: 2px 0;
}

.sheet-pill {
  width: 32px;
  height: 4px;
  border-radius: 99px;
  background: rgba(255, 255, 255, 0.22);
}

.sheet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sheet-header h2 {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 500;
  color: var(--text-primary);
}

.icon-btn-sm {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid var(--border-hairline);
  background: var(--bg-elevated);
  color: var(--text-primary);
  display: grid;
  place-items: center;
  cursor: pointer;
}

.sheet-body {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.control-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.control-cell {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.micro-label {
  font-size: 0.7rem;
  font-weight: 500;
  color: var(--text-muted);
  letter-spacing: 0.02em;
}

.compact-select {
  height: 38px;
  padding: 0 10px;
  border-radius: 12px;
  border: 1px solid var(--border-hairline);
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-size: 0.8rem;
}

.slider-stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.slider-meta {
  display: flex;
  justify-content: space-between;
  font-size: 0.76rem;
  margin-bottom: 2px;
}

input[type="range"] {
  width: 100%;
  accent-color: var(--ai-blue);
  height: 24px;
}

.telemetry-details summary {
  font-size: 0.76rem;
  font-weight: 500;
  color: var(--text-muted);
  cursor: pointer;
}

.run-log {
  margin: 6px 0 0;
  padding: 8px;
  max-height: 110px;
  overflow-y: auto;
  border-radius: 10px;
  background: var(--bg-app);
  border: 1px solid var(--border-hairline);
  font-size: 0.7rem;
  color: #cbd5e1;
}

/* Quality Report Form Inside Floating Overlay */
.report-privacy-note {
  margin: 0;
  font-size: 0.75rem;
  color: var(--text-muted);
  line-height: 1.4;
}

.issue-chip-group {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.issue-chip {
  padding: 5px 11px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-hairline);
  background: var(--bg-elevated);
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.2s var(--ease-fade), color 0.2s var(--ease-fade), border-color 0.2s var(--ease-fade);
}

.issue-chip input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.issue-chip:has(input:checked) {
  background: rgba(138, 180, 248, 0.16);
  border-color: var(--ai-blue);
  color: var(--text-primary);
}

.report-textarea {
  width: 100%;
  padding: 9px 11px;
  border-radius: 12px;
  border: 1px solid var(--border-hairline);
  background: var(--bg-app);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.78rem;
  resize: none;
}

.report-textarea:focus {
  outline: none;
  border-color: var(--ai-blue);
}

.report-footer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.telemetry-tag {
  font-size: 0.7rem;
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

@media (max-width: 420px) {
  .hide-mobile {
    display: none;
  }
}

/* Desktop / Tablet Centered Gemini Studio Frame (>= 768px) */
@media (min-width: 768px) {
  body.app-shell {
    max-width: 1040px;
    margin: 0 auto;
    padding: 8px 20px;
  }

  .ai-command-capsule {
    max-width: 560px;
    width: 100%;
    margin: 0 auto;
  }

  .bottom-sheet {
    left: auto;
    right: 28px;
    bottom: 84px;
    width: 370px;
  }
}
```

### Step 3: Update `src/ui/mobile-shell.ts` (AI Processing Animation Controller, Split Slider & Non-Dimming Overlays)

```typescript
// src/ui/mobile-shell.ts

export interface QualityReportPayload {
  issueType: string;
  notes: string;
  model: string;
  runtime: string;
  threshold: string;
  feather: string;
}

export interface ShellBindings {
  onSubmitQualityReport?: (payload: QualityReportPayload) => void;
}

export function setVisible(el: HTMLElement | null, visible: boolean): void {
  if (!el) return;
  el.dataset.visible = visible ? 'true' : 'false';
  el.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

export function initMobileShell(bindings?: ShellBindings): {
  setVisible: typeof setVisible;
  setProcessing: (active: boolean, label?: string) => void;
  setProgress: (percent: number, indeterminate: boolean, label: string) => void;
  setRuntimeLabel: (provider: 'webgpu' | 'wasm') => void;
  enableComparisonSplit: (enabled: boolean) => void;
  openDrawer: () => void;
  closeAllSheets: () => void;
} {
  const stageArea = document.getElementById('drop-zone') as HTMLElement | null;
  const processingOverlay = document.getElementById('ai-processing-overlay') as HTMLElement | null;

  const drawer = document.getElementById('engine-drawer') as HTMLElement | null;
  const reportModal = document.getElementById('report-modal') as HTMLElement | null;
  const backdrop = document.getElementById('drawer-backdrop') as HTMLElement | null;

  const triggerBtn = document.getElementById('engine-drawer-trigger') as HTMLButtonElement | null;
  const refineBtn = document.getElementById('quick-refine-btn') as HTMLButtonElement | null;
  const closeDrawerBtn = document.getElementById('close-drawer-btn') as HTMLButtonElement | null;

  const reportBtn = document.getElementById('report-quality-btn') as HTMLButtonElement | null;
  const closeReportBtn = document.getElementById('close-report-btn') as HTMLButtonElement | null;
  const reportForm = document.getElementById('quality-report-form') as HTMLFormElement | null;
  const telemetryPreview = document.getElementById('report-telemetry-preview') as HTMLElement | null;

  const compareStage = document.getElementById('compare-stage') as HTMLElement | null;
  const compareDivider = document.getElementById('compare-divider') as HTMLElement | null;

  const statusPill = document.getElementById('status-pill') as HTMLElement | null;
  const statusText = document.getElementById('status-text') as HTMLElement | null;
  const ringBar = document.getElementById('progress-ring-bar') as SVGCircleElement | null;
  const runtimeLabel = document.getElementById('runtime-badge-label') as HTMLElement | null;

  const CIRCUMFERENCE = 56.5;

  const closeAllSheets = () => {
    setVisible(drawer, false);
    setVisible(reportModal, false);
    setVisible(backdrop, false);
    triggerBtn?.setAttribute('aria-expanded', 'false');
  };

  const openDrawer = () => {
    setVisible(reportModal, false);
    setVisible(drawer, true);
    setVisible(backdrop, true);
    triggerBtn?.setAttribute('aria-expanded', 'true');
  };

  const openReportModal = () => {
    setVisible(drawer, false);
    triggerBtn?.setAttribute('aria-expanded', 'false');

    const modelVal = (document.getElementById('model-select') as HTMLSelectElement | null)?.value ?? 'default';
    const providerVal = (document.getElementById('provider-select') as HTMLSelectElement | null)?.value ?? 'auto';
    if (telemetryPreview) {
      telemetryPreview.textContent = `${modelVal} • ${providerVal}`;
    }

    setVisible(reportModal, true);
    setVisible(backdrop, true);
  };

  triggerBtn?.addEventListener('click', () => {
    if (drawer?.dataset.visible === 'true') closeAllSheets();
    else openDrawer();
  });

  refineBtn?.addEventListener('click', () => {
    if (drawer?.dataset.visible === 'true') closeAllSheets();
    else openDrawer();
  });
  closeDrawerBtn?.addEventListener('click', closeAllSheets);

  reportBtn?.addEventListener('click', () => {
    if (reportModal?.dataset.visible === 'true') closeAllSheets();
    else openReportModal();
  });
  closeReportBtn?.addEventListener('click', closeAllSheets);
  backdrop?.addEventListener('click', closeAllSheets);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllSheets();
    }
  });

  reportForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const issueInput = reportForm.querySelector<HTMLInputElement>('input[name="issue-type"]:checked');
    const notesInput = document.getElementById('report-notes') as HTMLTextAreaElement | null;
    const modelVal = (document.getElementById('model-select') as HTMLSelectElement | null)?.value ?? 'default';
    const providerVal = (document.getElementById('provider-select') as HTMLSelectElement | null)?.value ?? 'auto';
    const thresholdVal = (document.getElementById('threshold-input') as HTMLInputElement | null)?.value ?? '0';
    const featherVal = (document.getElementById('feather-input') as HTMLInputElement | null)?.value ?? '0';

    bindings?.onSubmitQualityReport?.({
      issueType: issueInput?.value ?? 'rough-edges',
      notes: notesInput?.value.trim() ?? '',
      model: modelVal,
      runtime: providerVal,
      threshold: thresholdVal,
      feather: featherVal,
    });

    if (notesInput) notesInput.value = '';
    closeAllSheets();
    setProgress(100, false, 'Quality feedback saved');
  });

  // =========================================================
  // GEMINI / CHATGPT IMAGE PROCESSING ANIMATION STATE
  // =========================================================
  const setProcessing = (active: boolean, label?: string) => {
    stageArea?.classList.toggle('is-processing', active);
    setVisible(processingOverlay, active);
    if (active) {
      setVisible(compareDivider, false);
      setProgress(0, true, label ?? 'Isolating subject…');
    } else if (label) {
      setProgress(100, false, label);
    }
  };

  // =========================================================
  // TOUCH-DRAGGABLE BEFORE/AFTER COMPARISON SPLIT SLIDER
  // =========================================================
  let splitPct = 50;
  let isDragging = false;

  const applySplit = (pct: number) => {
    splitPct = Math.max(0, Math.min(100, pct));
    if (compareStage) {
      compareStage.style.setProperty('--split', `${splitPct}%`);
    }
    if (compareDivider) {
      compareDivider.setAttribute('aria-valuenow', String(Math.round(splitPct)));
    }
  };

  const updateFromClientX = (clientX: number) => {
    if (!compareStage) return;
    const rect = compareStage.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    applySplit(pct);
  };

  if (compareStage && compareDivider) {
    compareDivider.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      isDragging = true;
      compareDivider.classList.add('is-dragging');
      compareDivider.setPointerCapture(e.pointerId);
      updateFromClientX(e.clientX);
    });

    compareDivider.addEventListener('pointermove', (e: PointerEvent) => {
      if (!isDragging) return;
      updateFromClientX(e.clientX);
    });

    const stopDrag = (e: PointerEvent) => {
      if (!isDragging) return;
      isDragging = false;
      compareDivider.classList.remove('is-dragging');
      if (compareDivider.hasPointerCapture(e.pointerId)) {
        compareDivider.releasePointerCapture(e.pointerId);
      }
    };

    compareDivider.addEventListener('pointerup', stopDrag);
    compareDivider.addEventListener('pointercancel', stopDrag);

    compareDivider.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        applySplit(splitPct - 5);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        applySplit(splitPct + 5);
      }
    });
  }

  const enableComparisonSplit = (enabled: boolean) => {
    applySplit(enabled ? 50 : 0);
    setVisible(compareDivider, enabled);
    setVisible(reportBtn, enabled);
  };

  // Live SVG Ring + Twinkling AI Spark Status Label
  const setProgress = (percent: number, indeterminate: boolean, label: string) => {
    if (statusText) statusText.textContent = label;
    setVisible(statusPill, true);
    if (!statusPill || !ringBar) return;

    if (indeterminate) {
      statusPill.classList.add('is-spinning');
    } else {
      statusPill.classList.remove('is-spinning');
      const clamped = Math.max(0, Math.min(100, percent));
      const offset = CIRCUMFERENCE - (clamped / 100) * CIRCUMFERENCE;
      ringBar.style.strokeDashoffset = String(offset);
    }
  };

  const setRuntimeLabel = (provider: 'webgpu' | 'wasm') => {
    if (runtimeLabel) {
      runtimeLabel.textContent = provider === 'webgpu' ? 'WebGPU' : 'CPU';
    }
  };

  return {
    setVisible,
    setProcessing,
    setProgress,
    setRuntimeLabel,
    enableComparisonSplit,
    openDrawer,
    closeAllSheets,
  };
}
```

---

## 5. Verification Checklist for the Agent

1. **Hook `shell.setProcessing(...)` into `src/main.ts`:**
   * Call `shell.setProcessing(true, 'Isolating subject…')` as soon as the worker starts processing an image so the iridescent Gemini/ChatGPT shimmer sweep, laser scan beam, breathing stage border aura, and twinkling AI spark status pill appear over the image.
   * Call `shell.setProcessing(false, 'Done')` and `shell.enableComparisonSplit(true)` when the cutout completes so the shimmer fades out and the touch-draggable comparison slider + 30%-opacity report flag fade in.
2. **Verify Non-Dimming Floating Overlays:** Confirm `#engine-drawer` and `#report-modal` render at `z-index: 60` over the main inference stage while `#drawer-backdrop` stays `background: transparent; backdrop-filter: none;`.
3. **Run Repo Checks:** Run `npm run typecheck`, `npm run lint`, `npm run test`, and `npm run test:browser` to confirm everything passes cleanly.