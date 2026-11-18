"""接待台（演示接口）：多平台消息聚合 + 链接识别 + 人机协同（和 Codex 会话绑定）+ 人兜底 + 实物接管。

设计稿见 `接待台_人机协同设计.md`。这里的对话、Codex 会话、指标都是**演示数据**，Codex 没有真的接；
形状尽量照真 ERP / 群控：
- 实物聊天（群控，闲鱼）：会话带「对上的那件货 listing_sku」、回复是异步建单（同号两次操作至少隔 30 秒，一次最多 9 张图）、
  能发的实拍只出买家能看的（库位照 / 订单截图 / 议价取证不出）、商品卡、仓库位置；响应考核 chat-sla（阅读 5 分钟、回复 15 分钟、23–9 点静默）。
- 虚拟 / 服务：自己接待，Codex 会话 + 专属 Skill 带客户，转人才轮到员工。
"""
from __future__ import annotations

import math
import re
import time
import zlib
from datetime import datetime
from urllib.parse import parse_qs, urlparse

from fastapi import APIRouter, Depends, HTTPException

from app.deps import get_current_user

router = APIRouter(prefix="/api/demo", tags=["接待台（演示接口）"])
NOW = lambda: time.time()  # noqa: E731
NAME = {"chenxm": "陈小满", "zhoubb": "周小北", "newbie": "新同事", "admin": "销售主管", "linxiao": "林晓"}
SEND_GAP_SEC = 30      # 真群控：同一个号两次操作至少隔 30 秒
MAX_IMAGES = 9         # 闲鱼一次选图上限

PLATFORMS = [
    {"k": "xianyu", "name": "闲鱼", "connected": True, "via": "群控（真 ERP 已有）", "rule": "回复是异步建单；同号两次操作至少隔 30 秒；一次最多 9 张图"},
    {"k": "xhs", "name": "小红书", "connected": False, "via": "未接入（演示数据）", "rule": "私信和笔记评论是两条通道；站外引流会被限流（待核）"},
    {"k": "taobao", "name": "淘宝", "connected": False, "via": "未接入（演示数据）", "rule": "平台禁止引导站外交易（待核）"},
    {"k": "jd", "name": "京东", "connected": False, "via": "未接入（演示数据）", "rule": "平台禁止引导站外交易（待核）"},
]
PLAT_NAME = {p["k"]: p["name"] for p in PLATFORMS}

# ------------------------------------------------------------------ 链接识别
PLAT_HOSTS = [("xianyu", ("goofish.com", "2.taobao.com", "xianyu.com")), ("xhs", ("xiaohongshu.com", "xhslink.com")),
              ("jd", ("jd.com", "3.cn")), ("taobao", ("taobao.com", "tmall.com", "tb.cn"))]
REMOTE_HOSTS = ("todesk.com", "sunlogin.oray.com", "oray.com", "sunloginclient.com")
DISK_HOSTS = ("pan.baidu.com", "aliyundrive.com", "alipan.com", "115.com", "quark.cn")
SHORT_HOSTS = ("xhslink.com", "tb.cn", "3.cn", "m.tb.cn")
OK_OUT_HOSTS = REMOTE_HOSTS          # 发给买家的链接只放行远控官方站（教客户装向日葵 / ToDesk）
# 我们自己的商品登记簿：（平台，商品 ID）→ 产品。演示登记，真环境要从各平台的发布记录同步。
REGISTRY = {
    ("xianyu", "9100000000001"): "v-mcd", ("xianyu", "9100000000002"): "v-kfc", ("xianyu", "9100000000003"): "v-dmn", ("xianyu", "9100000000004"): "v-wls",
    ("xianyu", "9100000000005"): "v-gpt", ("xianyu", "9100000000011"): "v-and", ("xianyu", "9100000000012"): "v-cad",
    ("taobao", "710000000011"): "v-and", ("taobao", "710000000003"): "v-dmn", ("jd", "100100000002"): "v-kfc",
    ("xhs", "note:66a000000000000000000001"): "v-cad", ("xhs", "note:66a000000000000000000002"): "v-bnb",
}
SKU_REG = {("xianyu", "9200000000001"): "513211540233-A", ("xianyu", "9200000000002"): "513211549229", ("xianyu", "9200000000003"): "BQAFLF1XF01011", ("xianyu", "9200000000004"): "513211540233-B"}


def _product(pid: str) -> dict | None:
    import virtual_stub as vs
    p = vs.DB.get(pid)
    if not p:
        return None
    return {"id": pid, "name": p["name"], "kind": p["kind"], "path": p.get("path", []), "price": p.get("price"), "cover": p.get("cover", "svc"),
            "learn": bool(p.get("learn")), "stock": (p.get("stock") or {}).get("avail")}


def resolve_link(url: str) -> dict:
    """看链接是什么：哪个平台、商品还是笔记、是不是我们自己的商品（对上哪个产品 / 服务类型）、能不能点。不会真的打开任何链接。"""
    raw = (url or "").strip().rstrip("。，,）)")
    out = {"url": raw, "host": "", "platform": "", "platform_name": "", "kind": "unknown", "kind_name": "识别不了", "id": "", "matched": False, "product": None, "sku": "",
           "safe": False, "note": ""}
    if not raw:
        return out
    u = raw if re.match(r"^https?://", raw, re.I) else "https://" + raw
    try:
        p = urlparse(u)
    except ValueError:
        return out
    host = (p.hostname or "").lower()
    out["host"] = host
    if "." not in host:
        out["note"] = "不是一个链接。"
        return out
    hm = lambda hs: any(host == h or host.endswith("." + h) for h in hs)  # noqa: E731
    if hm(REMOTE_HOSTS):
        out.update(kind="remote", kind_name="远控工具（向日葵 / ToDesk）", safe=True, note="远控官方站。服务类对话里是正常的：教客户下载安装用；识别码要客户自己念，临时有效。")
        return out
    if hm(DISK_HOSTS):
        out.update(kind="disk", kind_name="网盘 / 下载链接", note="来路不明的下载包不要点、不要下载。要让客户下载工具，只给远控官方站。")
        return out
    plat = next((k for k, hs in PLAT_HOSTS if hm(hs)), "")
    if not plat:
        out["note"] = "不是我们做的四个平台，也不是远控官方站：来路不明，不要点，不要让智能体自己打开。"
        return out
    out.update(platform=plat, platform_name=PLAT_NAME[plat])
    q = parse_qs(p.query)
    pid = next((q[k][0] for k in ("id", "itemId", "item_id", "skuId") if k in q), "")
    path = p.path or ""
    kind = "item"
    if plat == "xhs":
        m = re.search(r"/(?:explore|discovery/item)/([0-9a-f]{16,})", path)
        if m:
            kind, pid = "note", "note:" + m.group(1)
        else:
            m = re.search(r"/goods-detail/([0-9a-zA-Z]{8,})", path)
            pid = pid or (m.group(1) if m else "")
    else:
        m = re.search(r"/item/(\d+)", path) or re.search(r"/(\d{6,})(?:\.html)?$", path)
        pid = pid or (m.group(1) if m else "")
    if not pid and hm(SHORT_HOSTS):
        out.update(kind="short", kind_name="短链接", note="短链要展开才能识别，系统不会自动去打开。请买家发商品名，或让他发完整链接。")
        return out
    if not pid:
        out.update(kind="shop", kind_name="店铺 / 其它页面", note="没有商品编号，对不上我们的商品。")
        return out
    out.update(kind=kind, kind_name="商品链接" if kind == "item" else "笔记（不是商品）", id=pid, safe=True)
    prod = REGISTRY.get((plat, pid))
    sku = SKU_REG.get((plat, pid))
    if prod:
        pr = _product(prod)
        if pr:
            out.update(matched=True, product=pr)
            out["note"] = ("来自笔记：按笔记对上了这个服务，要人再确认一次买家要的是不是它。" if kind == "note" else "对上了我们的商品。")
    elif sku:
        out.update(matched=True, sku=sku, note="对上了这件货（群控按标题和价格对上的，回给前端 listing_sku）。")
    else:
        out["note"] = "我们的商品登记里没有这个编号：可能是别家的商品、已下架的商品，或还没同步。要人确认，不要凭链接猜。"
    return out


