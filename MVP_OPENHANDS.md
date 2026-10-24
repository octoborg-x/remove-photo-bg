# remove-bg-photo — MVP Build Specification for OpenHands

**Updated:** 2026-10-24  
**Goal:** Build a browser-first background remover for marketplace/product photos.  
**Budget:** $0 during development; target under $50/month after validation.  
**Agent:** OpenHands.

> Treat this document as the implementation source of truth. Inspect the existing repository before changing it. Preserve user work. Implement and test in increments. Never invent test results, model revisions, legal clearances, or deployment URLs.

## 1. Product scope

Build a responsive web app where users drop/select one JPEG, PNG, or WebP image; the model runs locally in their browser; the user previews the result and downloads a full-resolution transparent PNG or white-background JPG.

Audience: small online sellers and marketplace merchants.

MVP promises, only after verification:
- No account or per-image fee.
- Image pixels stay on the device during processing.
- Original image dimensions are preserved within documented limits.
- Transparent PNG and white-background JPG.
- Clear model download progress, errors, supported browsers, file limits, and known quality limitations.
- No silent cloud-processing fallback.

Out of scope: accounts, billing, API, batch, teams, AI backgrounds, video, native mobile app, backend/database, cloud inference, analytics SDKs. Do not add paid services without asking first.

## 2. Stack and repository approach

First inspect the repository, package manager, existing tests, git status, hosting, and current changes. Reuse a functioning framework. If the repository is empty, prefer:
- Vite + TypeScript, vanilla TS or a small UI library.
- A Web Worker for model inference.
- ONNX Runtime Web directly, or `@huggingface/transformers` if the exact model graph is compatible.
- WebGPU as preferred runtime when supported by the selected graph.
- A WASM fallback only after testing a compatible graph/model; do not assume a WebGPU graph runs on WASM.
- Static hosting; model assets served from a pinned, first-party location or affordable object storage after checking current limits/pricing.
- Unit tests, lint, typecheck, production build, and browser tests if available.

Suggested layout (adapt to the repository):
```text
src/features/background-removal/
  image-validation.ts
  image-preprocess.ts
  mask-postprocess.ts
  composite.ts
  export-image.ts
  model-client.ts
  model.worker.ts
  types.ts
src/legal/
public/models/
public/wasm/
tests/unit/
tests/e2e/
MVP_OPENHANDS.md
MODEL_CARD.md
THIRD_PARTY_LEGAL_NOTICES.md
PRIVACY.md
.env.example
```
Do not commit large model binaries to Git by default. Provide a repeatable download/build script and record hashes.

## 3. Model decision and licensing record

**Initial technical candidate:** official `ZhengPeng7/BiRefNet_lite` checkpoint:
- Model page: https://huggingface.co/ZhengPeng7/BiRefNet_lite
- Author repository: https://github.com/ZhengPeng7/BiRefNet
- Other variants, not interchangeable without a separate record:
  - https://huggingface.co/ZhengPeng7/BiRefNet_lite-2K
  - https://huggingface.co/ZhengPeng7/BiRefNet_lite-matting

**Project implementation decision:** use the official model page's published MIT licence declaration as the initial basis for implementing and testing the selected checkpoint. Preserve the applicable MIT text and copyright attribution in `THIRD_PARTY_LEGAL_NOTICES.md`. This is a project implementation decision, not legal advice or proof that every possible training-data issue has been adjudicated. Record any separate training-data/provenance questions honestly; do not claim “unconditionally legally cleared” in marketing.

Relevant upstream discussion: https://github.com/ZhengPeng7/BiRefNet/issues/306

Before using a model artifact, OpenHands must verify and record:
- Exact model page, upstream repository, immutable revision/commit SHA.
- Exact file name, file size, SHA-256, and download source.
- Whether it is upstream or a third-party ONNX conversion.
- Conversion/patch scripts, source checkpoint, commit, and their licences.
- Input shape, channel order, normalization, output tensor layout, activation, and postprocessing.
- Runtime/package versions and licences.
- Licence source, copyright notice, redistribution terms, and known limitations.
- Date checked and any unresolved provenance question.

Do not assume the stock ONNX export works with WebGPU. If a community export is needed, pin it, inspect its source and licence, and hash the exact artifact. If no compatible artifact is established, build a small smoke test/export path or report the blocker; do not pretend it works.

