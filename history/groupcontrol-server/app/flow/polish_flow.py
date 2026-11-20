"""闲鱼「一键擦亮」流程(账号级):我的 → 我发布的 →(默认在卖 tab)→ 点「一键擦亮」。

擦亮刷曝光、不改 Listing。今日已擦亮/置灰 → 视为成功(每日有次数上限)。
PolishSpec: {}(账号级,无需商品参数)
"""

from app.flow.delist_flow import open_my_published, select_tab
from app.flow.engine import Engine, StepError


def step_polish(e: Engine, spec: dict) -> None:
    open_my_published(e)
    select_tab(e, "在卖", "polish")  # 擦亮按钮在在卖 tab 页顶
    hit = e.find_any(["一键擦亮", "已擦亮", "今日已擦亮"], timeout=6)
    if not hit:
        raise StepError("polish", "未找到擦亮按钮", e.save_shot("miss_polish"))
    label, node = hit
    if label == "一键擦亮":
        e.tap_xy(*node["center"], settle=1.5)
        e.dismiss_nuisance()  # 擦亮后可能弹推广/成功提示
    # 「已擦亮/今日已擦亮」→ 已刷过,直接算成功


STEPS = [
    ("polish", step_polish),
]


def run_polish(transport, spec: dict, shot_sink=None) -> dict:
    from app.flow.publish_flow import reset_to_clean
    e = Engine(transport, shot_sink=shot_sink)
    result = e.run(STEPS, spec)
    reset_to_clean(e)
    return result
