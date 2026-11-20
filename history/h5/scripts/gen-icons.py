"""生成 PWA 图标（和小程序登录页的「泛」字徽标同款：主色底 + 白字）。

用法：python3 scripts/gen-icons.py   （需要 Pillow；字体用 macOS 自带的冬青黑体）
产物在 public/icons/，已经提交进仓库，平时不用跑。
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
BLUE = (37, 99, 235, 255)  # --color-primary #2563EB
WHITE = (255, 255, 255, 255)
FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"
GLYPH = "泛"


def font(size):
    return ImageFont.truetype(FONT, size, index=2)  # W6（粗体，和登录页徽标的 700 对上）


def draw_glyph(img, scale):
    d = ImageDraw.Draw(img)
    w, h = img.size
    f = font(int(w * scale))
    box = d.textbbox((0, 0), GLYPH, font=f)
    gw, gh = box[2] - box[0], box[3] - box[1]
    d.text(((w - gw) / 2 - box[0], (h - gh) / 2 - box[1]), GLYPH, font=f, fill=WHITE)


def rounded(size, radius_ratio=0.22, scale=0.56):
    """普通图标：圆角方块，四角透明"""
    big = size * 4
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle((0, 0, big - 1, big - 1), radius=int(big * radius_ratio), fill=BLUE)
    draw_glyph(img, scale)
    return img.resize((size, size), Image.LANCZOS)


def full(size, scale):
    """满底：iOS 主屏图标（系统自己切圆角，透明角会变黑）、安卓 maskable（字缩在安全区内）"""
    big = size * 4
    img = Image.new("RGBA", (big, big), BLUE)
    draw_glyph(img, scale)
    return img.resize((size, size), Image.LANCZOS).convert("RGB")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rounded(192).save(OUT / "icon-192.png")
    rounded(512).save(OUT / "icon-512.png")
    full(512, 0.40).save(OUT / "icon-maskable-512.png")
    full(180, 0.54).save(OUT / "apple-touch-icon.png")
    rounded(64, 0.24, 0.62).save(OUT / "favicon-64.png")
    (OUT / "favicon.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        '<rect width="64" height="64" rx="15" fill="#2563EB"/>'
        '<text x="32" y="44" text-anchor="middle" font-size="38" font-weight="700" fill="#fff" '
        'font-family="PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif">泛</text></svg>\n',
        encoding="utf-8",
    )
    print("icons ->", OUT)


if __name__ == "__main__":
    main()
