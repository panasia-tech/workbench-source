"""生成 AdsPower 群控模块所需的演示截图（Playwright 现场异常截图、15:30 小铺数据留存截图、验机质检图）。"""
import os
from PIL import Image, ImageDraw, ImageFont

FONT = None
for p in ("/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/STHeiti Medium.ttc", "/Library/Fonts/Arial Unicode.ttf"):
    if os.path.exists(p):
        FONT = p
        break


def fnt(sz: int):
    return ImageFont.truetype(FONT, sz) if FONT else ImageFont.load_default()


def browser_frame(title_url: str, env_badge: str, w=960, h=600):
    img = Image.new("RGB", (w, h), (244, 246, 251))
    d = ImageDraw.Draw(img)
    # Top Chrome / AdsPower bar
    d.rectangle((0, 0, w, 52), fill=(30, 41, 59))
    for i, col in enumerate(((239, 68, 68), (245, 158, 11), (16, 185, 129))):
        d.ellipse((18 + i * 22, 19, 32 + i * 22, 33), fill=col)
    d.rounded_rectangle((96, 10, w - 230, 42), 10, fill=(51, 65, 85))
    d.text((112, 16), title_url, fill=(226, 232, 240), font=fnt(16))
    d.rounded_rectangle((w - 216, 10, w - 16, 42), 10, fill=(37, 99, 235))
    d.text((w - 204, 16), env_badge, fill=(255, 255, 255), font=fnt(15))
    return img, d


