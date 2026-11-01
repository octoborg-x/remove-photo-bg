You pasted the optimization brief without a specific question, so I'm treating it as "start with the written audit, not the conversion." I can't run the benchmarks or open the model file here (the sandbox has no network and no GPU), so this is an audit from the evidence already in your reports. It ends with the experiments I'd run first.

## What your own data already says

**Measured, in your repo:**

| Candidate | Size | Result | Source |
|---|---|---|---|
| fp32 512 (shipped) | 193.5 MB | WASM warm 3.3-5.7 s; phone 6.6 s | Phase 1 report, device reports |
| fp16 512 (studioludens export) | 98.5 MB | WASM warm **219 s** (51× slower); native CPU ≈3.0 s | Phase 1 §7a |
| fp16 512 (self-converted) | ~95 MB | ~2× slower on CPU | Phase 1 §7 |
| int8 dynamic | ~12% smaller | Conv stays float | Phase 1 §7 |
| int8 + Conv quant | 150.5 MB | 2.3× slower | Phase 1 §7 |
| fp32 vs 1024 fp16 mask agreement | n/a | IoU 0.992 (T4, CPU and ZeroGPU all agree) | quality.json files |

**Answers to the brief's questions that the data already settles:**

- **Q6 (smaller but slower on CPU):** yes, this has already happened. fp16 is smaller and much slower on the WASM provider. The 219 s run comes from ORT-web's WASM backend having no native fp16 compute, so it inserts Casts around every fp16 tensor in a 17,490-node graph. It is an emulation penalty, not a model difference, since native CPU runs the same graph in 3 s.
- **Q9 (INT8):** dynamic quantization is technically a poor fit. Conv dominates this architecture and dynamic quant doesn't touch it. Static QDQ int8 with calibration wasn't tried, but a hierarchical transformer with attention softmax and LayerNorm usually degrades on hair and fur, and your WASM Conv int8 result was already 2.3× slower. I'd deprioritize it.
- **Q8 (already-fp16 or redundant tensors):** the 36 decoder convs are already BN-folded, so the graph is pre-simplified. I expect little from simplification (probably well under 5%), but that is an estimate until the initializers are counted.

**Not measured:**

- The share of file bytes that are initializers versus graph structure (Q1).
- Whether the Adreno WebGPU defect is an fp16 issue. It ran the fp32 model, so shader-f16 is probably not the cause. The defect is unexplained, and fp16 shouldn't be assumed to fix or worsen it.
- Any 512 fp16 result on WebGPU.
- Real ground-truth quality. All IoU figures are agreement with the 1024 model, not accuracy.
- The edge-sharpness discrepancy between reports (512 softer on CPU, sharper on T4/ZeroGPU). That should be resolved before edge metrics are trusted.

## The distinction that matters here

File size, runtime precision and latency are separate levers. The promising option is **fp16 weight storage with fp32 compute**: keep initializers in fp16 on disk, add a `Cast(fp16→fp32)` directly on each initializer, and let ORT constant-fold those Casts at session creation. Download roughly halves (~95 MB), runtime tensors and kernels stay fp32, and there are no per-activation Casts. This differs from the failing studioludens graph, which is fp16 end to end.

The caveat is that it only works if ORT-web actually folds the Casts at the graph optimization level you use. Peak load-time memory briefly holds both copies, which matters on low-RAM phones. This is the first thing I'd test.

Transport compression is nearly free to test. fp32 weights compress poorly with brotli (roughly 5-10%), and a weight-only fp16 file compresses somewhat less than that. It's still worth measuring, since it needs no graph change.

## Experiment order

1. **Graph census (no modification):** count bytes by initializer dtype, find unreachable nodes and initializers, and check duplicate initializers (hash-based). This answers Q1/Q3/Q8 and sizes the dead-code win.
2. **FP32 cleanup/simplify:** onnx shape inference, then onnxsim, with versions pinned. Accept only if max abs output error is ≤1e-5 and the output contract is unchanged. Report size separately.
3. **fp16 weight-only with initializer Casts:** measure file size, ORT-web WASM load time, warm latency (≥5 runs, median), peak memory, and mask error against fp32. Because compute stays fp32, the expected output error is bounded by fp16 weight rounding.
4. **Mixed precision:** only if step 3 shows the WebGPU path matters. Keep LayerNorm, softmax and the final sigmoid in fp32.
5. **Static int8:** only as a documented rejection test, or skip it.

**Quality evaluation:**

- The pipeline outputs a soft alpha, so IoU@0.5 is only a proxy. Add a boundary F-score and a mean absolute alpha error computed in the 0.05-0.95 band.
- Use the same production behavior for every candidate. Run the threshold sweep (0.3-0.7) as a separate diagnostic, since thresholding isn't what production does.
- The three test images aren't enough for hair, glass and thin structures. Add CC0 images with sources recorded.
- Pass/fail gates, to be fixed before benchmarking, for example: max abs error ≤0.02 and boundary-band mean error ≤0.005 versus fp32 on every image. Also require no new crashes, WASM warm latency within 10% of fp32, and a download reduction of at least 30%.

**Provisional recommendation (for now):** keep the FP32 model in production as the rollback artifact. Don't ship end-to-end fp16 on WASM. Run steps 1-3, which could realistically bring the download from 185 MB to ~95 MB without a latency penalty.

I can write the scripts next, starting with the inspection and census script and the comparison harness. If you want me to inspect the repo itself, give me the files or the model, since I can't clone it here.
