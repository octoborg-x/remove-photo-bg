# Distillation Plan (Phase 1)

> Working plan for the Phase 1 STOP-for-review deliverable (spec
> `optimize_model_plan/audit.md` §6-Phase1.4). Counts marked **measured** come
> from the Phase 1 manifest; anything not yet measured is marked **untested** or
> **pending**.

## 1. Goal and rollback

Produce a small ONNX segmentation model (student) that imitates the production
teacher (`model_512.onnx`, sha256 `eaafaa10…a3b6b87`) on product/marketplace
photos, shrinking the browser download from ≈185 MB to ≤ 25 MB without
unacceptable loss on hair, fur, glass and thin structures. The FP32 teacher is
preserved as the rollback artifact; the production URL, provider, thresholds and
app pipeline are **not** changed.

## 2. Compute

### 2.1 Colab terms finding (spec §3.3) — REQUIRED RECORD

Checked the official Google Colab FAQ on **2026-11-01**
(`https://research.google.com/colaboratory/faq.html`, section "Which activities
are restricted in Colab?"). Verbatim:

> The following are disallowed from managed Colab runtimes running free of
> charge, without a positive Colab compute unit balance, and may be terminated
> at any time without warning:
> - remote control such as SSH shells, remote desktops
> - bypassing the notebook UI to interact primarily via a web UI
> - chess training
> - running distributed computing workers

**Finding:** the spec's primary mode (remote Colab GPU over SSH) is **explicitly
listed as disallowed on free runtimes and may be terminated without warning**.
This is a policy risk, not a technical one.

**Risk and mitigation (no evasion):**
- The spec forbids keep-alive hacks and evading runtime limits, so none are
  used. The session is interactive (I drive it from a notebook that the user
  runs) and the SSH path exists only to run the spec's own scripts.
- **Fallback that removes the risk:** the spec's own §3.4 fallback — a
  self-contained `notebooks/distill-colab.ipynb` the user runs by hand in the
  notebook UI — is the policy-safe path. All scripts are already resumable and
  idempotent, so they run equally well pasted into notebook cells.
- I will continue on the SSH path only while it is available and the user is
  driving the notebook; if Colab terminates the runtime, the notebook fallback
  takes over. Recorded here per spec; **not resolved by evasion**.

### 2.2 Verified GPU environment (2026-11-01)

| field | value |
|---|---|
| GPU | Tesla T4, driver 580.82.07, 15360 MiB (verified via `nvidia-smi`) |
| Python / torch | 3.13.16 / 2.11.0+cu130, `torch.cuda.is_available() == True` |
| onnxruntime-gpu | 1.31.1, providers `TensorrtExecutionProvider`, `CUDAExecutionProvider`, `CPUExecutionProvider` |
| Disk | overlay 113 G, ≈112 G free |

A CPU-only Colab runtime was also encountered (`nvidia-smi` absent,
`torch.cuda.is_available() == False`); per spec §3.1 that is a **STOP**, and GPU
work moved to the T4 host.

## 3. Data plan

### 3.1 Sources (licence-gated per image — spec §5)

Phase 1 seed fetchers (implemented, `scripts/distill/`):

- `fetch-cleveland.py` — **Cleveland Museum of Art Open Access**, `cc0=1` query
  plus a per-record `share_license_status == "CC0"` re-check. This is the bulk
  source (≈14k rows). Product-like `type=` values, `images.print` (~3400 px).
- `fetch-cc0.py` — Wikimedia Commons, per-file machine-readable licence filter
  (CC0 / PD / PDM only; `-sa`/`-nc` dropped). Batched metadata (50 titles/call)
  and an incremental, resumable manifest.
- `fetch-eval.py` — the **evaluation set** (spec §6-Phase1.3), same licence gate
  but disjoint categories, separate manifest/dir (see §3.3).
- `fetch-met.py` — The Met Open Access, `isPublicDomain == true` +
  `primaryImage` only. **Dropped in practice:** the object-detail endpoint
  returns 403 from the Colab host (`436535 403`, `437310 403`), so no Met rows
  were fetched. Kept in the tree for a future host.

Later sources per spec §5 (Smithsonian CC0, AIC, Rijksmuseum, Openverse, Open
Images V7 CC-BY, COCO/LVIS) are **pending**. Smithsonian's public `DEMO_KEY` is
rate-limited to ~10 requests/hour (measured: `X-Ratelimit-Limit: 10`), which is
impractical for bulk; a registered key would be needed. AIC returned 403, NGA
404, Rijksmuseum 410 (retired key).

**Measured Phase 1 counts:** see §5 (filled from the manifest when fetching
completes). Rejections are logged with a reason in
`data/fetcher-logs/<date>.json`.

### 3.2 Preselection (`scripts/distill/select.py`)

Deterministic; logs every rejection reason, applied in order:
1. Technical: short side ≥ 768 px, Laplacian-variance sharpness floor, JPEG
   decode, dHash perceptual dedup (hamming < 6), per-collection/category caps.
2. Safety: face/NSFW filter — **pending** (not yet wired).
3. Teacher confidence: uncertain-pixel ratio, 512-vs-1024-teacher IoU ≥ 0.98,
   teacher-vs-flipped IoU ≥ 0.98 — **pending** (needs Phase 2 labels).
4. Geometry: dominant connected component ≥ 90 % of foreground, area 5–80 % of
   frame, little border contact — **pending** (needs labels).
5. Tiers: A = clean/composite-eligible; B = hair/fur/soft edges; C = glass /
   transparent (never composite).
6. Manual review: contact sheets for ≈5 % of Tier A plus all borderline cases —
   the user reviews before training starts.
7. Leakage control: group split by source collection and near-duplicate cluster.

**Known mitigation:** `select.py`'s name shadows the stdlib `select` module, but
`scripts/distill/_bootstrap.py` (imported first by every script) removes the
script directory from `sys.path`, so `import onnx`/PIL/numpy work. Verified
2026-11-01; no rename needed.

### 3.3 Evaluation set

Real images only, never trained on or tuned, ≥ 100 images if legally possible,
covering plain-background product, hair, fur, glass/translucent, clutter, thin
structures/holes, low contrast, small subject and hard shadows, plus the 3
existing `test-images/`. Built by `scripts/distill/fetch-eval.py` from
licence-gated Commons categories **disjoint from the training categories**, into
`data/eval-manifest.csv` (`split=test`) and `data/eval-images/`. No hand-verified
ground-truth masks supplied yet, so **every metric is labelled "agreement with
teacher, not accuracy"** (spec §6).

## 4. Storage plan (spec §4)

- Local ≤ 40 GB, Drive ≤ 5 GB. `df -h /content` / `du -sh` logged per session in
  `run-metadata.json`.
- Ingestion resizes every image to max side 1536 px, JPEG q90, EXIF stripped;
  originals are never kept. Only IDs/URLs in the manifest are downloaded.
- Teacher soft masks: 8-bit PNG (Phase 2), after verifying on 200 images that
  8-bit quantisation changes IoU vs float by < 0.001 (spec §4.3) — **untested**.
- Composites generated on the fly (deterministic per seed,index); only a small
  review sample is written to disk. Backgrounds: 1k textures, pool ≤ ≈500 files.
- Drive holds manifests, labels tar, checkpoints (last 3 + best), logs, contact
  sheets and the final ONNX. Tars are copied to `/content` and read from local
  disk; never trained from Drive.

## 5. Delivery counts (Phase 1)

**Measured** from `data/manifest.csv` (raw) and `data/manifest-selected.csv`
(after `select.py`), 2026-11-01.

Raw manifest (licence-gated, before preselection):

| dimension | counts |
|---|---|
| total rows | **14,840** (all unique sha256; 0 missing files) |
| per source | cleveland-maa 13,909 · wikimedia-commons 931 |
| per licence | CC0 1.0 13,909 · CC0 681 · Public domain 250 |
| per category | object 7,880 · product 5,009 · jewelry 1,128 · glass 400 · plant 200 · pet 200 · shoe 23 |

After `select.py` (short-side ≥ 768, sharpness ≥ 30, dHash dedup):

| dimension | counts |
|---|---|
| kept | **11,861** (2,979 rejected: 1,541 short-side, 800 duplicate-near, 638 sharpness) |
| per category | object 6,285 · product 3,936 · jewelry 976 · glass 347 · plant 162 · pet 138 · shoe 17 |
| per split | train 8,306 · val 1,779 · test 1,776 |
| per tier | A 11,514 · C 347 |

**Known gap (reported, not hidden):** Tier B (hair/fur/soft edges) is **empty in
the training set** — the museum sources yield object/product/jewelry/glass
categories only, so `select.py`'s category-based tiering produces no B rows. The
evaluation set covers hair/fur separately. A small Tier-B training fetch
(soft-edge/animal-hair categories, disjoint from the eval categories) is the
recommended Phase-2 top-up before training, since the spec wants real Tier-B
images in training.

Evaluation set: `data/eval-manifest.csv` + `data/eval-images/` (see §3.3);
counts filled below once `fetch-eval.py` completes.


## 6. Acceptance criteria (fixed before training — spec §7)

A candidate may replace production only if **all** hold:

- Mean IoU vs teacher ≥ 0.97 and no evaluation image below 0.90.
- No visible failure on glass, hair/fur or thin structures, reviewed per image;
  boundary F-score within an agreed margin of the teacher in those categories.
- Valid transparent PNG at original dimensions through the existing pipeline.
- File size ≤ 25 MB (fp32 or weight-only fp16), ≥ 70 % smaller than 185 MB.
- WASM warm latency ≤ teacher's on the same device (phone reference ≈6.6 s),
  target ≤ 2 s. WebGPU never the default without hardware-specific correctness
  validation.
- No new crashes/memory failures/browser incompatibilities; existing tests pass.
- `DISTILL_PROVENANCE.md` complete, every licence verified and recorded.

If not met, the verdict is **NO-GO** and the FP32 model stays in production.

## 7. Experiment order

1. **Phase 1 (this STOP):** fetchers + manifest + preselection + evaluation set
   + this plan. Deliver counts and the provenance file. **STOP for review.**
2. **Phase 2:** `make-labels.py` (8-bit soft PNG at 512; GPU parity §3.7 and
   8-bit quantisation §4.3 verified); `composite.py` (foreground-colour
   estimation, round-trip filter, deterministic placement, background mix).
3. **Phase 3:** Student A baseline (U2-Netp, licence-checked) as the quality
   floor; Student B (mobile encoder + high-res skips, ONNX-opset-17-safe ops,
   BN folded, ≤ 25 MB fp32). `train.py` with the spec loss, CPU smoke test then
   a first short GPU run — **STOP and report** before full training.
4. **Phase 4:** export (opset 17, sigmoid included), optimisation experiments
   reported separately (shape inference, onnxsim, weight-only fp16; int8 only if
   time allows), full evaluation per category, browser benchmark, and the
   GO / GO-WITH-FALLBACK / NO-GO verdict.
