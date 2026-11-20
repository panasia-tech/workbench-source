"""闲鱼网页版「回聊天」流程:AdsPower 浏览器 goto /im → 登录态检查 → 按 peer_key 逐行定位会话
→ 输入文本 → (dry_run 到此为止)/点发送 → 回读最新 out 消息校验。

与手机版 app/flow/reply_chat.py 同业务语义(宁可失败绝不盲重发),与 read_chats_web.py 同构
(同一 Transport 原语、同一 result schema)。ChatReplySpec: {conversation_id, peer_key, text, dry_run}。

web 语义差异(2026-09-09 实测,侦察见 scripts/web_sendbtn_recon.py + adspower-executor/docs/recon-notes.md):
- peer_key 网页版 = 顶栏「闲鱼号」a[href*="personal?userId="] 的数字 userId,兼容掩码会员名 (t***2)。
- 定位会话:列表(rc-virtual-list 虚拟滚动)逐行点进候选会话,读顶栏 peer_key 比对,不匹配继续下一行;
  扫完可见行向下滚轮翻行,最多扫 20 行。SPA 页内切换,回列表无需 BACK。
- 输入:点 textarea 聚焦 → set_text(insert_text 中文安全)→ dump 回读 textarea desc==text。
- 发送按钮:div[class*="sendbox-bottom--"] 内 button.ant-btn(内 span desc「发 送」),
  空框时也渲染;优先点 button 节点(span 几何有毛刺,2026-09-09 实测 h=280)。
  按钮按 cls 认:local_transport 带标签名前缀("button ant-btn …"),执行端 dump 是原样
  className("ant-btn …"),两种都认(见 _is_button)。
- 发送后回读:/im 消息列表**最新在底部**,parse_chat_page_web 的 messages 按 cy 升序 = 老→新。
  发送前先数会话里和这句同文的 out 有几条,发送后多出一条才算发出(同一句话第二次发也核得出);
  对不上 → 报「未确认」失败交人工核对,绝不自动重发。
- dry_run=true:跑到「文本已填入并回读一致」为止,不点发送,done=["reply_chat_dry_run"]。
- 风控锚点:dump 文本命中 RISK_ANCHORS/滑块文案 → RiskHit,绝不过滑块。动作间隔 ≥1.5s。
"""
import logging
import os
import time

from app import storage
from app.config import settings
from app.flow.engine import LoginRequired, RiskHit, RISK_ANCHORS
from app.flow.transport import FlowTimeout
from app.flow.web.im_nav import leave_conversation
from app.flow.web.login import recover_login
from app.flow.web.parse import (
    CLS_CONV_ITEM,
    CLS_LOGIN_NICK,
    CLS_MSG_ROW,
    find_login_nick,
    CLS_TEXTAREA,
    CLS_TOPBAR,
    parse_chat_page_web,
    parse_conversation_list_web,
)

logger = logging.getLogger("gc.reply_chat_web")

IM_URL = "https://www.goofish.com/im"
LIST_SCROLL_X = 248           # 列表区横向中心(与 read_chats_web 同)
MAX_SCAN_ROWS = 20            # 定位会话最多点进的行数(对齐需求上限)
LIST_LOAD_WAITS = 6           # 会话列表还没渲染出来时最多等几轮(每轮 _LIST_LOAD_SEC)
_LIST_LOAD_SEC = 2.0
_SETTLE = 1.5                 # 动作间隔下限(风控纪律)

# 发送按钮(2026-09-09 实测 recon):sendbox-bottom 内的 ant-btn
CLS_SENDBOX_BOTTOM = "sendbox-bottom--"


class _Fail(Exception):
    """普通失败:带步骤名,映射 result.failed_step(对齐手机版 StepError)。"""

    def __init__(self, step: str, reason: str, shot: str | None = None):
        super().__init__(f"[{step}] {reason}")
        self.step = step
        self.reason = reason
        self.shot = shot


def _flat(nodes):
    """transport.dump_nodes() 的 {center,size} 元组 → 扁平 {cx,cy,w,h}(与 read_chats_web 同)。"""
    out = []
    for n in nodes:
        c = n.get("center") or (n.get("cx", 0), n.get("cy", 0))
        s = n.get("size") or (n.get("w", 0), n.get("h", 0))
        out.append({
            "desc": n.get("desc", ""), "cls": n.get("cls", ""),
            "clickable": bool(n.get("clickable")),
            "cx": int(c[0]), "cy": int(c[1]), "w": int(s[0]), "h": int(s[1]),
        })
    return out


