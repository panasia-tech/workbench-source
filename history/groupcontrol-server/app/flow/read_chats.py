"""闲鱼「读聊天」流程(1a):消息 tab → 扫会话 → 逐个未读会话读气泡+拼历史 → 结构化返回。
服务端经 MQTT 驱动设备,纯解析在 chat_parse。ChatScanSpec: {max_convs?: int=5}。"""
import logging
import time

from app.chat_parse import parse_chat_page, parse_conversation_list
from app.flow.engine import Engine, LoginRequired, RiskHit, StepError
from app.flow.ready import ensure_logged_in
from app.flow.transport import FlowTimeout

logger = logging.getLogger("gc.read_chats")

XIANYU_PKG = "com.taobao.idlefish"


def _flat(nodes):
    """transport.dump_nodes() 的 {center,size} 元组格式 → chat_parse 用的扁平 {cx,cy,w,h}。
    兼容已是扁平 cx/cy/w/h 的输入(取不到 center/size 时回退)。"""
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


def _open_messages(e: Engine):
    from app.flow.publish_flow import _leave_editor_to_home
    e.t.key("WAKEUP")
    e.t.force_stop(XIANYU_PKG)
    time.sleep(1)
    e.t.launch_app(XIANYU_PKG)
    time.sleep(3)
    e.dismiss_nuisance()
    if not e.find("消息", timeout=2):
        _leave_editor_to_home(e)
        ensure_logged_in(e, "read_chats")   # 仍到不了消息 tab:先判是否掉登录(是则升级 LoginRequired)
    # 底部「消息」tab:OCR 文字中心贴近系统手势区(y≈2337/2400),直接点会被手势吞掉,
    # 抬升 100px 改点 tab 图标区(2026-07-28 小米12 真机实测:原落点进不了消息页)。
    hit = e.require("消息", "open_messages", timeout=8)
    e.tap_xy(hit["center"][0], hit["center"][1] - 100, settle=2.0)


