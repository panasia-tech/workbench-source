"""闲鱼「发布商品」流程:字段化 + 声明式步骤 + 异常兜底。

== 发布任务字段 PublishSpec(= 后端 goods_publish 任务的 MQTT payload)==
每个字段对应一个发布步骤,枚举项即该步的不同选择:

{
  "images": ["/local/path", ...],    # 商品图:从 ERP 数据库/OSS 取图 → adb push 到设备 → 加入发布。空=跳过
  "description": "AOC 24G2",          # 只填「型号(+关键成色)」种子;正文文案交闲鱼 AI 生成/识图,不手写长文
  "ai_rewrite": true,                 # 用闲鱼 AI 生成/润色文案(闲鱼会结合图片+型号出标题描述)
  "price": 460,                       # 售价(元)
  "shipping": {
    "mode": "fixed_fee",             # free 包邮 | fixed_fee 不包邮-固定邮费
                                      # | by_distance 不包邮-按距离 | no_ship 无需邮寄
    "fixed_fee": 12,                 # mode=fixed_fee 时的固定邮费
    "self_pickup": true              # 买家自提开关
  },
  "location": null,                   # 所在位置(null=用默认)。TODO
  "worry_free_sell": true,            # 【默认加入无忧卖】老板要求所有商品默认加入;UI 在加图+发布后出现,待定位
  "confirm_publish": false            # true 才真点「发布」(默认 false,只填不发)
}

图片与文案策略(老板口径):**图片从 ERP 数据库取 → 加入发布 → 用闲鱼 AI 结合图片生成文案**,
群控侧不手写长描述,description 只给「型号」种子。

执行结果(供上层映射 MQTT report):
  {ok, done:[已完成步骤], failed_step, reason, shot}  失败带步骤名+原因+截图路径。
"""

import base64
import subprocess
import sys
import time

import erp_image
from xy_engine import Engine, StepError

XIANYU_PKG = "com.taobao.idlefish"

# 发货方式枚举 → OCR 锚点文案
SHIPPING_ANCHOR = {
    "free": "包邮",
    "fixed_fee": "不包邮-固定邮费",
    "by_distance": "不包邮-按距离付费",
    "no_ship": "无需邮寄",
}

# 默认发布规格(dev 自测用)
DEFAULT_SPEC = {
    "images": [],
    "description": "AOC 24G2",
    "ai_rewrite": True,
    "price": 460,
    "shipping": {"mode": "fixed_fee", "fixed_fee": 12, "self_pickup": True},
    "location": None,
    "worry_free_sell": True,   # 默认加入无忧卖
    "confirm_publish": False,
}


# ---------- 中文/文本输入(ADBKeyboard 已装则支持中文)----------
def _has_adbkeyboard(e: Engine) -> bool:
    out = subprocess.run(["adb", "shell", "ime", "list", "-s"], capture_output=True, text=True).stdout
    return "adbkeyboard" in out.lower()


def _input_text(e: Engine, text: str, step: str):
    """输入文本。优先 ADBKeyboard 的 base64 广播(中文/空格都稳);未装则仅支持无空格 ASCII。

    坑:`ADB_INPUT_TEXT --es msg "带 空格"` 会被设备端 shell 按空格拆碎,必须走 base64。
    """
    if _has_adbkeyboard(e):
        e._adb("shell", "ime", "set", "com.android.adbkeyboard/.AdbIME")
        time.sleep(0.4)
        b64 = base64.b64encode(text.encode("utf-8")).decode("ascii")
        subprocess.run(["adb"] + (["-s", e.serial] if e.serial else []) +
                       ["shell", "am", "broadcast", "-a", "ADB_INPUT_B64", "--es", "msg", b64], check=False)
        time.sleep(0.6)
    elif text.isascii() and " " not in text:
        e._adb("shell", "input", "text", text)
    else:
        # 不静默通过,抛异常进异常队列,避免"以为填了其实没填"
        raise StepError(step, "需 ADBKeyboard 输入中文/空格,但未安装", e.save_shot(f"noime_{step}"))


