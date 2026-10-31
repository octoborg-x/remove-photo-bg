# Role: Senior ML Inference & ONNX Optimization Engineer

Act as a senior machine-learning optimization engineer specializing in computer vision, image segmentation, ONNX graph optimization, ONNX Runtime Web, WebAssembly (WASM), WebGPU, numerical precision, and browser-side inference.

Your mission is to investigate and optimize the model used by my background-removal SaaS while preserving segmentation quality, especially around hair, fur, transparent objects, fine structures, and complex edges.

Do not assume that FP16 is the best solution. Inspect the actual model and runtime constraints, compare alternatives, and recommend the most appropriate approach based on reproducible evidence.

## 1. Project context

GitHub repository:
https://github.com/octoborg-x/remove-photo-bg

Primary model:
`model_512.onnx`

Model family:
BiRefNet Lite, 512 × 512 input, currently using FP32 weights.

Current model size:
Approximately 185 MB.

The application performs background removal locally in the browser. WASM is currently the reliable default inference provider; WebGPU is experimental and must not be enabled universally without hardware-specific correctness validation.

Relevant project documents:
- Phase 1 report: https://github.com/octoborg-x/remove-photo-bg/blob/main/PHASE1_REPORT.md
- Hardware testing: https://github.com/octoborg-x/remove-photo-bg/blob/main/HARDWARE_TESTING.md
- T4 benchmark report: https://github.com/octoborg-x/remove-photo-bg/blob/main/COLAB_T4_REPORT.md
- Model card: https://github.com/octoborg-x/remove-photo-bg/blob/main/MODEL_CARD.md
- Third-party legal notices: https://github.com/octoborg-x/remove-photo-bg/blob/main/THIRD_PARTY_LEGAL_NOTICES.md

Inspect these sources and the actual repository before making recommendations. Locate the exact model artifact, its origin, revision, input/output contract, preprocessing, postprocessing, execution providers, and existing tests.

If the model is hosted outside Git, identify the precise source and immutable revision. Verify the artifact's SHA-256 and license provenance. Do not substitute another similarly named checkpoint without documenting the change.

## 2. First determine whether FP32 → FP16 is appropriate

Before converting anything, answer these questions:

1. What percentage of the ONNX file is made up of FP32 initializers versus graph structure and other data?
2. Which operators and tensors support FP16 in the target browser runtimes?
3. Does the current model use operations that may require FP32 accumulation or FP32 intermediate tensors?
4. Can the target ONNX Runtime Web version execute the converted graph correctly using WASM?
5. Can WebGPU execute it efficiently on representative browsers and GPUs?
6. Would FP16 reduce download size while increasing latency on CPU-only devices?
7. Would mixed precision be safer or faster than converting all eligible weights?
8. Does the graph already contain FP16 tensors or redundant initializers?
9. Would dynamic or static INT8 quantization be technically appropriate for this architecture?
10. Is model-file compression or better asset delivery worth testing separately from changing numerical precision?

Explain the distinction between:
- Weight storage precision.
- Intermediate activation precision.
- Operator execution precision.
- Model file size.
- Peak runtime memory.
- Download and initialization latency.
- Warm inference latency.
- Segmentation quality.

Do not assume that a model with FP16 weights necessarily performs all inference in FP16.

### Required decision

Compare at least these candidates:

A. Existing FP32 model — baseline and rollback artifact.

B. FP16 conversion with appropriate graph handling and preserved external I/O types where needed.

C. Mixed-precision conversion, if technically justified.

D. INT8 quantization, if supported and likely to offer a meaningful advantage.

E. Graph simplification and safe removal of genuinely unused graph elements.

Recommend which experiments should be performed first, with reasons based on the actual graph and deployment target.

Do not implement every candidate blindly. Reject options that are incompatible with the model or browser runtime, and explain why.

## 3. Remove genuinely unused ONNX graph elements

Inspect the graph and identify:
- Initializers not referenced by any live graph node.
- Unreachable nodes and dead branches.
- Unused outputs or auxiliary outputs that are not part of the required inference contract.
- Redundant constants or other safely removable graph data.
- Duplicated structures that can be eliminated without changing semantics.

Use graph reachability and dependency analysis, starting from the required outputs.

Important constraints:
- Preserve every node and initializer needed to compute the required output.
- Preserve the existing input/output names, shapes, dtypes, dynamic dimensions, and semantics unless a change is explicitly justified and separately tested.
- Do not remove nodes simply because their names appear unused.
- Do not remove intermediate outputs if downstream nodes depend on them.
- Do not remove model outputs required by the application's preprocessing or postprocessing pipeline.
- Do not strip metadata or model provenance indiscriminately.
- Validate graph integrity after every transformation.

