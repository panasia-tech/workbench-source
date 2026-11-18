"""销售工作台的「流转」演示接口：订单缺口（自动抓单）、今天的任务、新手教程进度、协同请求、发布上架、发货出库、撤回。

真实 ERP 里没有的部分（任务表、协同请求、订单对账、教程进度）在这里用内存数据做出来，当作给程序员的接口说明；
发布上架 / 发货出库直接改演示库里的真实表（SkuShopListing、SalesOutbound、Sku），所以 Gallery 的红黄绿会跟着变。
凡是这里做的动作，前端都会标「演示」——不用模拟回执冒充生产真实成功（#95 SAFE-07）。
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException

from app.deps import get_current_user

router = APIRouter(prefix="/api/demo", tags=["销售工作台流转（演示接口）"])
_DB = {"S": None, "IDS": None}
NOW = lambda: time.time()  # noqa: E731

# ---- 规则（奖惩数值是示意，以公司正式通知为准）----
RULES = {
    "price": {"floor": 1.0, "cap": 5.0, "low": "低于采购成本价（亏损倒挂）：请提高售价，或在滞销清仓/瑕疵折价时注明原因。",
              "high": "高于成本 500%：可以发，请先确认没有多打一个 0。"},
    "publish": {"quota": 10, "undo_sec": 60, "penalty": "从大库图库选好不重复图片并确认闲鱼清洗价（不倒挂亏损）即可直接上架。"},
    "ship": {"undo_sec": 30, "penalty": "没核对货号就出库，会发错货，发错一单扣当单提成并记入月度复盘（示意）。",
             "deadline": "实物当天 17:00 前要发；17:00 以后付款的顺延到次日 17:00。虚拟付款 1 分钟内要发。"},
    "correction": "可在撤回窗口内直接撤回，或重选图片/修改价格后直接覆盖更新。",
}

ME = {
    "chenxm": {"name": "陈小满", "post": "销售业务员"}, "zhoubb": {"name": "周小北", "post": "销售业务员"}, "newbie": {"name": "新同事", "post": "销售业务员（第一天）"},
    "admin": {"name": "销售主管", "post": "销售主管"}, "linxiao": {"name": "林晓", "post": "仓管业务员"},
}
S = {
    "practice": {"chenxm": {"phys": 3, "virt": 3, "svc": 3}, "zhoubb": {"phys": 3, "virt": 3, "svc": 3}, "newbie": {"phys": 0, "virt": 0, "svc": 0}, "admin": {"phys": 3, "virt": 3, "svc": 3}},
    "watched": {"chenxm": ["0-all", "1-all", "1-0", "1-1"], "zhoubb": [], "newbie": [], "admin": []},
    "commission": {"chenxm": {"day_ok": 38, "day_pend": 60, "mon_ok": 1260, "mon_pend": 410}, "zhoubb": {"day_ok": 20, "day_pend": 10, "mon_ok": 980, "mon_pend": 300}, "newbie": {"day_ok": 0, "day_pend": 0, "mon_ok": 0, "mon_pend": 0}},
    "ledger": {"chenxm": [{"t": "今天", "src": "出库 × 2（实物）", "amt": 20, "st": "pend"}, {"t": "今天", "src": "麦当劳双人餐 × 3（成交提成 10%）", "amt": 18, "st": "ok"},
                          {"t": "昨天", "src": "跟卖型新品「必胜客双人套餐」上新奖", "amt": 20, "st": "ok"}, {"t": "昨天", "src": "CAD 描图 × 2（成交提成 20%）", "amt": 18.6, "st": "pend"}]},
    "assigned": [{"id": "a1", "cat": "显示器", "req": "把飞利浦 27 英寸这个系列今天过一遍：缺图的补拍，价格对着行情看一眼", "files": ["飞利浦显示器清单.xlsx"], "to": "chenxm", "by": "销售主管", "done": False, "status": "待接收", "due": "", "scope": "", "history": []}],
    "exceptions": [], "owner": {}, "undo": {}, "picks": {}, "devreq": [], "order_fees": {},
    "collab": {"id": "cr1", "title": "买家问：这台飞利浦显示器能不能当面验机？需要仓管拍一段屏幕无坏点的视频", "from": "消息工作台（外包）", "t0": NOW(), "taken_by": None},
    "team_target": {"target": 120, "done": 74},
}
ORDERS: list[dict] = []


def _staff(u): return u.username


def init(SessionDemo, IDS):
    _DB["S"], _DB["IDS"] = SessionDemo, IDS
    reset_orders()


def reset_orders():
    m = lambda mins: mins  # noqa: E731
    ORDERS.clear()
    ORDERS.extend([
        dict(id="XY2026110011", kind="phys", title="小米 空气净化器 4LITE", amount=359, buyer="买家-阿杰", paid="昨天 17:42", paid_min=1190, p_status="paid", s_status="pending", sku="BQAFLF1XF01011-B",
             shift="17:00 以后付款，顺延到今天 17:00", note=""),
        dict(id="XY2026110012", kind="phys", title="戴森 HT01 电吹风", amount=1680, buyer="买家-小林", paid="昨天 15:20", paid_min=1300, p_status="paid", s_status="pending", sku="513211549229-B",
             overdue=True, note="昨天付款，已过当天 17:00，还没打单出库"),
        dict(id="XY2026110013", kind="phys", title="创维 F24G30F 24英寸显示器", amount=468, buyer="买家-momo", paid="今天 09:10", paid_min=150, p_status="cancelled", s_status="pending", sku="513211540009-B",
             note="买家已在平台取消订单，系统里还是待发货"),
        dict(id="XY2026110014", kind="phys", title="飞利浦 25M2N32 25英寸显示器", amount=560, buyer="买家-老周", paid="今天 10:02", paid_min=95, p_status="addr_changed", s_status="pending", sku="513211540232-B",
             note="买家改了收货地址，系统里还是旧地址"),
        dict(id="XY2026110015", kind="phys", title="飞利浦 27M2N5510P 27英寸显示器", amount=1020, buyer="买家-文文", paid="今天 10:40", paid_min=60, p_status="paid", s_status="pending", sku=None,
             unmatched="same_model", candidates=["513211540233-A", "513211540233-B"], note="同款有两件在库，不知道发哪一件"),
        dict(id="XY2026110016", kind="phys", title="创维 F27G30F 27英寸显示器", amount=598, buyer="买家-小雨", paid="今天 10:55", paid_min=45, p_status="paid", s_status="pending", sku=None,
             unmatched="no_map", candidates=[], note="这个闲鱼商品 ID 没有挂到任何库存货号"),
        dict(id="XY2026110017", kind="phys", title="飞利浦 25M2N3200W 25英寸显示器", amount=609, buyer="买家-宁宁", paid="今天 11:20", paid_min=20, p_status="paid", s_status="none", sku=None,
             note="平台上买家 11:20 已付款，抓单程序没抓到。补抓之后系统会按闲鱼商品 ID 找货；找不到会转到「对不上货」。"),
        dict(id="XY2026110018", kind="phys", title="小米 小爱音箱 Pro", amount=219, buyer="买家2", paid="今天 08:30", paid_min=210, p_status="shipped", s_status="callback_failed", sku="DEMO-SOLD-2", tracking="SF1400000018",
             note="已出库，但回传平台失败，买家看不到物流"),
        dict(id="XY2026110019", kind="phys", title="飞利浦 24B1U5301H 显示器", amount=468, buyer="买家1", paid="昨天 14:05", paid_min=1320, p_status="shipped", s_status="shipped", sku="DEMO-SOLD-1", tracking="SF1400000019", note=""),
        dict(id="XY2026110020", kind="phys", title="戴森 HD08 电吹风", amount=1390, buyer="买家3", paid="昨天 10:30", paid_min=1500, p_status="shipped", s_status="shipped", sku="DEMO-SOLD-3", tracking="SF1400000020", note=""),
    ])


def _gap(o):
    """把一笔订单归到四种缺口之一。返回 (kind, label, why)。"""
    if o["s_status"] == "none":
        return "missed", "漏抓", "平台有这笔已付款订单，系统里没有（补采漏单）"
    if o["s_status"] == "pending" and not o.get("sku"):
        return "unmatched", "对不上货", {"same_model": "同款有多件，要人选定是哪一件", "no_map": "缺映射：商品 ID 没挂到库存货号"}.get(o.get("unmatched"), "匹配不到库存")
    if o["s_status"] == "callback_failed":
        return "desync", "状态不同步", "已出库但回传平台失败：先查平台实际状态，再重传"
    if o["p_status"] in ("cancelled", "addr_changed") and o["s_status"] == "pending":
        return "desync", "状态不同步", "买家已" + ("取消订单" if o["p_status"] == "cancelled" else "改了地址") + "，系统里还是待发货"
    if o.get("overdue"):
        return "stuck", "卡住没走", "已过当天 17:00 的发货时限"
    if o["s_status"] == "pending":
        return "pending", "待发货", o.get("shift") or "在时限内"
    return "ok", "正常", ""


def _sku_cost_map():
    costs = {}
    if _DB["S"] is None:
        return costs
    db = _db()
    try:
        from app.models import Sku
        for s in db.query(Sku.sku_code, Sku.cost_price).all():
            costs[s[0]] = float(s[1] or 0)
    finally:
        db.close()
    return costs


def _order_out(o, sku_costs=None):
    k, label, why = _gap(o)
    costs = sku_costs if sku_costs is not None else _sku_cost_map()
    code = o.get("sku") or ((o.get("candidates") or [None])[0])
    cost = float(costs.get(code, 0) or 0)
    fees = dict(S.setdefault("order_fees", {}).get(o["id"]) or {"platform": 0, "shipping": 0, "repair": 0, "other": 0, "refund": 0, "receivable": float(o.get("amount") or 0), "note": ""})
    fee_sum = sum(float(fees.get(x) or 0) for x in ("platform", "shipping", "repair", "other"))
    refund = float(fees.get("refund") or 0)
    recv = float(fees.get("receivable") or 0) or float(o.get("amount") or 0)
    net_profit = round(recv - cost - fee_sum - refund, 2)
    return {**o, "gap": k, "gap_label": label, "why": why, "lvl": {"ok": "grn", "pending": "amb"}.get(k, "red"),
            "cost_price": cost, "fees": fees, "net_profit": net_profit}


def _team():
    return ["chenxm", "zhoubb"]


def _owner(key):
    return S["owner"].get(key) or _team()[abs(hash(key)) % 2]


def _db():
    return _DB["S"]()


def _is_sup(u): return u.username == "admin"


# ------------------------------------------------------------------ 我 + 规则
@router.get("/me")
def me(u=Depends(get_current_user)):
    n = u.username
    p = S["practice"].get(n, {})
    return {"username": n, **ME.get(n, {"name": u.name, "post": "销售业务员"}), "dept": "销售部", "supervisor": _is_sup(u), "practice": p,
            "practice_done": all(v >= 3 for v in p.values()) if p else False, "watched": S["watched"].get(n, []),
            "commission": S["commission"].get(n, S["commission"]["chenxm"] if _is_sup(u) else {"day_ok": 0, "day_pend": 0, "mon_ok": 0, "mon_pend": 0}),
            "ledger": S["ledger"].get(n, []), "team": S["team_target"], "rules": RULES}


@router.post("/practice")
def practice(body: dict, u=Depends(get_current_user)):
    k, n = body.get("key"), int(body.get("step") or 0)
    p = S["practice"].setdefault(u.username, {"phys": 0, "virt": 0, "svc": 0})
    if k not in p:
        raise HTTPException(400, "没有这个练习")
    p[k] = max(p[k], min(3, n))
    return {"practice": p, "done": all(v >= 3 for v in p.values())}


@router.post("/watched")
def watched(body: dict, u=Depends(get_current_user)):
    w = S["watched"].setdefault(u.username, [])
    if body.get("key") not in w:
        w.append(body["key"])
    return {"watched": w}


@router.post("/learning/reset")
def reset_learning(u=Depends(get_current_user)):
    """只重置学习进度，绝不动真实任务、库存、订单、审批（#95 TOUR-03）。"""
    S["practice"][u.username] = {"phys": 0, "virt": 0, "svc": 0}
    S["watched"][u.username] = []
    return {"ok": True, "note": "只重置了学习进度，真实业务数据没有动"}


