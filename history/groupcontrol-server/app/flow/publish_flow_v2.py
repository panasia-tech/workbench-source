"""发布流程 V2：节点/坐标驱动，运行态零 OCR。

背景（2026-07-26 老板拍板）：机型单一（小米12/1080x2400）、闲鱼版本锁定，
OCR 只用于开发期校准与失败取证。运行态改为：
- **节点优先**：dump_nodes 本地几百毫秒、布局无关（编辑器全部控件都有语义节点，
  含「发布, 发布」这种双文案 desc）。
- **固定坐标兜底**：首页底部 tab 等少数稳定位置。
- **变长等待只看节点**：闲鱼 AI 写描述等用节点状态轮询（每次 ~0.5s），不用 OCR。

收益：全流程从 ~10 分钟（150~200 次截屏+OCR 往返）压到 2~3 分钟。

节点地图(2026-08-01 复校,闲鱼新版 @1080x2400;tab 较 07-26 版整体下移 ~50px):
  首页: 卖闲置(540,2316) 我的(960,2316) 消息(761,2316) 闲鱼(120,2335)
  编辑器: 关闭(49,167) 发布,发布(975,167) 添加图片(227,443) 描述(540,892)
          AI帮你写(540,1327) 价格设置(540,1512) 发货方式(540,1682) 选择位置(540,1820)
"""

import logging
import re
import time

from app.flow import ocr as O
from app.flow.engine import Engine, RiskHit, StepError

logger = logging.getLogger("gc.flow.publish_v2")

XIANYU_PKG = "com.taobao.idlefish"

# ---- 固定坐标(节点读不到的位置;1080x2400,2026-08-01 复校)----
XY_SELL_TAB = (540, 2316)      # 首页底部「卖闲置」
XY_PUBLISH_ENTRY = (250, 1320) # 卖闲置面板「发闲置」卡片
XY_HOME_TAB = (120, 2335)      # 底部「闲鱼」tab(复位用)
# 发布编辑页顶栏「发布」黄钮(08-30 小米12 实测:节点 bounds=[871,123][1080,211],截图复核一致)。
# 节点读不到时固定点这里,不再用 OCR 找位置(OCR 全屏 contains 曾命中描述正文误点,08-30)。
XY_PUBLISH_BTN = (975, 167)


# ---------- 节点工具 ----------

def _nodes(e: Engine) -> list[dict]:
    return e.t.dump_nodes()


def _find(ns: list[dict], prefix: str, clickable=None) -> dict | None:
    """按 desc 前缀找节点。「发布, 发布」这类双文案 desc 用前缀匹配（exact 会漏）。"""
    for n in ns:
        if (n.get("desc") or "").startswith(prefix):
            if clickable is None or n.get("clickable") == clickable:
                return n
    return None


def _tap_node(e: Engine, n: dict, settle: float = 1.0) -> None:
    # Transport 规整后的节点结构:{desc,cls,clickable,center:(x,y),size:(w,h)}
    e.tap_xy(n["center"][0], n["center"][1], settle=settle)


def _wait_node(e: Engine, prefix: str, timeout: float = 8, clickable=None) -> dict | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        hit = _find(_nodes(e), prefix, clickable)
        if hit:
            return hit
        time.sleep(0.6)
    return None


def _scroll_down(e: Engine) -> None:
    e.t.swipe(540, 1900, 540, 1100, 400)
    time.sleep(0.8)


def _find_row(e: Engine, prefix: str, step: str, timeout: float = 5, scrolls: int = 3) -> dict:
    """找编辑页的行节点(价格设置/发货方式/选择位置)。编辑页内容多时行在屏外,
    节点树只有可见区 → 找不到就下滑再试(最多 scrolls 次)。"""
    for _ in range(scrolls + 1):
        hit = _wait_node(e, prefix, timeout=timeout)
        if hit:
            return hit
        _scroll_down(e)
    raise StepError(step, f"编辑页无「{prefix}」行(下滑 {scrolls} 次后仍未见)", e.save_shot(f"v2_row_{step}"))


def _wait_gone(e: Engine, prefix: str, timeout: float = 8) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not _find(_nodes(e), prefix):
            return True
        time.sleep(0.6)
    return False


def _keypad_up(e: Engine) -> bool:
    return {"1", "2", "3"} <= {n.get("desc") for n in _nodes(e)}


def _in_editor(ns: list[dict]) -> bool:
    return _find(ns, "添加图片") is not None or _find(ns, "描述,") is not None


def _discard_draft_if_any(e: Engine) -> None:
    """草稿弹框 → 放弃/不保存(不攒脏草稿——脏草稿会带错分类错属性毒化下一单,
    07-26 实测:草稿被恢复成分类=组装台机,发布被静默拦)。
    弹框有两种文案:「未编辑完成,继续编辑?」和「要不要先存个草稿」。"""
    ns = _nodes(e)
    if (_find(ns, "未编辑完成") or _find(ns, "继续编辑")
            or _find(ns, "存个草稿") or _find(ns, "要不要")):
        d = _find(ns, "放弃") or _find(ns, "不保存") or _find(ns, "重新发布")
        if d:
            _tap_node(e, d, settle=1.2)


def _dismiss_permission_popup(e: Engine) -> bool:
    """系统权限弹窗(闲鱼进发布页常弹「允许"闲鱼"获取位置信息」)→ 点「仅在使用中允许」放行。
    不放行会盖在发布编辑页上,读不到「添加图片」→ 误判「未进入发布编辑页」。
    ⚠️ 这类系统弹窗无障碍**节点树读不到**(2026-08-13 实测:dump_nodes 既无弹窗按钮、
    也读不到被盖住的编辑页控件),只能 OCR 认按钮再按坐标点。先试节点(个别 ROM 可读)再退 OCR。"""
    # 1) 节点优先:个别机型系统弹窗节点可读,省一次 OCR
    ns = _nodes(e)
    for allow in ("仅在使用中允许", "本次使用允许"):
        btn = _find(ns, allow)
        if btn:
            _tap_node(e, btn, settle=1.2)
            logger.info("v2 放行系统权限弹窗(节点): 点「%s」", allow)
            return True
    # 2) OCR 兜底:「仅在使用中允许/本次使用允许」是权限弹窗独有文案,编辑页不会出现 → 认到即点
    try:
        items = e.read()
    except RiskHit:
        raise
    except Exception:
        logger.warning("v2 权限弹窗 OCR 读屏失败,跳过放行", exc_info=True)
        return False
    for allow in ("仅在使用中允许", "本次使用允许"):   # 优先持久授权「仅在使用中允许」
        hit = O.find(items, allow)
        if hit:
            e.tap_xy(hit["center"][0], hit["center"][1], settle=1.2)
            logger.info("v2 放行系统权限弹窗(OCR): 点「%s」", allow)
            return True
    return False


