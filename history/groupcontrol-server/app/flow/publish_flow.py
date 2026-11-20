"""闲鱼「发布商品」流程:字段化 PublishSpec + 声明式步骤 + 异常兜底。

与旧 automation/publish_flow.py 逻辑一致,但:
- 所有设备操作走 Engine/Transport 原语(dev=ADB / prod=MQTT RPC),步骤代码 dev/prod 通用。
- 图片:spec["images"] 现在是 **OSS URL 列表**(不是本地路径);push_media 让设备自己下载入相册。
  调用方须只传 sku/product/ 前缀图,严禁 asset/*_order_*(买家隐私)与 sku/location/(库位图)。
- **描述完全交给闲鱼 AI 从图生成**(老板 2026-07-14 拍板方案 C):不主动填型号种子。
  闲鱼描述框是 Flutter,无障碍 ACTION_SET_TEXT 写不进,且不引入内置 IME;加图后闲鱼 AI 自动写描述,
  step_description 只等 AI 写好/采用,不做文本输入。代价:AI 偶尔分类错(显示器猜路由器)无种子纠正,接受。

PublishSpec:
{
  "images": ["https://oss/....jpg", ...],  # 商品图 OSS URL;空=跳过(无图则无 AI 描述)
  "description": null,                       # 方案 C:不再用于输入,描述由闲鱼 AI 从图生成;字段保留仅作元数据
  "ai_rewrite": true,
  "price": 460,
  "shipping": {"mode": "free|fixed_fee|by_distance|no_ship", "fixed_fee": 12, "self_pickup": true},
  "location": null,
  "worry_free_sell": true,                  # 默认加入无忧卖(UI 在发布后弹窗,待定位)
  "confirm_publish": false                  # true 才真点「发布」
}

结果(供上层映射 Task/Listing):{ok, done, failed_step, reason, shot, risk}
"""

import logging
import re
import time

from app.flow.engine import Engine, StepError

logger = logging.getLogger("gc.flow.publish")

XIANYU_PKG = "com.taobao.idlefish"

# 纯价格数字(可带 ￥/¥ 前缀、千分位、小数),用于智能定价面板里认出推荐价数字
_PRICE_NUM_RE = re.compile(r"^[¥￥]?\s*\d[\d,]*(\.\d+)?$")

SHIPPING_ANCHOR = {
    "free": "包邮",
    "fixed_fee": "不包邮-固定邮费",
    "by_distance": "不包邮-按距离付费",
    "no_ship": "无需邮寄",
}


# 编辑页特征锚点(编辑区占位),用于判断是否已在编辑页。
# ⚠️ 不用「发货方式」——它既是编辑页的行、又是发货方式**面板**的标题,分不清面板/编辑页。
EDITOR_ANCHORS = ["添加优质", "描述一下"]
# 模态面板特征(盖在编辑页上,须先收掉才能回首页):定价面板 / 发货方式面板独有词。
PANEL_MARKERS = ["推荐定价", "发起竞拍", "邮寄", "买家自提"]


def _in_editor(e: Engine) -> bool:
    return e.find_any(EDITOR_ANCHORS, timeout=1) is not None


