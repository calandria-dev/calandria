#!/usr/bin/env python3
"""Regenerates desktop/assets/*.png. Run by hand:  python3 scripts/make-assets.py

The PNGs are committed, so a clean checkout — and every CI lane — needs neither
ImageMagick nor a font. This exists so the next person can change the mark
without reverse-engineering a binary.

The mark is the app's own icon reduced to its single foreground rod + resting
ellipse (docs/design/handoff/assets/favicon-small.svg): the full ten-rod logo
turns to mush at 16 px, which is the size a tray actually gets. Drawn from
primitives rather than rasterized from the SVG because ImageMagick 6 has no
rsvg delegate on most boxes and its own SVG renderer is not reproducible —
these coordinates ARE the SVG's, transposed into a square.

Requires ImageMagick 6 (`convert`) and DejaVu Sans Bold.
"""
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "assets"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
TEAL = "#45cabb"
BADGE_BG = "#e5484d"
# Supersample, then Lanczos down: at 16 px the rod's rounded cap and the
# ellipse's 0.55-unit stroke are sub-pixel, and ImageMagick's own antialiasing
# alone leaves both ragged.
SS = 8


def mark(size: int, colour: str, out: pathlib.Path) -> None:
    """The tray mark: one rounded rod standing in its resting ellipse."""
    s = size * SS
    # favicon-small.svg's viewBox is 4.05 x 14.23 and a tray icon is square, so
    # the content is centred in a 14.23-unit square (x offset 5.09) with 5%
    # padding — menu bars and system trays clip to their own inset otherwise.
    pad = 0.05
    k = s * (1 - 2 * pad) / 14.23
    o = pad * s
    p = lambda v: round(o + v * k, 2)  # noqa: E731
    rod = f"roundrectangle {p(6.06)},{p(0)} {p(8.16)},{p(13.0)} {p(1.05)},{p(1.05)}"
    dish = f"ellipse {p(7.11)},{p(13.0)} {p(1.75)},{p(0.95)} 0,360"
    subprocess.run(
        ["convert", "-size", f"{s}x{s}", "xc:none",
         "-fill", colour, "-stroke", "none", "-draw", rod,
         "-fill", "none", "-stroke", colour, "-strokewidth", str(round(0.55 * k, 2)),
         "-draw", f"stroke-opacity 0.7 {dish}",
         "-filter", "Lanczos", "-resize", f"{size}x{size}", f"PNG32:{out}"],
        check=True,
    )


def badge(label: str, out: pathlib.Path) -> None:
    """A Windows taskbar overlay: a filled disc carrying one glyph group."""
    s = 16 * SS
    subprocess.run(
        ["convert", "-size", f"{s}x{s}", "xc:none",
         "-fill", BADGE_BG, "-stroke", "none", "-draw", f"circle {s//2},{s//2} {s//2},4",
         "-font", FONT, "-pointsize", str(84 if len(label) == 1 else 58),
         "-fill", "white", "-gravity", "center", "-annotate", "+0+0", label,
         "-filter", "Lanczos", "-resize", "16x16", f"PNG32:{out}"],
        check=True,
    )


def main() -> int:
    OUT.mkdir(exist_ok=True)
    # macOS menu bar: a template image is pure black + alpha and AppKit inverts
    # it for the dark menu bar and the selected state. The "Template" suffix is
    # what makes Electron mark it as one; the @2x file is picked up by name.
    mark(16, "black", OUT / "trayTemplate.png")
    mark(32, "black", OUT / "trayTemplate@2x.png")
    # Windows and Linux draw the tray icon as-is, so it carries the brand colour.
    mark(32, TEAL, OUT / "tray.png")
    # Windows has no numeric badge API — the taskbar overlay is a 16x16 image —
    # so the digits are pre-rendered. Ten ~500-byte files, against shipping a
    # PNG encoder and a bitmap font inside main.js to draw them at runtime.
    for n in range(1, 10):
        badge(str(n), OUT / f"badge-{n}.png")
    badge("9+", OUT / "badge-9plus.png")
    print(f"wrote {len(list(OUT.glob('*.png')))} files to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
