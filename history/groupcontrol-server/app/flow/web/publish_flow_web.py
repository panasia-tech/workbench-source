"""闲鱼网页版「发布上架」流程:AdsPower 浏览器 goto /publish → 图片/描述/价格/发货/所在地
→ (属性智能识别)→ 点「发布」→ 成功锚点 + 在售列表回读校验 → 结构化返回。

与 read_chats_web / goods_flows_web 同构(同一 Transport 原语、同一 result schema:
{ok, done, failed_step, reason, shot, risk},login=True 表掉登录),业务语义对齐手机版
publish_flow_v2 的步骤分解(open_editor→images→description→price→shipping→location→publish
→回读校验),差异:
- 描述直填(spec.description,网页版无 AI 帮写);标题=描述首行(闲鱼网页版无标题字段,
  发布后回读 personal 列表用描述前缀匹配)。
- 图片:push_media 下载到本地 → transport.set_input_files 直喂隐藏 file input(ant-upload),
  不经文件选择器。⚠️ set_input_files 是本地联调扩展,MQTT 执行端需补 upload_files 原语。
- 属性:传图+描述后服务端「智能识别属性」自动填(实测 2026-09-09:识别出分类=必填项)。
  流程等识别(≤30s 不阻塞),spec.attrs 里已选的跳过、未选的尝试 ant-select 补选,
  识别不出不阻塞发布(对齐手机版「不选齐顶多发布不推进,网页版实测分类被 AI 兜住」)。
- 分类:AI 识别的分类可能「网页端不支持发布」(实测测试文案被识别成「软件/程序/网站
  开发」)——点发布只弹 toast 静默返回,无表单错误、无网络请求,极易误判成「点击被拦截」。
  _step_category 检测提示文案,出现时改选兜底分类「其他闲置」(可用 spec.category 覆盖);
  下拉选项被 tips-- 橙色浮层盖住时物理 tap 点不到,需 js_click_text 扩展兜底穿透。

2026-09-09 AdsPower 实测(recon-notes.md §5 + scripts/web_publish_recon.py):
- /publish 为普通文档流(window.scrollY 滚动,deltaY+ = 向下);**底部有固定发布条容器
  (高约 88px)遮住所在地行**——点击任何行前先滚到视口中部(cy ≤ h-120),否则点空。
- 图片:隐藏 input[type=file](accept 多图格式,带 multiple)可直接 set_input_files 多文件;
  缩略图节点=div[class*="preview-container--"](每张一个),添加按钮文案空图「添加首图」
  传图后变「添加细节图」。上传后表单出现 ant-form-item-has-success。
- 描述:div[class*="editor--"] contenteditable,占位符 ::before;set_text 直写
  (local_transport._SET_TEXT_JS 已支持 contenteditable),回读 editor 节点 desc。
- 价格:两个 input.ant-input(placeholder 0.00)左=价格右=原价;dump desc 现含真实值
  (local_transport._DUMP_JS 已把 input.value 放进 desc)→ 可直接回读校验。
- 发货:4 个 radio 按 label 文本定位(包邮/按距离计费/一口价/无需邮寄);一口价选中后
  出现「邮费」ant-input(在 radio 行下方);「支持自提」是 ant-checkbox(switch 样式)。
- 所在地:默认回填账号常用地址(实测「金汇之城」);点击弹 modal(标题「宝贝所在地」)
  含 input[class*="search-input--"](placeholder 搜索地点);输入后出 div[class*="auto-item"]
  自动补全列表,点第一个选中并关闭 modal。
- 发布:底部固定黄钮「发布」(常驻视口底部,无需滚动)。发布后行为见 _wait_publish_outcome。

风控:engine.RISK_ANCHORS + 网页版滑块锚点(goods_flows_web.WEB_RISK_ANCHORS),命中即
RiskHit 返回(熔断,不过滑块)。⚠️ 阿里 punish 滑块渲染在跨域 iframe(_____tmd_____/punish),
dump 文本完全看不到——_check_risk(nodes, t) 传 transport 时会额外查 iframe src
(local_transport.risk_punish_active 扩展)。连续快速跳页容易触发 punish(实测发布+连跳
详情页即触发),冷却约 10min;触发后只熔断等待,绝不过滑块。操作纪律:动作间隔 ≥1.5s、
页面跳转 ≥2s。

失败清理:已进入发布页后任一步失败 → _leave_publish(处理「存草稿?」弹窗,点放弃类按钮,
回闲鱼首页),并 clear_media 删掉 push_media 下载的图。已发布成功但后续校验失败 →
item_id 仍返回(result 里 ok=False + item_id + published=True),供对账,绝不盲重发。
"""
import logging
import os
import re
import time

from app.flow.engine import LoginRequired, RiskHit
from app.flow.transport import FlowTimeout
from app.flow.web.goods_flows_web import (
    WEB_RISK_ANCHORS,
    above_feed,
    _collect_all_cards,
    _flat,
    _local_shot_sink,
    _mk_save_shot,
    parse_goods_cards,
)
from app.flow.web.login import recover_login
from app.flow.web.parse import find_login_nick
from app.publish_spec import validate_publish_spec

logger = logging.getLogger("gc.publish_flow_web")

PUBLISH_URL = "https://www.goofish.com/publish"
PERSONAL_URL = "https://www.goofish.com/personal"

