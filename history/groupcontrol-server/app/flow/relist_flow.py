"""闲鱼「重新上架」流程:我的 → 我发布的 → 已下架 tab → 点目标行的「重新上架」→ 发布编辑页 →「发布」。

已下架 tab = 仓库;重新上架不改 item_id,状态 DELISTED→LIVE。

【2026-07-16 真机校准】关键:点「重新上架」**不是弹确认框**,而是**重开发布编辑页**(商品资料
已预填),必须再点右上「发布」才真上架(→「发布成功」)。已在架过的商品重发通常**不弹无忧卖**,
直接成功。故本流程 = 点「重新上架」打开编辑页 → 复用 publish_flow.step_publish 完成发布(它已
处理「发布」按钮 + 无忧卖弹窗跳过 + 发布成功/待上架判定)。重新上架必真发,故强制 confirm_publish=True。

「重新上架」按钮是文字,OCR 读;点哪一行和下架同一套定位(delist_flow.locate_row_y,名称+价格),
对不上这件商品就失败、不点——已下架只剩一件也一样。

RelistSpec: {item_id, listing_id, title, price, title_hint}
"""

from app.flow.delist_flow import locate_row_y, open_my_published, row_button, select_tab
from app.flow.engine import Engine, StepError


def step_open_offshelf(e: Engine, spec: dict) -> None:
    open_my_published(e)
    select_tab(e, "已下架", "open_offshelf")


def step_relist_open_editor(e: Engine, spec: dict) -> None:
    """点目标商品行的「重新上架」→ 闲鱼重开发布编辑页(预填)。不是确认框(真机校准)。

    定位与下架同一套(locate_row_y:名称+价格,节点优先,对不上就不点)：先在已下架列表里对上
    这件商品的卡片，再点这张卡片上的「重新上架」(row_button 按行挑)。以前已下架只有一个按钮时
    不核对标题直接点——那一件未必是要上的(要上的已被人手动上架/删了、或标题回读错了),点下去就把
    别的商品重新上架了,无法自动回滚。现在不管几件都先对上再点;链接没记标题也一样失败。
    """
    btns = [it for it in e.read() if it["text"].strip() == "重新上架"]
    if not btns:
        raise StepError("relist", "未找到「重新上架」按钮", e.save_shot("miss_relist"))
    row_y = locate_row_y(e, spec, tab="已下架", action="重新上架")
    btn = row_button(btns, ("重新上架",), row_y)
    if not btn:
        # 对上了卡片,它那一行却没认出按钮:不拿离得远的(那是别的卡片的)凑数
        raise StepError("relist", "这件商品那一行没找到「重新上架」，没有重新上架",
                        e.save_shot("relist_btn_far"))
    e.tap_xy(*btn["center"], settle=2.5)


def step_relist_publish(e: Engine, spec: dict) -> None:
    """发布编辑页点「发布」+ 处理无忧卖/成功页。复用 publish_flow.step_publish。
    spec 已在 run_relist 里注入 confirm_publish=True(重新上架必真发)。"""
    from app.flow import publish_flow
    publish_flow.step_publish(e, spec)


STEPS = [
    ("open_offshelf", step_open_offshelf),
    ("relist", step_relist_open_editor),   # 点「重新上架」→ 打开发布编辑页
    ("publish", step_relist_publish),      # 编辑页「发布」+ 弹窗/成功判定
]


def run_relist(transport, spec: dict, shot_sink=None) -> dict:
    from app.flow.publish_flow import reset_to_clean
    spec = {**(spec or {}), "confirm_publish": True}  # 重新上架必真发(不留 dry-run)
    e = Engine(transport, shot_sink=shot_sink)
    result = e.run(STEPS, spec)
    # 透出发布终态(step_publish 可能置 _publish_outcome,如 PENDING_PAYMENT_AUTH)
    result["publish_outcome"] = spec.get("_publish_outcome") or ("SUBMITTED" if result.get("ok") else None)
    reset_to_clean(e)
    return result
