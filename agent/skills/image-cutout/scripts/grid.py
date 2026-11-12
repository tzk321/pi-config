#!/usr/bin/env python3
"""Ruler grid overlay: pick --paint boxes without guessing coordinates.

    ~/.cache/pi-cutout/.venv/bin/python grid.py IMG [--step 100] [--out /tmp/grid.png] [--width 1000]

Prints the image size, then writes a labelled overlay (lines every `step` px,
coordinates in the image's own pixel space).
"""
from __future__ import annotations

import argparse

from PIL import Image, ImageDraw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("img")
    ap.add_argument("--step", type=int, default=100)
    ap.add_argument("--width", type=int, default=1000)
    ap.add_argument("--out", default="/tmp/grid.png")
    args = ap.parse_args()

    im = Image.open(args.img).convert("RGB")
    W, H = im.size
    scale = args.width / W
    im = im.resize((args.width, int(H * scale)), Image.LANCZOS)
    d = ImageDraw.Draw(im, "RGBA")
    step = max(1, int(args.step * scale))
    for x in range(0, im.width, step):
        d.line([(x, 0), (x, im.height)], fill=(0, 255, 255, 110), width=1)
        d.text((x + 2, 2), str(int(x / scale)), fill=(255, 0, 255, 255))
    for y in range(0, im.height, step):
        d.line([(0, y), (im.width, y)], fill=(0, 255, 255, 110), width=1)
        d.text((2, y + 1), str(int(y / scale)), fill=(255, 0, 255, 255))
    im.save(args.out)
    print(f"{W}x{H} -> {args.out} {im.size[0]}x{im.size[1]} | grid step {args.step}px")


if __name__ == "__main__":
    main()
