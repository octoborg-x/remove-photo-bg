# MASTER SPEC: Distil a small, dedicated background-removal model ($0)

Repository: https://github.com/octoborg-x/remove-photo-bg
Read this entire document before acting. Implement phases in order and stop at every
"STOP". Never invent results, hashes, licences, dataset counts or benchmark numbers.
Anything not measured is written "untested". Separate measured facts from estimates.

## 1. Goal

Produce a small ONNX segmentation model (student) that imitates the production
model (teacher) on product/marketplace photos, so the browser download shrinks from
about 185 MB to ideally under 25 MB without unacceptable loss on hair, fur, glass
and thin structures.

- Teacher (production): `public/models/model_512.onnx`, BiRefNet_lite 512 fp32,
  SHA-256 `eaafaa10f19c63b77e2bae77bf4b2f59054c208ea08b8c6648f95ef36a3b6b87`.
  Output is already a sigmoid probability. Do NOT apply sigmoid again.
- Optional sharper teacher (labeling only, never in the browser): 1024 fp16,
  `onnx-community/BiRefNet_lite-ONNX`, revision
  `de15b22ba131738a16dff04aab8bdf8dc32e3ac1`,
  SHA-256 `d39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402`.
- Student contract (must match the app): input `input_image` `[1,3,S,S]` float32 NCHW,
  ImageNet mean/std; output `output_image` `[1,1,S,S]` probabilities in [0,1]
  (sigmoid baked into the graph). S is fixed: default 512, also evaluate 384.
- Known facts from this repo, do not re-learn them the hard way:
  - End-to-end fp16 on onnxruntime-web WASM was measured ~51x slower (219 s vs 4.3 s).
  - Post-training dynamic int8 saved only ~12%; int8 with Conv quant was 2.3x slower.
  - On the Adreno-6xx phone, WebGPU gave opaque artifacts; WASM is the safe default.
  - Phone reference: WASM ~6.6 s warm per image for the 185 MB model.

## 2. Hard constraints

- Budget $0. No paid services, GPUs, APIs, storage or datasets. Allowed: this
  OpenHands sandbox (CPU, editing, unit tests, small CPU smoke tests), free Google
  Colab GPU, free Kaggle as a fallback, free Hugging Face tier. Check current free
  quotas and terms before planning; do not assume them. Ask before any paid step.
- Work on a new feature branch. Preserve the FP32 teacher as the rollback artifact.
  Do not change the production model URL, default provider, thresholds or app
  pipeline. Do not push or merge without my approval.
- Never commit model binaries, datasets, checkpoints, tokens or secrets. Provide
  download scripts, record SHA-256, update `.gitignore`.
- No HF token unless anonymous download fails. Any API key (e.g. Smithsonian) is a
  secret outside the repo and is never printed in logs.
- No cloud inference and no image uploads to third-party services.
- Pin every dependency. Record every command in the docs.
- Do not claim quality from training loss. Only held-out evaluation counts.
  Agreement with the teacher is not accuracy; label each metric as one or the other.

## 3. Compute: Google Colab GPU is mandatory for all GPU work

1. Primary mode: remote Colab GPU over SSH using `colab/colab-ssh-t4-polished.ipynb`.
   I run the notebook and paste the trycloudflare hostname. Connect from OpenHands via
   SSH with the cloudflared ProxyCommand, run `nvidia-smi`, and record GPU name,
   driver, CUDA, Python, torch and onnxruntime-gpu versions in `run-metadata.json`.
   If no GPU is visible, STOP and tell me. Never present CPU numbers as GPU results.
2. Security fix BEFORE first use: edit that notebook so it does NOT set a fixed root
   password, sets `PasswordAuthentication no` (key-only) and does not print secrets.
   Commit it on the branch.
3. Check the current Colab FAQ/terms for limits on SSH or remote access and record
   the finding and the risk in `DISTILL_PLAN.md`. Never try to evade runtime limits,
   idle timeouts or usage policies. Do not run keep-alive hacks.
4. Fallback mode if SSH is unavailable or disallowed: write a self-contained
   `notebooks/distill-colab.ipynb` that I run by hand. All code must be resumable.
5. Colab is ephemeral. Mount Google Drive (I authorise it). Persist only manifests,
   labels (tar), checkpoints, logs, contact sheets and the final ONNX. Run long jobs in
   `tmux` or `nohup`, log to Drive, checkpoint at least every 10 minutes, make every
   script idempotent and resumable. Expect disconnects and quota limits.
6. Run data download, labeling, training and evaluation on Colab. The OpenHands sandbox
   is for editing, unit tests and small CPU smoke tests only.