# ------------------------------------------------------------------ 任务：主管加派、协同请求、没见过的情况
@router.get("/tasks")
def tasks(u=Depends(get_current_user)):
    mine = [t for t in S["assigned"] if _is_sup(u) or t["to"] == u.username]
    return {"assigned": mine, "owners": S["owner"]}


@router.post("/tasks")
def assign(body: dict, u=Depends(get_current_user)):
    if not _is_sup(u):
        raise HTTPException(403, "只有主管能加派任务")
    req, scope, due = (str(body.get(key) or "").strip() for key in ("req", "scope", "due"))
    if not req or not scope or not due:
        raise HTTPException(400, "请写明要求、交付范围和交付时间")
    t = {"id": "a%d" % (len(S["assigned"]) + 1), "cat": body.get("cat") or "其他", "req": req,
         "scope": scope, "due": due, "files": body.get("files") or [], "to": body.get("to") or "chenxm",
         "by": "销售主管", "done": False, "status": "待接收", "history": []}
    S["assigned"].append(t)
    return {**t, "tb": "已生成本机演示任务"}


def _task(tid, u):
    task = next((t for t in S["assigned"] if t["id"] == tid), None)
    if not task:
        raise HTTPException(404, "没有这条任务")
    if not _is_sup(u) and task["to"] != u.username:
        raise HTTPException(403, "只有负责人或主管可以查看这项任务")
    return task