URL_RE = re.compile(r"(https?://[^\s，。）)]+|(?:[a-z0-9-]+\.)+(?:com|cn|top|xyz|net|cc)/[^\s，。）)]*)", re.I)


def _links_in(text: str) -> list[dict]:
    return [resolve_link(m.group(0)) for m in URL_RE.finditer(text or "")]


# ------------------------------------------------------------------ 会话
def _t(m_ago: float) -> str:
    return datetime.fromtimestamp(NOW() - m_ago * 60).strftime("%H:%M")


def _m(who, text, ago, **kw):
    d = "in" if who == "buyer" else "sys" if who == "sys" else "out"
    return {"dir": d, "who": who, "text": text, "t": _t(ago), "status": "sent" if d == "out" else "", **kw}


def _pn(pid: str, k: str, dft: str = "") -> str:
    import virtual_stub as vs
    return (vs.DB.get(pid) or {}).get("notes", {}).get(k, dft)


ONBOARD = ["发接入指引（教客户装向日葵 / ToDesk）", "客户装好，生成临时识别码", "确认客户授权的设备和范围", "接入并核对设备"]
MODES = {
    "auto": {"t": "全自动", "d": "智能体直接回买家，人只看。只给低风险、规则明确的情况用。"},
    "draft": {"t": "草稿待审", "d": "智能体起草，人点「发送」或改了再发，驳回要写原因。新客、报价、退款类默认这个。"},
    "suggest": {"t": "只建议", "d": "智能体在内部频道给建议，人自己回买家。"},
    "manual": {"t": "人工", "d": "智能体暂停，全部人回。"},
}


def _agent(skill, status="running", last="", session=None, steps=None, step=None):
    sid = session or "cx-" + format(zlib.crc32((skill + last).encode()) & 0xFFFFFFFF, "08x")
    return {"session": sid, "runner": "云端 Codex Desktop（会话绑定这条对话）", "skill": skill, "status": status, "last": last, "steps": steps, "step": step}


