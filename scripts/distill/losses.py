#!/usr/bin/env python3
"""Distillation losses (spec §6-Phase3):
loss = BCE(student, teacher_soft)
     + IoU loss
     + 0.5 * L1(gradient(student), gradient(teacher))
     + 0.5 * SSIM(student, teacher)
plus optional boundary-weighted term and optional GT-BCE where GT exists.
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F


def iou_loss(pred: torch.Tensor, target: torch.Tensor, eps: float = 1e-6):
    inter = (pred * target).sum()
    union = pred.sum() + target.sum() - inter
    return 1.0 - (inter + eps) / (union + eps)


def gradient_penalty(pred: torch.Tensor, target: torch.Tensor):
    """0.5 * L1 between gradient magnitudes. Channels = 1 (mask)."""
    g1 = torch.abs(torch.gradient(pred, dim=(2, 3))[0]) + \
         torch.abs(torch.gradient(pred, dim=(2, 3))[1])
    g2 = torch.abs(torch.gradient(target, dim=(2, 3))[0]) + \
         torch.abs(torch.gradient(target, dim=(2, 3))[1])
    return F.l1_loss(g1, g2)


def ssim_loss(pred: torch.Tensor, target: torch.Tensor,
              win_size: int = 7, sigma: float = 1.5):
    """Standard SSIM on 1-channel masks; returns 1 - SSIM (a loss)."""
    from torch.nn.functional import conv2d, pad
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    k = torch.arange(win_size, dtype=pred.dtype, device=pred.device) - (win_size // 2)
    k = torch.exp(-0.5 * (k / sigma) ** 2)
    k = k / k.sum()
    win = torch.outer(k, k).view(1, 1, win_size, win_size)

    def conv(x):
        return conv2d(pad(x, (win_size // 2,) * 4, mode="reflect"), win,
                      stride=1, padding=0)

    mu1, mu2 = conv(pred), conv(target)
    p2, t2, pt = pred * pred, target * target, pred * target
    s11, s22, s12 = conv(p2) - mu1 ** 2, conv(t2) - mu2 ** 2, conv(pt) - mu1 * mu2
    num = (2 * mu1 * mu2 + c1) * (2 * s12 + c2)
    den = (mu1 ** 2 + mu2 ** 2 + c1) * (s11 + s22 + c2)
    return 1.0 - (num / den.clamp(min=1e-6)).mean()


class DistillLoss(nn.Module):
    def __init__(self, w_bce: float = 1.0, w_iou: float = 1.0,
                 w_grad: float = 0.5, w_ssim: float = 0.5,
                 w_gt: float = 0.2):
        super().__init__()
        self.w_bce, self.w_iou = w_bce, w_iou
        self.w_grad, self.w_ssim = w_grad, w_ssim
        self.w_gt = w_gt
        self.bce = nn.BCEWithLogitsLoss()

    def forward(self, pred: torch.Tensor, teacher_soft: torch.Tensor,
                gt: torch.Tensor | None = None):
        logits = torch.logit(pred.clamp(1e-6, 1 - 1e-6))  # to logits for BCE
        loss = self.w_bce * self.bce(logits, teacher_soft)
        loss = loss + self.w_iou * iou_loss(pred, teacher_soft)
        loss = loss + self.w_grad * gradient_penalty(pred, teacher_soft)
        loss = loss + self.w_ssim * ssim_loss(pred, teacher_soft)
        if gt is not None and self.w_gt > 0:
            loss = loss + self.w_gt * self.bce(logits.clamp(-5, 5), gt)
        return loss