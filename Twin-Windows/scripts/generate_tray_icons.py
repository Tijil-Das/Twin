"""
Generates multi-resolution system tray status icons for Twin on Windows.
Matches the exact visual identity of the file explorer status badges:
- idle (synced): Windows green circle with crisp white checkmark tick
- syncing: Vibrant yellow circle with deep bronze contrast outline
- paused: Amber circle with dual white pause bars
- error: Red circle with crisp white dismissal cross
"""
import os
from PIL import Image, ImageDraw

def render_tray_icon(kind: str, sz: int = 32) -> Image.Image:
    scale = 8
    canvas_sz = sz * scale
    img = Image.new("RGBA", (canvas_sz, canvas_sz), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    scx = canvas_sz / 2.0
    scy = canvas_sz / 2.0
    # Diameter ~26px at 32x32 for ideal system tray padding
    sr = 13.0 * scale
    bbox = [scx - sr, scy - sr, scx + sr, scy + sr]

    if kind == "idle":
        # Green circle with white checkmark tick (exact match to folder overlay synced badge)
        green_fill = (34, 163, 56, 255)
        green_outline = (21, 128, 61, 255)
        outline_w = max(1, int(round(0.12 * sr)))
        draw.ellipse(bbox, fill=green_fill, outline=green_outline, width=outline_w)

        p1 = (scx - sr * 0.54, scy + sr * 0.08)
        p2 = (scx - sr * 0.22, scy + sr * 0.41)
        p3 = (scx + sr * 0.54, scy - sr * 0.35)
        tick_w = max(1, int(round(0.25 * sr)))
        draw.line([p1, p2, p3], fill=(255, 255, 255, 255), width=tick_w, joint="curve")

        cap_r = tick_w / 2.0
        for pt in [p1, p3]:
            draw.ellipse(
                [pt[0] - cap_r, pt[1] - cap_r, pt[0] + cap_r, pt[1] + cap_r],
                fill=(255, 255, 255, 255),
            )
    elif kind == "syncing":
        # Vibrant yellow circle with bronze rim (exact match to folder overlay syncing badge)
        yellow_fill = (250, 204, 21, 255)
        yellow_outline = (65, 25, 2, 255)
        outline_w = max(1, int(round(0.22 * sr)))
        draw.ellipse(bbox, fill=yellow_fill, outline=yellow_outline, width=outline_w)
    elif kind == "paused":
        # Amber circle with pause bars
        amber_fill = (245, 158, 11, 255)
        amber_outline = (180, 83, 9, 255)
        outline_w = max(1, int(round(0.14 * sr)))
        draw.ellipse(bbox, fill=amber_fill, outline=amber_outline, width=outline_w)

        bar_w = max(1, int(round(0.22 * sr)))
        bar_h = sr * 0.45
        for offset_x in [-sr * 0.26, sr * 0.26]:
            pt1 = (scx + offset_x, scy - bar_h)
            pt2 = (scx + offset_x, scy + bar_h)
            draw.line([pt1, pt2], fill=(255, 255, 255, 255), width=bar_w)
            cap_r = bar_w / 2.0
            for pt in [pt1, pt2]:
                draw.ellipse(
                    [pt[0] - cap_r, pt[1] - cap_r, pt[0] + cap_r, pt[1] + cap_r],
                    fill=(255, 255, 255, 255),
                )
    elif kind == "error":
        # Red circle with error cross
        red_fill = (239, 68, 68, 255)
        red_outline = (185, 28, 28, 255)
        outline_w = max(1, int(round(0.14 * sr)))
        draw.ellipse(bbox, fill=red_fill, outline=red_outline, width=outline_w)

        x_w = max(1, int(round(0.22 * sr)))
        d = sr * 0.40
        pts = [
            ((scx - d, scy - d), (scx + d, scy + d)),
            ((scx - d, scy + d), (scx + d, scy - d)),
        ]
        cap_r = x_w / 2.0
        for pt1, pt2 in pts:
            draw.line([pt1, pt2], fill=(255, 255, 255, 255), width=x_w)
            for pt in [pt1, pt2]:
                draw.ellipse(
                    [pt[0] - cap_r, pt[1] - cap_r, pt[0] + cap_r, pt[1] + cap_r],
                    fill=(255, 255, 255, 255),
                )
    else:
        raise ValueError(f"Unknown kind: {kind}")

    return img.resize((sz, sz), Image.Resampling.LANCZOS)

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    tray_dir_tauri = os.path.normpath(os.path.join(script_dir, "..", "src-tauri", "icons", "tray"))
    tray_dir_iconpack = os.path.normpath(os.path.join(script_dir, "..", "..", "Icon-Pack", "Tray"))
    root_iconpack = os.path.normpath(os.path.join(script_dir, "..", "..", "Icon-Pack"))

    os.makedirs(tray_dir_tauri, exist_ok=True)
    os.makedirs(tray_dir_iconpack, exist_ok=True)
    os.makedirs(root_iconpack, exist_ok=True)

    icons = ["idle", "syncing", "paused", "error"]
    for icon_name in icons:
        im = render_tray_icon(icon_name, sz=32)
        # 1. Tauri tray directory
        out_tauri = os.path.join(tray_dir_tauri, f"{icon_name}.png")
        im.save(out_tauri, format="PNG")
        print(f"Generated {out_tauri} (32x32)")

        # 2. Icon-Pack/Tray/ subdirectory
        out_iconpack_tray = os.path.join(tray_dir_iconpack, f"{icon_name}.png")
        im.save(out_iconpack_tray, format="PNG")
        print(f"Generated {out_iconpack_tray} (32x32)")

        # 3. Icon-Pack root (prefixed as tray_*.png)
        out_iconpack_root = os.path.join(root_iconpack, f"tray_{icon_name}.png")
        im.save(out_iconpack_root, format="PNG")
        print(f"Generated {out_iconpack_root} (32x32)")

if __name__ == "__main__":
    main()

