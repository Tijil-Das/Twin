"""
Generates multi-resolution Windows File Explorer overlay icons for Twin.
Supports all 3 placement configurations:
- top_right (rests on the top-right shoulder of Windows folder icon, matching user specs)
- bottom_right (hangs on the bottom-right corner of the folder body)
- centered (sits in the middle of the folder body)

Each generated .ico file contains 7 native resolutions:
16x16, 24x24, 32x32, 48x48, 64x64, 128x128, 256x256
ensuring pin-sharp rendering at all Windows Explorer view modes (Details, List, Tiles, Medium, Large, Extra Large).
"""
import os
from PIL import Image, ImageDraw

def render_frame(canvas_size: int, placement: str, kind: str) -> Image.Image:
    # Scale up for high-precision anti-aliased geometry
    scale = 4
    s = canvas_size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Adaptive diameter for icon size legibility
    if canvas_size <= 16:
        d = 0.35 * s
    elif canvas_size <= 24:
        d = 0.30 * s
    elif canvas_size <= 32:
        d = 0.28 * s
    else:
        d = 0.260 * s
    r = d / 2.0

    if placement == "top_right":
        # Top-right shoulder of Windows folder body
        cx = 0.846 * s
        cy = 0.248 * s
    elif placement == "bottom_right":
        # Bottom-right corner of Windows folder body
        cx = 0.846 * s
        cy = 0.740 * s
    elif placement == "centered":
        # Center of Windows folder body
        cx = 0.500 * s
        cy = 0.525 * s
    else:
        raise ValueError(f"Unknown placement: {placement}")

    # Boundary safety clamp
    cx = min(cx, s - r - 1)
    cy = min(cy, s - r - 1)
    cx = max(cx, r + 1)
    cy = max(cy, r + 1)

    bbox = [cx - r, cy - r, cx + r, cy + r]

    if kind == "synced":
        # Green tick badge
        green_fill = (34, 163, 56, 255) # vibrant green matching user spec
        green_outline = (16, 95, 30, 255) # dark green contrast outline
        outline_w = max(1, int(round(1.2 * scale * (canvas_size / 256.0))))

        draw.ellipse(bbox, fill=green_fill, outline=green_outline, width=outline_w)

        # Crisp white checkmark
        p1 = (cx - r * 0.42, cy - r * 0.04)
        p2 = (cx - r * 0.10, cy + r * 0.32)
        p3 = (cx + r * 0.46, cy - r * 0.35)

        if canvas_size <= 16:
            stroke_w = max(1, int(round(1.5 * scale)))
        elif canvas_size <= 24:
            stroke_w = max(1, int(round(1.8 * scale)))
        elif canvas_size <= 32:
            stroke_w = max(2, int(round(2.2 * scale)))
        else:
            stroke_w = max(2, int(round(8.5 * scale * (canvas_size / 256.0))))

        draw.line([p1, p2, p3], fill=(255, 255, 255, 255), width=stroke_w, joint="curve")

    elif kind == "syncing":
        # Yellow dot badge with deep dark-amber/bronze outline for high contrast against yellow folder
        yellow_fill = (250, 204, 21, 255) # vibrant yellow/amber
        yellow_outline = (75, 30, 4, 255) # deep dark bronze/amber rim for strong contrast
        outline_w = max(1, int(round(2.6 * scale * (canvas_size / 256.0))))

        draw.ellipse(bbox, fill=yellow_fill, outline=yellow_outline, width=outline_w)

    return img.resize((canvas_size, canvas_size), Image.Resampling.LANCZOS)

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    out_dir_tauri = os.path.normpath(os.path.join(script_dir, "..", "src-tauri", "icons", "overlay"))
    out_dir_iconpack = os.path.normpath(os.path.join(script_dir, "..", "..", "Icon-Pack"))
    
    os.makedirs(out_dir_tauri, exist_ok=True)
    os.makedirs(out_dir_iconpack, exist_ok=True)

    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

    for placement in ["top_right", "bottom_right", "centered"]:
        for kind in ["synced", "syncing"]:
            frames = {sz: render_frame(sz[0], placement, kind) for sz in sizes}
            largest = frames[(256, 256)]
            others = [frames[sz] for sz in sizes if sz != (256, 256)]

            filename = f"{kind}_{placement}.ico"
            for target_dir in [out_dir_tauri, out_dir_iconpack]:
                filepath = os.path.join(target_dir, filename)
                largest.save(filepath, format="ICO", append_images=others, sizes=sizes)
            print(f"Generated {filename} (saved to src-tauri/icons/overlay and Icon-Pack)")

if __name__ == "__main__":
    main()