**Excluded by default:**
- BRIA RMBG-1.4/RMBG-2.0 unless an applicable commercial licence/agreement is obtained and recorded.
- `@imgly/background-removal` unless its AGPL obligations are deliberately accepted.
- Any model selected only because a blog or model aggregator says “free”.

## 4. Third-Party Legal Notices and Disclosure

Create `THIRD_PARTY_LEGAL_NOTICES.md` at the repository root and link it from the app footer. Use exact upstream notices; do not assume every dependency is MIT.

Start with this content, then fill every placeholder from verified source files:

```markdown
# Third-Party Legal Notices and Disclosure

This application includes third-party software and model artifacts. Each
component remains subject to its own licence and notices.

## BiRefNet_lite model
- Upstream: ZhengPeng7 / BiRefNet
- Model page: https://huggingface.co/ZhengPeng7/BiRefNet_lite
- Source: https://github.com/ZhengPeng7/BiRefNet
- Exact revision: [VERIFIED REVISION]
- Exact artifact: [FILENAME]
- SHA-256: [HASH]
- Published licence declaration: MIT
- Licence source: [LINK TO EXACT UPSTREAM LICENCE]
- Notes: The project uses the selected checkpoint under the published licence
  declaration. Model provenance and any separate training-data questions are
  documented in MODEL_CARD.md. This notice is not a legal warranty.

Copyright (c) 2024 ZhengPeng

[Paste the exact MIT licence text from the applicable upstream source here.
Do not rely on a hand-retyped template if the upstream text differs.]

## Runtime
- Package: [onnxruntime-web OR @huggingface/transformers]
- Version: [VERIFIED VERSION]
- Licence and source: [VERIFIED URL]
- Include any required notice text.

## Other dependencies
| Component | Exact version | Licence | Licence/source URL | Runtime or build-time |
|---|---|---|---|---|
| Vite | [fill] | [verify] | [fill] | build |
| TypeScript | [fill] | [verify] | [fill] | build |
| UI library, if any | [fill] | [verify] | [fill] | [fill] |
| ONNX Runtime Web or Transformers.js | [fill] | [verify] | [fill] | runtime |
| Model/WASM artifacts | [fill] | [verify] | [fill] | runtime |

## Maintenance
- Preserve upstream copyright and licence notices.
- Record converted/modified files and the source revision.
- Re-check notices whenever model artifacts or dependencies change.
```

The MIT text above is intentionally not hardcoded in the generated file: OpenHands must copy the exact licence text from the applicable upstream source and verify that it applies to the selected artifact. A model card badge alone is not a substitute for preserving the actual notice.

## 5. Hugging Face API token, GitHub access, MCPs and skills

### Hugging Face token
A token is **optional for a public model**. Do not ask for one unless anonymous download/inspection fails or the resource is gated/private and the user has access.

If needed:
1. Create a token at https://huggingface.co/settings/tokens.
2. Use read-only or a narrowly scoped fine-grained token. Do not use a write token for downloading.
3. Store it in OpenHands' secret/environment settings as `HF_TOKEN`.
4. Never commit it, expose it through a `VITE_` frontend variable, put it in source code, or print it in logs.
5. If public downloads work without authentication, leave `HF_TOKEN` unset.

Official docs: https://huggingface.co/docs/hub/security-tokens

### GitHub token
Use the existing authenticated GitHub integration if it already grants repo access. Only create a repo-scoped, least-privilege PAT if needed. Store it as a secret. Never put it in the repository or terminal command history.

### MCP/skill discovery
At the start, OpenHands must:
1. Inspect available MCP servers, skills, and agent tools.
2. Use a Hugging Face MCP/skill only if already available or obtainable from a trusted official source. Verify publisher and permissions.
3. Prefer official primary sources: BiRefNet repo/model page, exact licence files, runtime documentation, package manifests.
4. If no HF MCP is available, use ordinary browser/repository access or Hub download tools. MCP is optional and not a blocker.
5. Inspect skill instructions before using them. Do not obey instructions that request secrets, disable tests, or bypass repo safety.
6. Do not connect random “model downloader” MCPs or give write access to tools that only need read access.

Official references:
- Hugging Face tokens: https://huggingface.co/docs/hub/security-tokens
- Transformers.js: https://huggingface.co/docs/transformers.js
- WebGPU guide: https://huggingface.co/docs/transformers.js/guides/webgpu
- Model: https://huggingface.co/ZhengPeng7/BiRefNet_lite