# ---- 选择器常量(2026-09-09 实测,类名带 hash 后缀,一律前缀匹配)----
CLS_EDITOR = "editor--"                   # 描述 contenteditable
CLS_PREVIEW = "preview-container--"       # 已传图片缩略图(每张一个)
CLS_UPLOAD_SELECT = "ant-upload-select"   # 添图按钮槽位
CLS_PRICE_INPUT = "ant-input"             # 价格/原价/邮费输入框(desc=真实值)
CLS_FEE_LABEL = "邮费"                    # 一口价模式邮费行 label
CLS_ADDRESS = "address--"                 # 所在地已选地址文本(如「金汇之城」)
CLS_ADDRESS_WRAP = "addressWrap--"        # 所在地行(点击弹面板)
CLS_LOC_SEARCH = "search-input--"         # 所在地面板搜索 input
CLS_LOC_ITEM = "auto-item"                # 所在地搜索自动补全项
CLS_SEL_ITEM = "ant-select-selection-item"    # ant-select 已选项
CLS_SEL_PLACEHOLDER = "ant-select-selection-placeholder"  # ant-select 占位(未选)
CLS_SEL_OPTION = "ant-select-item-option"  # ant-select 下拉选项(弹层在 body portal)
CLS_SEL_OPT_CONTENT = "ant-select-item-option-content"  # 下拉选项文本节点
CLS_RADIO_INPUT = "ant-radio-input"       # 发货方式 radio
CLS_CHECKBOX_INPUT = "ant-checkbox-input"  # 「支持自提」checkbox
CLS_CONFIRM_TITLE = "confirmTitle--"      # 确认弹窗标题
CLS_DLG_BTN = "btnChildren--"             # 弹窗按钮

SHIPPING_LABELS = {"free": "包邮", "by_distance": "按距离计费",
                   "fixed_fee": "一口价", "no_ship": "无需邮寄"}

# 分类「网页端不支持发布」的提示文案(点发布只弹 toast 静默返回,2026-09-09 实测)
CAT_UNSUPPORTED = ("网页版暂不支持发布此分类", "当前分类不支持网页端发布")
CAT_FALLBACK = "其他闲置"   # 网页端万能的兜底分类

# 发布页「存草稿?」类弹窗的放弃按钮文案(对齐手机版 _discard_draft_if_any)
DRAFT_GIVEUP = ("放弃", "不保存", "直接离开", "狠心离开", "确认退出")
DRAFT_SIGNS = ("存草稿", "继续编辑", "未编辑完成", "保存草稿", "离开")

_GAP = 2.0        # 页面跳转最小间隔(风控纪律)
_SETTLE = 1.5     # 动作后 settle
_AI_WAIT = 30.0   # 智能识别属性等待上限(不阻塞)


class StepFail(Exception):
    """单步失败:携带 step/reason/shot,由 run_publish_web 统一收成 result。"""

    def __init__(self, step: str, reason: str, shot: str | None = None):
        super().__init__(reason)
        self.step = step
        self.reason = reason
        self.shot = shot


def _check_risk(nodes, t=None) -> None:
    """dump 文本命中风控锚点 → RiskHit(goods_flows_web.WEB_RISK_ANCHORS 含滑块锚点);
    传 t 时额外查阿里 punish 滑块 iframe(跨域,dump 看不到,2026-09-09 实测)。

    推荐流里的字不算(goods_flows_web.above_feed):点完「发布」会落到新商品详情页(底下「为你推荐」),
    保活开的首页下半截是「猜你喜欢」,都是别人的商品标题,「违规」「申诉」不稀奇。"""
    for n in above_feed(nodes):
        txt = n.get("desc") or ""
        if not txt:
            continue
        for anchor in WEB_RISK_ANCHORS:
            if anchor in txt:
                raise RiskHit(anchor)
    if t is not None and hasattr(t, "risk_punish_active"):
        hit = t.risk_punish_active()
        if hit:
            raise RiskHit(f"punish滑块iframe:{hit}")


def _ensure_login(t, nodes, h: int, save_shot) -> list:
    """页头有真实昵称(parse.find_login_nick,与另三条网页版流程同一判法)→ 已登录;
    否则先试快速进入(web/login.py),还没有才 LoginRequired。返回最新节点(自救时页面重开过)。

    以前这里只看 nick-- 元素有没有字,未登录时页头那个元素的字是「登录」,也算登着了。
    """
    if find_login_nick(nodes, h):
        return nodes
    again = recover_login(t, PUBLISH_URL, _flat, lambda ns: _check_risk(ns, t))
    if again is not None and find_login_nick(again, h):
        return again
    raise LoginRequired("网页版未登录(/publish 无账号昵称)", save_shot("login_publish"))


def _find(nodes, desc=None, cls_pat=None, cy_band=None):
    """通用节点查找:desc 精确 + cls 前缀包含 + cy 区间。"""
    out = []
    for n in nodes:
        if desc is not None and (n.get("desc") or "") != desc:
            continue
        if cls_pat is not None and cls_pat not in (n.get("cls") or ""):
            continue
        if cy_band is not None and not (cy_band[0] <= n["cy"] <= cy_band[1]):
            continue
        out.append(n)
    out.sort(key=lambda n: (n["cy"], n["cx"]))
    return out


def _scroll_into_band(t, nodes, w, h, matcher, band=(0.15, 0.85), max_swipes: int = 6) -> dict:
    """把 matcher 命中的节点滚进视口安全带(默认 15%~85% 高度;发布页文档短、底部固定
    发布条约 88px 遮罩起点 ≈ h-88,行中心 ≤0.85h 即在遮罩之上可点)并返回重取的节点坐标。滚不到 → StepFail。每次滚动后重新 dump(坐标随滚动失效)。"""
    for _ in range(max_swipes + 1):
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes, t)
        hit = matcher(nodes)
        if hit and h * band[0] <= hit["cy"] <= h * band[1]:
            return hit
        t.swipe(int(w * 0.5), int(h * 0.30), int(w * 0.5), int(h * 0.70))  # deltaY+=向下
        time.sleep(_SETTLE)
    raise StepFail("scroll", f"目标行滚 {max_swipes} 轮仍未进视口安全带 "
                             f"[{band[0]:.0%}~{band[1]:.0%}](发布条遮罩区点不到)")