def _local_shot_sink(name: str, data: bytes) -> str:
    os.makedirs("shots", exist_ok=True)
    path = os.path.join("shots", f"{int(time.time())}_{name}.png")
    with open(path, "wb") as f:
        f.write(data)
    return path


def _check_risk(nodes) -> None:
    """dump 文本命中风控锚点 → RiskHit(文本锚点对网页版足够,不走 OCR)。"""
    for n in nodes:
        t = n.get("desc") or ""
        if not t:
            continue
        for anchor in RISK_ANCHORS:
            if anchor in t:
                raise RiskHit(anchor)


def _ensure_login(t, nodes, h: int, save_shot) -> list:
    """页头有**真实昵称** → 已登录;否则先试快速进入(web/login.py),还没有才 LoginRequired。
    返回最新节点(自救时页面重开过)。

    判定收口在 parse.find_login_nick:未登录时闲鱼**也会**在页头渲染 nick-- 元素,
    文本是「登录」两个字、位置也在页头,光看「元素在且文本非空」会把未登录页判成
    已登录——读聊天于是静默返回 0 个会话(假成功),发消息/上下架则在后面某处报一个
    看不懂的错,而不是那句能直接行动的「未登录」。
    """
    if find_login_nick(nodes, h):
        return nodes
    again = recover_login(t, IM_URL, _flat, _check_risk)
    if again is not None and find_login_nick(again, h):
        return again
    raise LoginRequired("网页版未登录(/im 无账号昵称)",
                        save_shot("login_reply_chat", t.screencap()))


def _norm_key(key: str) -> str:
    """peer_key 归一化:去括号/空白(兼容 (t***2) 写法)。"""
    return (key or "").strip().strip("()（）").strip()


def _peer_match(page: dict, want: str) -> bool:
    """顶栏解析结果与 spec.peer_key 比对:userId 精确,或掩码会员名一致(归一化后)。"""
    want_n = _norm_key(want)
    if not want_n:
        return False
    if _norm_key(page.get("peer_key") or "") == want_n:
        return True
    return _norm_key(page.get("peer_nick") or "") == want_n


def _on_chat_page(nodes) -> bool:
    """真进了聊天页:有 message-topbar-- 且有 textarea(对齐 read_chats_web 校验)。"""
    has_topbar = any(CLS_TOPBAR in (n.get("cls") or "") for n in nodes)
    has_input = any(any(k in (n.get("cls") or "") for k in CLS_TEXTAREA) for n in nodes)
    return has_topbar and has_input


def _enter_conversation(t, peer_key: str, w, h) -> bool:
    """列表逐行点进候选会话,顶栏 userId/掩码会员名比对 peer_key。

    虚拟滚动:扫完可见行未命中 → 列表向下滚轮翻行再扫;总点进行数 ≤ MAX_SCAN_ROWS。
    SPA 页内切换,退回列表=直接点下一行(无 BACK)。找到即停在会话页返回 True。
    """
    tried: set = set()      # (nick, last_message) 已试过的行,防滚动后重复点进
    attempts = 0
    scrolls = 0
    waits = 0
    while attempts < MAX_SCAN_ROWS and scrolls <= 6:
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes)
        rows = [r for r in parse_conversation_list_web(nodes, w, h)
                if (r["nick"], r.get("last_message")) not in tried]
        if not rows and not tried:
            # 一行都没见过=列表还没渲染,不能滚:这一滚就把最新的几行滚过去了,后面只会往更老的翻
            # (11-01 蓝鲸:最新的会话被滚走,点进 20 个别的买家会话后报「未找到」)
            waits += 1
            if waits > LIST_LOAD_WAITS:
                logger.warning("会话列表等了 %d 轮还是空的", LIST_LOAD_WAITS)
                return False
            time.sleep(_LIST_LOAD_SEC)
            continue
        if not rows:
            # 可见行全试过:向下滚列表看更老的会话(对齐 read_chats_web 翻行方向)
            scrolls += 1
            t.swipe(LIST_SCROLL_X, int(h * 0.30), LIST_SCROLL_X, int(h * 0.65))
            time.sleep(_SETTLE)
            continue
        for row in rows:
            if attempts >= MAX_SCAN_ROWS:
                break
            tried.add((row["nick"], row.get("last_message")))
            attempts += 1
            t.tap(row["row_cx"], row["row_cy"])
            time.sleep(2.0)
            page_nodes = _flat(t.dump_nodes())
            _check_risk(page_nodes)
            if not _on_chat_page(page_nodes):
                logger.warning("row=%s 未进入聊天页,跳过", row["nick"])
                time.sleep(_SETTLE)
                continue
            page = parse_chat_page_web(page_nodes, w, h)
            logger.info("进 %s → peer_key=%s peer_nick=%s",
                        row["nick"], page.get("peer_key"), page.get("peer_nick"))
            if page.get("peer_key") and _peer_match(page, peer_key):
                return True
            time.sleep(_SETTLE)   # 不匹配,直接点下一行(SPA,列表常驻)
        # for 跑完仍未 return → 继续 while(滚轮翻行)
    return False