def _build() -> list[dict]:
    g = lambda pid: _pn(pid, "guide")  # noqa: E731
    C = []

    def add(**c):
        c.setdefault("owner", {"type": "agent", "who": ""})
        c.setdefault("mode", "auto")
        c.setdefault("triggers", [])
        c.setdefault("draft", None)
        c.setdefault("internal", [])
        c.setdefault("commitments", [])
        c.setdefault("handoff", None)
        c.setdefault("closed", False)
        c.setdefault("due_min", None)
        c.setdefault("tags", [])
        c.setdefault("danger", "")
        c.setdefault("buyer_stats", {"orders": 0, "refunds": 0, "talk": 1})
        C.append(c)

    add(id="r-v1", domain="virt", platform="xianyu", account="演示号·卡券1", buyer="阿杰", pid="v-mcd", item_url="https://www.goofish.com/item?id=9100000000001", closed=True,
        order={"status": "已发码", "amount": 47.66}, buyer_stats={"orders": 3, "refunds": 0, "talk": 4}, tags=["老客"], agent=_agent("卡券接待 Skill v0.2（话术取自产品卡）", "idle", "自动发码并回使用方法"),
        msgs=[_m("buyer", "拍了，这个怎么用？", 9), _m("sys", "付款后 0 分 20 秒：发货检查通过（上一单已确认、退款累计未达线、不在黑名单）→ 已自动发码", 9),
              _m("bot", g("v-mcd") or "麦当劳 App → 我的 → 优惠券 → 兑换。", 9, tag="自动回复·使用方法"), _m("buyer", "好了，谢谢", 6)])
    add(id="r-v2", domain="virt", platform="xianyu", account="演示号·卡券1", buyer="momo", pid="v-kfc", item_url="https://www.goofish.com/item?id=9100000000002", mode="draft",
        triggers=[{"code": "used_code", "text": "买家说券码已被使用，但我们这边查是没用过的：要人核对码库状态和买家截图（不能自动判）"}], due_min=None,
        order={"status": "已发码", "amount": 18.9}, buyer_stats={"orders": 1, "refunds": 0, "talk": 3},
        agent=_agent("卡券接待 Skill v0.2（话术取自产品卡）", "paused", "买家说券码已使用：触发「卡密已用」，已暂停自动回复并转人"),
        handoff={"who": "买家 momo，闲鱼，肯德基随心配单人餐，订单已发码", "ask": "兑换页提示券码已使用，他说自己没用过", "done": ["已回「请发报错截图」", "已收到截图"], "stuck": "要核对码库里这张码的状态，智能体没有权限查", "next": "查码库状态；确认未用就换一张新码并回买家，已用就按规则解释"},
        msgs=[_m("buyer", "券码提示已经被使用了，可是我根本没用过", 14), _m("bot", "收到，这个我转给同事核对，请先发一张报错截图。", 14, tag="自动回复·转人"), _m("buyer", "[图片] 兑换页提示「券码已使用」", 12)])
    add(id="r-v3", domain="virt", platform="taobao", account="演示号·卡券2", buyer="林先生", pid="v-dmn", item_url="https://item.taobao.com/item.htm?id=710000000003",
        order={"status": "咨询中", "amount": 0}, agent=_agent("卡券接待 Skill v0.2（话术取自产品卡）", "running", "库存为 0，自动回复并提示先别拍"),
        msgs=[_m("buyer", "有货吗？今天能发吗", 5), _m("bot", "这款暂时没有库存，已经自动暂停上架了，到货后会补上。先不要拍，拍了系统也发不出码。", 5, tag="自动回复·库存为 0")])
    add(id="r-v4", domain="virt", platform="xianyu", account="演示号·卡券1", buyer="不吃香菜", pid="v-wls", item_url="https://www.goofish.com/item?id=9100000000004", mode="draft",
        triggers=[{"code": "refund", "text": "买家申请退款，这款本周退款率已到 8% 停止线：要人处理，处理完回产品卡「周复盘」记一笔"}], due_min=None,
        order={"status": "已发码", "amount": 19.99}, buyer_stats={"orders": 2, "refunds": 1, "talk": 5}, tags=["有过退款"],
        agent=_agent("卡券接待 Skill v0.2（话术取自产品卡）", "paused", "退款：按规则转人"),
        handoff={"who": "买家不吃香菜，闲鱼，华莱士双人随心拼，已发码", "ask": "要退款，说已发码但没用", "done": ["已按规则回复退款规则"], "stuck": "已发码未使用能不能退，规则要人判断；这款退款率已到 8%", "next": "人决定退或不退；退的话走退款并回买家，不退要给出理由"},
        msgs=[_m("buyer", "我想退款，不想要了", 8), _m("bot", _pn("v-wls", "refund") or "未发码可退；已发码未使用，请联系人工。", 8, tag="自动回复·退款规则"), _m("buyer", "已经发码了，但我没用", 7)])
    add(id="r-v5", domain="virt", platform="xianyu", account="演示号·卡券2", buyer="Eason", pid="v-gpt", item_url="https://www.goofish.com/item?id=9100000000005", danger="密码",
        triggers=[{"code": "password", "text": "买家在聊天里发了密码：要他撤回，我们不记录、不转发、不进任何截图和教程；只收账号邮箱"}],
        order={"status": "待充值", "amount": 138}, agent=_agent("卡券接待 Skill v0.2（话术取自产品卡）", "paused", "检测到密码：已暂停，提示撤回"),
        msgs=[_m("buyer", "邮箱 e***@mail.com，密码是 ********（演示：已打码）", 4), _m("bot", "请不要在聊天里发密码。代充只需要账号邮箱，请把刚才那条撤回。", 4, tag="自动回复·安全提示")])
    add(id="r-v6", domain="virt", platform="jd", account="演示号·卡券3", buyer="京东用户8841", pid="v-kfc", item_url="https://item.jd.com/100100000002.html", mode="draft",
        order={"status": "咨询中", "amount": 0}, buyer_stats={"orders": 0, "refunds": 0, "talk": 1},
        agent=_agent("卡券接待 Skill v0.2（话术取自产品卡）", "draft_ready", "起草了一条回复，等人审"),
        draft={"text": "这个券是肯德基随心配 2+1 单人餐，到店出示券码兑换，单张券一次用一张，不能和其他优惠叠加。拍下后系统会自动发码。", "basis": ["产品卡 · 使用方法", "产品卡 · 话术（叠加规则）"], "conf": 0.78, "why": "买家问能不能叠加：产品卡里写了「不能叠加」，把握较高，但是新客首问，按规则先给人审"},
        msgs=[_m("buyer", "这个券和别的优惠能叠加吗？", 3)])
    add(id="r-s1", domain="svc", platform="xianyu", account="演示号·服务1", buyer="阿远", pid="v-and", item_url="https://www.goofish.com/item?id=9100000000011", due_min=38,
        order={"status": "已付款", "amount": 99}, buyer_stats={"orders": 1, "refunds": 0, "talk": 6},
        agent=_agent("安卓刷机 专属 Skill v1.0", "running", "识图：向日葵已安装，识别码已生成；等客户点允许远程控制", session="cx-7f3a91c2", steps=ONBOARD, step=2),
        msgs=[_m("sys", "付款 → 智能体接手接待（云端 Codex Desktop + 安卓刷机专属 Skill）", 22), _m("agent", "你好，先把向日葵装好，教程在这里（手绘教程 · 约 2 分钟）。装好后点右上角生成临时识别码发我，不要发密码。", 21, tag="智能体·接入指引"),
              _m("buyer", "[图片] 向日葵主界面，识别码显示在中间", 15), _m("agent", "已识别：向日葵已安装，识别码已生成。下一步请点「允许远程控制」，我确认授权范围后再接入。", 15, tag="智能体·识图判断下一步")])
    add(id="r-s2", domain="svc", platform="xianyu", account="演示号·服务1", buyer="小周", pid="v-and", item_url="https://www.goofish.com/item?id=9100000000011", due_min=21,
        triggers=[{"code": "mac", "text": "客户用的是 Mac：这项 Skill 只覆盖 Windows 客户机，Mac 要人判断能不能接，不能接就退款（别让智能体硬做）"}],
        order={"status": "已付款", "amount": 99}, agent=_agent("安卓刷机 专属 Skill v1.0", "paused", "客户是 Mac，超出 Skill 范围：已暂停并转人", session="cx-1b44d0e7", steps=ONBOARD, step=0),
        handoff={"who": "买家小周，闲鱼，安卓刷机服务，已付款 99 元", "ask": "要刷机", "done": ["已确认环境：苹果电脑 Mac"], "stuck": "Skill 只覆盖 Windows 客户机", "next": "人判断：能接就走人工远程；不能接就退款并说明"},
        msgs=[_m("sys", "付款 → 智能体接手接待", 40), _m("agent", "你好，请问你的电脑是 Windows 还是苹果电脑？", 39, tag="智能体·确认环境"), _m("buyer", "苹果电脑，Mac", 31), _m("agent", "这单我先转给同事，请稍等。", 31, tag="智能体·转人")])
    add(id="r-s3", domain="svc", platform="taobao", account="演示号·服务2", buyer="大宝", pid="v-and", item_url="https://item.taobao.com/item.htm?id=710000000011", due_min=12,
        triggers=[{"code": "not_understood", "text": "教程已经发过去，客户还是看不懂：人介入（电话 / 语音带他一步步来；一小时时效只剩 12 分钟，疑难可转同行）"}],
        order={"status": "已付款", "amount": 99}, buyer_stats={"orders": 1, "refunds": 0, "talk": 8}, tags=["小白"],
        agent=_agent("安卓刷机 专属 Skill v1.0", "stuck", "两次讲解客户仍不会：已暂停", session="cx-93a0ee51", steps=ONBOARD, step=1),
        handoff={"who": "买家大宝，淘宝，安卓刷机服务，已付款 99 元，是小白", "ask": "要刷机，但装不好远控", "done": ["已发手绘教程", "第 2 次换说法重讲"], "stuck": "客户看不懂圈两下的教程，第 2 次仍没装好向日葵", "next": "人打电话 / 语音带他装；一小时时效只剩 12 分钟，装不上就转同行"},
        msgs=[_m("agent", "已发送手绘教程，请按第 3 步操作，装好后告诉我。", 36, tag="智能体·发教程"), _m("buyer", "我看不懂你发的这个，圈两下我怎么知道点哪里", 30), _m("agent", "我换个说法再讲一遍……（第 2 次）", 29, tag="智能体·重讲"),
              _m("buyer", "还是不会，能不能直接帮我弄", 24), _m("sys", "智能体两次讲解客户仍不会：暂停智能体，转人", 24)])
    add(id="r-s4", domain="svc", platform="xhs", account="演示号·小红书1", buyer="设计小李", pid="v-cad", item_url="https://www.xiaohongshu.com/explore/66a000000000000000000001", due_min=55, mode="draft",
        triggers=[{"code": "blurry", "text": "AI 工作流类：客户发来的图很糊，清晰原图才能保证质量；要人先判断能不能做、要不要让客户重拍（做不出来别接）"}],
        order={"status": "咨询中", "amount": 0}, buyer_stats={"orders": 0, "refunds": 0, "talk": 2}, tags=["来自笔记"],
        agent=_agent("CAD 描图 AI 工作流 v0.3（赛马中）+ 人工校对", "draft_ready", "起草了一条重拍建议，等人审", session="cx-c70d2a18"),
        draft={"text": "你发的图边缘有点糊，描出来的线可能不准。能不能在亮一点的地方、正对着重拍一张？或者直接发电子版图纸，我们按电子版做更稳。", "basis": ["产品卡 · 风险（清晰原图才能保证质量）"], "conf": 0.66, "why": "原图质量会影响交付，建议先让客户重拍；把握中等，转人审"},
        handoff={"who": "买家设计小李，小红书（从笔记进来），CAD 描图", "ask": "把手机拍的纸质平面图转 DWG，明天要用", "done": ["收到图片"], "stuck": "图糊，AI 工作流可能做不准", "next": "人看图决定接不接；接就先报价并说明可能有误差"},
        msgs=[_m("buyer", "[图片] 手机拍的纸质平面图，边缘有点糊", 7), _m("buyer", "能转成 DWG 吗，明天要用", 6)])
    add(id="r-s5", domain="svc", platform="xhs", account="演示号·小红书1", buyer="民宿阿姨", pid="v-bnb", item_url="https://www.xiaohongshu.com/discovery/item/66a000000000000000000002", mode="draft",
        order={"status": "咨询中", "amount": 0}, agent=_agent("民宿图精修 AI 工作流 v0.1（赛马中）", "draft_ready", "起草了一条价格说明，等人审", session="cx-5e12b9aa"),
        draft={"text": "民宿房源图是只做真实照片的调色精修，不会生成房间里不存在的设施（平台不允许）。整套 20 张的价格我们先看一下你的图再报，好吗？", "basis": ["产品卡 · 风险（只做真实照片精修）"], "conf": 0.6, "why": "买家问价：报价口径还在测（赛马中），不自动报价"},
        msgs=[_m("buyer", "你好，我家民宿 20 张图能修吗？多少钱", 2)])
    add(id="r-s6", domain="svc", platform="xianyu", account="演示号·服务1", buyer="游戏玩家", pid="v-game", item_url="https://www.goofish.com/item?id=9100000000099", due_min=None,
        triggers=[{"code": "unknown_link", "text": "买家发了一个来路不明的链接，也不是我们的商品链接：不自动打开，要人看一眼"}],
        order={"status": "咨询中", "amount": 0}, agent=_agent("（这项服务还没入库，没有可执行 Skill）", "paused", "商品链接对不上，链接来路不明：已暂停", session=None),
        msgs=[_m("buyer", "我打三角洲一直报虚拟化，你看这个能解决吗 https://xz-fix.top/a1b2c", 3)])

    # ---- 实物（聊天外包出去，只在外包搞不定时我们接管）
    ph = dict(domain="phys", platform="xianyu", mode="manual", agent=None, owner={"type": "outsource", "who": "外包客服小张"})
    add(id="a1", account="果果数码", buyer="阿杰-数码控", sku="513211540233-A", item_url="https://www.goofish.com/item?id=9200000000001", due_min=None, read_by="外包客服小张", waited_sec=7 * 60, escalated=False, owners=["陈小满"], ask="photo",
        order={"status": "咨询中", "amount": 0}, buyer_stats={"orders": 1, "refunds": 0, "talk": 3}, **ph,
        msgs=[_m("buyer", "你好，这个显示器还在吗", 40), _m("outsource", "在的亲，今天可以拍", 38, tag="外包客服小张"), _m("buyer", "能发一下屏幕的实拍细节吗？有没有划痕", 7)])
    add(id="a2", account="果果数码", buyer="momo_小仓鼠", sku="513211549229", item_url="https://www.goofish.com/item?id=9200000000002", due_min=None, read_by=None, waited_sec=19 * 60, escalated=True, owners=["陈小满"], ask="price",
        order={"status": "咨询中", "amount": 0}, buyer_stats={"orders": 0, "refunds": 0, "talk": 2}, **ph,
        triggers=[{"code": "sla_reply", "text": "买家等了 19 分钟还没人回，超过回复 15 分钟的考核，已升级"}],
        msgs=[_m("buyer", "最低多少能出？一口价吗", 19)])
    add(id="a3", account="小满优选", buyer="林先生", sku="BQAFLF1XF01011", item_url="https://www.goofish.com/item?id=9200000000003", due_min=None, read_by=None, waited_sec=26 * 60, escalated=True, owners=["陈小满"], ask="which",
        order={"status": "咨询中", "amount": 0}, buyer_stats={"orders": 0, "refunds": 0, "talk": 2}, **ph,
        triggers=[{"code": "sla_reply", "text": "买家等了 26 分钟还没人回，超过回复 15 分钟的考核，已升级"}],
        msgs=[_m("buyer", "你们有几台？我要成色最好的那台", 26)])
    add(id="a4", account="周周二手", buyer="设备迷", sku="513211540233-B", item_url="https://www.goofish.com/item?id=9200000000004", due_min=None, read_by="外包客服小张", waited_sec=11 * 60, escalated=False, owners=["周小北"], ask="video",
        order={"status": "咨询中", "amount": 0}, buyer_stats={"orders": 0, "refunds": 0, "talk": 4}, **ph,
        msgs=[_m("buyer", "能当面验机吗？或者录一段屏幕无坏点的视频", 11)])
    for c in C:
        c["last_send"] = 0
        if c["triggers"] and c["mode"] == "auto" and c["agent"]:
            c["mode"] = "manual" if any(x["code"] in ("password", "mac", "unknown_link", "not_understood") for x in c["triggers"]) else "draft"
    return C