def _log_task(task, u, action, note=""):
    task["history"].append({"action": action, "note": note, "by": u.username, "at": datetime.now().isoformat(timespec="seconds")})


_TASK_ACTIONS = {
    "待接收": {"执行中"},
    "执行中": {"等待外部", "受阻待接管", "待验收"},
    "等待外部": {"执行中"},
    "受阻待接管": {"执行中"},
    "待验收": {"已验收", "退回补正"},
    "退回补正": {"待验收"},
}


def _change_task(tid, body, u):
    task = _task(tid, u)
    status = body.get("status")
    if status not in _TASK_ACTIONS.get(task["status"], set()):
        raise HTTPException(409, "任务状态已变化，请刷新后再操作")
    if status in {"已验收", "退回补正"} and not _is_sup(u):
        raise HTTPException(403, "只有主管可以验收或退回")
    if status not in {"已验收", "退回补正"} and task["to"] != u.username and not (_is_sup(u) and task["status"] == "受阻待接管"):
        raise HTTPException(403, "由当前任务负责人操作")
    practice = S["practice"].get(u.username, {})
    if not _is_sup(u) and (not practice or any(v < 3 for v in practice.values())):
        raise HTTPException(403, "先完成三个练习")
    note = str(body.get("note") or "").strip()
    if status in {"等待外部", "受阻待接管", "待验收", "退回补正"} and not note:
        raise HTTPException(400, "请填写等待事项、受阻原因、交付证据或退回意见")
    if status == "执行中" and task["status"] == "受阻待接管" and _is_sup(u):
        task["to"] = u.username
    task.update(status=status, done=status == "已验收")
    _log_task(task, u, status, note)
    return task


@router.post("/tasks/{tid}/status")
def task_status(tid: str, body: dict, u=Depends(get_current_user)):
    return _change_task(tid, body, u)


@router.post("/tasks/{tid}/done")
def task_done(tid: str, body: dict, u=Depends(get_current_user)):
    return _change_task(tid, {"status": "待验收", "note": body.get("note")}, u)


@router.post("/tasks/{tid}/reassign")
def reassign(tid: str, body: dict, u=Depends(get_current_user)):
    if not _is_sup(u):
        raise HTTPException(403, "只有主管能改派")
    task = _task(tid, u)
    fields = [str(body.get(key) or "").strip() for key in ("done", "remaining", "next")]
    if task["done"] or not all(fields) or not body.get("to"):
        raise HTTPException(400, "请确认任务未验收，并填齐已做、未完成、下一步和接手人")
    task["to"] = body["to"]
    task["status"] = "待接收"
    _log_task(task, u, "改派", "；".join(f"{key}：{value}" for key, value in zip(("已做", "未完成", "下一步"), fields)))
    return task


@router.post("/owner")
def set_owner(body: dict, u=Depends(get_current_user)):
    if not _is_sup(u):
        raise HTTPException(403, "只有主管能改派")
    S["owner"][body["key"]] = body["to"]
    return {"ok": True}


