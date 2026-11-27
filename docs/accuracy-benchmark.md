# Accuracy benchmark — specification and per-image checklist

**Purpose.** `EVALUATION.md` runs the real pipeline over a fixed 64-image set and
reports *descriptive* numbers: success, dimensions, timing, and edge-character
statistics. Those answer "did it run and did the shape change?" but not the
customer's question — **is the cut-out correct?** This document specifies a
benchmark that (a) measures correctness where a ground truth exists, (b) turns
the descriptive metrics into explicit per-image pass/fail thresholds where it
does not, and (c) records the result per image so a model or runtime change can
be accepted or rejected on evidence.

It is the written spec the "8/64 empty outputs" finding needs: the count is a
symptom, and this is the instrument that names, per image, *what* failed and
*against which threshold*.

- Machine-readable worksheet: `eval/benchmark-checklist.csv`
- Reviewable worksheet: `eval/benchmark-checklist.md`
- Regenerate (and optionally prefill from a run):
  ```sh
  python3 scripts/eval/benchmark-checklist.py
  python3 scripts/eval/benchmark-checklist.py --run eval-results/wasm
  ```

---

## 1. What "accuracy" can mean here (and which definition we use)

There is **no ground-truth mask** for the 64 Commons photos — nobody has
hand-traced the subject. That is the root reason the current harness reports
"agreement" and "descriptive edge metrics" instead of accuracy. A benchmark that
claims "accuracy" must therefore say which of four evidence tiers it is using:

| Tier | Evidence | What it can claim | Cost |
|---|---|---|---|
| **A. Regression** | Descriptive metrics on all 64 images, diffed run-to-run | "this change moved nothing / moved category X by Y" | low — already built |
| **B. Synthetic ground truth** | Composite known-alpha cut-outs onto new backgrounds; the compositing alpha *is* exact GT | true IoU / Dice / boundary-F / MAE | medium — needs a set builder |
| **C. Hand-labelled gold subset** | A human traces N images (binary or soft alpha) | true accuracy on real photos | high — human hours |
| **D. Human judgement** | A rubric + rater panel over the 64 outputs | "would a marketplace seller accept this?" | high — human hours |
| **E. Model agreement** | fp32 teacher / 1024 reference as reference mask | "reproduces the reference", *not* accuracy | low — already built |

The benchmark's **primary accuracy number comes from Tier B**, because it is the
only tier that yields an exact ground truth cheaply and reproducibly. Tiers A/C/D
support it: A guards regressions, C validates that synthetic GT transfers to real
photos, D is the final word on subjective quality.

### 1.1 Tier B — how to build exact ground truth without hand-labelling

Compositing is exact: if you start from an image whose subject alpha is known
(`A_gt`) and place it on a known background `B`, the model should return a mask
equal to `A_gt`. Two sources of known-alpha material, both already in the repo:

1. **RGBA cut-outs in the eval set.** `eval/images/clothing-03.png` and
   `eval/images/large-06.png` carry a real alpha channel. Composite each over
   several backgrounds; the composite's correct mask is the original alpha.
2. **The reference masks** in `smoke-results/reference/*.mask.png` (3 images) and
   any future exported PNG with alpha.

A Tier-B set builder should, per source cut-out, composite over a matrix of
backgrounds — flat white, flat black, a mid-grey, a colour cast, a natural photo,
a cluttered photo — and record the exact alpha as the GT PNG. This directly
exercises the two regimes the photos cannot isolate: **background remains**
(a background that matches the subject's luminance) and **subject removed** (a
translucent subject over a busy background).

> **Caveat to state in every Tier-B report.** A model trained partly on
> composites can score higher on synthetic GT than on real photos. Tier B is a
> *lower bound on separability*, not a substitute for Tier C/D. Report the
> synthetic score and the human verdict side by side; never present the synthetic
> number alone as "model accuracy".

### 1.2 Tier A — thresholds without a ground truth

For the 64 photos, a per-image **minimum acceptable** is expressed as a *band* on
each descriptive metric, not a single score:

- an **absolute floor/ceiling** that must hold for every image (e.g. non-empty,
  correct dimensions, no crash);
