"""闲鱼网页版「售出巡检」:读个人中心「已售出」里的商品链接,按 item_id 对本号在架账本,
直开详情页见到「卖掉了」才记。

为什么另起一条:chat_scan 靠聊天页商品卡标题对账本(jobs._detect_sold_listings),可网页版聊天页的
商品卡**根本没有标题**(只有图、价、运费、交易状态,2026-10-17 实测截图),这条在浏览器号上从没
对上过一单——当天生产 gc_listing 一条 SOLD 都没有,浏览器号的成交全漏,卖掉的货还挂在别的号上。
个人中心「已售出」不靠买家发消息,会话被人先点开过也不怕。

2026-10-17 实测(东南亚泡菜味的蓝鲸,经执行端已开着的浏览器看的真实页面):
- tab 条「综合 / 在售42 / 已售出2」,div[class*="tabItem--"];切过去后它带 tabItem-active--。
- 卡片包在 a[class*="feeds-item-wrap--"] 里,href=/item?id=<itemId>(dump 把 href 放进 desc)。
  09-09 那版卡片还不是 <a>(goods_flows_web 模块 docstring),10-15 改版后是了,item_id 直接可读。
  不按标题对:同一个号上真有两件不同 SKU、标题和价格一字不差的货(那天卖掉的就是其中一件)。
- 已售详情页(自己的货):卖家按钮 sellerButton-- 是「卖掉了」(灰,不可点)+「删除」,主图盖「卖掉了」章;
  在售是「下架」+「删除」。详情页页头没有登录昵称(只有搜索框),登录态只能在个人中心看。
  页面下半截是「为你推荐」,30 张别人的商品卡。
- 「我卖出的」网页版没做:点了弹「我卖出的待上线,扫码去 APP 查看」。

宁漏勿错:tab 没找到 / 点了没切过去 / 有卡片却读不到链接 → 整轮失败、不报(任务列表里看得见);
详情页不是「卖掉了」→ 不报。单轮最多确认 spec.max_confirm 个。只读:只点「已售出」tab、只开详情页。
"""
from __future__ import annotations

import logging
import re
import time

from app.flow.engine import LoginRequired, RiskHit
from app.flow.transport import FlowTimeout
from app.flow.web.goods_flows_web import (
    CLS_CARD_TITLE,
    CLS_CARD_WARP,
    CLS_SELLER_BTN,
    ITEM_URL,
    StepFail,
    _GAP,
    _MAX_SWIPES,
    _SETTLE,
    _check_risk,
    _check_risk_unless_deleted,
    _delisted_state,
    _flat,
    _item_id_from_url,
    _mk_save_shot,
    _open_personal,
    _page_deleted,
)

logger = logging.getLogger("gc.sold_scan_web")

# tab 条:「综合 / 在售N / 已售出N」;件数可能和字在一个节点里,也可能是紧挨着的数字节点
_SOLD_TAB = re.compile(r"^已售出?\s*(\d+)?$")
CLS_TAB_ACTIVE = "active"            # 当前 tab:tabItem-active--
CLS_FEED_LINK = "feeds-item-wrap--"  # 卡片外层 <a>,href=/item?id=<itemId>
SOLD_BUTTON = "卖掉了"                # 已售详情页的卖家按钮
# 已售卡片比 tab 上写的件数多出这么多,就当读到的不是「已售出」(页面结构变了),本轮不报
_TAB_SLACK = 3


def find_sold_tab(nodes) -> tuple[dict | None, int | None]:
    """个人中心 tab 条里的「已售出」→ (节点, 件数)。没有 tab 返回 (None, None);
    读不到件数时件数为 None(只是少一道防呆)。tab 条在卡片上面,优先认 tab 类的节点。"""
    hits = [n for n in nodes if _SOLD_TAB.match((n.get("desc") or "").strip())]
    if not hits:
        return None, None
    tab = next((n for n in hits if "tab" in (n.get("cls") or "").lower()), None) \
        or min(hits, key=lambda n: n["cy"])
    count = _SOLD_TAB.match(tab["desc"].strip()).group(1)
    if count is None:
        near = [n for n in nodes if (n.get("desc") or "").strip().isdigit()
                and abs(n["cy"] - tab["cy"]) <= 12 and 0 < n["cx"] - tab["cx"] <= 80]
        if near:
            count = min(near, key=lambda n: n["cx"])["desc"].strip()
    return tab, (int(count) if count is not None else None)


