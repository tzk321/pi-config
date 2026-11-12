#!/usr/bin/env python3
"""Flat-background cutout for anime / illustration art.

isnet-anime segmentation + background-colour matting + halo removal.

Run with the skill venv:
    ~/.cache/pi-cutout/.venv/bin/python cutout.py IN OUT [options]

Typical:
    cutout.py kati.png kati-cutout.png --preview /tmp/prev.png --report
    cutting away background decoration the model keeps:
    cutout.py in.png out.png --paint 180,65,420,175 0,470,400,735 --report

Exit code 0 on success. Prints a small report to stdout.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

# --------------------------------------------------------------------------- #
# background estimate
# --------------------------------------------------------------------------- #


def border_pixels(A: np.ndarray, width: int = 6) -> np.ndarray:
    return np.concatenate(
        [
            A[:width].reshape(-1, 3),
            A[-width:].reshape(-1, 3),
            A[:, :width].reshape(-1, 3),
            A[:, -width:].reshape(-1, 3),
        ]
    )


def detect_bg(A: np.ndarray, tol: float = 35.0):
    """Detect background colour + its border-connected region.

    Border bands (letterbox stripes, white margins) are common, so the most
    frequent border colour is not automatically the background: candidates are
    ranked by the size of the region they flood into from the image border.
    """
    H, W, _ = A.shape
    bp = border_pixels(A).astype(np.int16)
    q = (bp // 8).astype(np.int32)
    keys = q[:, 0] * 1000000 + q[:, 1] * 1000 + q[:, 2]
    uniq, counts = np.unique(keys, return_counts=True)
    order = np.argsort(counts)[::-1][:5]

    border = np.zeros((H, W), bool)
    border[0, :] = border[-1, :] = True
    border[:, 0] = border[:, -1] = True

    best = None
    for i in order:
        cand = np.median(bp[keys == uniq[i]], axis=0).astype(np.float32)
        d = np.abs(A - cand).max(axis=2)
        seed = border & (d < tol)
        if seed.sum() < 16:
            continue
        region = ndi.binary_propagation(seed, mask=(d < tol))
        area = int(region.sum())
        if best is None or area > best[0]:
            best = (area, region)
    if best is None:
        return detect_bg_mode(A), np.zeros((H, W), bool)
    area, region = best
    return np.median(A[region], axis=0).astype(np.float32), region


def detect_bg_mode(A: np.ndarray) -> np.ndarray:
    """Fallback: most common quantised border colour."""
    bp = border_pixels(A).astype(np.int16)
    q = (bp // 8).astype(np.int32)
    keys = q[:, 0] * 1000000 + q[:, 1] * 1000 + q[:, 2]
    uniq, counts = np.unique(keys, return_counts=True)
    sel = keys == uniq[np.argmax(counts)]
    return np.median(bp[sel], axis=0).astype(np.float32)


def bg_field(A: np.ndarray, B: np.ndarray, region: np.ndarray | None = None,
             tol: float = 22.0) -> np.ndarray:
    """Per-pixel background colour = colour of the nearest clean background pixel.

    Handles gradients / vignettes that a single global colour would miss.  The
    seed set is kept *tight* (tol 22) on purpose: a loose tolerance drags
    near-background subject colours (pumpkin cream, pale skin) into the field and
    then the field colour is no longer a true background sample.
    """
    H, W, _ = A.shape
    d = np.abs(A - B).max(axis=2)
    cls = region if region is not None else np.ones((H, W), bool)
    seed = cls & (d < tol)
    if seed.sum() < 16:
        seed = cls & (d < tol * 2)
    if seed.sum() < 16:
        return np.broadcast_to(B, A.shape).copy()
    _, idx = ndi.distance_transform_edt(~seed, return_indices=True)
    return A[idx[0], idx[1]]


# --------------------------------------------------------------------------- #
# rect painting (remove bg decorations before inference)
# --------------------------------------------------------------------------- #


def parse_paint(spec: str):
    parts = spec.split(":")
    box = [int(v) for v in parts[0].split(",")]
    if len(box) != 4:
        raise SystemExit(f"bad --paint box (want x0,y0,x1,y1): {spec}")
    flood = parts[-1].strip().lower() == "flood"
    if flood:
        parts = parts[:-1]
    mode = parts[1] if len(parts) > 1 else "color"
    tol = float(parts[2]) if len(parts) > 2 else None
    if mode not in ("all", "color", "neutral", "bright", "shadow"):
        raise SystemExit(f"bad --paint mode: {mode}")
    return box, mode, tol, flood


def dominant_colour(px: np.ndarray, B: np.ndarray) -> np.ndarray:
    """Most common quantised colour in the region that is not the background.

    Near-white pixels are skipped unless the background itself is near-white:
    white letterbox margins are handled by the `bright` mode and would otherwise
    steal the dominant-colour vote from the junk the box is actually aimed at.
    """
    bg_is_white = B.min() >= 235
    usable = px.min(axis=1) < 245 if not bg_is_white else np.ones(len(px), bool)
    cand = px[usable] if usable.sum() > 64 else px
    q = (cand.astype(np.int32) // 12)
    keys = q[:, 0] * 1000000 + q[:, 1] * 1000 + q[:, 2]
    uniq, counts = np.unique(keys, return_counts=True)
    order = np.argsort(counts)[::-1]
    for i in order[:8]:
        sel = keys == uniq[i]
        med = np.median(cand[sel], axis=0)
        if np.abs(med - B).max() > 40:
            return med.astype(np.float32)
    return np.median(cand, axis=0).astype(np.float32)


def flood_from_box_border(m: np.ndarray) -> np.ndarray:
    """Keep only components of `m` that touch the box border.

    A decoration is usually clipped by the box, while a subject part (shoe, hair)
    floating inside the box is not, so this separates "this junk is background"
    from "I drew the box too big and hit the character".
    """
    if not m.any():
        return m
    ring = np.zeros_like(m)
    ring[0, :] = ring[-1, :] = True
    ring[:, 0] = ring[:, -1] = True
    lbl, n = ndi.label(m)
    keep = np.unique(lbl[ring & m])
    keep = keep[keep > 0]
    if keep.size == 0:
        return m
    return np.isin(lbl, keep)


def paint_mask(A, Bf, B, specs):
    P = np.zeros(A.shape[:2], bool)
    for spec in specs:
        (x0, y0, x1, y1), mode, tol, flood = parse_paint(spec)
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(A.shape[1], x1), min(A.shape[0], y1)
        box = A[y0:y1, x0:x1]
        if box.size == 0:
            continue
        sub = P[y0:y1, x0:x1]
        if mode == "all":
            sub[:] = True
            m = np.ones(box.shape[:2], bool)
            print(f"  paint {mode:7s} box=({x0},{y0},{x1},{y1}) px={int(m.sum()):6d}")
            continue
        if mode == "color":
            t = 26.0 if tol is None else tol
            c = dominant_colour(box.reshape(-1, 3), B)
            m = np.abs(box - c).max(axis=2) < t
            m = ndi.binary_closing(m, np.ones((5, 5)))
            m = ndi.binary_dilation(m, np.ones((3, 3))) & (np.abs(box - c).max(axis=2) < t + 16)
        elif mode == "neutral":
            t = 22.0 if tol is None else tol
            mx = box.max(axis=2)
            mn = box.min(axis=2)
            m = (mx - mn) <= t
        elif mode == "shadow":
            t = 24.0 if tol is None else tol
            mx = box.max(axis=2)
            mn = box.min(axis=2)
            cos, _ = chroma_cosine(box, B)
            # floor shadows are desaturated but keep the hue of whatever is lit,
            # not the hue of the background: a grey-blue shoe must survive.
            m = ((mx - mn) <= t) & (mx >= 70) & (mx <= 180) & (cos <= 0.35)
        else:  # bright
            t = 235.0 if tol is None else tol
            m = box.min(axis=2) >= t
        if flood:
            m = flood_from_box_border(m)
        sub |= m
        print(f"  paint {mode:7s} box=({x0},{y0},{x1},{y1}) px={int(m.sum()):6d}"
              f"{' flood' if flood else ''}")
    return P


# --------------------------------------------------------------------------- #
# mask post-processing
# --------------------------------------------------------------------------- #


def chroma_cosine(A: np.ndarray, B: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    mean = A.mean(axis=2, keepdims=True)
    cI = A - mean
    nI = np.linalg.norm(cI, axis=2)
    cB = B - B.mean()
    nB = float(np.linalg.norm(cB)) + 1e-6
    cos = (cI @ (cB / nB)) / np.maximum(nI, 1e-6)
    return cos, nI / nB


def soft_key(d: np.ndarray, floor: float, span: float) -> np.ndarray:
    return np.clip((d - floor) / span, 0.0, 1.0)


def key_out_background(a, Aeff, Bf, B, tol, floor, span, force_bg=None):
    """Zero alpha on background-coloured pixels, but only when the hue matches B.

    The hue guard keeps same-brightness but differently-hued art (e.g. blue plaid
    on a purple background) intact.  Pixels the caller explicitly painted with a
    --paint box are background by decree and skip the hue guard.
    """
    d = np.abs(Aeff - Bf).max(axis=2)
    cos, satr = chroma_cosine(Aeff, B)
    # strict on purpose: a shaded blue-grey shoe is "cool like the purple background"
    # so a loose hue test punches stripes through it.  Real leftover background
    # pixels score cos~1.0 / satr~1.0.
    hue_ok = (cos > 0.95) & (satr > 0.6)
    hit = hue_ok & (d < tol)
    a = np.where(hit, np.minimum(a, soft_key(d, floor, span)), a)
    # Background-coloured islands enclosed by keyed pixels (glass interior, plastic
    # ornament, glossy highlight) would otherwise survive as purple speckles at
    # partial alpha: the soft ramp is right for edges, wrong for holes.
    if hit.any():
        island = ndi.binary_fill_holes(ndi.binary_closing(hit, np.ones((3, 3)))) & (d < tol)
        a = np.where(island, 0.0, a)
    if force_bg is not None and force_bg.any():
        a = np.where(force_bg, 0.0, a)
    return a, int(hit.sum())


def key_holes(a, Aeff, Bf, floor, span, min_area=120):
    """Enclosed background regions: the model marks any closed gap as foreground."""
    solid = a > 0.5
    holes = ndi.binary_fill_holes(solid) & ~solid
    if not holes.any():
        return a, 0
    lbl, n = ndi.label(holes)
    sizes = ndi.sum(holes, lbl, range(1, n + 1))
    keep = np.isin(lbl, np.where(sizes >= min_area)[0] + 1)
    if not keep.any():
        return a, 0
    d = np.abs(Aeff - Bf).max(axis=2)
    return np.where(keep, np.minimum(a, soft_key(d, floor, span)), a), int(keep.sum())


def drop_specks(a, min_area):
    lbl, n = ndi.label(a > 0.35)
    if n == 0:
        return a, 0, 0
    sizes = ndi.sum(np.ones_like(a), lbl, range(1, n + 1))
    keep = np.concatenate([[False], sizes > min_area])
    dropped = int(sizes[sizes <= min_area].sum()) if (sizes <= min_area).any() else 0
    return a * keep[lbl], int(keep.sum()), dropped


def component_info(a, min_area=800):
    """Largest component = subject; list the others the model kept (decorations)."""
    lbl, n = ndi.label(a > 0.5)
    if n == 0:
        return None, []
    sizes = ndi.sum(np.ones_like(a), lbl, range(1, n + 1))
    main = int(np.argmax(sizes)) + 1
    others = []
    for i in range(1, n + 1):
        if i == main or sizes[i - 1] < min_area:
            continue
        ys, xs = np.where(lbl == i)
        others.append(
            dict(label=i, area=int(sizes[i - 1]),
                 box=[int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1])
        )
    others.sort(key=lambda o: -o["area"])
    return main, others


def drop_remote(a, min_area):
    main, others = component_info(a, min_area)
    if main is None or not others:
        return a, []
    lbl, _ = ndi.label(a > 0.5)
    ids = [o["label"] for o in others]
    return a * ~np.isin(lbl, ids), others


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #


def main():
    p = argparse.ArgumentParser(description="flat-background cutout (anime illustrations)")
    p.add_argument("src")
    p.add_argument("dst")
    p.add_argument("--model", default="isnet-anime")
    p.add_argument("--bg", default="auto", help="auto | R,G,B")
    p.add_argument("--paint", action="append", default=[],
                   metavar="x0,y0,x1,y1[:mode[:tol]]",
                   help="paint background junk out before inference; "
                        "mode=all|color|neutral|bright|shadow")
    p.add_argument("--key-tol", type=float, default=34.0, help="max channel distance still treated as background")
    p.add_argument("--key-floor", type=float, default=9.0)
    p.add_argument("--key-span", type=float, default=20.0)
    p.add_argument("--no-holefix", action="store_true")
    p.add_argument("--no-key", action="store_true", help="skip background colour keying")
    p.add_argument("--no-decontam", action="store_true", help="skip purple-halo / edge unmixing")
    p.add_argument("--contrast", default="0.16,0.66", help="alpha tighten: LO,SPAN")
    p.add_argument("--min-speck", type=int, default=60)
    p.add_argument("--drop-remote", type=int, default=0,
                   metavar="AREA", help="delete detached components >= AREA px (decorations)")
    p.add_argument("--crop-tight", action="store_true", help="trim transparent margins")
    p.add_argument("--preview", default=None, help="write checkerboard composite here")
    p.add_argument("--alpha-out", default=None, help="write raw alpha PNG here")
    p.add_argument("--report", action="store_true")
    args = p.parse_args()

    src = Path(args.src).expanduser()
    dst = Path(args.dst).expanduser()
    A0 = np.asarray(Image.open(src).convert("RGB")).astype(np.float32)
    H, W, _ = A0.shape

    if args.bg == "auto":
        B, bg_region = detect_bg(A0)
    else:
        B = np.array([float(v) for v in args.bg.split(",")], dtype=np.float32)
        bg_region = None
    Bf = bg_field(A0, B, bg_region)
    if args.report:
        print(f"image {W}x{H} | bg=({B[0]:.0f},{B[1]:.0f},{B[2]:.0f})")

    Aeff = A0.copy()
    paint = np.zeros(A0.shape[:2], bool)
    if args.paint:
        paint = paint_mask(A0, Bf, B, args.paint)
        Aeff[paint] = Bf[paint]

    from rembg import new_session

    sess = new_session(args.model)
    pred = sess.predict(Image.fromarray(Aeff.astype(np.uint8)))
    a = np.asarray(pred[0], dtype=np.float32)
    a = a / 255.0 if a.max() > 1.5 else a
    a = a.copy()

    if not args.no_key:
        a, nkey = key_out_background(a, Aeff, Bf, B, args.key_tol, args.key_floor,
                                     args.key_span, force_bg=paint)
        if args.report:
            print(f"colour key: {nkey} px")
    if not args.no_holefix:
        a, nhole = key_holes(a, Aeff, Bf, args.key_floor, args.key_span)
        if args.report:
            print(f"enclosed holes keyed: {nhole} px")

    a, kept, dropped_px = drop_specks(a, args.min_speck)
    main, others = component_info(a, max(800, args.min_speck * 4))
    if args.report and others:
        print(f"detached components kept by the model ({len(others)}):")
        for o in others[:12]:
            print(f"  area={o['area']:6d} box={o['box']}")
        print("  -> remove them with --drop-remote AREA if they are background decoration")
    if args.drop_remote:
        a, removed = drop_remote(a, args.drop_remote)
        if args.report:
            print(f"dropped {len(removed)} detached components")

    lo, span = (float(v) for v in args.contrast.split(","))
    af = np.clip((a - lo) / span, 0.0, 1.0)
    af = np.where(a > 0.985, 1.0, af)

    rgb = Aeff.copy()
    if not args.no_decontam:
        w = np.clip((af - 0.12) / 0.38, 0.0, 1.0)[..., None]
        F = (Aeff - (1.0 - af[..., None]) * Bf) / np.maximum(af[..., None], 0.08)
        rgb = w * np.clip(F, 0, 255) + (1.0 - w) * Aeff
    # bleed: give transparent pixels the nearest visible colour so scaling/filtering
    # does not pull stale background colour into the edges
    core = af > 0.5
    if core.any():
        _, idx = ndi.distance_transform_edt(~core, return_indices=True)
        rgb = np.where((af < 0.5)[..., None], rgb[idx[0], idx[1]], rgb)

    out = np.dstack([rgb.astype(np.uint8), (af * 255.0 + 0.5).astype(np.uint8)])
    img = Image.fromarray(out, "RGBA")
    if args.crop_tight:
        bbox = img.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
        if bbox:
            img = img.crop(bbox)
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst)
    if args.alpha_out:
        Image.fromarray((af * 255).astype(np.uint8)).save(args.alpha_out)
    if args.preview:
        yy, xx = np.mgrid[0:H, 0:W]
        c = (((yy // 24) + (xx // 24)) % 2).astype(np.float32)
        bgc = np.where(c[..., None] == 0, 205.0, 155.0).repeat(3, axis=2)
        comp = (rgb * af[..., None] + bgc * (1 - af[..., None])).clip(0, 255).astype(np.uint8)
        Image.fromarray(comp).save(args.preview)

    if args.report:
        print(f"soft edge px: {int(((af > 0.02) & (af < 0.98)).sum())} | "
              f"transparent: {(af < 0.02).mean() * 100:.1f}% | comps kept: {kept} | speck px: {dropped_px}")
    print(f"wrote {dst} {img.size[0]}x{img.size[1]} RGBA")
    return 0


if __name__ == "__main__":
    sys.exit(main())