@router.get("/collab")
def collab(u=Depends(get_current_user)):
    c = S["collab"]
    el = NOW() - c["t0"]
    state = "taken" if c["taken_by"] else ("open" if el < 60 else "peer" if el < 120 else "sup")
    left = None if state in ("taken", "sup") else int(60 - (el if state == "open" else el - 60))
    return {**c, "state": state, "left": left, "peer": "周小北" if u.username == "chenxm" else "陈小满", "elapsed": int(el)}


@router.post("/collab/take")
def collab_take(u=Depends(get_current_user)):
    S["collab"]["taken_by"] = ME.get(u.username, {}).get("name", u.username)
    return {"ok": True}


@router.post("/collab/reset")
def collab_reset(u=Depends(get_current_user)):
    S["collab"].update(t0=NOW(), taken_by=None)
    return {"ok": True}


@router.post("/exceptions")
def exc_add(body: dict, u=Depends(get_current_user)):
    t = (body.get("text") or "").strip()
    if not t:
        raise HTTPException(400, "先写一句话说发生了什么")
    e = {"id": "e%d" % (len(S["exceptions"]) + 1), "who": ME.get(u.username, {}).get("name", u.username), "text": t, "ruled": False, "t": datetime.now().strftime("%H:%M")}
    S["exceptions"].append(e)
    return e


@router.get("/exceptions")
def exc_list(u=Depends(get_current_user)):
    return {"items": S["exceptions"]}


@router.post("/exceptions/{eid}/rule")
def exc_rule(eid: str, u=Depends(get_current_user)):
    for e in S["exceptions"]:
        if e["id"] == eid:
            e["ruled"] = True
            return e
    raise HTTPException(404, "没有这条")


# ------------------------------------------------------------------ 每日选品日报（实物 / 卡券 / 虚拟服务各 1 条）
# 出处：11-06 管理层会，「日报还有一个东西就是选品的……实物、卡券、虚拟服务 3 个，每天要提交」。
# 线索来源不限（个人经历、同行、榜单都行），但必须写依据；今天确实没找到的，要写原因，不能空着交。
PICK_KINDS = [("phys", "实物"), ("voucher", "卡券"), ("service", "虚拟服务")]


@router.get("/picks")
def picks_get(u=Depends(get_current_user)):
    today = datetime.now().strftime("%Y-%m-%d")
    mine = S["picks"].get(u.username)
    team = []
    if _is_sup(u):
        for k in ("chenxm", "zhoubb", "newbie"):
            p = S["picks"].get(k)
            team.append({"user": k, "name": ME[k]["name"], "done": bool(p), "none": sum(1 for v in (p or {"items": {}})["items"].values() if v.get("none")), "at": p["at"] if p else ""})
    return {"date": today, "kinds": [{"k": k, "label": lb} for k, lb in PICK_KINDS], "mine": mine, "team": team}


@router.post("/picks")
def picks_add(body: dict, u=Depends(get_current_user)):
    items, out = body.get("items") or {}, {}
    for k, lb in PICK_KINDS:
        it = items.get(k) or {}
        if it.get("none"):
            why = (it.get("why") or "").strip()
            if len(why) < 6:
                raise HTTPException(400, f"「{lb}」今天没找到，要写一句原因（至少 6 个字），不能空着交。")
            out[k] = {"none": True, "why": why}
            continue
        title, basis = (it.get("title") or "").strip(), (it.get("basis") or "").strip()
        if len(title) < 2:
            raise HTTPException(400, f"「{lb}」那条还没写品名；今天没找到就勾「今天没找到」写原因。")
        if len(basis) < 4:
            raise HTTPException(400, f"「{lb}」要写依据：你在哪里看到的、为什么值得做（至少 4 个字）。")
        out[k] = {"title": title, "basis": basis, "link": (it.get("link") or "").strip(), "none": False}
    S["picks"][u.username] = {"date": datetime.now().strftime("%Y-%m-%d"), "items": out, "support": (body.get("support") or "").strip(), "at": datetime.now().strftime("%H:%M")}
    return S["picks"][u.username]


# ------------------------------------------------------------------ 提给开发（走禅道，不私发）
# 出处：11-09 技术对接会，「私下发的需求我肯定不接……要么就走禅道」「谁提的谁验收」。
# 这里只做软件里的入口和留痕；正式环境一条对应禅道里的一条需求，需求号、状态以禅道为准（接法待程序员评估）。
DEV_STATUS = ["待评审", "开发中", "待提需求的人验收", "已验收", "打回重改"]


@router.get("/devreq")
def devreq_list(u=Depends(get_current_user)):
    items = S["devreq"] if _is_sup(u) else [r for r in S["devreq"] if r["by"] == u.username]
    return {"items": items, "status": DEV_STATUS}


@router.post("/devreq")
def devreq_add(body: dict, u=Depends(get_current_user)):
    title, text = (body.get("title") or "").strip(), (body.get("text") or "").strip()
    kind = body.get("kind") if body.get("kind") in ("bug", "feature") else "bug"
    if len(title) < 6:
        raise HTTPException(400, "标题要写清楚是哪一页的什么问题（至少 6 个字）。只写两个字没人知道是哪个需求。")
    if len(text) < 15:
        raise HTTPException(400, "详细描述写清楚：你在做什么、看到了什么、希望变成什么（至少 15 个字）。")
    r = {"id": "R-%d" % (len(S["devreq"]) + 1), "by": u.username, "who": ME.get(u.username, {}).get("name", u.username), "kind": kind, "title": title, "text": text,
         "page": (body.get("page") or "").strip(), "t": datetime.now().strftime("%m-%d %H:%M"), "status": "待评审", "note": "演示：正式环境这一条会进禅道，谁提的谁验收。"}
    S["devreq"].append(r)
    return r


