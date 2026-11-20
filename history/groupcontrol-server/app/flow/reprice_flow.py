"""闲鱼「改价」流程:复用 Engine 的定位 + 数字键盘。

智能调价人工复核后下发:对某 Listing 改成新价。定价键盘直接复用 publish 的 keypad_type
(锚定「确定」黄键推算网格,已真机验证)。

⚠️ 现状:进入「我的-在卖 → 定位商品 → 编辑 → 改价入口」的导航锚点需真机校准(标 TODO);
    一旦到了定价面板,keypad_type 与发布流程完全一致,可靠。

RepriceSpec:
{
  "item_id": "...",         # Listing 的闲鱼商品 id
  "title_hint": "AOC 24G2", # 列表定位用
  "new_price": 430          # 新价(元)
}
结果:{ok, done, failed_step, reason, shot, risk}
"""

import time

from app.flow.delist_flow import row_button, step_locate_item, step_open_my_listings
from app.flow.engine import Engine, StepError


def step_open_edit(e: Engine, spec: dict):
    """点目标商品那一行的「编辑」进编辑页(还在在卖列表上,locate_item 只定了行、没点)。

    在卖每张卡片都有自己的「编辑」:以前 find_any 取屏上置信度最高的那个,多件在卖时未必在
    目标行,进去改的就是别的商品的价。现在只点定位到的那一行的(row_button),没定位到就不点。
    """
    # TODO(真机校准):编辑入口文案/位置
    row_y = spec.get("_row_y")
    if not row_y:
        raise StepError("open_edit", "没定位到要改价的商品，没有改价", e.save_shot("reprice_no_row"))
    btn = row_button(e.read(), ("编辑", "修改"), row_y)
    if not btn:
        raise StepError("open_edit", "这件商品那一行没找到「编辑」，没有改价", e.save_shot("miss_edit"))
    e.tap_xy(*btn["center"], settle=1.5)


def step_change_price(e: Engine, spec: dict):
    price = spec.get("new_price")
    if price is None:
        raise StepError("change_price", "缺 new_price")
    # 编辑页价格行:与 publish 同构,滚到发货方式附近再点￥值控件
    e.scroll_to("发货方式", "change_price", max_swipes=5)
    opened = False
    for _ in range(3):
        cands = [it for it in e.read()
                 if ("￥" in it["text"] or "¥" in it["text"]) and it["center"][0] > e.width // 2]
        val = min(cands, key=lambda it: it["center"][1]) if cands else None
        if val:
            e.tap_xy(*val["center"], settle=1.2)
            if e.find("定价", timeout=3):
                opened = True
                break
        e.dismiss_nuisance()
        time.sleep(0.6)
    if not opened:
        raise StepError("change_price", "点价格行未弹出定价面板", e.save_shot("reprice_open"))
    e.keypad_type(int(price), "change_price")  # 复用发布的数字键盘(已真机验证)


def step_save(e: Engine, spec: dict):
    """保存修改。"""
    # TODO(真机校准):保存按钮文案「保存」「完成」「确认修改」
    hit = e.find_any(["保存", "完成", "确认修改"], timeout=6)
    if not hit:
        raise StepError("save", "未找到保存按钮", e.save_shot("miss_save"))
    e.tap_xy(*hit[1]["center"], settle=1.5)


STEPS = [
    ("open_my_listings", step_open_my_listings),
    ("locate_item", step_locate_item),
    ("open_edit", step_open_edit),
    ("change_price", step_change_price),
    ("save", step_save),
]


def run_reprice(transport, spec: dict, shot_sink=None) -> dict:
    from app.flow.publish_flow import reset_to_clean  # 复用复位(按键精灵范式:结束回干净首页)
    e = Engine(transport, shot_sink=shot_sink)
    result = e.run(STEPS, spec)
    reset_to_clean(e)
    return result