def feed_item_ids(nodes) -> list[str]:
    """卡片外层链接里的 item_id,按页面顺序去重。"""
    out: list[str] = []
    for n in nodes:
        if CLS_FEED_LINK in (n.get("cls") or ""):
            item_id = _item_id_from_url(n.get("desc") or "")
            if item_id and item_id not in out:
                out.append(item_id)
    return out


def _has_cards(nodes) -> bool:
    return any(CLS_CARD_WARP in (n.get("cls") or "") or CLS_CARD_TITLE in (n.get("cls") or "")
               for n in nodes)


def _collect_sold_ids(t, w, h, nodes, count: int | None, max_swipes: int) -> tuple[list[str], bool]:
    """滚动收「已售出」卡片的 item_id → (ids, 见没见到卡片)。

    列表一页 20 件,滚到底才加载下一页:滚一下没新链接就停,只读得到最上面 20 件(2026-10-17
    洞穴Q弹的荆芥已售出 191 件就是这样)。所以连着 3 下没新链接才停(够滚过一屏半到底、等下一页
    出来);读满 tab 上写的件数就不用再滚。平时最上面一两页就是最近卖掉的,补查老成交时
    spec.max_swipes 给大些。
    """
    ids = feed_item_ids(nodes)
    saw_cards = _has_cards(nodes)
    idle = 0
    for _ in range(max_swipes):
        if count is not None and len(ids) >= count:
            break
        before = len(ids)
        t.swipe(int(w * 0.6), int(h * 0.25), int(w * 0.6), int(h * 0.25) + 500)   # 向下滚
        time.sleep(_SETTLE)
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes)
        saw_cards = saw_cards or _has_cards(nodes)
        ids += [i for i in feed_item_ids(nodes) if i not in ids]
        idle = idle + 1 if len(ids) == before else 0
        if idle >= 3:
            break
    return ids, saw_cards


def detail_sold_state(nodes) -> tuple[bool, str]:
    """详情页(按账本 item_id 直开)→ (卖掉了没有, 依据)。纯函数。

    只认正面证据:卖家按钮里有「卖掉了」。在售是「下架」;已下架是「重新上架/上架」或「已下架」;
    删掉了是「宝贝被删掉了」。一个卖家按钮都没有 = 掉登录了或者不是本号的货,不算。
    """
    if _page_deleted(nodes):
        return False, "已删除"
    buttons = {(n.get("desc") or "").strip() for n in nodes if CLS_SELLER_BTN in (n.get("cls") or "")}
    buttons.discard("")
    if SOLD_BUTTON in buttons:
        return True, SOLD_BUTTON
    if "下架" in buttons:
        return False, "在售"
    if _delisted_state(nodes):
        return False, "已下架"
    if not buttons:
        return False, "看不到卖家按钮(掉登录了,或不是本号的货)"
    return False, f"卖家按钮是「{'/'.join(sorted(buttons))}」,不认识,不算卖掉"