@router.post("/devreq/{rid}/status")
def devreq_status(rid: str, body: dict, u=Depends(get_current_user)):
    st = body.get("status")
    if st not in DEV_STATUS:
        raise HTTPException(400, "没有这个状态")
    for r in S["devreq"]:
        if r["id"] == rid:
            if st in ("已验收", "打回重改"):
                if r["by"] != u.username:
                    raise HTTPException(403, "谁提的谁验收：只有提这条需求的人能点验收或打回。")
                if r["status"] != "待提需求的人验收":
                    raise HTTPException(400, "还没开发好，不能验收。")
            if st in ("开发中", "待提需求的人验收") and not _is_sup(u):
                raise HTTPException(403, "评审和开发状态由主管 / 程序员改。")
            r["status"] = st
            return r
    raise HTTPException(404, "没有这条")


# ------------------------------------------------------------------ 店铺分组派单负荷均衡（全脱敏输出 + 管理端一次性配置接口）
from dispatch_policy_bridge import (
    get_admin_dispatch_policies,
    get_public_dispatch_groups,
    get_shop_dispatch_status,
    save_admin_dispatch_policies,
)


def _ent_state(e):
    return e.get("state") or "grn"


def _ent_of_shop(label):
    st = get_shop_dispatch_status(label)
    return {
        "id": st["group_code"],
        "name": st["group_name"],
        "state": st["state"],
        "dispatch_state": st["dispatch_state"],
        "badge": st["dispatch_badge"],
        "hint": st["dispatch_hint"],
    }


@router.get("/entities")
def entities(_=Depends(get_current_user)):
    return {
        "demo": True,
        "items": get_public_dispatch_groups(),
        "rule": "系统按各店铺分组当期排期密度自动均衡分配上新任务：显示「排期已满·暂停派新」的店铺请改选其他空闲店铺。",
    }


@router.get("/admin/dispatch-policies")
def admin_get_dispatch_policies(u=Depends(get_current_user)):
    if not _is_sup(u):
        raise HTTPException(403, "权限隔离：店铺派单容量上限配置仅向管理端开放")
    return {"ok": True, "items": get_admin_dispatch_policies()}


@router.post("/admin/dispatch-policies")
def admin_save_dispatch_policies(body: dict, u=Depends(get_current_user)):
    if not _is_sup(u):
        raise HTTPException(403, "权限隔离：店铺派单容量上限配置仅向管理端开放")
    items = body.get("items")
    if not isinstance(items, list):
        raise HTTPException(400, "请提交有效的策略列表 items")
    saved = save_admin_dispatch_policies(items, updated_by=getattr(u, "username", "admin"))
    return {"ok": True, "items": saved}


# ------------------------------------------------------------------ 录屏切片（屏幕类）：手机 H5 录一段视频，电脑（浏览器）切成多张，人看有没有问题，再传
# 出处：11-06 管理层会 02 [03:30]–[04:23]「只有屏幕可以切片……屏幕可以切，录个 10 秒视频，切成 100 片」；用户 11-11：
# 「手机 H5 打开来录个视频，切片直接就在这里弄，电脑切好，看有没有问题」。
# 切出来的是**这件货自己的屏幕画面**，算这件货的实拍图（存到 inspection/listing 目录，页面按目录把它算成实拍）。
# 真实环境只读，不上传；这里写演示库（本机 demo-img 目录 + 演示库里这件货的 images）。
import base64
import os
import re

_IMG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo-img", "inspection", "listing")


@router.post("/slices")
def slices_upload(body: dict, u=Depends(get_current_user)):
    """body: {sku_code, frames: [dataURL(jpeg)], start}。一批一批传（每批 10 张左右）。"""
    from app.models import Sku
    from sqlalchemy.orm.attributes import flag_modified
    code = (body.get("sku_code") or "").strip()
    frames = body.get("frames") or []
    start = int(body.get("start") or 0)
    if not re.fullmatch(r"[A-Za-z0-9_\-]{3,40}", code):
        raise HTTPException(400, "货号不对")
    if not frames:
        raise HTTPException(400, "没有图")
    if len(frames) > 30:
        raise HTTPException(400, "一次最多传 30 张，请分批")
    os.makedirs(_IMG_DIR, exist_ok=True)
    db = _db()
    try:
        sku = db.query(Sku).filter(Sku.sku_code == code).first()
        if not sku:
            raise HTTPException(404, "没有这件货")
        urls = []
        for i, d in enumerate(frames):
            m = re.fullmatch(r"data:image/jpeg;base64,([A-Za-z0-9+/=]+)", d or "")
            if not m:
                raise HTTPException(400, "只收 JPEG 图")
            raw = base64.b64decode(m.group(1))
            if len(raw) > 2_500_000:
                raise HTTPException(400, "单张图太大（超过 2.5MB）")
            name = f"slice-{code}-{start + i + 1:03d}.jpg"
            with open(os.path.join(_IMG_DIR, name), "wb") as f:
                f.write(raw)
            urls.append("/api/demo-img/inspection/listing/" + name)
        cur = list(sku.images or [])
        for x in urls:
            if x not in cur:
                cur.append(x)
        sku.images = cur
        flag_modified(sku, "images")
        db.commit()
        return {"ok": True, "added": len(urls), "total": len(cur), "demo": True}
    finally:
        db.close()