def _wait_editor_or_dismiss_perm(e: Engine, reason: str, shot: str) -> None:
    """等发布编辑页(「添加图片」)出现;等不到就当系统权限弹窗(位置)挡住 → 放行后重试(最多 2 个弹窗)。"""
    if _wait_node(e, "添加图片", timeout=10):
        return
    for _ in range(2):
        if not _dismiss_permission_popup(e):
            break
        if _wait_node(e, "添加图片", timeout=8):
            return
    raise StepError("open_editor", reason, e.save_shot(shot))


def reset_to_clean(e: Engine, spec: dict | None = None) -> None:
    """复位到干净首页。节点驱动：键盘「确定」收键盘 → 面板「确定/X」→ 编辑器「关闭」→ 弃草稿。"""
    for _ in range(6):
        ns = _nodes(e)
        if _find(ns, "卖闲置"):
            break
        if _keypad_up(e):
            ok = _find(ns, "确定")
            if ok:
                _tap_node(e, ok, settle=1.0)
            continue
        panel = _find(ns, "发货方式\n") or _find(ns, "定价")
        if panel:
            act = _find(ns, "取消") or _find(ns, "确定")
            if act:
                _tap_node(e, act, settle=1.0)
                continue
        close = _find(ns, "关闭")
        if close:
            _tap_node(e, close, settle=1.0)
            _discard_draft_if_any(e)
            continue
        # 不在编辑器也没有面板/键盘:可能已在桌面/别的页,BACK 无意义,直接重拉闲鱼
        if not _in_editor(ns):
            e.t.launch_app(XIANYU_PKG)
            time.sleep(5)   # 2.5→5s:给慢冷启动留落地时间,避免复位循环里反复重拉打断上一个启动
            if _find(_nodes(e), "卖闲置"):
                break
            continue
        e.t.key("BACK")
        time.sleep(1.0)
    else:
        e.t.force_stop(XIANYU_PKG)
    # 清本单推进相册的图(防串图);清理失败不致命但要留日志
    try:
        uris = (spec or {}).get("_pushed_media") or None
        n = e.t.clear_media(uris)
        logger.info("v2 复位清理相册图 %s 张", n)
    except Exception as ex:
        logger.warning("v2 复位清图失败(残留会串下一单):%s", ex)


# ---------- 步骤 ----------

def step_open_editor(e: Engine, spec: dict) -> None:
    e.t.key("WAKEUP")
    for attempt in range(2):
        e.t.force_stop(XIANYU_PKG)
        time.sleep(1)
        e.t.launch_app(XIANYU_PKG)
        # 等首页或编辑器出现(冷启动快慢不一,固定 sleep 会读在启动图上)。
        # 10s→20s:2026-08-30 真机实测小米12/Android15 冷启动(开屏广告+Flutter init)落在 12s+,
        # 10s 窗口每次都差临门一脚,task 失败后 10s 闲鱼才上前台。
        deadline = time.time() + 20
        ns: list[dict] = []
        while time.time() < deadline:
            ns = _nodes(e)
            if _find(ns, "卖闲置") or _in_editor(ns):
                break
            time.sleep(1.0)
        if _find(ns, "卖闲置") or _in_editor(ns):
            break
        logger.warning("v2 闲鱼拉起未见首页(第 %d 次),重试", attempt + 1)
    if _in_editor(ns) or not _find(ns, "卖闲置"):
        reset_to_clean(e, spec)   # 草稿/弹层残留 → 收拾干净
        time.sleep(1)
    if not _find(_nodes(e), "卖闲置"):
        from app.flow.ready import ensure_logged_in
        ensure_logged_in(e, "publish")   # 到不了首页:先判是否掉登录(是则升级 LoginRequired 触发冻结+通知)
        raise StepError("open_editor", "闲鱼首页不可见(卖闲置未找到)", e.save_shot("v2_miss_home"))
    e.tap_xy(*XY_SELL_TAB, settle=1.5)
    e.tap_xy(*XY_PUBLISH_ENTRY, settle=2.0)
    _discard_draft_if_any(e)
    _wait_editor_or_dismiss_perm(e, "未进入发布编辑页", "v2_miss_editor")
    # 残留草稿检测:闲鱼常无提示直接恢复上次草稿(描述已有内容/分类是旧的)。
    # 全新编辑页的描述是占位符;不是占位符=脏草稿,弃掉重进(07-26 实测脏草稿毒化分类)
    desc_node = _find(_nodes(e), "描述,")
    if desc_node and "描述一下" not in desc_node["desc"]:
        logger.info("v2 检测到残留草稿(描述非占位),弃掉重进")
        close = _find(_nodes(e), "关闭")
        if close:
            _tap_node(e, close, settle=1.0)
        _discard_draft_if_any(e)
        time.sleep(1.0)
        e.tap_xy(*XY_SELL_TAB, settle=1.5)
        e.tap_xy(*XY_PUBLISH_ENTRY, settle=2.0)
        _discard_draft_if_any(e)
        _wait_editor_or_dismiss_perm(e, "弃草稿后未进入发布编辑页", "v2_miss_editor2")


def step_images(e: Engine, spec: dict) -> None:
    imgs = spec.get("images") or []
    if not imgs:
        return
    # 防串图:开推前清空 gc 相册(上单一残留就会被「选最新 N 张」选中)
    try:
        cleared = e.t.clear_media(None)
        if cleared:
            logger.info("v2 选图前清残留 %s 张", cleared)
    except Exception as ex:
        logger.warning("v2 选图前清残留失败:%s", ex)
    pushed: list[str] = spec.setdefault("_pushed_media", [])
    for url in imgs:
        uri = e.t.push_media(url)
        if uri:
            pushed.append(uri)
        time.sleep(0.5)
    slot = _wait_node(e, "添加图片", timeout=5)
    if not slot:
        raise StepError("images", "编辑页无「添加图片」入口", e.save_shot("v2_img_slot"))
    _tap_node(e, slot, settle=2.5)
    # 选图器(原生):每张缩略图配 desc=选择 的框,点第一个=最新=刚推的
    for _ in range(len(imgs)):
        ok = e.tap_node_by_desc("选择", "images", index=0)
        time.sleep(0.5)
        if not ok:
            raise StepError("images", "选图器无「选择」节点(图没推进相册?)", e.save_shot("v2_picker"))
    nxt = _wait_node(e, "下一步", timeout=5)
    if not nxt:
        raise StepError("images", "选图器「下一步」未找到(选择未生效?)", e.save_shot("v2_picker_next"))
    _tap_node(e, nxt, settle=1.5)
    done = _wait_node(e, "完成", timeout=5)
    if not done:
        raise StepError("images", "选图器「完成」未找到", e.save_shot("v2_picker_done"))
    _tap_node(e, done, settle=2.0)
    _find_row(e, "价格", "images")   # 回编辑页校验(图+描述会把价格行顶到屏下,必须带滚动)