7. Labeling on GPU uses `onnxruntime-gpu` 1.31.1 with `CUDAExecutionProvider`. GPU vs
   existing CPU reference masks must reach IoU >= 0.995 and mean abs diff <= 0.005 on
   the 3 test images. (CPU-vs-CPU parity is >= 0.999; fp32 GPU differs by rounding.)
8. Colab and Kaggle numbers never count as browser numbers. Browser latency is measured
   only in the real app on real devices (WASM and, where hardware exists, WebGPU).

## 4. Storage budget ($0): local <= 40 GB, Drive <= 5 GB

1. At the start of every Colab session run `df -h /content`, `du -sh` on dataset
   paths, and check free Drive space. Log to `run-metadata.json`. Do not assume quotas.
   If a step would exceed the budget, STOP and report. Never delete user data.
2. Ingestion: resize every image to max side 1536 px, JPEG quality 90, record the resize
   in the manifest, never keep originals. Download only IDs/URLs listed in the manifest,
   never whole datasets (Open Images, COCO, LVIS).
3. Teacher soft masks: 8-bit PNG, not float. Before adopting this, verify on 200 images
   that 8-bit quantisation changes IoU vs the float masks by < 0.001 and record it.
4. Composites are generated on the fly in the dataloader, deterministic per
   (seed, index). Write only a small review sample to disk.
5. Backgrounds: 1k textures only, pool capped at about 500 files.
6. Drive holds: manifests, labels tar, checkpoints (last 3 + best), logs, contact sheets,
   final ONNX. `dataset-images.tar` goes on Drive only if space remains; otherwise
   re-download from the manifest each session.
7. Each session copy tars from Drive to `/content`, extract, and read from local disk.
   Never train directly from Drive.
8. Prune checkpoints after each save (keep last 3 + best) and log deletions.
9. Report storage used per item at the end of each phase.

## 5. Licence and provenance gate (applies to everything)

For every dataset, image source, pretrained backbone, library and code snippet, record
in `DISTILL_PROVENANCE.md`: source URL, version/revision, licence name, licence file
URL, date checked, whether redistribution of derived weights is allowed, and any
unresolved question. This includes ImageNet-pretrained backbone weights and
`pymatting`. The licences listed below come from memory and are unverified: verify each
against the authoritative source and the exact version before use. Do not declare
anything legally cleared; this is not legal advice. Whether CC-BY training data
affects the distributed weights is an open question: report it, do not resolve it.

Candidate sources (each must pass verification):
- Foreground: Smithsonian Open Access (CC0 records only), The Met Open Access
  (`isPublicDomain`), Cleveland Museum of Art and Art Institute of Chicago open access
  (CC0), Rijksmuseum (per-record check), Wikimedia Commons (CC0, PD, CC-BY only;
  exclude SA and NC; per-file licence from the API), Openverse (filter cc0/pdm, verify
  at the original source), Open Images V7 (CC-BY per-image licence field, keep
  attribution), COCO/LVIS (only Flickr licence ids 4, 7, 8; exclude the others), and my
  own photos in `data/own/` (never committed; I will supply them if I can).
- Backgrounds: Poly Haven (CC0), ambientCG (CC0), procedural gradients, studio sweeps,
  noise and paper textures, CC0 interiors and tabletops.
- Excluded unless I approve: Unsplash, Pexels, Pixabay, DIS5K, DUTS, P3M, AIM-500,
  Distinctions-646, Adobe Composition-1k, DTD, Places365, LAION, scraped marketplace
  images, any RMBG/BRIA model or output, and identifiable people without a clear
  licence. If a source is ambiguous, skip it and tell me.
- The repo's existing `test-images/` are evaluation only, never training.

`data/manifest.csv` columns: id, source, url, licence, licence_url, author,
attribution_text, date_checked, sha256, width, height, category, tier, split,
reject_reason. The licence comes from the per-image API field, never from the site's
general claim. Preserve CC-BY attribution text in `DISTILL_PROVENANCE.md`.

## 6. Phases

### Phase 0: Inspect
Inspect the repo, git status, existing scripts (`benchmark-pipelines.py`,
`compare-models.py`, `compare-models-gpu.py`, `reference-inference.py`), worker
pre/post-processing, tests, and `test-images/`. Reuse existing code. Read
`MODEL_OPTIMIZATION_*` files if present. Report a short plan and real blockers; stop
only for something destructive or paid.