- a **category-conditioned expectation** (e.g. `thin-structure` legitimately has
  a low foreground fraction; a `large` bouquet legitimately has many components);
- a **regression delta** against the pinned baseline (`EVALUATION.md` §Baseline):
  a change is rejected if a category's mean moves beyond the tolerance.

The thresholds in §5 are proposed defaults, chosen from the recorded baseline so
they are tight enough to catch the empty-output class but loose enough not to
fire on the known-good images. They are **configuration**, and the doc is their
single source of truth.

---

## 2. The image set

`eval/manifest.json` pins **64 images, 8 categories × 8**, committed under
`eval/images/` with SHA-256, dimensions and licence per entry. The licence audit
allows only CC0 / public domain / CC BY (no ShareAlike). Facts the checklist
prefills:

| Category | n | What it exercises | Pinned sizes (WxH) |
|---|---|---|---|
| `ordinary-product` | 8 | clean silhouette, ordinary removal | 1280 wide; 640–2879 tall |
| `clothing` | 8 | fine edges, fabric detail | 1280 wide; 853–1920 tall |
| `hair-fur` | 8 | edge preservation on hair/fur | 1280 wide; 823–1917 tall |
| `glass-transparent` | 8 | transparent/reflective detail | 1280 wide; 745–1920 tall |
| `accessory` | 8 | thin structures, small objects, narrow gaps | 1280 wide; 853–1707 tall |
| `complex-bg` | 8 | clear subject on a cluttered background | 1280 wide; 852–1997 tall |
| `large` | 8 | 1920 px inputs — memory and responsiveness | 1920 wide; 1920–2939 tall |
| `thin-structure` | 8 | glasses, cutlery, jewellery, keys | 1280 wide; 724–1920 tall |

- 61 JPEG, 3 PNG (`clothing-03`, `hair-fur-04`, `large-06`); 2 carry a real
  alpha channel (`clothing-03`, `large-06`).
- Every image is within the app's own 4096 px longest-side limit
  (`image-validation.ts` `DEFAULT_UPLOAD_LIMITS.maxLongestSide = 4096`).
- `scripts/eval/build-eval-set.py --verify` runs in CI (`static-checks`) so the
  set cannot drift silently.

A **Tier-B synthetic set** is a *separate* manifest (e.g.
`eval/synthetic-manifest.json`), not a mutation of this one, so the two evidence
tiers stay independent and separately diffable.

---

## 3. Measurement checklist

One row per image. Columns 3.1–3.2 are identity; 3.3–3.9 are the measurement
spec. `eval/benchmark-checklist.csv` carries exactly these columns.

### 3.1 Identity (prefilled from the manifest)

| Field | Definition | Source |
|---|---|---|
| `name` | manifest title (`File:…`) | `manifest.json` |
| `path` | `eval/images/<id><ext>` | resolved on disk |
| `id` | stable `<category>-NN` | manifest |
| `category` | one of the 8 | manifest |
| `license` / `source` | provenance | manifest |

### 3.2 Minimum acceptable quality thresholds

Each image carries the thresholds that apply to it (§5). A row is **PASS** only
if every applicable gate holds. The gates are:

1. `exec_ok = yes` — inference completed without a thrown error.
2. `dims_match = yes` — output WxH equals input WxH exactly.
3. `not empty` — `fg_frac ≥ 0.01`.
4. `bimodal_ok = yes` — raw-mask tail mass ≥ 0.40 (the ghost guard).
5. `alpha_max ≥ 230` — a real opaque core exists.
6. `speckle_frac ≤ 0.05` — no speckle-dominated output.
7. `infer_ms ≤ budget` — per-provider latency ceiling (§5.4).
8. `verdict ∈ {ok}` for a clean pass; `washed`/`kept`/`empty` are failures.

`accuracy-benchmark.py` writes the applicable values into each row as
`min_fg_frac`, `min_bimodal_tail`, `min_alpha_max`, `max_speckle_frac` and
`max_infer_ms`, so a checklist row states the bar it was judged against and the
row can be read without opening `eval/thresholds.json`.

### 3.3 Execution success