Quantify the size reduction attributable to dead-code removal separately from precision conversion.

## 4. Simplify the ONNX graph while preserving numerical behavior

Investigate appropriate tools, such as:
- ONNX shape inference.
- ONNX graph cleanup.
- ONNX Simplifier, where compatible.
- ONNX Runtime graph optimizations.
- Constant folding, when semantically safe.
- Elimination of redundant or equivalent graph operations.

Pin tool versions and document the exact commands or scripts used.

Treat every transformation as a candidate that must be validated, not as automatically safe.

### Numerical preservation requirements

Compare the original and transformed FP32 models using identical input tensors.

Measure:
- Maximum absolute output error.
- Mean absolute output error.
- Maximum relative error, with appropriate handling of near-zero reference values.
- Output shape, dtype, finiteness, and range.
- Mask differences after the application's actual postprocessing.
- Changes around the final segmentation boundary.

Where the operation is intended to preserve numerical behavior, define explicit tolerances before accepting the result.

Prefer transformations that are mathematically equivalent or demonstrably numerically equivalent within strict tolerances.

Do not describe a transformation as numerically identical merely because a few sample images look similar.

Keep separate results for:
1. FP32 graph cleanup/simplification.
2. FP16 conversion.
3. Mixed precision.
4. INT8 quantization.

This separation is necessary to identify which transformation causes any quality or performance change.

## 5. Build a reproducible segmentation-quality benchmark

Use the current FP32 model as the reference implementation.

Reuse the repository's existing evaluation images and tests. If they are insufficient, propose a small, representative evaluation set covering:

- Ordinary product photography.
- Human hair and fine strands.
- Animal fur.
- Transparent or translucent objects.
- Glass and reflective surfaces.
- Complex backgrounds and clutter.
- Thin structures, holes, and disconnected regions.
- Low-contrast boundaries.
- Small foreground subjects.
- Difficult lighting and shadows.

Avoid introducing a new test dataset without documenting its origin and license.

For every candidate, use identical input images, preprocessing, resizing, output interpretation, thresholding, and postprocessing.

### Reference comparisons

Evaluate each candidate against the original FP32 model.

Calculate, where appropriate:
- Mean absolute error and maximum absolute error for output masks.
- Mean squared error.
- Intersection over Union (IoU).
- Dice coefficient.
- Boundary F-score or another suitable edge-sensitive metric.
- Foreground precision and recall.
- False foreground pixels and false background pixels.
- Per-image metrics and aggregate metrics.

If ground-truth masks are unavailable, clearly distinguish model-to-model agreement from actual segmentation accuracy. Agreement with FP32 does not establish that either model is correct.

Do not rely on a single average metric. Report difficult images individually and include representative visual comparisons.

### Visual edge analysis

For every test image, save:
1. The original input.
2. The FP32 output mask.
3. The candidate output mask.
4. The absolute difference map.
5. The foreground cutout on a checkerboard background.
6. Edge-focused comparisons for hair, fur, transparent objects, and thin structures.

Make it easy to compare the reference and candidate side by side.

Identify whether differences are concentrated in:
- Fine hair or fur.
- Thin structures.
- Boundary transitions.
- Transparent regions.
- Shadows.
- Interior foreground pixels.
- Background pixels.

Use a consistent visualization scale so that subtle errors are not hidden.

## 6. Explicitly test mask thresholds

Investigate the application's actual mask-generation and thresholding logic before changing it.

If the model outputs a probability mask, evaluate relevant threshold values around the current production threshold.

For example, if the existing pipeline uses a threshold of 0.5, a diagnostic sweep could include:

`0.30, 0.40, 0.45, 0.50, 0.55, 0.60, 0.70`

This list is illustrative. First establish whether thresholding is appropriate for the model's actual output representation.

For each threshold, record:
- Foreground precision and recall.
- IoU and Dice, where ground truth exists.
- Boundary quality.
- False foreground and false background rates.
- Hair/fur retention.
- Transparency and thin-structure preservation.
- Visual artifacts and edge thickness.

Important:
- Evaluate the existing FP32 pipeline and each candidate using the same production threshold.
- Then perform a separate diagnostic threshold sweep.
- Do not use a different threshold for each candidate to conceal quantization or conversion errors.
- If a candidate only performs acceptably after threshold changes, report this as a separate calibration trade-off.
- Do not assume that threshold tuning can recover detail lost during inference.

If the application uses alpha matting, sigmoid, interpolation, normalization, or other mask processing, inspect that code and evaluate the full pipeline rather than assuming the output is a simple binary mask.

## 7. Benchmark performance on the actual deployment targets

A Kaggle GPU benchmark is useful for preliminary numerical comparisons, but it does not establish browser performance.