# ---------- 各步骤(fn(engine, spec))----------
def step_open_editor(e: Engine, spec: dict):
    base = ["adb"] + (["-s", e.serial] if e.serial else [])
    e._adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")  # 防息屏黑屏
    subprocess.run(base + ["shell", "am", "force-stop", XIANYU_PKG], capture_output=True)
    time.sleep(1)
    subprocess.run(base + ["shell", "monkey", "-p", XIANYU_PKG, "-c",
                           "android.intent.category.LAUNCHER", "1"], capture_output=True)
    time.sleep(4)
    e.dismiss_nuisance()
    e.tap_text("卖闲置", "open_editor")
    e.tap_text("发闲置", "open_editor")
    # 草稿弹窗:放弃旧草稿,要干净编辑页
    if e.find("未编辑完成", timeout=3):
        e.tap_text("放弃", "open_editor")
        time.sleep(1)
    if not e.wait_any(["添加优质", "描述一下"], timeout=10):
        raise StepError("open_editor", "未进入发布编辑页", e.save_shot("miss_editor"))


def step_images(e: Engine, spec: dict):
    """选图(节点驱动,已真机验证):ERP 图 push 进相册 → 打开选图器 →
    按 content-desc「选择」节点点最新的 N 张 → 下一步 → 完成。加图后闲鱼 AI 自动生成描述。"""
    imgs = spec.get("images") or []
    if not imgs:
        return
    for local in imgs:
        erp_image.push_to_gallery(local, e.serial)
        time.sleep(0.5)
    # 授权媒体(首次需要)
    for p in ("READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO", "READ_EXTERNAL_STORAGE"):
        e._adb("shell", "pm", "grant", XIANYU_PKG, f"android.permission.{p}")
    # 打开选图器
    e.tap_text("添加优质", "images")
    e.require_any(["所有文件", "相册"], "images", timeout=8)
    # 节点选图:每次点第一个「选择」框(=当前最新未选),选够 N 张(我们刚 push 的就是最新 N 张)
    for i in range(len(imgs)):
        e.tap_node_by_desc("选择", "images", index=0)
    e.tap_text("下一步", "images", timeout=6)
    e.tap_text("完成", "images", timeout=6)
    e.require_any(["价格", "发货方式", "描述一下", "AI帮你写好了"], "images", timeout=10)


def step_description(e: Engine, spec: dict):
    text = spec.get("description")
    if not text:
        return
    # 加图后闲鱼 AI 已自动写描述→占位符「描述一下」消失,此时不手填(避免覆盖/追加乱)
    hit = e.find("描述一下", timeout=4)
    if not hit:
        print("[flow] 描述框已有内容(闲鱼AI已生成),跳过手填型号")
        return
    e.tap_xy(*hit["center"], settle=0.8)
    _input_text(e, text, "description")
    e._adb("shell", "input", "keyevent", "KEYCODE_BACK")  # 收键盘
    time.sleep(0.6)


def step_ai_rewrite(e: Engine, spec: dict):
    if not spec.get("ai_rewrite"):
        return
    # 非致命:加图后闲鱼常已自动生成描述给「采用」→点它接受;或点「AI帮你写」;都没有就跳过
    for label in ("采用", "AI帮你写"):
        hit = e.find(label, timeout=2)
        if hit:
            e.tap_xy(*hit["center"], settle=1.2)
            return
    print("[flow] 无「采用/AI帮你写」按钮,跳过(AI 可能已自动应用)")