# ------------------------------------------------------------------ 订单缺口（自动抓单）
@router.get("/orders")
def orders(u=Depends(get_current_user)):
    sku_costs = _sku_cost_map()
    out = [_order_out(o, sku_costs) for o in ORDERS]
    try:   # 虚拟订单：被发货检查拦住 / 缺货的，按「1 分钟」规则一起进来
        import virtual_stub as vs
        for p in vs.DB.values():
            for o in p.get("orders", []):
                if o["status"] in ("held", "waiting"):
                    oid = "V-" + str(o["id"])
                    fees = dict(S.setdefault("order_fees", {}).get(oid) or {"platform": 0, "shipping": 0, "repair": 0, "other": 0, "refund": 0, "receivable": float(o.get("amount") or 0), "note": ""})
                    fee_sum = sum(float(fees.get(x) or 0) for x in ("platform", "shipping", "repair", "other"))
                    refund = float(fees.get("refund") or 0)
                    cost = float(p.get("cost") or 0)
                    recv = float(fees.get("receivable") or 0) or float(o.get("amount") or 0)
                    out.append({"id": oid, "kind": "virt", "title": p["name"], "amount": o["amount"], "cost_price": cost,
                                "fees": fees, "net_profit": round(recv - cost - fee_sum - refund, 2),
                                "buyer": o["buyer"], "paid": f"{o['paid_ago_min']} 分钟前", "paid_min": o["paid_ago_min"],
                                "p_status": "paid", "s_status": "pending", "sku": p["id"], "gap": "stuck", "gap_label": "卡住没走", "why": "；".join(o["hit"]) + "（虚拟付款 1 分钟内要发）",
                                "lvl": "red" if o["paid_ago_min"] >= 1 else "amb", "note": "", "vpid": p["id"], "void": o["id"]})
    except Exception:  # noqa: BLE001
        pass
    order = {"red": 0, "amb": 1, "grn": 2}
    out.sort(key=lambda x: (order[x["lvl"]], -x["paid_min"]))
    return {"items": out, "counts": {k: sum(1 for x in out if x["gap"] == k) for k in ("missed", "unmatched", "stuck", "desync", "pending", "ok")}}


@router.post("/orders/{oid}/fees")
def save_order_fees(oid: str, body: dict, u=Depends(get_current_user)):
    fees = {
        "platform": float(body.get("platform") or 0),
        "shipping": float(body.get("shipping") or 0),
        "repair": float(body.get("repair") or 0),
        "other": float(body.get("other") or 0),
        "refund": float(body.get("refund") or 0),
        "receivable": float(body.get("receivable") or 0),
        "note": str(body.get("note") or "").strip(),
    }
    S.setdefault("order_fees", {})[oid] = fees
    try:
        import pricing_stub
        pricing_stub.sync_commission_summary()
    except Exception:  # noqa: BLE001
        pass
    o = next((x for x in ORDERS if x["id"] == oid), None)
    return {"ok": True, "fees": fees, "item": _order_out(o) if o else None}


@router.post("/orders/{oid}/{action}")
def order_action(oid: str, action: str, body: dict | None = None, u=Depends(get_current_user)):
    body = body or {}
    o = next((x for x in ORDERS if x["id"] == oid), None)
    if not o:
        raise HTTPException(404, "没有这笔订单")
    if action == "capture":
        if o["s_status"] != "none":
            raise HTTPException(400, "这笔已经在系统里了")
        o["s_status"], o["unmatched"], o["candidates"] = "pending", "same_model", ["513211540215"]
        return {"msg": "已补抓进系统，现在是「对不上货」，请选货", **_order_out(o)}
    if action == "bind":
        code = body.get("sku_code")
        if not code:
            raise HTTPException(400, "先选一件货")
        if code not in (o.get("candidates") or []) and o.get("candidates"):
            raise HTTPException(400, "这件货不在候选里，别选错了")
        if any(x.get("sku") == code and x["id"] != oid and x["s_status"] == "pending" for x in ORDERS):
            raise HTTPException(400, "这件货已经被另一笔订单占用了，同一件货不能发两次")
        o["sku"] = code
        return {"msg": f"已绑定到货号 {code}", **_order_out(o)}
    if action == "ship":
        return ship({"sku_code": o.get("sku"), "order_id": oid, "tracking_no": body.get("tracking_no", ""), "scanned": body.get("scanned", "")}, u)
    if action == "resync":
        if o["p_status"] == "cancelled":
            o["s_status"] = "cancelled"
            ORDERS.remove(o)
            return {"msg": "已按平台状态取消，货释放回库存"}
        if o["p_status"] == "addr_changed":
            o["p_status"] = "paid"
            o["note"] = "地址已更新为买家新地址"
            return {"msg": "已改成新地址", **_order_out(o)}
        raise HTTPException(400, "这笔不需要同步")
    if action == "retry-callback":
        if o["s_status"] != "callback_failed":
            raise HTTPException(400, "这笔不用重传")
        o["s_status"], o["note"] = "shipped", "已重传，平台回读确认"
        return {"msg": "已重传，平台已确认（演示）", **_order_out(o)}
    raise HTTPException(400, "不认识这个动作")


# ------------------------------------------------------------------ 发布上架 / 发货出库（改演示库里的真实表）
def _shops(db):
    from app.models import SaleShop
    return db.query(SaleShop).order_by(SaleShop.sort_order).all()