| Field | Definition |
|---|---|
| `exec_ok` | boolean — the run resolved and produced a PNG data URL |
| `error` | the failure text when `exec_ok = no` (else empty) |
| `provider` | `wasm` or `webgpu` — the provider that actually ran |
| `actual_provider` | from the diagnostic report; must equal `provider` (a silent fallback is itself a finding) |

### 3.4 Output dimensions

| Field | Definition |
|---|---|
| `expected_w`, `expected_h` | from the manifest |
| `out_w`, `out_h` | decoded from the output PNG |
| `dims_match` | `out_w==expected_w && out_h==expected_h` — **must** hold |

### 3.5 Processing time

| Field | Definition |
|---|---|
| `infer_ms` | the run's reported inference time (mean of `--runs` repeats; first is cold) |
| `wall_ms` | end-to-end for the last repeat (decode → inference → export) |
| `cold_ms` | the first repeat's inference time (cold cost) |
| `provider` | timings are only comparable within one provider |

Record cold and warm separately: a browser cross-session driver shader cache
makes the "cold" number drift down across page sessions even when no warm run
occurred (`HARDWARE_TESTING.md` §1). Never compare a WASM timing to a WebGPU one.

### 3.6 Alpha-channel characteristics

Measured from the output PNG's alpha channel (`0..255`, normalised to `0..1`).
These are the visible-result metrics; `scripts/eval/analyze-eval.py` computes the
first five.

| Field | Definition |
|---|---|
| `fg_frac` | share of pixels kept (`alpha ≥ 0.5`) |
| `soft_edge_frac` | share in the transition band (`0.02 < alpha < 0.98`) |
| `edge_contrast` | mean `|∇alpha|` on the boundary (low ⇒ blurry/soft cut) |
| `alpha_min` / `alpha_max` / `alpha_mean` | range and centre of the alpha |
| `opaque_frac` | share with `alpha ≥ 230` (the solid core; `output-alpha.ts`) |
| `any_frac` | share with `alpha > 0` (any visibility) |
| `tail_mass` | `P(alpha<0.1) + P(alpha>0.95)` — bimodality; `< 0.40` ⇒ suspect |
| `histogram` | 16-bin alpha histogram, for drift diffing |

### 3.7 Empty outputs

An **empty / near-empty** output keeps essentially nothing and is a
customer-visible failure even though inference "succeeded".

| Field | Definition |
|---|---|
| `empty` | `fg_frac < 0.01` (the `analyze-eval.py` rule) |
| `empty_class` | `fully-transparent` (`alpha_max = 0`) vs `near-empty` (a faint core) |
| `verdict` | `empty` / `washed` / `kept` / `ok` from `classifyOutputAlpha` |

Report the **count and the image ids**, and separate a genuinely empty subject
from a legitimate one: a few eval images are dark, low-contrast frames where the
subject is hard to isolate by luminance, so an "empty" there is a model
limitation to record, not necessarily a bug. The checklist's `notes` column is
where that call is written down.

### 3.8 Segmentation characteristics

The accuracy-oriented half. Computed from the alpha mask alone, so it works on
the 64 photos without a ground truth (Tier A) and is the same code that scores a
Tier-B run against its exact GT.

| Field | Definition | Failure it exposes |
|---|---|---|
| `components` | count of 8-connected foreground regions | speckle, or a genuinely multi-part subject (verify against the photo) |
| `largest_component_frac` | largest region ÷ total foreground | a fragmented subject (broken into pieces) |
| `speckle_frac` | share of regions smaller than 0.05 % (`5e-4`) of the image — the app's `strict` island bar | stray dots a listing shows as noise |
| `holes` | count of background regions fully enclosed by foreground | a missing subject interior (e.g. a hole punched through a product) |
| `hole_area_frac` | total enclosed-background area ÷ image | how much subject was eaten away |
| `border_fg_frac` | foreground share within a 2-px frame at the image border | **background remains** — a subject that leaks to the edge is suspicious unless the subject genuinely fills the frame |
| `bbox_fill` | foreground bbox area ÷ image area | a subject cropped or mis-framed |
| `bbox_touch_border` | whether the fg bbox touches an edge | framing check |
| `centroid_offset` | distance of the fg centroid from the image centre, normalised | subject off-centre beyond the photo's own framing |
| `boundary_bandwidth_px` | mean distance between the 0.1 and 0.9 alpha crossings | softness/hardness of the cut, in pixels (comparable across resolutions) |
| `trimap` | `P(definite-FG)`, `P(unknown)`, `P(definite-BG)` at a fixed band | edge-uncertainty share |

