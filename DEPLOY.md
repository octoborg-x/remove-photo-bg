# Deploying to Cloudflare Pages + Hugging Face (no credit card)

Two free tiers, neither needs a payment method:

| Artifact | Where it lives | Why |
|---|---|---|
| `model_512.onnx` (185 MB) | **Hugging Face** (free, no CC) | Cloudflare Pages caps a static file at 25 MiB and GitHub Releases sends no CORS header; HF serves with `Access-Control-Allow-Origin` and no size cap. Fetched inside the service worker, which proxies + caches it. |
| WASM runtime (13.3 MB `ort-wasm-simd-threaded.wasm` + loaders) | **Cloudflare Pages static** (same-origin) | ORT's threaded `pthread` workers bypass the service worker, so the `.wasm` must be same-origin (or carry CORP — an R2 domain wouldn't without a card). The CPU-only bundle fits under the 25 MiB cap. |
| App shell | Cloudflare Pages static | ~400 KB after stripping the model. |

## Why this split

- **Model → HF.** The service worker fetches it cross-origin (HF answers with
  `Access-Control-Allow-Origin: *`), normalizes it into a same-origin,
  `Cross-Origin-Resource-Policy: cross-origin` cached response, and caches it. On
  later visits nothing is re-downloaded (verified: 0 model requests on reload).
- **WASM → Pages static.** The WebGPU (`jsep`) binary is 26.5 MiB — over the
  25 MiB per-file cap — so we ship the **CPU-only bundle** (`ort.wasm.min.js`,
  which loads only the 13.3 MiB threaded binary). Runtime provider is `wasm`;
  WebGPU is no longer attempted (see `scripts/fetch-models.mjs` for the
  reasoning). Cross-origin WASM would hang anyway.

## One-time setup (no credit card)

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

2. **Create the Pages project** at https://dash.cloudflare.com → Workers & Pages.
   (Direct Upload via `wrangler pages deploy`; Git integration also works.)

3. **Set the repo secrets/variables** (GitHub → Settings → Secrets and
   variables → Actions):

   | Name | Type | Value |
   |---|---|---|
   | `CLOUDFLARE_API_TOKEN` | secret | token with `Pages:Edit` |
   | `CLOUDFLARE_ACCOUNT_ID` | secret | your Cloudflare account id |
   | `VITE_ASSET_BASE` | variable | `https://huggingface.co/<owner>/<repo>/resolve/main/` |

   Until `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` exist, the `deploy`
   workflow no-ops with a notice (branches stay green).

4. In the Pages project settings set **production branch = `production`**
   (optional but recommended; pushes to `production` deploy to prod, pushes to
   `staging` create preview deploys, and pushes to `main` don't re-deploy).

## Branch model

- `staging` → preview deployment, every push
- `production` → production deployment only when its branch is pushed
- `main` → no deploy (so merges don't recreate production)

## Local development against the real remote

```sh
VITE_ASSET_BASE=https://huggingface.co/<owner>/<repo>/resolve/main/ npm run dev
```

If the repo is public, a `VITE_ASSET_BASE` without credentials works from any
browser; the SW caches the model on first load and subsequent visits need no
network for it.

## The deploy workflow

`.github/workflows/deploy-pages.yml`:

- Runs on pushes to `staging`/`production` and manual dispatch.
- No-ops with a descriptive notice until Cloudflare secrets are configured.
- With secrets: `npm ci` → `npm run build:site` (removes `dist/models/`) →
  `npx wrangler pages deploy`.

The model is **not** fetched during deploy — it lives on HF. To re-upload it
after a change, push to the HF repo (or run `npm run fetch-models` locally and
`hf upload` the file).