def _scroll_to_top(e: Engine) -> None:
    """编辑页滚回顶:step_images 结尾会把页面滑到底找价格行,「AI帮你写」滚出可见区后
    节点树里直接消失——找不到就静默不点(08-01 实测「AI 描述不触发」的主因)。"""
    for _ in range(3):
        e.t.swipe(540, 1100, 540, 1900, 400)
        time.sleep(0.7)
    time.sleep(1.0)


def _semantic_tap(e: Engine, node: dict, desc_candidates: list[str]) -> bool:
    """语义点击(performAction CLICK):闲鱼 Flutter 会过滤无障碍合成手势——tap_xy 点
    「AI帮你写/采用」这类链接无效(08-01 实测:手势点了没反应,手动点有效),
    performAction 走 performClick 可绕过(与定价键盘同原理)。按候选 desc 逐一尝试
    (闲鱼 desc 常带重复文案,如「AI帮你写, AI帮你写」),全不中退手势点节点中心。"""
    for d in desc_candidates:
        if e.t.node_click(d):
            return True
    _tap_node(e, node, settle=1.5)
    return False


def step_description(e: Engine, spec: dict) -> None:
    """方案 C:描述=闲鱼 AI 从图生成。两代闲鱼行为都兼容:
    - 老版(07-26 校准):点「AI帮你写」触发,文本直接进描述框;
    - 新版(08-01 实测):可能选图后自动生成,结果落在「自己写/采用」卡片——**不点「采用」
      描述框永远是占位符**。
    流程:滚回顶(AI帮你写 才在节点树里)→ 点它触发(节点不在=自动生成中,写明日志)
    → 等「采用」出现即点 或 描述框文本已变;两轮触发仍不出 → 种子文案兜底
    (assembler 保证非空);种子也无效 → 硬失败,不带空描述往后走。
    """
    if not spec.get("images"):
        return
    if _find(_nodes(e), "AI帮你重写"):
        pass  # 已生成(草稿/上一针),不重触发;描述正文 Flutter 读不到,用「AI帮你重写」判
    else:
        for attempt in range(2):
            _scroll_to_top(e)
            ai = _find(_nodes(e), "AI帮你写")
            if ai:
                how = "语义点击" if _semantic_tap(e, ai, ["AI帮你写, AI帮你写", "AI帮你写"]) else "手势兜底"
                logger.info("v2 已点「AI帮你写」触发(第 %d 轮,%s)", attempt + 1, how)
            else:
                logger.info("v2「AI帮你写」节点不可见(第 %d 轮):自动生成中或已生成,跳过手点",
                            attempt + 1)
            # 等生成完成:每秒查描述正文长度,长度>0 且连续 3 次一致=AI 写完(流式输出稳定)
            if _wait_desc_settled(e, int(spec.get("ai_desc_wait", 90))):
                break
            logger.warning("v2 AI 描述第 %d 轮未生成/未稳定", attempt + 1)
        else:
            # 两轮都没出:种子文案兜底。⚠️ 点描述框会拉起系统 IME 盖住下半屏,收尾必须收键盘。
            seed = (spec.get("description") or "").strip()
            logger.warning("v2 AI 描述两轮未生成,种子文案兜底(len=%d)", len(seed))
            injected = False
            if seed:
                dn = _find_desc_row(_nodes(e))
                if dn:
                    _tap_node(e, dn, settle=1.5)
                    # Flutter 描述框 set_text 常「未找到聚焦输入框」(08-01 实测)→ 先走 IME commit
                    # (与 1b 聊天回复同通道,需 gc 内置 IME 为默认),失败再退 set_text。
                    for how in ("ime", "set_text"):
                        try:
                            e.t.ime_commit(seed) if how == "ime" else e.t.set_text(seed)
                            logger.info("v2 种子描述注入成功(%s)", how)
                            injected = True
                            break
                        except Exception as ex:
                            logger.warning("v2 种子描述注入失败(%s):%s", how, ex)
                    done = _find(_nodes(e), "完成")
                    if done:
                        _tap_node(e, done, settle=1.2)
                    else:
                        e.t.key("BACK")   # 没收成编辑器「完成」键时,BACK 收 IME
                        time.sleep(0.8)
            # 描述正文 Flutter 读不到、无法回读校验 → 以注入是否成功为准(都失败才硬失败)
            if not injected:
                raise StepError("description", "AI 两轮未生成,种子兜底注入也失败(ime/set_text 均不可用)",
                                e.save_shot("v2_desc_empty"))
    # AI 属性(品牌/尺寸/成色/功能状态)自动勾选比描述慢几秒,没选齐「发布」点了没反应(07-26 实测)
    time.sleep(8)


def step_ai_rewrite(e: Engine, spec: dict) -> None:
    if not spec.get("ai_rewrite"):
        return
    # 只点「采用」采纳已生成内容;触发「AI帮你写」已在 step_description 做过,
    # 再点会重新生成、反而把已写好的冲掉。链接怕手势过滤,语义点击优先。
    hit = _find(_nodes(e), "采用")
    if hit:
        _semantic_tap(e, hit, ["采用", "采用, 采用"])


def _find_desc_row(ns: list[dict]) -> dict | None:
    """描述行节点:先「描述,」前缀(占位/老版);退化用 AI 锚点上方最近的长文本块
    (新版已填状态:节点 desc 可能不再带「描述,」前缀——08-01「未找到描述行」的根因)。"""
    hit = _find(ns, "描述,")
    if hit:
        return hit
    anchor = _find(ns, "AI帮你写") or _find(ns, "AI帮你重写") or _find(ns, "AI生成仅供参考")
    if not anchor:
        return None
    ay = anchor["center"][1]
    best, best_dy = None, ay
    for n in ns:
        d = (n.get("desc") or "")
        if len(d) < 8 or n["center"][1] >= ay:
            continue
        if d.startswith(("发闲置", "存草稿", "发布", "关闭", "草稿箱")):
            continue
        dy = ay - n["center"][1]
        if dy < best_dy:
            best, best_dy = n, dy
    return best


