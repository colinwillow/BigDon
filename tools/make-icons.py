#!/usr/bin/env python3
"""Regenerate every app icon from icons/icon_original.png.

Run this after changing the icon art:

    python3 tools/make-icons.py        # needs Pillow: pip install pillow

Two things here are deliberate and easy to get wrong.

* APPLE ICONS ARE FULL-BLEED, with no rounded corners baked in. iOS applies its
  own squircle mask, so art that already has rounded corners shows those corners
  as dark notches inside Apple's mask. It also ignores the manifest entirely and
  reads the <link rel="apple-touch-icon"> tags, which is why those sizes exist
  separately from the PWA ones.

* MASKABLE ICONS NEED THEIR SUBJECT IN THE MIDDLE. Android crops a maskable
  icon to whatever shape the launcher likes — circle, squircle, teardrop — and
  only guarantees the middle 80%. This artwork is already composed for that:
  Big Don is centred and well inside the safe zone, and the background bleeds
  to every edge, so the maskable variants are the SAME full-bleed art. Scaling
  it down and padding the border was tried and looks worse — the pad reads as a
  mistake, a visible frame around the art, and the mask then cuts the pad
  rather than the picture.

* FAVICONS GET A TIGHTER CROP. The full picture is three characters; below
  about 48px that collapses into coloured mush. The 16/32/48 sizes therefore
  come from a head crop of the centre figure, which keeps a readable
  blonde-on-blue silhouette right down to 16px. Set FAVICON_CROP to None to
  use the full art at those sizes too.
"""

from PIL import Image
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"
SOURCE = ICONS / "icon_original.png"

# iOS home screen. Full bleed — see the note above.
APPLE = [180, 167, 152, 120]
# Browser tabs and bookmarks.
FAVICON = [16, 32, 48]
# PWA manifest, drawn as-is.
ANY = [192, 512]
# PWA manifest, drawn inside a launcher-chosen mask. Same full-bleed art —
# see the note above.
MASKABLE = [192, 512]

# Head crop for the small sizes, as (centre x, top y, side) in fractions of the
# source. Set to None to use the full picture everywhere.
FAVICON_CROP = (0.505, 0.11, 0.40)


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"missing {SOURCE} — that is the master the rest come from")
    master = Image.open(SOURCE).convert("RGB")
    if master.width != master.height:
        raise SystemExit(f"master must be square, got {master.size}")

    if FAVICON_CROP:
        cx, y0, frac = FAVICON_CROP
        side = int(master.width * frac)
        x = int(master.width * cx) - side // 2
        y = int(master.height * y0)
        small = master.crop((x, y, x + side, y + side))
    else:
        small = master

    written = []
    for s in APPLE:
        p = ICONS / f"apple-touch-icon-{s}.png"
        master.resize((s, s), Image.LANCZOS).save(p)
        written.append(p)

    for s in FAVICON:
        p = ICONS / f"favicon-{s}.png"
        small.resize((s, s), Image.LANCZOS).save(p)
        written.append(p)

    for s in ANY:
        p = ICONS / f"icon-{s}.png"
        master.resize((s, s), Image.LANCZOS).save(p)
        written.append(p)

    for s in MASKABLE:
        p = ICONS / f"icon-maskable-{s}.png"
        master.resize((s, s), Image.LANCZOS).save(p)
        written.append(p)

    for p in written:
        print(f"  {p.relative_to(ROOT)}  {p.stat().st_size / 1024:.1f} KB")
    print(f"{len(written)} icons written")


if __name__ == "__main__":
    main()
