#!/usr/bin/env python3
"""Generate clean local sample device photos for monitor hits & snapshot galleries (zero external dead links)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path("./demo")
OUT.mkdir(parents=True, exist_ok=True)


def font(size: int):
    for p in ["/System/Library/Fonts/STHeiti Medium.ttc", "/System/Library/Fonts/Hiragino Sans GB.ttc"]:
        if Path(p).exists():
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


ITEMS = [
    ("item_mbp_m3.jpg", "MacBook Pro 14 M3", "16+512 · 极客自用 · 几乎全新", (30, 58, 138), (239, 246, 255)),
    ("item_ip15p.jpg", "iPhone 15 Pro 256G", "国行原色 · 电池93% · 原盒", (15, 118, 110), (236, 253, 245)),
    ("item_a7m4.jpg", "Sony A7M4 单机身", "快门 8,600 · CMOs 无灰 · 实拍", (109, 40, 217), (245, 243, 255)),
    ("item_rog_2k.jpg", "ROG 27寸 2K 高刷屏", "99新几乎全新 · 无坏点实拍", (180, 83, 9), (255, 251, 235)),
    ("item_ipad_m2.jpg", "iPad Pro 11 M2 256G", "深空灰 · WiFi版 · 实拍验机样本", (51, 65, 85), (248, 250, 252)),
    ("item_dell_4k.jpg", "Dell U2723QE 4K", "27寸专业显示器 · 原装支架", (185, 28, 28), (254, 242, 242)),
]

for fname, title, sub, fg, bg in ITEMS:
    im = Image.new("RGB", (640, 440), bg)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([24, 24, 616, 416], radius=24, fill=(255, 255, 255), outline=fg, width=4)
    d.rounded_rectangle([44, 44, 596, 240], radius=16, fill=fg)
    d.text((70, 96), title, font=font(36), fill=(255, 255, 255))
    d.text((70, 152), "闲鱼监控实拍原图快照 · 买前锁证样本", font=font(20), fill=(219, 234, 254))
    d.text((48, 272), sub, font=font(24), fill=(15, 23, 42))
    d.rounded_rectangle([48, 326, 592, 384], radius=12, fill=bg, outline=fg, width=2)
    d.text((66, 342), "已存工作台快照库（防卖家事后删改描述与图片）", font=font(19), fill=fg)
    im.save(OUT / fname, "JPEG", quality=86)

print("Generated 6 local sample item images in", OUT)
