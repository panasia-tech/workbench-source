"""闲鱼「回聊天」流程(1b):消息 tab → 按 peer_key 定位会话 → 输入文本并发送 → 回读校验。

ChatReplySpec: {conversation_id: str, peer_key: str, text: str}

定位会话与 1a 读链路同法:消息列表逐行进,顶栏「会员名:<掩码>」比对 peer_key。
发送 = 点输入框聚焦 → set_text(原生框)/ime_input 注入(Flutter 框) → 点「发送」→ 回读末条 out 气泡校验。

原则:**宁可失败也绝不盲发/重发**。发送后回读不到刚发的文本时,报「未确认」失败交人工核对
(消息可能已发出也可能没有,自动重试=重复发送),不自动重试。
"""
import time

from app.chat_parse import parse_chat_page, parse_conversation_list
from app.flow.engine import Engine, RiskHit, StepError
from app.flow.read_chats import _flat, _open_messages


def _enter_conversation(e: Engine, peer_key: str, max_rows: int = 8) -> bool:
    """会话列表逐行进,顶栏会员名比对 peer_key。找到即停在会话页;找不到退回列表返回 False。"""
    w, h = e.width, e.height
    rows = parse_conversation_list(_flat(e.t.dump_nodes()), w, h)[:max_rows]
    for row in rows:
        e.tap_xy(w // 2, row["row_cy"], settle=2.0)
        page = parse_chat_page(_flat(e.t.dump_nodes()), w, h)
        if page.get("peer_key") == peer_key:
            return True
        e.t.key("BACK")
        time.sleep(1.2)
    return False


def _has_text_node(e: Engine, text: str) -> bool:
    """输入框里是否已有目标文本(Flutter 会把输入内容渲染成 desc=文本 的节点)。"""
    return any((n.get("desc") or "") == text for n in e.t.dump_nodes())


def _ime_inject(e: Engine, text: str) -> None:
    """IME 注入(Flutter 唯一可靠路径,见 transport.ime_commit;2026-07-29 真机定案)。

    群控机装机时经 adb 把内置微型 IME 设为默认输入法(无人值守设备不需要软键盘,
    免切换、免权限);注入丢焦点则补点聚焦后再来一针。
    """
    try:
        e.t.ime_commit(text)
        time.sleep(0.8)
        if _has_text_node(e, text):
            return
    except Exception:
        pass
    hit = e.find_node("想跟TA说")
    if hit:
        e.tap_xy(*hit["center"], settle=1.2)
    try:
        e.t.ime_commit(text)
        time.sleep(0.8)
    except Exception:
        pass


def _send_text(e: Engine, text: str) -> None:
    # 点输入框聚焦并弹键盘(「想跟TA说…」是输入框 hint,1a chrome 词表同款)
    hit = e.find_node("想跟TA说")
    if not hit:
        raise StepError("reply_focus", "未找到聊天输入框", e.save_shot("reply_no_input"))
    e.tap_xy(*hit["center"], settle=1.5)
    # 优先 set_text(原生 EditText);Flutter 输入框 ACTION_SET_TEXT 不可写(2026-07-26 实测),
    # 退 IME 注入(commitText,2026-07-28 定案;剪贴板+长按粘贴路线同日实测被 Flutter 封堵)
    try:
        e.t.set_text(text)
        time.sleep(0.8)
        written = _has_text_node(e, text)
    except Exception:
        written = False
    if not written:
        _ime_inject(e, text)
    if not _has_text_node(e, text):
        raise StepError("reply_input", "文本未写入输入框(set_text/IME 注入均未生效)",
                        e.save_shot("reply_input_fail"))
    if not e.t.node_click("发送"):
        # 语义点击失败兜底:按 desc 找「发送」节点坐标点
        e.tap_node_by_desc("发送", "reply_send", timeout=4)
    time.sleep(1.5)


def _verify_sent(e: Engine, text: str, retries: int = 6) -> bool:
    """校验刚发的文本已上屏(气泡/会话列表预览)。

    不用 1a 的方向启发式判 out:长文本气泡横跨 0.35w 中线会被误判成 in(2026-07-29 实测,
    消息其实已发出)。gc IME 下聊天页气泡的语义节点上屏极慢(分钟级),但**会话列表预览节点
    即时刷新且 desc 带全文**(视觉截断而已)——故页内快查不到就 BACK 回列表校验预览。
    gc IME(无键盘)下输入框挂在 cy≈82,落在聊天区窗口(10%~90%)之外,窗口内命中即气泡/预览。
    """
    top, bottom = e.height * 0.10, e.height * 0.90
    for i in range(retries):
        if i:
            time.sleep(1.5)
        for n in _flat(e.t.dump_nodes()):
            t = (n.get("desc") or "").strip()
            if not t or not (top < n["cy"] < bottom):
                continue
            # 精确匹配不限长度;包含匹配要求节点文本 ≥4 字,防短词误命中 chrome
            if t == text or (len(t) >= 4 and (t in text or text in t)):
                return True
        if i == 2:
            # 页内读不到(语义延迟)→ 退回会话列表,用即时刷新的预览节点校验
            e.t.key("BACK")
            time.sleep(1.5)
    return False


def run_reply_chat(transport, spec: dict, shot_sink=None) -> dict:
    from app.flow.publish_flow import reset_to_clean
    e = Engine(transport, shot_sink=shot_sink)
    spec = spec or {}
    peer_key = spec.get("peer_key") or ""
    text = (spec.get("text") or "").strip()
    try:
        if spec.get("media"):
            # 安卓推图只做了相册写 jpg(发布用),聊天里选图发送没做过,宁可失败也别乱点
            raise StepError("reply_media", "安卓号还不能在聊天里发图片和视频,请用浏览器号的会话发")
        if not peer_key or not text:
            raise StepError("reply_spec", "spec 缺 peer_key 或 text")
        _open_messages(e)
        if not _enter_conversation(e, peer_key):
            raise StepError("reply_find", f"前 8 行会话未找到 peer={peer_key}",
                            e.save_shot("reply_no_conv"))
        _send_text(e, text)
        if not _verify_sent(e, text):
            # 未确认=可能已发出也可能没有。自动重试会重复发送,报失败交人工核对,勿重发。
            raise StepError("reply_verify",
                            "发送后未回读到该消息(可能已发出,请人工核对,勿重发)",
                            e.save_shot("reply_unverified"))
        result = {"ok": True, "done": ["reply_chat"], "failed_step": None,
                  "reason": None, "shot": None, "risk": None}
    except RiskHit as ex:
        result = {"ok": False, "done": [], "failed_step": "reply_chat",
                  "reason": str(ex), "shot": ex.shot, "risk": ex.anchor}
    except StepError as ex:
        result = {"ok": False, "done": [], "failed_step": ex.step,
                  "reason": ex.reason, "shot": ex.shot, "risk": None}
    reset_to_clean(e)
    return result
