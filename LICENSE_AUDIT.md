# LICENSE_AUDIT — dependency and model licence audit

Date: **2026-11-02**. Tool: `license-checker-rseidelsohn` **5.0.1** (BSD-3-Clause).
Node: v24.21.0, npm 11.21.0. Lockfile: `package-lock.json` (lockfileVersion 3).

Reproduce with:

```bash
npm ci
npm run license:audit        # license-checker-rseidelsohn --production && --summary
```

This audit covers the JavaScript/TypeScript dependency tree (direct +
transitive, production + development) and the redistributed runtime/model
artifacts. It is not legal advice.

## 1. Result summary

**No copyleft, source-available, non-commercial, or unknown licence is present
in the installed tree.** Every package resolves to a permissive licence. The
only `UNLICENSED` entry is this repository's own `private: true` package.

| Licence | Count |
|---|---|
| MIT | 119 |
| ISC | 65 |
| Apache-2.0 | 23 |
| BSD-3-Clause | 16 |
| BlueOak-1.0.0 | 11 |
| BSD-2-Clause | 7 |
| CC-BY-3.0 | 1 |
| CC0-1.0 | 1 |
| (MIT AND CC-BY-3.0) | 1 |
| 0BSD | 1 |
| (MIT OR CC0-1.0) | 1 |
| UNLICENSED (this repo, `private`) | 1 |
| **Total** | **247** |

Production-only tree: **19** packages, all MIT / ISC / Apache-2.0 /
BSD-3-Clause (see §3). Development/test adds Vite, TypeScript, puppeteer-core,
onnxruntime-node, the licence checker itself, and their transitive deps.

## 2. Flagged for manual review

| Item | Declaration | Assessment |
|---|---|---|
| `spdx-exceptions@2.5.0` | `CC-BY-3.0` | **Data file** of SPDX exception identifiers, not code. CC-BY-3.0 is a permissive content licence; attribution preserved by the package's own notice. Shipped as a transitive dev dependency of the licence checker, not in the product bundle. **OK.** |
| `spdx-license-ids@3.0.24` | `CC0-1.0` | Data file of SPDX ids; CC0 is a public-domain dedication. Dev-only. **OK.** |
| `spdx-ranges@2.1.1` | `(MIT AND CC-BY-3.0)` | Data file; both terms permissive and compatible. Dev-only. **OK.** |
| `type-fest@0.20.2` | `(MIT OR CC0-1.0)` | Dual-licensed; either term is permissive. Dev-only. **OK.** |
| `tslib@2.8.1` | `0BSD` | Zero-clause BSD; no attribution requirement. **OK.** |
| BlueOak-1.0.0 (11 packages: `glob`, `minimatch`, `minipass*`, `lru-cache`, `path-scurry`, `isexe`, `tar`, `chownr`, `common-ancestor-path`, `yallist`) | `BlueOak-1.0.0` | Modern permissive licence (OSI-approved). Pulled in by the licence checker / build tooling. **OK.** |
| `remove-bg-photo@0.0.1` | `UNLICENSED` | This repository; `private: true`, not published. **Expected.** |

No AGPL / GPL / LGPL / SSPL / MPL / EPL / CDDL was detected.

## 3. Direct dependencies (verified)

| Component | Version | Licence | Source | Runtime? |
|---|---|---|---|---|
| `onnxruntime-web` | 1.29.0 | MIT | https://github.com/microsoft/onnxruntime | **runtime (redistributed)** |
| `onnxruntime-common` | 1.29.0 | MIT | https://github.com/microsoft/onnxruntime | runtime (dep of above) |
| `vite` | 5.4.21 | MIT | https://github.com/vitejs/vite | build |
| `typescript` | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript | build |
| `puppeteer-core` | 23.11.1 | Apache-2.0 | https://github.com/puppeteer/puppeteer | dev/test |
| `onnxruntime-node` | 1.29.0 | MIT | https://github.com/microsoft/onnxruntime | dev/test (native reference) |
| `license-checker-rseidelsohn` | 5.0.1 | BSD-3-Clause | https://github.com/RSeidelsohn/license-checker-rseidelsohn | dev (audit tooling) |

Licence text verified at the authoritative source for the redistributed runtime:
`onnxruntime` `LICENSE` @ tag `v1.29.0` is MIT, "Copyright (c) Microsoft
Corporation" (checked 2026-11-02). `vite` `LICENSE` @ `v5.4.21` is MIT,
"Copyright (c) 2019-present, VoidZero Inc. and Vite contributors".

## 4. Redistributed runtime artifacts (not npm packages)

The site ships the ONNX Runtime Web **CPU-only** WASM bundle as static files
(`public/wasm/`, copied from `node_modules/onnxruntime-web/dist` by
`scripts/fetch-models.mjs`). These are covered by the `onnxruntime` MIT licence
above. Committed hashes (re-verified 2026-11-02 with `sha256sum`):

| File | Size (bytes) | SHA-256 |
|---|---|---|
| `public/wasm/ort.wasm.min.js` | 50,196 | `f87630372da0668a72b4304e062365117cbe432d6060ca146799b1c1888460ae` |
| `public/wasm/ort-wasm-simd-threaded.mjs` | 24,218 | `5a15f1fd086b3f6c2baf1f35105b8f502653b567e165cef80028870b39748747` |
| `public/wasm/ort-wasm-simd-threaded.wasm` | 13,961,845 | `ec8580a9d7b9476ceee52e10a7f94124e4dc71a019d666ed6d4726697c109a4d` |

The WebGPU-capable `jsep` bundle is **not** committed or deployed on hosts with a
per-file cap; it is fetched at build time only when `fetch-models --webgpu` is
used (see `THIRD_PARTY_LEGAL_NOTICES.md` for its hashes).

## 5. Model artifacts

The three served models are weight-only quantisations of the same upstream
`ZhengPeng7/BiRefNet_lite` checkpoint (MIT). Their file/size/SHA-256 are recorded
in `THIRD_PARTY_LEGAL_NOTICES.md` §BiRefNet_lite model and in `MODEL_CARD.md`.
They are model weights, audited separately from npm dependencies per the spec.

## 6. Release gate

- No dependency with unresolved licensing obligations ships.
- Preserve required copyright/licence notices in `THIRD_PARTY_LEGAL_NOTICES.md`.
- Re-run this audit whenever dependencies, model files, runtime assets, or their
  versions change. The command is pinned in `package.json` (`npm run license:audit`).