def _text_match(a: str, b: str) -> bool:
    """文本比对:精确相等,或长文本(≥4 字)互相包含(对齐手机版 _verify_sent 容错)。"""
    if a == b:
        return True
    return len(a) >= 4 and len(b) >= 4 and (a in b or b in a)


def _find_textarea(nodes) -> dict | None:
    tas = [n for n in nodes if any(k in (n.get("cls") or "") for k in CLS_TEXTAREA)]
    if not tas:
        return None
    return min(tas, key=lambda n: n["w"] * n["h"])   # 多个命中取最小(真输入框)


def _fill_text(t, text: str, save_shot) -> None:
    """点 textarea 聚焦 → set_text 填入 → dump 回读 textarea desc 校验(对齐手机版写入+校验)。"""
    nodes = _flat(t.dump_nodes())
    _check_risk(nodes)
    ta = _find_textarea(nodes)
    if not ta:
        raise _Fail("reply_focus", "未找到聊天输入框", save_shot("reply_no_input", t.screencap()))
    t.tap(ta["cx"], ta["cy"])
    time.sleep(_SETTLE)
    try:
        t.set_text(text)
    except Exception as ex:
        raise _Fail("reply_input", f"set_text 写入失败:{ex}", save_shot("reply_input_fail", t.screencap()))
    time.sleep(_SETTLE)
    nodes = _flat(t.dump_nodes())
    _check_risk(nodes)
    ta = _find_textarea(nodes)
    written = ta and _text_match((ta.get("desc") or "").strip(), text)
    if not written:
        raise _Fail("reply_input", "文本未写入输入框(set_text 后回读不一致)",
                    save_shot("reply_input_fail", t.screencap()))


def _is_button(n) -> bool:
    """按钮节点。local_transport 的 cls 带标签名前缀("button ant-btn css-…"),执行端 dump 的
    cls 是原样 className("ant-btn css-… ant-btn-default"),元素没 class 才退成标签名("button")。
    原来只认 cls 里有 "button",线上走执行端一直认不出,全靠下面的兜底去点 span(2026-10-18 核实)。
    按词比,不按子串:ant-btn-icon 之类按钮里头的 span 不算。"""
    toks = (n.get("cls") or "").split()
    return bool(toks) and (toks[0] == "button" or "ant-btn" in toks)


def _find_send_button(nodes, h: int) -> dict | None:
    """发送按钮:sendbox-bottom 带内 clickable 的 button.ant-btn(2026-09-09 实测)。

    按钮空框时也渲染;优先取 button 节点(span「发 送」几何有毛刺 h=280,不取)。
    带内取最小面积者防误中容器。两种 dump 格式见 _is_button。
    """
    bands = [n for n in nodes if CLS_SENDBOX_BOTTOM in (n.get("cls") or "")]
    if not bands:
        return None
    band = max(bands, key=lambda n: n["w"] * n["h"])
    bx1 = band["cx"] - band["w"] / 2 - 2
    bx2 = band["cx"] + band["w"] / 2 + 2
    by1 = band["cy"] - band["h"] / 2 - 2
    by2 = band["cy"] + band["h"] / 2 + 2
    cands = [n for n in nodes
             if n.get("clickable") and _is_button(n)
             and bx1 <= n["cx"] <= bx2 and by1 <= n["cy"] <= by2
             and 10 <= n["w"] and 10 <= n["h"] <= 80]
    if not cands:
        # 兜底:带内 desc 去空格后 == 「发送」的节点
        cands = [n for n in nodes
                 if (n.get("desc") or "").replace(" ", "") == "发送"
                 and bx1 <= n["cx"] <= bx2 and by1 <= n["cy"] <= by2]
    if not cands:
        return None
    return min(cands, key=lambda n: n["w"] * n["h"])