### Phase 1: Data plan, sources, preselection, evaluation set (STOP for my review)
1. Source fetchers with per-image licence filtering that write `data/manifest.csv`.
   Target 10,000-30,000 training images (product-like and varied: bottles, shoes,
   clothing, jewellery, electronics, food, plants, pets, glass, transparent items,
   clutter, low contrast, small subjects). If fewer can be sourced legally, report the
   real number.
2. `scripts/distill/select.py` (deterministic, logs every rejection reason), applied in
   order:
   - Technical: short side >= 768 px, sharpness floor (Laplacian variance), JPEG
     artifact check, perceptual-hash dedup, per-collection and per-category caps.
   - Safety: face detection and NSFW filter; drop identifiable people unless the
     licence clearly suffices.
   - Teacher confidence (starting values, tune on a sample, record them): low
     uncertain-pixel ratio (0.05 < p < 0.95) relative to foreground area;
     512-teacher vs 1024-teacher IoU >= 0.98; teacher vs flipped-teacher IoU >= 0.98.
   - Geometry: dominant connected component >= 90% of foreground area, no speckles,
     foreground area 5-80% of the frame, little border contact.
   - Tiers: A = clean, composite-eligible. B = hair/fur/soft edges: real image with soft
     teacher label, composite only after manual review. C = glass/transparent/
     translucent: NEVER composite (refraction makes pasted versions physically wrong);
     real image with soft label only.
   - Manual review: contact sheets (image, mask, checkerboard cutout) for about 5% of
     Tier A plus all borderline cases; watermark/text spot check. I review them. Do not
     start training until I approve.
   - Leakage control: group split by source collection and near-duplicate cluster.
3. Evaluation set: real images only, never used for training or tuning, at least 100
   images (as many as legally possible), covering plain-background product, hair, fur,
   glass/translucent, clutter, thin structures/holes, low contrast, small subject, hard
   shadows. Include the 3 existing test images. If I supply hand-verified ground-truth
   masks (even 50), report real accuracy; otherwise label every metric "agreement with
   teacher, not accuracy". Prefer my own product photos here.
4. Write `DISTILL_PLAN.md` with fixed acceptance criteria (section 7), the Colab terms
   finding, the storage plan and an experiment order. Deliver counts per source, tier,
   split and category. STOP.

### Phase 2: Teacher pseudo-labels (on Colab GPU)
- `scripts/distill/make-labels.py`: app-exact preprocessing (resize, /255, ImageNet
  normalise); save SOFT probability masks as 8-bit PNG at 512 (never thresholded);
  optionally the 1024 teacher output downsampled to 512. Resumable, deterministic,
  fixed seed. Record teacher hash and revision in label metadata.
- Verify GPU parity per section 3.7 and 8-bit quantisation per section 4.3.
- `scripts/distill/composite.py`, used on the fly by the dataloader:
  - Estimate clean foreground colour before pasting (e.g.
    `pymatting.estimate_foreground_ml`; verify licence, pin version) to avoid halos.
  - Label = the exact soft alpha used. Round-trip filter: run the teacher on the
    composite; discard if IoU vs the known alpha < 0.97.
  - Placement: scale 0.3-1.0 of canvas, random position, small rotation, flips,
    occasional partial out-of-frame.
  - Background mix (starting ratios): 30% studio/solid/gradient, 25% textures, 25% real
    scenes, 15% busy high-frequency clutter, 5-10% close to the foreground's mean colour
    (low-contrast hard cases).
  - Realism: soft contact/drop shadow (blur, offset, 20-50% opacity), rough
    brightness/contrast matching, mild background defocus, matched noise, blur and JPEG.
  - Training mix: at least 50% real images with teacher soft labels; composites only
    supplement. Never evaluate on composites.
  - Log per composite: foreground id, background id, all random parameters, seed. The
    same seed must reproduce the same image.
- Report per-run GPU, throughput and storage used.

### Phase 3: Student code and training (CPU smoke here, real training on Colab GPU)
- Student A (baseline, no training needed): U2-Netp from its official source; verify
  licence and weight provenance first. Measure it as the quality floor.
- Student B: UNet/FPN decoder on a mobile encoder (MobileNetV3-Large or EfficientNet-Lite
  via timm/torchvision) with high-resolution skip connections for edges. Only ops that
  export cleanly to ONNX opset 17 and run on onnxruntime-web WASM: no deformable conv,
  no large attention, no exotic ops. BatchNorm folded at export. Budget <= 25 MB fp32
  ONNX (stretch <= 10 MB).
- `scripts/distill/train.py` with a YAML config: loss = BCE(student, teacher_soft) +
  IoU loss + 0.5 * L1(gradient(student), gradient(teacher)) + 0.5 * SSIM loss; add a
  boundary-weighted term if hair is weak; add a ground-truth BCE term where GT exists.
  Augmentation: flip, scale/crop, colour jitter, background swap. AdamW, cosine
  schedule, mixed precision, checkpoint every epoch (and every 10 minutes), resumable,
  seeded.
