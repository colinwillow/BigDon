#!/usr/bin/env python3
"""Regenerate every app icon from icons/icon-source-1024.png.

Run this after changing the icon art:

    python3 tools/make-icons.py        # needs Pillow: pip install pillow

Two things here are deliberate and easy to get wrong.

* APPLE ICONS ARE FULL-BLEED, with no rounded corners baked in. iOS applies its
  own squircle mask, so art that already has rounded corners shows those corners
  as dark notches inside Apple's mask. It also ignores the manifest entirely and
  reads the <link rel="apple-touch-icon"> tags, which is why those sizes exist
  separately from the PWA ones.

* MASKABLE ICONS NEED A SAFE ZONE. Android crops a maskable icon to whatever
  shape the launcher likes — circle, squircle, teardrop — and only the middle
  80% is guaranteed visible. So the maskable variants scale the art down inside
  a full-bleed background instead of being edge-to-edge, or Big Don loses his
  hair to a circular mask.
"""

from PIL import Image
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"
SOURCE = ICONS / "icon-source-1024.png"

# Sampled from the artwork, so the padding on a maskable icon is invisible.
BG = (7, 146, 201)

# iOS home screen. Full bleed — see the note above.
APPLE = [180, 167, 152, 120]
# Browser tabs and bookmarks.
FAVICON = [16, 32, 48]
# PWA manifest, drawn as-is.
ANY = [192, 512]
# PWA manifest, drawn inside a launcher-chosen mask.
MASKABLE = [192, 512]
# Fraction of the maskable icon the art may occupy: Android guarantees the
# central 80%, and a little under that leaves room for aggressive masks.
SAFE = 0.78


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"missing {SOURCE} — that is the master the rest come from")
    master = Image.open(SOURCE).convert("RGB")
    if master.width != master.height:
        raise SystemExit(f"master must be square, got {master.size}")

    written = []
    for s in APPLE:
        p = ICONS / f"apple-touch-icon-{s}.png"
        master.resize((s, s), Image.LANCZOS).save(p)
        written.append(p)

    for s in FAVICON:
        p = ICONS / f"favicon-{s}.png"
        master.resize((s, s), Image.LANCZOS).save(p)
        written.append(p)

    for s in ANY:
        p = ICONS / f"icon-{s}.png"
        master.resize((s, s), Image.LANCZOS).save(p)
        written.append(p)

    for s in MASKABLE:
        canvas = Image.new("RGB", (s, s), BG)
        inner = int(round(s * SAFE))
        art = master.resize((inner, inner), Image.LANCZOS)
        off = (s - inner) // 2
        canvas.paste(art, (off, off))
        p = ICONS / f"icon-maskable-{s}.png"
        canvas.save(p)
        written.append(p)

    for p in written:
        print(f"  {p.relative_to(ROOT)}  {p.stat().st_size / 1024:.1f} KB")
    print(f"{len(written)} icons written")


if __name__ == "__main__":
    main()