def _desc_body(ns: list[dict]) -> str:
    """描述框当前正文(去「描述,」前缀,占位符视作空)。AI 流式生成时按其长度变化判进度。
    新版闲鱼生成后描述节点 desc 不再带「描述,」前缀(08-01:旧判定 _find(ns,"描述,") 因此
    读不到、误判「未生成」重复触发致 FAILED)——这里统一走 _find_desc_row 退化定位。"""
    dn = _find_desc_row(ns)
    if not dn:
        return ""
    d = (dn.get("desc") or "")
    body = d[len("描述,"):] if d.startswith("描述,") else d
    body = body.strip()
    return "" if (not body or "描述一下" in body) else body


def _wait_desc_settled(e: Engine, timeout: float, stable_needed: int = 3) -> bool:
    """等 AI 描述生成完成:每秒取描述正文长度,长度>0 且连续 stable_needed 次不变=写完。
    AI 是流式输出,长度不再增长才算结束——比「有正文就走」稳,避免写到一半就往下。
    「采用」卡片模式先采纳再计长度。超时未稳定返回 False。"""
    deadline = time.time() + timeout
    last, stable = -1, 0
    while time.time() < deadline:
        ns = _nodes(e)
        adopt = _find(ns, "采用")
        if adopt:
            # 新版:采纳 AI 卡片 → 文本进描述框、属性开始自动勾选(链接怕手势过滤,语义点击)
            _semantic_tap(e, adopt, ["采用", "采用, 采用"])
            last, stable = -1, 0
            time.sleep(1.0)
            continue
        # 主信号:生成完成后「AI帮你写」→「AI帮你重写」。新版描述正文 Flutter 渲染、无障碍读不到
        # 文本(08-01 真机:content-desc/text 全空)→ 长度判定失效,靠这个可读的链接节点判完成。
        if _find(ns, "AI帮你重写"):
            logger.info("v2 AI 描述已生成(「AI帮你重写」出现)")
            return True
        n = len(_desc_body(ns))
        if n > 0 and n == last:
            stable += 1
            if stable >= stable_needed:
                logger.info("v2 AI 描述已稳定(len=%d,连续 %d 次一致),视为生成结束", n, stable_needed)
                return True
        else:
            stable = 0
        last = n
        time.sleep(1.0)
    return False


def _wait_keypad(e: Engine, step: str, timeout: float = 6) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _keypad_up(e):
            return
        time.sleep(0.5)
    raise StepError(step, "数字键盘未弹起", e.save_shot(f"v2_kp_{step}"))


def _keypad_confirm(e: Engine, step: str) -> None:
    """键盘黄色「确定」:接受合成触摸(2026-07-26 实测;数字键才被过滤)。点完等键盘收。"""
    ns = _nodes(e)
    ok = _find(ns, "确定")
    if not ok:
        raise StepError(step, "键盘「确定」节点未找到", e.save_shot(f"v2_kp_ok_{step}"))
    _tap_node(e, ok, settle=1.2)
    deadline = time.time() + 5
    while time.time() < deadline:
        if not _keypad_up(e):
            return
        time.sleep(0.5)
    raise StepError(step, "键盘「确定」后键盘未收", e.save_shot(f"v2_kp_close_{step}"))


def _type_amount(e: Engine, value, step: str, focus_xy: tuple[int, int] | None = None) -> None:
    """把金额写进数字键盘的输入框。健壮三级(治 #1「价格框没获得焦点 → set_text 找不到可聚焦输入框」):
      ① set_text 直写(键盘弹起时输入框应已聚焦,原生 EditText 可整段覆盖);
      ② 失败 → tap 金额编辑区重新聚焦、确认键盘仍在,再 set_text;
      ③ 仍失败 → IME 注入兜底(gc IME 为默认时可写原生 EditText,与描述框同通道)。
    三级都不行才硬失败。"""
    s = str(int(value))
    try:
        e.t.set_text(s)
        return
    except Exception as ex1:
        logger.warning("v2 %s set_text 首次失败(%s),tap 聚焦后重试", step, ex1)
    if focus_xy:
        e.tap_xy(*focus_xy, settle=1.0)
        _wait_keypad(e, step, timeout=4)
        try:
            e.t.set_text(s)
            return
        except Exception as ex2:
            logger.warning("v2 %s 聚焦后 set_text 仍失败(%s),OCR 兜底聚焦", step, ex2)
    # OCR 兜底聚焦:固定坐标没点中(布局漂移)→ OCR 找金额编辑区点一下再写
    if _ocr_tap(e, ["请输入价格", "输入价格", "价格", "请输入", "¥"], step=step):
        try:
            _wait_keypad(e, step, timeout=4)
            e.t.set_text(s)
            return
        except Exception as ex_ocr:
            logger.warning("v2 %s OCR 聚焦后 set_text 仍失败(%s),尝试 IME 注入兜底", step, ex_ocr)
    try:
        e.t.ime_commit(s)
    except Exception as ex3:
        raise StepError(step, f"金额写入失败(set_text/聚焦重试/OCR聚焦/IME 均不可用):{ex3}",
                        e.save_shot(f"v2_{step}_set"))


def _scroll_to_bottom(e: Engine) -> None:
    """编辑页滚到底:行位置变为底部锚定的固定值(机型单一/锁版,2026-07-26 校准)。
    底部锚定布局(1080x2400):所在位置≈2160,发货方式≈2004,闲鱼币抵扣≈1836,价格≈1704。
    滚完必须等回弹停稳再点,否则点在未停稳的内容上(07-26 实测误点率最高的环节)。"""
    for _ in range(3):
        e.t.swipe(540, 1900, 540, 900, 350)
        time.sleep(0.7)
    time.sleep(1.5)