def _dismiss_draft_dialog(t, nodes) -> bool:
    """发布页残留草稿弹窗(「继续编辑/存草稿」类)→ 点放弃,保持全新表单。"""
    joined = " ".join((n.get("desc") or "") for n in nodes)
    if not any(s in joined for s in DRAFT_SIGNS):
        return False
    for txt in DRAFT_GIVEUP:
        for n in nodes:
            if (n.get("desc") or "").strip() == txt:
                t.tap(n["cx"], n["cy"])
                time.sleep(_SETTLE)
                return True
    logger.warning("检测到草稿弹窗但无放弃类按钮,保持现状")
    return False


def _leave_publish(t, save_shot, reason: str) -> None:
    """失败清理:离开发布页(处理存草稿弹窗 → 回首页)。清理失败不覆盖原失败原因。"""
    try:
        t.launch_app("https://www.goofish.com")
        time.sleep(_GAP)
        nodes = _flat(t.dump_nodes())
        _dismiss_draft_dialog(t, nodes)
    except Exception as ex:
        logger.warning("发布页现场清理失败(%s):%s", reason, ex)
        try:
            save_shot(f"cleanup_fail_{reason}")
        except Exception:
            pass


# ---------------------------------------------------------------- 步骤

def _step_images(t, spec, save_shot, w, h) -> None:
    """push_media 下载全部图片 → set_input_files 直喂隐藏 file input → 数缩略图校验数量。"""
    urls = spec.get("images") or []
    if not urls:
        raise StepFail("images", "spec.images 为空(validate_publish_spec 应已拦下)")
    if not hasattr(t, "set_input_files"):
        raise StepFail("images", "transport 不支持 set_input_files——MQTT 执行端需补 "
                                 "upload_files 原语才能跑 web 发布")
    pushed: list[str] = spec.setdefault("_pushed_media", [])
    paths = []
    for url in urls:
        try:
            p = t.push_media(url)
        except Exception as ex:
            raise StepFail("images", f"图片下载失败 {url[:60]}: {ex}")
        if not p:
            raise StepFail("images", f"push_media 返回空 {url[:60]}")
        paths.append(p)
        pushed.append(p)
        time.sleep(0.5)
    time.sleep(_GAP)
    feed = list(paths)
    for attempt in range(4):
        n_set = t.set_input_files(feed)  # input 带 multiple 时一次全喂;不带则只吃第一张
        time.sleep(6)
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes, t)
        got = len(_find(nodes, cls_pat=CLS_PREVIEW))
        logger.info("images: 已喂 %d 张(第 %d 轮),缩略图 %d 张", len(feed), attempt + 1, got)
        if got >= len(paths):
            return
        feed = feed[got:]  # 多文件部分生效时补喂剩余
        if not feed:
            break
    raise StepFail("images", f"上传后缩略图 {got}/{len(paths)} 张", save_shot("pub_images"))


def _step_description(t, spec, save_shot, w, h) -> None:
    """contenteditable 描述:滚到可见 → 点击聚焦 → set_text → 回读校验(对齐手机版回读纪律)。"""
    desc = (spec.get("description") or "").strip()
    if not desc:
        raise StepFail("description", "spec.description 为空(网页版无 AI 帮写,必须直给文案)")
    if len(desc) > 1500:
        raise StepFail("description", f"描述 {len(desc)} 字超 1500 上限")
    hit = _scroll_into_band(t, None, w, h, lambda ns: next(
        (n for n in ns if CLS_EDITOR in (n.get("cls") or "")), None))
    t.tap(hit["cx"], hit["cy"])
    time.sleep(1.0)
    try:
        t.set_text(desc)
    except Exception as ex:
        raise StepFail("description", f"描述注入失败(set_text): {ex}", save_shot("pub_desc"))
    time.sleep(_SETTLE)
    nodes = _flat(t.dump_nodes())
    _check_risk(nodes, t)
    joined = " ".join((n.get("desc") or "") for n in nodes)
    if desc[:20] not in joined:
        raise StepFail("description", f"描述回读校验失败(全页无 {desc[:20]!r} 前缀文本)",
                       save_shot("pub_desc_verify"))


def _is_ant_input(n) -> bool:
    """cls 精确含 ant-input 类 token(排除 ant-input-prefix/suffix 等含同名子串的 ¥ 符号节点)。"""
    return "ant-input" in (n.get("cls") or "").split()


def _fill_price_input(t, nodes, target, value, step, save_shot) -> None:
    """点目标 ant-input → set_text 覆盖写 → 回读校验(dump desc 现含 input 真实值)。"""
    t.tap(target["cx"], target["cy"])
    time.sleep(1.0)
    t.set_text(value)
    time.sleep(_SETTLE)
    nodes = _flat(t.dump_nodes())
    _check_risk(nodes, t)
    fresh = next((n for n in nodes
                  if _is_ant_input(n)
                  and abs(n["cx"] - target["cx"]) < 80 and abs(n["cy"] - target["cy"]) < 60), None)
    got = (fresh or {}).get("desc") or ""
    if got != value and not _same_amount(got, value):
        raise StepFail(step, f"回读校验失败(写入 {value},读到 {got!r})", save_shot(f"pub_{step}"))