def run_sold_scan_web(transport, spec: dict, shot_sink=None) -> dict:
    """spec: {listings: [{listing_id, item_id, title}](本号在架账本), max_confirm, max_swipes?}
    (jobs.create_sold_scan;max_swipes 只在补查老成交时给,默认滚 _MAX_SWIPES 下)。

    result 在通用字段外带:sold_count(tab 上的件数)、sold_ids(已售出里读到几个链接)、
    candidates、checked(每个候选的结论)、sold(确认卖掉的 [{listing_id, item_id, title}])。
    """
    t = transport
    save_shot = _mk_save_shot(t, shot_sink)
    result = {"ok": True, "done": ["sold_scan"], "failed_step": None,
              "reason": None, "shot": None, "risk": None, "sold": [], "checked": []}
    try:
        spec = spec or {}
        live = {str(x["item_id"]): x for x in (spec.get("listings") or []) if x.get("item_id")}
        cap = max(1, int(spec.get("max_confirm") or 5))
        max_swipes = max(0, int(spec.get("max_swipes") or _MAX_SWIPES))
        w, h, nodes = _open_personal(t, save_shot)          # 含登录态检查(详情页页头没有昵称,只能在这看)

        tab, count = find_sold_tab(nodes)
        if tab is None:
            raise StepFail("sold_tab", "个人中心没找到「已售出」tab(页面改版了?),本轮不报",
                           save_shot("sold_no_tab"))
        result["sold_count"] = count
        if count == 0:
            return result
        t.tap(tab["cx"], tab["cy"])
        time.sleep(3)
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes)
        now_tab, _ = find_sold_tab(nodes)
        if not now_tab or CLS_TAB_ACTIVE not in (now_tab.get("cls") or ""):
            raise StepFail("sold_tab", "点了「已售出」没切过去,本轮不报", save_shot("sold_tab_stuck"))

        ids, saw_cards = _collect_sold_ids(t, w, h, nodes, count, max_swipes)
        result["sold_ids"] = len(ids)
        if saw_cards and not ids:
            raise StepFail("sold_list", "「已售出」有卡片却读不到商品链接(页面又改版了?),本轮不报",
                           save_shot("sold_no_links"))
        if count is not None and len(ids) > count + _TAB_SLACK:
            raise StepFail("sold_list", f"「已售出」写着 {count} 件,却读到 {len(ids)} 个商品链接,"
                           f"读到的不像已售列表,本轮不报", save_shot("sold_list_mismatch"))

        cands = [live[i] for i in ids if i in live][:cap]
        result["candidates"] = len(cands)
        for lst in cands:
            item_id = str(lst["item_id"])
            time.sleep(_GAP)
            t.launch_app(ITEM_URL.format(item_id))
            time.sleep(4)
            got = _item_id_from_url(t.page.url)
            if got != item_id:
                result["checked"].append({"item_id": item_id, "sold": False,
                                          "why": f"没落到这个商品(url id={got})"})
                continue
            nodes = _flat(t.dump_nodes())
            _check_risk_unless_deleted(nodes)              # 只看「为你推荐」以上
            sold, why = detail_sold_state(nodes)
            result["checked"].append({"item_id": item_id, "sold": sold, "why": why})
            if sold:
                result["sold"].append({"listing_id": lst.get("listing_id"), "item_id": item_id,
                                       "title": lst.get("title")})
                logger.info("售出巡检:item_id=%s 「%s」卖掉了", item_id, (lst.get("title") or "")[:20])
            else:
                logger.info("售出巡检:item_id=%s 在已售出里,但详情页不算卖掉(%s)", item_id, why)
    except RiskHit as ex:
        result = {"ok": False, "done": [], "failed_step": "sold_scan",
                  "reason": str(ex), "shot": ex.shot, "risk": ex.anchor}
    except LoginRequired as ex:
        result = {"ok": False, "done": [], "failed_step": "sold_scan",
                  "reason": ex.reason, "shot": ex.shot, "risk": None, "login": True}
    except FlowTimeout as ex:
        result = {"ok": False, "done": [], "failed_step": "sold_scan",
                  "reason": str(ex), "shot": None, "risk": None}
    except StepFail as ex:
        result = {"ok": False, "done": [], "failed_step": ex.step,
                  "reason": ex.reason, "shot": ex.shot, "risk": None}
    except Exception as ex:
        logger.warning("sold_scan_web 未预期异常: %s", ex)
        result = {"ok": False, "done": [], "failed_step": "sold_scan",
                  "reason": str(ex), "shot": None, "risk": None}
    return result
