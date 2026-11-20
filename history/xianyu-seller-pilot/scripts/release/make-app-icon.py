#!/usr/bin/env python3
"""从一张方图生成 macOS 规范的应用图标。

# 为什么要有这个脚本

第一版是把原图直接改名叫 icon.png 就交差了——1024×1024、**不带透明通道、
四角是直的**。macOS 不会替你切圆角：Dock 里于是出现一张硬边白方块，
紧挨着旁边形状正常的图标，像贴上去的贴纸。

苹果从 Big Sur 起给的图标网格是固定的，这里照着做：
  · 画布 1024，四周留 100 的透明边（图标自带留白，Dock 靠它对齐大小）
  · 中间 824 的圆角瓷砖，圆角走**超椭圆**而不是圆弧——
    苹果的角是连续曲率的，用 rounded_rectangle 画出来在大尺寸下一眼能看出差别
  · 瓷砖自带投影，落在那 100 的留白里

# 抠图这一段值得说明

原图是画在浅色底上的，直接贴到带渐变的瓷砖上会露出一个方形的接缝。
所以要把底抠掉，但**不能按「接近白色就透明」来抠**——鱼脸本身就是近白色的，
那样抠会把鱼脸一起抠没。

做法是两步合一步：
  1. 从四角泛洪填充，得到**与边缘连通**的那片背景（鱼脸虽然也是白的，
     但它被鱼身围着、跟边缘不连通，不会被选中）；
  2. 在这片背景里，按「与底色的差值」算出**软透明度**，而不是非 0 即 255——
     原图边缘是抗锯齿的、鱼下面还有淡投影，硬阈值会留下一圈毛边。
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "resources" / "icon-workbench-source.png"

CANVAS = 1024
MARGIN = 100                      # 苹果网格的四周留白
TILE = CANVAS - MARGIN * 2        # 824
SQUIRCLE_N = 5.0                  # 超椭圆指数；越大越方，5 接近苹果的角
ART_FILL = 0.80                   # 图形占瓷砖的比例，长边为准
SS = 4                            # 蒙版超采样倍数，换边缘平滑

GRAD_TOP = (255, 255, 255)        # 瓷砖底色：上白下淡青，青色取自鱼身
GRAD_BOTTOM = (223, 240, 245)
EDGE = (86, 158, 178, 46)         # 内描边：一根让瓷砖有边界感的细线


def max_channel_diff(img: Image.Image, color: tuple[int, int, int]) -> Image.Image:
    """每个像素与给定颜色的**最大通道差**（不是亮度差）。

    用亮度差会把蓝色的差值压掉八成——鱼正好是蓝的。
    """
    flat = Image.new("RGB", img.size, color)
    d = ImageChops.difference(img.convert("RGB"), flat)
    r, g, b = d.split()
    return ImageChops.lighter(ImageChops.lighter(r, g), b)


def cutout(src: Image.Image) -> Image.Image:
    """把画在纯色底上的图形抠出来，返回裁到内容边界的 RGBA。"""
    rgb = src.convert("RGB")
    bg = rgb.getpixel((2, 2))

    # 1) 四角泛洪：只拿到**与边缘连通**的背景。鱼脸是白的但被围在里面，选不到它。
    probe = rgb.copy()
    w, h = probe.size
    sentinel = (255, 0, 255)       # 原图里不存在的颜色，用来当标记
    for xy in ((1, 1), (w - 2, 1), (1, h - 2), (w - 2, h - 2)):
        ImageDraw.floodfill(probe, xy, sentinel, thresh=60)
    outside = max_channel_diff(probe, sentinel).point(lambda v: 255 if v < 10 else 0)

    # 2) 背景区域内按差值算软透明度：抗锯齿边和淡投影都能平滑过渡
    soft = max_channel_diff(rgb, bg).point(lambda v: min(255, max(0, (v - 6) * 8)))
    alpha = Image.composite(soft, Image.new("L", src.size, 255), outside)

    out = rgb.copy()
    out.putalpha(alpha)
    box = alpha.point(lambda v: 255 if v > 8 else 0).getbbox()
    return out.crop(box) if box else out


def squircle_mask(size: int) -> Image.Image:
    """超椭圆蒙版。超采样后缩回来，避免边缘出锯齿。"""
    big = size * SS
    r = big / 2.0
    pts = []
    steps = 2048
    for i in range(steps):
        t = 2.0 * 3.141592653589793 * i / steps
        import math
        ct, st = math.cos(t), math.sin(t)
        x = r * (1 if ct >= 0 else -1) * abs(ct) ** (2.0 / SQUIRCLE_N)
        y = r * (1 if st >= 0 else -1) * abs(st) ** (2.0 / SQUIRCLE_N)
        pts.append((r + x, r + y))
    m = Image.new("L", (big, big), 0)
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def build_tile(art: Image.Image, size: int) -> Image.Image:
    """铺满整块的圆角瓷砖：渐变底 + 居中图形 + 内描边。"""
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        grad.putpixel((0, y), tuple(
            round(a + (b - a) * t) for a, b in zip(GRAD_TOP, GRAD_BOTTOM)))
    tile = grad.resize((size, size), Image.BILINEAR).convert("RGBA")

    fitted = art.copy()
    scale = (size * ART_FILL) / max(fitted.size)
    fitted = fitted.resize(
        (max(1, round(fitted.width * scale)), max(1, round(fitted.height * scale))),
        Image.LANCZOS)
    tile.alpha_composite(fitted, ((size - fitted.width) // 2, (size - fitted.height) // 2))

    stroke = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(stroke).rectangle([0, 0, size - 1, size - 1], outline=EDGE,
                                     width=max(1, size // 340))
    tile.alpha_composite(Image.composite(
        stroke, Image.new("RGBA", (size, size), (0, 0, 0, 0)), squircle_mask(size)))

    tile.putalpha(ImageChops.multiply(tile.getchannel("A"), squircle_mask(size)))
    return tile


def build_icon(art: Image.Image) -> Image.Image:
    """按苹果网格摆好：瓷砖居中留白，投影落在留白里。"""
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    tile = build_tile(art, TILE)

    shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 64), (MARGIN, MARGIN + 14), squircle_mask(TILE))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(22)))
    canvas.alpha_composite(tile, (MARGIN, MARGIN))
    return canvas


def main() -> int:
    if not SOURCE.exists():
        print(f"找不到源图：{SOURCE}")
        return 1
    art = cutout(Image.open(SOURCE))
    print(f"抠图完成，内容 {art.width}×{art.height}")

    icon = build_icon(art)
    res = ROOT / "resources"

    icon.save(res / "icon-workbench.png")

    iconset = res / "icon-workbench.iconset"
    shutil.rmtree(iconset, ignore_errors=True)
    iconset.mkdir(parents=True)
    for px, names in {
        16: ["icon_16x16.png"], 32: ["141a1d0e90@example.invalid", "icon_32x32.png"],
        64: ["202e379f8c@example.invalid"], 128: ["icon_128x128.png"],
        256: ["0b16b1a947@example.invalid", "icon_256x256.png"],
        512: ["067c072fe2@example.invalid", "icon_512x512.png"],
        1024: ["44f007119c@example.invalid", "icon_1024x1024.png"],
    }.items():
        small = icon.resize((px, px), Image.LANCZOS)
        for n in names:
            small.save(iconset / n)

    icns = res / "icon-workbench.icns"
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(icns)], check=True)
    shutil.copyfile(icns, res / "icon-seller-pilot.icns")
    shutil.copyfile(SOURCE, res / "icon-seller-pilot-source.png")

    # 跟着热更新走的那张：已经装好的机器换代码就能换 Dock 图标，不必重打包
    pub = ROOT / "src" / "renderer" / "public"
    pub.mkdir(parents=True, exist_ok=True)
    icon.resize((512, 512), Image.LANCZOS).save(pub / "app-icon.png")

    # 界面里那枚标记：铺满整块，不留白——侧栏 36px 的位置经不起再缩 20%
    tile = build_tile(art, 256)
    tile.save(ROOT / "src" / "renderer" / "src" / "assets" / "logo.png")

    # Windows 的 .ico 用**铺满整块**那版，不是留白那版。
    # macOS 会拿四周那 100 的透明边去对齐、自己再排版；Windows 不会——
    # 把留白版塞进任务栏，图标就比旁边的小一圈，像没做好。
    big = build_tile(art, 256)
    big.save(res / "icon-workbench.ico",
             sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])

    print(f"已生成：{icns.name} / icon-workbench.png / public/app-icon.png / assets/logo.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