def _read_history(e: Engine):
    """dump→上滑→dump 去重拼接到收敛(loop-until-dry)。返回累计节点(去重后)。"""
    w, h = e.width, e.height
    seen, nodes_all = set(), []
    def collect(nodes):
        added = 0
        for n in nodes:
            key = (n.get("desc", ""), n["cx"], n["cy"])
            if key in seen:
                continue
            seen.add(key); nodes_all.append(n); added += 1
        return added
    collect(_flat(e.t.dump_nodes()))
    dry = 0; rounds = 0
    while dry < 2 and rounds < 12:
        e.t.swipe(w // 2, int(h * 0.27), w // 2, int(h * 0.67), 400)
        time.sleep(1.0)
        added = collect(_flat(e.t.dump_nodes()))
        dry = dry + 1 if added == 0 else 0
        rounds += 1
    return nodes_all


def _on_chat_page(e: Engine) -> bool:
    """确认真的进了聊天页(输入框/顶栏特征)。点歪、落在消息列表或服务号页时为 False。

    2026-07-29 幻影会话根因:row_cy 点偏后没校验,把消息列表/Tab 页文本当气泡解析,
    peer_key 用 row 坐标兜底 → 每轮扫描新建幻影会话、垃圾文本全入库。
    """
    for n in _flat(e.t.dump_nodes()):
        t = n.get("desc") or ""
        if "想跟TA说" in t or "闲鱼私聊" in t or "会员名" in t:
            return True
    return False


def run_read_chats(transport, spec: dict, shot_sink=None) -> dict:
    from app.flow.publish_flow import reset_to_clean
    e = Engine(transport, shot_sink=shot_sink)
    max_convs = int((spec or {}).get("max_convs", 5))
    conversations, messages = [], {}
    result = {"ok": True, "done": ["read_chats"], "failed_step": None,
              "reason": None, "shot": None, "risk": None}
    try:
        _open_messages(e)
        w, h = e.width, e.height
        rows = parse_conversation_list(_flat(e.t.dump_nodes()), w, h)
        # 未读驱动:只进带未读角标的买家会话(系统行不带 unread,已在解析层排除)。
        # 无未读则本轮不点开任何会话——既省设备时间,也不再盲扫前 N 个把已读会话反复读一遍。
        targets = [r for r in rows if r.get("unread", 0) > 0]
        n_unread = len(targets)
        if len(targets) > max_convs:
            logger.warning("未读会话 %d 超过单轮上限 %d,其余下轮再扫", n_unread, max_convs)
            targets = targets[:max_convs]
        logger.info("会话列表 %d 行,未读 %d 行,本轮进 %d", len(rows), n_unread, len(targets))
        for row in targets:
            try:
                e.tap_xy(w // 2, row["row_cy"], settle=2.0)
                if not _on_chat_page(e):
                    logger.warning("row_cy=%s 未进入聊天页(点歪或服务号),跳过", row["row_cy"])
                    e.t.key("BACK"); time.sleep(1.2)
                    continue
                page = parse_chat_page(_read_history(e), w, h)
                if not page.get("peer_key"):
                    # 顶栏「会员名」没解析到:nick 是账号身份,缺了会让会话按 row 坐标无限裂变,宁缺毋滥
                    logger.warning("聊天页未解析到会员名,跳过(msgs=%d)", len(page.get("messages", [])))
                    e.t.key("BACK"); time.sleep(1.2)
                    continue
                key = page["peer_key"]
                conversations.append({
                    "peer_key": key, "peer_nick": page.get("peer_key"),
                    "item_title": page.get("item_title"),
                    "item_price": page.get("item_price"),
                    "order_status": row.get("order_status"),
                    "last_message": row.get("last_message"), "unread": row.get("unread", 0),
                })
                messages[key] = page.get("messages", [])
                e.t.key("BACK"); time.sleep(1.2)
            except (RiskHit, FlowTimeout):
                raise  # 风控/流程硬超时:立即终止本轮,交外层统一收尾(已读到的会话仍保留)
            except Exception as ex:
                # 单个会话读失败(RPC/OCR/解析异常)不应带走整轮:记日志、退回列表、继续下一个。
                logger.warning("读取会话失败,跳过 row_cy=%s: %s", row.get("row_cy"), ex)
                try:
                    e.t.key("BACK"); time.sleep(1.0)
                except Exception:
                    pass
                continue
    except RiskHit as ex:
        # 手动 try/except(见模块顶注:动态遍历会话不走 Engine.run(STEPS)),
        # 须补捕获 RiskHit 否则会逃逸成未预期异常、risk 字段丢失、账号不会被熔断冻结。
        result = {"ok": False, "done": [], "failed_step": "read_chats",
                  "reason": str(ex), "shot": ex.shot, "risk": ex.anchor}
    except StepError as ex:
        result = {"ok": False, "done": [], "failed_step": ex.step,
                  "reason": ex.reason, "shot": ex.shot, "risk": None}
    except FlowTimeout as ex:
        result = {"ok": False, "done": [], "failed_step": "read_chats",
                  "reason": str(ex), "shot": None, "risk": None}
    except LoginRequired as ex:
        result = {"ok": False, "done": [], "failed_step": "read_chats",
                  "reason": ex.reason, "shot": ex.shot, "risk": None, "login": True}
    except Exception as ex:
        # 兜底:任何未预期异常都不带走已读到的会话(增量保留,不再"一崩全丢")。
        logger.warning("read_chats 未预期异常,保留已读会话: %s", ex)
        result = {"ok": False, "done": [], "failed_step": "read_chats",
                  "reason": str(ex), "shot": None, "risk": None}
    result["conversations"] = conversations
    result["messages"] = messages
    try:
        reset_to_clean(e)  # 超时/异常态下也可能再抛(如又撞硬超时),吞掉以确保结果能返回
    except Exception as ex:
        logger.warning("reset_to_clean 失败(忽略): %s", ex)
    return result