@router.get("/plan")
def plan(u=Depends(get_current_user)):
    """每日上架计划：每个号今天用了几票（上限 10，下架也照计）。"""
    from app.enums import ShopListingStatus
    from app.models import SkuShopListing
    db = _db()
    try:
        shops = _shops(db)
        used = {s.id: db.query(SkuShopListing).filter(SkuShopListing.sale_shop_id == s.id, SkuShopListing.publish_status == ShopListingStatus.LISTED).count() for s in shops}
        extra = S.setdefault("quota_extra", {})
        from app.models import Sku
        from app.enums import SkuStatus
        conf = (db.query(Sku.sku_code, SkuShopListing.sale_shop_id).join(SkuShopListing, SkuShopListing.sku_id == Sku.id)
                .filter(Sku.status == SkuStatus.RESERVED, SkuShopListing.publish_status == ShopListingStatus.LISTED).all())
        return {"quota": RULES["publish"]["quota"], "interval": "每 20–30 分钟一票", "conflicts": [{"sku": c, "shop": sid} for c, sid in conf],
                "accounts": [{"id": s.id, "label": s.label, "used": min(10, used[s.id] + extra.get(s.id, 0)), "limit": 10} for s in shops]}
    finally:
        db.close()


@router.post("/publish")
def publish(body: dict, u=Depends(get_current_user)):
    """发布上架：服务端同样拦——没批过的价和图不发；超当日 10 票不发；一件货已锁单不发。"""
    from app.enums import ShopListingStatus, SkuStatus
    from app.models import ListingApproval, SaleShop, SkuShopListing, Sku
    from app.services import listing_approval as la
    code, shop_ids = body.get("sku_code"), body.get("shop_ids") or []
    if not shop_ids:
        raise HTTPException(400, "先选要发到哪几个号")
    db = _db()
    try:
        sku = db.query(Sku).filter(Sku.sku_code == code).first()
        if not sku:
            raise HTTPException(404, "没有这件货")
        if sku.status != SkuStatus.IN_STOCK:
            raise HTTPException(400, "这件货已经锁单或出库，不能再上架")
        used = {}
        done = []
        for sh in db.query(SaleShop).filter(SaleShop.id.in_(shop_ids)).all():
            en = _ent_of_shop(sh.label)
            if en and _ent_state(en) == "red":
                raise HTTPException(400, f"「{sh.label}」当前排期已满（暂停派新），请改选其他空闲店铺。")
        for sid in shop_ids:
            ap = la.current(db, sku.id, sid)
            # 两步法：草稿 / 待审态如在发布台直接确认，自动二审通过并发布；STALE/REJECTED/无价图仍拦截要求清洗
            if not ap or ap.status in ("NONE", "REJECTED", "STALE"):
                raise HTTPException(400, "这个号还没有二审确认的价和图，请先在下方确认或进价格清洗页一键确认。" + RULES["publish"]["penalty"])
            if ap.status in ("DRAFT", "SUBMITTED"):
                la.submit(db, sku, ap, u.id) if ap.status == "DRAFT" else None
                db.flush()
                la.review(db, sku, ap, approve=True, note="人工二审确认直接上架", user_id=u.id)
                db.flush()
            why = la.problem_for_publish(db, sku, ap)
            if why:
                raise HTTPException(400, "已确认内容失效：" + why)
            if db.query(SkuShopListing).filter(SkuShopListing.sku_id == sku.id, SkuShopListing.sale_shop_id == sid, SkuShopListing.publish_status == ShopListingStatus.LISTED).first():
                continue
            n = db.query(SkuShopListing).filter(SkuShopListing.sale_shop_id == sid, SkuShopListing.publish_status == ShopListingStatus.LISTED).count() + S.setdefault("quota_extra", {}).get(sid, 0)
            if n >= RULES["publish"]["quota"]:
                raise HTTPException(400, "这个号今天已经发满 10 票，第 11 票不发（下架删除也照计）。顺延到明天，已记在计划里。")
            db.add(SkuShopListing(sku_id=sku.id, sale_shop_id=sid, publish_status=ShopListingStatus.LISTED, listing_approval_id=ap.id, images=list(ap.images or [])))
            done.append(sid)
            S["undo"][(code, sid)] = NOW() + RULES["publish"]["undo_sec"]
        db.commit()
        return {"msg": f"已提交到 {len(done)} 个号，平台确认后才算上架成功（演示）", "shop_ids": done, "undo_sec": RULES["publish"]["undo_sec"], "demo": True}
    finally:
        db.close()


@router.post("/unpublish")
def unpublish(body: dict, u=Depends(get_current_user)):
    from app.models import Sku, SkuShopListing
    code, sid = body.get("sku_code"), body.get("shop_id")
    until = S["undo"].get((code, sid))
    if not until or NOW() > until:
        raise HTTPException(400, RULES["correction"])
    db = _db()
    try:
        sku = db.query(Sku).filter(Sku.sku_code == code).first()
        db.query(SkuShopListing).filter(SkuShopListing.sku_id == sku.id, SkuShopListing.sale_shop_id == sid).delete()
        db.commit()
        S["undo"].pop((code, sid), None)
        return {"msg": "已撤回，没有发到平台"}
    finally:
        db.close()


@router.post("/correction")
def correction(body: dict, u=Depends(get_current_user)):
    e = {"id": "e%d" % (len(S["exceptions"]) + 1), "who": ME.get(u.username, {}).get("name", u.username), "text": "更正申请：" + (body.get("text") or "已生效的动作要改"), "ruled": False, "t": datetime.now().strftime("%H:%M")}
    S["exceptions"].append(e)
    return {"msg": "已发给主管，在他的红灯清单里", "id": e["id"]}


