#!/usr/bin/env python3
"""Compare a cutout against a reference alpha (regression check).

    ~/.cache/pi-cutout/.venv/bin/python compare.py NEW.png REFERENCE.png

Prints alpha IoU plus the largest clusters of extra / missing pixels with their
bounding boxes, so you can see *where* the two disagree instead of a bare number.
"""
from __future__ import annotations

import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi


def mask(path, thr=127):
    im = Image.open(path)
    if im.mode != "RGBA":
        raise SystemExit(f"{path}: not RGBA (mode {im.mode})")
    return np.asarray(im)[:, :, 3] > thr


def clusters(m, top=4, min_area=300):
    lbl, n = ndi.label(m)
    if n == 0:
        return []
    sizes = ndi.sum(m, lbl, range(1, n + 1))
    out = []
    for i in np.argsort(sizes)[::-1][:top]:
        if sizes[i] < min_area:
            continue
        ys, xs = np.where(lbl == i + 1)
        out.append((int(sizes[i]), (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)))
    return out


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    new, ref = mask(sys.argv[1]), mask(sys.argv[2])
    if new.shape != ref.shape:
        raise SystemExit(f"size mismatch: {new.shape} vs {ref.shape}")
    inter, union = (new & ref).sum(), (new | ref).sum()
    print(f"IoU {inter / union:.4f} | union {int(union)} px")
    for name, m in (("extra", new & ~ref), ("missing", ref & ~new)):
        print(f"{name}: {int(m.sum())} px")
        for area, box in clusters(m):
            print(f"   area={area:6d} box={box}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