def _tap_row_verified(e: Engine, step: str, row_prefix: str, y: int, check):
    """点行并验证目标面板出现。坑(08-01 真机):①行 y 随布局漂移;②右侧(x≈800)才是「¥ >」可点区;
    ③页面常有多个同名节点(顶部提示 + 底部设置行)→ 取**最下方**那个(价格/发货/位置设置行都在
    编辑页底部,顶部同名的是提示如 AI 定价参考)。先等最下方节点 y 停稳,再点 (800, 稳定y)。"""
    def _bottom(ns):
        ms = [n for n in ns if (n.get("desc") or "").startswith(row_prefix)]
        return max(ms, key=lambda n: n["center"][1]) if ms else None
    row, last = None, None
    for _ in range(8):
        row = _bottom(_nodes(e))
        cy = row["center"][1] if row else None
        if cy is not None and cy == last:
            break
        last = cy
        time.sleep(0.6)
    ns = _nodes(e)
    allm = [n["center"] for n in ns if (n.get("desc") or "").startswith(row_prefix)]
    anchors = [k for k in ("添加图片", "发货方式", "价格", "描述,", "完成", "定价", "所在位置") if _find(ns, k)]
    cx = row["center"][0] if row else 540
    cy = row["center"][1] if row else y
    logger.info("v2 rowtap[%s] 「%s」全部=%s 取最下=(%s,%s) 固定y=%d 锚点=%s", step, row_prefix, allm, cx, cy, y, anchors)
    for tx, ty, how in [(800, cy, "右侧"), (cx, cy, "行心"), (800, y, "固定y")]:
        e.tap_xy(tx, ty, settle=2.0)
        if check():
            return
        ns2 = _nodes(e)
        # 部分机型/版本点「价格」行先弹「定价/确定/取消」气泡而不是直接开面板(08-05 真机,
        # 古代蹦迪的皇冠海星机):补点「定价」再验一次。check 已过(panel 大开)时不会走到这。
        if step == "price":
            via = _find(ns2, "定价")
            if via:
                _tap_node(e, via, settle=1.5)
                if check():
                    return
                ns2 = _nodes(e)
        popup = [k for k in ("定价", "确定", "请输入", "取消", "邮寄", "包邮", "运费") if _find(ns2, k)]
        logger.info("v2 rowtap[%s] %s(%d,%d) 未开面板;弹出=%s", step, how, tx, ty, popup)
    raise StepError(step, "行点击均未打开目标面板", e.save_shot(f"v2_rowtap_{step}"))


def step_price(e: Engine, spec: dict) -> None:
    price = spec.get("price")
    if price is None:
        return
    # 描述刚生成、页面干净,直接滚动点行。
    _scroll_to_bottom(e)
    # 校验放宽:面板开(定价节点在)或键盘弹起都算开——部分机型面板大开但键盘不自动弹
    # (08-06 奶酪机实测:截图面板已开、无键盘,被判"未开面板"误失败)。
    _tap_row_verified(e, "price", "价格", 1704,
                      lambda: _keypad_up(e) or _find(_nodes(e), "定价") is not None)
    # 键盘未自动弹的变体:点 ¥金额编辑区(1080x2400 校准:金额/铅笔位)聚焦,等键盘起再写
    if not _keypad_up(e):
        e.tap_xy(540, 1218, settle=1.5)
        _wait_keypad(e, "price")
    _type_amount(e, price, "price", focus_xy=(540, 1218))
    _keypad_confirm(e, "price")
    # 定价**面板本体**还要再点一次「确定」才提交回编辑页——键盘确定只收键盘不关面板,
    # 且面板开着时「价格设置」行不可见(2026-07-26 实测:面板大开却被判 price 通过,
    # 后续步骤全在面板上空滑)。
    ok = _wait_node(e, "确定", timeout=3)
    if ok:
        _tap_node(e, ok, settle=1.5)
        _wait_gone(e, "定价", timeout=5)
    # 节点校验:面板必须已关(定价标题消失)且价格行可见。
    # ⚠️ 价格行节点 desc 是静态的「价格设置」,**不含金额**(2026-07-26 实测:屏上明明 ¥200,desc 无值),
    # 金额最终由发布回读/在卖卡片价格兜底(list_cards 带 price),这里只验「面板关了、行在」。
    ns = _nodes(e)
    if _find(ns, "定价"):
        raise StepError("price", "定价面板未关闭", e.save_shot("v2_price_panel"))
    if not _find(ns, "价格"):
        raise StepError("price", "价格行不可见(面板状态异常?)", e.save_shot("v2_price_verify"))


def step_shipping(e: Engine, spec: dict) -> None:
    sp = spec.get("shipping") or {}
    mode = sp.get("mode", "fixed_fee")
    # 发货面板选项不是语义节点(07-26 实测节点树搜不到),用固定坐标(1080x2400 校准,机型单一/锁版)
    anchor_xy = {"free": (300, 1170), "by_distance": (300, 1320),
                 "fixed_fee": (300, 1464), "no_ship": (300, 1596)}.get(mode)
    if not anchor_xy:
        raise StepError("shipping", f"未知发货方式 mode={mode}")
    _scroll_to_bottom(e)
    _tap_row_verified(e, "shipping", "发货方式", 2004,
                      lambda: _wait_node(e, "邮寄", timeout=2) is not None)
    e.tap_xy(*anchor_xy, settle=1.5)
    if mode == "fixed_fee":
        # 选中后焦点自动进邮费框、键盘自动弹起。邮费框是独立窗口原生 EditText → set_text 直写;
        # 数字键被键盘过滤勿逐位点;键盘「确定」可合成触摸提交。(2026-07-26 探针实证)
        _wait_keypad(e, "shipping")
        fee_val = int(sp.get("fixed_fee", 0))
        _type_amount(e, fee_val, "shipping")
        _keypad_confirm(e, "shipping")
    if sp.get("self_pickup"):
        # 「买家自提」开关也不一定是节点;全新编辑页默认关,盲点一次即开(每次都从干净草稿起步,状态确定)
        e.tap_xy(930, 1764, settle=0.8)
    # 面板「确定」关闭(键盘已收时是底部大黄钮):节点优先,固定坐标兜底
    ok = _wait_node(e, "确定", timeout=5)
    if ok:
        _tap_node(e, ok, settle=1.5)
    else:
        e.tap_xy(540, 2230, settle=1.5)
    # 节点校验:发货方式行 desc 应变「发货方式\n运费¥12.00/自提」(free 为「包邮」)
    expect = "包邮" if mode == "free" else "运费"
    ns = _nodes(e)
    row = _find(ns, "发货方式")
    fee_str = str(int(sp.get("fixed_fee", 0)))
    if not row or expect not in row["desc"]:
        raise StepError("shipping", f"发货方式校验失败(行={(row or {}).get('desc')!r},期望含「{expect}」)",
                        e.save_shot("v2_ship_verify"))
    if mode == "fixed_fee" and fee_str not in row["desc"].replace(",", ""):
        raise StepError("shipping", f"邮费校验失败(行={row['desc']!r},期望含 {fee_str})",
                        e.save_shot("v2_fee_verify"))