CONVS: list[dict] = []
LAST_SEND: dict[str, float] = {}
KILL = {"on": False}
OUTSOURCE_NOTES: dict[str, list] = {}


def reset():
    global CONVS
    CONVS = _build()
    LAST_SEND.clear()
    KILL["on"] = False
    OUTSOURCE_NOTES.clear()
    CRM.clear()


def _ensure():
    if not CONVS:
        reset()


def _state(c: dict) -> str:
    if c["closed"]:
        return "done"
    if c["owner"]["type"] == "human":
        return "human"
    if c["triggers"]:
        return "need"
    if c["draft"]:
        return "draft"
    if c["domain"] == "phys":
        return "outsource"
    return "agent" if c["domain"] == "svc" else "bot"


def _urgent(c: dict) -> float:
    """兜底队列的排序分：越小越急。到期分钟数、已等分钟数、有安全红线的先。"""
    s = 1000.0
    if c.get("danger"):
        s -= 500
    if c.get("due_min") is not None:
        s = min(s, c["due_min"])
    if c.get("waited_sec"):
        s = min(s, 15 - c["waited_sec"] / 60)
    return s


def _summary(c: dict) -> dict:
    prod = _product(c["pid"]) if c.get("pid") else None
    last = next((m for m in reversed(c["msgs"]) if m["dir"] != "sys"), c["msgs"][-1])
    st = _state(c)
    return {"id": c["id"], "domain": c["domain"], "platform": c["platform"], "platform_name": PLAT_NAME[c["platform"]], "account": c["account"], "buyer": c["buyer"], "state": st,
            "owner": c["owner"], "mode": c["mode"], "need": c["triggers"][0]["text"] if c["triggers"] else "", "danger": c.get("danger", ""), "due_min": c.get("due_min"),
            "waited_sec": c.get("waited_sec"), "escalated": c.get("escalated", False), "last": last["text"][:46], "last_t": last["t"], "last_who": last["who"], "urgent": _urgent(c) if st in ("need", "draft") else 1000,
            "draft": bool(c["draft"]), "agent_status": (c["agent"] or {}).get("status", ""), "item_title": (prod or {}).get("name") or _sku_name(c.get("sku")),
            "product": prod, "read_by": c.get("read_by"), "owners": c.get("owners", []), "conversation_id": c["id"], "item_url": c.get("item_url", "")}