def _leave_editor_to_home(e: Engine, tries: int = 8):
    """把闲鱼从「编辑页/弹层」退回首页(「卖闲置」可见)。全程只用原语,不依赖 adb。
    关闭按钮是 content-desc=「关闭」的节点(node_click,分辨率无关);闲鱼非 root 杀不掉,
    force_stop 只回主页、下次 launch 会恢复上次草稿编辑页,所以每次进出都要靠这个收拾干净。"""
    for _ in range(tries):
        if not _in_editor(e) and e.find("卖闲置", timeout=1):
            return True
        # ① 自定义数字键盘弹起时会盖住面板的「取消/确定」→ 先收键盘再处理(否则点不到,死循环)。
        # 闲鱼自绘键盘**不响应系统 BACK**;「收起键盘/删除」不是真 Button(clickable=False),
        # 对其祖先 ACTION_CLICK 无效(实测 node_click 返回 True 但键盘不收)。只有「确定」是真
        # Button——点它提交并收键盘(此处编辑的多是原价/残留值,提交无害,面板随后被取消)。
        if {"1", "2", "3"} <= {n["desc"] for n in e.t.dump_nodes()}:
            stuck = getattr(e, "_kp_stuck", 0) + 1
            e._kp_stuck = stuck  # noqa: SLF001 引擎实例级计数,流程内一次性使用
            if stuck <= 2:
                e.t.node_click("确定")
            elif stuck == 3:
                # node_click 假成功(闲鱼 7.25.80 邮费键盘实证):改 OCR 坐标 tap 确定再试一次
                act = e.find("确定", timeout=1)
                if act:
                    e.tap_xy(*act["center"], settle=1.0)
            else:
                # 键盘仍不收:无障碍手段在此键盘上全堵(2026-07-25 探针实证),别再空转,
                # 交给上层 force_stop + 草稿丢弃路径;报可诊断的错误而非笼统 miss_home
                raise StepError("recovery", "自定义数字键盘无法收起(node_click/tap 均无效,"
                                "疑似反自动化键盘,见 2026-07-25 进度文档 §4)", e.save_shot("kp_stuck"))
            time.sleep(1.0)
            continue
        e._kp_stuck = 0  # noqa: SLF001 键盘已收,复位计数
        # ② 模态面板(定价/发货方式)盖在编辑页上:优先「取消」收掉;发货方式面板无取消(只底部
        # 确定 + 右上 X),点其底部「确定」把面板收回编辑页(recovery 提交无害)。面板必须先于编辑页处理。
        panel = e.find_any(PANEL_MARKERS, timeout=1)
        if panel:
            act = e.find("取消", timeout=1) or e.find("确定", timeout=1)
            if act:
                e.tap_xy(*act["center"], settle=1.2)
            elif e.t.node_click("关闭"):
                time.sleep(1.0)
            else:
                # 发货方式面板的关闭 X 是 a11y 读不到的独立窗口节点;按坐标真触摸点右上角 X。
                # 底部弹层的 X 在其表头(约屏高 26%、贴右缘),用比例坐标避免依赖具体机型。
                title = e.find("发货方式", timeout=1) or e.find("定价", timeout=1)
                x_y = title["center"][1] if title else int(e.height * 0.26)
                e.tap_xy(e.width - 78, x_y, settle=1.2)
        # ③ 编辑页:点左上「关闭」X 退出(desc=关闭 clickable),失败退回 BACK
        elif not e.t.node_click("关闭"):
            e.t.key("BACK")
        time.sleep(1.2)
        # 关闭后可能弹「保存草稿?」:放弃(勿保存,免草稿越攒越多)
        d = e.find_any(["放弃", "不保存", "退出编辑", "不保留"], timeout=1.5)
        if d:
            e.tap_xy(*d[1]["center"], settle=1.0)
    return bool(e.find("卖闲置", timeout=1))


def step_open_editor(e: Engine, spec: dict):
    e.t.key("WAKEUP")               # 防息屏黑屏
    e.t.force_stop(XIANYU_PKG)
    time.sleep(1)
    e.t.launch_app(XIANYU_PKG)
    time.sleep(4)
    e.dismiss_nuisance()
    # 闲鱼常把上次草稿「无提示」直接恢复进编辑页,此时首页「卖闲置」不可见→靠「关闭」节点退回首页
    if _in_editor(e) or not e.find("卖闲置", timeout=2):
        if not _leave_editor_to_home(e):
            raise StepError("open_editor", "无法退回闲鱼首页(卖闲置不可见)", e.save_shot("miss_home"))
    e.tap_text("卖闲置", "open_editor")
    e.tap_text("发闲置", "open_editor")
    if e.find_any(["未编辑完成", "继续编辑"], timeout=3):  # 弹草稿框→放弃,要干净新编辑页
        d = e.find_any(["放弃", "重新发布", "不保存"], timeout=2)
        if d:
            e.tap_xy(*d[1]["center"], settle=1.0)
    if not e.wait_any(["添加优质", "描述一下"], timeout=10):
        raise StepError("open_editor", "未进入发布编辑页", e.save_shot("miss_editor"))


