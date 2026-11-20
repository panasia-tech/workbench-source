"""闲鱼网页版「读聊天」流程:AdsPower 浏览器 goto /im → 登录态检查 → 扫未读会话 → 读消息 → 结构化返回。

与手机版 app/flow/read_chats.py 同构(同一 Transport 原语、同一 result schema),
解析在 app/flow/web/parse.py(2026-09-09 AdsPower 实测 DOM)。ChatScanSpec: {max_convs?: int=5}。

web 语义差异:
- launch_app(pkg) 的 pkg 是 URL(https://www.goofish.com/im)。
- 登录态:页头 .nick-- 元素含当前账号昵称;没有 → LoginRequired。
- BACK:会话是 /im 页内打开(URL 不变),key("BACK") 由 transport 决定(no-op 或 go_back);
  左栏会话列表常驻,读完直接点下一个即可。
- 风控锚点:dump 文本命中「验证码/安全验证/账号异常…」→ RiskHit(对齐手机版)。
"""
import logging
import os
import re
import time

from app import storage
from app.config import settings
from app.flow.engine import LoginRequired, RiskHit, RISK_ANCHORS
from app.flow.transport import FlowTimeout
from app.flow.web.login import _bundle_html, recover_login
from app.flow.web.im_nav import leave_conversation
from app.flow.web.parse import (
    CLS_CONV_ITEM,
    CLS_LOGIN_NICK,
    find_login_nick,
    CLS_MSG_LIST,
    CLS_TEXTAREA,
    CLS_TOPBAR,
    parse_chat_page_web,
    parse_conversation_list_web,
)

logger = logging.getLogger("gc.read_chats_web")

IM_URL = "https://www.goofish.com/im"
# 列表区横向范围(左侧栏):dump 里 conversation-item 的中心 cx 即列表中心
LIST_SCROLL_X = 248
_SETTLE = 1.5


def _flat(nodes):
    """transport.dump_nodes() 的 {center,size} 元组 → 扁平 {cx,cy,w,h}(与手机版一致)。
    img 节点的 src 原样透传(商品卡缩略图直取;老执行端 dump 没有该字段)。"""
    out = []
    for n in nodes:
        c = n.get("center") or (n.get("cx", 0), n.get("cy", 0))
        s = n.get("size") or (n.get("w", 0), n.get("h", 0))
        flat = {
            "desc": n.get("desc", ""), "cls": n.get("cls", ""),
            "clickable": bool(n.get("clickable")),
            "cx": int(c[0]), "cy": int(c[1]), "w": int(s[0]), "h": int(s[1]),
        }
        if n.get("src"):
            flat["src"] = n["src"]
        out.append(flat)
    return out


def _local_shot_sink(name: str, data: bytes) -> str:
    os.makedirs("shots", exist_ok=True)
    path = os.path.join("shots", f"{int(time.time())}_{name}.png")
    with open(path, "wb") as f:
        f.write(data)
    return path


# 这个进程里留过 HTML 的会话,一个会话留一份就够
_html_sampled: set[str] = set()


def _sample_chat_html(t, peer_key: str, page: dict) -> str | None:
    """商品 id 或缩略图没读到时,存一份会话页 HTML,对照它改解析。

    商品卡的解析是按猜测写的(11-01 今日 11 个会话只读到 2 个商品 id、0 张缩略图)。
    只读,不点不发;HTML 里有聊天内容,所以限量。留不下来不影响读聊天。
    """
    if page.get("item_id") and page.get("item_image"):
        return None
    if peer_key in _html_sampled or len(_html_sampled) >= settings.chat_html_sample_limit:
        return None
    _html_sampled.add(peer_key)
    try:
        name = re.sub(r"[^0-9A-Za-z_-]", "_", peer_key)
        key = storage.save_blob(f"chat_html_{name}", _bundle_html(t.page_snapshot()).encode(), "html")
        logger.info("会话页 HTML 已留档 peer=%s key=%s", peer_key, key)
        return key
    except Exception as ex:  # 老执行端没有这个原语、页面卡住,都不许拖累读聊天
        logger.warning("会话页 HTML 留档失败 peer=%s: %s", peer_key, ex)
        return None


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
                        save_shot("login_read_chats", t.screencap()))