def _nm(s):
    n = s.product_name or s.model or ""
    return n if (s.brand and s.brand in n) else f"{s.brand or ''} {n}".strip()


def _sku_name(code):
    if not code:
        return ""
    try:
        import workbench_stub as wb
        from app.models import Sku
        db = wb._db()
        try:
            s = db.query(Sku).filter(Sku.sku_code == code).first()
            return _nm(s) if s else ""
        finally:
            db.close()
    except Exception:
        return ""


def _dom(domain: str):
    return (lambda c: c["domain"] in ("virt", "svc")) if domain == "vs" else (lambda c: c["domain"] == "phys")


# ------------------------------------------------------------------ 实物：WMS 信息页
_PRIVATE = ("_order_", "/location", "location_images", "negotiat", "redispatch")


def buyer_safe(url: str) -> bool:
    p = urlparse(url or "").path.lower() or (url or "").lower()
    return bool(url) and not any(m in p for m in _PRIVATE)


def _sku_info(code: str | None) -> dict | None:
    if not code:
        return None
    try:
        import workbench_stub as wb
        from app.enums import SkuStatus
        from app.models import Sku
        db = wb._db()
    except Exception:
        return None
    try:
        s = db.query(Sku).filter(Sku.sku_code == code).first()
        if not s:
            return None
        imgs = [u for u in (s.images or []) if isinstance(u, str) and buyer_safe(u)]
        real = [u for u in imgs if "/inspection/listing/" in u]
        defect = [u for u in imgs if "/inspection/defect/" in u]
        cost = float(s.cost_price) if s.cost_price else 0
        same = db.query(Sku).filter(Sku.model == s.model, Sku.status == SkuStatus.IN_STOCK).limit(12).all() if s.model else []
        orig_imgs = [u for u in imgs if "/sku/product/" in u] or real[:2]
        sug_p = float(s.suggest_price) if s.suggest_price else None
        v_thumb = real[0] if real else (imgs[0] if imgs else "/api/demo-img/MON1-1.jpg")
        return {"code": s.sku_code, "name": _nm(s), "model": s.model, "spec": getattr(s, "spec", None), "grade": s.condition_grade or "",
                "location": s.location_code or "", "short_code": s.short_code or "", "status": str(getattr(s.status, "value", s.status)), "suggest_price": sug_p,
                "floor": math.ceil(cost * 1.3) if cost else 0, "real": real, "defect": defect, "orig": orig_imgs,
                "qc_report": "/api/demo-img/GC-QC-REPORT.jpg",
                "videos": [{"title": f"{_nm(s)} · 15秒通电成色实拍视频.mp4", "thumb": v_thumb, "duration": "00:15"}],
                "shipping_note": "亲，本店默认不包邮（顺丰/京东加固防震固定运费 ¥12），当天 17:00 前拍下当天发出；杭州本地也支持预约到仓当面验机自提。",
                "price_note": f"亲，这台 {_nm(s)} 已对照最新闲鱼同成色成交行情核定实价 ¥{int(sug_p) if sug_p else '面议'}，一机一码原图实拍，签收 48 小时功能异常包退换。",
                "slots": [{"code": x.sku_code, "grade": x.condition_grade or "未分级", "location": x.location_code or "", "me": x.sku_code == s.sku_code} for x in same]}
    finally:
        db.close()


PICKUP = "（演示地址）杭州市富阳区恩波大道仓库自提点，工作日 9:30–18:30，到仓前闲鱼站内留言预约核验"

ADDRESS_POOL = [
    {"id": "ad1", "label": "① 富阳总部主仓（自提/退换）", "addr": "浙江省杭州市富阳区银湖街道恩波大道 282 号泛亚数码仓（支持当面通电验机自提）"},
    {"id": "ad2", "label": "② 富春湾新城备仓", "addr": "浙江省杭州市富阳区富春湾新城智能制造园 B 区 3 号仓"},
    {"id": "ad3", "label": "③ 滨江高新同城闪送点", "addr": "浙江省杭州市滨江区江南大道网商路交界同城交接点（仅限同城骑手取件）"},
    {"id": "ad4", "label": "④ 余杭未来科技城自提点", "addr": "浙江省杭州市余杭区文一西路未来科技城电子仓自提柜"},
    {"id": "ad5", "label": "⑤ 西湖翠苑数码检测点", "addr": "浙江省杭州市西湖区教工路百脑汇周边合作验机自提点"},
    {"id": "ad6", "label": "⑥ 下沙大学城校园自提点", "addr": "浙江省杭州市钱塘区学源街高教园区东区合作驿站"},
    {"id": "ad7", "label": "⑦ 萧山钱江世纪城交接点", "addr": "浙江省杭州市萧山区鸿宁路商务中心 1 楼顺丰驻点"},
    {"id": "ad8", "label": "⑧ 拱墅运河上街同城点", "addr": "浙江省杭州市拱墅区台州路运河商务区合作网点"},
    {"id": "ad9", "label": "⑨ 临平高铁北站快发仓", "addr": "浙江省杭州市临平区迎宾路电商物流园快发档口"},
    {"id": "ad10", "label": "⑩ 大件显示器木架退回专仓", "addr": "浙江省杭州市富阳区春江街道大件屏幕防震签收专仓（拒收到付）"},
]


# ------------------------------------------------------------------ 接口
def _find(cid):
    _ensure()
    c = next((x for x in CONVS if x["id"] == cid), None)
    if not c:
        raise HTTPException(404, "没有这个会话")
    return c


def _me(u):
    return NAME.get(u.username, u.username)