def step_attributes(e: Engine, spec: dict) -> None:
    """按 spec.attrs 补齐属性 chips(分类/品牌/型号/屏幕尺寸/成色/功能状态)。

     chips 是 Flutter 渲染、节点树不可见——**此处按老板许可使用 OCR 一次性定位**
    (全流程唯一 OCR 点)。已选中的 chip 用像素色检测(黄底)跳过,不重复点(会反选)。
    spec.attrs 例:{"分类":"显示器","品牌":"AOC","型号":"P25M2S","屏幕尺寸":"26.1-28英寸",
    "成色":"轻微使用痕迹","功能状态":"功能完好无维修"}。ERP 组装侧按 SKU 数据填。
    注意:显示器类目的「型号」是闲鱼**必填**且候选项多、AI 自动选不了——不选点「发布」
    静默不响应(08-31 TEST-014/015 全页截图实锤)。
    """
    attrs = spec.get("attrs") or {}
    if not attrs:
        return
    import cv2
    import numpy as np
    from app.flow import ocr as O

    def chip_selected(center) -> bool:
        data = e.t.screencap()
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        x, y = int(center[0]), int(center[1])
        patch = img[max(0, y - 8):y + 9, max(0, x - 8):x + 9]
        r, g, b = (int(patch[:, :, i].mean()) for i in (2, 1, 0))
        return r > 200 and g > 170 and b < 130   # 黄底=已选

    for label, key in (("分类", "分类"), ("品牌", "品牌"), ("型号", "型号"),
                       ("屏幕尺寸", "屏幕尺寸"), ("成色", "成色"), ("功能状态", "功能状态")):
        value = attrs.get(key)
        if not value:
            continue
        # chips 行可横向滚动,目标可能在屏外:先按短键找,找不到左滑该行再找(最多 3 次)
        short = value[:4]
        for slide in range(4):
            items = e.read()
            lab = O.find(items, label)
            val = O.find(items, value) or O.find(items, short)
            # 行约束优先;label 缺失/合并时也放行(value 文案本身够独特,如「功能完好无维修」)
            if val and (not lab or abs(lab["center"][1] - val["center"][1]) <= 70):
                break
            if slide < 3:
                if lab:
                    # label 在、目标 chip 不在:该行横向滑出更多选项
                    e.t.swipe(900, lab["center"][1], 300, lab["center"][1], 300)
                else:
                    # 整行不在屏内(被顶到折叠下,如属性区被描述编辑器顶开):下滚一点再找
                    e.t.swipe(540, 1700, 540, 1200, 350)
                time.sleep(0.8)
        else:
            # 调试留证:把当时的 OCR 全量识别项打进日志(「功能状态」多次定位失败的排查)
            texts = " | ".join(it["text"] for it in items[:40])
            logger.info("v2 属性「%s=%s」未定位到(行/chip 缺),跳过。OCR全量: %s", label, value, texts)
            continue
        if chip_selected(val["center"]):
            logger.info("v2 属性「%s=%s」已选中,跳过", label, value)
            continue
        logger.info("v2 点属性 chip:「%s=%s」", label, value)
        e.tap_xy(*val["center"], settle=0.8)

    # ---- 「型号」兜底(老板拍板 08-31) ----
    # 显示器等类目「型号」必填,而 AI 候选常不含真实型号(attrs 匹配不上/没给型号就永远空着),
    # 空着点「发布」静默不推进(TEST-014/015 实锤)。该行一个都没选 → 默认选第一个 chip。
    lab = None
    for _ in range(3):
        items = e.read()
        lab = O.find(items, "型号")
        if lab:
            break
        e.t.swipe(540, 1700, 540, 1200, 350)   # 行可能在屏外,下滚找
        time.sleep(0.8)
    if not lab:
        return   # 该类目没有型号行,不管
    ly, lx = lab["center"]
    chips = [it for it in items
             if abs(it["center"][1] - ly) <= 70 and it["center"][0] > lx + 40
             and it["text"].strip() != "型号"]
    chips.sort(key=lambda it: it["center"][0])
    if not chips:
        return
    for c in chips:
        if chip_selected(c["center"]):
            return   # 已有选中(attrs 点的或 AI 自动选的),不动
    logger.info("v2 型号行无选中项,兜底选第一个 chip:「%s」", chips[0]["text"])
    e.tap_xy(*chips[0]["center"], settle=0.8)


def step_location(e: Engine, spec: dict) -> None:
    if spec.get("location"):
        raise StepError("location", "指定位置流程待实现", e.save_shot("v2_todo_location"))


def step_worry_free(e: Engine, spec: dict) -> None:
    """无忧卖弹窗在点「发布」之后出现,处理在 step_publish 的发布后循环;此步占位。"""


_QR_SIGNS = ("请勿上传含二维码", "含二维码", "二维码的图片")
_QR_MASK_BTN = "一键打码"


def _ocr_items_safe(e: Engine) -> list[dict]:
    """OCR 读屏;读失败返回空表(RiskHit 照常抛出触发风控熔断,不吞)。"""
    try:
        return e.read()
    except RiskHit:
        raise
    except Exception:
        logger.warning("v2 OCR 读屏失败", exc_info=True)
        return []


def _ocr_tap(e: Engine, texts, step: str = "", settle: float = 1.5) -> bool:
    """OCR 兜底点击:节点/set_text 找不到目标时,用 OCR 在屏上找任一 text,命中即点其中心。
    返回是否点到。(通用兜底原则:节点读不到 → OCR 找按钮位置点。)"""
    items = _ocr_items_safe(e)
    for t in ([texts] if isinstance(texts, str) else texts):
        hit = O.find(items, t)
        if hit:
            e.tap_xy(hit["center"][0], hit["center"][1], settle=settle)
            if step:
                logger.info("v2 %s OCR 兜底点「%s」@%s", step, t, hit["center"])
            return True
    return False


def _qr_banner_present(e: Engine, use_ocr: bool = True) -> bool:
    """闲鱼「请勿上传含二维码…」横幅在不在。节点优先;use_ocr 时读不到再 OCR 兜底。"""
    if any(_find(_nodes(e), s) for s in _QR_SIGNS):
        return True
    if not use_ocr:
        return False
    return any(O.find(_ocr_items_safe(e), s) for s in _QR_SIGNS)


