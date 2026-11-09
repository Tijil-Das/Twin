"""
Generates multi-resolution Windows File Explorer shell icon overlays for Twin.

Standard Windows Shell (IShellIconOverlayIdentifier) overlays:
- synced: Emerald green circle with crisp white checkmark
- syncing: Solid yellow circle with dark outline, NO inner symbols

Icons are centered with a 20% transparent boundary padding so Windows Explorer's
shell overlay rendering engine draws them crisply in the lower-left slot without
clipping, blurring, or distortion.

Multi-resolution ICOs (16x16 up to 256x256) support all Explorer view modes and DPI scalings.
"""
import os
from PIL import Image, ImageDraw

def render_badge(sz: int, kind: str) -> Image.Image:
    scale = 4
    s = sz * scale
    r = s * 0.40
    cx = s * 0.50
    cy = s * 0.50

    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    bbox = [cx - r, cy - r, cx + r, cy + r]

    if kind == "synced":
        green_fill = (34, 197, 94, 255)     # #22c55e (emerald green)
        green_outline = (21, 128, 61, 255)  # #15803d (dark green border for contrast)
        outline_w = max(1, int(round(0.12 * r)))
        draw.ellipse(bbox, fill=green_fill, outline=green_outline, width=outline_w)

        # Crisp, high-contrast white checkmark
        p1 = (cx - r * 0.48, cy + r * 0.05)
        p2 = (cx - r * 0.14, cy + r * 0.38)
        p3 = (cx + r * 0.48, cy - r * 0.32)
        tick_w = max(1, int(round(0.24 * r)))
        draw.line([p1, p2, p3], fill=(255, 255, 255, 255), width=tick_w, joint="curve")

        # Smooth rounded end caps
        cap_r = tick_w / 2.0
        for pt in [p1, p3]:
            draw.ellipse(
                [pt[0] - cap_r, pt[1] - cap_r, pt[0] + cap_r, pt[1] + cap_r],
                fill=(255, 255, 255, 255),
            )
    elif kind == "syncing":
        # Solid yellow circle with dark outline, NO inner symbols
        yellow_fill = (250, 204, 21, 255)   # #facc15
        yellow_outline = (92, 38, 5, 255)   # #5c2605
        outline_w = max(1, int(round(0.14 * r)))
        draw.ellipse(bbox, fill=yellow_fill, outline=yellow_outline, width=outline_w)

    return img.resize((sz, sz), Image.Resampling.LANCZOS)

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    out_dir_tauri = os.path.normpath(os.path.join(script_dir, "..", "src-tauri", "icons", "overlay"))
    out_dir_iconpack = os.path.normpath(os.path.join(script_dir, "..", "..", "Icon-Pack"))

    os.makedirs(out_dir_tauri, exist_ok=True)
    os.makedirs(out_dir_iconpack, exist_ok=True)

    sizes = [16, 20, 24, 32, 40, 48, 60, 64, 72, 80, 96, 120, 128, 144, 192, 256]
    size_tuples = [(sz, sz) for sz in sizes]

    for kind in ["synced", "syncing"]:
        frames = {sz: render_badge(sz, kind) for sz in sizes}
        largest = frames[256]
        others = [frames[sz] for sz in sizes if sz != 256]

        filenames = [
            f"{kind}.ico",
            f"{kind}_centered.ico",
            f"{kind}_top_right.ico",
            f"{kind}_bottom_right.ico",
        ]

        for fname in filenames:
            for target_dir in [out_dir_tauri, out_dir_iconpack]:
                filepath = os.path.join(target_dir, fname)
                largest.save(filepath, format="ICO", append_images=others, sizes=size_tuples)
            print(f"Generated {fname} ({len(sizes)} resolutions: {sizes[0]}px..{sizes[-1]}px)")

if __name__ == "__main__":
    main()
