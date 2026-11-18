"""高拟真商品演示图生成器（支持全量历史库存、闲鱼36卡快照与三栏精修图池）。"""
import hashlib
import os
import random
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

OUT = os.path.join(os.path.dirname(__file__), "demo-img")
os.makedirs(OUT, exist_ok=True)
for sub in ("inspection/listing", "inspection/defect", "sku/location", "sku/product", "library"):
    os.makedirs(os.path.join(OUT, sub), exist_ok=True)

FONT = None
for p in (
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
):
    if os.path.exists(p):
        FONT = p
        break


_FONT_CACHE = {}


def font(sz):
    if sz not in _FONT_CACHE:
        _FONT_CACHE[sz] = ImageFont.truetype(FONT, sz) if FONT else ImageFont.load_default()
    return _FONT_CACHE[sz]


def fast_grad(w, h, c1, c2):
    g = Image.linear_gradient("L").resize((w, h))
    return ImageOps.colorize(g, c1, c2).convert("RGBA")


def grad(w, h, c1, c2):
    return fast_grad(w, h, c1, c2).convert("RGB")


def shade(c, k):
    return tuple(max(0, min(255, int(v * k))) for v in c[:3])


def rng_of(*parts):
    return random.Random(int(hashlib.md5("|".join(map(str, parts)).encode()).hexdigest()[:12], 16))