Two metrics need the RGB pixels and the composited result, so they are Tier-B
only (they need a background to measure against):

| Field | Definition | Failure it exposes |
|---|---|---|
| `halo` | mean RGB error in the edge band vs the subject interior, composited on white | colour fringing / matte halo at the cut |
| `bg_purity` | mean RGB error in the definite-background region vs the true background | residual background colour bleeding through |

### 3.9 Reproducibility and parity (run-level, not per-image)

Recorded once per run, but a benchmark is not reliable without them:

| Field | Definition |
|---|---|
| `determinism` | re-run the same image twice on the same provider; the two output PNGs must be **byte-identical** (or within a stated tolerance) |
| `provider_parity` | on a device that has a GPU, run the set on `wasm` and `webgpu`; per image, `IoU(mask_wasm, mask_webgpu)` — a low value is the ghost signature |
| `peak_rss_mb` | peak browser RSS (already in `report.json`) |
| `fail_count` | images that failed any gate |

---

## 4. Accuracy metrics (Tier B, and Tier C/D where a GT exists)

When a ground-truth alpha `G` and a predicted alpha `P` are both available:

| Metric | Definition | Notes |
|---|---|---|
| `IoU@0.5` | `|P>0.5 ∧ G>0.5| / |P>0.5 ∨ G>0.5|` | the headline binary score |
| `Dice@0.5` | `2·|P>0.5 ∧ G>0.5| / (|P>0.5|+|G>0.5|)` | softer than IoU on small subjects |
| `MAE` | mean `|P−G|` over all pixels | the app's real output is a soft alpha |
| `MSE` | mean `(P−G)²` | penalises large errors |
| `boundary_F@0.5` | F-score between boundary maps at radius r (dilation tolerance) | the metric that actually rewards clean edges |
| `band_MAE` | mean `|P−G|` where `0.05 < G < 0.95` | error where edge quality lives |
| `fg_precision` / `fg_recall` | `TP/(TP+FP)` / `TP/(TP+FN)` at 0.5 | precision low ⇒ background remains; recall low ⇒ subject removed |
| `flips` | pixels crossing 0.5 between two masks | regression unit |
| `empty_GT` flag | both masks all-background | agreement, **not** IoU 0 — excluded from the aggregate |

These already exist in `scripts/distill/evaluate.py` and
`scripts/distill/eval-parity.py`; the benchmark reuses that code, pointing it at
the Tier-B GT instead of at the teacher.

**Aggregate rules.** Report per-image rows *and* the category mean, the worst
image, and the count below a floor. Never tune a per-image threshold to hide a
regression (`optimize_model_plan/audit.md` §"never tunes thresholds"). Exclude
`empty_GT` rows from IoU means and count them separately.

---

## 5. Thresholds (proposed defaults)

Tune to the recorded baseline (`EVALUATION.md` §Baseline); the numbers below are
the starting point and are the single source the checklist generator mirrors.

### 5.1 Universal gates (every image, every provider)

| Gate | Rule | Rationale |
|---|---|---|
| ran | `exec_ok` | a crash is always a failure |
| dimensions | `dims_match` | the product must not resize |
| not empty | `fg_frac ≥ 0.01` | `analyze-eval.py` empty rule |
| bimodal | `tail_mass ≥ 0.40` | `raw-mask-stats.ts` `MIN_BIMODAL_TAIL` — the ghost guard |
| opaque core | `alpha_max ≥ 230` | `output-alpha.ts` `NEAR_OPAQUE_ALPHA` |
| not kept | `opaque_frac < 0.995` | `output-alpha.ts` `KEPT_OPAQUE_FRACTION` |
| speckle | `speckle_frac ≤ 0.05` | measured against the `strict` (5e-4) island bar; after issue #145 the worst category mean is 0.26 (`complex-bg`), and the remaining failures are 1-px soft-band artefacts, not islands (§5.1.1) |

