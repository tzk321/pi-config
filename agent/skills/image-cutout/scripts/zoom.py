#!/usr/bin/env python3
"""Zoomed side-by-side inspection strip for a cutout.

    ~/.cache/pi-cutout/.venv/bin/python inspect.py SRC CUTOUT X0,Y0,X1,Y1 [--zoom 2] \
        [--out /tmp/inspect.png] [--bg white,magenta,black,checker]

Panel order: original, then the cutout composited over each --bg colour.
Reading a bright magenta / dark panel makes residual background, halos and
hard alpha steps obvious in ways a white panel hides.
"""
from __future__ import annotations

import argparse

import numpy as np
from PIL import Image

PANELS = {
    "white": (255, 255, 255),
    "black": (20, 20, 20),
    "magenta": (255, 0, 255),
    "green": (0, 255, 0),
    "grey": (128, 128, 128),
}


def checker(w, h, s=16):
    yy, xx = np.mgrid[0:h, 0:w]
    c = (((yy // s) + (xx // s)) % 2).astype(np.uint8)
    return np.where(c[..., None] == 0, 210, 160).astype(np.uint8).repeat(3, axis=2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("cut")
    ap.add_argument("box", help="x0,y0,x1,y1")
    ap.add_argument("--zoom", type=float, default=2.0)
    ap.add_argument("--out", default="/tmp/inspect.png")
    ap.add_argument("--bg", default="white,magenta,black,checker")
    args = ap.parse_args()

    x0, y0, x1, y1 = (int(v) for v in args.box.split(","))
    src = Image.open(args.src).convert("RGB")
    cut = Image.open(args.cut).convert("RGBA")
    box = (x0, y0, min(x1, src.width), min(y1, src.height))
    base = src.crop(box)
    tile = cut.crop(box)

    panels = [base]
    for name in args.bg.split(","):
        name = name.strip()
        if name == "checker":
            bg = Image.fromarray(checker(*tile.size))
        elif name in PANELS:
            bg = Image.new("RGB", tile.size, PANELS[name])
        else:
            raise SystemExit(f"unknown --bg panel: {name}")
        bg.paste(tile, (0, 0), tile)
        panels.append(bg)

    w, h = base.size
    gap = 10
    canvas = Image.new("RGB", (w * len(panels) + gap * (len(panels) - 1), h), (24, 24, 24))
    for i, pan in enumerate(panels):
        canvas.paste(pan, (i * (w + gap), 0))
    canvas = canvas.resize((int(canvas.width * args.zoom), int(canvas.height * args.zoom)),
                           Image.LANCZOS)
    canvas.save(args.out)
    print(f"wrote {args.out} {canvas.size[0]}x{canvas.size[1]} (panel1=original, then {args.bg})")


if __name__ == "__main__":
    main()
