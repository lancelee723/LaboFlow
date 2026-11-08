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
    windows_icon = BUILD / "icon.ico"
    master.save(
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
    master.resize((512, 512), Image.LANCZOS).save(package_icon)

    # Development dock icon. macOS does not mask images handed to
    # app.dock.setIcon, so the full-bleed canvas artwork (macOS 26 contract)
    # renders square in dev. Bake the system-style corner mask into a
    # separate asset; packaged builds use the icns and need none of this.
    SS = 4
    dev_mask_big = Image.new("L", (BASE * SS, BASE * SS), 0)
    dev_mask_draw = ImageDraw.Draw(dev_mask_big)
    dev_mask_draw.rounded_rectangle(
        (0, 0, BASE * SS - 1, BASE * SS - 1), radius=230 * SS, fill=255
    )
    dev_mask = dev_mask_big.resize((BASE, BASE), Image.LANCZOS)
    dev_dock = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    dev_dock.paste(master, (0, 0), dev_mask)
    dev_dock_path = BUILD / "icon-dev-dock.png"
    dev_dock.save(dev_dock_path)

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
    # The artwork is the full-bleed macOS 26 canvas: white field with the
    # logo lockup (colored blocks + dark wordmark). Dark pixels are the
    # wordmark alone — the gray outline that used to need a clip rectangle
    # is scrubbed from the tracked asset, so no clip is necessary.
    tray_alpha = tray_alpha
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
        master.resize((sz, sz), Image.LANCZOS).save(iconset / f"icon_{sz}x{sz}.png")
        master.resize((sz * 2, sz * 2), Image.LANCZOS).save(
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