def _step_price(t, spec, save_shot, w, h) -> None:
    """价格区两个 ant-input:左=价格(必填)、右=原价(可空)。按坐标分左右,不盲点。"""
    price = spec.get("price")
    if price is None:
        raise StepFail("price", "spec.price 缺失")
    value = _fmt_amount(price)

    def _pair(ns):
        ins = [n for n in ns if _is_ant_input(n) and (n.get("desc") or "") != ""]
        # 价格区两个输入框同行(desc 为真实值或占位 0.00):取相邻同 cy 的一对
        ins = [n for n in ins if n["h"] <= 40 and n["w"] <= 400]
        if len(ins) < 2:
            return None
        ins.sort(key=lambda n: n["cx"])
        pair = [n for n in ins if abs(n["cy"] - ins[0]["cy"]) < 40]
        return pair if len(pair) >= 2 else None

    hit = _scroll_into_band(t, None, w, h, lambda ns: (_pair(ns) or [None])[0])
    nodes = _flat(t.dump_nodes())
    pair = _pair(nodes)
    if not pair:
        raise StepFail("price", "滚动后价格输入框对消失", save_shot("pub_price"))
    left, right = pair[0], pair[1]
    _fill_price_input(t, None, left, value, "price", save_shot)
    logger.info("price: 价格 %s 已写入回读一致", value)
    orig = spec.get("original_price")
    if orig:
        nodes = _flat(t.dump_nodes())
        fresh = _pair(nodes)
        if fresh:
            _fill_price_input(t, None, fresh[1], _fmt_amount(orig), "price", save_shot)


def _fmt_amount(v) -> str:
    f = float(v)
    return str(int(f)) if f == int(f) else f"{f:.2f}".rstrip("0").rstrip(".")


def _same_amount(a: str, b: str) -> bool:
    """回读值是否等于写入值:页面会把 0 显示成 0.00、把 12 显示成 12.00,按数字比。
    一口价 0 元是常态(不填运费),不能因为格式差异把正常写入判成失败。"""
    try:
        return float(a) == float(b)
    except (TypeError, ValueError):
        return False


def _step_shipping(t, spec, save_shot, w, h) -> None:
    """发货方式:按 label 文本点 radio(包邮/按距离计费/一口价/无需邮寄);一口价补邮费;
    self_pickup 勾「支持自提」。回读:radio 选中态 dump 读不到 → 以邮费行/邮费值回读兜底。"""
    sp = spec.get("shipping") or {}
    mode = sp.get("mode", "fixed_fee")
    label = SHIPPING_LABELS.get(mode)
    if not label:
        raise StepFail("shipping", f"未知发货方式 mode={mode}")
    hit = _scroll_into_band(t, None, w, h,
                            lambda ns: next((n for n in ns if (n.get("desc") or "") == label), None))
    t.tap(hit["cx"], hit["cy"])
    time.sleep(_SETTLE)
    if mode == "fixed_fee":
        fee = sp.get("fixed_fee", 0)
        fee_val = _fmt_amount(fee)

        def _fee_input(ns):
            lab = next((n for n in ns if (n.get("desc") or "") == CLS_FEE_LABEL), None)
            if not lab:
                return None
            cands = [n for n in ns if _is_ant_input(n)
                     and n["cy"] > lab["cy"] - 10 and n["cy"] < lab["cy"] + 60
                     and abs(n["cx"] - lab["cx"]) < 300]
            return cands[0] if cands else None

        if not _fee_input(_flat(t.dump_nodes())):
            raise StepFail("shipping", "一口价已选但未出现「邮费」输入框", save_shot("pub_fee"))
        # 邮费框在「一口价」下面约 76px:radio 刚好在安全带底边时邮费框会落进底部发布条,
        # 点了聚焦不到(2026-11 焕新连续失败 set_text 无聚焦),要单独滚进安全带
        fee_node = _scroll_into_band(t, None, w, h, _fee_input)
        _fill_price_input(t, None, fee_node, fee_val, "shipping", save_shot)
        logger.info("shipping: 一口价邮费 %s 已写入回读一致", fee_val)
    if sp.get("self_pickup"):
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes, t)
        lab = next((n for n in nodes if (n.get("desc") or "") == "支持自提"), None)
        box = None
        if lab:
            cands = [n for n in nodes if CLS_CHECKBOX_INPUT in (n.get("cls") or "")
                     and abs(n["cy"] - lab["cy"]) < 40 and n["cx"] > lab["cx"]]
            box = cands[0] if cands else None
        if not box and lab:
            # checkbox 节点读不到时点开关区(label 右侧,2026-09-09 实测 switch 样式)
            box = {"cx": lab["cx"] + int(lab["w"] / 2) + 30, "cy": lab["cy"]}
        if not box:
            raise StepFail("shipping", "「支持自提」checkbox 定位失败", save_shot("pub_pickup"))
        t.tap(box["cx"], box["cy"])
        time.sleep(_SETTLE)