def _collect_rows(t, w, h) -> list:
    """收会话列表行(含虚拟滚动:未读会话可能在视口外,向下滚轮翻行,按 (nick,last) 去重合并)。"""
    merged: dict = {}

    def add(nodes):
        for r in parse_conversation_list_web(nodes, w, h):
            if r.get("nick"):
                merged.setdefault((r["nick"], r.get("last_message")), r)

    add(_flat(t.dump_nodes()))
    for _ in range(3):
        before = len(merged)
        t.swipe(LIST_SCROLL_X, int(h * 0.30), LIST_SCROLL_X, int(h * 0.65))  # 向下滚(deltaY+)=看更老的会话
        time.sleep(_SETTLE)
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes)
        add(nodes)
        if len(merged) == before:
            break
    # 滚回列表顶部,保证未读行都渲染可点
    for _ in range(4):
        t.swipe(LIST_SCROLL_X, int(h * 0.65), LIST_SCROLL_X, int(h * 0.30))  # 向上滚(deltaY-)=回顶部
        time.sleep(0.8)
    return list(merged.values())


def _locate_row(t, row, w, h):
    """回列表后重新按 nick 定位行(滚动后坐标变了),拿新鲜 row_cy 再点。"""
    nodes = _flat(t.dump_nodes())
    _check_risk(nodes)
    for r in parse_conversation_list_web(nodes, w, h):
        if r["nick"] == row["nick"] and r.get("last_message") == row.get("last_message"):
            return r
    return None


def _on_chat_page(nodes) -> bool:
    """真进了聊天页:有 message-topbar-- 且有 textarea 输入框(对齐手机版 _on_chat_page 校验)。"""
    has_topbar = any(CLS_TOPBAR in (n.get("cls") or "") for n in nodes)
    has_input = any(any(k in (n.get("cls") or "") for k in CLS_TEXTAREA) for n in nodes)
    return has_topbar and has_input


def _read_history(t, w, h) -> list:
    """逐轮 dump(不合并)→ [nodes0, nodes1, ...](loop-until-dry,对齐手机版 _read_history)。

    web 上滚=消息容器滚轮。reverse 列表锚定在底部(最新),deltaY+ 才向顶部加载更早历史
    (2026-09-09 实测:deltaY- 会卸载已渲染行而不加载,DOM 越滚越少)。消息列表
    infinite-scroll,加载更老消息后 React 重排,同一消息在不同轮次坐标会位移——
    所以**不在节点层合并**,交由 _parse_history 按 (direction,text) 并集去重。
    """
    dumps = []
    nodes0 = _flat(t.dump_nodes())
    _check_risk(nodes0)
    lists = [n for n in nodes0 if CLS_MSG_LIST in (n.get("cls") or "")]
    scroll_x = int(lists[0]["cx"]) if lists else int(w * 0.61)
    # 先回到底部(最新):会话记忆上次滚动位置,可能停在历史中间(2026-09-09 实测),
    # reverse 列表 deltaY- = 向底部。到底后再向上加载,保证新旧消息都覆盖。
    for _ in range(3):
        t.swipe(scroll_x, int(h * 0.70), scroll_x, int(h * 0.30), 400)
        time.sleep(0.8)
    nodes0 = _flat(t.dump_nodes())
    _check_risk(nodes0)
    dumps.append(nodes0)
    dry = 0
    rounds = 0
    prev_sig = None
    while dry < 2 and rounds < 12:
        t.swipe(scroll_x, int(h * 0.30), scroll_x, int(h * 0.70), 400)
        time.sleep(1.2)
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes)
        dumps.append(nodes)
        # 「无新增」判定:消息行文本集合没变即干(坐标位移不算新增)
        sig = frozenset((n.get("desc") or "") for n in nodes
                        if "message-row--" in (n.get("cls") or ""))
        dry = dry + 1 if sig == prev_sig else 0
        prev_sig = sig
        rounds += 1
    return dumps


def _parse_history(dumps, w, h) -> dict:
    """对每轮 dump 分别解析,消息按 (direction, text) 并集(坐标随滚动位移,不能用位置去重)。

    页面包(peer_key/peer_nick/item_title/item_price/item_image/item_id)取**最后一轮**(窗口最老、
    含全部加载历史)。消息顺序 = 老→新:最新在底部,每轮 dump 带全部已渲染的行、按 cy 升序
    本就是老→新;往上翻才加载的更早历史只出现在后面几轮,所以**从最后一轮倒着并**。
    原来从第一轮正着并,首扫长会话时更早的历史排到了最新消息后面——jobs 按这个顺序落库,
    兜底判欠回复看的「最后一条」就成了一条老消息,回复率看的先后也跟着乱。
    与手机版一致,完全同文的重复消息入库时也会被 jobs 的 dedup_key 吸收,不丢数据。
    """
    page = {"peer_key": None, "peer_nick": None, "item_title": None,
            "item_price": None, "item_image": None, "item_id": None, "messages": []}
    seen = set()
    for nodes in reversed(dumps):
        p = parse_chat_page_web(nodes, w, h)
        if p.get("peer_key") and not page["peer_key"]:
            page.update(peer_key=p["peer_key"], peer_nick=p.get("peer_nick"),
                        item_title=p.get("item_title"), item_price=p.get("item_price"),
                        item_image=p.get("item_image"), item_id=p.get("item_id"))
        for m in p.get("messages", []):
            k = (m["direction"], m["text"])
            if k in seen:
                continue
            seen.add(k)
            page["messages"].append(m)
    return page


