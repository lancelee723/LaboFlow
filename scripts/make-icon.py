#!/usr/bin/env python3
"""Derive LaboFlow platform icon resources from the canonical logo.

The tracked ``apps/desktop/build/icon_1024.png`` file is the brand source of
truth. This script preserves that file and emits:

  apps/desktop/build/icon.iconset/  - all macOS iconset sizes
  apps/desktop/build/icon.icns      - via `iconutil` (macOS only)
  apps/desktop/build/icon.ico       - multi-size Windows application icon
  apps/desktop/build/icon.png       - 512px Windows/Linux package icon
  apps/desktop/build/tray-icon-mac.png - transparent macOS template icon

Run: python3 scripts/make-icon.py
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "apps" / "desktop" / "build"
SOURCE = BUILD / "icon_1024.png"

BASE = 1024


def main() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(f"canonical logo is missing: {SOURCE}")

    with Image.open(SOURCE) as source:
        master = source.convert("RGBA")
    if master.size != (BASE, BASE):
        raise ValueError(
            f"canonical logo must be {BASE}x{BASE}, got {master.width}x{master.height}"
        )

    BUILD.mkdir(parents=True, exist_ok=True)
    # Bake the system-style corner mask into the packaged artwork. macOS 26
    # applies its automatic squircle only to Icon Composer's .icon format; a
    # legacy .icns is displayed as-is, so a full-bleed canvas shipped as the
    # bundle icon rendered square in Dock and Finder (observed on 26.x).
    # Every packaged asset therefore derives from the masked canvas; the
    # full-bleed icon_1024.png stays the brand source and keeps feeding the
    # tray template derivation below.
    SS = 4
    mask_big = Image.new("L", (BASE * SS, BASE * SS), 0)
    mask_draw = ImageDraw.Draw(mask_big)
    mask_draw.rounded_rectangle(
        (0, 0, BASE * SS - 1, BASE * SS - 1), radius=230 * SS, fill=255
    )
    mask = mask_big.resize((BASE, BASE), Image.LANCZOS)
    rounded = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    rounded.paste(master, (0, 0), mask)

    windows_icon = BUILD / "icon.ico"
    rounded.save(
        windows_icon,
        format="ICO",
        sizes=[
            (16, 16),
            (32, 32),
            (48, 48),
            (64, 64),
            (128, 128),
            (256, 256),
        ],
    )
    package_icon = BUILD / "icon.png"
    rounded.resize((512, 512), Image.LANCZOS).save(package_icon)

    # Development dock icon: the same masked canvas. macOS does not mask
    # images handed to app.dock.setIcon either, so dev needs the baked
    # corners just as much as the packaged bundle does.
    dev_dock_path = BUILD / "icon-dev-dock.png"
    rounded.save(dev_dock_path)

    # macOS menu bar icons are template images: the opaque pixels are tinted
    # by the system. The application icon has an opaque light tile, so using
    # it directly would turn that tile into the tray silhouette. Derive the
    # dark PI mark as a transparent, monochrome image instead.
    tray_icon = master.convert("L")
    tray_alpha = ImageChops.multiply(
        tray_icon.point(
            lambda luminance: max(0, min(255, (160 - luminance) * 255 // 80))
        ),
        master.getchannel("A"),
    )
    # The source artwork also contains a soft outline around its light app
    # tile. Keep the known LaboFlow logo area so that outline cannot leak into
    # the menu bar template silhouette. The rectangle matches the logo bounds
    # in the tracked icon_1024.png (25px tile margins, bbox (125,279)-(898,745)).
    mark_clip = Image.new("L", master.size, 0)
    mark_draw = ImageDraw.Draw(mark_clip)
    mark_draw.rectangle((125, 279, 898, 745), fill=255)
    tray_alpha = ImageChops.multiply(tray_alpha, mark_clip)
    tray_icon_mac = Image.new("RGBA", master.size, (0, 0, 0, 0))
    tray_icon_mac.putalpha(tray_alpha)
    mark_bounds = tray_alpha.getbbox()
    if mark_bounds is None:
        raise ValueError("canonical logo does not contain a dark PI mark")
    mark = tray_icon_mac.crop(mark_bounds).resize((768, 768), Image.LANCZOS)
    tray_icon_mac = Image.new("RGBA", master.size, (0, 0, 0, 0))
    tray_icon_mac.paste(mark, (128, 128), mark)
    tray_icon_mac_path = BUILD / "tray-icon-mac.png"
    tray_icon_mac.save(tray_icon_mac_path)

    iconset = BUILD / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()
    sizes = [16, 32, 128, 256, 512]
    for sz in sizes:
        rounded.resize((sz, sz), Image.LANCZOS).save(iconset / f"icon_{sz}x{sz}.png")
        rounded.resize((sz * 2, sz * 2), Image.LANCZOS).save(
            iconset / f"icon_{sz}x{sz}@2x.png"
        )

    iconutil = shutil.which("iconutil")
    if iconutil is None:
        print(f"used {SOURCE}")
        print(f"wrote {windows_icon}")
        print(f"wrote {package_icon}")
        print(f"wrote {dev_dock_path}")
        print(f"wrote {tray_icon_mac_path}")
        print("skipped icon.icns (iconutil is unavailable)")
        return

    icns = BUILD / "icon.icns"
    subprocess.run(
        [iconutil, "-c", "icns", str(iconset), "-o", str(icns)], check=True
    )
    print(f"used {SOURCE}")
    print(f"wrote {windows_icon}")
    print(f"wrote {package_icon}")
    print(f"wrote {dev_dock_path}")
    print(f"wrote {tray_icon_mac_path}")
    print(f"wrote {icns}")


if __name__ == "__main__":
    main()