def _same_out_count(page: dict, text: str) -> int:
    """会话里和 text 同文的 out 有几条(比对口径同 _text_match)。"""
    return sum(1 for m in page.get("messages", [])
               if m["direction"] == "out" and _text_match(m["text"].strip(), text))


def _send_and_verify(t, text: str, w, h, save_shot) -> None:
    """点发送 → 回读:同文 out 比发送前多出一条才算发出。校验不过 → 未确认失败,绝不盲重发。

    原来拿 outs[0] 当最新一条——可 /im 最新在底部、parse 按 cy 升序,outs[0] 是**最早**那条:
    会话里只要发过消息,新发的就必判失败、不落库(2026-10-18 生产 12 单核实,4 单失败全是
    这个,其中 3 句后来的会话扫描都读回来了,其实都发出去了)。只看最新一条也不够:同一句话
    第二次发,上一条就同文,发没发出去分不出来——所以数条数。
    """
    nodes = _flat(t.dump_nodes())
    _check_risk(nodes)
    btn = _find_send_button(nodes, h)
    if not btn:
        raise _Fail("reply_send", "未找到发送按钮(sendbox-bottom 内无 ant-btn)",
                    save_shot("reply_no_send", t.screencap()))
    # 发送前的底数:dump 带全部已渲染的消息行(视口外的也在),和发送后同一口径
    before = _same_out_count(parse_chat_page_web(nodes, w, h), text)
    t.tap(btn["cx"], btn["cy"])
    time.sleep(2.5)                       # 上屏 + 列表回读窗口
    # 轮询回读:新气泡上屏要一会儿
    for i in range(4):
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes)
        page = parse_chat_page_web(nodes, w, h)
        if _same_out_count(page, text) > before:
            return
        time.sleep(_SETTLE)
    raise _Fail("reply_verify",
                "发送后未回读到该消息(可能已发出,请人工核对,勿重发)",
                save_shot("reply_unverified", t.screencap()))


def _row_count(nodes) -> int:
    """会话里渲染出来的消息行数(文字、图片、视频都是一行)。"""
    return sum(1 for n in nodes if CLS_MSG_ROW in (n.get("cls") or ""))


def _send_media(t, media: list[dict], save_shot) -> None:
    """图片 / 视频:现签下载地址 → 执行端下到本机 → 喂给聊天框的上传控件 → 消息行多出对应条数才算发出。

    ⚠️ 网页版上传控件的选择器、选了文件是直接发出还是还要点确认,都还没在真号上实测过
    (所以 chat_media_enabled 默认关)。回读对不上一律报「未确认」交人工核对,绝不重发。
    """
    if not settings.chat_media_enabled:
        raise _Fail("reply_media", "发图片和视频还没开通")
    if not hasattr(t, "set_input_files"):
        raise _Fail("reply_media", "这个执行端不支持喂文件")
    selector = settings.chat_media_input_selector
    paths: list[str] = []
    try:
        for m in media:
            url = storage.sign_object_url(m.get("key"), expires=1800)
            if not url:
                raise _Fail("reply_media", "存储没配好,签不出下载地址")
            path = t.push_media(url)
            if not path:
                raise _Fail("reply_media", f"文件没下下来:{(m.get('key') or '')[-40:]}")
            paths.append(path)
            time.sleep(0.5)
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes)
        before = _row_count(nodes)
        fed = 0
        while fed < len(paths):
            try:
                # 控件带 multiple 一次全收;不带只收第一个,剩下的一个个喂
                n = t.set_input_files(paths[fed:], selector=selector)
            except Exception as ex:
                raise _Fail("reply_media_find", f"没找到聊天框的上传控件({selector}):{ex}",
                            save_shot("reply_media_no_input", t.screencap()))
            fed += max(1, n)
            time.sleep(_SETTLE)
        for _ in range(8):
            time.sleep(2.5)                   # 上传 + 上屏;视频要更久
            nodes = _flat(t.dump_nodes())
            _check_risk(nodes)
            if _row_count(nodes) >= before + len(paths):
                return
        raise _Fail("reply_verify", "图片视频发出后没回读到(可能已发出,请人工核对,勿重发)",
                    save_shot("reply_media_unverified", t.screencap()))
    finally:
        if paths:
            try:
                t.clear_media(paths)
            except Exception as ex:   # 清临时文件失败不影响结果
                logger.info("清理执行端临时文件失败:%s", ex)


