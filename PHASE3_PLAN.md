# PHASE3_PLAN — Notices, privacy, and the licence audit

> **Status: DONE.** Phase 3 is complete and verified — see
> [`PHASE3_REPORT.md`](./PHASE3_REPORT.md) for the delivered items, the measured
> licence audit, and the CSP verification. This plan is retained as the
> historical scope.

Prepared 2026-11-02, to start after Phase 2 is confirmed (`PHASE2_REPORT.md`).
Scope: MVP_OPENHANDS.md §11 **Phase 3** (Notices/privacy), §4 (third-party
notices), §8 (privacy/CSP), and the "Dependency and Model Licence Audit" section
at the end of the spec.

Rules carried forward: no invented hashes, revisions, licence clearances, or
URLs; no secrets; no paid resources; preserve required notices; do not claim
every training-data question is resolved (it is not).

## 1. Deliverables

| File | Action | Source of truth |
|---|---|---|
| `LICENSE_AUDIT.md` | **create** | npm licence checker + manual review of flagged items |
| `THIRD_PARTY_LEGAL_NOTICES.md` | update | upstream licence files + pinned artifacts |
| `MODEL_CARD.md` | update | shipped default is `model_512_int8_fp16` |
| `PRIVACY.md` | update | current build behaviour + network evidence |
| `index.html` footer | add links | Privacy + Third-party notices |
| CSP | add | `public/_headers` (prod) + `vite.config.ts` (dev), after testing |

## 2. Model notice work

The three shipped artifacts are weight-only quantisations of the same
BiRefNet_lite 512 fp32 teacher. `THIRD_PARTY_LEGAL_NOTICES.md` currently
documents only the fp32 teacher (`onnx/model.onnx`). Phase 3 must:

1. Record all three manifest ids with their file, size, and SHA-256 (§2 of
   `PHASE2_REPORT.md`), and state the derivation relationship (int8 backbone +
   fp16 decoder, materialised to fp32; fp16 weight-only storage).
2. Re-state the upstream MIT basis (`ZhengPeng7/BiRefNet_lite`, verified commit
   `aa62cd87eafb9cc43056d08ef3615a14628b831d`) and keep the verbatim MIT text.
3. Note the third-party exporter's licence status honestly (the
   `Phoenix-ActuallyFree` repo declares no licence; the covering licence is the
   upstream MIT the weights derive from).
4. Update `MODEL_CARD.md` "ONNX artifact used" + runtime section to the shipped
   default, and record the quantisation method and its measured parity.

## 3. Dependency licence audit (repeatable)

1. **npm:** add `license-checker-rseidelsohn` as a devDependency and run it over
   the installed tree + lockfile; capture direct and transitive, production and
   development, into `LICENSE_AUDIT.md` with the tool version, date, and the
   exact command.
2. **Python:** only if the repo ships Python runtime components. The distill
   scripts are dev/offline tooling with `scripts/distill/requirements-distill.txt`;
   if audited, run `pip-licenses` against that pinned environment and record it.
   Do not add Python solely to run the audit.
3. **Model artifacts + WASM:** audit separately from npm — the three `.onnx`
   files, `public/wasm/*` (onnxruntime-web 1.29.0, MIT), and the committed
   `ort.wasm.min.js` / `ort-wasm-simd-threaded.{mjs,wasm}` hashes.
4. **Flag for manual review:** AGPL, GPL, LGPL, SSPL, source-available,
   non-commercial, custom, unknown, missing, conflicting. Assess obligations in
   context (the app is a static site; onnxruntime-web is the only runtime dep).
5. **Verify evidence:** open the authoritative licence file at the exact version
   for any flagged/ambiguous component; package metadata alone is not conclusive.
6. **Release gate:** no dependency with unresolved obligations ships silently —
   report and propose a compatible alternative or request approval.

Known items to confirm during the audit: `onnxruntime-web` (MIT),
`vite` (MIT), `typescript` (Apache-2.0), `puppeteer-core` (Apache-2.0),
`onnxruntime-node` (MIT) — all as recorded in `THIRD_PARTY_LEGAL_NOTICES.md`
§Development dependencies; re-verify, do not assume.

## 4. Privacy + CSP

1. Update `PRIVACY.md` to the current build:
   - per-model cache buckets (`remove-bg-model-<id>-<sha8>`), not one bucket;
   - the model list and the default (`model_512_int8_fp16`, ~65 MB);
   - upload validation limits (20 MB / 4096 px) and the drop zone;
   - state that filenames are not logged (fixed in Phase 2).
2. Network evidence: cite `smoke-results/phase2-final/requests.json` (16
   first-party requests, 0 third-party) as the Phase 2 verification.
3. CSP: add to `public/_headers` (Cloudflare Pages) and `vite.config.ts` dev
   headers, after testing the real requirements. Draft to validate:
   `default-src 'self'; script-src 'self'; worker-src 'self' blob:;
   connect-src 'self' <asset-origin>; img-src 'self' blob: data:;
   style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none';
   base-uri 'self'; frame-ancestors 'none'`.
   The asset origin is `VITE_ASSET_BASE` when set (Hugging Face), so the CSP
   must allow that origin in `connect-src` only when it is configured. Verify the
   page still loads the model + WASM under the CSP before committing.
4. Add footer links from `index.html` to `PRIVACY.md` and
   `THIRD_PARTY_LEGAL_NOTICES.md` (served as static pages) or an in-app notices
   route if a static path is simpler for the host.

## 5. Definition of done (Phase 3)

- [ ] `LICENSE_AUDIT.md` exists with date, tool + version, commands, detected
      licences, flagged items, and resolutions.
- [ ] `THIRD_PARTY_LEGAL_NOTICES.md` covers all three shipped models + WASM.
- [ ] `MODEL_CARD.md` matches the shipped default.
- [ ] `PRIVACY.md` matches the current build and cites network evidence.
- [ ] Footer links present; CSP applied and tested (no CSP regressions).
- [ ] No unresolved copyleft/unknown licence ships without a recorded decision.