#### 5.1.1 The island / speckle area bars (two variants)

The app can drop disconnected foreground specks with either of two bars, and the
engine-controls sidebar exposes the choice ("Island cleanup"):

| Variant | Fraction of the output area | On a 1920×2939 photo | Use |
|---|---|---|---|
| `fine` (**default**) | `2e-5` (0.002 %) | ~113 px (~11 px square) | keep small deliberate detail — a distant earring, a thin stem |
| `strict` | `5e-4` (0.05 %) | ~2800 px (~53 px square) | clear this benchmark's speckle gate |

The same selected variant is applied by the Stage-4 cleanup and by the
flood-recovery despeckle, so a run is internally consistent. The numbers live in
one place and the benchmark mirrors the `strict` one:

| Constant | File | Role |
|---|---|---|
| `ISLAND_CLEANUP_FRACTIONS` | `src/features/background-removal/island-cleanup.ts` | **the definition** of both variants |
| `MIN_ISLAND_FRACTION` | `src/features/background-removal/refine-mask.ts` | Stage-4 `removeTinyIslands` default — aliases `fine` |
| `MIN_ISLAND_FRACTION_STRICT` | `src/features/background-removal/refine-mask.ts` | Stage-4 strict bar — aliases `strict` |
| `MIN_RECOVERY_ISLAND_FRACTION` | `src/features/background-removal/mask-recovery.ts` | flood-recovery despeckle default — aliases `fine` |
| `SPECKLE_ISLAND_FRACTION` | `scripts/eval/quality_metrics.py` | `component_stats` speckle definition, and therefore this gate — equals `strict` |

The guard is two-sided: `src/features/background-removal/threshold-sync.test.ts`
reads the Python constants and fails if either variant drifts, and
`python3 scripts/eval/accuracy-benchmark.py --self-test` (in CI) reads the TS map
and both defaults and fails the same way. Change a number in one place and the
other side must change with it; there is no undocumented divergence to fall back
on.

**Why the default is `fine`.** Only *disconnected* components strictly below the
bar are deleted, so a thin-but-connected structure (a chain, a hair strand, a
spectacle temple) is never touched regardless of its area. The `fine` bar keeps
legitimately small, detached detail that the `strict` bar would delete, which is
what a customer sees as a lost earring or a clipped product part. The cost is
grain the benchmark counts as speckle.

**Benchmarking.** This gate counts speckle at `5e-4`, so a run scored against it
must use the `strict` variant: `?islands=strict` on the page URL (the eval
harness passes it through `--url`). A `fine` run can still score
`speckle_frac` — the number is computed the same way — but it describes the
shipped default rather than the gate. With the pre-#145 code the Stage-4 bar was
`2e-5`; issue #145 raised it to `5e-4` to match the gate, and the two variants
now make that a choice instead of a hard-coded change.

**Resolution.** The bar is a fraction of the **output** image, not of the grid
the cleanup happens to run on. When `performance.maxProcessingPixels` forces
Stage 4 onto a downscaled working copy, `minIslandArea()` rescales the bar into
that grid (`outputArea × fraction × workArea / outputArea`), so the effective
fraction is identical at any working resolution. Before issue #145 the bar was
recomputed from the work dimensions, so the 16-pixel floor was a floor in *work*
pixels and the effective fraction drifted with the downscale factor. With the
shipped default (`maxProcessingPixels = 4096²`, larger than any image the app
accepts) no eval image is downscaled, so this is a correctness fix rather than a
measured change on the 64-image set. A 16-output-pixel floor keeps 1–2 px specks
removable on thumbnails under either variant.

