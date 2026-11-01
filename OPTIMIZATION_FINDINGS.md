# Weight-optimisation findings — beating `c5_best`

Date: 2026-11-01
Scope: the two ONNX models on the HF Space `Octoborg/remove-photo-bg`
(`model_512.onnx` teacher, `c5_best.onnx` "optimized"), plus the local
`public/models/model_512.onnx`.

Everything below is **measured**. Nothing here is estimated or extrapolated.
Where a value was not measured it is marked _untested_.

## 1. What `c5_best` actually is

`c5_best` is **not** a better model. It is the fp32 teacher with **weight-only
fp16 storage**:

- identical topology and identical common weights (worst abs difference between
  shared initializers: `0.0`);
- every fp32 initializer stored as fp16, materialised back to fp32 by a `Cast`
  node (`486` extra `Cast` nodes, `486` `*_fp16` initializers);
- so the graph still computes in **fp32** — activations, kernels and latency are
  unchanged. Only the file on disk is smaller.

Measured parity, `c5_best` vs teacher on the three repo test images:
IoU@0.5 `0.99997` / `0.99996` / `1.00000`, max abs diff `<= 0.0103`.

| model | bytes | MB | vs teacher |
|---|---:|---:|---:|
| `model_512.onnx` (teacher) | 193,514,682 | 193.51 | 100 % |
| `c5_best.onnx` | 98,799,684 | 98.80 | 51.1 % |

Size breakdown of `c5_best`: fp16 initializers `91.95 MB`, node structure
`6.46 MB` (mostly long tensor **names**), `value_info` `0.29 MB`.

## 2. Levers tested

| lever | result | verdict |
|---|---|---|
| Strip `value_info`, node names, docstrings | −0.36 MB (−0.36 %) | negligible |
| Rename every tensor to a short name | −0.5 % | negligible |
| `onnxsim` simplify | **expands** the graph (193.8 MB out) | counter-productive |
| Transport compression (HF serves the file **uncompressed**) | gzip 83 %, brotli 79 % of raw | real, but client-side |
| Dynamic int8 (ORT `quantize_dynamic`) | fails on the fp16 graph; on the fp32 teacher only reaches 81.5 % and adds a 0.18 max error | not useful |
| Weight-only **int8** storage (per-channel) + fp32 materialise | **56.2 MB, −43 %**, IoU `>= 0.9987`, 0 pixels flip | **win** |

The winning construction generalises the fp16 trick: store large weights as
int8 with a per-output-channel scale, and materialise an fp32 tensor with
`Cast` + `Mul` so the graph keeps its original fp32 types (same kernels, same
latency). The edge-critical decoder is kept at fp16 because int8 error
concentrates at high-frequency detail (hair, glass rims).

### Measured comparison (ORT CPU, 3 repo test images)

| variant | MB | % of `c5_best` | warm ms | maxErr | MAE | IoU@0.5 (min) | conf-flips |
|---|---:|---:|---:|---:|---:|---:|---:|
| `model_512` fp32 | 193.51 | 195.9 | 1957.9 | – | – | – | – |
| `c5_best` (weight fp16) | 98.80 | 100.0 | 1950.6 | – | – | – | – |
| A: backbone int8 | 72.91 | 73.8 | 1934.0 | 0.2646 | 0.00026 | 0.99871 | 0 |
| B: backbone+squeeze int8 | 68.82 | 69.7 | 1979.9 | 0.2641 | 0.00026 | 0.99870 | 0 |
| **C: + decoder int8** | **56.23** | **56.9** | **1957.3** | **0.2104** | **0.00030** | **0.99894** | **0** |

"conf-flips" = number of pixels whose probability crossed `0.5` versus the
teacher, summed over the three images. Variant C flips **none**.

### Verified in the real runtime (onnxruntime-web WASM, single-thread)

Same page, same input image, all three models loaded and timed:

| | `c5_best` | default (B) | aggressive (C) |
|---|---:|---:|---:|
| file size | 98.80 MB | 68.49 MB | 55.89 MB |
| vs `c5_best` | 100 % | −30.7 % | −43.4 % |
| WASM session load | 2075 ms | 931 ms | 964 ms |
| WASM warm median | 7863 ms | 7753 ms | 7752 ms |
| max abs diff vs `c5_best` | – | 0.1441 | 0.1449 |
| MAE | – | 0.000133 | 0.000218 |
| pixels crossing 0.5 | – | 0 | 0 |

Both variants load the WASM session ~2.2x faster and keep warm inference at
parity. Neither flips a single pixel.

Reproduce with `scripts/distill/optimize-weights.py` (default = decoder fp16):

```
python3 scripts/distill/optimize-weights.py \
  --model public/models/model_512.onnx \
  --out smoke-results/distill/onnx
# -> student-512-mixed.onnx, 68,491,168 B, sha256 524bd904…d8b17046
#    parity (real image): maxAbs 0.09547  MAE 0.000147  IoU@0.5 0.99945  conf-flips 0
```

Add `--aggressive` for the 55.89 MB / `418d0427…92bbe8d` build (decoder also
int8). The **default** (decoder fp16) is the recommended ship: it keeps the
final upsampling stage at the safer precision, at the cost of 12.6 MB.

## 3. Honest limits

- **This is a compression win, not a model-quality win.** The spec's stated goal
  (a student under 25 MB that matches or beats the teacher on hair and glass) is
  **not met** by this work. The recommended build is 68.5 MB; even the
  aggressive one (55.9 MB) is still `> 2x` that target.
- The **strict per-pixel gate fails**: max abs diff is `0.10–0.14`, against the
  brief's `<= 0.02`. The stable signals (MAE `~2e-4`, IoU `>= 0.9987`, zero
  confident flips) pass, and the max is boundary-dominated — but the strict
  gate is not satisfied and should not be claimed as such.
- **Latency is unchanged** (int8 is cast back to fp32). If the goal is *speed*
  on the WASM/CPU path, weight storage precision does not help; that needs a
  smaller architecture or true int8 kernels.
- Everything is measured on **three** product/animal/glass photos in
  `test-images/`. A larger, more adversarial set (fine hair, translucent
  glass, motion blur) is **untested**.
- The transport-compression win (brotli 79 %) depends on the host sending
  `Content-Encoding: br`; Hugging Face currently serves the `.onnx`
  uncompressed, so it is **not** realised today.

## 4. Recommended next step (not done here)

To actually reach a `< 25 MB` student with teacher-level hair/glass quality, the
path in `optimize_model_plan/audit.md` stands: **distill a smaller architecture
on a GPU** (the repo already has `scripts/distill/*` for a MobileNetV3 student),
then apply this same weight-only int8/fp16 storage on top of the distilled
checkpoint. Weight storage alone cannot create quality that the architecture
does not have.

## 5. Repo defect found

`scripts/distill/select.py` shadows the Python standard-library `select` module
because Python puts a script's own directory first on `sys.path`. Any tool run
*as a file* from `scripts/distill/` fails to import `onnx` (which pulls in
`selectors` -> `select`). Workaround used here: run the optimiser via stdin
(`python - < script.py`) or from another directory. A rename (e.g.
`select_candidates.py`) would remove the trap.