def run_reply_chat_web(transport, spec: dict, shot_sink=None) -> dict:
    t = transport
    save_shot = shot_sink or _local_shot_sink
    spec = spec or {}
    entered = False
    peer_key = spec.get("peer_key") or ""
    text = (spec.get("text") or "").strip()
    media = spec.get("media") or []
    dry_run = bool(spec.get("dry_run", False))
    try:
        if not _norm_key(peer_key) or not (text or media):
            raise _Fail("reply_spec", "spec 缺 peer_key 或 text")
        t.launch_app(IM_URL)                       # launch_app 语义=goto URL
        time.sleep(4)
        w, h = t.screen_size()
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes)
        nodes = _ensure_login(t, nodes, h, save_shot)

        if not _enter_conversation(t, peer_key, w, h):
            raise _Fail("reply_find", f"前 {MAX_SCAN_ROWS} 行会话未找到 peer={peer_key}",
                        save_shot("reply_no_conv", t.screencap()))
        entered = True

        if media:
            if dry_run:
                raise _Fail("reply_spec", "发图片视频不支持试跑")
            _send_media(t, media, save_shot)
            if text:
                # 图片已经到买家那边了:文字这步失败也按「未确认」报,人工补一句,不能整单重发
                try:
                    _fill_text(t, text, save_shot)
                    _send_and_verify(t, text, w, h, save_shot)
                except _Fail as ex:
                    raise _Fail("reply_verify", f"图片已发出,文字没确认发出:{ex.reason}", ex.shot)
            result = {"ok": True, "done": ["reply_chat_media"], "failed_step": None,
                      "reason": None, "shot": None, "risk": None}
            leave_conversation(t)
            return result

        _fill_text(t, text, save_shot)
        if dry_run:
            shot = save_shot("reply_dry_run", t.screencap())
            result = {"ok": True, "done": ["reply_chat_dry_run"], "failed_step": None,
                      "reason": None, "shot": shot, "risk": None}
            leave_conversation(t)
            return result

        _send_and_verify(t, text, w, h, save_shot)
        result = {"ok": True, "done": ["reply_chat"], "failed_step": None,
                  "reason": None, "shot": None, "risk": None}
    except RiskHit as ex:
        result = {"ok": False, "done": [], "failed_step": "reply_chat",
                  "reason": str(ex), "shot": ex.shot, "risk": ex.anchor}
    except LoginRequired as ex:
        result = {"ok": False, "done": [], "failed_step": "reply_chat",
                  "reason": ex.reason, "shot": ex.shot, "risk": None, "login": True}
    except FlowTimeout as ex:
        result = {"ok": False, "done": [], "failed_step": "reply_chat",
                  "reason": str(ex), "shot": None, "risk": None}
    except _Fail as ex:
        result = {"ok": False, "done": [], "failed_step": ex.step,
                  "reason": ex.reason, "shot": ex.shot, "risk": None}
    except Exception as ex:
        logger.warning("reply_chat_web 未预期异常: %s", ex)
        result = {"ok": False, "done": [], "failed_step": "reply_chat",
                  "reason": f"未预期异常:{ex}", "shot": None, "risk": None}
    # 进过会话就退出来(见 im_nav);风控 / 掉登录不动页面,留给人看现场
    if entered and not result.get("risk") and not result.get("login"):
        leave_conversation(t)
    return result
