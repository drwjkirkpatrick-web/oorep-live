#!/usr/bin/env python3
"""Generate OORep Live app icons (icns + png set) from a vector-ish source drawn with PIL."""
import os, struct
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build", "icons")
ICNS = os.path.join(ROOT, "build")
os.makedirs(BUILD, exist_ok=True)

BG = (16, 22, 33, 255)        # deep navy
GRAD_TOP = (26, 118, 210)     # ocean blue
GRAD_BOT = (13, 59, 102)
ACCENT = (94, 234, 212)       # teal
WHITE = (237, 242, 247)

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)

def draw_base(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # rounded-square macOS-style plate
    r = int(size * 0.225)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=BG)
    # vertical gradient overlay
    grad = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        gd.line([(int(size*0.08), y), (size - int(size*0.08), y)], fill=lerp(GRAD_TOP, GRAD_BOT, y / size))
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    s = size
    # live pulse trace (ECG-like) — the "live data" motif
    pts = []
    import math
    for i in range(60):
        x = s * 0.14 + (s * 0.72) * i / 59
        t = i / 59
        y = s * 0.58
        if 0.42 < t < 0.50:
            y -= math.sin((t - 0.42) / 0.08 * math.pi) * s * 0.16
        elif 0.50 <= t < 0.58:
            y += math.sin((t - 0.50) / 0.08 * math.pi) * s * 0.10
        elif 0.24 < t < 0.30:
            y -= math.sin((t - 0.24) / 0.06 * math.pi) * s * 0.045
        pts.append((x, y))
    lw = max(2, int(s * 0.035))
    d.line(pts, fill=ACCENT, width=lw, joint="curve")
    # pulse dot
    dot_r = max(3, int(s * 0.035))
    d.ellipse([pts[-1][0] - dot_r, pts[-1][1] - dot_r, pts[-1][0] + dot_r, pts[-1][1] + dot_r], fill=ACCENT)
    # "OORep" text on larger sizes
    if s >= 128:
        try:
            from PIL import ImageFont
            f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", int(s * 0.13))
            tb = d.textbbox((0, 0), "OORep", font=f)
            tw, th = tb[2] - tb[0], tb[3] - tb[1]
            d.text(((s - tw) / 2 - tb[0], s * 0.72 - th / 2 - tb[1]), "OORep", font=f, fill=WHITE)
        except Exception:
            pass
    return img

sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
pngs = []
for sz in sizes:
    p = os.path.join(BUILD, f"{sz}.png")
    draw_base(sz).save(p)
    pngs.append((sz, p))
    print("wrote", p)

# Linux hicolor layout
for sz in [16, 24, 32, 48, 64, 128, 256, 512]:
    d = os.path.join(BUILD, f"{sz}x{sz}")
    os.makedirs(d, exist_ok=True)
    import shutil
    shutil.copy(os.path.join(BUILD, f"{sz}.png"), os.path.join(d, "oorep-live.png"))

# .icns (macOS): modern ic04/ic10 ARGB or classic PNG types
def icns_entry(typ, data):
    return struct.pack(">4sI", typ.encode("ascii"), 8 + len(data)) + data

entries = b""
mapping = {16: "is32", 32: "il32", 128: "ic13", 256: "ic14", 512: "ic11"}  # placeholder legacy unused
# Use PNG-based types (10.7+)
png_types = {16: "icp4", 32: "icp5", 64: "icp6", 128: "ic07", 256: "ic08", 512: "ic09", 1024: "ic10"}
for sz in sizes:
    if sz in png_types:
        with open(os.path.join(BUILD, f"{sz}.png"), "rb") as f:
            entries += icns_entry(png_types[sz], f.read())
icns_path = os.path.join(ICNS, "icon.icns")
with open(icns_path, "wb") as f:
    f.write(struct.pack(">4sI", b"icns", 8 + len(entries)) + entries)
print("wrote", icns_path, os.path.getsize(icns_path), "bytes")