def _dismiss_qrcode_block(e: Engine, use_ocr: bool = True) -> bool:
    """图片含二维码/条码 → 闲鱼顶部红字拦发布 + 给「一键打码」按钮,不处理点「发布」静默不推进
    (2026-08-13 实测,仓库带条码的包装箱/标签照常触发)。→ 自动点「一键打码」给码区打码,
    等横幅消失后返回 True 让上层重试发布;无横幅返回 False。"""
    if not _qr_banner_present(e, use_ocr=use_ocr):
        return False
    btn = _find(_nodes(e), _QR_MASK_BTN, clickable=True) or _find(_nodes(e), _QR_MASK_BTN)
    if btn:
        _tap_node(e, btn, settle=2.5)
        logger.info("v2 图片含二维码 → 点「一键打码」(节点)")
    else:
        hit = O.find(_ocr_items_safe(e), _QR_MASK_BTN)
        if not hit:
            logger.warning("v2 检到含二维码横幅,但找不到「一键打码」按钮,无法自动处理")
            return False
        e.tap_xy(hit["center"][0], hit["center"][1], settle=2.5)
        logger.info("v2 图片含二维码 → 点「一键打码」(OCR)")
    # 等闲鱼给码区打码完成:横幅消失(节点判,最多 ~12s;节点读不到则靠上层重试再 OCR 复检)
    deadline = time.time() + 12
    while time.time() < deadline:
        if not _qr_banner_present(e, use_ocr=False):
            logger.info("v2 一键打码完成,二维码横幅已消失,重试发布")
            return True
        time.sleep(1.0)
    logger.warning("v2 一键打码后横幅仍在(12s),仍继续尝试发布")
    return True


def step_publish(e: Engine, spec: dict) -> None:
    if not spec.get("confirm_publish"):
        return

    def _editor_present() -> bool:
        ns = _nodes(e)
        return (_find(ns, "添加图片") or _find(ns, "描述,")
                or _find(ns, "发货方式") or _find(ns, "价格")) is not None

    # 「添加图片」节点加图后就被缩略图替代,不能当编辑页判据(07-26 误判「已推进」,实际没点动)。
    # 发布按钮 tap 最多 3 次,每次以编辑页真正消失为准。
    _dismiss_qrcode_block(e, use_ocr=False)   # 发布前:图片含二维码会静默拦发布,先节点侧快检+一键打码
    # 描述编辑器残留(顶栏有「完成/主题」)会盖住编辑页,「发布」点了不响应(08-30 TEST-012)——先收掉
    done = _find(_nodes(e), "完成")
    if done:
        logger.info("v2 publish:发现描述编辑器残留(「完成」在场),先语义点击收编")
        _semantic_tap(e, done, ["完成"])
        time.sleep(1.0)
        if _find(_nodes(e), "完成"):
            e.t.key("BACK")
            time.sleep(0.8)
    advanced = False
    for attempt in range(3):
        ns = _nodes(e)
        btn = _find(ns, "发布", clickable=True) or _find(ns, "发布")   # 「发布, 发布」前缀命中
        # 编辑页「发布」按钮恒在顶栏(y≈167/2400)。y>400 的「发布」前缀节点是正文/描述里的
        # 文字(如 AI 文案含「发布」),点了只会把光标移进描述栏(08-30 实测误点),不算按钮。
        if btn and btn["center"][1] > 400:
            logger.info("v2 publish 第%d次:忽略顶栏外「发布」节点@%s(非按钮)", attempt + 1, btn["center"])
            btn = None
        # 诊断:发布前页面状态(IME 残留 / 必填属性提示 / 发布按钮位置)
        hints = [k for k in ("完成", "主题", "请完善", "请选择", "请填写", "必填") if _find(ns, k)]
        logger.info("v2 publish 第%d次:发布按钮=%s 提示=%s", attempt + 1, (btn or {}).get("center"), hints)
        # 「发布, 发布」链接可能与「AI帮你写」同样被 Flutter 手势过滤 → 语义点击优先,手势兜底;
        # 节点完全读不到 → 固定坐标点顶栏右上黄钮(实测位,见 XY_PUBLISH_BTN 注释),不再 OCR 定位。
        if btn:
            _semantic_tap(e, btn, ["发布, 发布", "发布"])
            # performAction 可能假成功:返回 true 但没真正触发 Flutter onTap(08-31 TEST-016 实锤:
            # 属性/价格/运费全齐,三次语义点击编辑页纹丝不动)。2s 没动静补一记物理点——
            # 此刻编辑器还在(没收成才会走到这),(975,167) 就是发布钮本身,安全。
            time.sleep(2.0)
            if _editor_present():
                logger.info("v2 publish 第%d次:语义点击未生效,补物理点@%s", attempt + 1, XY_PUBLISH_BTN)
                e.tap_xy(*XY_PUBLISH_BTN, settle=1.0)
        else:
            # 盲点前守卫+留证:不在编辑页时禁止盲点固定坐标——(975,167) 落在别的页面就是
            # 别人的按钮(08-30:疑似流程中断后点到消息页右上角,落到「消息设置」页,无现场可查)。
            shot = e.save_shot(f"v2_pub_try{attempt + 1}")
            if not _editor_present():
                raise StepError("publish", "点发布前已不在编辑页(前置步骤中断/被弹窗带走),拒绝盲点固定坐标",
                                shot)
            logger.info("v2 publish 第%d次:按钮节点未读到,固定坐标点发布@%s 证据=%s",
                        attempt + 1, XY_PUBLISH_BTN, shot)
            e.tap_xy(*XY_PUBLISH_BTN, settle=1.5)
        deadline = time.time() + 8
        while time.time() < deadline:
            if not _editor_present():
                advanced = True
                break
            time.sleep(0.6)
        if advanced:
            break
        nsa = _nodes(e)
        # 硬拦弹窗:闲鱼「无法发布宝贝,运费最高500元」等——明确失败,别拖成模糊 UNCERTAIN(08-01 实测运费999)
        if any(("无法发布" in (n.get("desc") or "")) or ("运费最高" in (n.get("desc") or "")) for n in nsa):
            raise StepError("publish", "闲鱼拒发(无法发布/运费超限,检查 spec.shipping.fixed_fee≤500)",
                            e.save_shot("v2_pub_rejected"))
        after = [k for k in ("请完善", "请选择", "请填写", "必填", "继续发布", "仍要发布", "无忧卖", "验货宝") if _find(nsa, k)]
        logger.info("v2 publish 第%d次未推进;弹出=%s", attempt + 1, after)
        if _dismiss_qrcode_block(e):   # 未推进多半是图片含二维码横幅拦住 → 打码后重试发布
            continue
        # 未推进:出现任一确认/成功类弹窗 = 已越过编辑页,交给下面 30s 处理循环;
        # 节点读不到再 OCR 兜底复检(老板要求)。
        confirm_kw = ("继续发布", "仍要发布", "确认发布", "立即发布", "无忧卖", "验货宝", "立即托管", "发布成功", "再发一件")
        if any(_find(nsa, k) for k in confirm_kw) or \
           any(O.find(_ocr_items_safe(e), k) for k in ("继续发布", "仍要发布", "确认发布", "立即发布", "发布成功")):
            advanced = True
            break
    if not advanced:
        # 全页留证:未推进多半是某必填项没选(08-31 TEST-014 帧见「型号」未选),但编辑器
        # 一屏看不全——滚一遍各截一帧,每个属性行的选中态都可复盘
        _scroll_to_top(e)
        shots = [e.save_shot("v2_pub_no_advance_top")]
        for i in range(2):
            _scroll_down(e)
            shots.append(e.save_shot(f"v2_pub_no_advance_{i + 1}"))
        raise StepError("publish", "点「发布」后编辑页未推进(按钮未响应或必填属性未选齐,全页截图见 shots)",
                        shots[0])
    deadline = time.time() + 30
    while time.time() < deadline:
        ns = _nodes(e)
        descs = [n.get("desc") or "" for n in ns]
        _has = lambda kw: any(kw in d for d in descs)
        # 成功锚点:①发布成功/再发一件;②发布成功后必弹的「托管无忧卖」推广弹窗。
        # ⚠️ 08-01 真机实测:弹窗里**可读**的 desc 是「立即托管」「N 天内卖出」「概率将在」+ 商品标题,
        # 而「托管无忧卖」「恭喜商品可…」横幅是 Flutter 图读不到——务必用前者当锚点。
        if (_has("发布成功") or _has("再发一件") or _has("立即托管")
                or _has("天内卖出") or _has("概率将在")):
            if spec.get("worry_free_sell"):
                inst = _find(ns, "立即托管")
                if inst:
                    _tap_node(e, inst, settle=1.5)   # 开无忧卖(worry_free_sell=true)
            return
        join = _find(ns, "加入无忧卖") or _find(ns, "立即加入") or _find(ns, "一键加入")
        skip = _find(ns, "暂不加入") or _find(ns, "暂不") or _find(ns, "以后再说") or _find(ns, "直接发布")
        cont = _find(ns, "继续发布") or _find(ns, "仍要发布") or _find(ns, "确认发布")
        if _find(ns, "无忧卖") or _find(ns, "验货宝"):
            act = join if spec.get("worry_free_sell") else skip
            if act:
                _tap_node(e, act, settle=1.5)
                continue
            # 新版(08-01 实测):发布成功后的「托管无忧卖」推广弹窗只有「立即托管」+ 关闭 X,
            # join/skip 模式都不命中——弹窗本身就是发布成功锚点(只有发成了才会弹):
            # 要加入就点「立即托管」,否则 BACK 关掉弹窗按成功收尾(回读在卖列表做终验)。
            instant = _find(ns, "立即托管")
            if instant:
                if spec.get("worry_free_sell"):
                    _tap_node(e, instant, settle=1.5)
                    continue
                e.t.key("BACK")
                time.sleep(1.0)
                return
        if cont:
            _tap_node(e, cont, settle=1.5)
            continue
        # 节点没读到二次确认按钮 → OCR 兜底找位置点(老板要求)
        if _ocr_tap(e, ["继续发布", "仍要发布", "确认发布", "立即发布"], step="publish"):
            continue
        # 待上架(未开通支付宝收款):宝贝已提交,不是失败;干净退出
        if _find(ns, "还差最后一步") or _find(ns, "开通支付宝收款") or _find(ns, "待上架"):
            spec["_publish_outcome"] = "PENDING_PAYMENT_AUTH"
            e.t.key("BACK")
            time.sleep(1.0)
            leave = _find(_nodes(e), "狠心离开") or _find(_nodes(e), "确认退出")
            if leave:
                _tap_node(e, leave, settle=1.0)
            return
        # 已回首页:发布多半已完成(成功页一闪而过)
        if _find(ns, "卖闲置"):
            return
        time.sleep(1.0)
    logger.warning("v2 发布后 30s 未捕获成功锚点,按 UNCERTAIN 交给对账")
    raise StepError("publish", "发布后 30s 未确认成功(UNCERTAIN:可能已发布,勿盲重发)",
                    e.save_shot("v2_pub_uncertain"))


