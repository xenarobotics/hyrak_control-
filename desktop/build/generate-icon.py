#!/usr/bin/env python3
"""
Regenerates build/icon-master.png from the brand source art. Run this after
the mark in frontend/public/brand/icon.png changes, then re-run icon-gen to
refresh icon.ico/icon.icns/icon.png:

    python3 build/generate-icon.py
    node -e "require('icon-gen')('build/icon-master.png', 'build', { \
        ico: { name: 'icon', sizes: [16,24,32,48,64,128,256] }, \
        icns: { name: 'icon', sizes: [16,32,64,128,256,512,1024] }, \
        favicon: false })"
    python3 -c "from PIL import Image; \
        Image.open('build/icon-master.png').resize((512,512)).save('build/icon.png')"

icon.png is already a clean transparent PNG (confirmed via its alpha
channel, not just how it LOOKS when previewed on a white canvas) — no
chroma-keying needed, just composite it onto the app's dark chrome color.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent.parent
SRC = ROOT / "frontend" / "public" / "brand" / "icon.png"
OUT = Path(__file__).resolve().parent / "icon-master.png"

CANVAS = 1024
BG = (10, 10, 12, 255)  # matches desktop/src/main.ts's window backgroundColor #0a0a0c
MARK_SCALE = 0.62        # fraction of canvas the mark occupies, centered


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    canvas = Image.new("RGBA", (CANVAS, CANVAS), BG)
    target = int(CANVAS * MARK_SCALE)
    mark = src.resize((target, target), Image.LANCZOS)
    offset = ((CANVAS - target) // 2, (CANVAS - target) // 2)
    canvas.paste(mark, offset, mark)
    canvas.save(OUT)
    print(f"saved {OUT} ({canvas.size[0]}x{canvas.size[1]})")


if __name__ == "__main__":
    main()
