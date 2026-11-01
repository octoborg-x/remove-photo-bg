TUNNEL_HOST=<paste the trycloudflare hostname here>
SSH_KEY=~/.ssh/colab_ed25519

Connect to the Colab instance and execute the distillation plan exactly as
specified in optimize_model_plan/audit.md (already in the repo, read it fully
before acting). Implementation order and STOP gates from that document are
binding; never invent results, hashes, licences, dataset counts or benchmark
numbers.

1. CONNECT
   - Repo is already cloned at /content/remove-photo-bg on the Colab instance.
   - Connect per audit.md §3.1 using the cloudflared ProxyCommand and this key,
     e.g.:
       ssh -p 2222 \
         -o ProxyCommand="cloudflared access ssh --hostname $TUNNEL_HOST" \
         -i ~/.ssh/colab_ed25519 root@$TUNNEL_HOST
     (adapt the exact cloudflared invocation if the client version differs).
   - Run nvidia-smi. If no GPU is visible, STOP and report.
     Never present CPU numbers as GPU results.
   - Record GPU name, driver, CUDA, plus python/torch/onnxruntime-gpu versions
     in smoke-results/distill/run-metadata.json (per repo scripts).

2. EXECUTE (in audit.md order)
   - Phase 1: data plan, sources, preselection, evaluation set. Use/verify the
     scripts in scripts/distill/ (fetch-cc0.py, select.py, make-labels.py).
     Write DISTILL_PLAN.md with the §7 acceptance criteria and §3.3 Colab
     terms finding. Checkpoint manifests and contact sheets to Google Drive
     (path per §3.5) if Drive is mounted; otherwise keep them on the instance.
   - STOP at the end of Phase 1 and report back to me with the plan path,
     real counts/hashes and blockers. Do not start training until I approve —
     the spec mandates this gate.
   - Colab is ephemeral: run long jobs under tmux/nohup, log to Drive,
     make every step idempotent/resumable, checkpoint at least every 10 min.

3. REPORT
   - Report blockers instead of working around them. Never exceed the §4
     storage budget. Never delete user data.
   - Security: key-only auth is already configured on the instance — do not
     change it, do not print or store any private key or token.