def _step_location(t, spec, save_shot, w, h) -> str | None:
    """宝贝所在地:打开面板(行滚进安全带再点,避开底部固定发布条)→ 搜索 spec.location
    → 选第一个自动补全项。返回选中地址名;spec.location 为空 → 用默认回填值,不改动。"""
    loc = (spec.get("location") or "").strip()
    nodes = _flat(t.dump_nodes())
    addr = next((n for n in nodes if CLS_ADDRESS in (n.get("cls") or "")), None)
    if not loc:
        logger.info("location: spec.location 为空,保留账号默认「%s」",
                    (addr or {}).get("desc"))
        return (addr or {}).get("desc")
    hit = _scroll_into_band(t, None, w, h,
                            lambda ns: next((n for n in ns if CLS_ADDRESS in (n.get("cls") or "")), None))
    t.tap(hit["cx"], hit["cy"])
    time.sleep(_GAP)
    nodes = _flat(t.dump_nodes())
    _check_risk(nodes, t)
    si = next((n for n in nodes if CLS_LOC_SEARCH in (n.get("cls") or "")), None)
    if not si:
        raise StepFail("location", "所在地面板未打开(无搜索输入框)", save_shot("pub_loc"))
    t.tap(si["cx"], si["cy"])
    time.sleep(1.0)
    t.set_text(loc)
    time.sleep(2.5)
    nodes = _flat(t.dump_nodes())
    _check_risk(nodes, t)
    items = _find(nodes, cls_pat=CLS_LOC_ITEM)
    if not items:
        raise StepFail("location", f"搜索 {loc!r} 无自动补全结果", save_shot("pub_loc_result"))
    t.tap(items[0]["cx"], items[0]["cy"])
    time.sleep(_GAP)
    # 回读校验:面板关闭 + 地址行文本变为选中项
    nodes = _flat(t.dump_nodes())
    _check_risk(nodes, t)
    if any(CLS_LOC_SEARCH in (n.get("cls") or "") for n in nodes):
        raise StepFail("location", "点选后所在地面板未关闭", save_shot("pub_loc_stuck"))
    addr = next((n for n in nodes if CLS_ADDRESS in (n.get("cls") or "")), None)
    got = (addr or {}).get("desc") or ""
    if got and loc[:2] not in got and got[:2] not in loc:
        raise StepFail("location", f"所在地回读「{got}」与期望 {loc!r} 不符",
                       save_shot("pub_loc_verify"))
    logger.info("location: 已选「%s」(搜索 %r)", got or "?", loc)
    return got or None


def _step_attributes(t, spec, save_shot, w, h) -> None:
    """智能识别属性:等 AI 出结果(≤30s 不阻塞);spec.attrs 逐项检查,未选的尝试 ant-select
    补选(点击下拉 → 点匹配选项);识别不出/补选失败不阻塞发布(对齐手机版语义)。"""
    deadline = time.time() + _AI_WAIT
    while time.time() < deadline:
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes, t)
        if _find(nodes, cls_pat=CLS_SEL_ITEM):
            logger.info("attributes: 智能识别已出结果")
            break
        time.sleep(2.0)
    else:
        logger.warning("attributes: 等智能识别 %ds 无结果,按不阻塞继续", int(_AI_WAIT))
    attrs = spec.get("attrs") or {}
    for key, value in attrs.items():
        try:
            _fill_attr_select(t, key, str(value), w, h)
        except StepFail as ex:
            logger.warning("attributes: 补选 %s=%s 失败(不阻塞): %s", key, value, ex.reason)
        time.sleep(1.0)


def _fill_attr_select(t, key: str, value: str, w, h) -> None:
    """单个 ant-select 属性补选:找 key label 右侧同排下拉 → 已选=value 跳过 → 点开下拉
    → 选项里找 value 点击。选项弹层在 body portal(dump 可见)。"""
    nodes = _flat(t.dump_nodes())
    lab = next((n for n in nodes if (n.get("desc") or "").strip() == key), None)
    if not lab:
        logger.info("attributes: 无「%s」属性行(该类目没有),跳过", key)
        return
    row_band = (lab["cy"] - 20, lab["cy"] + 40)

    def _sel(ns):
        cands = [n for n in ns
                 if ("ant-select" in (n.get("cls") or "")) and (n.get("desc") or "").strip()
                 and row_band[0] <= n["cy"] <= row_band[1] and n["cx"] > lab["cx"]]
        return cands[0] if cands else None

    cur = _sel(nodes)
    if not cur:
        logger.info("attributes: 「%s」行无下拉控件,跳过", key)
        return
    if cur["desc"].strip() == value:
        logger.info("attributes: %s=%s 已由智能识别选中,跳过", key, value)
        return
    t.tap(cur["cx"], cur["cy"])
    time.sleep(_SETTLE)
    nodes = _flat(t.dump_nodes())
    _check_risk(nodes, t)
    opts = [n for n in _find(nodes, cls_pat=CLS_SEL_OPTION) if value in (n.get("desc") or "")]
    if not opts:
        # 收起下拉,保持页面干净
        t.tap(lab["cx"], lab["cy"])
        time.sleep(1.0)
        raise StepFail("attributes", f"「{key}」下拉无选项含 {value!r}")
    t.tap(opts[0]["cx"], opts[0]["cy"])
    time.sleep(_SETTLE)
    logger.info("attributes: 补选 %s=%s 完成", key, value)


def _category_value(nodes) -> str | None:
    """分类 ant-select 当前值(ant-select-selection-item);未识别返回 None。"""
    return next(((n.get("desc") or "").strip() for n in nodes
                 if CLS_SEL_ITEM in (n.get("cls") or "") and (n.get("desc") or "").strip()), None)


