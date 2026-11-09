"""
Generates multi-resolution Windows File Explorer overlay icons for Twin.

Supported placements matching user reference specifications:
- top_right: shifted towards upper-right (Image 1)
- bottom_right: shifted towards bottom-right (Image 2)
- centered: centered on the badge canvas (Image 3)

Badge radius r = 0.27 * sz produces a 30% diameter badge relative to the folder icon,
accurately matching the reference proportions.
"""
import os
from PIL import Image, ImageDraw

def render_badge(sz: int, placement: str, kind: str) -> Image.Image:
    scale = 4
    s = sz * scale
    r = s * 0.27

    if placement == "top_right":
        cx = s * 0.62
        cy = s * 0.38
    elif placement == "bottom_right":
        cx = s * 0.62
        cy = s * 0.62
    elif placement == "centered":
        cx = s * 0.50
        cy = s * 0.50
    else:
        cx = s * 0.50
        cy = s * 0.50

    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    bbox = [cx - r, cy - r, cx + r, cy + r]

    if kind == "synced":
        green_fill = (34, 197, 94, 255)     # #22c55e (emerald green)
        green_outline = (21, 128, 61, 255)  # #15803d (dark green border for contrast)
        outline_w = max(1, int(round(0.10 * r)))
        draw.ellipse(bbox, fill=green_fill, outline=green_outline, width=outline_w)

        # Crisp, high-contrast white checkmark
        p1 = (cx - r * 0.50, cy + r * 0.05)
        p2 = (cx - r * 0.16, cy + r * 0.38)
        p3 = (cx + r * 0.50, cy - r * 0.34)
        tick_w = max(1, int(round(0.26 * r)))
        draw.line([p1, p2, p3], fill=(255, 255, 255, 255), width=tick_w, joint="curve")

        # Smooth rounded end caps
        cap_r = tick_w / 2.0
        for pt in [p1, p3]:
            draw.ellipse(
                [pt[0] - cap_r, pt[1] - cap_r, pt[0] + cap_r, pt[1] + cap_r],
                fill=(255, 255, 255, 255),
            )
    elif kind == "syncing":
        yellow_fill = (250, 204, 21, 255)   # #facc15
        yellow_outline = (113, 63, 18, 255) # #713f12
        outline_w = max(1, int(round(0.12 * r)))
        draw.ellipse(bbox, fill=yellow_fill, outline=yellow_outline, width=outline_w)

        # Circular arrows for sync symbol
        arc_r = r * 0.54
        arc_bbox = [cx - arc_r, cy - arc_r, cx + arc_r, cy + arc_r]
        arc_w = max(1, int(round(0.22 * r)))
        draw.arc(arc_bbox, start=30, end=150, fill=(30, 41, 59, 255), width=arc_w)
        draw.arc(arc_bbox, start=210, end=330, fill=(30, 41, 59, 255), width=arc_w)

    return img.resize((sz, sz), Image.Resampling.LANCZOS)

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    out_dir_tauri = os.path.normpath(os.path.join(script_dir, "..", "src-tauri", "icons", "overlay"))
    out_dir_iconpack = os.path.normpath(os.path.join(script_dir, "..", "..", "Icon-Pack"))

    os.makedirs(out_dir_tauri, exist_ok=True)
    os.makedirs(out_dir_iconpack, exist_ok=True)

    sizes = [16, 20, 24, 32, 40, 48, 60, 64, 72, 80, 96, 120, 128, 144, 192, 256]
    size_tuples = [(sz, sz) for sz in sizes]

    for placement in ["top_right", "bottom_right", "centered"]:
        for kind in ["synced", "syncing"]:
            frames = {sz: render_badge(sz, placement, kind) for sz in sizes}
            largest = frames[256]
            others = [frames[sz] for sz in sizes if sz != 256]

            filenames = [f"{kind}_{placement}.ico"]
            # Default un-suffixed filename gets centered
            if placement == "centered":
                filenames.append(f"{kind}.ico")

            for fname in filenames:
                for target_dir in [out_dir_tauri, out_dir_iconpack]:
                    filepath = os.path.join(target_dir, fname)
                    largest.save(filepath, format="ICO", append_images=others, sizes=size_tuples)
                print(f"Generated {fname} ({len(sizes)} resolutions: {sizes[0]}px..{sizes[-1]}px)")

if __name__ == "__main__":
    main()