STEPS = [
    ("open_editor", step_open_editor),
    ("images", step_images),
    ("description", step_description),
    ("ai_rewrite", step_ai_rewrite),
    ("attributes", step_attributes),
    ("price", step_price),
    ("shipping", step_shipping),
    ("location", step_location),
    ("worry_free_sell", step_worry_free),
    ("publish", step_publish),
]


def _readback_title(e: Engine) -> str | None:
    """发布后回在卖列表读刚上架商品标题(强锚)。节点驱动,失败不致命。"""
    try:
        from app.flow.delist_flow import list_cards, open_my_published, select_tab
        open_my_published(e)
        select_tab(e, "在卖", "readback")
        cards = list_cards(e)
        if not cards:
            logger.warning("v2 回读标题:在卖列表为空")
            return None
        title = cards[0]["title"]
        logger.info("v2 回读标题:%s", title)
        return title
    except Exception as ex:
        logger.warning("v2 回读标题失败(不影响发布结果):%s", ex)
        return None


def run_publish_v2(transport, spec: dict, shot_sink=None) -> dict:
    e = Engine(transport, shot_sink=shot_sink)
    result = e.run(STEPS, spec)
    # 回读在卖列表首条标题(强锚,原生可读):真标题落 result["title"] → 账本 Listing.title,
    # 是售出检测(整标题匹配)与下架/改价定位的依据。2026-08-31 起标题不再注入 #NNNN 短编码,
    # UNCERTAIN 不再能靠前缀翻正——读不回就保持原判,交人工/下轮对账,勿盲重发。
    title = None
    if result.get("ok") or result.get("failed_step") == "publish":
        title = _readback_title(e)
    result["publish_outcome"] = spec.get("_publish_outcome") or ("SUBMITTED" if result.get("ok") else None)
    if title:
        result["title"] = title
    try:
        reset_to_clean(e, spec)
    except Exception as ex:
        # 复位失败不该把已经成功的发布判成失败(残留由下一单 open_editor 自愈)
        logger.warning("v2 复位异常(不影响本单结果):%s", ex)
    return result
