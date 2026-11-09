# Deployment — Vercel

Vercel is the deployment target for the static Vite application. Model weights
remain hosted on Hugging Face and are fetched at runtime by the browser service
worker.

## Asset architecture

| Artifact | Location | Reason |
|---|---|---|
| App shell and WebGPU-capable ONNX Runtime assets | Vercel | Same-origin delivery supports the threaded runtime and cross-origin isolation headers. |
| Model weights | Hugging Face Space: `Octoborg/remove-photo-bg` | Keeps large model files out of the application build; the service worker fetches and caches the selected model. |

The Hugging Face base URL is:

```text
https://huggingface.co/spaces/Octoborg/remove-photo-bg/resolve/main/
```

## Branch deployments and domains

Deployments are limited to the three release branches. `vercel.json` sets
`git.deploymentEnabled` so that only `main`, `staging`, and `production` build;
every other branch (including feature branches and `develop`) is skipped, so a
pull request does **not** create a preview deployment.

| Branch | Environment | URL |
|---|---|---|
| `production` | Production | https://remove-photo-bg.vercel.app |
| `main` | Preview | https://main-remove-photo-bg.vercel.app |
| `staging` | Preview | https://staging-remove-photo-bg.vercel.app |
| `production` | Preview | https://production-remove-photo-bg.vercel.app |

The production domain (`remove-photo-bg.vercel.app`) is the project's primary
domain and always serves the latest successful `production` deployment. Each
branch also gets a stable preview alias named `<branch>-remove-photo-bg.vercel.app`.
Set these up once in the Vercel dashboard (Project → Settings → Domains): add
`remove-photo-bg.vercel.app` as the production domain, and add each
`<branch>-remove-photo-bg.vercel.app` alias with its matching Git branch.
`vercel domains add <domain> <project>` and `vercel alias set <deployment> <domain>`
do the same from the CLI.

> **Note:** the `git.deploymentEnabled` keys are branch globs (`minimatch`). A
> branch matches `*` only when it has no slash, so both `*` and `**` are set to
> `false` to also disable slash-named branches; the three explicit `true` entries
> re-enable the release branches.

## Vercel setup

1. Import `octoborg-x/remove-photo-bg` into Vercel from GitHub.
2. Select the Vite framework preset (or allow auto-detection).
3. Keep the build command from `vercel.json`: `npm run vercel:build`.
4. Set the project environment variable:

   ```text
   VITE_ASSET_BASE=https://huggingface.co/spaces/Octoborg/remove-photo-bg/resolve/main/
   ```

5. Add the domains from the table above (production domain plus one branch
   alias per release branch).
6. Deploy. The build prepares the WebGPU-capable runtime without downloading
   model weights, builds the application, copies legal documents, and removes
   any local `dist/models/` directory.

## Build behaviour

The `vercel:build` script:

- Downloads the WebGPU-capable runtime without model weights.
- Runs `npm run build` for type-checking and the Vite production build.
- Copies legal and privacy documents into `dist/`.
- Removes `dist/models/`; model weights are fetched from Hugging Face at runtime.

## Security headers

`vercel.json` configures COOP, COEP, and Content-Security-Policy response
headers for production. The Vite development and preview servers apply their
corresponding headers through `vite.config.ts`.

## Local development

```sh
npm ci
npm run fetch-models -- --webgpu
npm run dev
```

For a local production build and preview:

```sh
npm run build
npm run preview
```

The service worker caches downloaded model assets on the device. Bump
`CACHE_VERSION` in `public/sw.js` when changing the model or ONNX Runtime.