@router.get("/inbox")
def inbox(domain: str = "vs", _=Depends(get_current_user)):
    _ensure()
    items = [_summary(c) for c in CONVS if _dom(domain)(c)]
    counts = {"all": len(items)}
    for k in ("need", "draft", "agent", "bot", "human", "outsource", "done"):
        counts[k] = len([i for i in items if i["state"] == k])
    counts["queue"] = counts["need"] + counts["draft"]
    return {"items": items, "counts": counts, "platforms": PLATFORMS, "kill": KILL["on"], "modes": MODES,
            "doorbell": {"online": 7, "total": 8, "desc": "AdsPower im_watch.py 常驻 /im 监听未读角标与 WS 帧（延迟 < 2秒）"},
            "address_pool": ADDRESS_POOL}


@router.get("/inbox-summary")
def inbox_summary(_=Depends(get_current_user)):
    _ensure()
    vs = [c for c in CONVS if c["domain"] != "phys" and _state(c) in ("need", "draft")]
    ph = [c for c in CONVS if c["domain"] == "phys" and c.get("escalated")]
    return {"vs_queue": len(vs), "phys_esc": len(ph)}


@router.get("/inbox/{cid}")
def inbox_one(cid: str, u=Depends(get_current_user)):
    c = _find(cid)
    out = _summary(c)
    links = []
    for m in c["msgs"]:
        for lk in _links_in(m["text"]):
            links.append(dict(lk, in_msg=m["text"][:24]))
    quick = []
    if c.get("pid"):
        for k, lb in (("guide", "使用方法"), ("refund", "退款规则"), ("script", "话术")):
            if _pn(c["pid"], k):
                quick.append({"k": lb, "text": _pn(c["pid"], k)})
    quick += [{"k": "稍等", "text": "收到，我这边马上核对，请稍等几分钟。"}, {"k": "要截图", "text": "麻烦发一张报错页面的截图（不要拍到密码和验证码）。"}]
    info = _sku_info(c.get("sku")) if c["domain"] == "phys" else None
    out.update(msgs=c["msgs"], internal=c["internal"], draft=c["draft"], agent=c["agent"], commitments=c["commitments"], handoff=c["handoff"], order=c.get("order"), buyer_stats=c["buyer_stats"],
               tags=c["tags"], triggers=c["triggers"], item=resolve_link(c.get("item_url", "")), links=links, quick=quick, info=info, pickup=PICKUP if c["domain"] == "phys" else "",
               mine=c["owner"]["type"] == "human" and c["owner"]["who"] == _me(u), kill=KILL["on"], modes=MODES, notes=OUTSOURCE_NOTES.get(cid, []), ask=c.get("ask", ""),
               max_images=MAX_IMAGES, gap_sec=SEND_GAP_SEC, address_pool=ADDRESS_POOL)
    return out


@router.get("/link-resolve")
def link_resolve(url: str = "", _=Depends(get_current_user)):
    return resolve_link(url)


@router.post("/inbox/{cid}/claim")
def claim(cid: str, u=Depends(get_current_user)):
    c = _find(cid)
    if c["closed"]:
        raise HTTPException(400, "这个会话已经处理完了")
    if c["owner"]["type"] == "human" and c["owner"]["who"] != _me(u):
        raise HTTPException(400, f"{c['owner']['who']} 正在处理这个会话：同一时间只能一个人（或一个智能体）操作，不然会重复回复买家。")
    prev = c["owner"]["type"]
    c["owner"] = {"type": "human", "who": _me(u)}
    if c.get("agent"):
        c["agent"]["status"] = "paused"
        c["agent"]["last"] = f"{_me(u)} 已接管，暂停"
    c["msgs"].append(_m("sys", f"{_me(u)} 接管了" + ("，智能体已暂停，不会再自动回复；它留下的交接摘要在上面。" if prev == "agent" else "（实物聊天原来是外包客服在回，现在由你接管）。"), 0))
    return {"ok": True}


@router.post("/inbox/{cid}/release")
def release(cid: str, body: dict, u=Depends(get_current_user)):
    c = _find(cid)
    if not (c["owner"]["type"] == "human" and c["owner"]["who"] == _me(u)):
        raise HTTPException(400, "现在不是你在处理，不用交还")
    note = (body.get("note") or "").strip()
    if len(note) < 6:
        raise HTTPException(400, "交还要写一句话（至少 6 个字）：你已经决定了什么、答应了买家什么、后面不能做什么。智能体 / 外包客服接着做要看这个。")
    if any(t["code"] in ("used_code", "refund", "password") for t in c["triggers"]):
        raise HTTPException(400, "这类问题（卡密已用 / 退款 / 密码）要先「已处理」结案，不能直接交还自动回复。")
    for cm in body.get("commitments") or []:
        cm = (cm or "").strip()
        if cm:
            c["commitments"].append({"text": cm, "by": _me(u), "t": datetime.now().strftime("%H:%M")})
    c["commitments"].append({"text": "交还备注：" + note, "by": _me(u), "t": datetime.now().strftime("%H:%M"), "note": True})
    c["owner"] = {"type": "outsource", "who": "外包客服小张"} if c["domain"] == "phys" else {"type": "agent", "who": ""}
    if c.get("agent"):
        c["agent"]["status"] = "running"
        c["agent"]["last"] = "收到人的交还备注，继续"
    c["triggers"] = [t for t in c["triggers"] if t["code"] in ("sla_reply",)] if c["domain"] == "phys" else []
    c["msgs"].append(_m("sys", f"{_me(u)} 交还给{'外包客服' if c['domain'] == 'phys' else '智能体'}：{note}", 0))
    return {"ok": True}


@router.post("/inbox/{cid}/mode")
def set_mode(cid: str, body: dict, u=Depends(get_current_user)):
    c = _find(cid)
    m = body.get("mode")
    if m not in MODES or not c.get("agent"):
        raise HTTPException(400, "没有这个模式")
    if m == "auto" and c["triggers"]:
        raise HTTPException(400, "有未处理的转人原因时不能切全自动：先处理。")
    c["mode"] = m
    c["msgs"].append(_m("sys", f"{_me(u)} 把这个会话的智能体模式改成「{MODES[m]['t']}」", 0))
    return {"ok": True}


def _guard(c: dict, text: str, media: list, loc: bool):
    """发给买家之前的外发守卫：每个平台都查。"""
    if re.search(r"(密码|验证码|支付密码|银行卡号|身份证号)", text) and not re.search(r"(不要|别|千万不)", text):
        raise HTTPException(400, "不要向客户索要或转述密码、验证码、银行卡号、身份证号；需要时让客户自己在自己的电脑上输入。")
    if re.search(r"(微信|vx|v信|wx|薇信|QQ|扣扣|加我|手机号|\b1[3-9]\d{9}\b)", text, re.I):
        raise HTTPException(400, "不要在聊天里留微信 / QQ / 手机号，也别说「加我」：各平台都把这算站外引流，会限流甚至封号（规则待法务 / 平台核）。")
    for lk in _links_in(text):
        if lk["host"] and not any(lk["host"] == h or lk["host"].endswith("." + h) for h in OK_OUT_HOSTS):
            raise HTTPException(400, f"链接 {lk['host']} 不能发给买家：外链会被平台判站外引流。只放行远控官方站（向日葵 / ToDesk）。")
    if len(media) > MAX_IMAGES:
        raise HTTPException(400, f"一次最多发 {MAX_IMAGES} 张图（闲鱼一次选图上限）。")
    for u in media:
        if not buyer_safe(u):
            raise HTTPException(400, "这张图不能发给买家：库位照、订单截图、议价取证一律不出。")
    if loc and c["domain"] != "phys":
        raise HTTPException(400, "只有实物自提才发仓库位置")