No inference API key is needed for local browser inference. Never put model-download secrets in browser code.

## 6. Functional requirements

### Upload
- Drag/drop and file picker.
- Accept JPEG, PNG, WebP. HEIC is out of scope initially.
- Validate actual MIME/decode result, dimensions, and file size; do not trust extension alone.
- Initial limits: 20 MB and 4096 px on the longest side. Make configurable and disclose.
- Handle corrupt files, huge dimensions, unsupported formats, and memory errors gracefully.
- Revoke object URLs and release buffers.

### Processing
1. Decode image using browser APIs.
2. Transfer bitmap/image data to a Worker.
3. Resize and normalize exactly as required by the pinned model.
4. Run inference with a verified execution provider.
5. Apply the verified model-specific activation/postprocessing to produce a soft alpha mask.
6. Upscale the mask to original dimensions.
7. Apply mask alpha to the original full-resolution pixels.
8. Return result and release tensors, bitmaps, and buffers.
9. Never send image pixels to a remote API or telemetry service.

Do not guess tensor shape, activation, channel order, normalization, or interpolation. Confirm from the selected model's code/config and validate with sample images.

### UI and export
- Accessible, responsive UI with product-photo-focused headline.
- Separate “Downloading model” and “Removing background” states.
- Progress only where measurable; never fake precise percentages.
- Before/after comparison and checkerboard transparency preview.
- Export transparent PNG and white-background JPG.
- PNG must have real alpha; JPG must be composited on pure white.
- Preserve original dimensions within the documented cap; do not upscale the source itself.
- Clear retry, reset, and error actions.
- Tell users the model download size before the first download.
- Footer links to Privacy and Third-party notices.
- Keyboard operation, focus states, labels, and reduced-motion support.

## 7. Runtime and fallback

- Feature-detect WebGPU and confirm compatibility with the exact graph.
- Prefer WebGPU for a verified compatible model.
- Add WASM fallback only with a verified compatible smaller graph/model. U²-Netp may be evaluated separately, but its exact weights, training-data provenance, licence, and runtime compatibility must be checked.
- If neither provider works, explain the limitation; never silently upload the image.
- On memory failure, retry at a smaller supported input size once at most, and disclose reduced detail.
- Use a Worker; clean up resources after inference.
- Pin runtime and artifact versions.
- Cache model assets with versioned keys using Cache API or IndexedDB.
- Self-host runtime/model assets where practical. Do not ship an unpinned third-party conversion.

## 8. Privacy and security

- No backend needed for MVP.
- No uploads of original/result images.
- No third-party analytics, ad pixels, external fonts, remote logging, or error SDK in initial MVP.
- Self-host JS, CSS, fonts, model, and WASM when feasible.
- Configure a restrictive CSP after testing actual runtime requirements. Review `default-src`, `script-src`, `connect-src`, `img-src`, `worker-src`, `font-src`, `object-src`, `base-uri`, and `frame-ancestors`.
- Use `connect-src 'self'` if every required runtime/model asset is self-hosted. If an external origin is needed, document it and allow only that origin.
- Add `PRIVACY.md` with precise image-processing and network behavior.
- Inspect DevTools Network during processing and verify no request carries image pixels.
- Do not log filenames, image content, EXIF, or raw user input.

## 9. Tests and benchmark

Use existing tooling if present; otherwise use Vitest for unit tests and Playwright for browser flow if supported.

Unit tests:
- File/MIME/size/dimension validation.
- Mask resizing/normalization.
- Alpha compositing.
- PNG alpha and JPG white background.
- Object URL and Worker cleanup.
- Model load/inference failure.
- Ensure no app-level image upload path exists.

Browser tests:
- Upload JPEG and PNG.
- Model loads and inference completes in a supported browser.
- Preview and both exports work.
- Invalid/oversized/corrupt input shows errors.
- Worker errors reach the UI.
- No unexpected external requests during processing.
- Keyboard-only workflow is usable.

Use legally usable test images (own or appropriately licensed) covering product on plain background, complex edges, hair, plant/fur, low contrast, glass/translucency, and clutter. Do not commit private/copyrighted images without permission.

