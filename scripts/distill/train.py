#!/usr/bin/env python3
"""Train the student against teacher soft labels (spec §6-Phase3).

Hosts a small, deterministic, resumable training loop:
  - reads data/manifest-selected.csv (rows with split=train)
  - for each row loads the image + teacher soft label (8-bit PNG/255)
  - loss  = DistillLoss (BCE + IoU + grad-L1 + SSIM) vs teacher soft label
  - optimizer AdamW, one-cycle-ish cosine schedule
  - AMP (torch.autocast) when cuda is available
  - checkpoint every --ckpt-every-steps and every --ckpt-every-minutes,
    keep last K + best, all hashed to run-metadata
  - deterministic seeds, resumable from the latest checkpoint prefix

Usage:
    python3 scripts/distill/train.py \
        --manifest data/manifest-selected.csv \
        --labels data/labels512 --ckpt-dir smoke-results/distill/ckpt \
        --epochs 2 --batch 2 --size 512 --limit 8   # CPU smoke
    # Colab GPU (real):
    python3 scripts/distill/train.py --manifest data/manifest-selected.csv \
        --labels /content/drive/.../labels512 --ckpt-dir ... --epochs 30
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from _bootstrap import *  # noqa: F401, E402  (sys.path fix)
import numpy as np
import torch
from PIL import Image

from scripts.distill.losses import DistillLoss
from scripts.distill.student import build_student

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_pair(img_path: Path, label_path: Path, size: int):
    img = Image.open(img_path).convert("RGB").resize((size, size),
                                                     Image.BILINEAR)
    x = np.asarray(img, np.float32) / 255.0
    x = (x - MEAN) / STD
    x = x.transpose(2, 0, 1)[None].astype(np.float32)          # [1,3,S,S]

    lab = Image.open(label_path).convert("L").resize((size, size),
                                                     Image.NEAREST)
    y = np.asarray(lab, np.float32) / 255.0                    # [S,S]
    y = y[None, None, ...].astype(np.float32)                  # [1,1,S,S]
    return x, y


def make_dataset(manifest: Path, labels: Path, images: Path, size: int,
                 limit: int = 0):
    rows = [r for r in csv.DictReader(open(manifest)) if r.get("split") == "train"]
    if limit:
        rows = rows[:limit]
    pairs = []
    for r in rows:
        lab = labels / r["id"][:2] / f"{r['id']}.png"
        img = images / f"{r['sha256']}.jpg"
        if lab.exists() and img.exists():
            pairs.append((img, lab, r["id"]))
    return pairs


def evaluate(model, dl, device, size):
    model.eval()
    losses, meters = [], {"bce": 0.0, "iou": 0.0}
    with torch.no_grad():
        for x, y, _ in dl:
            x, y = x.to(device), y.to(device)
            p = model(x)
            losses.append(float(model._loss_fn(p, y)))
    return float(np.mean(losses)) if losses else float("nan")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True, type=Path)
    ap.add_argument("--labels", default="data/labels512", type=Path)
    ap.add_argument("--images", default="data/images", type=Path)
    ap.add_argument("--ckpt-dir", default="smoke-results/distill/ckpt", type=Path)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--batch", type=int, default=2)
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--ckpt-every-steps", type=int, default=0)
    ap.add_argument("--ckpt-every-minutes", type=int, default=10)
    ap.add_argument("--keep-best", type=int, default=1)
    ap.add_argument("--backbone", default="mobilenetv3_large_100")
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    random.seed(args.seed)
    torch.set_num_threads(max(1, os.cpu_count() or 1))

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"device: {device}")

    model = build_student(backbone=args.backbone).to(device)
    loss_fn = DistillLoss()
    model._loss_fn = loss_fn
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)

    pairs = make_dataset(args.manifest, args.labels, args.images, args.size,
                         args.limit)
    if not pairs:
        print("no train pairs (manifest/labels missing?)"); sys.exit(2)
    # shuffle once deterministically; simple batching
    rng = random.Random(args.seed)
    rng.shuffle(pairs)
    n = len(pairs)
    print(f"train pairs: {n}")

    args.ckpt_dir.mkdir(parents=True, exist_ok=True)
    start_step, best = 0, float("inf")
    # resume
    ckpts = sorted(args.ckpt_dir.glob("step-*.pt"))
    if ckpts:
        last = ckpts[-1]
        sd = torch.load(last, map_location=device)
        model.load_state_dict(sd["model"])
        opt.load_state_dict(sd["opt"])
        start_step = sd["step"]
        best = sd.get("best", float("inf"))
        print(f"resumed from {last} at step {start_step}")

    steps_per_epoch = max(1, (n + args.batch - 1) // args.batch)
    total_steps = steps_per_epoch * args.epochs
    sched = torch.optim.lr_scheduler.OneCycleLR(
        opt, max_lr=args.lr, total_steps=total_steps,
        pct_start=0.3, anneal_strategy="cos")
    if start_step:
        for _ in range(start_step):
            sched.step()

    use_amp = device == "cuda"
    scaler = torch.cuda.amp.GradScaler(enabled=use_amp)

    last_ckpt_time = time.time()
    step = start_step
    for epoch in range(args.epochs):
        model.train()
        for i in range(0, n, args.batch):
            bx, by = [], []
            for img, lab, _ in pairs[i:i + args.batch]:
                x, y = load_pair(img, lab, args.size)
                bx.append(torch.from_numpy(x)); by.append(torch.from_numpy(y))
            x, y = torch.cat(bx).to(device), torch.cat(by).to(device)
            opt.zero_grad()
            with torch.autocast(device_type="cuda", enabled=use_amp):
                p = model(x)
                loss = loss_fn(p, y)
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
            sched.step()
            step += 1
            if step % max(1, steps_per_epoch // 4) == 0 or loss.item() < best:
                print(f"ep{epoch} step{step}/{total_steps} loss={loss.item():.4f} "
                      f"lr={sched.get_last_lr()[0]:.2e}")

            need_step = args.ckpt_every_steps and step % args.ckpt_every_steps == 0
            need_min = time.time() - last_ckpt_time >= args.ckpt_every_minutes * 60
            if need_step or need_min:
                save = {
                    "model": model.state_dict(), "opt": opt.state_dict(),
                    "step": step, "epoch": epoch, "best": best,
                }
                f = args.ckpt_dir / f"step-{step}.pt"
                torch.save(save, f)
                last_ckpt_time = time.time()
                # prune keeps last-3 + best
                allc = sorted(args.ckpt_dir.glob("step-*.pt"))
                bestc = [c for c in allc if c.name.startswith("best-")]
                for c in allc[:-3]:
                    c.unlink(missing_ok=True)
                if loss.item() < best:
                    best = loss.item()
                    (args.ckpt_dir / f"best-{step}.pt").write_bytes(f.read_bytes())

        # end of epoch
        save = {"model": model.state_dict(), "opt": opt.state_dict(),
                "step": step, "epoch": epoch, "best": best}
        torch.save(save, args.ckpt_dir / f"step-{step}.pt")
        allc = sorted(args.ckpt_dir.glob("step-*.pt"))
        for c in allc[:-3]:
            c.unlink(missing_ok=True)

    # final + metadata
    final = args.ckpt_dir / "final.pt"
    torch.save({"model": model.state_dict()}, final)
    meta = {
        "backend": "torch", "torch": torch.__version__, "device": device,
        "epochs": args.epochs, "pairs": n, "size": args.size, "lr": args.lr,
        "steps_total": step, "final_sha256": sha256_file(final),
        "seed": args.seed,
    }
    (args.ckpt_dir.parent / "train-metadata.json").write_text(
        json.dumps(meta, indent=2))
    print(f"done: steps={step} | final -> {final} | sha256={meta['final_sha256']}")


if __name__ == "__main__":
    raise SystemExit(main())