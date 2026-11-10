"""
Generates multi-resolution Windows File Explorer shell icon overlays for Twin
directly from authentic Icon-Pack assets with standard Windows overlay badge proportions (~52% diameter):
- synced.ico  <- derived from Icon-Pack/tray_idle.ico
- syncing.ico <- derived from Icon-Pack/tray_syncing.ico
"""
import io
import os
import struct
from PIL import Image

def get_highest_res_image(ico_path: str) -> Image.Image:
    with open(ico_path, 'rb') as f:
        data = f.read()
    count = struct.unpack('<H', data[4:6])[0]
    best_img = None
    best_w = 0
    for i in range(count):
        w, h, sz, off = struct.unpack('<BBII', data[6+i*16:6+i*16+2] + data[6+i*16+8:6+i*16+16])
        w = 256 if w == 0 else w
        if w > best_w:
            best_w = w
            best_img = Image.open(io.BytesIO(data[off:off+sz])).convert('RGBA')
    return best_img

def build_overlay_ico(circle_img: Image.Image, out_paths: list[str], ratio: float = 0.52, y_shift_ratio: float = 0.08):
    sizes = [16, 20, 24, 32, 40, 48, 60, 64, 72, 80, 96, 120, 128, 144, 192, 256]
    frames = {}
    for sz in sizes:
        diam = max(8, int(round(sz * ratio)))
        resized = circle_img.resize((diam, diam), Image.Resampling.LANCZOS)
        canvas = Image.new('RGBA', (sz, sz), (0, 0, 0, 0))
        offset_x = (sz - diam) // 2
        # Center horizontally, shift down slightly (~8% of canvas) for ideal bottom-left folder placement
        offset_y = min(sz - diam, (sz - diam) // 2 + max(1, int(round(sz * y_shift_ratio))))
        canvas.paste(resized, (offset_x, offset_y), resized)
        frames[sz] = canvas

    size_tuples = [(sz, sz) for sz in sizes]
    largest = frames[256]
    others = [frames[sz] for sz in sizes if sz != 256]
    for p in out_paths:
        largest.save(p, format='ICO', append_images=others, sizes=size_tuples)
        print(f"Generated {p} ({len(sizes)} resolutions: {sizes[0]}px..{sizes[-1]}px, badge={int(ratio*100)}%, y_shift=+{int(y_shift_ratio*100)}%)")

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.normpath(os.path.join(script_dir, "..", ".."))
    icon_pack = os.path.join(repo_root, "Icon-Pack")
    out_dir_tauri = os.path.join(repo_root, "Twin-Windows", "src-tauri", "icons", "overlay")

    os.makedirs(out_dir_tauri, exist_ok=True)
    os.makedirs(icon_pack, exist_ok=True)

    src_idle = os.path.join(icon_pack, "tray_idle.ico")
    if os.path.exists(src_idle):
        idle_master = get_highest_res_image(src_idle)
        idle_circle = idle_master.crop(idle_master.getbbox())
        build_overlay_ico(
            idle_circle,
            [os.path.join(icon_pack, "synced.ico"), os.path.join(out_dir_tauri, "synced.ico")],
            ratio=0.52,
        )

    src_syncing = os.path.join(icon_pack, "tray_syncing.ico")
    if os.path.exists(src_syncing):
        syncing_master = get_highest_res_image(src_syncing)
        syncing_circle = syncing_master.crop(syncing_master.getbbox())
        build_overlay_ico(
            syncing_circle,
            [os.path.join(icon_pack, "syncing.ico"), os.path.join(out_dir_tauri, "syncing.ico")],
            ratio=0.52,
        )

if __name__ == "__main__":
    main()