def _step_category(t, spec, save_shot, w, h) -> str | None:
    """分类兜底:AI 智能识别的分类可能「网页端不支持发布」——发布钮点了只弹 toast 静默返回,
    无任何表单错误(2026-09-09 实测:测试文案被识别成「软件/程序/网站开发」,网页端拒发)。
    出现不支持提示、或 spec.category 显式指定且与当前值不同时:打开分类 ant-select
    选中目标(默认「其他闲置」)。注意:选项常被 tips-- 橙色提示浮层盖住,物理 tap
    点不到(elementFromPoint 命中浮层),必须 js_click_text 扩展兜底。返回最终分类值。"""
    nodes = _flat(t.dump_nodes())
    joined = " ".join((n.get("desc") or "") for n in nodes)
    cur = _category_value(nodes)
    want = (spec.get("category") or "").strip()
    unsupported = any(s in joined for s in CAT_UNSUPPORTED)
    if not unsupported and (not want or want == cur):
        logger.info("category: 保持「%s」%s", cur, "(AI 识别)" if cur else "")
        return cur
    if not want:
        want = CAT_FALLBACK
        logger.warning("category: 当前分类「%s」网页端不支持发布,兜底切到「%s」", cur, want)
    if not cur:
        raise StepFail("category", "分类 ant-select 无当前值(智能识别未完成?),无法改选",
                       save_shot("pub_cat"))
    if not hasattr(t, "js_click_text"):
        raise StepFail("category", f"分类「{cur}」网页端不支持发布,且 transport 无 "
                                   f"js_click_text 扩展无法兜底选「{want}」")

    def _opt(ns):
        return next((n for n in _find(ns, desc=want) if CLS_SEL_OPT_CONTENT in (n.get("cls") or "")), None)

    def _has_options(ns) -> bool:
        return any(CLS_SEL_OPTION in (n.get("cls") or "") for n in ns)

    def _poll_options(seconds: float) -> list:
        """轮询 dump 直到下拉选项出现(选项异步拉取,不能点一下立刻判定没开)。"""
        deadline = time.time() + seconds
        ns: list = []
        while time.time() < deadline:
            time.sleep(1.0)
            ns = _flat(t.dump_nodes())
            if _has_options(ns):
                return ns
        return ns

    # 打开下拉的三种策略:物理 tap(常规可行)→ JS mousedown 序列(ant Select 靠
    # mousedown 开,el.click() 无效;物理 tap 又可能被 tips-- 浮层吃)→ JS click 容器。
    # 每种策略点后都轮询等选项渲染,避免「点一下没立刻见选项就又点」把下拉关掉。
    nodes = _flat(t.dump_nodes())
    sel_node = next((n for n in nodes if CLS_SEL_ITEM in (n.get("cls") or "")
                     and (n.get("desc") or "").strip() == cur), None)
    if sel_node:
        t.tap(sel_node["cx"], sel_node["cy"])
    nodes = _poll_options(6)
    if not _has_options(nodes) and hasattr(t, "js_mouse_click"):
        logger.info("category: 物理 tap 未打开下拉,改 JS mousedown 序列")
        t.js_mouse_click(".ant-select-in-form-item .ant-select-selector")
        nodes = _poll_options(6)
    if not _has_options(nodes) and hasattr(t, "js_click_selector"):
        logger.info("category: JS mousedown 仍未打开下拉,再试 JS click 容器")
        t.js_click_selector(".ant-select-in-form-item")
        nodes = _poll_options(5)
    if not _has_options(nodes):
        raise StepFail("category", "分类下拉打不开(三种策略均无选项弹层)",
                       save_shot("pub_cat"))

    if not _opt(nodes):
        # 下拉支持搜索:当前值相关建议里没目标时,在搜索框输入目标再选
        # (dump 里的 ant-select-selection-search 是 span,tap 坐标打不中真实 input)
        searched = False
        if hasattr(t, "fill_text"):
            try:
                t.fill_text(".ant-select-selection-search input", want)
                searched = True
            except Exception as ex:
                logger.warning("category: fill_text 失败,回退物理聚焦: %s", ex)
        if not searched:
            si = next((n for n in nodes if "ant-select-selection-search" in (n.get("cls") or "")), None)
            if not si:
                raise StepFail("category", "下拉无目标选项且无搜索框,fill_text 扩展也不可用")
            t.tap(si["cx"], si["cy"])
            time.sleep(1.0)
            t.set_text(want)
        time.sleep(2.5)
        nodes = _flat(t.dump_nodes())
    if not _opt(nodes):
        raise StepFail("category", f"分类下拉中无选项 {want!r}(搜索后仍无)", save_shot("pub_cat_opt"))
    # 直接 JS click 选项:物理 tap 会被 tips-- 橙色提示浮层拦截(2026-09-09 实测)
    t.js_click_text(want, cls=CLS_SEL_OPT_CONTENT)
    time.sleep(_SETTLE)
    got = _category_value(_flat(t.dump_nodes()))
    if got != want:
        raise StepFail("category", f"改选失败:期望 {want!r},实际 {got!r}", save_shot("pub_cat_verify"))
    logger.info("category: 已改选「%s」", got)
    return got


def _close_stray_layers(t, w, h) -> None:
    """点页面标题等中性区,收掉残留的属性下拉弹层(ant-select dropdown 开着会吃掉 footer 点击)。

    标题在页面最上面。表单填到后面页面已经往下滚了,标题在视口上方(cy 是负的),原来照样
    去点,点到屏幕外——等于没点,弹层也没收(2026-10-06 回放里每次点「发布」前都有一下
    (520,-391)、(846,-351))。现在标题不在视口里就先往上滚回来再点;滚几次还看不到就点
    右上角空白兜底。「发布」在底部固定条里,往上滚不影响后面去点它。
    """
    for _ in range(4):
        nodes = _flat(t.dump_nodes())
        title = next((n for n in nodes if (n.get("desc") or "") == "发闲置"), None)
        if title and 0 < title["cy"] < h * 0.3:
            t.tap(title["cx"], title["cy"])
            break
        if not title or title["cy"] > 0:
            t.tap(int(w * 0.85), int(h * 0.12))
            break
        t.swipe(int(w * 0.5), int(h * 0.70), int(w * 0.5), int(h * 0.30))   # deltaY-=向上
        time.sleep(_SETTLE)
    else:
        t.tap(int(w * 0.85), int(h * 0.12))
    time.sleep(1.2)


