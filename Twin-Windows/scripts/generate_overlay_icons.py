"""
Generates multi-resolution Windows File Explorer shell icon overlays for Twin.
Supports all 3 user-selected placement options:
- top_right: upper-right shoulder of Windows folder body (Image 1)
- bottom_right: bottom-right corner of Windows folder body (Image 2)
- centered: center of Windows folder body (Image 3)

Badge types:
- synced: Emerald green circle with crisp white checkmark
- syncing: Solid yellow circle with dark outline, NO inner symbols

ICOs are multi-resolution (16x16 up to 256x256) for crisp rendering at all Windows Explorer view modes and DPI scalings.
"""
import os
from PIL import Image, ImageDraw

def render_badge(sz: int, placement: str, kind: str) -> Image.Image:
    scale = 4
    s = sz * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Adaptive radius: 30% diameter relative to folder width at large sizes,
    # with slightly enlarged radius at small icon sizes (16-48px) for legibility.
    if sz <= 16:
        r = 3.2 * scale
    elif sz <= 24:
        r = 4.2 * scale
    elif sz <= 32:
        r = 5.2 * scale
    elif sz <= 48:
        r = 7.2 * scale
    elif sz <= 64:
        r = 9.2 * scale
    else:
        r = 0.137 * s

    # Exact folder body coordinate mappings (verified against Windows 11 system folder bounds):
    # Folder bounds: X=0.062..0.934 (w=0.875), Y=0.133..0.816 (h=0.684)
    if placement == "top_right":
        cx = 0.841 * s
        cy = 0.250 * s
    elif placement == "bottom_right":
        cx = 0.841 * s
        cy = 0.779 * s
    elif placement == "centered":
        cx = 0.500 * s
        cy = 0.518 * s
    else:
        cx = 0.500 * s
        cy = 0.518 * s

    # Safety clamp inside icon canvas
    cx = max(r + 1, min(s - r - 1, cx))
    cy = max(r + 1, min(s - r - 1, cy))

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