@router.post("/inbox/{cid}/send")
def send(cid: str, body: dict, u=Depends(get_current_user)):
    c = _find(cid)
    if not (c["owner"]["type"] == "human" and c["owner"]["who"] == _me(u)):
        raise HTTPException(400, "先点「我来接」：同一时间只能一个人（或一个智能体）操作，不然会重复回复买家。")
    text = (body.get("text") or "").strip()
    media = list(body.get("media") or [])
    card, loc = bool(body.get("card")), bool(body.get("location"))
    video = body.get("video")
    custom_loc = (body.get("location_text") or "").strip()
    tag_lbl = (body.get("tag") or "").strip()
    if not (text or media or card or loc or video or custom_loc):
        raise HTTPException(400, "先写一句话，或选要发的内容")
    _guard(c, text, media, loc)
    info = _sku_info(c.get("sku")) if c["domain"] == "phys" else None
    parts = {}
    if tag_lbl:
        parts["tag"] = tag_lbl
    if card and info:
        parts["card"] = {"title": info["name"], "grade": info["grade"], "price": info["suggest_price"]}
    if media:
        parts["media"] = media
    if video:
        parts["video"] = video if isinstance(video, dict) else ((info or {}).get("videos") or [{"title": "商品15秒实拍视频.mp4", "duration": "00:15"}])[0]
    if custom_loc:
        parts["location"] = custom_loc
    elif loc:
        parts["location"] = PICKUP
    now = NOW()
    wait = now - LAST_SEND.get(c["account"], 0)
    st = "sent" if wait >= SEND_GAP_SEC else "queued"
    LAST_SEND[c["account"]] = now
    m = _m("staff", text, 0, by=_me(u), status=st, **parts)
    if st == "queued":
        m["hint"] = f"同一个号两次操作至少隔 {SEND_GAP_SEC} 秒，已排队，稍后自动发出"
    c["msgs"].append(m)
    return {"ok": True, "status": st}


@router.post("/inbox/{cid}/draft/{action}")
def draft_action(cid: str, action: str, body: dict, u=Depends(get_current_user)):
    c = _find(cid)
    d = c["draft"]
    if not d:
        raise HTTPException(400, "现在没有待审的草稿")
    if not (c["owner"]["type"] == "human" and c["owner"]["who"] == _me(u)):
        raise HTTPException(400, "先点「我来接」再审草稿：不然两个人同时审会发两遍。")
    if action in ("approve", "edit"):
        text = (body.get("text") or d["text"]).strip()
        if action == "edit" and text == d["text"]:
            raise HTTPException(400, "没改动，直接点「发送」")
        _guard(c, text, [], False)
        c["msgs"].append(_m("staff", text, 0, by=_me(u), tag="智能体草稿" + ("（人改过）" if action == "edit" else "（人审过）")))
        c["draft"] = None
        c["agent"]["status"] = "running"
        c["agent"]["last"] = "草稿已被人" + ("改后发出" if action == "edit" else "审过发出")
        return {"ok": True}
    if action == "reject":
        why = (body.get("reason") or "").strip()
        if len(why) < 4:
            raise HTTPException(400, "驳回要写原因（至少 4 个字）：智能体和以后改话术的人要看。")
        c["internal"].append({"who": "staff", "by": _me(u), "text": f"驳回草稿：{why}", "t": datetime.now().strftime("%H:%M")})
        c["draft"] = None
        c["agent"]["status"] = "running"
        c["agent"]["last"] = "草稿被驳回：" + why
        return {"ok": True}
    if action == "rewrite":
        ins = (body.get("instruction") or "").strip()
        if len(ins) < 4:
            raise HTTPException(400, "写一句怎么改（至少 4 个字）")
        c["internal"].append({"who": "staff", "by": _me(u), "text": "重写：" + ins, "t": datetime.now().strftime("%H:%M")})
        c["internal"].append({"who": "agent", "text": "收到（演示回复，未接真 Codex）：已按这条重写草稿。", "t": datetime.now().strftime("%H:%M"), "demo": True})
        c["draft"] = dict(d, text=f"{d['text']}（已按「{ins}」重写，演示）", conf=min(0.95, d["conf"] + 0.1))
        return {"ok": True}
    raise HTTPException(400, "没有这个动作")


@router.post("/inbox/{cid}/internal")
def internal(cid: str, body: dict, u=Depends(get_current_user)):
    """内部频道：人 ↔ 绑定的 Codex 会话，买家看不到。正式版：这里发的话就是发给那个 Codex thread。演示里智能体的回复是写死的。"""
    c = _find(cid)
    if not c.get("agent"):
        raise HTTPException(400, "实物会话没有智能体")
    text = (body.get("text") or "").strip()
    if len(text) < 2:
        raise HTTPException(400, "先写一句指令")
    now = datetime.now().strftime("%H:%M")
    c["internal"].append({"who": "staff", "by": _me(u), "text": text, "t": now})
    if re.search(r"(退款|退钱)", text):
        r = "收到：退款相关我不自己回，已标成要人处理。"
    elif re.search(r"(先问|问一下|确认)", text):
        r = "好，下一条草稿我会先问清楚再给方案。"
    elif re.search(r"(别|不要|停)", text):
        r = "好，我先停，等你的下一条指令。"
    else:
        r = "收到。我会按这条调整后面的草稿，做完在这里告诉你。"
    c["internal"].append({"who": "agent", "text": r + "（演示回复，未接真 Codex）", "t": now, "demo": True})
    return {"ok": True}


@router.post("/inbox/{cid}/resolve")
def resolve(cid: str, body: dict, u=Depends(get_current_user)):
    c = _find(cid)
    note = (body.get("note") or "").strip()
    if not (c["owner"]["type"] == "human" and c["owner"]["who"] == _me(u)):
        raise HTTPException(400, "先「我来接」，处理完再结案")
    if len(note) < 6:
        raise HTTPException(400, "写一句处理结果（至少 6 个字），例如「已核对码库，换了一张新码」。以后回看才知道怎么处理的。")
    c["closed"], c["triggers"], c["due_min"], c["draft"] = True, [], None, None
    c["owner"] = {"type": "agent", "who": ""}
    if c.get("agent"):
        c["agent"]["status"] = "idle"
    c["msgs"].append(_m("sys", f"{_me(u)} 已处理：{note}", 0))
    return {"ok": True}


@router.post("/inbox-kill")
def kill(body: dict, u=Depends(get_current_user)):
    """总开关：暂停所有智能体 / 机器人的自动回复（出事时一键停）。只有主管能按。"""
    if u.username != "admin":
        raise HTTPException(403, "只有主管能按总开关")
    KILL["on"] = bool(body.get("on"))
    return {"ok": True, "kill": KILL["on"]}


