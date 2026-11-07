# Model optimisation report

Scope: shrink the shipped background-removal ONNX artifacts without changing the
app contract, then re-pin them. Work done in the OpenHands CPU sandbox
(`scripts/distill/`, pinned by `requirements-distill.txt`).

Everything below is **measured** unless it is explicitly labelled an estimate.
No GPU step was run: the distillation phases in `optimize_model_plan/audit.md`
need a free Colab T4 and are still open (see "Untested" at the end).

## 1. Reproduction (baseline trust)

All three shipped artifacts were re-derived and verified byte-for-byte against
the pins in `scripts/fetch-models.mjs` before any change:

| artifact | bytes | SHA-256 | reproduced? |
|---|---|---|---|
| `model_512_int0_fp32.onnx` | 193,514,682 | `eaafaa10f19c63b77e2bae77bf4b2f59054c208ea08b8c6648f95ef36a3b6b87` | yes |
| `model_512_int0_fp16.onnx` | 98,799,684 | `099c89de1d9a3da27af3d5329460f543e5d9390fc45e7ba7d0e7360b378d5f97` | yes |
| `model_512_int8_fp16.onnx` | 68,491,168 | `524bd904f68a48c3390bd27ab85d9e8107af0e1b8e79f20197ecdeaad8b17046` | yes |

The int8+fp16 artifact was rebuilt from the fp32 teacher and matched the shipped
file exactly, so the quantiser used here is the same one that produced it.

## 2. Where the bytes are

Census of the fp32 teacher (`scripts/distill/onnx-census.py`):

- 96.5% of the file is initializer (weight) bytes; 0 dead nodes.
- 27 groups of byte-identical initializers, about 2.9 MB reclaimable.
- **6,245,154 B** of `metadata_props` is PyTorch `torch.onnx` debug metadata
  (source file names, stack traces) baked into every node, plus graph-level
  `ExportedProgram` metadata. This is dead weight in a production artifact.

In the 68.5 MB int8+fp16 artifact: 31.6 MB INT8 + 30.1 MB FP16 storage, of which
the backbone (`m.bb.*`) is 27.66 MB, the decoder 25.37 MB, the squeeze module
4.12 MB and the output head 4.78 MB.

`onnxsim` was tried and rejected: it cut nodes 2213 → 1862 but made the file
slightly **larger**, so it buys nothing here.

## 3. Lossless cleanup (shipped)

`scripts/distill/optimize-onnx.py --scope none` removes the debug metadata, the
duplicate initializers and the `value_info` entries, changing no computation.

| artifact | before | after | delta | SHA-256 | parity |
|---|---|---|---|---|---|
| `model_512_int8_fp16.onnx` | 68,491,168 | **60,763,193** | −11.3% | `10f1cf12d614b8b9db8a8dc9183c8525cbf6e020bb230e9b15daaf127012bc26` | **62/62 images bit-identical** |
| `model_512_int0_fp16.onnx` | 98,799,684 | **92,519,896** | −6.4% | `c77e5a8ca6866dc8ff536d9aafefb1591e94d906b7b68528f14cb0be070eeae5` | bit-identical |
| `model_512_int0_fp32.onnx` | 193,514,682 | **184,339,317** | −4.7% | `5f4a5e0f1f39a0aebb2a0087efa2a8553ea6c3012f8fea69dbaa58194fe83d96` | bit-identical |

"Bit-identical" means `np.array_equal` on the output tensor for every one of the
62 eval images, not a tolerance. This is free size with zero numerical risk, so
all three artifacts are shipped cleaned.

## 4. Quantisation candidates (measured, then rejected)

Every candidate was evaluated against the fp32 teacher over the 62-image
`eval/images` set with the app's exact preprocessing (bilinear 512, /255,
ImageNet mean/std, NCHW). Agreement with the teacher is **not** accuracy: there
is no ground-truth mask, so all of these are model-to-model numbers.

| candidate | MB | mean IoU@0.5 | min IoU | flips | images w/ flips | max band MAE |
|---|---|---|---|---|---|---|
| lossless fp32 (reference) | 184.34 | 1.00000 | 1.00000 | 0 | 0/62 | 0.0000 |
| lossless fp16 | 92.52 | 0.99989 | 0.99770 | 578 | 40/62 | 0.0354 |
| **shipped int8 backbone** | 68.49 | 0.98114 | **0.00000** | 122,628 | 56/62 | 0.6115 |
| int8 decoder convs only | 83.79 | 0.99882 | 0.95842 | 7,086 | 56/62 | 0.1225 |
| int8 backbone + decoder convs | 52.41 | 0.98107 | 0.00000 | 123,561 | 56/62 | 0.6113 |
| int8 everything (`m.*`) | 48.50 | 0.98045 | 0.00000 | 125,719 | 56/62 | 0.6104 |

The 3-image check used previously reported zero threshold flips for the shipped
artifact. On 62 images the same artifact flips pixels on 56 of them, so that
3-image gate was too weak to be a shipping criterion.

