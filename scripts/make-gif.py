#!/usr/bin/env python3
"""Turns docs/img/demo.webm (from scripts/record-demo.js) into docs/img/demo.gif.

Frame extraction uses the ffmpeg that Playwright already downloaded
(`npx playwright install chromium`); GIF encoding uses Pillow
(`pip install pillow`). Nothing here is part of the extension itself.

    python3 scripts/make-gif.py [width] [fps]
"""
import glob
import os
import subprocess
import sys
import tempfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG = os.path.join(ROOT, "docs", "img")
WIDTH = int(sys.argv[1]) if len(sys.argv) > 1 else 960
FPS = int(sys.argv[2]) if len(sys.argv) > 2 else 8


def find_ffmpeg():
    pattern = os.path.expanduser("~/Library/Caches/ms-playwright/ffmpeg-*/ffmpeg-*")
    pattern_linux = os.path.expanduser("~/.cache/ms-playwright/ffmpeg-*/ffmpeg-*")
    hits = sorted(glob.glob(pattern) + glob.glob(pattern_linux))
    if not hits:
        sys.exit("ffmpeg not found - run: npx playwright install chromium")
    return hits[-1]


def main():
    trim = float(open(os.path.join(IMG, ".demo-trim")).read().strip())
    src = os.path.join(IMG, "demo.webm")
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(
            [find_ffmpeg(), "-v", "error", "-ss", str(trim), "-i", src, "-r", str(FPS),
             "-vf", f"scale={WIDTH}:-1", os.path.join(tmp, "f%04d.png")],
            check=True,
        )
        paths = sorted(glob.glob(os.path.join(tmp, "f*.png")))
        if not paths:
            sys.exit("no frames extracted")

        # One shared palette keeps colors stable between frames (no flicker).
        sample = [Image.open(p).convert("RGB") for p in paths[:: max(1, len(paths) // 24)]]
        sheet = Image.new("RGB", (sample[0].width, sum(i.height for i in sample)))
        y = 0
        for img in sample:
            sheet.paste(img, (0, y))
            y += img.height
        palette = sheet.quantize(colors=64, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)

        frames, durations = [], []
        last_bytes = None
        for p in paths:
            q = Image.open(p).convert("RGB").quantize(palette=palette, dither=Image.Dither.NONE)
            b = q.tobytes()
            if b == last_bytes:  # still frame: extend the previous one instead of storing a copy
                durations[-1] += 1000 // FPS
                continue
            frames.append(q)
            durations.append(1000 // FPS)
            last_bytes = b
        durations[-1] += 1500  # linger on the last frame before looping

        out = os.path.join(IMG, "demo.gif")
        frames[0].save(out, save_all=True, append_images=frames[1:], duration=durations,
                       loop=0, optimize=True, disposal=1)
        print(f"wrote docs/img/demo.gif: {len(paths)} frames -> {len(frames)} stored, "
              f"{os.path.getsize(out) / 1e6:.1f} MB, {sum(durations) / 1000:.1f}s")


if __name__ == "__main__":
    main()