def gen_all(out_dir: str):
    os.makedirs(out_dir, exist_ok=True)

    # 1. GC-ERR-PUNISH.jpg — 命中风控滑块 punish iframe
    img, d = browser_frame("https://www.goofish.com/publish  [CDP 接管]", "AdsPower #k1j4r7tw")
    d.rounded_rectangle((180, 120, 780, 490), 22, fill=(255, 255, 255), outline=(251, 191, 36), width=3)
    d.rounded_rectangle((180, 120, 780, 186), 22, fill=(254, 243, 199))
    d.text((215, 140), "⚠ 闲鱼安全验证（punish iframe 已捕获）", fill=(146, 64, 14), font=fnt(24))
    d.text((215, 215), "检测到操作频率波动，请拖动下方滑块完成安全验证：", fill=(51, 65, 85), font=fnt(19))
    d.rounded_rectangle((215, 270, 745, 326), 14, fill=(241, 245, 249), outline=(203, 213, 225), width=2)
    d.rounded_rectangle((217, 272, 285, 324), 12, fill=(245, 158, 11))
    d.text((242, 284), ">>", fill=(255, 255, 255), font=fnt(22))
    d.text((335, 286), "向右滑动验证（群控策略：严禁脚本硬闯滑块）", fill=(100, 116, 139), font=fnt(17))
    d.rounded_rectangle((215, 365, 745, 455), 14, fill=(254, 242, 242))
    d.text((235, 380), "gc-ads 守护动作：已立即停止点击并触发 18 分钟冷却熔断", fill=(185, 28, 28), font=fnt(18))
    d.text((235, 414), "截图时间：今日 14:22:09 · 冷却结束后可一键重排或人工开窗检查", fill=(127, 29, 29), font=fnt(15))
    img.save(os.path.join(out_dir, "GC-ERR-PUNISH.jpg"), quality=88)

    # 2. GC-ERR-WUYOU.jpg — 无忧卖下架拦截
    img, d = browser_frame("https://www.goofish.com/item?id=89412039812", "AdsPower #k1j2m8pq")
    d.rounded_rectangle((80, 90, 880, 520), 20, fill=(255, 255, 255))
    d.text((115, 118), "戴森 HT01 Airstrait 吹风直发器 95新　¥1,650", fill=(15, 23, 42), font=fnt(24))
    d.rounded_rectangle((115, 165, 265, 202), 8, fill=(239, 246, 255))
    d.text((130, 173), "已加入「无忧卖」", fill=(29, 78, 216), font=fnt(16))
    # Toast modal
    d.rounded_rectangle((210, 245, 750, 435), 20, fill=(15, 23, 42))
    d.text((248, 278), "✕ 网页版下架被平台拦截（终态，不自动重试）", fill=(248, 113, 113), font=fnt(21))
    d.text((248, 322), "平台提示：「该宝贝已加入无忧卖，请前往闲鱼 App", fill=(241, 245, 249), font=fnt(18))
    d.text((248, 354), "『无忧卖 - 售卖中』操作下架或通过闲管家 API 同步」", fill=(241, 245, 249), font=fnt(18))
    d.text((248, 394), "定位步骤：goods_delist -> click_delist_confirm", fill=(148, 163, 184), font=fnt(15))
    img.save(os.path.join(out_dir, "GC-ERR-WUYOU.jpg"), quality=88)

    # 3. GC-ERR-LOGIN.jpg — 登录态失效
    img, d = browser_frame("https://www.goofish.com/im  [self_check 失败]", "AdsPower #k1j6q9lm")
    d.rounded_rectangle((200, 130, 760, 480), 22, fill=(255, 255, 255), outline=(239, 68, 68), width=3)
    d.text((245, 168), "🔒 闲鱼网页版登录会话已过期", fill=(185, 28, 28), font=fnt(26))
    d.text((245, 224), "当前窗口 Cookie 已超过有效期，页面跳转至扫码/短信登录框。", fill=(71, 85, 105), font=fnt(18))
    d.rounded_rectangle((245, 275, 715, 395), 14, fill=(248, 250, 252))
    d.text((268, 295), "处理指引（免明文密码托管）：", fill=(15, 23, 42), font=fnt(18))
    d.text((268, 328), "1. 点击工作台「一键唤起 AdsPower 专窗」自动填充账号", fill=(51, 65, 85), font=fnt(16))
    d.text((268, 358), "2. 点击「领 6 位动态码」完成二次验证，看门狗自动恢复任务", fill=(51, 65, 85), font=fnt(16))
    img.save(os.path.join(out_dir, "GC-ERR-LOGIN.jpg"), quality=88)

    # 4. GC-SHOP-OVW.jpg — 15:30 小铺数据总览原图留存
    img, d = browser_frame("https://www.goofish.com/myseller/datacenter/overview", "15:32 自动抓拍留存")
    d.rounded_rectangle((40, 76, 920, 560), 20, fill=(255, 255, 255))
    d.text((70, 98), "闲鱼小铺数据 · 经营概览（近 7 天快照）", fill=(15, 23, 42), font=fnt(24))
    d.text((620, 104), "数据更新至昨日 24:00 · 原图留档", fill=(100, 116, 139), font=fnt(15))
    cards = [
        ("访问次数", "2,973", "+14.2%"),
        ("商品曝光次数", "14,261", "+18.6%"),
        ("商品浏览次数", "2,310", "+9.4%"),
        ("支付金额 (¥)", "6,146.00", "+22.0%"),
    ]
    for idx, (k, v, chg) in enumerate(cards):
        x = 70 + idx * 210
        d.rounded_rectangle((x, 152, x + 194, 268), 16, fill=(248, 250, 252), outline=(226, 232, 240))
        d.text((x + 18, 168), k, fill=(100, 116, 139), font=fnt(15))
        d.text((x + 18, 198), v, fill=(15, 23, 42), font=fnt(26))
        d.text((x + 18, 236), f"较前7日 {chg}", fill=(5, 150, 105), font=fnt(14))
    # Trend chart
    d.text((70, 296), "近 7 日曝光与浏览趋势（自动截图归档，防漏抓）", fill=(51, 65, 85), font=fnt(17))
    d.rounded_rectangle((70, 330, 890, 526), 16, fill=(248, 250, 252))
    pts = [(110, 480), (230, 455), (350, 462), (470, 410), (590, 395), (710, 372), (840, 355)]
    d.line(pts, fill=(37, 99, 235), width=5)
    for px, py in pts:
        d.ellipse((px - 6, py - 6, px + 6, py + 6), fill=(37, 99, 235))
    img.save(os.path.join(out_dir, "GC-SHOP-OVW.jpg"), quality=88)

    # 5. GC-SHOP-FUNNEL.jpg — 15:30 交易漏斗与流量来源原图
    img, d = browser_frame("https://www.goofish.com/myseller/datacenter/trade", "15:32 自动抓拍留存")
    d.rounded_rectangle((40, 76, 920, 560), 20, fill=(255, 255, 255))
    d.text((70, 98), "商品与交易转化漏斗 + 浏览来源占比", fill=(15, 23, 42), font=fnt(24))
    stages = [
        ("1. 商品曝光人数 UV", "6,787 人", 760, (219, 234, 254), (30, 64, 175)),
        ("2. 商品浏览人数 UV（点击率 13.7%）", "928 人", 580, (191, 219, 254), (30, 64, 175)),
        ("3. 询单会话人次（询单率 4.4%）", "41 人", 410, (167, 243, 208), (6, 95, 70)),
        ("4. 成交支付人数（静默+询单转化）", "11 单 · ¥18,420", 290, (110, 231, 183), (6, 78, 59)),
    ]
    for i, (lb, val, bar_w, bg, fg) in enumerate(stages):
        y = 158 + i * 74
        d.rounded_rectangle((70, y, 70 + bar_w, y + 56), 14, fill=bg)
        d.text((90, y + 16), f"{lb}   —   {val}", fill=fg, font=fnt(18))
    d.text((70, 472), "流量来源：搜索 78.74%  ｜  闲鱼号主页 13.59%  ｜  猜你喜欢 6.11%  ｜  其他 1.56%", fill=(51, 65, 85), font=fnt(17))
    img.save(os.path.join(out_dir, "GC-SHOP-FUNNEL.jpg"), quality=88)

    # 6. GC-SHOP-CS.jpg — 15:30 客服响应监控原图
    img, d = browser_frame("https://www.goofish.com/myseller/datacenter/service", "15:33 自动抓拍留存")
    d.rounded_rectangle((40, 76, 920, 560), 20, fill=(255, 255, 255))
    d.text((70, 98), "客服核心监控（3 分钟人工/智能体响应率）", fill=(15, 23, 42), font=fnt(24))
    cs_cards = [
        ("咨询人数 UV", "31"),
        ("接待会话量", "32"),
        ("平均首次响应", "1分48秒"),
        ("3分钟响应率", "88.4%"),
    ]
    for idx, (k, v) in enumerate(cs_cards):
        x = 70 + idx * 210
        d.rounded_rectangle((x, 160, x + 194, 285), 16, fill=(240, 253, 244), outline=(134, 239, 172))
        d.text((x + 18, 180), k, fill=(22, 101, 52), font=fnt(16))
        d.text((x + 18, 218), v, fill=(20, 83, 45), font=fnt(28))
    d.rounded_rectangle((70, 320, 890, 510), 16, fill=(248, 250, 252))
    d.text((95, 348), "AdsPower 消息门铃（im_watch.py）加速效果：", fill=(15, 23, 42), font=fnt(19))
    d.text((95, 388), "• 常驻 /im 页面实时监听未读角标与 WS 帧，新消息到达 < 2 秒触发 chat_scan", fill=(51, 65, 85), font=fnt(17))
    d.text((95, 424), "• 彻底消除旧版 300 秒轮询延迟，保障 3 分钟响应率稳定 ≥ 85%", fill=(51, 65, 85), font=fnt(17))
    img.save(os.path.join(out_dir, "GC-SHOP-CS.jpg"), quality=88)

    # 7. GC-QC-REPORT.jpg — ERP 验机质检报告单（供聊天 + 号 10 宫格一键发给买家）
    qc = Image.new("RGB", (760, 540), (255, 255, 255))
    qd = ImageDraw.Draw(qc)
    qd.rectangle((0, 0, 760, 74), fill=(15, 23, 42))
    qd.text((32, 22), "泛亚 ERP · 入库真机质检与功能核验单（买家可见版）", fill=(255, 255, 255), font=fnt(22))
    rows = [
        ("核验结论", "✓ 全部功能检测通过 · 实拍一机一码留档"),
        ("外观成色", "95 新（边框无磕碰，屏幕无坏点/无老化暗斑）"),
        ("核心功能", "接口满血正常 / 按键灵敏 / 烤机温控稳定 / 序列号已核验"),
        ("售后保障", "签收 48 小时功能异常包退换 · 顺丰/京东加固防震发出"),
    ]
    for i, (k, v) in enumerate(rows):
        y = 104 + i * 86
        qd.rounded_rectangle((32, y, 728, y + 70), 14, fill=(248, 250, 252), outline=(226, 232, 240))
        qd.text((52, y + 22), k, fill=(100, 116, 139), font=fnt(17))
        qd.text((178, y + 22), v, fill=(15, 23, 42), font=fnt(18))
    qd.text((32, 475), "注：本图不含任何仓库库位隐私码与采购成本信息，可安全发给闲鱼买家。", fill=(5, 150, 105), font=fnt(15))
    qc.save(os.path.join(out_dir, "GC-QC-REPORT.jpg"), quality=90)


if __name__ == "__main__":
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo-img")
    gen_all(here)
    cache_dir = os.path.expanduser("~/Library/Caches/panasia-gallery-stitch-20261113/demo-img")
    if os.path.isdir(os.path.dirname(cache_dir)):
        gen_all(cache_dir)
    print("Generated 7 GC demo images successfully.")