@router.post("/inbox/{cid}/note")
def outsource_note(cid: str, body: dict, u=Depends(get_current_user)):
    """实物：不接管时，也可以只把结论写给外包客服，让他照着回。"""
    c = _find(cid)
    text = (body.get("text") or "").strip()
    if len(text) < 4:
        raise HTTPException(400, "写一句结论（至少 4 个字），外包客服照着回买家。")
    if re.search(r"(密码|验证码)", text):
        raise HTTPException(400, "不要写密码、验证码。")
    OUTSOURCE_NOTES.setdefault(cid, []).append({"by": _me(u), "text": text, "t": datetime.now().strftime("%H:%M")})
    return {"ok": True}


@router.get("/inbox-metrics")
def metrics(domain: str = "vs", _=Depends(get_current_user)):
    """回复率等。数值是演示值；真环境：实物用 /api/gc-ops/chat-sla/stats，虚拟 / 服务要自己的消息库来算。"""
    _ensure()
    live = [c for c in CONVS if _dom(domain)(c)]
    if domain == "phys":
        return {"demo": True, "conf": {"enabled": True, "read_min": 5, "reply_min": 15, "quiet_start": 23, "quiet_end": 9},
                "items": [{"staff_id": "s1", "name": "外包客服小张", "cycles": 46, "read": 46, "replied": 41, "late_read": 3, "late_reply": 6, "open": 5, "avg_read_sec": 96, "avg_reply_sec": 410},
                          {"staff_id": "s2", "name": "陈小满", "cycles": 9, "read": 9, "replied": 8, "late_read": 0, "late_reply": 1, "open": 1, "avg_read_sec": 70, "avg_reply_sec": 300},
                          {"staff_id": "", "name": "未指定负责人", "cycles": 7, "read": 5, "replied": 2, "late_read": 4, "late_reply": 5, "open": 5, "avg_read_sec": 1500, "avg_reply_sec": 2400}], "total_cycles": 62}
    need = len([c for c in live if _state(c) in ("need", "draft")])
    risk = len([c for c in live if c.get("due_min") is not None and c["due_min"] <= 15])
    return {"demo": True, "kpis": [
        {"k": "reply", "label": "回复率", "v": "96.4%", "hint": "有回复的会话 ÷ 全部会话（近 24 小时，演示值）"},
        {"k": "first", "label": "首响（中位）", "v": "18 秒", "hint": "买家第一句到第一次回复"},
        {"k": "sla", "label": "15 分钟内回复", "v": "94%", "hint": "照真 ERP 考核：回复 15 分钟"},
        {"k": "auto", "label": "自动处理率", "v": "71%", "hint": "没转人就结束的会话占比"},
        {"k": "hand", "label": "转人率", "v": "19%", "hint": "触发转人的会话占比"},
        {"k": "take", "label": "接管后处理", "v": "7.2 分钟", "hint": "人接手到结案的平均时长"},
        {"k": "need", "label": "现在要人", "v": str(need), "live": True, "hint": "兜底队列里的会话数（实时）"},
        {"k": "risk", "label": "快超时", "v": str(risk), "live": True, "hint": "一小时时效只剩 15 分钟以内（实时）"}],
        "by_platform": [{"k": "xianyu", "reply": "97%", "first": "15 秒", "auto": "72%"}, {"k": "xhs", "reply": "91%", "first": "41 秒", "auto": "60%"},
                        {"k": "taobao", "reply": "95%", "first": "22 秒", "auto": "74%"}, {"k": "jd", "reply": "93%", "first": "29 秒", "auto": "78%"}]}


# ------------------------------------------------------------------ CRM 概述：哪个群 / 渠道对应哪个产品（集体统筹）
# 用户 11-11：「哪一个东西是哪个群，肯定要有一个集体的统筹：这个是星巴克，这个是肯德基，这个是三角洲服务……」；
# 「CRM 肯定要有个专门的 SaaS，现在只是一个简单的概述」。禅道 C02：发现 / 已联系 / 已加入 / 已核验 / 已合作 是不同的事实，不能跳。
CRM_ROLES = ["供货群 / 供货渠道", "抢券群 / 羊毛群（线索来源）", "客户群", "同行 / 卖家", "发卡小店"]
CRM_STATES = ["发现", "已联系", "已加入", "已核验", "已合作"]
CRM: list[dict] = []


@router.get("/crm")
def crm(_=Depends(get_current_user)):
    import virtual_stub as vs
    prods = [{"id": p["id"], "name": p["name"], "kind": p["kind"], "path": p.get("path", [])[:-1], "cover": p.get("cover", "svc")} for p in vs.DB.values()]
    return {"roles": CRM_ROLES, "states": CRM_STATES, "products": prods, "groups": CRM}


@router.post("/crm/groups")
def crm_add(body: dict, u=Depends(get_current_user)):
    import virtual_stub as vs
    pid = body.get("pid") or ""
    name = (body.get("name") or "").strip()
    role = body.get("role")
    if pid and pid not in vs.DB:
        raise HTTPException(400, "没有这个产品")
    if len(name) < 2:
        raise HTTPException(400, "群名 / 渠道名要写清楚（至少 2 个字）")
    if role not in CRM_ROLES:
        raise HTTPException(400, "选一个角色")
    if role != CRM_ROLES[1] and not pid:
        raise HTTPException(400, "除了线索来源群，每个群 / 渠道都要对应一个具体产品：不能只存一个万能联系人。")
    g = {"id": "g%d" % (len(CRM) + 1), "pid": pid, "name": name, "platform": (body.get("platform") or "").strip(), "role": role, "size": (body.get("size") or "").strip(),
         "owner": (body.get("owner") or "").strip(), "state": "发现", "log": [{"t": datetime.now().strftime("%m-%d %H:%M"), "by": NAME.get(u.username, u.username), "text": "登记（发现）：" + (body.get("note") or "").strip()}]}
    CRM.append(g)
    return g


@router.post("/crm/groups/{gid}/state")
def crm_state(gid: str, body: dict, u=Depends(get_current_user)):
    g = next((x for x in CRM if x["id"] == gid), None)
    if not g:
        raise HTTPException(404, "没有这个群")
    to, note = body.get("state"), (body.get("note") or "").strip()
    if to not in CRM_STATES:
        raise HTTPException(400, "没有这个状态")
    if CRM_STATES.index(to) != CRM_STATES.index(g["state"]) + 1:
        raise HTTPException(400, f"现在是「{g['state']}」，只能往后一步：发现 → 已联系 → 已加入 → 已核验 → 已合作。搜到群名不等于已联系，更不等于已合作。")
    if to in ("已核验", "已合作") and len(note) < 6:
        raise HTTPException(400, "「已核验」「已合作」要写依据（至少 6 个字）：试单结果、报价、交付证据。关系好不替代履约证据。")
    g["state"] = to
    g["log"].append({"t": datetime.now().strftime("%m-%d %H:%M"), "by": NAME.get(u.username, u.username), "text": f"{to}：{note}"})
    return g


@router.post("/reception-reset")
def reception_reset(_=Depends(get_current_user)):
    reset()
    return {"ok": True}