### 4.1 The `clothing-04.jpg` failure, and why it is not an int8 bug

On `clothing-04.jpg` (person with a small dog, outdoors) the fp32 teacher returns
a 41.6%-foreground mask, while the shipped int8 artifact returns an **empty
mask** (0.0% foreground, IoU 0.0). This is the single catastrophic case.

The cause is the teacher, not the quantiser:

| input | teacher foreground |
|---|---|
| clean | 41.57% |
| + N(0, 0.001) pixel noise | 46.36% |
| + N(0, 0.003) | 58.30% |
| **+ N(0, 0.01)** | **0.02%** |
| + N(0, 0.03) | 0.00% |

A 0.01-scale perturbation — far smaller than int8 weight error — already
collapses the fp32 model to an empty mask. The output sits on a knife edge
there, so any weight error tips it. The fp16 artifact (0.99989 mean, 0.9977 min)
stays on the correct side.

Percentile clipping of the int8 scales was tried as a fix and does not help:
clipping at the 99.9th percentile reaches only IoU 0.756 on that image, and
99.5/99.0 collapse it completely.

### 4.2 Decision

- **Ship the lossless cleanup** of all three artifacts. Free size, provably
  identical outputs.
- **Do not change the default.** The spec (§9) says not to change the shipped
  model silently, and every quantisation change here is a trade that needs the
  user's call.
- The honest ranking of what was measured:

  | option | MB | meets "no image < 0.90"? | note |
  |---|---|---|---|
  | lossless cleanup only (shipped here) | 60.76 | no (`clothing-04.jpg` 0.0) | smallest, but keeps the knife-edge failure |
  | int8 decoder convs only | 83.79 | **yes** (min 0.9584) | safest quantisation, but **larger** than the current default |
  | fp16 weights | 92.52 | **yes** (min 0.9977) | numerically safest, largest |
  | int8 backbone ± decoder convs | 48–84 | no | collapse on `clothing-04.jpg` |

  No measured candidate meets the §7 size rule (≤ 25 MB) or the ≤ 2 s latency
  target, so none can replace production.
- The `clothing-04.jpg` knife edge is a property of the **fp32 teacher**, not the
  quantiser, and is the real root cause. Fixing the teacher (or excluding such
  images) is what would make an int8 backbone safe; that is out of scope here and
  is the recommended next step.

## 5. Transport compression (measured, informational)

The hosting path serves raw files; the service worker caches them. For reference
only, the cleaned artifacts compress as:

| artifact | raw | gzip −9 | brotli −11 |
|---|---|---|---|
| `model_512_int8_fp16.onnx` | 60.76 MB | 52.23 MB | 50.67 MB |
| `model_512_int0_fp16.onnx` | 92.52 MB | 81.85 MB | 77.73 MB |
| `model_512_int0_fp32.onnx` | 184.34 MB | 164.50 MB | 162.51 MB |

No transport change is made in this PR.

## 6. Acceptance against `optimize_model_plan/audit.md` §7

| criterion | status |
|---|---|
| Mean IoU vs teacher ≥ 0.97 | default: 0.98114 — passes |
| No eval image below 0.90 | default: 0.00000 (`clothing-04.jpg`) — **fails** |
| No visible failure on glass/hair/fur/thin | int8 flips on 56/62 — **not met** |
| Valid transparent PNG at original size | **passes** (18/18 browser checks, RGBA colour type 6) |
| File size ≤ 25 MB | 60.76 MB — **fails** |
| WASM warm latency ≤ teacher | 4,866 ms vs the teacher's ~4.3 s reference — **fails** |
| Provenance complete | unchanged; see `THIRD_PARTY_LEGAL_NOTICES.md` |

**Verdict: NO-GO for replacing the model with a distilled student.** This change
does not claim otherwise: it is a lossless size reduction of the existing
artifacts plus a correction of an over-optimistic parity claim. The §7 bar needs
the trained student from Phases 1–3, which requires Colab GPU.

## 6.1 Browser measurements (real Chromium, WASM)

Run after the artifacts were re-pinned, against a local Vite dev server:

- `npm run test:browser`: **18/18 checks pass**. PNG export is colour type 6
  (real alpha), JPG export present, **0 third-party requests** during processing,
  worker/manifest failures surface in the UI, and the metered-download prompt now
  reads "about 57.9 MB".
- `node scripts/measure-browser-memory.mjs glass-wine.jpg`: stage `Done`,
  warm inference **4,866.3 ms**, peak above baseline **1,254 MB** (baseline
  927 MB, after model load 1,763 MB, after run 2,131 MB), 39 samples.

These are sandbox CPU numbers, not phone numbers; the phone reference is ~6.6 s.

## 7. Untested

- WebGPU behaviour and any GPU latency.
- Real accuracy (no hand-verified ground-truth masks exist).
- The Colab GPU distillation phases (labels, student training, export) — not run.
- Phone / real-device latency and memory for the new artifacts.