def tag(img, text, wm=True):
    """使用 textbbox 精确测量中英文像素宽度，彻底杜绝白底裁字或溢出。"""
    d = ImageDraw.Draw(img, "RGBA")
    f = font(24)
    bbox = d.textbbox((0, 0), text, font=f)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    pad_x = 18
    box_h = max(44, th + 18)
    d.rounded_rectangle((18, 18, 18 + tw + pad_x * 2, 18 + box_h), 12, fill=(15, 23, 42, 188))
    d.text((18 + pad_x, 18 + box_h // 2), text, font=f, fill=(255, 255, 255, 248), anchor="lm")
    if wm:
        wf = font(22)
        wb = d.textbbox((0, 0), "实拍样张", font=wf)
        ww = wb[2] - wb[0]
        W, H = img.size
        d.rounded_rectangle((W - ww - 38, H - 48, W - 14, H - 14), 8, fill=(15, 23, 42, 115))
        d.text((W - 26, H - 31), "实拍样张", font=wf, fill=(255, 255, 255, 225), anchor="rm")


def phone(d, cx, cy, body, w=296, h=590, angle2=False):
    x0, y0 = cx - w // 2, cy - h // 2
    d.rounded_rectangle((x0 + 12, y0 + 16, x0 + w + 12, y0 + h + 16), 48, fill=(0, 0, 0, 68))
    d.rounded_rectangle((x0 - 3, y0 - 3, x0 + w + 3, y0 + h + 3), 49, fill=shade(body, 1.25))
    d.rounded_rectangle((x0, y0, x0 + w, y0 + h), 46, fill=body)
    if angle2:
        d.rounded_rectangle((x0 + 22, y0 + 22, x0 + 154, y0 + 154), 30, fill=shade(body, 0.84))
        for dx, dy in ((52, 52), (114, 52), (52, 114)):
            d.ellipse((x0 + dx - 24, y0 + dy - 24, x0 + dx + 24, y0 + dy + 24), fill=(22, 24, 30))
            d.ellipse((x0 + dx - 16, y0 + dy - 16, x0 + dx + 16, y0 + dy + 16), fill=(42, 56, 84))
            d.ellipse((x0 + dx - 6, y0 + dy - 8, x0 + dx + 2, y0 + dy), fill=(180, 210, 255, 180))
        d.ellipse((x0 + w // 2 - 24, y0 + h // 2 - 24, x0 + w // 2 + 24, y0 + h // 2 + 24), fill=shade(body, 1.18))
    else:
        d.rounded_rectangle((x0 + 11, y0 + 11, x0 + w - 11, y0 + h - 11), 38, fill=(16, 18, 26))
        # 渐变壁纸块 + 灵动岛 + 玻璃高光
        d.rounded_rectangle((x0 + 16, y0 + 16, x0 + w - 16, y0 + h - 16), 34, fill=(32, 58, 118))
        d.polygon([(x0 + 16, y0 + 180), (x0 + w - 16, y0 + 80), (x0 + w - 16, y0 + 380), (x0 + 16, y0 + 440)], fill=(78, 136, 242, 190))
        d.polygon([(x0 + 16, y0 + 340), (x0 + w - 16, y0 + 260), (x0 + w - 16, y0 + h - 16), (x0 + 16, y0 + h - 16)], fill=(132, 88, 210, 180))
        d.rounded_rectangle((x0 + w // 2 - 44, y0 + 26, x0 + w // 2 + 44, y0 + 48), 11, fill=(8, 10, 14))
        d.text((cx, y0 + 128), "09:41", font=font(56), fill=(255, 255, 255, 240), anchor="mm")
        d.polygon([(x0 + 20, y0 + 18), (x0 + 130, y0 + 18), (x0 + 42, y0 + 420), (x0 + 20, y0 + 420)], fill=(255, 255, 255, 30))


def laptop(d, cx, cy, body):
    d.ellipse((cx - 340, cy + 136, cx + 340, cy + 188), fill=(0, 0, 0, 58))
    d.rounded_rectangle((cx - 280, cy - 208, cx + 280, cy + 122), 20, fill=shade(body, 0.72))
    d.rectangle((cx - 262, cy - 190, cx + 262, cy + 104), fill=(18, 22, 34))
    d.polygon([(cx - 262, cy - 190), (cx + 262, cy - 190), (cx + 262, cy - 20), (cx - 262, cy + 50)], fill=(44, 108, 224))
    d.polygon([(cx - 262, cy + 10), (cx + 120, cy - 90), (cx + 262, cy + 104), (cx - 262, cy + 104)], fill=(24, 168, 152, 210))
    d.polygon([(cx - 250, cy - 186), (cx - 90, cy - 186), (cx - 190, cy + 100), (cx - 250, cy + 100)], fill=(255, 255, 255, 36))
    d.polygon([(cx - 344, cy + 144), (cx + 344, cy + 144), (cx + 292, cy + 120), (cx - 292, cy + 120)], fill=body)
    d.rounded_rectangle((cx - 344, cy + 138, cx + 344, cy + 160), 9, fill=shade(body, 1.12))


def tablet(d, cx, cy, body):
    d.rounded_rectangle((cx - 262, cy - 192, cx + 278, cy + 208), 36, fill=(0, 0, 0, 56))
    d.rounded_rectangle((cx - 268, cy - 198, cx + 268, cy + 198), 36, fill=body)
    d.rounded_rectangle((cx - 244, cy - 174, cx + 244, cy + 174), 22, fill=(20, 24, 34))
    d.polygon([(cx - 244, cy - 174), (cx + 244, cy - 174), (cx + 244, cy + 20), (cx - 244, cy + 90)], fill=(38, 152, 134))
    d.polygon([(cx - 244, cy + 40), (cx + 244, cy - 30), (cx + 244, cy + 174), (cx - 244, cy + 174)], fill=(58, 110, 212, 215))


def headphones(d, cx, cy, body):
    d.arc((cx - 230, cy - 260, cx + 230, cy + 150), 180, 360, fill=shade(body, 0.85), width=38)
    for sx in (-1, 1):
        d.rounded_rectangle((cx + sx * 226 - 58, cy - 42, cx + sx * 226 + 58, cy + 192), 42, fill=body)
        d.rounded_rectangle((cx + sx * 226 - 36, cy - 14, cx + sx * 226 + 36, cy + 164), 30, fill=shade(body, 1.28))


def console(d, cx, cy, body):
    d.rounded_rectangle((cx - 344, cy - 142, cx + 344, cy + 142), 42, fill=body)
    d.rounded_rectangle((cx - 344, cy - 142, cx - 232, cy + 142), 40, fill=(46, 192, 228))
    d.rounded_rectangle((cx + 232, cy - 142, cx + 344, cy + 142), 40, fill=(242, 82, 82))
    d.rectangle((cx - 228, cy - 122, cx + 228, cy + 122), fill=(18, 22, 30))
    d.rectangle((cx - 216, cy - 110, cx + 216, cy + 110), fill=(36, 74, 148))
    d.ellipse((cx - 308, cy - 52, cx - 264, cy - 8), fill=(28, 30, 36))
    d.ellipse((cx + 264, cy + 8, cx + 308, cy + 52), fill=(28, 30, 36))


def camera(d, cx, cy, body):
    d.rounded_rectangle((cx - 260, cy - 126, cx + 260, cy + 154), 32, fill=body)
    d.rounded_rectangle((cx - 90, cy - 172, cx + 90, cy - 116), 16, fill=shade(body, 0.85))
    d.rectangle((cx - 260, cy - 126, cx + 260, cy - 72), fill=shade(body, 0.78))
    d.ellipse((cx - 118, cy - 96, cx + 118, cy + 140), fill=(24, 26, 32))
    d.ellipse((cx - 92, cy - 70, cx + 92, cy + 114), fill=(42, 54, 78))
    d.ellipse((cx - 64, cy - 42, cx + 64, cy + 86), fill=(26, 48, 96))
    d.ellipse((cx - 32, cy - 18, cx - 6, cy + 8), fill=(190, 225, 255, 195))


def monitor(d, cx, cy, body, accent=(52, 132, 246), stand_kind="flat"):
    # 显示器阴影 + 窄边框面板 + 细腻游戏/设计壁纸 + 金属支架
    d.ellipse((cx - 230, cy + 206, cx + 230, cy + 252), fill=(0, 0, 0, 65))
    if stand_kind == "tripod":
        d.polygon([(cx - 18, cy + 96), (cx + 18, cy + 96), (cx + 28, cy + 206), (cx - 28, cy + 206)], fill=shade(body, 0.82))
        d.line((cx, cy + 196, cx - 175, cy + 238), fill=shade(body, 0.75), width=18)
        d.line((cx, cy + 196, cx + 175, cy + 238), fill=shade(body, 0.75), width=18)
        d.line((cx - 40, cy + 200, cx + 40, cy + 200), fill=accent, width=6)
    else:
        d.rectangle((cx - 26, cy + 108, cx + 26, cy + 212), fill=shade(body, 0.82))
        d.rounded_rectangle((cx - 168, cy + 206, cx + 168, cy + 234), 10, fill=shade(body, 0.94))

    d.rounded_rectangle((cx - 344, cy - 228, cx + 344, cy + 116), 16, fill=(0, 0, 0, 56))
    d.rounded_rectangle((cx - 348, cy - 232, cx + 348, cy + 110), 14, fill=body)
    # 屏幕显示区
    sx0, sy0, sx1, sy1 = cx - 332, cy - 216, cx + 332, cy + 90
    d.rectangle((sx0, sy0, sx1, sy1), fill=(15, 20, 34))
    d.polygon([(sx0, sy0), (sx1, sy0), (sx1, sy0 + 185), (sx0, sy0 + 250)], fill=accent)
    d.polygon([(sx0, sy0 + 160), (cx + 80, sy0 + 55), (sx1, sy1), (sx0, sy1)], fill=(22, 168, 148, 215))
    d.ellipse((cx - 120, cy - 150, cx + 120, cy + 30), fill=(255, 210, 120, 95))
    # 屏幕参数角标（如 2K 180Hz HDR）
    d.rounded_rectangle((sx0 + 18, sy1 - 44, sx0 + 182, sy1 - 12), 8, fill=(15, 23, 42, 185))
    d.text((sx0 + 100, sy1 - 28), "IPS · 高刷实测", font=font(18), fill=(255, 255, 255, 230), anchor="mm")
    # 玻璃斜向高光
    d.polygon([(sx0 + 10, sy0), (sx0 + 150, sy0), (sx0 + 40, sy1), (sx0 + 10, sy1)], fill=(255, 255, 255, 32))
    # 下巴电源指示灯
    d.ellipse((cx - 4, cy + 97, cx + 4, cy + 105), fill=(74, 222, 128))


def purifier(d, cx, cy, body):
    d.ellipse((cx - 170, cy + 228, cx + 170, cy + 276), fill=(0, 0, 0, 56))
    d.rounded_rectangle((cx - 156, cy - 256, cx + 156, cy + 252), 44, fill=body)
    # 顶部出风口格栅
    d.ellipse((cx - 126, cy - 244, cx + 126, cy - 196), fill=shade(body, 0.78))
    # 圆形 OLED 数显屏
    d.ellipse((cx - 72, cy - 148, cx + 72, cy - 4), fill=(18, 22, 28))
    d.arc((cx - 64, cy - 140, cx + 64, cy - 12), 0, 360, fill=(34, 197, 94), width=6)
    d.text((cx, cy - 84), "012", font=font(38), fill=(255, 255, 255), anchor="mm")
    d.text((cx, cy - 46), "PM2.5 优", font=font(16), fill=(134, 239, 172), anchor="mm")
    # 下半部进风微孔阵列
    for row in range(8):
        y = cy + 36 + row * 22
        for col in range(-5, 6):
            x = cx + col * 22
            d.ellipse((x - 3, y - 3, x + 3, y + 3), fill=shade(body, 0.68))


def dryer(d, cx, cy, body):
    d.ellipse((cx - 180, cy + 236, cx + 180, cy + 280), fill=(0, 0, 0, 52))
    # 手柄（金属灰机身）+ 吹风筒（玫红/普鲁士蓝撞色中空风道）
    d.rounded_rectangle((cx - 38, cy - 30, cx + 38, cy + 258), 26, fill=(76, 80, 92))
    d.rounded_rectangle((cx - 175, cy - 166, cx + 175, cy - 14), 74, fill=body)
    d.ellipse((cx - 165, cy - 158, cx - 32, cy - 22), fill=shade(body, 0.72))
    d.ellipse((cx - 135, cy - 128, cx - 62, cy - 52), fill=(238, 242, 248))
    d.ellipse((cx + 108, cy - 118, cx + 132, cy - 94), fill=(244, 63, 94))
    d.ellipse((cx + 108, cy - 82, cx + 132, cy - 58), fill=(59, 130, 246))


def speaker(d, cx, cy, body):
    """哈曼卡顿琉璃水晶透明音箱 / 桌面蓝牙音箱。"""
    d.ellipse((cx - 190, cy + 210, cx + 190, cy + 262), fill=(0, 0, 0, 62))
    # 透明玻璃罩与内部波纹氛围灯
    d.pieslice((cx - 176, cy - 230, cx + 176, cy + 240), 180, 360, fill=(210, 225, 245, 165))
    d.rounded_rectangle((cx - 176, cy - 10, cx + 176, cy + 150), 28, fill=(195, 212, 236, 175))
    d.ellipse((cx - 118, cy + 10, cx + 118, cy + 126), fill=(96, 165, 250, 175))
    d.ellipse((cx - 76, cy + 32, cx + 76, cy + 104), fill=(255, 255, 255, 215))
    # 底部织物黑金底座
    d.rounded_rectangle((cx - 182, cy + 118, cx + 182, cy + 232), 48, fill=body)
    d.polygon([(cx - 136, cy - 170), (cx - 88, cy - 190), (cx - 106, cy + 90), (cx - 148, cy + 90)], fill=(255, 255, 255, 70))


def robot_vac(d, cx, cy, body):
    """云鲸 / 石头扫拖机器人基站+圆盘主机。"""
    d.ellipse((cx - 220, cy + 210, cx + 220, cy + 260), fill=(0, 0, 0, 56))
    d.rounded_rectangle((cx - 175, cy - 235, cx + 175, cy + 195), 56, fill=body)
    d.rounded_rectangle((cx - 130, cy - 205, cx + 130, cy - 125), 28, fill=shade(body, 0.9))
    d.ellipse((cx - 152, cy + 20, cx + 152, cy + 238), fill=(250, 251, 253), outline=shade(body, 0.78), width=6)
    d.ellipse((cx - 36, cy + 92, cx + 36, cy + 164), fill=shade(body, 0.82))


def earbuds(d, cx, cy, body):
    d.ellipse((cx - 180, cy + 130, cx + 180, cy + 176), fill=(0, 0, 0, 48))
    d.rounded_rectangle((cx - 186, cy - 138, cx + 186, cy + 138), 78, fill=body)
    d.line((cx - 184, cy - 22, cx + 184, cy - 22), fill=shade(body, 0.76), width=5)
    d.ellipse((cx - 10, cy + 48, cx + 10, cy + 68), fill=(74, 222, 128))


ITEMS = {
    "IP13": ("phone", (38, 42, 52), (214, 226, 242), (170, 190, 220)),
    "IP12": ("phone", (236, 236, 242), (246, 232, 222), (226, 204, 190)),
    "IPAD9": ("tablet", (170, 176, 188), (226, 238, 232), (176, 206, 196)),
    "M50": ("camera", (42, 44, 50), (240, 236, 226), (214, 206, 190)),
    "XM4": ("headphones", (32, 34, 42), (232, 226, 240), (196, 186, 214)),
    "SW": ("console", (240, 242, 246), (250, 226, 226), (234, 190, 190)),
    "MBA": ("laptop", (196, 202, 212), (226, 232, 246), (186, 198, 230)),
    "APP2": ("earbuds", (246, 247, 250), (232, 242, 250), (190, 214, 236)),
    "MATE40": ("phone", (24, 118, 108), (222, 240, 236), (176, 214, 204)),
    "IP14": ("phone", (112, 86, 158), (240, 232, 248), (206, 190, 226)),
    "Z30": ("camera", (38, 40, 46), (232, 240, 236), (190, 208, 198)),
    "KINDLE": ("tablet", (38, 40, 46), (246, 244, 236), (222, 218, 200)),
    "MON1": ("monitor", (34, 38, 46), (226, 234, 246), (186, 204, 230)),
    "MON2": ("monitor_silver", (198, 204, 214), (232, 240, 232), (190, 212, 194)),
    "MON_ROG": ("monitor_rog", (28, 30, 38), (38, 34, 58), (22, 20, 36)),
    "MON_AOC": ("monitor_aoc", (36, 36, 42), (238, 228, 230), (204, 184, 190)),
    "MON_LG": ("monitor_lg", (42, 44, 52), (226, 232, 244), (188, 198, 222)),
    "MON_ACER": ("monitor_acer", (36, 40, 46), (224, 238, 236), (182, 210, 206)),
    "PUR": ("purifier", (244, 246, 249), (232, 244, 240), (186, 222, 210)),
    "DYS": ("dryer", (196, 56, 108), (248, 232, 238), (228, 192, 208)),
    "SPK": ("speaker", (36, 38, 46), (224, 232, 246), (178, 194, 222)),
    "ROB": ("robot_vac", (242, 244, 248), (234, 240, 246), (196, 208, 220)),
    "MI13": ("phone", (228, 230, 226), (246, 238, 214), (228, 214, 170)),
}


def draw_object(kind, body, variant=0):
    layer = Image.new("RGBA", (900, 900), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer, "RGBA")
    cx, cy = 450, 450
    if kind == "phone":
        phone(d, cx, cy, body, angle2=bool(variant % 2))
    elif kind == "laptop":
        laptop(d, cx, cy, body)
    elif kind == "tablet":
        tablet(d, cx, cy, body)
    elif kind == "headphones":
        headphones(d, cx, cy, body)
    elif kind == "console":
        console(d, cx, cy, body)
    elif kind == "camera":
        camera(d, cx, cy, body)
    elif kind == "monitor":
        monitor(d, cx, cy, body, accent=(52, 132, 246), stand_kind="flat")
    elif kind == "monitor_silver":
        monitor(d, cx, cy, body, accent=(36, 168, 132), stand_kind="flat")
    elif kind == "monitor_rog":
        monitor(d, cx, cy, body, accent=(168, 56, 236), stand_kind="tripod")
    elif kind == "monitor_aoc":
        monitor(d, cx, cy, body, accent=(224, 52, 72), stand_kind="tripod")
    elif kind == "monitor_lg":
        monitor(d, cx, cy, body, accent=(72, 118, 242), stand_kind="tripod")
    elif kind == "monitor_acer":
        monitor(d, cx, cy, body, accent=(20, 168, 150), stand_kind="flat")
    elif kind == "purifier":
        purifier(d, cx, cy, body)
    elif kind == "dryer":
        dryer(d, cx, cy, body)
    elif kind == "speaker":
        speaker(d, cx, cy, body)
    elif kind == "robot_vac":
        robot_vac(d, cx, cy, body)
    else:
        earbuds(d, cx, cy, body)
    return layer


def unit_marks(layer, code, rng, scratches=2):
    d = ImageDraw.Draw(layer, "RGBA")
    for _ in range(scratches):
        x, y = rng.randint(270, 620), rng.randint(270, 580)
        d.line((x, y, x + rng.randint(28, 76), y + rng.randint(-22, 22)), fill=(255, 255, 255, 95), width=2)
    sx, sy = rng.randint(250, 540), rng.randint(585, 690)
    lbl = str(code)[-8:]
    f = font(20)
    tb = d.textbbox((0, 0), lbl, font=f)
    bw = max(136, (tb[2] - tb[0]) + 28)
    d.rounded_rectangle((sx, sy, sx + bw, sy + 36), 6, fill=(252, 252, 252, 238), outline=(148, 163, 184, 200), width=1)
    d.text((sx + bw // 2, sy + 18), lbl, font=f, fill=(30, 41, 59), anchor="mm")


def place(scene, layer, scale, angle, dx, dy, mirror=False):
    if mirror:
        layer = ImageOps.mirror(layer)
    if scale != 1:
        layer = layer.resize((int(900 * scale), int(900 * scale)), Image.LANCZOS)
    layer = layer.rotate(angle, resample=Image.BICUBIC, expand=False)
    w, h = layer.size
    scene.paste(layer, (450 - w // 2 + dx, 450 - h // 2 + dy), layer)


def photo_real(pre, code, n):
    kind, body, c1, c2 = ITEMS[pre]
    r = rng_of("real", code, n)
    tone = r.uniform(0.86, 1.06)
    wall = tuple(min(255, int(v * tone)) for v in (224, 228, 234))
    desk = tuple(min(255, int(v * r.uniform(0.82, 1.08))) for v in r.choice([(158, 122, 88), (104, 110, 120), (196, 178, 152), (76, 82, 92)]))
    scene = fast_grad(900, 900, wall, tuple(int(v * 0.92) for v in wall))
    d = ImageDraw.Draw(scene, "RGBA")
    d.rectangle((0, 565 + r.randint(-28, 24), 900, 900), fill=desk + (255,))
    d.ellipse((140, 645, 760, 770), fill=(0, 0, 0, 48))
    layer = draw_object(kind, tuple(min(255, int(v * r.uniform(0.92, 1.06))) for v in body), variant=n)
    unit_marks(layer, code, r, scratches=1 + (n % 3))
    place(scene, layer, r.uniform(0.84, 0.98) if n != 2 else r.uniform(1.02, 1.12), r.uniform(-5, 5), r.randint(-36, 36), r.randint(6, 44))
    scene = scene.filter(ImageFilter.GaussianBlur(0.25))
    tag(scene, f"仓内实拍 · {code} · #{n}")
    return scene.convert("RGB")


def photo_defect(pre, code):
    kind, body, c1, c2 = ITEMS[pre]
    r = rng_of("defect", code)
    scene = fast_grad(900, 900, (56, 60, 70), (28, 30, 38))
    layer = draw_object(kind, body, variant=1)
    place(scene, layer, 1.85, r.uniform(-8, 8), r.randint(-180, 180), r.randint(-140, 140))
    d = ImageDraw.Draw(scene, "RGBA")
    for _ in range(4):
        x, y = r.randint(280, 620), r.randint(280, 620)
        d.line((x, y, x + r.randint(60, 140), y + r.randint(-35, 35)), fill=(255, 255, 255, 195), width=3)
    d.ellipse((330, 330, 570, 570), outline=(239, 68, 68, 255), width=6)
    tag(scene, f"外观瑕疵微距 · {code}")
    return scene.convert("RGB")


def photo_location(code, loc):
    r = rng_of("loc", code)
    scene = fast_grad(900, 900, (52, 58, 68), (30, 34, 42))
    d = ImageDraw.Draw(scene, "RGBA")
    for y in (300, 580, 860):
        d.rectangle((40, y, 860, y + 22), fill=(194, 122, 42, 255))
        d.rectangle((40, y + 22, 60, y + 70), fill=(120, 80, 30, 255))
        d.rectangle((840, y + 22, 860, y + 70), fill=(120, 80, 30, 255))
    for y in (300, 580):
        x = 80
        while x < 760:
            w = r.randint(120, 210)
            h = r.randint(120, 210)
            d.rectangle((x, y - h, x + w, y), fill=(168 + r.randint(-14, 14), 132 + r.randint(-10, 10), 86, 255))
            x += w + r.randint(16, 38)
    bx, by = r.randint(180, 420), 580
    d.rectangle((bx, by - 230, bx + 300, by), fill=(192, 150, 98, 255), outline=(250, 204, 21, 255), width=6)
    d.rounded_rectangle((bx + 32, by - 154, bx + 268, by - 66), 8, fill=(252, 252, 252, 255))
    d.text((bx + 150, by - 122), f"库位 {loc}", font=font(36), fill=(15, 23, 42), anchor="mm")
    d.text((bx + 150, by - 84), str(code)[:16], font=font(19), fill=(71, 85, 105), anchor="mm")
    tag(scene, f"库位定位图 · {loc}")
    return scene.convert("RGB")


def photo_material(pre, code, m):
    kind, body, c1, c2 = ITEMS[pre]
    r = rng_of("mat", code, m)
    style = m % 3
    if style == 1:
        scene = fast_grad(900, 900, (252, 253, 255), (234, 238, 245))
        sc, ang, dx, dy, mir = 0.98, r.uniform(-3, 3), r.randint(-24, 24), r.randint(-16, 16), bool(m % 2)
    elif style == 2:
        c = r.choice([(248, 232, 212), (226, 240, 222), (220, 232, 250), (246, 224, 232)])
        scene = fast_grad(900, 900, c, tuple(int(v * 0.86) for v in c))
        d0 = ImageDraw.Draw(scene, "RGBA")
        d0.rectangle((0, 610, 900, 900), fill=(184, 156, 126, 210))
        sc, ang, dx, dy, mir = r.uniform(0.95, 1.08), r.uniform(-6, 6), r.randint(-45, 35), r.randint(0, 32), False
    else:
        scene = fast_grad(900, 900, (34, 40, 54), (16, 20, 30))
        d0 = ImageDraw.Draw(scene, "RGBA")
        d0.ellipse((160, 130, 740, 710), fill=(96, 132, 204, 58))
        sc, ang, dx, dy, mir = r.uniform(0.88, 0.96), r.uniform(-6, 6), r.randint(-20, 45), r.randint(-18, 18), True
    layer = draw_object(kind, tuple(min(255, int(v * r.uniform(0.94, 1.05))) for v in body), variant=m)
    place(scene, layer, sc, ang, dx, dy, mirror=mir)
    tag(scene, f"商品图素材 · 视角 #{m}")
    return scene.convert("RGB")


PHOTO_SKUS = {
    "513211540233-A": ("MON1", "A-04", 3, False, True, True),
    "513211540233-B": ("MON1", "A-10", 2, False, True, True),
    "513211540215": ("MON2", "A-07", 2, False, True, False),
    "513211540009": ("MON1", "A-02", 0, False, True, False),
    "513211540213": ("MON2", "A-11", 2, False, False, False),
    "513211540203": ("MON1", "A-09", 3, False, True, True),
    "BQAFLF1XF01011": ("PUR", "A-03", 2, False, True, True),
    "513211549229": ("DYS", "A-12", 3, True, True, True),
    "513211540026": ("MON1", "A-01", 2, False, False, False),
    "513211540232": ("MON2", "A-06", 2, False, True, True),
    "BQAFLF1XF01011-B": ("PUR", "A-08", 2, False, True, False),
    "513211549229-B": ("DYS", "A-05", 2, False, True, False),
    "513211540009-B": ("MON1", "A-02", 2, False, True, False),
    "513211540232-B": ("MON2", "A-06", 2, False, True, False),
}

n_img = 0
for code, (pre, loc, nreal, defect, has_loc, has_mat) in PHOTO_SKUS.items():
    for n in range(1, nreal + 1):
        photo_real(pre, code, n).save(os.path.join(OUT, "inspection/listing", f"{code}-{n}.jpg"), quality=88)
        n_img += 1
    if defect:
        photo_defect(pre, code).save(os.path.join(OUT, "inspection/defect", f"{code}-1.jpg"), quality=88)
        n_img += 1
    if has_loc:
        photo_location(code, loc).save(os.path.join(OUT, "sku/location", f"{code}-1.jpg"), quality=86)
        n_img += 1
    if has_mat:
        for m in range(1, 7):
            photo_material(pre, code, m).save(os.path.join(OUT, "sku/product", f"{code}-m{m}.jpg"), quality=88)
            n_img += 1

# 为每个品类前缀生成全量历史库存通用实拍图与商品素材图（供259件真实库存SKU按品牌型号映射）
for pre in ITEMS:
    for n in range(1, 5):
        photo_real(pre, f"SPU-{pre}", n).save(os.path.join(OUT, "inspection/listing", f"GEN-{pre}-{n}.jpg"), quality=86)
        n_img += 1
    photo_location(f"SPU-{pre}", f"B-{list(ITEMS.keys()).index(pre) + 1:02d}").save(
        os.path.join(OUT, "sku/location", f"GEN-{pre}-loc.jpg"), quality=84
    )
    n_img += 1
    for m in range(1, 7):
        photo_material(pre, f"SPU-{pre}", m).save(os.path.join(OUT, "sku/product", f"GEN-{pre}-m{m}.jpg"), quality=86)
        n_img += 1
print("physical & historical pool photos:", n_img)


LIB_SCENES = [
    ("精修主图 · 纯白棚拍正面", (252, 253, 255), (236, 240, 246), 0.96, 0, 0, 0, False),
    ("精修图池 · 评测台斜侧实拍", (242, 238, 230), (216, 208, 196), 0.92, -4, -20, 10, False),
    ("精修图池 · 居家木桌光影", (228, 238, 226), (194, 212, 192), 1.02, 5, 22, 14, True),
    ("精修图池 · 45°侧面窄边框", (232, 238, 248), (196, 210, 232), 1.06, -6, -28, -8, False),
    ("精修图池 · 暗调电竞质感", (36, 42, 56), (18, 22, 32), 0.92, 4, 18, -12, True),
    ("精修图池 · 开箱成色特写", (248, 236, 224), (222, 204, 186), 0.88, 3, -14, 20, False),
    ("精修图池 · 背部接口细节", (236, 234, 246), (206, 200, 226), 0.86, -3, 14, 16, False),
    ("精修图池 · 自然光窗台", (250, 246, 232), (228, 218, 192), 0.96, 4, -18, 8, True),
    ("精修图池 · 极简灰底正侧", (230, 233, 238), (198, 204, 214), 0.94, -3, 12, -8, False),
    ("精修图池 · 点亮屏幕实测", (222, 232, 246), (186, 202, 226), 0.98, 2, -10, 6, False),
    ("精修图池 · 底座支架特写", (240, 238, 234), (210, 206, 198), 1.08, -2, 8, -24, True),
    ("精修图池 · 全套配件合拍", (234, 242, 238), (198, 214, 206), 0.84, 0, 0, 18, False),
]


def photo_lib_good(pre, idx):
    kind, body, c1, c2 = ITEMS[pre]
    label, bg1, bg2, sc, ang, dx, dy, mir = LIB_SCENES[(idx - 1) % len(LIB_SCENES)]
    r = rng_of("lib-good", pre, idx)
    scene = fast_grad(900, 900, bg1, bg2)
    d0 = ImageDraw.Draw(scene, "RGBA")
    d0.ellipse((170, 655, 730, 775), fill=(0, 0, 0, 38))
    layer = draw_object(kind, tuple(max(0, min(255, int(v * r.uniform(0.95, 1.05)))) for v in body), variant=idx)
    place(scene, layer, sc, ang + r.uniform(-1.5, 1.5), dx, dy, mirror=mir)
    tag(scene, label)
    return scene.convert("RGB")


def photo_xianyu_card(pre, idx):
    """36 张互不重复闲鱼搜索流实拍图，含专门的配件单卖、碎屏故障、回收海报、引流噪点卡。"""
    kind, body, c1, c2 = ITEMS[pre]
    r = rng_of("xy-card", pre, idx)

    # 专门的配件单卖噪点图（供快照视觉一眼识别「仅底座/电源线」）
    if idx in (5, 21):
        scene = fast_grad(640, 640, (234, 230, 222), (186, 176, 162))
        d = ImageDraw.Draw(scene, "RGBA")
        d.rectangle((0, 410, 640, 640), fill=(142, 112, 84, 255))
        # 画电源适配器砖块 + 线缆圈
        d.rounded_rectangle((190, 250, 430, 390), 18, fill=(38, 40, 46))
        d.arc((120, 220, 520, 500), 10, 210, fill=(28, 30, 36), width=14)
        d.rounded_rectangle((140, 46, 500, 102), 12, fill=(15, 23, 42, 215))
        d.text((320, 74), "单出原装电源线 / 支架配件", font=font(24), fill=(254, 240, 138), anchor="mm")
        return scene.convert("RGB")

    # 专门的碎屏/坏机配件图
    if idx in (11, 27):
        scene = fast_grad(640, 640, (74, 78, 88), (42, 44, 52))
        layer = draw_object(kind, body, variant=idx).resize((580, 580), Image.LANCZOS)
        scene.paste(layer, (30, 35), layer)
        d = ImageDraw.Draw(scene, "RGBA")
        # 蜘蛛网裂纹 + 彩条花屏线
        cx0, cy0 = 310, 270
        for ang_x, ang_y in ((-160, -110), (170, -95), (-140, 110), (155, 120), (20, -135), (-30, 130)):
            d.line((cx0, cy0, cx0 + ang_x, cy0 + ang_y), fill=(255, 255, 255, 225), width=3)
        for lx in (240, 248, 392):
            d.line((lx, 130, lx, 360), fill=(244, 63, 94, 220), width=3)
        d.rounded_rectangle((150, 540, 490, 594), 10, fill=(185, 28, 28, 230))
        d.text((320, 567), "内屏漏液竖线 · 拆机配件价", font=font(22), fill=(255, 255, 255), anchor="mm")
        return scene.convert("RGB")

    # 专门的回收广告大字报图
    if idx in (14, 30):
        scene = fast_grad(640, 640, (220, 38, 38), (153, 27, 27))
        d = ImageDraw.Draw(scene, "RGBA")
        d.rounded_rectangle((36, 48, 604, 592), 24, fill=(255, 251, 235, 248))
        d.text((320, 175), "全城高价回收", font=font(58), fill=(185, 28, 28), anchor="mm")
        d.text((320, 275), "显示器 · 电脑 · 办公设备", font=font(34), fill=(30, 41, 59), anchor="mm")
        d.rounded_rectangle((110, 355, 530, 435), 16, fill=(245, 158, 11))
        d.text((320, 395), "免费上门估价 · 当场结款", font=font(30), fill=(255, 255, 255), anchor="mm")
        d.text((320, 515), "非卖品 · 拍下不发货", font=font(26), fill=(100, 116, 139), anchor="mm")
        return scene.convert("RGB")

    # 专门的 99 元引流链接图
    if idx in (4, 29):
        scene = fast_grad(640, 640, (254, 243, 199), (253, 224, 71))
        layer = draw_object(kind, body, variant=idx).resize((480, 480), Image.LANCZOS)
        scene.paste(layer, (80, 110), layer)
        d = ImageDraw.Draw(scene, "RGBA")
        d.rectangle((0, 0, 640, 92), fill=(220, 38, 38, 242))
        d.text((320, 46), "¥99 租机押金 / 咨询改价勿直接拍", font=font(28), fill=(255, 255, 255), anchor="mm")
        return scene.convert("RGB")

    palettes = [
        ((232, 226, 216), (172, 146, 118)),
        ((220, 226, 234), (132, 142, 156)),
        ((238, 234, 226), (192, 178, 158)),
        ((64, 68, 78), (38, 40, 48)),
        ((224, 234, 224), (150, 168, 148)),
        ((242, 228, 232), (186, 154, 164)),
        ((246, 240, 224), (198, 172, 132)),
        ((212, 224, 236), (118, 136, 158)),
        ((234, 228, 240), (162, 148, 176)),
        ((82, 74, 68), (48, 42, 38)),
        ((218, 232, 228), (136, 164, 156)),
        ((244, 232, 218), (184, 148, 112)),
    ]
    wall, desk = palettes[(idx - 1) % len(palettes)]
    scene = fast_grad(640, 640, wall, tuple(int(v * 0.9) for v in wall))
    d = ImageDraw.Draw(scene, "RGBA")
    d.rectangle((0, 396 + r.randint(-26, 22), 640, 640), fill=desk + (255,))
    d.ellipse((100, 458, 540, 548), fill=(0, 0, 0, 46))
    body_tint = tuple(max(0, min(255, int(v * r.uniform(0.90, 1.08)))) for v in body)
    layer = draw_object(kind, body_tint, variant=idx).resize((640, 640), Image.LANCZOS)
    if idx % 3 == 0:
        layer = ImageOps.mirror(layer)
    sc = r.uniform(0.82, 1.05)
    if sc != 1.0:
        layer = layer.resize((int(640 * sc), int(640 * sc)), Image.LANCZOS)
    layer = layer.rotate(r.uniform(-6, 6), resample=Image.BICUBIC, expand=False)
    w, h = layer.size
    scene.paste(layer, (320 - w // 2 + r.randint(-28, 28), 320 - h // 2 + r.randint(-12, 28)), layer)
    return scene.convert("RGB")


def photo_lib_bad(pre, mode):
    kind, body, c1, c2 = ITEMS[pre]
    if mode == "wm":
        scene = fast_grad(900, 900, (255, 242, 238), (248, 216, 210))
        layer = draw_object(kind, body)
        place(scene, layer, 0.88, -3, 20, 30)
        d = ImageDraw.Draw(scene, "RGBA")
        d.rectangle((0, 0, 900, 132), fill=(220, 38, 38, 242))
        d.text((450, 66), "双11爆款直降 · 某某旗舰店 · 盗图必究", font=font(36), fill=(255, 244, 180, 255), anchor="mm")
        d.rectangle((0, 774, 900, 900), fill=(234, 88, 12, 238))
        d.text((450, 836), "领券立减 ¥200 · 咨询客服送赠品", font=font(34), fill=(255, 255, 255, 255), anchor="mm")
        for y in (270, 480, 660):
            d.text((450, y), "@某某数码专营店 实拍盗图必究", font=font(32), fill=(220, 38, 38, 110), anchor="mm")
        return scene.convert("RGB")
    if mode == "fuzzy":
        alt_body = ((body[2] + 65) % 240, (body[0] + 75) % 240, (body[1] + 50) % 240)
        scene = fast_grad(900, 900, (236, 240, 244), (208, 216, 224))
        layer = draw_object(kind, alt_body, variant=1)
        place(scene, layer, 0.84, 7, -24, 12, mirror=True)
        tag(scene, "模糊池 · 近邻旧款外观 · 待人工核对")
        return scene.convert("RGB")
    if mode == "small":
        scene = fast_grad(320, 320, (225, 228, 232), (195, 200, 208))
        layer = draw_object(kind, body).resize((260, 260), Image.BILINEAR)
        scene.paste(layer, (30, 24), layer)
        scene = scene.convert("RGB").filter(ImageFilter.GaussianBlur(2.4))
        d = ImageDraw.Draw(scene)
        d.rectangle((0, 276, 320, 320), fill=(15, 23, 42))
        d.text((160, 298), "320x320 低清模糊打回图", font=font(18), fill=(255, 255, 255), anchor="mm")
        return scene
    scene = fast_grad(460, 960, (244, 246, 250), (228, 232, 240))
    d = ImageDraw.Draw(scene, "RGBA")
    d.rectangle((0, 0, 460, 56), fill=(15, 23, 42, 245))
    d.text((230, 28), "14:26  5G  电商详情页长截图", font=font(20), fill=(255, 255, 255, 240), anchor="mm")
    layer = draw_object(kind, body).resize((360, 360), Image.LANCZOS)
    scene.paste(layer, (50, 90), layer)
    for i, y in enumerate(range(490, 880, 68)):
        d.rounded_rectangle((32, y, 428, y + 50), 10, fill=(255, 255, 255, 238))
        d.text((52, y + 25), f"参数规格截屏行 #{i + 1} · 非纯商品图", font=font(19), fill=(71, 85, 105, 255), anchor="lm")
    return scene.convert("RGB")


n_lib = 0
for pre in ITEMS:
    for idx in range(1, 37):
        photo_xianyu_card(pre, idx).save(os.path.join(OUT, f"{pre}-{idx}.jpg"), quality=84)
        n_lib += 1
    for idx in range(1, 13):
        photo_lib_good(pre, idx).save(os.path.join(OUT, "library", f"{pre}-lib-{idx}.jpg"), quality=88)
        n_lib += 1
    for bmode in ("wm", "fuzzy", "small", "long"):
        photo_lib_bad(pre, bmode).save(os.path.join(OUT, "library", f"{pre}-bad-{bmode}.jpg"), quality=84)
        n_lib += 1
for idx in range(1, 37):
    photo_xianyu_card("MON1", idx).save(os.path.join(OUT, f"P-{idx}.jpg"), quality=84)
    n_lib += 1
print("library & 36-card xianyu snapshot photos:", n_lib)


def _fit(d, text, box_w, start, color, y, cx=450, anchor="mm"):
    size = start
    while size > 24:
        f = font(size)
        w = d.textlength(text, font=f)
        if w <= box_w:
            break
        size -= 4
    d.text((cx, y), text, font=font(size), fill=color, anchor=anchor)


VIRT = {
    "mcd": ("麦当劳", "双堡双人餐电子券", (200, 20, 30), (255, 190, 30), "M"),
    "kfc": ("肯德基", "随心配 2+1 单人餐", (190, 20, 40), (240, 90, 80), "K"),
    "pzh": ("必胜客", "双人套餐 9 件套", (190, 30, 30), (110, 160, 60), "必"),
    "dmn": ("达美乐", "四人餐 · 含配送", (0, 102, 178), (0, 150, 230), "达"),
    "wls": ("华莱士", "双人随心拼 · 温州", (200, 30, 30), (250, 180, 40), "华"),
    "jp": ("花潮日料自助", "温州滨江万象城 · 一位", (120, 30, 60), (220, 120, 130), "日"),
    "xdq": ("雪窦山", "雪窦寺 成人门票", (30, 100, 70), (120, 190, 140), "景"),
    "tz": ("台州中盛", "餐饮优惠线索", (80, 70, 140), (150, 140, 210), "台"),
    "ppt": ("AI PPT 代做", "基础 / 标准 / 高级", (200, 90, 30), (250, 170, 90), "P"),
    "xhs": ("小红书笔记", "种草图文代写", (220, 40, 70), (250, 120, 140), "红"),
    "vid": ("短视频代剪", "15–30 秒 商品展示", (40, 40, 60), (110, 110, 160), "剪"),
    "starbucks": ("星巴克", "中杯饮品券", (0, 98, 65), (0, 140, 90), "星"),
    "dominos": ("达美乐", "100 元代金券", (0, 102, 178), (0, 150, 230), "达"),
    "greentea": ("绿茶餐厅", "生日 · 免费甜品", (46, 125, 50), (129, 199, 132), "绿"),
    "jdcard": ("京东 E 卡", "200 元电子卡", (200, 20, 30), (255, 90, 70), "京"),
    "clean_jd": ("京东到家", "2 小时标准保洁", (230, 60, 50), (255, 140, 90), "家"),
    "clean_mt": ("美团保洁", "2 小时标准保洁", (255, 190, 0), (255, 225, 90), "美"),
    "bus_tokyo": ("东京 · 关东大巴", "1 日自由乘车", (30, 60, 140), (90, 130, 220), "巴"),
    "local_fuyang": ("麓山时代", "100 元 5 折券 · 杭州富阳", (140, 40, 120), (230, 100, 180), "麓"),
    "chatgpt": ("ChatGPT Plus", "月卡代充", (16, 120, 100), (60, 190, 160), "G"),
    "claude": ("Claude Pro", "月卡代充", (190, 90, 50), (240, 150, 100), "C"),
    "steam": ("Steam", "充值卡 50 元", (20, 40, 70), (60, 100, 150), "S"),
    "svc": ("新服务", "待立项 · 学习中", (50, 60, 90), (110, 130, 190), "服"),
    "game": ("三角洲行动", "虚拟化报警 · 远程处理", (24, 40, 70), (70, 120, 190), "游"),
    "flash": ("安卓刷机", "到店 / 远程 · 1 台", (40, 50, 70), (90, 110, 150), "机"),
    "cad": ("CAD 描图", "代画 · 1 张图纸", (60, 70, 90), (120, 140, 170), "图"),
    "bnb": ("民宿图精修", "真实照片 · 10 张", (200, 110, 80), (245, 180, 140), "宿"),
    "points": ("积分预约码", "京东权益 · 预约 1 次", (150, 40, 60), (230, 100, 110), "积"),
}
for key, (title, sub, c1, c2, ch) in VIRT.items():
    img = grad(900, 900, c1, c2).convert("RGBA")
    d = ImageDraw.Draw(img, "RGBA")
    d.ellipse((520, -160, 1060, 380), fill=(255, 255, 255, 30))
    d.ellipse((-200, 560, 380, 1100), fill=(0, 0, 0, 26))
    x0, y0, x1, y1 = 110, 190, 790, 710
    d.rounded_rectangle((x0 + 8, y0 + 14, x1 + 8, y1 + 14), 36, fill=(0, 0, 0, 50))
    d.rounded_rectangle((x0, y0, x1, y1), 36, fill=(255, 255, 255, 245))
    for cy in (450,):
        d.ellipse((x0 - 34, cy - 34, x0 + 34, cy + 34), fill=c1 + (255,))
        d.ellipse((x1 - 34, cy - 34, x1 + 34, cy + 34), fill=c2 + (255,))
    for x in range(x0 + 60, x1 - 50, 26):
        d.line((x, 450, x + 12, 450), fill=(0, 0, 0, 40), width=3)
    d.ellipse((x0 + 56, y0 + 50, x0 + 176, y0 + 170), fill=c1 + (255,))
    d.text((x0 + 116, y0 + 110), ch, font=font(64), fill=(255, 255, 255), anchor="mm")
    d.text((x0 + 210, y0 + 90), "电子卡券", font=font(30), fill=(0, 0, 0, 95), anchor="lm")
    _fit(d, title, 560, 76, tuple(int(v * 0.8) for v in c1), 392, cx=450)
    _fit(d, sub, 560, 40, (60, 60, 70), 520, cx=450)
    d.text((x0 + 56, 660), "NO. VC-AUTO", font=font(26), fill=(0, 0, 0, 90), anchor="lm")
    d.text((x1 - 56, 660), "自动秒发", font=font(26), fill=(0, 0, 0, 90), anchor="rm")
    img.convert("RGB").save(os.path.join(OUT, f"V-{key}.jpg"), quality=88)
print("virtual covers:", len(VIRT))
