#!/usr/bin/env python3
"""Run one model over the test images and save full-resolution float masks.

One session per process, so the two models' activation peaks never overlap.
intra_op_num_threads=1 keeps ORT from multiplying its per-thread arenas, which
is what got the earlier combined run OOM-killed.
"""
import os
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
IMAGES = [
    "test-images/product-scent-bottle.jpg",
    "test-images/animal-buddy-dog.jpg",
    "test-images/glass-wine.jpg",
]
OUT = "smoke-results/measurements/masks"

model, size, sigmoid, tag = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "1", sys.argv[4]
os.makedirs(OUT, exist_ok=True)

opts = ort.SessionOptions()
opts.intra_op_num_threads = 1
opts.inter_op_num_threads = 1
opts.enable_mem_pattern = False
sess = ort.InferenceSession(model, sess_options=opts, providers=["CPUExecutionProvider"])
name_in = sess.get_inputs()[0].name
name_out = sess.get_outputs()[0].name

for path in IMAGES:
    image = Image.open(path)
    img = image.convert("RGB").resize((size, size), Image.BILINEAR)
    arr = np.asarray(img, dtype=np.float32) / 255.0
    arr = (arr - MEAN) / STD
    tensor = np.ascontiguousarray(arr.transpose(2, 0, 1)[None, ...], dtype=np.float32)

    preds = sess.run([name_out], {name_in: tensor})[0]
    m = preds[0, -1].astype(np.float32)
    if sigmoid:
        m = 1.0 / (1.0 + np.exp(-m))
    # Resize the float mask so the comparison is not quantised to 8-bit.
    up = np.asarray(
        Image.fromarray(m, mode="F").resize(image.size, Image.BILINEAR), dtype=np.float32
    ).clip(0.0, 1.0)

    base = os.path.splitext(os.path.basename(path))[0]
    np.save(f"{OUT}/{base}_{tag}.npy", up)
    print(f"{base} {tag} ok {up.shape}", flush=True)
    del preds, m, up, tensor
