#!/usr/bin/env python3
"""从 icon-source.jpg 生成应用图标与界面图标资源。"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "desktop" / "icon-source.jpg"
PUBLIC = ROOT / "public"
DESKTOP = ROOT / "desktop"


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def rounded_tile(size: int, radius_ratio: float) -> Image.Image:
    base = Image.open(SRC).convert("RGB")
    tile = base.resize((size, size), Image.LANCZOS).convert("RGBA")
    radius = max(1, round(size * radius_ratio))
    tile.putalpha(rounded_mask(size, radius))
    return tile


def main() -> None:
    # 1) 应用图标：macOS 模板，824 内容 + 100 边距，圆角约 185
    content = 824
    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    base = Image.open(SRC).convert("RGB").resize((content, content), Image.LANCZOS).convert("RGBA")
    base.putalpha(rounded_mask(content, 185))
    canvas.alpha_composite(base, ((1024 - content) // 2, (1024 - content) // 2))
    canvas.save(DESKTOP / "AppIcon-source.png")

    # 2) 界面用图标：满幅圆角方块
    for size, name in [(512, "icon-book.png"), (180, "apple-touch-icon.png"), (64, "favicon.png")]:
        rounded_tile(size, 0.12).save(PUBLIC / name)

    # 3) favicon 多尺寸（16/32/48）合成一个 ico，兼容旧浏览器
    ico_sizes = [16, 32, 48]
    imgs = [rounded_tile(s, 0.12) for s in ico_sizes]
    imgs[-1].save(PUBLIC / "favicon.ico", format="ICO", sizes=[(s, s) for s in ico_sizes])

    print("assets written")


if __name__ == "__main__":
    main()
