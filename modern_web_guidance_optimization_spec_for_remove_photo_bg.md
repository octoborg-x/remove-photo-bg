# Modern Web Guidance Specification (`remove-photo-bg`)

> **Tailored from [`googlechrome/modern-web-guidance`](https://github.com/googlechrome/modern-web-guidance)** exclusively for `octoborg-x/remove-photo-bg` (client-side BiRefNet ONNX Runtime Web/WebGPU/WASM background remover).
>
> **Core Directive for Coding Agent:** Replace bespoke JavaScript UI state machines, scroll listeners, and manual backdrop/focus-trap plumbing with native, Baseline/cutting-edge Web Platform primitives—preserving 100% compatibility with `public/inference-worker.js` (classic worker), `public/sw.js` (Cache API), strict CSP headers in `vercel.json` / `vite.config.ts`, and Puppeteer smoke tests (`npm run test:browser`).

---

## 1. Quick Agent Setup (CLI Skill Integration)

Your repository already targets Node ≥ 20 (tested on v24). Install the official `modern-web-guidance` skill directly into your repo so your coding agent can query platform rules on demand:

```bash
# Install Modern Web Guidance skill into this workspace (Node >= 22)
npx modern-web-guidance@latest install

# Scan remove-photo-bg for legacy DOM/CSS patterns to upgrade
npx modern-web-guidance@latest legacy-scan src/ index.html

# Retrieve targeted platform guides relevant to this app
npx modern-web-guidance@latest retrieve "animate-to-from-top-layer"
npx modern-web-guidance@latest retrieve "scroll-driven-animations"
npx modern-web-guidance@latest retrieve "scheduler-yield"
```

---

## 2. Architecture Audit: Legacy Patterns vs. Modern Web Platform Upgrades

Every upgrade below eliminates main-thread JS overhead (critical while ONNX Runtime Web compiles WebGPU shaders or runs multi-threaded WASM) and removes custom focus/backdrop bugs.

| App Feature (`remove-photo-bg`) | Legacy Implementation Risk | Modern Web Guidance Replacement | App-Specific Benefit |
| :--- | :--- | :--- | :--- |
| **Floating Engine & Report Overlays** (`#engine-drawer`, `#report-modal`) | Custom `data-visible` + `#drawer-backdrop` div + manual `Escape` key listeners | **Native `<dialog>` + Top Layer (`show()`) + `@starting-style` + `transition-behavior: allow-discrete`** | Renders in the browser's native Top Layer above `<canvas>` with zero `z-index` wars, native `Escape` dismissal, and zero dimming of the live inference stage (`dialog::backdrop { display: none; }`). |
| **Background Stage Inactivity** | Custom `pointer-events: none` / `aria-hidden` toggling during errors or cellular prompts | **Native HTML `inert` attribute** | Atomically blocks tab focus, screen readers, and pointer hits on disabled/hidden layers in one attribute. |
| **Mask Post-Processing & Canvas Re-Encoding** (`0–100%` threshold, `0–64px` feather, PNG/JPG/WebP export) | Synchronous main-thread loops blocking slider drag (`INP` spikes) | **`scheduler.yield()`** (with `setTimeout(0)` fallback) | Yields back to the browser input pipeline between alpha-matte passes so dragging Edge Cut / Feather sliders stays locked at 60/120fps. |
| **Studio Color & AI Processing Gradients** | Static hex/RGBA stops with muddy mid-tones | **`oklch()` perceptual color space + `in oklch` gradient interpolation + `light-dark()`** | Vivid, banding-free Gemini/ChatGPT AI shimmer sweeps and uniform contrast across HDR/P3 mobile displays. |
| **Scroll-Assembled Landing / Showcase** | `IntersectionObserver` + `scroll` event listeners toggling `.is-assembled` | **CSS Scroll-Driven Animations (`animation-timeline: view()`)** | Runs 100% off the main thread on the GPU compositor—zero JS frame drops even during active WebGPU inference. |
| **Model & Console Log Disclosure** | Custom JS accordion toggles | **Native `<details>` + `::details-content` + `interpolate-size: allow-keywords`** | Smoothly animates from `height: 0` to `height: auto` in pure CSS with built-in keyboard/ARIA support. |
| **Telemetry & Studio Typography** | Tabular drift on percentage counters (`Downloading 42%`, `50%` split) | **`font-variant-numeric: tabular-nums` + `text-wrap: balance` / `pretty`** | Prevents status pill jitter during rapid progress ticks (`queued` → `downloading` → `ready`). |

---

## 3. Drop-In Modern Platform Implementations for `remove-photo-bg`

### 3.1 Top-Layer Non-Dimming `<dialog>` with `@starting-style` (`index.html` + CSS)

Instead of a `<div>` drawer with manual backdrop elements, promote `#engine-drawer` and `#report-modal` to native non-modal `<dialog>` elements (`dialog.show()`, **not** `showModal()`, so the user can simultaneously drag sliders and inspect/pan the live canvas without a dimming backdrop):

```html
<!-- Native Top-Layer Dialog: Non-dimming, live-canvas-interactive -->
<dialog id="engine-drawer" class="ai-floating-dialog" aria-labelledby="drawer-title">
  <div class="sheet-header">
    <h2 id="drawer-title">Engine &amp; Mask</h2>
    <!-- Native Invoker Command (with JS fallback for older Safari/Firefox) -->
    <button
      type="button"
      id="close-drawer-btn"
      commandfor="engine-drawer"
      command="close"
      class="icon-btn-sm"
      aria-label="Close panel"
    >✕</button>
  </div>

  <div class="sheet-body">
    <!-- Preserves exact IDs required by src/main.ts and Puppeteer tests -->
    <select id="model-select" class="compact-select">
      <option value="model_512_int8_fp16">Lite (68 MB)</option>
      <option value="model_512_int0_fp16">Balanced (99 MB)</option>
      <option value="model_512_int0_fp32">Pro FP32 (194 MB)</option>
    </select>

    <select id="provider-select" class="compact-select">
      <option value="auto">Auto (GPU)</option>
      <option value="webgpu">WebGPU</option>
      <option value="wasm">CPU (WASM)</option>
    </select>

    <input type="range" id="threshold-input" min="0" max="100" value="0" />
    <input type="range" id="feather-input" min="0" max="64" value="0" />

    <details id="log-panel" class="telemetry-details">
      <summary>Console Log</summary>
      <pre id="run-log" class="run-log"></pre>
    </details>
  </div>
</dialog>
```

```css
/* Modern Top-Layer Entry & Exit Animation (@starting-style + allow-discrete) */
@layer components {
  :root {
    interpolate-size: allow-keywords;
  }

  dialog.ai-floating-dialog {
    position: fixed;
    inset: auto 16px calc(86px + env(safe-area-inset-bottom, 0px)) 16px;
    margin: 0;
    width: auto;
    max-height: 58dvh;
    border-radius: 22px;
    border: 1px solid oklch(100% 0 0 / 0.16);
    background: oklch(21% 0.008 260 / 0.94);
    backdrop-filter: blur(16px);
    color: oklch(91% 0.005 260);
    box-shadow: 0 12px 36px oklch(0% 0 0 / 0.45);

    /* Open state */
    opacity: 1;
    transform: translateY(0) scale(1);
    transition:
      opacity 0.28s cubic-bezier(0.22, 1, 0.36, 1),
      transform 0.32s cubic-bezier(0.22, 1, 0.36, 1),
      overlay 0.32s allow-discrete,
      display 0.32s allow-discrete;
  }

  /* Never dim the inference stage behind the dialog */
  dialog.ai-floating-dialog::backdrop {
    display: none;
  }

  /* Closed state */
  dialog.ai-floating-dialog:not([open]) {
    opacity: 0;
    transform: translateY(14px) scale(0.97);
  }

  /* Entry frame right as [open] is added */
  @starting-style {
    dialog.ai-floating-dialog[open] {
      opacity: 0;
      transform: translateY(14px) scale(0.97);
    }
  }

  /* Smooth height: 0 -> auto animation for Console Log <details> */
  details.telemetry-details::details-content {
    block-size: 0;
    overflow: clip;
    transition:
      block-size 0.3s cubic-bezier(0.22, 1, 0.36, 1),
      content-visibility 0.3s allow-discrete;
  }

  details.telemetry-details[open]::details-content {
    block-size: auto;
  }
}
```

### 3.2 `oklch()` Perceptual Color System & Banding-Free AI Processing Shimmer

Upgrade `src/styles/mobile-ergonomic.css` to use `oklch()` and `in oklch` gradient interpolation so the Gemini/ChatGPT image scan sweep and breathing stage aura render without muddy gray mid-points:

```css
:root {
  --surface-canvas: oklch(17.5% 0.006 260);
  --surface-card: oklch(22.5% 0.008 260);
  --surface-elevated: oklch(27% 0.01 260);
  --ai-accent-blue: oklch(78% 0.12 255);
  --ai-accent-violet: oklch(75% 0.16 305);
  --ai-accent-mint: oklch(84% 0.13 160);
}

/* Banding-free perceptual gradient sweep during inference */
.ai-shimmer-veil {
  background: linear-gradient(
    115deg in oklch,
    oklch(78% 0.12 255 / 0.04) 20%,
    oklch(78% 0.12 255 / 0.24) 38%,
    oklch(75% 0.16 305 / 0.30) 50%,
    oklch(84% 0.13 160 / 0.20) 62%,
    oklch(78% 0.12 255 / 0.04) 80%
  );
  background-size: 250% 100%;
  animation: aiDiagonalShimmer 2.1s linear infinite;
  mix-blend-mode: screen;
}

/* Prevent status counter jitter during model download (0% -> 100%) */
.status-label,
output {
  font-variant-numeric: tabular-nums;
}

.hero-title {
  text-wrap: balance;
}

.hero-sub {
  text-wrap: pretty;
}
```

### 3.3 Main-Thread INP Protection with `scheduler.yield()` (`src/utils/yield-to-main.ts`)

When users scrub the `#threshold-input` or `#feather-input` sliders on high-resolution photos (e.g., `1400×960`+ phone captures), yield between alpha compositing and `canvas.toBlob()` encoding so Interaction to Next Paint (INP) stays well under Google's 200 ms threshold:

```ts
// src/utils/yield-to-main.ts
export async function yieldToMain(): Promise<void> {
  if ('scheduler' in globalThis && typeof (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler?.yield === 'function') {
    await (globalThis as { scheduler: { yield: () => Promise<void> } }).scheduler.yield();
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
```

### 3.4 Pure-CSS Scroll-Driven Assembly (`animation-timeline: view()`)

For your showcase/landing page sections, replace `IntersectionObserver` scroll-assembly JS with GPU-composited CSS Scroll-Driven Animations (with an automatic `@supports not (animation-timeline: view())` fallback so Firefox/older Safari still reveal elements cleanly):

```css
@supports (animation-timeline: view()) {
  @keyframes assembleFromLeft {
    from {
      opacity: 0;
      transform: translate3d(-64px, 0, 0) rotate(-1.5deg);
    }
    to {
      opacity: 1;
      transform: translate3d(0, 0, 0) rotate(0deg);
    }
  }

  @keyframes assembleFromRight {
    from {
      opacity: 0;
      transform: translate3d(64px, 0, 0) rotate(1.5deg);
    }
    to {
      opacity: 1;
      transform: translate3d(0, 0, 0) rotate(0deg);
    }
  }

  @keyframes assembleFromBottom {
    from {
      opacity: 0;
      transform: translate3d(0, 56px, 0) scale(0.96);
    }
    to {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
    }
  }

  [data-assemble="from-left"] {
    animation: assembleFromLeft linear both;
    animation-timeline: view();
    animation-range: entry 5% cover 32%;
  }

  [data-assemble="from-right"] {
    animation: assembleFromRight linear both;
    animation-timeline: view();
    animation-range: entry 5% cover 32%;
  }

  [data-assemble="from-bottom"] {
    animation: assembleFromBottom linear both;
    animation-timeline: view();
    animation-range: entry 5% cover 32%;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-assemble] {
    animation: none !important;
    opacity: 1 !important;
    transform: none !important;
  }
}
```

---

## 4. App-Specific Guardrails (Do Not Break)

1. **Keep `public/inference-worker.js` Classic & Unbundled:** Do not convert the ONNX worker to a Vite module worker (`single-inference-worker.test.ts` enforces this, and `importScripts('/wasm/ort.wasm.min.js')` requires classic worker semantics).
2. **Preserve Test Selectors & IDs:** Keep `#file-input`, `#remove-btn`, `#model-select`, `#provider-select`, `#threshold-input`, `#feather-input`, `#format-group`, `#download-link`, `#cellular-prompt`, `#error-banner`, and `#run-log` intact so `npm run test:browser` and `scripts/run-smoke.mjs` pass without modification.
3. **Verify Everything:** After applying changes, run `npm run verify` (`lint` + `typecheck` + `test` + `build`) and `npm run test:browser`.