def step_images(e: Engine, spec: dict):
    """选图(节点驱动):OSS 图 → 设备下载入相册 → 打开选图器 →
    按 content-desc「选择」节点点最新 N 张 → 下一步 → 完成。加图后闲鱼 AI 自动生成描述。"""
    imgs = spec.get("images") or []
    if not imgs:
        return
    # 防串图兜底(选图前先清)：选图靠「点最新的 N 张」，若上一单 reset_to_clean 没跑到
    # (崩溃/被杀/旧 APK 无 clear_media)，残留的历史商品图就会被这一单选中→发错图。
    # 本单还没推图，此刻相册里任何 gc 图都是残留 → 开推前清空,保证从空相册起步。
    # 与收尾的 uris 精确清互补:开头清「上一单残留」,收尾清「本单推入」。
    try:
        cleared = e.t.clear_media(None)
        if cleared:
            logger.info("step_images 选图前清理残留商品图 %s 张(防串图)", cleared)
    except Exception as ex:
        logger.warning("选图前清理残留失败(旧 APK 可能无 clear_media 原语,串图风险仍在):%s", ex)
    # 记下推进相册的 uri，收尾时精确删除。不删会堆积，更要命的是
    # 下面选图靠「点最新的 N 张」，残留一多就会把上一单的图发到这一单上。
    pushed: list[str] = spec.setdefault("_pushed_media", [])
    for url in imgs:
        uri = e.t.push_media(url)
        if uri:
            pushed.append(uri)
        time.sleep(0.5)
    e.tap_text("添加优质", "images")
    e.require_any(["所有文件", "相册"], "images", timeout=8)
    for _ in range(len(imgs)):
        e.tap_node_by_desc("选择", "images", index=0)  # 每次点第一个=当前最新未选
    e.tap_text("下一步", "images", timeout=6)
    e.tap_text("完成", "images", timeout=6)
    e.require_any(["价格", "发货方式", "描述一下", "AI帮你写好了"], "images", timeout=10)


def step_description(e: Engine, spec: dict):
    """方案 C:描述交给闲鱼 AI 从图生成,不做文本输入(描述框是 Flutter,set_text 写不进,不引入 IME)。
    有图:等 AI 把描述写好(占位「描述一下」消失);无图:无 AI 描述可依赖,直接跳过。"""
    if not spec.get("images"):
        return
    # 等闲鱼 AI 生成描述(加图后自动触发):占位消失或出现「AI帮你写/采用」即认为已就绪
    e.wait_any(["采用", "AI帮你写", "AI生成"], timeout=8)


def step_ai_rewrite(e: Engine, spec: dict):
    if not spec.get("ai_rewrite"):
        return
    for label in ("采用", "AI帮你写"):    # 非致命:没有就跳过
        hit = e.find(label, timeout=2)
        if hit:
            e.tap_xy(*hit["center"], settle=1.2)
            return


def _dismiss_ime(e: Engine):
    """描述框聚焦时系统键盘+工具条(主题/表情/识物|完成)会盖住价格/发货行(AI 采用后常驻聚焦,
    2026-07-14 真发首跑就栽在这):点工具条「完成」收起;没有该工具条则视为无键盘,不动。"""
    if e.find("识物", timeout=1.5):
        done = e.find("完成", timeout=1.5)
        if done:
            e.tap_xy(*done["center"], settle=1.2)


