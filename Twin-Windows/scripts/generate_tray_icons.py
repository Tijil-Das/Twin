"""
Generates high-contrast, enlarged 32x32 system tray PNG icons directly from
the authentic multi-resolution ICO assets in Icon-Pack.

The circle fills 30px of the 32x32 canvas (1px margin) so the icon appears
large, sharp, and clearly visible in the Windows 11 taskbar notification area.
"""
import os, struct, io
from PIL import Image

def get_largest_frame_from_ico(ico_path):
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

def make_enlarged_tray_icon(im_source, target_sz=32, target_diameter=30):
    bbox = im_source.getbbox()
    circle_crop = im_source.crop(bbox)
    circle_resized = circle_crop.resize((target_diameter, target_diameter), Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA', (target_sz, target_sz), (0, 0, 0, 0))
    offset = (target_sz - target_diameter) // 2
    canvas.paste(circle_resized, (offset, offset), circle_resized)
    return canvas

def main():
    repo_root = r'T:\Coding\Twin'
    icon_pack = os.path.join(repo_root, 'Icon-Pack')
    tauri_tray = os.path.join(repo_root, 'Twin-Windows', 'src-tauri', 'icons', 'tray')
    icon_pack_tray = os.path.join(icon_pack, 'Tray')

    os.makedirs(tauri_tray, exist_ok=True)
    os.makedirs(icon_pack_tray, exist_ok=True)

    items = [
        ('idle', 'tray_idle.ico'),
        ('syncing', 'tray_syncing.ico'),
        ('paused', 'tray_paused.ico'),
        ('error', 'tray_error.ico'),
    ]

    for name, ico_name in items:
        ico_path = os.path.join(icon_pack, ico_name)
        if not os.path.exists(ico_path):
            print(f'Warning: {ico_path} not found')
            continue
        large_frame = get_largest_frame_from_ico(ico_path)
        tray_png = make_enlarged_tray_icon(large_frame, target_sz=32, target_diameter=32)

        # 1. Twin-Windows/src-tauri/icons/tray/{name}.png
        out1 = os.path.join(tauri_tray, f'{name}.png')
        tray_png.save(out1, format='PNG')
        print(f'Saved {out1}')

        # 2. Icon-Pack/Tray/{name}.png
        out2 = os.path.join(icon_pack_tray, f'{name}.png')
        tray_png.save(out2, format='PNG')
        print(f'Saved {out2}')

        # 3. Icon-Pack/tray_{name}.png
        out3 = os.path.join(icon_pack, f'tray_{name}.png')
        tray_png.save(out3, format='PNG')
        print(f'Saved {out3}')

    # Generate properly proportioned overlay icons (~52% diameter) for Windows Explorer
    import generate_overlay_icons
    generate_overlay_icons.main()

if __name__ == '__main__':
    main()