Benchmark the final candidates in the actual application where feasible.

Test:
- ONNX Runtime Web with WASM.
- ONNX Runtime Web with WebGPU on compatible hardware.
- Representative desktop browsers.
- At least one CPU-only or WebGPU-unavailable configuration.

Measure separately:
- Model download size.
- Cold download time.
- Model initialization time.
- First inference, including relevant compilation overhead.
- Five or more warm inference runs.
- Median and mean warm latency.
- Peak browser memory where measurable.
- Failures, stalls, and fallback behavior.
- Output correctness.

Use identical hardware, browser versions, input images, and inference settings when comparing candidates.

Record hardware, OS, browser, GPU, driver, ONNX Runtime Web version, and execution provider.

Do not assume FP16 is faster on WASM merely because it is smaller. Do not assume WebGPU is correct simply because it is faster.

If a particular hardware configuration is unavailable, mark the result as untested rather than estimating a measured result.

## 8. Acceptance criteria

Before benchmarking, propose explicit acceptance criteria and document them in the experiment plan.

The following are starting points to discuss, not automatic pass conditions:

- FP32 graph simplification should preserve the model's required behavior within a strict, justified numerical tolerance.
- The candidate should produce valid masks and transparent PNG output through the existing application pipeline.
- No unacceptable regressions in hair, fur, transparency, or boundary quality.
- No new crashes, memory failures, or browser incompatibilities.
- A meaningful reduction in model download size.
- No unacceptable increase in cold-start or warm inference latency.
- Existing unit tests, integration tests, and browser smoke tests must pass.

Where numerical tolerances are appropriate, justify them based on output type and downstream processing. Where visual quality is the criterion, provide explicit examples and measurable boundary metrics.

Do not declare success solely because the ONNX file is smaller.

## 9. Implementation and repository safety

Work on a separate branch and preserve the original FP32 model.

Before modifying files:
1. Inspect the current repository and working tree.
2. Record the source model's SHA-256.
3. Identify all code and configuration referencing the current model.
4. Read the existing tests and benchmark scripts.
5. Check the model's license and source revision.

During implementation:
- Store candidate models separately from production assets.
- Avoid committing multiple large model binaries to Git.
- Do not commit API keys, access tokens, credentials, or private data.
- Pin conversion and simplification dependencies.
- Record reproducible commands and environment versions.
- Add tests for graph validity, input/output compatibility, numerical differences, and application integration.
- Preserve a simple rollback path to the original model.

Do not silently change the production model URL, model configuration, default inference provider, or output-processing logic.

Do not push changes or merge a pull request without authorization.

## 10. Deliverables

Produce the following artifacts:

1. `MODEL_OPTIMIZATION_AUDIT.md`
   - Exact model identity and provenance.
   - Current graph structure and tensor precision.
   - Baseline model size and performance.
   - Technical assessment of FP16 suitability.
   - Risks specific to WASM and WebGPU.
   - Recommended optimization strategy.

2. `MODEL_OPTIMIZATION_PLAN.md`
   - Ordered experiments.
   - Pinned dependencies.
   - Reproducible commands.
   - Quality and performance acceptance criteria.
   - Rollback strategy.

3. Reproducible optimization scripts
   - Graph inspection.
   - Safe dead-code cleanup.
   - Graph simplification.
   - FP16 conversion.
   - Optional INT8 experiment, if justified.
   - Numerical and segmentation comparison.

4. `MODEL_OPTIMIZATION_RESULTS.md`
   - A comparison table containing model size, file hash, conversion method, latency, memory, numerical error, segmentation metrics, and pass/fail status.
   - Visual comparison artifacts.
   - Per-image edge-quality findings.
   - Limitations and untested configurations.
   - Final recommendation.

5. Tests
   - ONNX graph validity.
   - Input/output contract preservation.
   - Numerical equivalence for graph-only transformations.
   - Segmentation regression tests.
   - Existing application tests and smoke tests.

If practical, generate a CSV containing per-image metrics for each candidate.

## 11. Required final recommendation

Conclude with a clear answer to these questions:

1. Is FP32 → FP16 appropriate for this particular BiRefNet Lite model and browser deployment?
2. Should we use FP16, mixed precision, INT8, graph cleanup, or a combination?
3. What measured reduction in file size does each method achieve?
4. What quality differences occur at boundaries and under which thresholds?
5. Which candidate offers the best balance of download size, browser compatibility, latency, memory, and segmentation quality?
6. Should the production model be replaced now, or should the original FP32 model remain in use?

Separate measured facts from estimates and recommendations.

If the evidence is insufficient, explain exactly what is missing and the minimum additional experiment required.

Start with repository inspection and a written audit. Do not begin by converting the model blindly.