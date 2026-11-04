# Model quality evaluation

**Purpose.** The per-model reports (`PHASE*_REPORT.md`) mostly measure *agreement
with another model* — the fp32 teacher, or the previous quantisation. That is a
useful correctness check, but it does not answer the customer's question: does
the cut-out look right? This document describes a fixed, licence-verified image
set and a harness that runs the **real deployed pipeline** over it, so quality
and performance can be compared across model revisions and runtimes and diffed
after any change.

## The image set

`eval/manifest.json` pins **64 images** across **8 categories, 8 each**:

| Category | What it exercises |
|---|---|
| `ordinary-product` | Clean silhouette, ordinary background removal |
| `clothing` | Fine edges and fabric detail |
| `hair-fur` | Edge preservation on hair and fur |
| `glass-transparent` | Transparent and reflective detail |
| `accessory` | Thin structures, small objects, narrow gaps |
| `complex-bg` | A clear subject against a cluttered background |
| `large` | 1920 px inputs — memory use and responsiveness |
| `thin-structure` | Glasses, cutlery, jewellery, keys — narrow shapes |

Every entry records the title, licence, source page, a pinned thumbnail URL,
dimensions (original and pinned) and SHA-256. The images themselves are
committed under `eval/images/`, so the set is stable and diffable.

**Licensing.** Only images that can be redistributed without a copyleft
obligation are used: CC0, public domain, "no restrictions", and CC BY. CC BY-SA
is deliberately excluded — bundling ShareAlike images would impose ShareAlike on
the redistributed set, while the project's dependency audit is otherwise
copyleft-free (see `LICENSE_AUDIT.md`). Per-image credits are generated into
`eval/ATTRIBUTION.md` from the same manifest that pins the bytes.

The set is built from Wikimedia Commons by
`scripts/eval/build-eval-set.py`, which searches per category, keeps only
approved licences and browser-decodable rasters, rejects artworks/diagrams (by
category membership, not just title), caps near-duplicate "series" and
per-query volume, and pins a standard-width thumbnail URL per image.

```sh
npm run eval:set                 # rebuild + download eval/images/ (network)
python3 scripts/eval/build-eval-set.py --verify   # offline: manifest vs files
```

`--verify` runs in CI (`static-checks`), so the committed set cannot silently
drift: every image must exist, match its SHA-256 and dimensions, sit within the
app's own 4096 px limit, and carry an approved licence.

## The harness

`scripts/eval/run-eval.mjs` drives the shipped page over every image through the
genuine upload path (`#pickFile` → `#runAll`) using the real classic worker, the
real model and the real exports. For each image it records success/failure,
output dimensions (must equal the input's), timing, the execution provider, and
peak browser RSS; it saves every output PNG under `eval-results/<run>/outputs/`.

`scripts/eval/analyze-eval.py` then measures the *visible* result from those
PNGs (from the alpha channel):

- **foreground** — share of the image kept (alpha ≥ 0.5);
- **soft edge** — share of pixels in the transition band (0.02..0.98), high on
  hair/fur and low on hard product edges;
- **edge contrast** — mean |∂alpha| along the boundary, a proxy for how hard the
  cut is;
- **components** — connected foreground regions (>1 suggests speckle or a
  genuinely multi-part object);
- **speckle** — foreground regions smaller than 0.05% of the image;
- **empty** — an output that keeps essentially nothing, which is a
  customer-visible failure even though inference "succeeded".

These are **descriptive, not accuracy scores** — there is no ground-truth mask
for these images. Their value is regression comparison: re-run after a model or
runtime change and a shift shows which categories moved. Visual review of the
output PNGs remains the authority for "is the mask right".

```sh
npm run build
npm run eval:run -- --provider wasm --out eval-results/wasm
npm run eval:analyze
# WebGPU, on a machine that has it:
RUN_GPU=1 npm run eval:run -- --provider webgpu --out eval-results/webgpu
```

## Baseline — WASM, `model_512_int8_fp16` (2026-11-04)

Recorded on a GitHub-hosted-class Linux container (no GPU), Chromium headless,
`?provider=wasm`, one run per image (cold per fresh page). `eval-results/wasm/`.

| Metric | Value |
|---|---|
| Images succeeded | **64 / 64** |
| Wrong output dimensions | **0** |
| Mean inference | **4097 ms** (per-image range ≈ 3.9–4.5 s) |
| Peak browser RSS | **555 MB** (baseline 460 MB) |
| Empty / near-empty outputs | **8 / 64** |

| category | n | ok | empty | foreground | soft edge | edge contrast | components | speckle |
|---|---|---|---|---|---|---|---|---|
| ordinary-product | 8 | 8 | 1 | 0.21879 | 0.0129 | 0.2202 | 1.25 | 0.0 |
| clothing | 8 | 8 | 1 | 0.28096 | 0.01513 | 0.16644 | 1.0 | 0.0625 |
| hair-fur | 8 | 8 | 2 | 0.23164 | 0.01136 | 0.15648 | 0.75 | 0.0 |
| glass-transparent | 8 | 8 | 0 | 0.32834 | 0.01767 | 0.21224 | 1.0 | 0.0 |
| accessory | 8 | 8 | 1 | 0.30602 | 0.01515 | 0.20895 | 2.625 | 0.10577 |
| complex-bg | 8 | 8 | 2 | 0.16822 | 0.01122 | 0.18669 | 1.5 | 0.15625 |
| large | 8 | 8 | 0 | 0.45798 | 0.06186 | 0.11955 | 29.25 | 0.50001 |
| thin-structure | 8 | 8 | 1 | 0.1236 | 0.02037 | 0.23275 | 1.5 | 0.0 |

### What the baseline shows

- **Inference is robust.** Every image decoded, ran and exported at the correct
  dimensions; no crash, no dimension drift, no memory failure at 1920 px.
- **`large` is the memory/latency ceiling.** It has the highest foreground,
  the widest soft edge and by far the most components/speckle (bouquets and
  cactus specimens are genuinely multi-part), which is where a marketplace user
  would notice residue first.
- **`thin-structure` is the hardest shape class.** Low foreground (thin objects
  are a small share of the frame) but the highest edge contrast and soft edge —
  exactly the regime where thin bars are most easily broken.
- **8 outputs are empty / near-empty.** These are the images worth looking at
  first; several are dark or low-contrast frames (a dark animal, a dark street
  scene, an archaeological object on black) where the subject is hard to isolate
  from the background by luminance. This is a real limitation of the current
  model, surfaced rather than hidden by the harness.

### Not yet measured

- **WebGPU.** No GPU in this environment (see `HARDWARE_TESTING.md`). Record
  WebGPU separately with `RUN_GPU=1`; do not compare a software-rendered number
  to a GPU one.
- **Ground-truth accuracy.** None of the above is a segmentation score.

## Comparing runs

Each run writes `eval-results/<run>/report.json`, `quality.json` and
`quality.md`, plus `outputs/*.png`. To compare a change, run the harness on the
same set before and after and diff `quality.json` / `report.json`; then review
the PNGs in the categories whose numbers moved. A mask that looks correct to the
customer matters more than a faster inference time.