Measure rather than assume:
- Cold model load and warm-cache load.
- Inference time on integrated-GPU laptop and mid-range Android.
- Peak memory, crashes, output dimensions, and subjective edge quality.
- First-download size and cache behavior.
Do not publish performance claims before measuring.

## 10. SEO and hosting

Audience: product sellers. Draft copy:
> Free product background remover — full-resolution PNG, right in your browser.

Supporting copy:
> Remove backgrounds from product photos on your device. Export a transparent PNG or white-background JPG. No account and no per-image charge.

Publish local-processing claims only after network/privacy tests pass. Disclose supported formats, size limits, model download size, browser requirements, and known issues with hair, glass, shadows, and fine edges.

SEO: unique title/meta description, descriptive headings, alt text, Open Graph metadata, sitemap, robots.txt, and canonical URL after deployment. Do not make unverified competitor claims. French/Arabic localization can follow after the core MVP.

Use static hosting if the free tier fits. Verify current asset-size limits, bandwidth/egress, object-storage pricing, and terms. Model downloads can be >100 MB, so bandwidth may dominate cost. Keep expected recurring spend under $50/month. Stop and ask before creating paid resources or buying a domain. Never expose tokens in frontend bundles or public env vars.

## 11. OpenHands execution sequence

### Phase 0 — Inspect
- Check repository, git status, framework, tests, hosting, current changes, and existing model artifacts.
- Preserve user changes.
- Discover installed skills/MCPs.
- Report a short plan and real blockers, then continue without waiting unless a destructive action or paid resource is required.

### Phase 1 — Model feasibility
- Verify official model page, licence, source revision, and exact artifact.
- Establish a compatible ONNX path and record SHA-256.
- Create a minimal browser smoke test with one local image.
- Confirm tensor semantics and export a valid transparent PNG.
- Verify no image-pixel network requests.
- Fix model/runtime compatibility before building the full UI.

### Phase 2 — Product workflow
Implement validation, worker lifecycle, model load, status/progress, preview, PNG/JPG exports, and error states.

### Phase 3 — Notices/privacy
Create `MODEL_CARD.md`, `THIRD_PARTY_LEGAL_NOTICES.md`, and `PRIVACY.md` from verified sources. Add footer links and CSP. Preserve required notices. Document the MIT declaration as the project basis without claiming every training-data question is definitively resolved.

### Phase 4 — Quality
Run lint, typecheck, unit tests, browser tests where available, and production build. Run a real manual model smoke test and record browser/device results. Fix failures rather than suppressing tests.

### Phase 5 — Delivery
Update README with install/run/test/build, model-download instructions, browser requirements, privacy, provenance, and notices. `.env.example` should contain names only and should not require a secret for browser-only inference. Report changed files, model revision/hash, actual test results, limitations, and deployment steps. Use a feature branch if available; do not force-push or push directly to the default branch without permission. Do not spend money without approval.

## 12. Definition of done

- [ ] Supported image can be selected/dropped.
- [ ] Exact pinned model runs in browser on a tested environment.
- [ ] Inference does not freeze the UI.
- [ ] Transparent PNG has real alpha and expected original dimensions.
- [ ] White-background JPG works.
- [ ] Invalid input, unsupported device, model failure, and memory failure are handled.
- [ ] No image pixels leave the device; verified via network inspection.
- [ ] Model revision, artifact hash, licence source, and runtime versions are recorded.
- [ ] `MODEL_CARD.md`, `THIRD_PARTY_LEGAL_NOTICES.md`, and `PRIVACY.md` exist and are linked.
- [ ] All dependency licences/notices checked.
- [ ] Lint, typecheck, tests, and build pass, or failures are truthfully documented.
- [ ] README explains setup and commands.
- [ ] No secrets committed.
- [ ] Hosting limits and monthly cost estimate checked before public launch.

Passing means technically ready for a private demo, not a guarantee of legal certainty.

## 13. OpenHands first prompt

Read MVP_OPENHANDS.md, but for this run implement ONLY Phase 0 and Phase 1 of section 11. This prompt replaces the first prompt in section 13. Ignore Phases 2-5, the full UI, the test suite, MODEL_CARD.md, THIRD_PARTY_LEGAL_NOTICES.md, PRIVACY.md, LICENSE_AUDIT.md and the token/MCP sections unless something blocks you. Stop after Phase 1 and report. Do not start Phase 2.

