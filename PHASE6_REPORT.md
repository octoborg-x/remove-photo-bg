# Phase 6 report — first-run loading experience

**Date:** 2026-11-04
**Status:** ✅ DONE — the first successful result is faster and clearer. No
product behaviour regressed; there is still exactly one inference
implementation (`public/inference-worker.js`).
**Budget spent:** $0.

The goal of this phase was to reduce the time and effort required to obtain the
first successful result. The default model is ~68.5 MB, so a first-time visitor
must download it before anything works; that download is the friction, and the
page now explains and controls it instead of hiding it behind a progress bar.

## What changed

### 1. The first action is obvious

`index.html` is now three numbered steps — **1 Choose a photo → 2 Remove the
background → 3 Download your image** — with the drop zone as the primary call to
action and a one-line tagline that states the outcome and the privacy guarantee.
The model list shows each model's size and label, so the default is an informed
choice rather than a mystery.

### 2. Loading is understandable, in three phases

`src/features/background-removal/load-progress.ts` gained a phase mapping over
the existing worker checkpoints:

```ts
export type LoadPhase = 'download' | 'prepare' | 'inference';
export function phaseForStage(stage: LoadStage): LoadPhase;
export const PHASE_LABELS: Record<LoadPhase, string>;
```

| Phase | Stages | UI |
| --- | --- | --- |
| **Download** | `queued`…`downloading` | determinate ring with the real `%` next to the model name; copy `Downloading <model> — 42%` |
| **Prepare** | `downloaded`, `creating-session`, `session-ready` | indeterminate ring (no honest percentage exists); copy `Preparing the model…` |
| **Inference** | `ready` + the run | collapsed **Processing** panel, animated colour, live step list |

The ring (`#modelProgress`) sits inside the button/model row, immediately after
the model name, and animates as a stroke-dashoffset fill (determinate) or a
spin (indeterminate). It respects `prefers-reduced-motion`.

### 3. Network preflight and download confirmation

`src/features/background-removal/network-preflight.ts` is a DOM-free decision
module over the Chromium Network Information API:

- Wi-Fi / ethernet → load straight away.
- Cellular (`type`, or `effectiveType` of `slow-2g`/`2g`/`3g`, or a sub-1.5
  Mbit/s downlink estimate) or `saveData` → show a confirmation stating the model
  size; the download starts only after **Download model**.
- Unknown (most desktops, Firefox/Safari) → load straight away. Treating
  "unknown" as metered would nag every desktop visitor, and the model size is
  stated in the UI regardless.

The answer is remembered per session. `?model=` / `?provider=` overrides skip the
prompt so scripted runs are never blocked. Dismissing is not a dead end:
pressing **Remove background** starts the download.

### 4. Processing panel replaces the progress bar and the report block

The old stage-line progress text and the bottom-of-page report block are gone.
`#processing` is a single collapsed word with an animated colour that expands to:

- a live step list — **Download model → Prepare model → Remove background →
  Create image**, each `todo`/`active`/`done` with a dot and optional detail; and
- the technical log (behind a nested **Technical details** disclosure).

The **Copy device report** button and its code path were removed. The same
information (provider, model id, timings) is still produced: it is in the log
and in `window.smokeProvider` / `window.smokeModelId` / `runSmoke()` for the
harnesses.

### 5. Failure recovery

`ErrorKind = 'upload' | 'download' | 'memory' | 'worker' | 'generic'` drives a
`#recovery` panel with plain-language text and one-tap actions:

- **Download failed** — retry the download, or pick a smaller model.
- **Out of memory** — provider-aware (`describeError` still explains that CPU
  WASM has no further fallback); suggests closing tabs / a smaller photo / a
  smaller model.
- **Engine did not start** — the no-response watchdog now shows the recovery
  panel instead of only a log warning.

### 6. Exports and privacy

Exports were already clear; the section now leads with **Download transparent
PNG** (default) and offers **Download white-background JPG** as the secondary
action. The tagline and footer state that the photo is processed in the browser
and never uploaded — unchanged, and still enforced by `no-upload-path.test.ts`.

## Verification

- **Unit:** 79 tests in 9 files, all pass — including 13 new network-preflight
  tests and 10 extended load-progress tests (`phaseForStage`).
- **Lint/typecheck/build:** `eslint .` clean, `tsc --noEmit` clean,
  `vite build` OK (13 modules, 29.07 kB JS).
- **Browser (real Chromium + WASM, 14/14 pass):** upload → inference → both
  exports; PNG colour type 6; the processing panel lists all four steps as
  `done`; **0 third-party requests**; unsupported/corrupt input errors; worker
  startup failure **and** its recovery panel; manifest failure; keyboard drop
  zone; metered-connection confirmation with the size; and confirming it starts
  the load.

```
PASS  JPEG upload → transparent PNG rendered
PASS  PNG export has an alpha channel (colour type 6)
PASS  download section reveals transparent PNG (default) + white-background JPG
PASS  processing panel lists download/prepare/inference steps
PASS  no third-party requests during processing
PASS  PNG upload → transparent PNG rendered
PASS  unsupported file type shows an error and no output
PASS  corrupt image shows a decode error and no output
PASS  worker startup failure surfaces an error in the UI
PASS  worker failure shows a recovery panel
PASS  manifest load failure surfaces an error in the UI
PASS  drop zone is keyboard-activatable (Enter opens the chooser)
PASS  metered connection shows a download confirmation with the model size
PASS  confirming the download starts the model load

14/14 browser checks passed
```

## Files

| File | Change |
| --- | --- |
| `src/features/background-removal/network-preflight.ts` | **new** — connection classification + confirmation copy |
| `src/features/background-removal/network-preflight.test.ts` | **new** — 13 tests |
| `src/features/background-removal/load-progress.ts` | `LoadPhase`, `PHASE_LABELS`, `phaseForStage` |
| `src/features/background-removal/load-progress.test.ts` | phase-mapping tests |
| `index.html` | three-step markup, ring, processing panel, recovery panel, preflight banner; report block removed |
| `src/main.ts` | phase-aware progress, ring/panel/step/recovery helpers, preflight gate, error kinds, report button removed |
| `scripts/run-browser-tests.mjs` | new export/panel/recovery/preflight checks |
| `scripts/eval/run-eval.mjs`, `scripts/measure-browser-memory.mjs` | follow the renamed drop zone / stage text |
| `README.md`, `HARDWARE_TESTING.md` | document the three phases, preflight, recovery, and the report-button removal |

## Notes and trade-offs

- **Ring, not a bar.** A small circle fits next to a model name in a `<select>`
  row and in the button; a bar would reflow the layout. Only the download is
  determinate — everything else spins rather than showing a fake percentage.
- **The model list cannot hold a live ring per option.** Native `<option>`s
  cannot contain markup, so the ring is rendered once, in the row next to the
  selected model, and every option states its size in text. This is the honest
  version of "next to each model".
- **The preflight never blocks a desktop visitor.** "Unknown" connection means
  "load now"; only positive evidence of a metered link prompts.
- **One inference implementation preserved.** `single-inference-worker.test.ts`
  still guards against a second session-creating worker.