**Known residual (out of scope for #145).** Under `strict`, nine images still
fail the speckle gate — `hair-fur-03`, `glass-transparent-04`, `complex-bg-01`,
`complex-bg-04`, `complex-bg-08`, `large-02`, `large-05`, `large-08`,
`thin-structure-03` — and in every one the flagged component is **exactly one
pixel** (measured: component areas are `[1]` or `[1,1,1]`), sitting inside a
steep alpha gradient rather than an isolated blob. A one-pixel foreground
component cannot have survived `removeTinyIslands` (any component below the bar
is zeroed), so it became `alpha ≥ 0.5` afterwards: the only later writer is
`smoothTransitionZone`, which averages transition-band pixels and can lift a
single band pixel over the cutoff. The gate then counts it as a speckle
component. No area threshold can catch it — the pass would have to run after
smoothing, or the mask would have to be despeckled after 8-bit quantisation.
That is a pass-ordering change, deliberately not folded into this threshold
alignment.

### 5.2 Segmentation sanity (per image)

| Gate | Rule | Notes |
|---|---|---|
| not fragmented | `largest_component_frac ≥ 0.5` unless the category is `large`/`complex-bg` | bouquets are genuinely multi-part |
| border leak | `border_fg_frac ≤ 0.02` unless `bbox_touch_border` is expected | flags background-remains |
| holes | flag `hole_area_frac > 0.02` for visual review | a punched-through product |
| bandwidth | `0.5 ≤ boundary_bandwidth_px ≤ 6` | too hard ⇒ aliased edge; too soft ⇒ blurry cut |

### 5.3 Tier-B accuracy floors

| Metric | Floor | Meaning |
|---|---|---|
| `IoU@0.5` | ≥ 0.95 | per image; below ⇒ a real segmentation miss |
| `Dice@0.5` | ≥ 0.97 | small-subject tolerant |
| `MAE` | ≤ 0.02 | matches the 512-vs-1024 parity scale (0.003) with headroom |
| `boundary_F@0.5` | ≥ 0.85 | edge quality |
| `fg_recall` | ≥ 0.90 | subject not removed |
| `fg_precision` | ≥ 0.90 | background not kept |

### 5.4 Latency budget (per provider, warm)

| Provider | Budget (mean `infer_ms`) | Basis |
|---|---|---|
| `wasm` | ≤ 8000 ms | baseline mean 4097 ms, range ≈3.9–4.5 s |
| `webgpu` | ≤ 2000 ms | Colab T4 measured 22 ms; desktop Gen-9 measured ≈4.4 s cold |

Latency is a **pass/fail gate**, not a ranking: a slower run that is correct
still passes if it is within budget; a fast run that fails a quality gate is
still a failure.

---

## 6. Per-image verdict and the 8/64 finding

The benchmark output for the 64-photo set is the checklist plus a one-line
verdict per image:

- **PASS** — every §5.1/5.2 gate holds.
- **FAIL(empty)** — `empty` or `washed` verdict; the subject was removed.
- **FAIL(kept)** — `kept` verdict; the background remains.
- **FAIL(dims)** — wrong output dimensions.
- **FAIL(exec)** — the run errored.
- **REVIEW** — a gate is near its limit, or a segmentation metric flags an image
  (`border leak`, `holes`, `fragmented`) that needs a human eye. Visual review of
  `outputs/*.png` remains the authority.

The "8/64 empty" baseline becomes **8 named rows** with their `empty_class`, so
the next task is concrete: for each, decide model limitation vs bug (dark
low-contrast frames are the documented limitation) and record the call in
`notes`.

---

## 7. How to run

```sh
npm run build
# Tier A — descriptive + thresholds over the 64 photos
npm run eval:run -- --provider wasm --out eval-results/wasm
npm run eval:analyze
# Worksheet only (no scoring): identity + threshold columns, blank measurements.
npm run eval:checklist
# Scored: fills the §3 measurements and applies the §5 gates → §6 verdicts.
npm run eval:benchmark -- eval-results/wasm
# WebGPU on a machine that has it (a real GPU; NOT the sandbox):
RUN_GPU=1 npm run eval:run -- --provider webgpu --out eval-results/webgpu
# Provider parity (§3.9): per-image mask flips between the two runs.
npm run eval:benchmark -- eval-results/wasm --parity eval-results/webgpu

# Tier B — exact ground truth (to be built: eval/synthetic-manifest.json)
python3 scripts/distill/evaluate.py --teacher <ref> --candidates <out.onnx> \
    --manifest eval/synthetic-manifest.csv --out eval-results/synthetic
```

The metrics and gate logic are checked offline in CI
(`python3 scripts/eval/accuracy-benchmark.py --self-test`), so a broken gate fails
the build without a model or a browser.

`run-eval.mjs` drives the app's real upload path, so it has to track the UI: it
opens the Studio layer before touching `#dropZone`, and reads the export from the
download link (`#downloadImage`), not the ≤450 px `#outputBox` preview. The sweep
also survives a headless renderer crash — after ~55 full-resolution inferences
Chromium's renderer dies and every later `newPage()` throws `Session with given id
not found`; the harness relaunches the browser (reusing a temp-dir profile so the
model stays cached) and contains any per-image crash, so all 64 images are scored
instead of the run aborting partway.

While it waits on the model or an image it prints the current operation on an
interval (the app's live stage line + newest Console line), so a stalled run
shows where it is; `EVAL_PROGRESS_MS` sets the cadence and `--quiet` /
`EVAL_QUIET=1` turns the heartbeat off. A `--provider webgpu` run without
`RUN_GPU=1` warns immediately — the default Chromium flags disable WebGPU and the
app's hard `?provider=` override has no fallback, so it would fail with
`no available backend found. ERR: [webgpu] backend not found`.

## 8. Open items (the work this spec unblocks)

1. **Build the Tier-B synthetic set builder** — composite the known-alpha
   cut-outs (`clothing-03.png`, `large-06.png`, the 3 reference masks) over the
   background matrix; emit GT alpha PNGs + a manifest. This is the single change
   that turns "agreement" into "accuracy".
2. ~~**Implement the §3.8 segmentation metrics**~~ — **done**; `quality_metrics.py`
   computes components, speckle, largest-component share, holes, hole area,
   border leak, bbox fill, centroid offset, boundary bandwidth and the trimap.
   `analyze-eval.py` keeps the original five keys for baseline diffing and imports
   the same implementations, so the two scripts cannot disagree.
3. ~~**Wire the gates** into a `benchmark.json`~~ — **done**;
   `accuracy-benchmark.py` applies the §5 gates and writes the §6 verdict
   (PASS / FAIL(exec|dims|empty|kept|gate) / REVIEW) per image, plus a run-level
   `--parity` block (§3.9). See §9.
4. **Label a Tier-C gold subset** — 2 images per category, hand-traced — to
   confirm the synthetic score transfers to real photos.
5. **Run the Tier-D rubric** on the 64 outputs (accept / minor / reject) to
   anchor the thresholds to human judgement.

Until item 1 (or item 4) lands, every quality figure in this repo is Tier A/E —
descriptive or agreement — and must be labelled as such. This document exists so
that is a stated position, not an unexamined one.

## 9. Implementation status

| Piece | Where | State |
|---|---|---|
| Descriptive metrics (§3.6–3.8) | `scripts/eval/quality_metrics.py` | done |
| Per-image worksheet (§3.1–3.2) | `scripts/eval/benchmark-checklist.py` (`eval:checklist`) | done |
| Scoring + §6 verdicts (§5) | `scripts/eval/accuracy-benchmark.py` (`eval:benchmark`) | done |
| Accuracy metrics (§4) | `quality_metrics.accuracy_metrics` | done — needs a GT mask to fire |
| Provider parity (§3.9) | `accuracy-benchmark.py --parity <run>` | done |
| Offline gate self-test | `accuracy-benchmark.py --self-test`, wired into CI | done |
| Tier-B synthetic set | — | open (item 1) |
| Tier-C gold masks | `eval/ground-truth/` (see its README) | open (item 4) |

The accuracy columns (`iou`/`dice`/`boundary_f`/`mae`/`fg_precision`/`fg_recall`)
are `null` until a ground-truth mask exists for that image; the report prints
`Accuracy: not measured` and the `n=` of scored images so a reader always knows
which tier a number came from. Drop a mask in `eval/ground-truth/` and re-run
`eval:benchmark` to turn those rows into scores.