def run_read_chats_web(transport, spec: dict, shot_sink=None) -> dict:
    t = transport
    save_shot = shot_sink or _local_shot_sink
    max_convs = int((spec or {}).get("max_convs", 5))
    conversations, messages = [], {}
    result = {"ok": True, "done": ["read_chats"], "failed_step": None,
              "reason": None, "shot": None, "risk": None}
    try:
        t.launch_app(IM_URL)                       # launch_app 语义=goto URL
        time.sleep(4)
        w, h = t.screen_size()
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes)
        nodes = _ensure_login(t, nodes, h, save_shot)

        rows = _collect_rows(t, w, h)
        targets = [r for r in rows if r.get("unread", 0) > 0]  # 未读驱动(对齐手机版)
        n_unread = len(targets)
        if len(targets) > max_convs:
            logger.warning("未读会话 %d 超过单轮上限 %d,其余下轮再扫", n_unread, max_convs)
            targets = targets[:max_convs]
        logger.info("会话列表 %d 行,未读 %d 行,本轮进 %d", len(rows), n_unread, len(targets))

        for row in targets:
            try:
                fresh = _locate_row(t, row, w, h)
                if not fresh:
                    logger.warning("列表里定位不到 %s(可能已滚走),跳过", row["nick"])
                    continue
                t.tap(fresh["row_cx"], fresh["row_cy"])
                time.sleep(2.5)
                page_nodes = _flat(t.dump_nodes())
                _check_risk(page_nodes)
                if not _on_chat_page(page_nodes):
                    logger.warning("row=%s 未进入聊天页,跳过", row["nick"])
                    t.key("BACK")
                    time.sleep(1.0)
                    continue
                page = _parse_history(_read_history(t, w, h), w, h)
                if not page.get("peer_key"):
                    # peer_key(会员名/userId)缺失会让会话按坐标无限裂变,宁缺毋滥(对齐手机版)
                    logger.warning("聊天页未解析到 peer_key,跳过(nick=%s,msgs=%d)",
                                   row["nick"], len(page.get("messages", [])))
                    t.key("BACK")
                    time.sleep(1.0)
                    continue
                key = page["peer_key"]
                html_key = _sample_chat_html(t, key, page)
                conversations.append({
                    "html_key": html_key,
                    "peer_key": key,
                    "peer_nick": page.get("peer_nick") or row["nick"],
                    "item_title": page.get("item_title"),
                    "item_price": page.get("item_price"),
                    "item_image": page.get("item_image"),
                    "item_id": page.get("item_id"),
                    "order_status": row.get("order_status"),
                    "last_message": row.get("last_message"),
                    "unread": row.get("unread", 0),
                })
                messages[key] = page.get("messages", [])
                t.key("BACK")                          # web:仍在 /im,BACK 由 transport 决定
                time.sleep(1.0)
            except (RiskHit, FlowTimeout):
                raise                                  # 风控/硬超时:立即终止,交外层收尾
            except Exception as ex:
                logger.warning("读取会话失败,跳过 %s: %s", row.get("nick"), ex)
                try:
                    t.key("BACK")
                    time.sleep(1.0)
                except Exception:
                    pass
                continue
    except RiskHit as ex:
        result = {"ok": False, "done": [], "failed_step": "read_chats",
                  "reason": str(ex), "shot": ex.shot, "risk": ex.anchor}
    except LoginRequired as ex:
        result = {"ok": False, "done": [], "failed_step": "read_chats",
                  "reason": ex.reason, "shot": ex.shot, "risk": None, "login": True}
    except FlowTimeout as ex:
        result = {"ok": False, "done": [], "failed_step": "read_chats",
                  "reason": str(ex), "shot": None, "risk": None}
    except Exception as ex:
        logger.warning("read_chats_web 未预期异常,保留已读会话: %s", ex)
        result = {"ok": False, "done": [], "failed_step": "read_chats",
                  "reason": str(ex), "shot": None, "risk": None}
    # 进过会话就退出来,别让业务标签页停在会话里把买家后来的消息当场读掉(见 im_nav)。
    # 风控 / 掉登录不动页面,留给人看现场
    if conversations and not result.get("risk") and not result.get("login"):
        leave_conversation(t)
    result["conversations"] = conversations
    result["messages"] = messages
    return result
