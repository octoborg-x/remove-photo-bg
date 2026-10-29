# Deploying to Cloudflare Pages + R2

The app is a ~400 KB static site. The ~230 MB of model + WASM binaries are **not**
part of it: Cloudflare Pages rejects any single file over 25 MiB, and the threaded
onnxruntime-web runtime loads a 26.5 MiB `.wasm` even when WebGPU is disabled.

## What is served from where

| Artifact | Size | Served by | Why |
|---|---|---|---|
| `model_512.onnx` | 185 MB | **R2**, fetched by the service worker | Largest file; fetched inside a worker the SW controls, so it can be proxied and cached. A Pages Function could time out on a slow client. |
| `ort-wasm-simd-threaded*.wasm/.mjs`, `ort.all.min.js` | ≤ 26.5 MB | **Pages Function** (`functions/wasm/[[path]].js`) → R2 | Must be same-origin and over 25 MiB. |
| HTML / JS shell, test images | small | **Pages static** | Everything else. |

Two constraints force the split, both verified by test:

1. **Threaded WASM must be same-origin.** onnxruntime-web's pthread workers fetch
   their own subresources directly, bypassing the service worker. A cross-origin
   `.wasm` therefore never receives the `Cross-Origin-Resource-Policy` header a
   COEP page demands, and `InferenceSession.create` hangs forever (single-threaded
   mode works, which is how this was isolated).
2. **Pages caps a single static file at 25 MiB**, below the 26.5 MiB `.jsep.wasm`.

A Pages Function satisfies both: it runs on the site's own origin and streams the
object straight from R2, so the 25 MiB static cap does not apply.

## One-time setup

1. **Create the R2 bucket and make it public.**
   ```sh
   npx wrangler r2 bucket create remove-bg-assets
   ```
   Enable public access (R2 → bucket → Settings → Public access) via a custom
   domain (recommended) or the `r2.dev` URL. Note that URL — it is
   `VITE_ASSET_BASE`.

2. **Allow the site origin through CORS** (the service worker reads the response
   body, so the fetch is a CORS request). Edit `r2-cors.json` with your Pages URL
   and apply it:
   ```sh
   npx wrangler r2 bucket cors put remove-bg-assets --file r2-cors.json
```

3. **Upload the binaries** (they are gitignored; fetch then push):
   ```sh
   npm run fetch-models
   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=remove-bg-assets \
     npm run upload-assets
   ```

4. **Create the Pages project** (Direct Upload) and bind the bucket. `wrangler.toml`
   already declares the `ASSETS_BUCKET` binding; the Function reads it.

5. **Set the production branch to `production`** in the Pages project settings, so
   pushes to `main` do **not** trigger a production deploy.

## Branch model

| Branch | Cloudflare environment | Trigger |
|---|---|---|
| `production` | Production | pushes to `production` only |
| `staging` | Preview | every push |
| `main` | — | no deploy (integration branch) |

`.github/workflows/deploy-pages.yml` implements this: it fetches the model, uploads
to R2 (idempotent — unchanged objects are skipped), builds the small site with
`npm run build:site`, and runs `wrangler pages deploy --branch=<git branch>`.

### Required repository secrets / variables

| Name | Kind | Value |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | secret | Pages:Edit + R2:Edit token |
| `CLOUDFLARE_ACCOUNT_ID` | secret | account id |
| `R2_ACCOUNT_ID` | secret | account id |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | secret | R2 API token |
| `R2_BUCKET` | secret | `remove-bg-assets` |
| `VITE_ASSET_BASE` | variable | public R2 URL, e.g. `https://assets.example.com` |

## Local development

Unset `VITE_ASSET_BASE` and the app serves everything same-origin from `public/`
(what `npm run dev` does). To exercise the remote path locally, point
`VITE_ASSET_BASE` at any origin serving the same paths over CORS:

```sh
VITE_ASSET_BASE=https://your-r2-public-url npm run dev
```

## Verifying persistence

After a first load, a reload must not re-fetch the model. Open DevTools →
Application → Cache Storage → `remove-bg-assets-*`; the model and WASM entries
should be present, and the Network tab should show no request for
`model_512.onnx` on the second visit.