def _find_price_value(e: Engine) -> dict | None:
    """找编辑页右半边价格值控件(￥X.XX),比「价格」二字 OCR 稳。"""
    cands = [it for it in e.read()
             if ("￥" in it["text"] or "¥" in it["text"]) and it["center"][0] > e.width // 2]
    return min(cands, key=lambda it: it["center"][1]) if cands else None


def _panel_amount(e: Engine) -> tuple[str, dict | None]:
    """定价面板里「推荐定价」下、原价/区间之上的那个大号数字 = 当前售价输入值。
    返回 (纯数字串, 该OCR项)。读不到返回 ("", None)。"""
    items = e.read()
    # 基准线必须取「定价」标题那一行。坑(2026-07-21 真机)：面板里含「定价」的不止一处——
    # 标题「定价」(价格上方) 和 「补充更多信息，帮你智能定价」(价格下方)。
    # ocr.find 返回的是**置信度最高**的一条，长句往往比两字标题分更高 → 基准线被拉到价格下方，
    # 真正的售价数字随即被下面的 `y > ry` 滤掉，读回恒为 ''，把已经填对的价格判成失败。
    # 故：排掉已知干扰句，并取最靠上的那处作基准。
    titles = [it for it in items
              if ("定价" in it["text"] or "推荐定价" in it["text"]) and "智能定价" not in it["text"]]
    ry = min(titles, key=lambda it: it["center"][1])["center"][1] if titles else int(e.height * 0.28)
    nums = [it for it in items
            if _PRICE_NUM_RE.match(it["text"].strip()) and it["center"][1] > ry and "原价" not in it["text"]]
    if not nums:
        return "", None
    top = min(nums, key=lambda it: it["center"][1])
    digits = re.sub(r"[^\d.]", "", top["text"])
    return digits, top


def _price_keypad_up(e: Engine) -> bool:
    return {"1", "2", "3"} <= {n["desc"] for n in e.t.dump_nodes()}


def _ensure_price_keypad(e: Engine, timeout: float = 6) -> bool:
    """确保定价数字键盘已弹起:没弹则点大号推荐价数字拉起(清空到空时键盘会自动收起,要重开)。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _price_keypad_up(e):
            return True
        _, big = _panel_amount(e)
        if big:
            e.tap_xy(*big["center"], settle=1.0)
        else:
            e.tap_xy(e.width // 2, int(e.height * 0.40), settle=1.0)
    return _price_keypad_up(e)


def _match_price(cur: str, target: str) -> bool:
    """面板大号数字 cur 是否等于 target(容忍 .0/.00 小数尾)。"""
    cur = cur.strip()
    return cur in (target, target + ".0", target + ".00") or cur.rstrip("0").rstrip(".") == target


def _set_price_via_keypad(e: Engine, price: int):
    """把售价设成 price:拉起定价键盘→**set_text 整体替换**推荐预填→读回校验,重试至多 3 次。
    关键(2026-07-15 真机定论):定价数字键盘弹起时,推荐价字段是原生 EditText,无障碍
    ACTION_SET_TEXT 可**整段覆盖**(免清空)。而闲鱼自定义键盘的「删除」键不是真 Button、
    合成触摸/ACTION_CLICK 都不可靠(逐位删+输会拼出鬼价 realpub5=364600 / 394600),故弃用逐位方案。
    键盘未弹时 set_text 无焦点写不进,必须先 _ensure_price_keypad。"""
    target = str(int(price))
    cur = ""
    last_err: Exception | None = None
    for _attempt in range(3):
        if not _ensure_price_keypad(e):
            raise StepError("price", "定价键盘无法弹起", e.save_shot("kp_price"))
        try:
            e.t.set_text(target)
        except Exception as ex:
            # 别静默吞：set_text 真失败时若不记，最后只剩「校验不过」，
            # 会把「没写进去」和「写进去了但没读到」这两种完全不同的故障混为一谈。
            last_err = ex
        # 读回校验要多试几次。写入生效后，还要经「截屏 RPC 往返 + 服务端 OCR」才能看到，
        # 单次固定等待容易读在半路：2026-07-21 真机就出现过面板明明是 460、
        # 证据截图也是 460，却因只读一次读早了而判失败(一次成功被误杀)。
        for _ in range(3):
            time.sleep(0.9)
            cur, _ = _panel_amount(e)
            if _match_price(cur, target):
                return
    detail = f"面板显示 {cur!r},期望 {target}"
    if last_err:
        detail += f";set_text 报错:{last_err}"
    raise StepError("price", f"售价校验失败({detail})", e.save_shot("kp_price_verify"))


def step_price(e: Engine, spec: dict):
    price = spec.get("price")
    if price is None:
        return
    _dismiss_ime(e)
    e.scroll_to("发货方式", "price", max_swipes=5)
    opened = False
    for _ in range(3):
        val = _find_price_value(e)
        if val:
            e.tap_xy(*val["center"], settle=1.2)
            if e.find("定价", timeout=3):
                opened = True
                break
        e.dismiss_nuisance()
        time.sleep(0.6)
    if not opened:
        raise StepError("price", "点价格行未弹出定价面板", e.save_shot("price_open"))
    # 定价面板两个变体(均真机实测):
    # ① 空白变体:有「输入定价」占位,点它拉起数字键盘;
    # ② 智能定价变体(2026-07-14 真发遇到):「推荐定价」标题 + 下方大号推荐价数字(如 360.0,
    #    OCR 无 ￥ 前缀)+ 价格区间滑条 + 原价¥0。**必须点那个大号推荐价数字**才编辑售价;
    #    早期误用 ￥ 过滤会点到「原价:¥0」→ 键盘绑到原价字段,售价没改(realpub4 栽在这)。
    kb = e.find_any(["输入定价", "输入价格"], timeout=2)
    if kb:
        e.tap_xy(*kb[1]["center"], settle=1.2)
    # 清空推荐预填 + 逐位输入 + 面板内校验(_set_price_via_keypad 内部会确保/重弹键盘)
    _set_price_via_keypad(e, int(price))
    # 键盘「确定」提交并收键盘,回到编辑页
    e.t.node_click("确定")
    time.sleep(1.2)
    # 编辑页最终校验:价格行必须精确等于 price(智能定价预填易拼接,必须核对)
    if not e.find_any(["发货方式", "所在位置"], timeout=4):
        raise StepError("price", "填价后未回到编辑页", e.save_shot("price_verify"))
    pv = None
    for _ in range(2):
        pv = _find_price_value(e)
        if pv:
            break
        time.sleep(0.8)
    m = re.search(r"[￥¥]\s*([\d.]+)", (pv["text"] if pv else "").replace(",", ""))
    ok_exact = False
    if m:
        try:
            ok_exact = abs(float(m.group(1)) - float(price)) < 0.01
        except ValueError:
            pass
    if not ok_exact:
        raise StepError("price", f"价格校验失败(编辑页价格={pv['text'] if pv else '未读到'},期望 {int(price)})",
                        e.save_shot("price_verify"))


def _shipping_row_text(e: Engine) -> str:
    """编辑页「发货方式」那一整行的文本(含右侧值)。读不到返回 ''。"""
    items = e.read()
    row = next((it for it in items if "发货方式" in it["text"]), None)
    if not row:
        return ""
    ry = row["center"][1]
    parts = [it["text"] for it in items if abs(it["center"][1] - ry) < 40]
    return " ".join(parts)


def _shipping_row_ok(txt: str, mode: str, sp: dict) -> bool:
    """编辑页发货方式行是否符合 spec。fixed_fee 必须见到「运费」和金额数字;free 见「包邮」。"""
    if not txt:
        return False
    if mode == "free":
        return "包邮" in txt
    if mode == "fixed_fee":
        return "运费" in txt and str(int(sp.get("fixed_fee", 0))) in txt.replace(",", "")
    if mode == "by_distance":
        return "距离" in txt
    if mode == "no_ship":
        return "无需邮寄" in txt
    return True


def step_shipping(e: Engine, spec: dict):
    sp = spec.get("shipping") or {}
    mode = sp.get("mode", "fixed_fee")
    anchor = SHIPPING_ANCHOR.get(mode)
    if not anchor:
        raise StepError("shipping", f"未知发货方式 mode={mode}")
    txt = ""
    # 2026-07-25 真机教训:面板里每个动作都「成功」,回编辑页却是 运费¥0.00(固定邮费 12 没生效),
    # 旧的弱校验(回到编辑页就算过)直接放行 → 发出去运费是错的。故回编辑页后必须核对行值,
    # 不符重做一次,仍不符带截图抛错。
    for attempt in range(2):
        e.scroll_to("发货方式", "shipping", max_swipes=5)
        e.tap_text("发货方式", "shipping")
        e.require("邮寄", "shipping", timeout=5)   # 面板已开(顶部「邮寄」分组)
        # 1) 先选发货方式(点单选行文字即选中);固定邮费选中后其下会冒出「￥0」邮费输入行
        e.tap_text(anchor, "shipping")
        if mode == "fixed_fee":
            # 选中「不包邮-固定邮费」后焦点自动进邮费框、数字键盘自动弹起。
            # 2026-07-26 新 APK(set_text 全窗口查找)实测最终配方:
            #   邮费框是**独立窗口的原生 EditText** → set_text 直接写入(老实现只查 rootInActiveWindow 够不到);
            #   键盘数字键 ACTION_CLICK/dispatchGesture 均被过滤(勿逐位点);
            #   键盘黄色「确定」接受合成触摸 → OCR 坐标点它提交并收键盘;
            #   面板右上 X 会**丢弃**未提交值(勿用 X 关面板)。
            fee_val = int(sp.get("fixed_fee", 0))
            if not _price_keypad_up(e):
                hit = e.find_any(["￥0", "¥0", "0.00", "输入邮费"], timeout=4)
                if hit:
                    e.tap_xy(e.width // 2, hit[1]["center"][1], settle=1.0)
            if not _price_keypad_up(e):
                raise StepError("shipping", "邮费数字键盘未弹起", e.save_shot("ship_fee_kp"))
            try:
                e.t.set_text(str(fee_val))
            except Exception as ex:
                raise StepError("shipping", f"邮费 set_text 写入失败:{ex}(需新版 APK)", e.save_shot("ship_fee_set"))
            # 读回校验(重试 4 次,行内拼接):¥ 与数字可能 OCR 成两个 item、光标会被读成 1/l、
            # RPC+OCR 链路有 1~3s 延迟,单点一次读易误判(2026-07-26 实测:字段明明 ¥12 却被误杀)。
            fee_str = str(fee_val)
            fee_ok = False
            for _ in range(4):
                time.sleep(0.9)
                items = e.read()
                yen = [it for it in items if "¥" in it["text"] or "￥" in it["text"]]
                for y in yen:
                    ry = y["center"][1]
                    row = " ".join(it["text"] for it in items if abs(it["center"][1] - ry) < 40)
                    if fee_str in row.replace(",", ""):
                        fee_ok = True
                        break
                if fee_ok:
                    break
            if not fee_ok:
                raise StepError("shipping", f"邮费读回校验失败(期望 ¥{fee_str})",
                                e.save_shot("ship_fee_verify"))
            act = e.find("确定", timeout=2)          # 键盘「确定」:提交并收键盘
            if act:
                e.tap_xy(*act["center"], settle=1.0)
            else:
                e.t.node_click("确定")               # 兜底(老版本闲鱼上是真 Button)
            time.sleep(1.0)
        # 2) 再开买家自提(选完发货方式后布局已定;开关在「买家自提」行右侧)
        if sp.get("self_pickup"):
            row = e.require("买家自提", "shipping")
            e.tap_xy(e.width - 90, row["center"][1], settle=0.6)
        # 3) 确定并回编辑页;校验发货方式行真的生效了
        e.tap_text("确定", "shipping", timeout=5)
        if mode != "free":
            e.require_any(["发货方式", "所在位置"], "shipping", timeout=5)  # 回到编辑页
        txt = _shipping_row_text(e)
        if _shipping_row_ok(txt, mode, sp):
            return
        logger.warning("发货方式行校验不符(第 %d 次重做):行=%r mode=%s sp=%s", attempt + 1, txt, mode, sp)
        time.sleep(1.0)
    raise StepError("shipping", f"发货方式两次设置均未生效(编辑页行={txt!r})", e.save_shot("ship_verify"))


def step_location(e: Engine, spec: dict):
    loc = spec.get("location")
    if not loc:
        return
    raise StepError("location", "指定位置流程待实现", e.save_shot("todo_location"))


def step_worry_free(e: Engine, spec: dict):
    """无忧卖 UI 在点「发布」之后才出现(弹窗),处理挪进 step_publish 的发布后循环;此步保留占位。"""


# ---- 发布后弹窗/成功锚点(候选集,真发校准中;跑真发后按证据收敛) ----
WFS_POPUP = ["无忧卖", "验货宝"]
WFS_JOIN = ["加入无忧卖", "立即加入", "一键加入", "确认加入", "加入并发布", "同意并加入"]
WFS_SKIP = ["暂不加入", "暂不", "以后再说", "跳过", "直接发布"]
PUBLISH_CONFIRM = ["继续发布", "仍要发布", "确认发布"]  # 规则/诚信类确认弹窗:推进发布
SUCCESS_ANCHORS = ["发布成功", "再发一件", "擦亮"]      # 成功页/详情页特征
# 「待上架」页:发布已提交、宝贝已建,但**账号未开通支付宝收款**→未认证宝贝无法上架卖出。
# 这是账号级业务前置(需号主完成支付宝实名收款),不是自动化能/该绕过的。见 [[alipay-integration]]。
PENDING_AUTH_MARKERS = ["还差最后一步", "开通支付宝收款", "待上架", "未认证宝贝"]


def _find_publish_btn(e: Engine) -> dict | None:
    """编辑页底部「发布」按钮:取文本恰为「发布」的最靠下命中,避免误中「我发布的」等长文本。"""
    cands = [it for it in e.read() if it["text"].strip() == "发布"]
    return max(cands, key=lambda it: it["center"][1]) if cands else None


def step_publish(e: Engine, spec: dict):
    if not spec.get("confirm_publish"):
        return  # 默认只填不发
    import json
    import os

    explore_dir = os.getenv("GC_PUBLISH_EXPLORE_DIR")  # 设了=捕获模式:每轮存截图+节点树供校准
    # 「发布」在顶栏。Flutter 按钮对 ACTION_CLICK 是「假成功」:node_click 返回 true 但实际没触发
    # (2026-07-25 真机实证:node_click 连点 3 次「成功」编辑页纹丝不动,adb 真实注入一点就过)。
    # 故**优先 OCR 定位坐标 tap**(dispatchGesture 合成触摸对普通 Flutter 按钮有效,全流程都这么点),
    # OCR 找不到按钮才退 node_click。每次点完都校验编辑页是否真的推进,不再盲信点击返回值。
    def _in_editor_now():
        return e.find_any(["发货方式", "所在位置", "添加优质"], timeout=1) is not None
    advanced = False
    for _ in range(3):
        btn = _find_publish_btn(e)
        if btn:
            e.tap_xy(*btn["center"], settle=2.5)
        elif e.t.node_click("发布"):
            time.sleep(2.5)
        else:
            break  # 两种途径都找不到按钮,别空转
        if not _in_editor_now():
            advanced = True
            break
        # 仍在编辑页:可能弹了确认/无忧卖(下方循环处理),也可能没点动,再试
        if e.find_any(WFS_POPUP + PUBLISH_CONFIRM + SUCCESS_ANCHORS, timeout=1):
            advanced = True
            break
        e.dismiss_nuisance()
        time.sleep(0.8)
    if not advanced:
        raise StepError("publish", "点「发布」后编辑页未推进(按钮未响应?)", e.save_shot("publish_no_advance"))

    from app.flow import ocr as O
    deadline = time.time() + 60
    seq = 0
    while time.time() < deadline:
        items = e.read()

        def _hit(cands):
            for c in cands:
                h = O.find(items, c)
                if h:
                    return c, h
            return None

        if explore_dir:
            e.save_shot(f"pub_{seq:02d}")
            try:
                with open(os.path.join(explore_dir, f"pub_nodes_{seq:02d}.json"), "w") as f:
                    json.dump(e.dump_nodes(), f, ensure_ascii=False)
            except Exception:
                pass
            seq += 1

        if _hit(SUCCESS_ANCHORS):
            e.save_shot("publish_success")
            return
        # 待上架页:宝贝已建但账号未开通支付宝收款→无法上架卖出。发布**已成功提交**(非失败),
        # 但需号主开通支付宝收款才真正 LIVE。这里干净离开认证页(不点「去开通」,那是号主的实名/支付流程),
        # 记录为「已提交待认证」终态。上层应把 Listing 记为 UNCERTAIN/待认证,勿盲重发(会建重复待上架宝贝)。
        if _hit(PENDING_AUTH_MARKERS):
            e.save_shot("publish_pending_auth")
            spec["_publish_outcome"] = "PENDING_PAYMENT_AUTH"
            # 离开认证页:BACK→「确定退出认证吗」弹「狠心离开」→点它退出,别开通支付宝
            e.t.key("BACK")
            time.sleep(1.2)
            leave = e.find_any(["狠心离开", "狠心退出", "确认退出", "退出"], timeout=3)
            if leave:
                e.tap_xy(*leave[1]["center"], settle=1.5)
            return
        # 无忧卖弹窗:按 spec 加入/跳过
        if _hit(WFS_POPUP):
            act = _hit(WFS_JOIN if spec.get("worry_free_sell") else WFS_SKIP)
            if act:
                e.tap_xy(*act[1]["center"], settle=1.5)
                continue
            e.save_shot(f"wfs_unknown_{seq:02d}")  # 弹窗在但按钮文案没命中:留证据,等超时人工校准
        # 规则/诚信类确认弹窗:推进
        act = _hit(PUBLISH_CONFIRM)
        if act:
            e.tap_xy(*act[1]["center"], settle=1.5)
            continue
        # 回到首页且编辑页没了:多半发布已完成只是没截到成功页(toast 短暂)
        if not _in_editor(e) and O.find(items, "卖闲置"):
            e.save_shot("publish_back_home")
            return
        time.sleep(0.8)
    # 超时没抓到瞬时成功锚点 ≠ 没发成功。慢传输(MQTT 截图节流~1/s)下「发布成功」toast 极易漏抓,
    # 商品其实已 live——2026-07-22 真机 MQTT 实测:重新上架后详情页 live、却报 UNCERTAIN,
    # 只因落在「刚刚来过」详情页(无 SUCCESS_ANCHORS 里的「擦亮」字样)。
    # 兜底以 list_cards 渲染真值收口(同「下架以 list_cards 为准」同源):spec 带 title(重新上架)时,
    # 导航回在卖查该商品是否已在架,在架即判成功——瞬时 toast 抓不到也能确认。
    title = (spec.get("title") or "").strip()
    if title:
        try:
            from app.flow import delist_flow as _dl
            _dl.step_open_my_listings(e, spec)
            titles = [c["title"] for c in _dl.list_cards(e)]
            key = title[:12]
            if any(t == title or (key and key in t) for t in titles):
                logger.info("发布 list_cards 兜底确认:商品「%s」已在在卖 → 判成功", title[:20])
                e.save_shot("publish_confirmed_via_list")
                return
        except Exception as ex:
            logger.warning("发布 list_cards 兜底确认失败(仍按 UNCERTAIN):%s", ex)
    # 仍无法确认:按 UNCERTAIN 语义抛错,上层置 Listing=UNCERTAIN 交对账,勿盲重发
    raise StepError("publish", "发布后 60s 未确认成功(UNCERTAIN:可能已发布,勿盲重发)",
                    e.save_shot("publish_uncertain"))


STEPS = [
    ("open_editor", step_open_editor),
    ("images", step_images),
    ("description", step_description),
    ("ai_rewrite", step_ai_rewrite),
    ("price", step_price),
    ("shipping", step_shipping),
    ("location", step_location),
    ("worry_free_sell", step_worry_free),
    ("publish", step_publish),
]


def reset_to_clean(e: Engine, spec: dict | None = None):
    """复位:把闲鱼恢复到干净首页(放弃当前草稿),给下一单干净起点。全程只用原语。
    无论本单成功失败都要跑;失败时也别让残留编辑页/弹层污染下一单。
    并清掉本单推进相册的商品图——图片残留会让下一单的「选最新 N 张」选到上一单的图。"""
    try:
        if not _leave_editor_to_home(e, tries=4):
            e.t.force_stop(XIANYU_PKG)  # 兜底:回主页(非 root 杀不掉,只降级回桌面)
    except Exception:
        try:
            e.t.force_stop(XIANYU_PKG)
        except Exception:
            pass
    # 清图放在最后且吞异常：清理失败不该把已经成功的发布判成失败，
    # 但要留日志，否则残留会静默累积到某天发错图才被发现。
    try:
        uris = (spec or {}).get("_pushed_media") or None
        n = e.t.clear_media(uris)
        logger.info("发布收尾清理相册图 %s 张(uris=%s)", n, len(uris) if uris else "全部")
    except Exception as ex:
        logger.warning("清理相册图失败(残留会影响下一单选图):%s", ex)


def run_publish(transport, spec: dict, shot_sink=None) -> dict:
    """跑一条发布流程。transport 由调用方按 dev/prod 传入(AdbTransport/MqttRpcTransport)。
    结束(成功或失败)后**复位**闲鱼到干净首页,保证下一单从已知状态起步(按键精灵范式)。"""
    e = Engine(transport, shot_sink=shot_sink)
    result = e.run(STEPS, spec)
    # 透出发布终态:PENDING_PAYMENT_AUTH = 宝贝已提交但账号未开通支付宝收款,未真正上架(勿盲重发)。
    result["publish_outcome"] = spec.get("_publish_outcome") or ("SUBMITTED" if result.get("ok") else None)
    if result.get("ok"):
        # 强锚 = 标题 + 价格(名称+价格匹配)。价格是发布入参已知(spec["price"]),
        # 记账时直接落 Listing.price;这里只需回读 AI 从图生成的标题。
        # (item_id 放弃:闲鱼卡片/详情 a11y 树都不含,只能靠分享短链绕解,不稳、拖慢发布路径。)
        result["title"] = _readback_title(e)
    reset_to_clean(e, spec)
    return result


def _readback_title(e: Engine) -> str | None:
    """发布成功后回捞刚上架商品的标题(强锚的「名称」半边;价格半边由 spec["price"] 记账)。

    闲鱼卡片/详情 a11y 树都不含 item_id,标题是我们在「在卖」列表里能精确定位商品的依据;
    配合发布价(名称+价格匹配)足以在下架/改价时锚定,无需 item_id。标题由闲鱼 AI 从图生成、
    发出去才知道,所以必须在此回读。整段吞异常:回读失败不该把已成功的发布判成失败,
    Listing 留空 title 即可,后续对账任务仍可补。
    """
    try:
        from app.flow.delist_flow import list_cards, open_my_published, select_tab

        open_my_published(e)
        select_tab(e, "在卖", "readback")
        cards = list_cards(e)
        if not cards:
            logger.warning("发布回读标题:在卖列表为空，可能尚未刷新")
            return None
        title = cards[0]["title"]           # 刚发布的排最前
        logger.info("发布回读标题:%s", title)
        return title
    except Exception as ex:
        logger.warning("发布回读标题失败(不影响发布结果):%s", ex)
        return None