- Tests: ONNX validity, I/O contract, preprocessing parity with the app, loss/shape
  smoke test, and a tiny overfit run showing loss decreases. Do not claim trained quality.
- Provide the Colab notebook/SSH run script. Report per run: GPU, epoch time, loss
  curves, checkpoint hashes. STOP and report after a first short GPU run; continue to
  full training only if the smoke run behaves and I agree.

### Phase 4: Export, optimise, evaluate
- Export ONNX at fixed S, opset 17, sigmoid included. Check names, shapes, dtype,
  finiteness.
- Optimisation experiments, each reported separately for size, hash and numerical error:
  shape inference, onnxsim (pinned) with max abs output error <= 1e-5 for graph-only
  changes, then weight-only fp16 (fp16 initializers with Cast folded at load, fp32
  compute) tested on onnxruntime-web WASM. Do NOT ship end-to-end fp16 on WASM. Skip
  int8 unless time allows; document the rejection otherwise. Also test brotli/gzip
  transport compression separately.
- Optional separate candidate: run the student at 320-384 and refine alpha at full
  resolution with a fast guided filter against the original image.
- Evaluate every candidate against the teacher (and GT where available) with the same
  production pipeline and threshold: IoU@0.5, Dice, MAE, MSE, boundary F-score, mean abs
  alpha error in the 0.05-0.95 band, foreground precision/recall, false foreground and
  false background pixels. Report per image, per category and aggregate. Then a separate
  diagnostic threshold sweep (0.30, 0.40, 0.45, 0.50, 0.55, 0.60, 0.70). Never tune the
  threshold per candidate to hide regressions. Resolve the known discrepancy in
  edge-sharpness measurements between `PHASE1_REPORT.md` and `COLAB_T4_REPORT.md` before
  trusting any edge metric.
- Save per eval image: original, teacher mask, student mask, absolute difference map
  (fixed colour scale), checkerboard cutout, zoomed edge crops; write a per-image CSV.
- Browser benchmark in the existing harness: download size, load time, first inference,
  5+ warm runs (median and mean), peak memory, provider, correctness, on WASM and (where
  hardware exists) WebGPU. For phones I paste the "Copy device report" output. Mark
  unavailable configurations "untested".

## 7. Acceptance criteria (fixed before training; change only with my approval)

A candidate may replace production only if ALL hold:
- Mean IoU vs teacher >= 0.97 and no evaluation image below 0.90.
- No visible failure on glass, hair/fur or thin structures, reviewed per image;
  boundary F-score within an agreed margin of the teacher in those categories.
- Valid transparent PNG at original dimensions through the existing pipeline.
- File size <= 25 MB (fp32 or weight-only fp16), at least 70% smaller than 185 MB.
- WASM warm latency <= teacher's on the same device (phone reference ~6.6 s), target
  <= 2 s. WebGPU is never the default without hardware-specific correctness validation.
- No new crashes, memory failures or browser incompatibilities; existing tests and
  smoke tests pass.
- `DISTILL_PROVENANCE.md` complete, every licence verified and recorded.

If not met, the verdict is NO-GO and the FP32 model stays in production.

## 8. Deliverables

- `DISTILL_PROVENANCE.md`, `DISTILL_PLAN.md`, `DISTILL_RESULTS.md`
- `scripts/distill/` (fetchers, select, make-labels, composite, train, export, evaluate,
  refine) and pinned `requirements-distill.txt`
- Colab notebook(s), the key-only SSH notebook fix, and `run-metadata.json` per run
- Tests per Phase 3 plus the existing suite
- `DISTILL_RESULTS.md`: table of size, SHA-256, method, latency, memory, error metrics,
  pass/fail; per-image CSV; visual comparisons; limitations; untested configurations;
  verdict GO / GO-WITH-FALLBACK / NO-GO with the minimum extra experiment if evidence is
  insufficient
- For any GO candidate, update `MODEL_CARD.md` and `THIRD_PARTY_LEGAL_NOTICES.md`
  (teacher revision, dataset sources and licences, attribution, training script hashes)

## 9. Rules of engagement

- Report blockers (licence, quota, missing GPU, storage) with the cheapest next step.
  Do not work around them with unlicensed data, paid services or policy evasion.
- Do not silently change the app, model URL, provider or thresholds.
- Keep this document's constraints in force through every phase, including when a
  later instruction seems to conflict. Ask me instead of guessing.