def _find_price_value(e: Engine) -> dict | None:
    """找编辑页右半边的价格值控件(￥X.XX)。比「价格」二字 OCR 稳。"""
    cands = [it for it in e.read()
             if ("￥" in it["text"] or "¥" in it["text"]) and it["center"][0] > e.width // 2]
    return min(cands, key=lambda it: it["center"][1]) if cands else None


def step_price(e: Engine, spec: dict):
    price = spec.get("price")
    if price is None:
        return
    # 加图/AI后编辑页变长,价格行可能要滚动才可见
    e.scroll_to("发货方式", "price", max_swipes=5)
    # 打开定价面板:点 ￥ 值控件,失败自动重试(编辑页刚加载/OCR 抖动)
    opened = False
    for _ in range(3):
        val = _find_price_value(e)
        if val:
            e.tap_xy(*val["center"], settle=1.2)
            if e.find("定价", timeout=3):
                opened = True
                break
        e.dismiss_nuisance()
        time.sleep(0.6)
    if not opened:
        raise StepError("price", "点价格行未弹出定价面板", e.save_shot("price_open"))
    e.keypad_type(int(price), "price")
    if not e.find_any(["发货方式", "所在位置"], timeout=4):
        raise StepError("price", "填价后未回到编辑页", e.save_shot("price_verify"))


def step_shipping(e: Engine, spec: dict):
    sp = spec.get("shipping") or {}
    mode = sp.get("mode", "fixed_fee")
    anchor = SHIPPING_ANCHOR.get(mode)
    if not anchor:
        raise StepError("shipping", f"未知发货方式 mode={mode}")
    e.scroll_to("发货方式", "shipping", max_swipes=5)
    e.tap_text("发货方式", "shipping")
    # 先开买家自提(此时无键盘遮挡,开关在行右侧)
    if sp.get("self_pickup"):
        row = e.require("买家自提", "shipping")
        e.tap_xy(e.width - 90, row["center"][1], settle=0.6)
    # 选邮寄方式
    e.tap_text(anchor, "shipping")
    # 固定邮费:填数字(应用内键盘)
    if mode == "fixed_fee":
        time.sleep(0.8)
        e.keypad_type(int(sp.get("fixed_fee", 0)), "shipping")
    # 确认整个发货面板
    e.tap_text("确定", "shipping", timeout=5)


def step_location(e: Engine, spec: dict):
    loc = spec.get("location")
    if not loc:
        return  # 用默认
    # TODO: 点「所在位置」→ 搜索/选择 loc
    raise StepError("location", "指定位置流程待实现", e.save_shot("todo_location"))


def step_worry_free(e: Engine, spec: dict):
    """默认加入无忧卖。UI 不在编辑页,实测在**加图+发布后**的流程里出现(具体位置待定位)。
    现为占位:待摸清 UI(需先有图的完整商品)后补 tap「无忧卖/加入」。"""
    if not spec.get("worry_free_sell"):
        return
    e.log_todo = getattr(e, "log_todo", [])
    print("[flow] TODO 无忧卖:默认加入,但 UI 在加图+发布后出现,尚未定位,本步暂跳过")


def step_publish(e: Engine, spec: dict):
    if not spec.get("confirm_publish"):
        return  # 默认只填不发
    e.tap_text("发布", "publish", timeout=5)
    # TODO: 处理发布确认弹窗 + 无忧卖加入(若在此弹) + 回读 itemId(发布成功页/我的-在卖)


STEPS = [
    ("open_editor", step_open_editor),
    ("images", step_images),
    ("description", step_description),
    ("ai_rewrite", step_ai_rewrite),
    ("price", step_price),
    ("shipping", step_shipping),
    ("location", step_location),
    ("worry_free_sell", step_worry_free),
    ("publish", step_publish),
]


def run(spec: dict, serial: str | None = None) -> dict:
    e = Engine(serial=serial)
    # 屏幕尺寸(算开关等右侧坐标)
    out = subprocess.run(["adb"] + (["-s", serial] if serial else []) + ["shell", "wm", "size"],
                         capture_output=True, text=True).stdout
    try:
        wh = out.split(":")[-1].strip().split("x")
        e.width, e.height = int(wh[0]), int(wh[1])
    except Exception:
        e.width, e.height = 1080, 2400
    return e.run(STEPS, spec)


def main():
    spec = dict(DEFAULT_SPEC)
    argv = sys.argv[1:]
    if "--publish" in argv:
        spec["confirm_publish"] = True
    for i, a in enumerate(argv):
        if a == "--price":
            spec["price"] = int(argv[i + 1])
        elif a == "--desc":
            spec["description"] = argv[i + 1]
        elif a == "--no-desc":
            spec["description"] = ""
    result = run(spec)
    print("=== 发布结果 ===")
    for k, v in result.items():
        print(f"  {k}: {v}")
    if not result["ok"]:
        print(f"❌ 失败于「{result['failed_step']}」:{result['reason']}  截图:{result['shot']}")
    else:
        print("✅ 全部步骤完成" + ("(未发布)" if not spec["confirm_publish"] else ""))


if __name__ == "__main__":
    main()
