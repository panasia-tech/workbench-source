"""开场统一前置:检测账号是否已登录闲鱼。

各任务(上架/下架/聊天)开场都是"WAKEUP → force_stop → launch → 找该任务起点锚点"。
以前"到不了起点"一律笼统 StepError,分不清是掉登录还是导航抖动,也不通知人工。
`ensure_logged_in` 就补这块:**只在"找不到起点"的失败分支调用** —— 已登录账号(能找到起点)
绝不会走到这里,故不会误冻结健康账号;命中登录页锚点才升级为 LoginRequired(→ 冻结+通知),
否则原样返回、继续走既有 StepError。

⚠️ LOGOUT_ANCHORS 是"最佳猜测",需一次真机掉登录 dump 确认/补全(和未读角标同款纪律)。
"""
import logging

from app.flow.engine import Engine, LoginRequired

logger = logging.getLogger("gc.ready")

# 闲鱼掉登录/游客态页面锚点(节点或 OCR 命中任一即算掉登录)。真机确认后补全。
LOGOUT_ANCHORS = [
    "立即登录", "一键登录", "新用户登录", "手机号登录", "登录闲鱼",
    "同意并登录", "我是闲鱼新用户", "点击登录", "登录/注册",
]


def _hit(text: str) -> str | None:
    for a in LOGOUT_ANCHORS:
        if a in text:
            return a
    return None


def ensure_logged_in(e: Engine, purpose: str = "task") -> None:
    """判当前是否掉登录:命中登录页锚点 → 抛 LoginRequired;否则静默返回。

    先看节点(快、无 OCR),节点没读到再 OCR 兜底一次。只在开场找不到起点时调用。"""
    try:
        node_text = " ".join((n.get("desc") or "") for n in e.t.dump_nodes())
    except Exception:
        node_text = ""
    a = _hit(node_text)
    if a:
        logger.warning("%s: 节点命中登录页「%s」,判定掉登录", purpose, a)
        raise LoginRequired(f"{purpose}:检测到登录页「{a}」,账号已掉登录", e.save_shot("login_required"))
    # OCR 兜底(登录页多为原生、节点通常够;e.read() 会带风控守卫,风控优先抛 RiskHit)
    try:
        ocr_text = " ".join((it.get("text") or "") for it in e.read())
    except Exception:
        ocr_text = ""
    a = _hit(ocr_text)
    if a:
        logger.warning("%s: OCR 命中登录页「%s」,判定掉登录", purpose, a)
        raise LoginRequired(f"{purpose}:OCR 命中登录页「{a}」,账号已掉登录", e.save_shot("login_required"))