def _wait_publish_outcome(t, spec, save_shot, timeout: float = 30.0) -> tuple[str | None, str | None]:
    """点「发布」后等成功锚点,返回 (item_id, outcome)。

    可能路径(2026-09-09 实测前侦察不足,按锚点集合兼容):
    ① 跳详情页/成功页(URL 含 id=)→ 直接从 URL 读 itemId;
    ② 开新 tab(详情页)→ wait_new_tab 激活读 URL;
    ③ 弹无忧卖/验货宝推广弹窗 → 不托管就点「暂不/关闭」继续等;
    ④ 成功文案锚点(发布成功/再发一件)。
    超时 → StepFail(UNCERTAIN,可能已发布,绝不盲重发)。
    """
    deadline = time.time() + timeout
    item_id = None
    while time.time() < deadline:
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes, t)
        descs = [(n.get("desc") or "") for n in nodes]
        joined = " ".join(descs)

        # 硬拦/确认弹窗优先处理
        blocked = next((d for d in descs if "无法发布" in d or "运费最高" in d), None)
        if blocked:
            raise StepFail("publish", f"闲鱼拒发:{blocked}", save_shot("pub_rejected"))
        for kw in ("继续发布", "仍要发布", "确认发布", "直接发布"):
            btn = next((n for n in nodes if (n.get("desc") or "").strip() == kw), None)
            if btn:
                t.tap(btn["cx"], btn["cy"])
                time.sleep(_SETTLE)
                break
        else:
            # 无忧卖/验货宝推广弹窗:不托管(网页版托管会进无忧卖,删除/下架都被平台管)
            if any(("无忧卖" in d or "验货宝" in d or "托管" in d) for d in descs):
                act = next((n for n in nodes if (n.get("desc") or "").strip() in
                            ("暂不加入", "暂不托管", "以后再说", "关闭")), None)
                if act:
                    t.tap(act["cx"], act["cy"])
                    time.sleep(_SETTLE)
                    continue

        # 成功路径:URL 跳详情/成功页
        url = getattr(t.page, "url", "") or ""
        m = re.search(r"[?&]id=(\d+)", url)
        if m and "/publish" not in url:
            return m.group(1), "SUBMITTED"
        if any(k in joined for k in ("发布成功", "再发一件")):
            # 成功页上找商品链接拿 itemId
            for n in nodes:
                mm = re.search(r"[?&]id=(\d+)", (n.get("desc") or ""))
                if mm:
                    return mm.group(1), "SUBMITTED"
            return None, "SUBMITTED"
        # 新 tab(详情页)
        if hasattr(t, "wait_new_tab"):
            try:
                url = t.wait_new_tab(contains="/item", timeout=3)
                mm = re.search(r"[?&]id=(\d+)", url)
                if mm:
                    return mm.group(1), "SUBMITTED"
            except Exception:
                pass
        time.sleep(1.5)
    raise StepFail("publish", "点「发布」后 30s 未捕获成功锚点(UNCERTAIN:可能已发布,勿盲重发)",
                   save_shot("pub_uncertain"))


