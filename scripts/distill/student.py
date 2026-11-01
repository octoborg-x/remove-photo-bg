#!/usr/bin/env python3
"""Student B — UNet/FPN decoder on a MobileNetV3-Large encoder (spec §6-Phase3).

Contract (must match the app):
    input:  [1,3,S,S] float32 NCHW, ImageNet normalized
    output: [1,1,S,S] float32 probabilities in [0,1] (sigmoid baked in)

Only ONNX-opset-17 / onnxruntime-web-WASM-friendly ops: conv2d, bn, relu,
upsample (bilinear), add. No deformable conv, no large attention.
BatchNorm is folded at export time (scripts/distill/export.py).

The encoder uses timm's pretrained MobileNetV3-Large features_only. A tiny
UNet head with skip connections preserves edges (thin structures, hair).
Channel budget kept small so the fp32 ONNX target stays <= ~25 MB.
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F


class ConvBNReLU(nn.Module):
    def __init__(self, cin: int, cout: int, k: int = 3, stride: int = 1,
                 pad: int = 1):
        super().__init__()
        self.conv = nn.Conv2d(cin, cout, k, stride, pad, bias=False)
        self.bn = nn.BatchNorm2d(cout)
        self.act = nn.ReLU(inplace=True)

    def forward(self, x):
        return self.act(self.bn(self.conv(x)))


class StudentB(nn.Module):
    """MobileNetV3-Large encoder + lightweight UNet decoder.

    features_only -> C = (24, 48, 96, 96) for in_ch=3 (channels may shift by
    timm version; the decoder reads them dynamically).

    Decoder path:
      up4  -> out_channels 32, then bilinear upsample + concat with fp-stem
      up2  -> 16
      head -> 1, sigmoid on logits
    """

    def __init__(self, backbone: str = "mobilenetv3_large_100", in_ch: int = 3):
        super().__init__()
        import timm
        stages = timm.create_model(
            backbone, features_only=True, out_indices=(1, 2, 3, 4),
            pretrained=True)
        ch = stages.feature_info.channels()   # dynamic per timm version
        self.stages = stages
        self.c1, self.c2, self.c3, self.c4 = ch

        # stem consistent with encoder's stem; this is the "fp-stem" level-0
        self.stem = ConvBNReLU(in_ch, 16, k=3, stride=2)      # 1/2
        self.dec4 = ConvBNReLU(self.c4, 32)
        self.dec3 = ConvBNReLU(self.c3 + 32, 32)
        self.dec2 = ConvBNReLU(self.c2 + 32, 24)
        self.dec1 = ConvBNReLU(self.c1 + 16 + 24, 16)          # +stem
        self.head = nn.Conv2d(16, 1, 1)
        self.sigmoid = nn.Sigmoid()

    def _upsam_plus(self, feat, ref, out_c):
        return F.interpolate(feat, size=ref.shape[-2:], mode="bilinear",
                             align_corners=False)

    def forward(self, x):
        # stage feature maps (descending resolution)
        fm = self.stages(x)                  # [c1@1/4, c2@1/8, c3@1/16, c4@1/32]
        f1, f2, f3, f4 = fm                 # NOTE: fm[0] is the 1/4 output
        # 1/8 resolution decoder
        d4 = self.dec4(f4)                                      # 32@1/32
        d4 = self._upsam_plus(d4, f3, 32)                       # ->1/16
        d3 = self.dec3(torch.cat([d4, f3], 1))                  # 32@1/16
        d3 = self._upsam_plus(d3, f2, 32)                       # ->1/8
        d2 = self.dec2(torch.cat([d3, f2], 1))                  # 24@1/8
        d2 = self._upsam_plus(d2, f1, 24)                       # ->1/4
        stem = self.stem(x)                                     # 16@1/2
        stem = F.interpolate(stem, size=f1.shape[-2:], mode="bilinear",
                             align_corners=False)               # ->1/4
        d1 = self.dec1(torch.cat([d2, f1, stem], 1))            # 16@1/4
        logit = self.head(d1)                                  # 1@1/4
        logit = F.interpolate(logit, size=x.shape[-2:],
                              mode="bilinear", align_corners=False)
        return self.sigmoid(logit)


def build_student(backbone: str = "mobilenetv3_large_100",
                  in_ch: int = 3) -> nn.Module:
    return StudentB(backbone=backbone, in_ch=in_ch)


if __name__ == "__main__":
    m = build_student()
    x = torch.randn(1, 3, 512, 512)
    with torch.no_grad():
        y = m(x)
    print("student out:", tuple(y.shape), float(y.min()), float(y.max()))
    n = sum(p.numel() for p in m.parameters())
    print("params:", f"{n/1e6:.2f}M")