@router.post("/ship")
def ship(body: dict, u=Depends(get_current_user)):
    """发货出库：核对货号（扫码）+ 快递单号必填；订单要和货一一对应；同一件货不能出两次。"""
    from app.enums import SkuStatus
    from app.models import SaleOrder, SalesOutbound, Sku
    code, oid, trk = body.get("sku_code"), body.get("order_id"), (body.get("tracking_no") or "").strip()
    if not code:
        raise HTTPException(400, "这笔订单还没有对上货，先去「对不上货」里选货")
    if (body.get("scanned") or "").strip() != code:
        raise HTTPException(400, "扫码的货号和订单要发的货号不一致，已拦住。" + RULES["ship"]["penalty"])
    if not trk:
        raise HTTPException(400, "快递单号必填（买家自提无需运单号）")
    o = next((x for x in ORDERS if x["id"] == oid), None)
    if o and (_gap(o)[0] in ("desync",) and o["p_status"] != "paid"):
        raise HTTPException(400, "买家已取消或改了地址，先去「状态不同步」里处理，再发货")
    db = _db()
    try:
        sku = db.query(Sku).filter(Sku.sku_code == code).first()
        if not sku or sku.status == SkuStatus.SHIPPED:
            raise HTTPException(400, "这件货已经出库了，不能重复出库")
        sku.status = SkuStatus.SHIPPED
        db.add(SalesOutbound(outbound_no="OUT%s%03d" % (datetime.now().strftime("%m%d%H%M"), (abs(hash(code)) % 900)), sku_id=sku.id, buyer_name=(o or {}).get("buyer", "买家"), outbound_type="XIANYU",
                             sale_price=Decimal(str((o or {}).get("amount", 0))), cost_price=sku.cost_price, tracking_no=trk, operator_id=u.id))
        so = db.query(SaleOrder).filter(SaleOrder.product_title == sku.product_name, SaleOrder.status == "PENDING").first()
        if so:
            so.status = "SHIPPED"
        db.commit()
        if o:
            o["s_status"], o["tracking"], o["sku"] = "shipped", trk, code
        try:
            import pricing_stub
            pricing_stub.sync_commission_summary()
        except Exception:  # noqa: BLE001
            c = S["commission"].setdefault(u.username, {"day_ok": 0, "day_pend": 0, "mon_ok": 0, "mon_pend": 0})
            c["day_pend"] += 10
            c["mon_pend"] += 10
            S["ledger"].setdefault(u.username, []).insert(0, {"t": "刚刚", "src": f"出库 {code}（实物）", "amt": 10, "st": "pend"})
        S["undo"][("ship", code)] = NOW() + RULES["ship"]["undo_sec"]
        return {"msg": "已出库，回传平台后才算完成（演示）", "undo_sec": RULES["ship"]["undo_sec"], "demo": True}
    finally:
        db.close()


@router.post("/reset")
def reset_all(u=Depends(get_current_user)):
    reset_orders()
    import virtual_stub as vs
    import copy
    vs.DB.clear()
    vs.DB.update(copy.deepcopy(vs.INIT))
    S["exceptions"].clear()
    S["picks"].clear()
    S["devreq"].clear()
    S["order_fees"].clear()
    import reception_stub
    reception_stub.reset()
    try:
        import pricing_stub
        pricing_stub.reset_state()
    except Exception:  # noqa: BLE001
        pass
    try:
        for fn in os.listdir(_IMG_DIR):
            if fn.startswith('slice-'):
                os.remove(os.path.join(_IMG_DIR, fn))
    except FileNotFoundError:
        pass
    try:
        from app.models import Sku
        from sqlalchemy.orm.attributes import flag_modified
        db = _db()
        for sk in db.query(Sku).all():
            keep = [x for x in (sk.images or []) if "/slice-" not in str(x)]
            if len(keep) != len(sk.images or []):
                sk.images = keep
                flag_modified(sk, "images")
        db.commit()
        db.close()
    except Exception:  # 清不掉就算了，重启会恢复
        pass
    S["owner"].clear()
    S["collab"].update(t0=NOW(), taken_by=None)
    return {"ok": True, "note": "订单和虚拟商品已恢复；实物的上架、出库要重启后端才会恢复"}


@router.get("/product-images")
def product_images():
    """演示：图片服务（product-image-service）按型号搜同款图的状态。真 ERP 是 GET /api/product-images。
    一个型号一次取 100 多张候选图，员工审核「图片合格 / 标记需处理」后，才进图池，给各号分不重复的上架图。"""
    items = [
        dict(spu_code="90000027", query="飞利浦 27M2N5510P", missing_photo_skus=0, status="READY", status_label="已就绪", formal_count=112, error=None),
        dict(spu_code="6951613923962", query="飞利浦 25M2N3200W", missing_photo_skus=0, status="READY", status_label="已就绪", formal_count=104, error=None),
        dict(spu_code="6978207303771", query="创维 F24G30F", missing_photo_skus=2, status="REVIEWING", status_label="等员工审核", formal_count=36, error=None),
        dict(spu_code="6974772491387", query="盈色 D75V", missing_photo_skus=0, status="REVIEWING", status_label="等员工审核", formal_count=54, error=None),
        dict(spu_code="", query="创维 F25G37F", missing_photo_skus=1, status="FAILED", status_label="搜图失败", formal_count=0, error="没有图片通过型号校验（型号写法对不上）"),
    ]
    counts = {"SEARCHING": 0, "REVIEWING": 2, "READY": 2, "REJECTED": 0, "FAILED": 1}
    return {"enabled": True, "review_url": "", "counts": counts, "pending_backfill": 0, "items": items}