# ---------------------------------------------------------------- 主流程
def run_publish_web(transport, spec: dict, shot_sink=None) -> dict:
    """网页版发布上架。spec 对齐手机版 PublishSpec 裁剪:
    {images[], description, price, original_price?, shipping{mode,fixed_fee?,self_pickup?},
     attrs?, location?, category?, confirm_publish, dry_run?}
    (category: AI 识别分类网页端不支持发布时改选的目标,默认「其他闲置」)。"""
    t = transport
    save_shot = _mk_save_shot(t, shot_sink)
    result = {"ok": True, "done": ["publish"], "failed_step": None,
              "reason": None, "shot": None, "risk": None}
    entered = False          # 是否已进发布页(决定失败时要不要清理现场)
    published = False        # 是否已点发布(决定 UNCERTAIN 时绝不重试、item_id 照报)
    item_id = None
    try:
        spec = dict(spec or {})
        try:
            validate_publish_spec(spec)
        except ValueError as ex:
            raise StepFail("spec", str(ex))

        t.launch_app(PUBLISH_URL)
        entered = True
        time.sleep(4)
        w, h = t.screen_size()
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes, t)
        nodes = _ensure_login(t, nodes, h, save_shot)
        _dismiss_draft_dialog(t, nodes)
        time.sleep(_GAP)

        _step_images(t, spec, save_shot, w, h)
        _step_description(t, spec, save_shot, w, h)
        _step_price(t, spec, save_shot, w, h)
        _step_shipping(t, spec, save_shot, w, h)
        location = _step_location(t, spec, save_shot, w, h)
        _step_attributes(t, spec, save_shot, w, h)
        category = _step_category(t, spec, save_shot, w, h)

        if spec.get("dry_run") or not spec.get("confirm_publish"):
            result["done"] = ["fill"]
            result["dry_run"] = True
            result["shot"] = save_shot("pub_dryrun")
            result["location"] = location
            result["category"] = category
            logger.info("publish: dry_run/confirm_publish=false,填单完成不发")
            _leave_publish(t, save_shot, "dry_run")
            try:
                t.clear_media(spec.get("_pushed_media") or None)
            except Exception as ex:
                logger.warning("publish: dry_run 清图失败: %s", ex)
            return result

        # 发布按钮常驻底部固定条(2026-09-09 实测,无需滚动)。
        # 点前先点中性区收掉可能残留的属性下拉弹层(弹层开着时点「发布」会被它吃掉);
        # 点完 3s 表单纹丝不动(仍在+无弹窗+无校验错误)算未生效,补点一次(对齐手机版 publish 重试)。
        time.sleep(_GAP)
        _close_stray_layers(t, w, h)
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes, t)
        advanced = False
        last_errs: list[str] = []
        for attempt in range(3):
            nodes = _flat(t.dump_nodes())
            _check_risk(nodes, t)
            btn = next((n for n in nodes if (n.get("desc") or "") == "发布"
                        and n["cy"] > h * 0.75), None)
            if not btn:
                raise StepFail("publish", "底部「发布」按钮不可见", save_shot("pub_no_btn"))
            t.tap(btn["cx"], btn["cy"])
            time.sleep(3.0)
            nodes = _flat(t.dump_nodes())
            _check_risk(nodes, t)
            joined = " ".join((n.get("desc") or "") for n in nodes)
            if any(s in joined for s in CAT_UNSUPPORTED):
                raise StepFail("publish", "闲鱼拒发:当前分类不支持网页端发布(分类兜底未生效)",
                               save_shot("pub_cat_blocked"))
            errs = [n["desc"] for n in nodes if "ant-form-item-explain-error" in (n.get("cls") or "")]
            if errs:
                last_errs = errs
                break                                  # 表单校验硬失败,不再补点
            url_now = getattr(t.page, "url", "") or ""
            dialog = any(CLS_CONFIRM_TITLE in (n.get("cls") or "") for n in nodes)
            form_intact = any(CLS_EDITOR in (n.get("cls") or "") for n in nodes)
            if dialog or not form_intact or "/publish" not in url_now:
                advanced = True
                break
            logger.info("publish: 第 %d 次点击未推进(下拉残留/未命中),补点前收弹层", attempt + 1)
            _close_stray_layers(t, w, h)
        if last_errs:
            raise StepFail("publish", "闲鱼表单校验未过:" + ";".join(e.strip() for e in last_errs),
                           save_shot("pub_invalid"))
        if not advanced:
            raise StepFail("publish", "点「发布」3 次均未推进(未弹窗未报错,疑似点击被拦截)",
                           save_shot("pub_no_advance"))
        published = True
        item_id, outcome = _wait_publish_outcome(t, spec, save_shot)
        shot_ok = save_shot("pub_submitted")
        result["publish_outcome"] = outcome
        result["item_id"] = item_id
        result["location"] = location
        result["category"] = category

        # 结果校验:回 personal 在售列表(发布后浏览器停在详情页,必须先跳列表),
        # 标题前缀(=描述首行)应出现;已发布成功但校验失败 → item_id 照报、published=True,绝不盲重发
        time.sleep(_GAP)
        t.launch_app(PERSONAL_URL)
        time.sleep(_GAP)
        cards = _collect_all_cards(t, w, h)
        want = (spec.get("description") or "").strip()[:12]
        hit_card = next((c for c in cards if c["title"] and want and
                         (want in c["title"] or c["title"][:12] in want)), None)
        if not hit_card:
            result["ok"] = False
            result["done"] = []
            result["failed_step"] = "verify"
            result["reason"] = (f"发布后回 personal 在售列表未找到标题前缀 {want!r} 的宝贝"
                                f"(已发布,item_id={item_id},勿盲重发)")
            result["shot"] = shot_ok
            result["published"] = True
            return result
        result["title"] = hit_card["title"]
        result["shot"] = shot_ok
    except RiskHit as ex:
        result = {"ok": False, "done": [], "failed_step": "publish",
                  "reason": str(ex), "shot": ex.shot, "risk": ex.anchor}
    except LoginRequired as ex:
        result = {"ok": False, "done": [], "failed_step": "publish",
                  "reason": ex.reason, "shot": ex.shot, "risk": None, "login": True}
    except FlowTimeout as ex:
        result = {"ok": False, "done": [], "failed_step": "publish",
                  "reason": str(ex), "shot": None, "risk": None}
    except StepFail as ex:
        result = {"ok": False, "done": [], "failed_step": ex.step,
                  "reason": ex.reason, "shot": ex.shot, "risk": None}
    except Exception as ex:
        logger.warning("publish_web 未预期异常: %s", ex, exc_info=True)
        result = {"ok": False, "done": [], "failed_step": "publish",
                  "reason": str(ex), "shot": None, "risk": None}
    # 失败清理:离开发布页(草稿弹窗点放弃)+ 删 push_media 下载的图
    if not result.get("ok"):
        if published:
            result["published"] = True
            result["item_id"] = item_id
        # 命中风控(认证/滑块/验证)就留在原页:那个弹窗要人来处理——扫码认证、拖滑块。
        # 跳回首页等于替人把它关了(2026-10-06 现场:「完成认证才可继续发布」正扫着码页面就跳走了)。
        if entered and not result.get("risk"):
            _leave_publish(t, save_shot, result.get("failed_step") or "fail")
    try:
        uris = spec.get("_pushed_media") or None
        n = t.clear_media(uris)
        if n:
            logger.info("publish: 清理下载图 %d 张", n)
    except Exception as ex:
        logger.warning("publish: 清理下载图失败(残留 /tmp,需留意): %s", ex)
    return result
