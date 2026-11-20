#!/usr/bin/env python3
"""Build the local, synthetic images and videos used by the procurement demo."""

import json
import os
import subprocess
import tempfile
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

PUBLIC = Path(__file__).resolve().parents[1] / "public"
EVIDENCE = PUBLIC / "evidence"
MEDIA = PUBLIC / "media"


def get_font(size):
    candidates = [
        os.environ.get("DEMO_FONT", ""),
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "C:/Windows/Fonts/msyh.ttc",
    ]
    for path in candidates:
        if path and Path(path).is_file():
            return ImageFont.truetype(path, size)
    raise SystemExit("请将 DEMO_FONT 设置为可读取的中文字体文件路径。")


def make_card(path, title, body, size=(800, 450)):
    image = Image.new("RGB", size, "#f0fdfa")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((24, 24, size[0] - 24, size[1] - 24), radius=22, fill="#ffffff")
    draw.rounded_rectangle((44, 44, size[0] - 44, 217), radius=14, fill="#134e4a")
    draw.text((64, 62), "泛亚采购工作台 · 合成演示样本", font=get_font(20), fill="#99f6e4")
    for index, line in enumerate(textwrap.wrap(title, width=24)):
        draw.text((64, 105 + index * 43), line, font=get_font(28), fill="#ffffff")
    for index, line in enumerate(textwrap.wrap(body, width=29)):
        draw.text((64, 251 + index * 37), line, font=get_font(23), fill="#0f172a")
    image.save(path)


def make_video(frames, destination):
    manifest = frames[0][0].parent / "sequence.txt"
    segments = []
    elapsed = 0
    previous_frame = 0
    for image, duration in frames:
        elapsed += duration
        end_frame = round(elapsed * 25)
        segment = image.with_suffix(".mp4")
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "25",
                "-i", str(image), "-frames:v", str(end_frame - previous_frame), "-c:v", "libx264",
                "-pix_fmt", "yuv420p", "-tune", "stillimage", str(segment),
            ],
            check=True,
        )
        segments.append(f"file '{segment.name}'\n")
        previous_frame = end_frame
    manifest.write_text("".join(segments))
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "1",
            "-i", str(manifest), "-c", "copy", "-movflags", "+faststart", str(destination),
        ],
        check=True,
    )


def main():
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    items = {
        "item_mbp_m3.jpg": "MacBook Pro 14 M3",
        "item_ip15p.jpg": "iPhone 15 Pro 256G",
        "item_a7m4.jpg": "Sony A7M4 单机身",
        "item_rog_2k.jpg": "ROG 27寸 2K 电竞屏",
        "item_ipad_m2.jpg": "iPad Pro 11 M2 256G",
        "item_dell_4k.jpg": "Dell U2723QE 4K",
        "snapshot-description.png": "商品描述版本记录",
        "snapshot-condition.png": "到货品况异常记录",
    }
    for name, title in items.items():
        make_card(EVIDENCE / name, title, "用于本机演示快照锁定与证据查看。")
    chapters = json.loads((MEDIA / "tutorial_chapters.json").read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory() as directory:
        temporary = Path(directory)
        frames = []
        for chapter in chapters:
            path = temporary / (chapter["id"] + ".png")
            make_card(path, chapter["title"], chapter["summary"])
            frames.append((path, chapter["durationSec"]))
        make_video(frames, MEDIA / "tutorial-v6.mp4")
        sample = temporary / "unbox.png"
        make_card(sample, "拆箱与验货留证", "拆封、外观检查和异常登记的模拟留证卡。")
        make_video([(sample, 3)], EVIDENCE / "unbox-sample.mp4")


if __name__ == "__main__":
    main()