Phase 0: inspect the repo and git status, preserve my work, use a feature branch, don't commit model binaries (use a download script), no secrets, no paid resources, no cloud inference. Don't ask for an HF token unless anonymous download fails.

Phase 1 goal: prove with evidence that ZhengPeng7/BiRefNet_lite runs in a browser and produces a correct full-resolution transparent PNG.

1. Provenance. For every artifact you use, record: repo, immutable revision/commit SHA, filename, size, SHA-256, upstream vs third-party, exact licence file URL and copyright line. Start from the official ZhengPeng7/BiRefNet_lite and onnx-community/BiRefNet_lite-ONNX (fp16). Known issue: the stock ONNX export has Concat/Split nodes that exceed WebGPU's per-shader storage-buffer limit. Community rewrites exist (e.g. jessolmstead/BiRefNet_lite-ONNX-webgpu, jignesh-work/vitaltools-birefnet-lite). Inspect them, don't trust their claims: verify the weights are unchanged and outputs match the stock graph on CPU, or reproduce the rewrite yourself. Pin whatever you use by revision and hash.
2. Semantics. Confirm from the model code/config, not memory: input shape (fixed or dynamic), channel order, normalization, output tensor and activation, resize/interpolation.
3. Smoke test. Use the repo's framework (Vite + TS if empty). A minimal page + Worker with ONNX Runtime Web or transformers.js: load the pinned model, run one local image, upscale the mask to the original size, apply it as alpha to the full-res pixels, download a PNG with real alpha. Print model download size, load time, 5 warm inference times and the execution provider used.
4. Environment honesty. If your sandbox has no real GPU/WebGPU, say so. Verify what you can (CPU/WASM provider, pre/post-processing, PNG alpha) and do NOT report WebGPU timings you didn't measure. Make the page runnable on my machine with one documented command so I can run it in Chrome and paste the numbers back.
5. Network. Confirm no request carries image pixels.

Pass/fail (defaults, tell me if you think they're wrong):
- Correct transparent PNG at original dimensions from at least 3 test images: product on plain background, hair/fur, glass or clutter. Use test-images/ if present, otherwise CC0 images with sources recorded.
- Warm inference of about 5 s or less at 1024x1024 on an integrated-GPU laptop (measured on my machine).
- No tab crash. Download size reported, flagged if over 100 MB.
- State whether the graph is fixed-1024 or dynamic. If a smaller-input fallback is needed, name candidates but don't adopt one without the same provenance checks.

Deliver: PHASE1_REPORT.md (provenance table, semantics, what ran where, measured results, verdict GO / GO-WITH-FALLBACK / NO-GO, blockers, recommended next step) plus the smoke-test code. Never invent results, hashes or licence clearances.

=== End of 13 ===


Dependency and Model Licence Audit

Before release, perform a repeatable licence audit of all production and development dependencies, runtime assets, and redistributed model artifacts.

1. JavaScript/TypeScript: Use an appropriate npm ecosystem licence checker, such as "license-checker-rseidelsohn" or "license-checker", and inspect the lockfile and installed dependency tree.
2. Python, if used: Use "pip-licenses" against the actual project environment. Do not add Python solely to run a licence audit if the project has no Python components.
3. Model artifacts: Audit the exact pretrained checkpoint, ONNX conversion, model configuration, tokenizer or auxiliary files if any, and their upstream licence notices separately from package dependencies.
4. Transitive dependencies: Include direct and transitive dependencies, production and development dependencies, WASM binaries, and any assets redistributed to users.
5. Flag for manual review: Identify AGPL, GPL, LGPL, SSPL, source-available, non-commercial, custom, unknown, missing, or conflicting licence declarations. Do not automatically assume every copyleft licence is incompatible; assess its obligations in the context of how the component is used and distributed.
6. Verify evidence: For flagged or ambiguous components, inspect the authoritative licence file and the exact version. Do not treat package metadata alone as conclusive.
7. Generate an audit report: Save the date, tool and version, commands run, dependency versions, detected licences, exceptions, and resolutions in "LICENSE_AUDIT.md".
8. Release gate: Do not silently introduce a dependency with unresolved licensing obligations. Report the issue and propose a compatible alternative or request approval before release.

Preserve required copyright notices and licence texts in "THIRD_PARTY_LEGAL_NOTICES.md". Run the audit again whenever dependencies, model files, runtime assets, or their versions change. Keep audit tooling and reports reproducible in CI where practical.