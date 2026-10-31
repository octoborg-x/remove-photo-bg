# Deploying the static site (no credit card)

Pushing to `staging` or `production` runs `.github/workflows/deploy-pages.yml`,
which builds the site (`npm run build:site` — Vite build + model stripped from
`dist/`) and uploads it to Cloudflare Pages. The job no-ops with a notice until
the `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` secrets are set.

This doc explains the asset architecture (why the app is a small static shell
+ remote heavy artifacts) and the branch model.

## Asset architecture

| Artifact | Where it lives | Why |
|---|---|---|
| `model_512.onnx` (185 MB) | **Hugging Face** (free, no CC) | A generic static host caps a single file well below 185 MB and GitHub Releases sends no CORS header; HF serves with `Access-Control-Allow-Origin` and no size cap. Fetched inside the service worker, which proxies + caches it. |
| WASM runtime (13.3 MB `ort-wasm-simd-threaded.wasm` + loaders) | **Same-origin static** | ORT's threaded `pthread` workers bypass the service worker, so the `.wasm` must be same-origin (or carry CORP). The CPU-only bundle fits comfortably in a static site. |
| App shell | Any static host | ~400 KB (the model is fetched at runtime, not bundled). |

## Why this split

- **Model → HF.** The service worker fetches it cross-origin (HF answers with
  `Access-Control-Allow-Origin: *`), normalizes it into a same-origin,
  `Cross-Origin-Resource-Policy: cross-origin` cached response, and caches it. On
  later visits nothing is re-downloaded (verified: 0 model requests on reload).
- **WASM → same-origin static.** The WebGPU (`jsep`) binary is 26.5 MiB, so we
  ship the **CPU-only bundle** (`ort.wasm.min.js`, which loads only the 13.3 MiB
  threaded binary). Runtime provider is `wasm`; WebGPU is no longer attempted
  (see `scripts/fetch-models.mjs` for the reasoning). Cross-origin WASM would
  hang anyway.

## Deploy flow (automated)

`.github/workflows/deploy-pages.yml` deploys on push to `staging`/`production`:

- `staging` -> Cloudflare Pages preview deployment
- `production` -> production deployment (only this branch)

`main` pushes do **not** deploy. The workflow reads `VITE_ASSET_BASE` from the
repo's actions **variable** (displayed value, not a secret) so the built site
can fetch the model from Hugging Face; leave it unset to serve model/WASM
same-origin (only useful when the model fits under the host's per-file cap).

## Hosting the site manually

1. **Create the HF model repo** (free). Layout matters — the app requests
   `/models/model_512.onnx`, so put the file under `models/`:

   ```
   your-repo/
   └── models/
       └── model_512.onnx
   ```

   Upload it (`huggingface-cli upload` with your token, or drag-and-drop on
   https://huggingface.co/new). The base URL is then:

   ```
   https://huggingface.co/<owner>/<repo>/resolve/main/
   ```

   (`resolve/` redirects to a CDN host; the SW follows the redirect and the
   cache key is the URL you gave it.)

2. **Build and host the shell on any static host:**

   ```sh
   npm ci
   npm run fetch-models   # fetch model + WASM into public/ (gitignored)
   npm run build          # -> dist/
   ```

   Upload `dist/` to your host. Set the build-time variable:

   ```
   VITE_ASSET_BASE=https://huggingface.co/<owner>/<repo>/resolve/main/
   ```

   (`public/_headers` and `public/sw.js` carry the cross-origin-isolation and
   caching headers for hosts that honor them.)

## Branch model (release flow only)

The `main` → `staging` → `production` flow is enforced by
`.github/workflows/branch-flow-guard.yml` (staging only ever receives the
literal `main` branch; production receives `main` or `staging`). Since the
deploy pipeline is gone, these branches are bookkeeping — promote when you want,
deploy separately.

## Local development against the real remote

```sh
VITE_ASSET_BASE=https://huggingface.co/<owner>/<repo>/resolve/main/ npm run dev
```

If the repo is public, a `VITE_ASSET_BASE` without credentials works from any
browser; the SW caches the model on first load and subsequent visits need no
network for it.

## Re-enabling a deploy (if you want one)

Add a workflow that uploads `dist/` to a static host of your choice. If you go
back to Cloudflare Pages:

- `npm run build:site` (Vite build + the model-stripping script) produces the
  uploadable `dist/`.
- Set `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets and, when the
  model lives on Hugging Face, a `VITE_ASSET_BASE` variable.
- `npx wrangler@3 pages deploy dist --project-name=remove-photo-bg --branch=<branch>`.

The model is **not** fetched during a deploy — it lives on HF. To re-upload it
after a change, push to the HF repo (or run `npm run fetch-models` locally and
`hf upload` the file).

`.github/workflows/deploy-pages.yml` now does all of this automatically on
push to `staging` (preview) or `production`. The job refuses to fail the build
when the secrets are missing — it emits a notice and exits green.
