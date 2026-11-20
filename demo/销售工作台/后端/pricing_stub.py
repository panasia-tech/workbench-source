"""大库图库三栏筛选 + 闲鱼爬虫原始快照与 V1 五重价格清洗引擎 + 商业闭环演示接口。

核心业务闭环（严格两步，绝无「员工提审 → 主管审批 / 重新审批」）：
1. 图片逻辑（查大库图库 + 电脑洗一轮分两波 + 已选定栏 = 三栏制）：
   - 按 SPU「品牌 + 型号」检索抓取好的大库图库（product-image-service），结合本件验货实拍图；
   - 电脑自动完成第一轮清洗（解码安全、分辨率 ≥400px、SHA-256/pHash 去重、型号置信度分档、去水印海报字、长宽比过滤），
     自动分成两波：
     * 第 1 栏「推荐可使用」（通过初筛的实拍图 + 高置信干净同款图）
     * 第 2 栏「不推荐使用」（带水印/促销字、近邻型号模糊、低清小图、长图截图、本件瑕疵留底照，附明确拦截原因，支持人工移入推荐或破格选用）
     * 第 3 栏「已经被选定的图片」（按闲鱼店铺分组，首图与单张均互不重复，选几张即可直接上架）
2. 价格逻辑（复刻第 1 版 xianyu-seller-pilot v0.2.0 缜密爬取与五重筛选）：
   - 按品类搜索策略（显示器双词拆分、净化器组合词、通用品牌+型号）抓取闲鱼搜索页原始快照并跨词 URL/itemId 去重；
   - 原地展示闲鱼当时搜出来的全部卡片（非目标商品在快照上加斜纹遮罩 +「非目标商品」角标 + 剔除代码）；
   - 机器按 V1 五重优先级筛选：
     1) blacklist（回收/求购/坏屏/故障/尸体/拆机/底座/支架/风嘴/滤芯/空盒/定金/补差）
     2) relevance（非目标型号：标题未匹配目标型号/别称）
     3) below_spu_min_price / above_spu_max_price（SPU 挂牌价上下限围栏）
     4) low_price（存在 ≥100 元有效样本时剔除 <100 元引流诱饵价）
     5) over_maximum（剔除 >100,000 元防拍占位价）
   - 预先算好「清洗后平均挂牌价（cleaned_average，主推）」、中位价、最低/最高价、离散度与采购价 5 档对比；
   - 员工只需三选一：【确认】、【修改（点卡片恢复/剔除实时重算均价，或直接改售价）】、【作废重新爬（支持微调检索词/屏蔽词/价格围栏）】→ 直接上架！
"""
from __future__ import annotations

import copy
import html
import math
import re
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from app.deps import get_current_user
from pilot_v020_engine import (
    apply_v020_spu_policy_patch,
    compute_v020_candidate_preview_and_logs,
    enrich_spu_policy,
    generate_ai_correction,
    generate_web_evidence,
    get_category_search_modes,
    record_wms_writeback,
    render_authentic_goofish_dom_snapshot,
    save_category_search_modes,
)
from spec_baseline_engine import evaluate_monitor_pricing

router = APIRouter(tags=["大库图库三栏与闲鱼快照核价直发（演示）"])

_CTX: dict[str, Any] = {"Session": None, "IDS": None}

# ------------------------------------------------------------------ V1 xianyu-seller-pilot 默认全局屏蔽词库
DEFAULT_BLACKLIST_TERMS: tuple[str, ...] = (
    "回收", "高价收", "求购", "寻购", "收购",
    "坏屏", "碎屏", "漏液", "花屏", "亮线", "不开机", "主板故障", "进水", "尸体", "维修", "故障机", "拆机件",
    "仅底座", "仅支架", "电源线", "适配器", "遥控器", "风嘴", "滤网", "滤芯", "包装盒", "空盒", "说明书", "保护壳",
    "定金", "邮费补差", "专拍链接", "勿拍", "出租", "租赁",
)

REJECTION_LABELS: dict[str, str] = {
    "blacklist": "屏蔽词命中",
    "relevance": "非目标型号",
    "below_spu_min_price": "低于SPU挂牌下限",
    "above_spu_max_price": "高于SPU挂牌上限",
    "low_price": "<100元引流价",
    "over_maximum": "防拍异常占位价",
    "manual_exclude": "人工剔除",
}

TIER_THRESHOLDS: dict[str, float] = {
    "strict": 0.72,
    "balanced": 0.62,
    "broad": 0.55,
}


def init(SessionDemo, IDS):
    _CTX["Session"], _CTX["IDS"] = SessionDemo, IDS
    reset_state()


def _db() -> Session:
    return _CTX["Session"]()


def _money(v) -> float:
    return round(float(v or 0), 2)


def _int_yuan(v) -> int:
    return int(round(float(v or 0)))


def _median(vals: list[float]) -> float | None:
    if not vals:
        return None
    s = sorted(vals)
    n = len(s)
    mid = n // 2
    return round(s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2, 2)


def _compact(text: str) -> str:
    return re.sub(r"[\s\-_/·()（）【】\[\]]+", "", str(text or "")).upper()


# ------------------------------------------------------------------ 品类与图片前缀推断
def _img_prefix_for(model: str, name: str, explicit_pfx: str = "") -> tuple[str, str]:
    t = f"{model} {name}".upper()
    if explicit_pfx and explicit_pfx in (
        "MON1", "MON2", "MON_ROG", "MON_AOC", "MON_LG", "MON_ACER", "PUR", "DYS", "SPK", "ROB",
        "IP14", "IP13", "IP12", "IPAD9", "MBA", "APP2", "XM4", "SW", "Z30", "M50", "MATE40", "KINDLE", "MI13",
    ):
        if "PUR" in explicit_pfx:
            return explicit_pfx, "purifier"
        if explicit_pfx in ("DYS", "SPK", "ROB"):
            return explicit_pfx, "appliance"
        if explicit_pfx.startswith("MON"):
            return explicit_pfx, "monitor"
        if explicit_pfx in ("IP14", "IP13", "IP12", "IPAD9", "MBA", "APP2"):
            return explicit_pfx, "apple"
        return explicit_pfx, "digital"
    if any(k in t for k in ("HT01", "戴森", "HD08", "V12", "ULIKE", "脱毛")):
        return "DYS", "appliance"
    if any(k in t for k in ("4LITE", "净化器", "ACM")):
        return "PUR", "purifier"
    if any(k in t for k in ("SONOS", "哈曼", "琉璃", "音响", "音箱")):
        return "SPK", "appliance"
    if any(k in t for k in ("云鲸", "石头", "扫地", "YJCC")):
        return "ROB", "appliance"
    if "AOC" in t:
        return "MON_AOC", "monitor"
    if "LG" in t:
        return "MON_LG", "monitor"
    if any(k in t for k in ("华硕", "ASUS", "ROG", "VG27", "XG27", "PG27")):
        return "MON_ROG", "monitor"
    if any(k in t for k in ("宏碁", "ACER", "XV27")):
        return "MON_ACER", "monitor"
    if "25M2N32" in t or "F25G" in t or "G25" in t or "24" in t:
        return "MON2", "monitor"
    if "27M2N" in t or "D75V" in t or "F24G" in t or "显示器" in t or "HKC" in t or "泰坦" in t or "KTC" in t or "盛色" in t:
        return "MON1", "monitor"
    if "IPHONE" in t or "15 PRO" in t:
        return "IP14", "apple"
    if "MAC MINI" in t or "MACBOOK" in t:
        return "MBA", "apple"
    if "IPAD" in t:
        return "IPAD9", "apple"
    if "SWITCH" in t or "佳明" in t:
        return "SW", "digital"
    if "AIRPODS" in t:
        return "APP2", "apple"
    if "飓风" in t or "HYPERX" in t or "XM4" in t:
        return "XM4", "digital"
    if "索尼" in t or "A7M4" in t:
        return "Z30", "digital"
    if any(k in t for k in ("券", "书", "CD", "课程", "代写", "代剪", "代充", "门票", "服务")):
        return "V-mcd", "non_3c"
    return "MON1", "digital"


def _brand_of(name: str, model: str, explicit_brand: str = "") -> str:
    if explicit_brand:
        return explicit_brand
    for b in ("飞利浦", "戴森", "小米", "创维", "盈色", "Apple", "苹果", "索尼", "任天堂"):
        if b in f"{name} {model}":
            return "Apple" if b in ("iPhone", "iPad", "Mac") else b
    if any(k in f"{name} {model}" for k in ("iPhone", "iPad", "Mac", "AirPods")):
        return "Apple"
    parts = str(name or "").strip().split()
    return parts[0] if len(parts) > 1 else ""


def _build_default_spu_policy(brand: str, model: str, name: str, center: float, cat_kind: str) -> dict[str, Any]:
    """复刻 V1 xianyu-seller-pilot 品类搜索词策略与 SPU 级过滤规则。"""
    m = (model or name).strip()
    b = (brand or "").strip()
    queries: list[str] = []
    if cat_kind == "monitor":
        # 显示器 split 策略：先搜纯型号，再搜 品牌+型号
        queries = [m, f"{b} {m}".strip()]
        extra_bl = ["底座", "支架", "屏线", "电源板"]
    elif cat_kind == "purifier":
        clean_m = m.replace("空气净化器", "").strip() or m
        queries = [f"{b} 空气净化器 {clean_m}".strip(), m]
        extra_bl = ["滤芯", "滤桶", "过滤网", "传感器"]
    elif cat_kind == "apple":
        queries = [m, f"国行 {m}".strip()]
        extra_bl = ["有锁", "卡贴", "ID锁", "模型机"]
    elif cat_kind == "appliance":
        queries = [f"{b} {m}".strip(), m]
        extra_bl = ["风嘴", "支架", "收纳盒", "防尘袋"]
    elif cat_kind == "non_3c":
        queries = [m]
        extra_bl = ["代拍定金"]
    else:
        queries = [f"{b} {m}".strip(), m]
        extra_bl = ["保护套", "收纳包"]

    dedup_q: list[str] = []
    for q in queries:
        q = re.sub(r"\s+", " ", q).strip()
        if q and q not in dedup_q:
            dedup_q.append(q)

    # SPU 挂牌价上下限围栏（模拟 SPU 主数据里维护的合理挂牌区间，自动挡住离谱配件价与天价礼盒）
    c = max(45.0, float(center or 500))
    min_fence = round(c * 0.58) if cat_kind != "non_3c" else None
    max_fence = round(c * 1.48) if cat_kind != "non_3c" else None
    return {
        "categoryProfile": cat_kind,
        "queries": dedup_q or [m],
        "aliases": [m],
        "blacklistMode": "append",   # inherit | append | replace
        "blacklistTerms": extra_bl,
        "minListingPrice": min_fence,
        "maxListingPrice": max_fence,
    }


def _sibling_wrong_model_pair(brand: str, model: str, cat_kind: str) -> tuple[str, str]:
    """生成闲鱼模糊搜索经常混入的 2 个『同品牌串型号非目标商品』，用于演示 V1 relevance 型号匹配规则。"""
    u = model.upper()
    if "HT01" in u:
        return "戴森 HD08 紫红色吹风机", "戴森 HD15 防飞翘吹风机"
    if "27M2N5510P" in u:
        return "飞利浦 27M1N3200Z 27寸显示器", "飞利浦 27E1N5600AE 2K办公屏"
    if "25M2N3200W" in u or "25M2N32" in u:
        return "飞利浦 242M8 24寸显示器", "飞利浦 243V7Q 办公显示器"
    if "D75V" in u:
        return "盈色 D24H 24寸办公显示器", "盈色 P27A 60Hz显示器"
    if "F24G30F" in u or "F25G37F" in u:
        return "创维 F22B20F 21.5寸显示器", "创维 F27B40Q 27寸办公显示器"
    if "4LITE" in u:
        return "小米 空气净化器 2S 旧款", "小米 空气净化器 ProH 大空间版"
    if "15 PRO" in u:
        return "iPhone 14 Pro 128G 国行", "iPhone 13 256G 自用无修"
    return f"{brand or '同品牌'} 旧款基础版 X100", f"{brand or '同品牌'} 入门青春版 S10"


def _sibling_wrong_model(brand: str, model: str, cat_kind: str) -> str:
    return _sibling_wrong_model_pair(brand, model, cat_kind)[0]


def _build_v1_candidates(
    brand: str,
    model: str,
    name: str,
    center: float,
    spu_policy: dict[str, Any],
    batch_ver: int = 1,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    """生成闲鱼搜索/挂牌页整页 36 个商品卡片（约 25 条合理在售 + 11 条不合理噪音项）+ 跨词 URL/itemId 去重。"""
    pfx, cat_kind = _img_prefix_for(model, name)
    queries = list(spu_policy.get("queries") or [model or name])

    def im(idx: int) -> str:
        if pfx.startswith("V-"):
            return f"/api/demo-img/{pfx}.jpg"
        return f"/api/demo-img/{pfx}-{(idx % 36) + 1}.jpg"

    c = max(45.0, float(center or 500))
    # 重爬时带轻微真实市场波动（±1%~2.4%），让员工看到作废重爬后新快照与均价实时更新
    jitter = 1.0 + (((batch_ver - 1) % 5) - 2) * 0.012 if batch_ver > 1 else 1.0
    c = c * jitter
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    q0 = queries[0]
    q1 = queries[1] if len(queries) > 1 else queries[0]
    has_q1 = len(queries) > 1

    if cat_kind == "non_3c":
        rows = [
            {"id": "XY-101", "itemId": f"xy8801{batch_ver}", "cardIdx": 1, "queryHits": [0], "queryText": q0,
             "seller": "诚信券坊", "city": "杭州", "condition": "全新", "type": "挂牌",
             "title": f"{name} 官方直充秒发 个人闲置转", "price": round(c * 0.98, 2), "img": im(0),
             "captured": now_str, "wants": 34, "views": 410},
            {"id": "XY-102", "itemId": f"xy8802{batch_ver}", "cardIdx": 2, "queryHits": [0], "queryText": q0,
             "seller": "周末省钱君", "city": "温州", "condition": "全新", "type": "挂牌",
             "title": f"{model} 现货电子码 正规渠道不限门店", "price": round(c * 1.02, 2), "img": im(1),
             "captured": now_str, "wants": 21, "views": 280},
            {"id": "XY-103", "itemId": f"xy8803{batch_ver}", "cardIdx": 3, "queryHits": [0], "queryText": q0,
             "seller": "同城自用出", "city": "上海", "condition": "全新", "type": "挂牌",
             "title": f"{model} 买多了转一张 可验真", "price": round(c * 0.96, 2), "img": im(2),
             "captured": now_str, "wants": 19, "views": 195},
            {"id": "XY-104", "itemId": f"xy8804{batch_ver}", "cardIdx": 4, "queryHits": [0], "queryText": q0,
             "seller": "补差专拍号", "city": "广州", "condition": "全新", "type": "挂牌",
             "title": f"{model} 邮费补差 专拍链接勿拍", "price": 1.0, "img": im(3),
             "captured": now_str, "wants": 88, "views": 950},
        ]
        q_runs = [{"queryIndex": 0, "query": q0, "rawCount": len(rows)}]
        return rows, q_runs, 0

    wrong_sib_1, wrong_sib_2 = _sibling_wrong_model_pair(brand, model, cat_kind)
    acc_terms = spu_policy.get("blacklistTerms") or ["底座"]
    acc_term_1 = acc_terms[0]
    acc_term_2 = acc_terms[1] if len(acc_terms) > 1 else acc_term_1
    min_fence_val = float(spu_policy.get("minListingPrice") or (c * 0.58))
    max_fence_val = float(spu_policy.get("maxListingPrice") or (c * 1.48))
    below_fence_price = max(108, _int_yuan(min_fence_val * 0.78))
    high_fence_price = _int_yuan(max_fence_val * 1.18)

    bm = f"{brand} {model}".strip()
    # 25 条真实合理的闲鱼在售挂牌模板
    valid_specs = [
        ("城西数码自用", "杭州", "95新", f"{bm} 个人一手自用 成色95新 功能全好无暗病", 0.98, 26, [0, 1]),
        ("搬家清闲置", "上海", "99新", f"仅拆封 {name} 箱说配件齐全 支持验货顺丰到付", 1.04, 31, [0]),
        ("极客桌面玩家", "苏州", "95新", f"{model} 实拍在用 无拆无修 换新回血出", 0.96, 19, [0, 1]),
        ("滨江老张闲置", "宁波", "9新", f"{bm} 正常使用痕迹 实拍如图 同城可自提", 0.93, 14, [0]),
        ("小陈精选数码", "南京", "95新", f"国行正品 {bm} 成色漂亮 检测全绿不议价", 1.02, 22, [1]),
        ("莫干山路小周", "杭州", "99新", f"女生自用 {bm} 保护极好 几乎全新带原盒", 1.05, 38, [0, 1]),
        ("科技园阿凯", "深圳", "95新", f"升级装备换下 {model} 功能正常 指哪拍哪", 0.95, 17, [0]),
        ("羊城好物转转", "广州", "9新", f"{name} 自用一年半 状态稳 顺丰保价发", 0.91, 12, [1]),
        ("望京打工人", "北京", "99新", f"公司年会奖品 {bm} 拆封试机一次 闲置转让", 1.07, 41, [0, 1]),
        ("春熙路小丸子", "成都", "95新", f"{bm} 国行在保 带电子购买凭证 诚心出", 1.01, 25, [0]),
        ("光谷程序猿", "武汉", "95新", f"桌面空间不够出 {model} 原装配件都在 无磕碰", 0.97, 15, [1]),
        ("五一广场数码", "长沙", "9新", f"{bm} 轻微使用痕迹 功能百分百完好 秒发", 0.90, 11, [0]),
        ("鹭岛海风闲置", "厦门", "99新", f"{name} 买来吃灰没用几次 成色充新 爽快包邮", 1.06, 29, [0, 1]),
        ("金鸡湖畔老李", "苏州", "95新", f"家里多出一台 {bm} 实拍现机 签收24h确认减20", 0.99, 18, [1]),
        ("二七塔下自用", "郑州", "9新", f"{model} 实用党好价 外观小划痕不影响使用", 0.89, 20, [0]),
        ("大明湖小夏", "济南", "95新", f"自用 {bm} 原装未拆修 支持任何方式验机", 1.00, 16, [0]),
        ("曲江书房主理", "西安", "99新", f"工作室摆拍道具 {name} 通电不超10小时", 1.08, 33, [1]),
        ("解放碑酷玩", "重庆", "95新", f"{bm} 换代闲置 箱说全 同城地铁口可面交", 0.94, 13, [0, 1]),
        ("五大道老克勒", "天津", "95新", f"个人闲置 {bm} 爱惜使用 细节图私聊秒回", 0.97, 10, [1]),
        ("星海广场小刘", "大连", "99新", f"京东自营购入 {model} 成色99新 配件齐全", 1.03, 27, [0]),
        ("栈桥吹风少年", "青岛", "95新", f"{bm} 在家闲置占地方 价格实在先到先得", 0.95, 21, [0]),
        ("东街口数码控", "福州", "9新", f"老客户回血 {name} 全功能正常 不刀不墨迹", 0.92, 9, [1]),
        ("天一阁藏家", "宁波", "全新", f"全新未拆封 {bm} 原厂封条完好 送礼自用皆宜", 1.11, 44, [0, 1]),
        ("南山设计狗", "深圳", "95新", f"{model} 工作室升级淘汰 干净卫生已消毒", 0.96, 15, [0]),
        ("珠江新城Lily", "广州", "99新", f"{bm} 礼盒拆出单机 成色极佳 顺丰特快发出", 1.02, 24, [1]),
    ]

    # 11 条真实闲鱼第 1 页常见不合理噪音卡片（完整覆盖五重过滤规则）
    noisy_specs = [
        (4, "引流特惠数码", "深圳", "99新", f"{bm} 现货多台成色靓 感兴趣私聊看实拍发改价链接", 39.9, 118, [0]),
        (5, "原装配件拆卖", "义乌", "9新", f"适用 {bm} 原装{acc_term_1} 电源线 仅配件不含主机", _int_yuan(max(55, c * 0.12)), 7, [0]),
        (8, "邻家闲置屋", "武汉", "95新", f"{wrong_sib_1} 自用闲置 功能完好（闲鱼模糊推荐）", _int_yuan(c * 0.79), 16, [1]),
        (11, "阿强维修铺", "东莞", "战损", f"{model} 进水不开机主板故障 当拆机件尸体研究出", _int_yuan(max(130, c * 0.24)), 9, [1]),
        (14, "全城闪电回收", "广州", "95新", f"高价回收 {bm} 全国上门验机当场秒结款", _int_yuan(c * 0.72), 5, [0, 1]),
        (18, "清仓老物件", "郑州", "伊拉克", f"{bm} 重度磨损裸机一处小暗病 特价处理不退换", below_fence_price, 31, [0]),
        (21, "盒子收纳控", "金华", "95新", f"{bm} 原装包装盒空盒+{acc_term_2} 不含机器看清楚拍", 49.0, 6, [0]),
        (25, "江北自用党", "重庆", "95新", f"{wrong_sib_2} 家里升级闲置 便宜出给有缘人", _int_yuan(c * 0.68), 14, [1]),
        (29, "同城数码搬运", "成都", "99新", f"{bm} 同城当面试机 标价引流请先私信问实价", 68.0, 94, [0]),
        (33, "礼盒收藏家", "北京", "全新", f"{bm} 全新未拆封限定礼盒版+全套三年全保套装", high_fence_price, 8, [1]),
        (36, "展示防拍号", "上海", "99新", f"{bm} 线下熟人已订展示留档 勿拍请先私聊", 999999, 2, [0]),
    ]
    noisy_by_pos = {pos: spec for pos, *spec in noisy_specs}

    rows: list[dict[str, Any]] = []
    v_idx = 0
    for pos in range(1, 37):
        if pos in noisy_by_pos:
            seller, city, cond, title, price_val, wants, qhits = noisy_by_pos[pos]
        else:
            seller, city, cond, title, mult, wants, qhits = valid_specs[v_idx]
            price_val = _int_yuan(c * mult)
            v_idx += 1
        norm_hits = [h for h in qhits if h == 0 or has_q1] or [0]
        q_txt = q0 if 0 in norm_hits else q1
        rows.append({
            "id": f"XY-{pos:02d}",
            "itemId": f"7901{pos:02d}{batch_ver}",
            "cardIdx": pos,
            "queryHits": norm_hits,
            "queryText": q_txt,
            "seller": seller,
            "city": city,
            "condition": cond,
            "type": "挂牌",
            "title": title,
            "price": price_val,
            "img": im(pos - 1),
            "captured": now_str,
            "wants": wants,
            "views": wants * 21 + 48,
        })

    q_runs = []
    total_raw = 0
    for idx, q in enumerate(queries):
        cnt = sum(1 for r in rows if idx in (r.get("queryHits") or [0]))
        total_raw += cnt
        q_runs.append({"queryIndex": idx, "query": q, "rawCount": cnt})
    deduped_cnt = max(0, total_raw - len(rows))
    return rows, q_runs, deduped_cnt


def _classify_against_purchase(price: float | None, cost: float | None) -> dict[str, Any]:
    """复刻 V1 classifyPriceAgainstPurchase 5 档采购成本对比 + 倒挂围栏。"""
    if not price or not cost or cost <= 0:
        return {"tier": "unknown", "label": "待核成本", "pct": None, "level": "amb"}
    pct = round((price / cost) * 100, 1)
    if price < cost:
        return {"tier": "below_purchase", "label": f"低于采购价 ({pct:.0f}%) · 倒挂拦截", "pct": pct, "level": "red"}
    if pct < 120:
        return {"tier": "purchase_100_119", "label": f"采购价 100%~119% 档 ({pct:.0f}%)", "pct": pct, "level": "amb"}
    if pct < 150:
        return {"tier": "purchase_120_plus", "label": f"采购价 120%+ 正常档 ({pct:.0f}%)", "pct": pct, "level": "grn"}
    if pct < 200:
        return {"tier": "purchase_150_plus", "label": f"采购价 150%+ 优质档 ({pct:.0f}%)", "pct": pct, "level": "grn"}
    return {"tier": "purchase_200_plus", "label": f"采购价 200%+ 高溢价档 ({pct:.0f}%)", "pct": pct, "level": "grn"}


def _effective_blacklist(spu_policy: dict[str, Any]) -> list[str]:
    mode = spu_policy.get("blacklistMode") or "append"
    custom = [str(x).strip() for x in (spu_policy.get("blacklistTerms") or []) if str(x).strip()]
    if mode == "replace":
        return custom
    if mode == "inherit":
        return list(DEFAULT_BLACKLIST_TERMS)
    merged = list(DEFAULT_BLACKLIST_TERMS)
    for t in custom:
        if t not in merged:
            merged.append(t)
    return merged


def _machine_screen(case: dict[str, Any]) -> dict[str, Any]:
    """复刻 V1 xianyu-seller-pilot 确定性五重优先级筛选 + 预计算平均价/中位价/极值。

    优先级顺序（DECISION_PRIORITY）：
    1. blacklist（命中屏蔽词）
    2. relevance（紧凑化标题不含目标型号或已配置别称）
    3. below_spu_min_price / above_spu_max_price（超出 SPU 挂牌价围栏）
    4. low_price（当存在 ≥100 元有效候选时，剔除 <100 元引流低价）
    5. over_maximum（剔除 >100,000 元异常占位价）
    """
    raw_rows = case["raw_samples"]
    spu_policy = case.get("spuPolicy") or {}
    cat_mode = case["strategy"].get("categoryMode") or ("non_3c" if spu_policy.get("categoryProfile") == "non_3c" else "3c")
    bl_terms = _effective_blacklist(spu_policy)
    min_spu = spu_policy.get("minListingPrice")
    max_spu = spu_policy.get("maxListingPrice")

    # 构造型号/别称匹配词根
    accept_tokens = [_compact(case.get("model") or "")]
    for a in (spu_policy.get("aliases") or []):
        ca = _compact(a)
        if ca and ca not in accept_tokens:
            accept_tokens.append(ca)
    # 若型号含中文前缀如「空气净化器4LITE」，同时允许核心型号片段「4LITE」
    core_alnum = re.findall(r"[A-Z0-9]{3,}", _compact(case.get("model") or ""))
    for tok in core_alnum:
        if tok not in accept_tokens:
            accept_tokens.append(tok)
    accept_tokens = [t for t in accept_tokens if t]

    # 第 1 遍：先评估前 3 项 + 防拍异常高价，判断是否存在 ≥100 元合法目标样本（V1 low_price 触发前置条件）
    prelim_codes: list[tuple[str | None, str]] = []
    has_ge_100_valid = False
    for r in raw_rows:
        p = float(r.get("price") or 0)
        t = str(r.get("title") or "")
        ct = _compact(t)
        code: str | None = None
        reason = ""

        hit_bl = next((kw for kw in bl_terms if kw and kw in t), None)
        if hit_bl:
            code = "blacklist"
            reason = f"命中屏蔽词「{hit_bl}」"
        elif accept_tokens and not any(tok in ct for tok in accept_tokens):
            code = "relevance"
            reason = f"非目标商品：标题未匹配目标型号「{case.get('model')}」"
        elif min_spu is not None and float(min_spu) > 0 and p >= 100 and p < float(min_spu):
            code = "below_spu_min_price"
            reason = f"低于 SPU 挂牌下限 ¥{_int_yuan(min_spu)}"
        elif max_spu is not None and float(max_spu) > 0 and p <= 100000 and p > float(max_spu):
            code = "above_spu_max_price"
            reason = f"高于 SPU 挂牌上限 ¥{_int_yuan(max_spu)}"
        elif p > 100000:
            code = "over_maximum"
            reason = "高于 ¥100,000 异常占位防拍价"

        if code is None and p >= 100:
            has_ge_100_valid = True
        prelim_codes.append((code, reason))

    # 第 2 遍：应用 low_price (<100 元引流价) 并汇总人工调整
    for r, (code, reason) in zip(raw_rows, prelim_codes):
        p = float(r.get("price") or 0)
        if code is None and cat_mode != "non_3c" and has_ge_100_valid and p < 100:
            code = "low_price"
            reason = f"低于 ¥100 引流诱饵价（当前 ¥{p:g}）"
        elif code is None and min_spu is not None and float(min_spu) > 0 and p < float(min_spu):
            code = "below_spu_min_price"
            reason = f"低于 SPU 挂牌下限 ¥{_int_yuan(min_spu)}"

        auto_inc = code is None
        r["rejectionCode"] = code or ""
        r["rejectionBadge"] = REJECTION_LABELS.get(code or "", "非目标商品") if code else "计入均价"
        r["machineInclude"] = auto_inc
        r["machineReason"] = reason if code else "通过五重初筛 · 正常同款挂牌"

        if not r.get("humanTouched"):
            r["include"] = auto_inc
            r["reason"] = "" if auto_inc else reason

    included = [r for r in raw_rows if r.get("include")]
    inc_prices = sorted(float(r["price"]) for r in included)
    cleaned_avg = round(sum(inc_prices) / len(inc_prices), 2) if inc_prices else None
    med = _median(inc_prices)
    low = inc_prices[0] if inc_prices else None
    high = inc_prices[-1] if inc_prices else None
    spread = round((high - low) / med, 4) if (med and med > 0 and low is not None and high is not None) else 0.0
    rec_price = _int_yuan(cleaned_avg) if cleaned_avg is not None else None

    cost = float(case.get("cost") or 0)
    comp = _classify_against_purchase(cleaned_avg, cost)
    fence_ok = (cleaned_avg is not None) and (cost <= 0 or cleaned_avg >= cost)

    days = int(case.get("stockAgeDays") or 0)
    clear_factor = 0.88 if days >= 28 else 0.94 if days >= 15 else 1.0
    clear_label = "满4周期滞销建议（88折）" if days >= 28 else "第3周期加速建议（94折）" if days >= 15 else "正常库龄"
    clear_price = max(_int_yuan(cost), _int_yuan(cleaned_avg * clear_factor)) if (cleaned_avg and cost) else (_int_yuan(cleaned_avg * clear_factor) if cleaned_avg else None)

    # 按剔除规则统计命中分布
    rej_breakdown: dict[str, int] = {}
    for r in raw_rows:
        if not r.get("include"):
            rc = "manual_exclude" if (r.get("humanTouched") and r.get("machineInclude")) else (r.get("rejectionCode") or "manual_exclude")
            rej_breakdown[rc] = rej_breakdown.get(rc, 0) + 1

    # 复刻 V1 Prices.vue + price-candidate.js 预计算候选价格供员工一键单选确认（无需每个店铺填价）
    price_candidates: list[dict[str, Any]] = []
    if rec_price is not None:
        price_candidates.append({
            "key": "cleaned_average",
            "label": "清洗后平均挂牌价（默认主推）",
            "price": rec_price,
            "exact": cleaned_avg,
            "desc": f"去掉 {len(raw_rows) - len(included)} 条不合理项后，{len(included)} 条同款有效挂牌算术均价",
            "recommended": True,
        })
    if med is not None:
        med_int = _int_yuan(med)
        price_candidates.append({
            "key": "market_median",
            "label": "行情中位价（取整）",
            "price": med_int,
            "exact": med,
            "desc": "抗高低极值干扰的中位数价格",
            "recommended": False,
        })
        pol_round10 = int(round(max(float(med), cost) / 10.0) * 10)
        price_candidates.append({
            "key": "policy_round10",
            "label": "策略保底整十价",
            "price": pol_round10,
            "exact": None,
            "desc": "max(中位数, 采购成本底线) 按 10 元取整",
            "recommended": False,
        })
    if days >= 15 and clear_price is not None:
        price_candidates.append({
            "key": "clearance",
            "label": clear_label,
            "price": clear_price,
            "exact": None,
            "desc": f"在库 {days} 天加速周转价（不低于采购成本）",
            "recommended": False,
        })

    case["stats"] = {
        "totalRawFetched": len(raw_rows) + int(case.get("dedupedCount") or 0),
        "dedupedCount": int(case.get("dedupedCount") or 0),
        "totalCandidates": len(raw_rows),
        "validCount": len(included),
        "includedCount": len(included),
        "rejectedCount": len(raw_rows) - len(included),
        "machineKept": sum(1 for r in raw_rows if r.get("machineInclude")),
        "machineRejected": sum(1 for r in raw_rows if not r.get("machineInclude")),
        "cleanedAverage": cleaned_avg,
        "mean": cleaned_avg,
        "median": med,
        "lowest": low,
        "highest": high,
        "low": low,
        "high": high,
        "spread": spread,
        "spreadPct": round(spread * 100, 1),
        "recommendedPrice": rec_price,    # V1 核心主报价：清洗后算术平均挂牌价（取整元）
        "priceCandidates": price_candidates,
        "priceSource": "cleaned_average",
        "purchaseComparison": comp,
        "priceFenceOk": fence_ok,
        "rejectionBreakdown": rej_breakdown,
        "clearancePrice": clear_price,
        "clearanceFactor": clear_factor,
        "clearanceLabel": clear_label,
        "lowSampleWarn": len(included) < 3,
        "wideSpreadWarn": spread > 0.25,
    }
    compute_v020_candidate_preview_and_logs(
        case,
        api_current_sale_price=case.get("apiCurrentSalePrice"),
        api_suggest_price=case.get("apiSuggestPrice"),
    )
    # ---- 接入 95%走量基准防呆尺 + 无样本同档兜底 + 5%高端实爬直算 + 卓威独立表 ----
    b_eval = evaluate_monitor_pricing(
        f"{case.get('brand') or ''} {case.get('model') or ''}".strip() or case.get("name", ""),
        f"{case.get('config') or ''} {case.get('name') or ''}",
        cleaned_avg,
        case.get("brand") or "",
    )
    case["baselineEval"] = b_eval
    cp_prev = case.get("candidatePreview") or {}
    fb_price = b_eval.get("fallbackSalePrice")
    if b_eval.get("supported"):
        if b_eval.get("sanityBlocked"):
            # 离谱低价（如 2K 240Hz 爬出 ¥200）强制拦截进人工复核队列，严禁自动采信假低价
            cp_prev["reviewOnly"] = True
            reasons = list(cp_prev.get("reviewReasons") or [])
            if b_eval.get("sanityReason") and b_eval["sanityReason"] not in reasons:
                reasons.insert(0, b_eval["sanityReason"])
            cp_prev["reviewReasons"] = reasons
            cp_prev["queueBucket"] = "review"
            cp_prev["subBucket"] = "sanity_blocked"
            cp_prev["queueLabel"] = "🚨 触发基准防呆拦截（错爬低价）"
            for cand in price_candidates:
                cand["recommended"] = False
            if fb_price:
                price_candidates.insert(0, {
                    "key": "spec_fallback",
                    "label": "同档规格兜底价（防呆替身）",
                    "price": int(fb_price),
                    "exact": float(fb_price),
                    "desc": b_eval.get("priceSource") or "已拦截异常实爬价，改用同规格档兜底锚点",
                    "recommended": True,
                })
                case["stats"]["recommendedPrice"] = int(fb_price)
                cp_prev["candidates"] = price_candidates
        elif len(included) == 0 and fb_price and b_eval.get("track") in ("volume_95", "zowie_independent"):
            # 闲鱼无在售样本时，95%走量款与卓威提供同规格桶兜底候选价（5%高端款绝不硬套公式！）
            price_candidates.append({
                "key": "spec_fallback",
                "label": "95%走量同档兜底价" if b_eval.get("track") == "volume_95" else "卓威独立参考价",
                "price": int(fb_price),
                "exact": float(fb_price),
                "desc": b_eval.get("priceSource") or "闲鱼无有效样本，按品牌档+分辨率+超频Hz兜底",
                "recommended": True,
            })
            case["stats"]["recommendedPrice"] = int(fb_price)
            cp_prev["candidates"] = price_candidates
    return case


# ------------------------------------------------------------------ 运行期状态存储（重置时恢复）
CLEAN_CASES: dict[str, dict[str, Any]] = {}
IMAGE_LIBRARIES: dict[str, dict[str, Any]] = {}
PRICEBOOK: list[dict[str, Any]] = []
INQUIRIES: list[dict[str, Any]] = []
COMMISSION: list[dict[str, Any]] = []
FX_CONFIG: dict[str, Any] = {"jpy_to_cny": 0.047, "freight_tax_pct": 12.0, "updated_at": "2026-11-14"}
EXTRAS_STORE: dict[str, dict[str, Any]] = {}


def _default_pricebook() -> list[dict]:
    return [
        {"id": "PB-001", "model": "27M2N5510P", "config": "27 英寸 2K 180Hz", "ref": 990, "suggest": 1020, "limit": 920, "deal": 640, "paid": 640, "rebate": 0, "status": "已生效", "ver": "v3", "from": "11-10", "to": "11-17", "fb": "主销稳价，实拍齐"},
        {"id": "PB-002", "model": "iPhone 15 Pro 256G", "config": "国行 无锁 95 新", "ref": 4890, "suggest": 4999, "limit": 5100, "deal": 4450, "paid": 4400, "rebate": 0, "status": "已生效", "ver": "v2", "from": "11-08", "to": "11-15", "fb": "到货 3 台，成色与报价一致"},
        {"id": "PB-003", "model": "Mac mini M4 16/256", "config": "国行 在保", "ref": 3280, "suggest": 3399, "limit": 3500, "deal": 0, "paid": 0, "rebate": 0, "status": "待核", "ver": "v1", "from": "11-12", "to": "11-19", "fb": ""},
        {"id": "PB-004", "model": "iPad Air 5 64G", "config": "WiFi 9 成新", "ref": 2650, "suggest": 2699, "limit": 2800, "deal": 2400, "paid": 2400, "rebate": 0, "status": "已生效", "ver": "v1", "from": "11-06", "to": "11-13", "fb": "已售 2 台"},
        {"id": "PB-005", "model": "戴森 V12 Detect", "config": "国行 全套", "ref": 1650, "suggest": 1699, "limit": 1800, "deal": 0, "paid": 0, "rebate": 0, "status": "已失效", "ver": "v1", "from": "10-20", "to": "11-03", "fb": "报价高于行情，暂停"},
        {"id": "PB-006", "model": "Switch OLED 白色", "config": "日版 单机", "ref": 1520, "suggest": 1580, "limit": 1650, "deal": 1400, "paid": 1400, "rebate": 0, "status": "已生效", "ver": "v2", "from": "11-11", "to": "11-18", "fb": ""},
        {"id": "PB-007", "model": "AirPods Pro 2", "config": "USB-C 国行", "ref": 1080, "suggest": 1150, "limit": 1200, "deal": 0, "paid": 0, "rebate": 0, "status": "维护中", "ver": "v1", "from": "11-12", "to": "11-19", "fb": ""},
        {"id": "PB-008", "model": "索尼 A7M4 单机身", "config": "国行 快门 1.2 万", "ref": 10900, "suggest": 11200, "limit": 11800, "deal": 0, "paid": 0, "rebate": 0, "status": "待核", "ver": "v1", "from": "11-12", "to": "11-20", "fb": ""},
    ]


def _default_inquiries() -> list[dict]:
    return [
        {"id": "XJ-2601", "platform": "闲鱼", "buyer": "小北", "product": "《三角洲行动》虚拟化报警处理", "pid": "v-game", "owner": "chenxm", "state": "已报价", "amount": 39, "source": "闲鱼搜索", "at": "11-12 09:12",
         "quotes": [{"v": 1, "price": 39, "valid": "11-14", "note": "含一次远程", "accepted": False}, {"v": 2, "price": 35, "valid": "11-13", "note": "老客户价", "accepted": True}],
         "follow": [{"t": "11-12 09:20", "text": "已发远程工具包，等客户装好"}], "lost": "", "order_id": ""},
        {"id": "XJ-2602", "platform": "闲鱼", "buyer": "阿杰", "product": "安卓刷机服务", "pid": "v-and", "owner": "zhoubb", "state": "跟进中", "amount": 99, "source": "闲鱼榜单", "at": "11-12 08:40",
         "quotes": [], "follow": [{"t": "11-12 08:55", "text": "问了机型和系统版本，等回复"}], "lost": "", "order_id": ""},
        {"id": "XJ-2603", "platform": "小红书", "buyer": "momo", "product": "小红书种草笔记代写", "pid": "v-xhs", "owner": "chenxm", "state": "待客户", "amount": 120, "source": "小红书私信", "at": "11-11 21:10",
         "quotes": [{"v": 1, "price": 120, "valid": "11-15", "note": "3 篇图文", "accepted": False}], "follow": [{"t": "11-11 21:30", "text": "客户说要和老板确认"}], "lost": "", "order_id": ""},
        {"id": "XJ-2604", "platform": "淘宝", "buyer": "陈先生", "product": "麦当劳 鸡牛双堡双人餐电子券", "pid": "v-mcd", "owner": "zhoubb", "state": "已成交", "amount": 46, "source": "淘宝问大家", "at": "11-11 18:02",
         "quotes": [{"v": 1, "price": 46, "valid": "11-12", "note": "", "accepted": True}], "follow": [{"t": "11-11 18:10", "text": "已发券"}], "lost": "", "order_id": "V-1031"},
        {"id": "XJ-2605", "platform": "闲鱼", "buyer": "老K", "product": "CAD 平面图描图代画", "pid": "v-cad", "owner": "chenxm", "state": "新询", "amount": 58, "source": "闲鱼搜索", "at": "11-12 10:02",
         "quotes": [], "follow": [], "lost": "", "order_id": ""},
        {"id": "XJ-2606", "platform": "京东", "buyer": "王女士", "product": "ChatGPT Plus 月卡代充", "pid": "v-gpt", "owner": "zhoubb", "state": "已丢单", "amount": 168, "source": "京东", "at": "11-10 16:20",
         "quotes": [{"v": 1, "price": 168, "valid": "11-11", "note": "", "accepted": False}], "follow": [], "lost": "客户嫌比别家贵 20 元", "order_id": ""},
    ]


def _seed_cleaning_case(
    sku_code: str,
    name: str,
    model: str,
    config: str,
    cost: float,
    market: float | None,
    days: int,
    *,
    brand: str = "",
    spu_code: str = "",
    api_suggest_price: float | None = None,
    api_current_sale_price: float | None = None,
    crawlless: bool = False,
) -> dict[str, Any]:
    _, cat_kind = _img_prefix_for(model or name, name)
    cat_mode = "non_3c" if cat_kind == "non_3c" else "3c"
    resolved_brand = _brand_of(name, model, brand)
    center = float(market or (cost * 1.48 if cost else 550))
    canonical_spu = str(spu_code or "").strip() or f"UNBOUND-{model or sku_code}"
    base_pol = _build_default_spu_policy(resolved_brand, model or name, name, center, cat_kind)
    spu_policy = enrich_spu_policy(
        base_pol,
        spu_key=canonical_spu,
        sku_code=sku_code,
        brand=resolved_brand,
        model=model or name,
        name=name,
    )
    if crawlless:
        samples, q_runs, deduped_cnt = [], [], 0
    else:
        samples, q_runs, deduped_cnt = _build_v1_candidates(resolved_brand, model or name, name, center, spu_policy, batch_ver=1)

    snap_id = f"SNAP-{sku_code}"
    case: dict[str, Any] = {
        "code": sku_code,
        "spuCode": canonical_spu,
        "brand": resolved_brand,
        "model": model or name,
        "name": name,
        "config": config or "标准配置",
        "cost": _money(cost),
        "apiSuggestPrice": api_suggest_price,
        "apiCurrentSalePrice": api_current_sale_price,
        "floor": int(math.ceil(cost * 1.0)) if cost else 0,
        "ratio": 1.0,
        "stockAgeDays": days,
        "crawlBatch": 1,
        "snapshotId": snap_id,
        "snapshotUrl": f"/api/demo/snapshots/{snap_id}",
        "crawledAt": "" if crawlless else datetime.now().strftime("%Y-%m-%d %H:%M"),
        "centerHint": center,
        "spuPolicy": spu_policy,
        "queryRuns": q_runs,
        "dedupedCount": deduped_cnt,
        "strategy": {
            "categoryMode": cat_mode,
            "minPriceThreshold": 100 if cat_mode == "3c" else 0,
            "selectedType": "挂牌",
            "conditionFilter": "ALL",
        },
        "raw_samples": samples,
        "versions": [],
        "invalidatedHistory": [],
        "aiSuggestion": None,
        "aiWebSearchResults": [],
        "activeVersion": None,
        "confirmedPrice": None,
        "overrideReason": "",
        "reviewNote": "",
        "reviewedBy": "",
        "reviewedAt": "",
        "step": "waiting_crawl" if crawlless else "human_review",
    }
    if not crawlless:
        _machine_screen(case)
        if sku_code in ("990001540233-A", "990001540203"):
            avg_p = 990 if sku_code == "990001540233-A" else (case["stats"].get("recommendedPrice") or 425)
            ver = {
                "version": 1,
                "price": avg_p,
                "priceType": "清洗均价",
                "cleanedAverage": case["stats"].get("cleanedAverage"),
                "median": case["stats"].get("median"),
                "samplesCount": case["stats"].get("validCount"),
                "confirmedBy": "陈小满",
                "confirmedAt": (datetime.now() - timedelta(hours=5)).strftime("%Y-%m-%d %H:%M"),
                "validUntil": (datetime.now() + timedelta(days=6)).strftime("%Y-%m-%d"),
                "overrideReason": "",
                "note": "第1步核对36条闲鱼快照确认均价",
            }
            case["versions"].append(ver)
            case["activeVersion"] = ver
            case["confirmedPrice"] = avg_p
            case["reviewedBy"] = "陈小满"
            case["reviewedAt"] = ver["confirmedAt"]
            case["step"] = "active"
            compute_v020_candidate_preview_and_logs(
                case,
                api_current_sale_price=avg_p,
                api_suggest_price=api_suggest_price,
            )
    else:
        compute_v020_candidate_preview_and_logs(
            case,
            api_current_sale_price=api_current_sale_price,
            api_suggest_price=api_suggest_price,
        )
    return case


# ==================================================================
# 大库图库（product-image-service）三栏清洗引擎
#   第 1 栏：推荐可使用（recommended）
#   第 2 栏：不推荐使用（notRecommended）
#   第 3 栏：已经被选定的图片（selectedByShop）
# ==================================================================
def _init_image_library_for_sku(sku_code: str) -> dict[str, Any]:
    if sku_code in IMAGE_LIBRARIES:
        return IMAGE_LIBRARIES[sku_code]

    db = _db()
    try:
        from app.enums import ShopListingStatus, SkuStatus
        from app.models import SaleShop, Sku, SkuShopListing
        from app.services import listing_approval as la

        sk = db.query(Sku).filter((Sku.sku_code == sku_code) | (Sku.model == sku_code)).first()
        if sk:
            brand = sk.brand or _brand_of(sk.product_name, sk.model or "")
            model = sk.model or sk.product_name
            prod_name = sk.product_name
            spu_dict = sk.spu if isinstance(sk.spu, dict) else {}
            spu_code = spu_dict.get("code") or ""
            explicit_pfx = spu_dict.get("img_prefix") or ""
            image_lane = spu_dict.get("image_lane") or "good"
            sk_images = list(sk.images or [])
            is_in_stock_ready = (sk.status == SkuStatus.IN_STOCK and not sk.reserve_source)
        else:
            # 支持从选品大库（8044条型号）或 SPU 编码直接打开三栏精修图库，绝不报 404！
            c_fallback = _get_or_init_case(sku_code)
            brand = c_fallback.get("brand") or _brand_of(sku_code, sku_code)
            model = c_fallback.get("model") or sku_code
            prod_name = c_fallback.get("name") or sku_code
            spu_code = c_fallback.get("spuCode") or sku_code
            explicit_pfx = ""
            image_lane = "good"
            sk_images = []
            is_in_stock_ready = True

        query = f"{brand} {model}".strip()
        pfx, _ = _img_prefix_for(model, prod_name, explicit_pfx=explicit_pfx)
        if pfx.startswith("V-"):
            pfx = "MON1"

        all_items: list[dict[str, Any]] = []
        # 1. 本件仓库验货实拍图（最高优先级，置信度 1.0）
        real_idx = 0
        defect_idx = 0
        mat_idx = 0
        for u in sk_images:
            u_str = str(u)
            if "/sku/location/" in u_str:
                continue
            if "/inspection/defect/" in u_str:
                defect_idx += 1
                all_items.append({
                    "id": f"DEF-{defect_idx}",
                    "url": u_str,
                    "sourceType": "warehouse_defect",
                    "sourceLabel": "本件瑕疵留底照",
                    "domain": "仓库验货台",
                    "resolution": "900×900",
                    "confidence": 1.0,
                    "qualityGrade": "defect",
                    "defaultWave": "not_recommended",
                    "filterCode": "defect_photo",
                    "machineReason": "本件验货瑕疵特写留底 · 默认不自动做主图（可按需选为末张说明图）",
                    "humanWave": None,
                })
            elif "/inspection/listing/" in u_str:
                real_idx += 1
                all_items.append({
                    "id": f"REAL-{real_idx}",
                    "url": u_str,
                    "sourceType": "warehouse_real",
                    "sourceLabel": f"本件验货实拍 #{real_idx}",
                    "domain": "仓库实拍",
                    "resolution": "900×900",
                    "confidence": 0.99,
                    "qualityGrade": "good",
                    "defaultWave": "recommended",
                    "filterCode": "",
                    "machineReason": "本件真机验货实拍 · 无水印高清",
                    "humanWave": None,
                })
            elif "/sku/product/" in u_str:
                mat_idx += 1
                # 只取前 3 张历史素材并入大库，避免和 library 重复臃肿
                if mat_idx <= 3:
                    all_items.append({
                        "id": f"MAT-{mat_idx}",
                        "url": u_str,
                        "sourceType": "spu_material",
                        "sourceLabel": f"历史同款素材 #{mat_idx}",
                        "domain": "历史商品库",
                        "resolution": "900×900",
                        "confidence": round(0.88 - mat_idx * 0.03, 2),
                        "qualityGrade": "good",
                        "defaultWave": "recommended",
                        "filterCode": "",
                        "machineReason": "同 SPU 已入库干净素材 · pHash 无碰撞",
                        "humanWave": None,
                    })

        # 2. 大库图库（product-image-service 按「品牌 + 型号」抓取并完成机器一轮清洗的 12 张高清候选池）
        lib_meta = [
            (1, "jd.com", "900×900", 0.97, "good", "正式池 · 官网白底正面"),
            (2, "zol.com.cn", "900×900", 0.93, "good", "正式池 · 评测台斜侧实拍"),
            (3, "smzdm.com", "900×900", 0.89, "good", "正式池 · 居家木桌光影"),
            (4, "tmall.com", "900×900", 0.85, "good", "正式池 · 45°侧面窄边框"),
            (5, "bilibili.com", "900×900", 0.79, "good", "正式池 · 暗调质感特写"),
            (6, "xiaohongshu.com", "900×900", 0.74, "good", "正式池 · 开箱成色特写"),
            (7, "suning.com", "900×900", 0.69, "ok", "模糊池 · 背部接口细节"),
            (8, "weibo.com", "900×900", 0.64, "ok", "模糊池 · 自然光窗台"),
            (9, "pconline.com.cn", "900×900", 0.60, "ok", "模糊池 · 极简灰底正侧"),
            (10, "ithome.com", "900×900", 0.88, "good", "正式池 · 点亮屏幕实测"),
            (11, "chiphell.com", "900×900", 0.82, "good", "正式池 · 底座支架特写"),
            (12, "v2ex.com", "900×900", 0.77, "good", "正式池 · 全套配件合拍"),
        ]
        # 若属于 product-image-service「坏的列表（图池不足 ≤30 张或打回需重搜）」，初始只保留前 5 张候选，供演示一键重搜补池
        active_lib_meta = lib_meta[:5] if image_lane == "bad" else lib_meta
        for idx, dom, res, conf, qg, lbl in active_lib_meta:
            all_items.append({
                "id": f"LIB-{idx}",
                "url": f"/api/demo-img/library/{pfx}-lib-{idx}.jpg",
                "sourceType": "crawled_library",
                "sourceLabel": lbl,
                "domain": dom,
                "resolution": res,
                "confidence": conf,
                "qualityGrade": qg,
                "defaultWave": "recommended",
                "filterCode": "",
                "machineReason": f"通过解码/尺寸/pHash去重 · 型号置信度 {conf:.2f}",
                "humanWave": None,
            })

        # 3. 机器第一轮自动洗入「不推荐使用」的典型同款候选（水印海报字 / 近邻串型号 / 低清小图 / 长截图）
        bad_meta = [
            ("wm", "taobao.com", "900×900", 0.81, "watermark", "检测到大面积促销横幅与店铺水印（「双11直降/盗图必究」）"),
            ("fuzzy", "xianyu.com", "900×900", 0.54, "low_confidence", f"型号证据不足（置信度 0.54）：疑似{_sibling_wrong_model(brand, model, '')}"),
            ("small", "baidu.com", "320×320", 0.76, "low_res", "分辨率偏低（320×320 < 400px 清晰度门槛）"),
            ("long", "m.jd.com", "460×960", 0.73, "aspect_ratio", "手机长截图 / 参数拼图嫌疑（高宽比 2.09）"),
        ]
        for bmode, dom, res, conf, fcode, rsn in bad_meta:
            all_items.append({
                "id": f"BAD-{bmode}",
                "url": f"/api/demo-img/library/{pfx}-bad-{bmode}.jpg",
                "sourceType": "crawled_filtered",
                "sourceLabel": "大库初筛拦截",
                "domain": dom,
                "resolution": res,
                "confidence": conf,
                "qualityGrade": "rejected",
                "defaultWave": "not_recommended",
                "filterCode": fcode,
                "machineReason": rsn,
                "humanWave": None,
            })

        # 读取各店铺当前已选图片，若未选则自动从 recommended 池不重样预选 3 张/店
        shops = db.query(SaleShop).order_by(SaleShop.sort_order).all()
        selected_by_shop: dict[str, list[str]] = {}
        used_urls: set[str] = set()

        for sh in shops:
            cur_ap = la.current(db, sk.id, sh.id) if sk else None
            listed_row = db.query(SkuShopListing).filter(
                SkuShopListing.sku_id == sk.id,
                SkuShopListing.sale_shop_id == sh.id,
                SkuShopListing.publish_status == ShopListingStatus.LISTED,
            ).first() if sk else None
            existing = list(la.clean_images((listed_row.images if listed_row and listed_row.images else None) or (cur_ap.images if cur_ap else []) or []))
            clean_existing = [u for u in existing if u not in used_urls]
            if clean_existing:
                selected_by_shop[sh.id] = clean_existing
                used_urls.update(clean_existing)
            else:
                selected_by_shop[sh.id] = []

        lib_state = {
            "code": sku_code,
            "brand": brand,
            "model": model,
            "name": prod_name,
            "spuCode": spu_code or "",
            "imgPrefix": pfx,
            "imageLane": image_lane,
            "formalPoolCount": 18 if image_lane == "bad" else 36,
            "query": query,
            "searchTier": "balanced",
            "items": all_items,
            "selectedByShop": selected_by_shop,
        }
        if is_in_stock_ready:
            _auto_deal_non_overlapping(lib_state, [s.id for s in shops], only_empty=True, per_shop=3)

        IMAGE_LIBRARIES[sku_code] = lib_state
        return lib_state
    finally:
        db.close()


def _effective_wave(item: dict[str, Any], tier: str) -> tuple[str, str]:
    """根据当前检索档位（strict/balanced/broad）与人工移入/移出裁决计算图片归属栏位。"""
    if item.get("humanWave") in ("recommended", "not_recommended"):
        hw = item["humanWave"]
        reason = item.get("humanReason") or ("人工复核移入推荐可使用" if hw == "recommended" else "人工移入不推荐使用")
        return hw, reason

    if item["defaultWave"] == "not_recommended":
        # 若切到宽松档（0.55），近邻低置信度（如 0.54）仍低于 0.55；而 LIB-6（0.60）会受档位控制
        return "not_recommended", item["machineReason"]

    threshold = TIER_THRESHOLDS.get(tier, 0.62)
    conf = float(item.get("confidence") or 1.0)
    if item["sourceType"] == "crawled_library" and conf < threshold:
        return "not_recommended", f"当前「{'严格档' if tier == 'strict' else '平衡档'}」要求置信度 ≥{threshold:.2f}（该图 {conf:.2f}，可切宽松档或人工移入推荐）"
    return "recommended", item["machineReason"]


def _auto_deal_non_overlapping(lib_state: dict[str, Any], shop_ids: list[str], *, only_empty: bool = False, per_shop: int = 3) -> None:
    tier = lib_state.get("searchTier") or "balanced"
    rec_urls = [it["url"] for it in lib_state["items"] if _effective_wave(it, tier)[0] == "recommended"]
    sel_map = lib_state["selectedByShop"]
    target_set = set(shop_ids)

    locked_urls: set[str] = set()
    targets: list[str] = []
    for sid, cur_list in sel_map.items():
        if sid not in target_set or (only_empty and cur_list):
            locked_urls.update(cur_list or [])
    for sid in shop_ids:
        cur_list = sel_map.get(sid) or []
        if only_empty and cur_list:
            continue
        targets.append(sid)

    avail = [u for u in rec_urls if u not in locked_urls]
    if not targets:
        return
    take_per = max(1, min(per_shop, len(avail) // max(1, len(targets)))) if len(avail) >= len(targets) else 1
    # 轮流发牌：保证每个店铺的首图和每一张图都互不重复
    for idx, sid in enumerate(targets):
        picked = []
        for j in range(take_per):
            pos = idx + j * len(targets)
            if pos < len(avail):
                picked.append(avail[pos])
        sel_map[sid] = picked


def _serialize_image_library(sku_code: str) -> dict[str, Any]:
    lib_state = _init_image_library_for_sku(sku_code)
    case = _get_or_init_case(sku_code)
    tier = lib_state.get("searchTier") or "balanced"

    db = _db()
    try:
        from app.enums import ShopListingStatus, SkuStatus
        from app.models import SaleShop, Sku, SkuShopListing
        from app.services import listing_approval as la

        sk = db.query(Sku).filter(Sku.sku_code == sku_code).first()
        shops = db.query(SaleShop).order_by(SaleShop.sort_order).all()

        # 反向索引：每张图当前被哪个店铺选定
        url_to_shop: dict[str, tuple[str, str]] = {}
        shop_lookup = {s.id: s.label for s in shops}
        for sid, urls in (lib_state.get("selectedByShop") or {}).items():
            for u in urls:
                if u not in url_to_shop:
                    url_to_shop[u] = (sid, shop_lookup.get(sid, sid))

        item_by_url = {it["url"]: it for it in lib_state["items"]}
        recommended: list[dict[str, Any]] = []
        not_recommended: list[dict[str, Any]] = []

        for it in lib_state["items"]:
            wave, rsn = _effective_wave(it, tier)
            picked = url_to_shop.get(it["url"])
            row = {
                "id": it["id"],
                "url": it["url"],
                "thumb": it["url"],
                "sourceType": it["sourceType"],
                "sourceLabel": it["sourceLabel"],
                "domain": it["domain"],
                "resolution": it["resolution"],
                "confidence": it["confidence"],
                "qualityGrade": it["qualityGrade"],
                "filterCode": it["filterCode"],
                "reason": rsn,
                "humanMoved": it.get("humanWave") is not None,
                "selectedShopId": picked[0] if picked else "",
                "selectedShopLabel": picked[1] if picked else "",
            }
            if wave == "recommended":
                recommended.append(row)
            else:
                not_recommended.append(row)

        # 组装第 3 栏：按店铺展示已经被选定的图片 + 当前售价 + 在架状态
        selected_shops_out: list[dict[str, Any]] = []
        seen_all: dict[str, str] = {}
        dup_warnings: list[str] = []
        rec_price = case.get("confirmedPrice") or (case.get("stats") or {}).get("recommendedPrice")

        for sh in shops:
            cur_ap = la.current(db, sk.id, sh.id) if sk else None
            listed_row = db.query(SkuShopListing).filter(
                SkuShopListing.sku_id == sk.id,
                SkuShopListing.sale_shop_id == sh.id,
                SkuShopListing.publish_status == ShopListingStatus.LISTED,
            ).first() if sk else None
            urls = list(lib_state["selectedByShop"].get(sh.id) or [])
            img_objs = []
            for idx, u in enumerate(urls):
                if u in seen_all:
                    dup_warnings.append(f"「{sh.label}」与「{seen_all[u]}」存在重复选图")
                else:
                    seen_all[u] = sh.label
                meta = item_by_url.get(u) or {}
                img_objs.append({
                    "url": u,
                    "thumb": u,
                    "isMain": idx == 0,
                    "sourceLabel": meta.get("sourceLabel") or "已选图片",
                })
            is_listed = listed_row is not None
            shop_price = int(cur_ap.price) if (cur_ap and cur_ap.price) else (int(rec_price) if rec_price else None)
            needs_fix = bool(is_listed and not (cur_ap and cur_ap.images))
            selected_shops_out.append({
                "shopId": sh.id,
                "label": sh.label,
                "listed": is_listed,
                "needsFix": needs_fix,
                "statusLabel": "在架待补选图" if needs_fix else ("已在架" if is_listed else ("已选好待上架" if img_objs else "待选图")),
                "price": shop_price,
                "images": img_objs,
            })

        st = case.get("stats") or {}
        return {
            "code": sku_code,
            "brand": lib_state["brand"],
            "model": lib_state["model"],
            "name": lib_state["name"],
            "spuCode": lib_state["spuCode"],
            "imageLane": lib_state.get("imageLane", "good"),
            "formalPoolCount": lib_state.get("formalPoolCount", 36),
            "query": lib_state["query"],
            "searchTier": tier,
            "tierThreshold": TIER_THRESHOLDS.get(tier, 0.62),
            "totalCrawled": len(lib_state["items"]),
            "recommended": recommended,
            "notRecommended": not_recommended,
            "selectedByShop": selected_shops_out,
            "collisionCheck": {
                "ok": len(dup_warnings) == 0,
                "warnings": dup_warnings,
                "totalSelected": sum(len(x["images"]) for x in selected_shops_out),
            },
            "priceSummary": {
                "cost": case["cost"],
                "cleanedAverage": st.get("cleanedAverage"),
                "recommendedPrice": st.get("recommendedPrice"),
                "confirmedPrice": case.get("confirmedPrice"),
                "median": st.get("median"),
                "lowest": st.get("lowest"),
                "highest": st.get("highest"),
                "validCount": st.get("validCount", 0),
                "rejectedCount": st.get("rejectedCount", 0),
                "dedupedCount": st.get("dedupedCount", 0),
                "queries": (case.get("spuPolicy") or {}).get("queries") or [case["model"]],
                "crawledAt": case.get("crawledAt") or "",
                "crawlBatch": case.get("crawlBatch", 1),
                "snapshotUrl": case.get("snapshotUrl") or "",
                "step": case.get("step"),
                "purchaseComparison": st.get("purchaseComparison") or {},
            },
        }
    finally:
        db.close()


@router.get("/api/wash-workflow/skus", summary="全量历史库存清洗 Gallery 总览（259件真实SKU / 165个SPU · 支持SPU归并 & 图池好坏分流）")
def list_wash_workflow_skus(u=Depends(get_current_user)):
    from app.enums import ShopListingStatus, SkuStatus
    from app.models import CrawlProduct, ListingApproval, SaleShop, Sku, SkuShopListing

    db = _db()
    try:
        shops = db.query(SaleShop).order_by(SaleShop.sort_order).all()
        skus = db.query(Sku).filter(Sku.status == SkuStatus.IN_STOCK).order_by(Sku.inbound_at.asc()).all()
        cp_map = {cp.name: float(cp.last_price) for cp in db.query(CrawlProduct).all() if cp.last_price is not None}
        for cp in db.query(CrawlProduct).all():
            if cp.keyword and cp.last_price is not None:
                cp_map.setdefault(cp.keyword, float(cp.last_price))

        # 一次性批量查询全部审批单与在架记录，保证 260+ 件全量历史库存毫秒级响应
        ap_by_pair: dict[tuple[Any, Any], Any] = {}
        for ap in db.query(ListingApproval).order_by(ListingApproval.version.asc()).all():
            ap_by_pair[(ap.sku_id, ap.sale_shop_id)] = ap

        listed_by_pair: dict[tuple[Any, Any], Any] = {}
        for lr in db.query(SkuShopListing).filter(SkuShopListing.publish_status == ShopListingStatus.LISTED).all():
            listed_by_pair[(lr.sku_id, lr.sale_shop_id)] = lr

        now = datetime.utcnow()
        out_items: list[dict[str, Any]] = []

        for sk in skus:
            if sk.reserve_source:
                continue
            code = sk.sku_code
            spu_dict = sk.spu if isinstance(sk.spu, dict) else {}
            spu_code = str(spu_dict.get("code") or "").strip()
            cat_name = spu_dict.get("category") or "显示器"
            exp_pfx = spu_dict.get("img_prefix") or ""
            img_lane = spu_dict.get("image_lane") or "good"

            # 若已加载精细 case / lib_state 则直接复用，否则轻量推演摘要（点进单品页再生成完整 36 条快照）
            case = CLEAN_CASES.get(code)
            lib_state = IMAGE_LIBRARIES.get(code)

            real_imgs = [str(x) for x in (sk.images or []) if "/inspection/listing/" in str(x)]
            mat_imgs = [str(x) for x in (sk.images or []) if "/sku/product/" in str(x)]
            pfx, _ = _img_prefix_for(sk.model or "", sk.product_name, explicit_pfx=exp_pfx)
            if pfx.startswith("V-"):
                pfx = "MON1"
            cover_url = real_imgs[0] if real_imgs else (mat_imgs[0] if mat_imgs else f"/api/demo-img/library/{pfx}-lib-1.jpg")
            cover_kind = "验货实拍" if real_imgs else ("同款素材" if mat_imgs else "精修大库图")

            if lib_state:
                tier = lib_state.get("searchTier") or "balanced"
                rec_cnt = sum(1 for it in lib_state["items"] if _effective_wave(it, tier)[0] == "recommended")
                not_rec_cnt = len(lib_state["items"]) - rec_cnt
                img_lane = lib_state.get("imageLane", img_lane)
                formal_pool_cnt = lib_state.get("formalPoolCount", 36)
            else:
                base_lib_cnt = 5 if img_lane == "bad" else 12
                rec_cnt = len(real_imgs) + min(3, len(mat_imgs)) + base_lib_cnt
                not_rec_cnt = 4 + sum(1 for x in (sk.images or []) if "/inspection/defect/" in str(x))
                formal_pool_cnt = 18 if img_lane == "bad" else 36

            listed_cnt = 0
            clean_listed_cnt = 0
            shop_pills: list[dict[str, Any]] = []
            first_ap_price = None
            for sh in shops:
                cur_ap = ap_by_pair.get((sk.id, sh.id))
                if cur_ap and cur_ap.price and not first_ap_price:
                    first_ap_price = int(cur_ap.price)
                listed_row = listed_by_pair.get((sk.id, sh.id))
                is_listed = listed_row is not None
                has_clean_imgs = bool(is_listed and ((listed_row.images and len(listed_row.images) > 0) or (cur_ap and cur_ap.images)))
                if is_listed:
                    listed_cnt += 1
                if has_clean_imgs:
                    clean_listed_cnt += 1
                sel_cnt = len((lib_state["selectedByShop"].get(sh.id) if lib_state else None) or (listed_row.images if listed_row and listed_row.images else None) or [1, 2, 3])
                shop_pills.append({
                    "shopId": sh.id,
                    "label": sh.label,
                    "listed": is_listed,
                    "hasCleanImgs": has_clean_imgs,
                    "selectedCount": sel_cnt,
                })

            total_selected = sum(p["selectedCount"] for p in shop_pills)
            if case:
                st = case.get("stats") or {}
                price_done = bool(case.get("step") == "active" and case.get("confirmedPrice"))
                crawlless = case.get("step") == "waiting_crawl" or not case.get("raw_samples")
                total_cards = len(case.get("raw_samples") or [])
                valid_cnt = st.get("validCount", 0)
                rej_cnt = st.get("rejectedCount", 0)
                cleaned_avg = st.get("cleanedAverage")
                rec_price = st.get("recommendedPrice")
                conf_price = case.get("confirmedPrice")
            else:
                crawlless = (sk.model == "25M2N3200W")
                mp = cp_map.get(f"{sk.brand or ''} {sk.model or ''}".strip()) or cp_map.get(sk.model or "") or float(sk.suggest_price or float(sk.cost_price or 300) * 1.42)
                cleaned_avg = None if crawlless else round(mp, 2)
                rec_price = None if crawlless else _int_yuan(mp)
                conf_price = first_ap_price if (clean_listed_cnt > 0 or first_ap_price) else None
                price_done = bool(conf_price)
                total_cards = 0 if crawlless else 36
                valid_cnt = 0 if crawlless else 25
                rej_cnt = 0 if crawlless else 11

            all_shops_done = len(shops) > 0 and clean_listed_cnt == len(shops) and price_done
            if crawlless:
                price_step = "waiting_crawl"
            elif price_done:
                price_step = "confirmed"
            else:
                price_step = "pending_price"

            if all_shops_done:
                overall_stage = "published"
                stage_rank = 2
            elif price_done:
                overall_stage = "step2_image"
                stage_rank = 1
            else:
                overall_stage = "step1_price"
                stage_rank = 0

            days = max(0, (now - sk.inbound_at).days) if sk.inbound_at else 0
            out_items.append({
                "code": code,
                "spuCode": spu_code or f"UNBOUND-{sk.model or code}",
                "spuBound": bool(spu_code),
                "category": cat_name,
                "brand": sk.brand or "",
                "model": sk.model or sk.product_name,
                "name": sk.product_name,
                "config": sk.spec or sk.condition_grade or "标准配置",
                "locationCode": sk.location_code or "—",
                "cost": float(sk.cost_price or 0),
                "stockAgeDays": days,
                "aged28d": days >= 28,
                "imageLane": img_lane,
                "formalPoolCount": formal_pool_cnt,
                "coverUrl": cover_url,
                "coverKind": cover_kind,
                "hasRealPhoto": len(real_imgs) > 0,
                "priceDone": price_done,
                "priceStep": price_step,
                "totalCards": total_cards,
                "validCount": valid_cnt,
                "rejectedCount": rej_cnt,
                "cleanedAverage": cleaned_avg,
                "recommendedPrice": rec_price,
                "confirmedPrice": conf_price,
                "imageDone": all_shops_done,
                "recommendedImgCount": rec_cnt,
                "notRecommendedImgCount": not_rec_cnt,
                "selectedImgCount": total_selected,
                "listedShopCount": clean_listed_cnt,
                "totalShopCount": len(shops),
                "shops": shop_pills,
                "overallStage": overall_stage,
                "stageRank": stage_rank,
            })

        out_items.sort(key=lambda x: (x["stageRank"], -x["stockAgeDays"], x["code"]))

        # 按 SPU 编码聚合（165 个真实 SPU，同 SPU 共享一套多关键词行情策略与精修图池）
        spu_map: dict[str, dict[str, Any]] = {}
        for it in out_items:
            skey = it["spuCode"]
            g = spu_map.get(skey)
            if not g:
                spu_map[skey] = {
                    "spuCode": skey,
                    "spuBound": it["spuBound"],
                    "category": it["category"],
                    "brand": it["brand"],
                    "model": it["model"],
                    "name": it["name"],
                    "leadSkuCode": it["code"],
                    "skuCodes": [it["code"]],
                    "skuCount": 1,
                    "maxAgeDays": it["stockAgeDays"],
                    "aged28d": it["aged28d"],
                    "imageLane": it["imageLane"],
                    "formalPoolCount": it["formalPoolCount"],
                    "coverUrl": it["coverUrl"],
                    "minCost": it["cost"],
                    "cleanedAverage": it["cleanedAverage"],
                    "recommendedPrice": it["recommendedPrice"],
                    "confirmedPrice": it["confirmedPrice"],
                    "overallStage": it["overallStage"],
                    "stageRank": it["stageRank"],
                    "publishedSkuCount": 1 if it["overallStage"] == "published" else 0,
                }
            else:
                g["skuCodes"].append(it["code"])
                g["skuCount"] += 1
                g["maxAgeDays"] = max(g["maxAgeDays"], it["stockAgeDays"])
                g["aged28d"] = g["aged28d"] or it["aged28d"]
                g["minCost"] = min(g["minCost"], it["cost"]) if it["cost"] else g["minCost"]
                if it["imageLane"] == "bad":
                    g["imageLane"] = "bad"
                    g["formalPoolCount"] = min(g["formalPoolCount"], it["formalPoolCount"])
                if it["overallStage"] == "published":
                    g["publishedSkuCount"] += 1
                if it["stageRank"] < g["stageRank"]:
                    g["stageRank"] = it["stageRank"]
                    g["overallStage"] = it["overallStage"]
                    g["leadSkuCode"] = it["code"]

        spu_groups = sorted(spu_map.values(), key=lambda x: (x["stageRank"], -x["skuCount"], -x["maxAgeDays"]))
        counts = {
            "all": len(out_items),
            "spu_total": len(spu_groups),
            "aged_28d": sum(1 for x in out_items if x["aged28d"]),
            "good_lane": sum(1 for x in out_items if x["imageLane"] == "good"),
            "bad_lane": sum(1 for x in out_items if x["imageLane"] == "bad"),
            "step1_price": sum(1 for x in out_items if x["overallStage"] == "step1_price"),
            "step2_image": sum(1 for x in out_items if x["overallStage"] == "step2_image"),
            "published": sum(1 for x in out_items if x["overallStage"] == "published"),
        }
        return {"items": out_items, "spuGroups": spu_groups, "counts": counts}
    finally:
        db.close()


@router.get("/api/image-library/skus/{code}", summary="查询大库图库三栏数据（推荐可使用 / 不推荐使用 / 已经被选定的图片）")
def get_sku_image_library(code: str, u=Depends(get_current_user)):
    return _serialize_image_library(code)


@router.post("/api/image-library/skus/{code}/move", summary="在「推荐可使用」与「不推荐使用」两波之间移动图片")
def move_library_image(code: str, body: dict, u=Depends(get_current_user)):
    lib_state = _init_image_library_for_sku(code)
    url = str(body.get("url") or "").strip()
    target = str(body.get("targetWave") or "").strip()
    reason = str(body.get("reason") or "").strip()
    if target not in ("recommended", "not_recommended"):
        raise HTTPException(400, "目标栏位必须是 recommended 或 not_recommended")
    it = next((x for x in lib_state["items"] if x["url"] == url), None)
    if not it:
        raise HTTPException(404, "未找到该图片")
    it["humanWave"] = target
    it["humanReason"] = reason or ("人工复核通过 · 移入推荐可使用" if target == "recommended" else "人工标记不可用 · 移入不推荐")
    # 若移入不推荐，自动从已选定栏移除，防止误发脏图
    if target == "not_recommended":
        for sid, urls in lib_state["selectedByShop"].items():
            if url in urls:
                urls.remove(url)
    return _serialize_image_library(code)


@router.post("/api/image-library/skus/{code}/select", summary="操作第3栏「已经被选定的图片」（选入/移除/设为主图/一键不重样配图）")
def select_library_image(code: str, body: dict, u=Depends(get_current_user)):
    lib_state = _init_image_library_for_sku(code)
    action = str(body.get("action") or "toggle").strip()
    shop_id = str(body.get("shopId") or "").strip()
    url = str(body.get("url") or "").strip()

    if action == "auto_assign":
        per_shop = int(body.get("perShop") or 3)
        target_shops = body.get("shopIds")
        if not target_shops:
            db = _db()
            try:
                from app.enums import ShopListingStatus
                from app.models import Sku, SkuShopListing
                sk = db.query(Sku).filter(Sku.sku_code == code).first()
                listed_sids: set[str] = set()
                if sk:
                    for row in db.query(SkuShopListing).filter(
                        SkuShopListing.sku_id == sk.id,
                        SkuShopListing.publish_status == ShopListingStatus.LISTED,
                    ).all():
                        if row.images:
                            listed_sids.add(row.sale_shop_id)
                            lib_state["selectedByShop"][row.sale_shop_id] = list(row.images)
                unlisted = [sid for sid in lib_state["selectedByShop"] if sid not in listed_sids]
                target_shops = unlisted if unlisted else list(lib_state["selectedByShop"].keys())
            finally:
                db.close()
        _auto_deal_non_overlapping(lib_state, target_shops, only_empty=False, per_shop=per_shop)
        return _serialize_image_library(code)

    if shop_id not in lib_state["selectedByShop"]:
        raise HTTPException(400, "请选择目标店铺")
    cur_list = lib_state["selectedByShop"][shop_id]

    if action == "clear_shop":
        cur_list.clear()
        return _serialize_image_library(code)

    if not url:
        raise HTTPException(400, "缺少图片地址")

    if action == "remove" or (action == "toggle" and url in cur_list):
        if url in cur_list:
            cur_list.remove(url)
        return _serialize_image_library(code)

    if action == "set_main":
        if url in cur_list:
            cur_list.remove(url)
        cur_list.insert(0, url)
        return _serialize_image_library(code)

    # action in ("add", "toggle"): 检查是否已被其他店铺占用（防铺货撞图）
    for other_sid, other_urls in lib_state["selectedByShop"].items():
        if other_sid != shop_id and url in other_urls:
            if body.get("forceMove"):
                other_urls.remove(url)
            else:
                db = _db()
                try:
                    from app.models import SaleShop
                    other_sh = db.query(SaleShop).filter(SaleShop.id == other_sid).first()
                    other_name = other_sh.label if other_sh else other_sid
                finally:
                    db.close()
                raise HTTPException(400, f"这张图已被「{other_name}」选定，多账号上架不能用同一张图（防平台判铺货）")

    if len(cur_list) >= 9:
        raise HTTPException(400, "单个闲鱼店铺最多选 9 张图片")

    # 如果是从「不推荐使用」破格选用，同步提拔进推荐池
    it = next((x for x in lib_state["items"] if x["url"] == url), None)
    if it:
        wave, _ = _effective_wave(it, lib_state.get("searchTier") or "balanced")
        if wave == "not_recommended":
            it["humanWave"] = "recommended"
            it["humanReason"] = "人工破格选用 · 已移入推荐并选定"

    if url not in cur_list:
        cur_list.append(url)
    return _serialize_image_library(code)


@router.post("/api/image-library/skus/{code}/search", summary="修改大库检索词或切换严格/平衡/宽松档位重新过滤")
def search_sku_image_library(code: str, body: dict, u=Depends(get_current_user)):
    lib_state = _init_image_library_for_sku(code)
    if "query" in body and str(body["query"]).strip():
        lib_state["query"] = str(body["query"]).strip()
    if "searchTier" in body and body["searchTier"] in TIER_THRESHOLDS:
        lib_state["searchTier"] = body["searchTier"]
    return _serialize_image_library(code)


@router.post("/api/image-library/skus/{code}/publish", summary="选几张图 + 确认闲鱼价格 → 一键直接洗净上架（无主管审批节点）")
def publish_from_library(code: str, body: dict, u=Depends(get_current_user)):
    from app.enums import ShopListingStatus, SkuStatus
    from app.models import CrawlPrice, CrawlProduct, ListingApproval, SaleShop, Sku, SkuAutoListing, SkuShopListing
    from app.services import listing_approval as la
    import workbench_stub as wb

    lib_state = _init_image_library_for_sku(code)
    case = _get_or_init_case(code)
    entries = body.get("shops") or []
    override_reason = str(body.get("overrideReason") or "").strip()
    if not entries:
        raise HTTPException(400, "请至少勾选一个要上架的店铺")

    db = _db()
    try:
        sk = db.query(Sku).filter(Sku.sku_code == code).first()
        if not sk:
            raise HTTPException(404, "商品不存在")
        if sk.status != SkuStatus.IN_STOCK or sk.reserve_source:
            raise HTTPException(400, "该商品已锁单或已出库，不能再上架")

        cost = float(sk.cost_price or 0)
        shop_map = {s.id: s for s in db.query(SaleShop).order_by(SaleShop.sort_order).all()}

        # 收集未参与本次提交但已在架的店铺图片，确保跨店零撞图
        submitting_ids = {str(e.get("shopId") or e.get("shop_id")) for e in entries}
        seen_urls: dict[str, str] = {}
        for sh in shop_map.values():
            if sh.id in submitting_ids:
                continue
            listed_row = db.query(SkuShopListing).filter(
                SkuShopListing.sku_id == sk.id,
                SkuShopListing.sale_shop_id == sh.id,
                SkuShopListing.publish_status == ShopListingStatus.LISTED,
            ).first()
            if listed_row and listed_row.images:
                for u0 in la.clean_images(listed_row.images):
                    seen_urls[u0] = sh.label

        unified_fallback_price = _int_yuan(
            body.get("price")
            or case.get("confirmedPrice")
            or (case.get("stats") or {}).get("recommendedPrice")
            or 0
        )
        validated: list[tuple[Any, int, list[str]]] = []
        for entry in entries:
            sid = str(entry.get("shopId") or entry.get("shop_id") or "")
            sh = shop_map.get(sid)
            if not sh:
                raise HTTPException(404, f"店铺 {sid} 不存在")
            price = _int_yuan(entry.get("price") or unified_fallback_price or 0)
            if price <= 0:
                raise HTTPException(400, f"还没有确认商品售价，请先完成第 1 步「洗价格」确认售价后再上架")
            if cost > 0 and price < cost and len(override_reason) < 2:
                raise HTTPException(400, f"「{sh.label}」售价 ¥{price} 低于采购成本 ¥{_int_yuan(cost)}（价格围栏拦截），如属清仓请注明原因")

            raw_imgs = entry.get("images")
            if raw_imgs is None:
                raw_imgs = lib_state["selectedByShop"].get(sid) or []
            clean_imgs = la.clean_images([i.get("url") if isinstance(i, dict) else str(i) for i in raw_imgs if i])
            if not clean_imgs:
                raise HTTPException(400, f"「{sh.label}」还没有选定图片，请先在左栏点选几张推荐图")
            for u0 in clean_imgs:
                if u0 in seen_urls:
                    raise HTTPException(400, f"「{sh.label}」选定的图片与「{seen_urls[u0]}」重复，请换一张避免铺货判罚")
                seen_urls[u0] = sh.label

            en = wb._ent_of_shop(sh.label)
            if en and wb._ent_state(en) == "red":
                raise HTTPException(400, f"「{sh.label}」当前排期已满（暂停派新），请改选其他空闲店铺")

            validated.append((sh, price, clean_imgs))

        published_labels: list[str] = []
        first_price = validated[0][1]
        for sh, price, clean_imgs in validated:
            lib_state["selectedByShop"][sh.id] = list(clean_imgs)
            already = db.query(SkuShopListing).filter(
                SkuShopListing.sku_id == sk.id,
                SkuShopListing.sale_shop_id == sh.id,
                SkuShopListing.publish_status == ShopListingStatus.LISTED,
            ).first()
            used_n = db.query(SkuShopListing).filter(
                SkuShopListing.sale_shop_id == sh.id,
                SkuShopListing.publish_status == ShopListingStatus.LISTED,
            ).count() + wb.S.setdefault("quota_extra", {}).get(sh.id, 0)
            if not already and used_n >= wb.RULES["publish"]["quota"]:
                raise HTTPException(400, f"「{sh.label}」今日已发满 10 票，第 11 票顺延明日")

            cur_ap = la.current(db, sk.id, sh.id)
            ap_row = ListingApproval(
                sku_id=sk.id,
                sale_shop_id=sh.id,
                version=(cur_ap.version + 1) if cur_ap else 1,
                status="APPROVED",
                price=Decimal(str(price)),
                images=clean_imgs,
                cost_price=sk.cost_price,
                min_cost_ratio=Decimal("1.0"),
                market_price=Decimal(str(price)),
                market_basis="闲鱼快照清洗均价确认",
                note=override_reason or "大库选图+闲鱼核价直接上架",
                edited_by=u.id,
                submitted_by=u.id,
                submitted_at=datetime.utcnow(),
                reviewed_by=u.id,
                reviewed_at=datetime.utcnow(),
                review_note="人工确认选图与价格直接上架",
            )
            db.add(ap_row)
            db.flush()
            if already:
                already.listing_approval_id = ap_row.id
                already.images = clean_imgs
            else:
                db.add(SkuShopListing(
                    sku_id=sk.id,
                    sale_shop_id=sh.id,
                    publish_status=ShopListingStatus.LISTED,
                    gc_account_id=sh.gc_account_id,
                    listing_approval_id=ap_row.id,
                    images=clean_imgs,
                ))
            wb.S["undo"][(code, sh.id)] = wb.NOW() + wb.RULES["publish"]["undo_sec"]
            published_labels.append(sh.label)

        # 同步更新商品建议价、自动上架流水线状态与行情表
        sk.suggest_price = Decimal(str(first_price))
        gap = db.query(SkuAutoListing).filter(SkuAutoListing.sku_id == sk.id).first()
        if gap:
            gap.stage = "READY"
            gap.last_error = "已完成选图与核价并直接上架"

        if sk.model:
            today = date.today()
            cp = db.query(CrawlProduct).filter(CrawlProduct.name == sk.model).first()
            if cp is None:
                cp = CrawlProduct(name=sk.model, keyword=sk.model, enabled=True, last_price=Decimal(str(first_price)), last_price_date=today, note="人工确认清洗价")
                db.add(cp)
                db.flush()
            else:
                cp.last_price = Decimal(str(first_price))
                cp.last_price_date = today
            c_row = db.query(CrawlPrice).filter(CrawlPrice.product_id == cp.id, CrawlPrice.crawl_date == today).first()
            inc_prices = sorted(float(x["price"]) for x in case["raw_samples"] if x.get("include"))
            raw_meta = {
                "source": "cleaned_average",
                "cleanedAverage": (case.get("stats") or {}).get("cleanedAverage"),
                "medianPrice": (case.get("stats") or {}).get("median"),
                "validCount": len(inc_prices),
                "validPrices": inc_prices,
                "snapshotId": case["snapshotId"],
            }
            if c_row is None:
                db.add(CrawlPrice(product_id=cp.id, crawl_date=today, price=Decimal(str(first_price)), raw=raw_meta))
            else:
                c_row.price = Decimal(str(first_price))
                c_row.raw = raw_meta

        db.commit()
        from types import SimpleNamespace
        sk_snap = SimpleNamespace(
            brand=sk.brand,
            model=sk.model,
            product_name=sk.product_name,
            cost_price=float(sk.cost_price or 0),
        )
    finally:
        db.close()

    gc_jobs = []
    try:
        import gc_stub
        gc_jobs = gc_stub.enqueue_publish_from_wash(code, sk_snap, validated, getattr(u, "name", u.username))
    except Exception:
        gc_jobs = []

    # 同步 CLEAN_CASES 版本状态
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
    ver_num = len(case["versions"]) + 1
    ver = {
        "version": ver_num,
        "price": first_price,
        "priceType": "清洗均价确认",
        "cleanedAverage": (case.get("stats") or {}).get("cleanedAverage"),
        "median": (case.get("stats") or {}).get("median"),
        "samplesCount": (case.get("stats") or {}).get("validCount", 0),
        "confirmedBy": getattr(u, "name", u.username),
        "confirmedAt": now_str,
        "validUntil": (datetime.now() + timedelta(days=7)).strftime("%Y-%m-%d"),
        "overrideReason": override_reason,
        "note": f"选图核价直发：{'、'.join(published_labels)}",
    }
    case["versions"].append(ver)
    case["activeVersion"] = ver
    case["confirmedPrice"] = first_price
    case["reviewedBy"] = ver["confirmedBy"]
    case["reviewedAt"] = now_str
    case["step"] = "active"

    imm_cnt = len([j for j in gc_jobs if j.get("status") == "SUCCESS"])
    sch_cnt = len([j for j in gc_jobs if j.get("status") == "SCHEDULED"])
    gc_note = ""
    if gc_jobs:
        gc_note = f"（AdsPower 群控队列：{imm_cnt} 票已立即发至网页端" + (f"，{sch_cnt} 票按 25 分钟防限流错峰排期" if sch_cnt else "") + "）"

    return {
        "ok": True,
        "published": published_labels,
        "gcJobs": gc_jobs,
        "undo_sec": wb.RULES["publish"]["undo_sec"],
        "msg": f"已完成清洗并排入 AdsPower 群控上架：{len(published_labels)} 个店铺（{'、'.join(published_labels)}）{gc_note}",
        "library": _serialize_image_library(code),
    }


# ==================================================================
# 提成聚合与全局初始化
# ==================================================================
def _compute_commission_ledger() -> list[dict]:
    import workbench_stub as wb
    import virtual_stub as vs

    existing_state = {r["id"]: r for r in COMMISSION}
    rows: list[dict] = []

    db = _db()
    sku_cost: dict[str, float] = {}
    try:
        from app.models import Sku
        for s in db.query(Sku).all():
            sku_cost[s.sku_code] = float(s.cost_price or 0)
    finally:
        db.close()

    for o in wb.ORDERS:
        if o.get("s_status") not in ("shipped", "callback_failed"):
            continue
        code = o.get("sku") or ""
        cost = float(sku_cost.get(code, 0))
        if not cost and "24B1U5301H" in o.get("title", ""):
            cost = 330.0
        elif not cost and "小爱音箱" in o.get("title", ""):
            cost = 150.0
        elif not cost and "HD08" in o.get("title", ""):
            cost = 900.0
        fees = wb.S.get("order_fees", {}).get(o["id"], {})
        fee_sum = sum(float(fees.get(k) or 0) for k in ("platform", "shipping", "repair", "other"))
        refund = float(fees.get("refund") or 0)
        recv = float(fees.get("receivable") or 0) or float(o.get("amount") or 0)
        margin = round(max(0.0, recv - cost - fee_sum - refund), 2)
        amt = round(margin * 0.10, 2)
        cid = f"CM-P-{o['id']}"
        prev = existing_state.get(cid, {})
        is_ref = refund > 0 or bool(prev.get("manual_refund"))
        st = "已扣回" if is_ref else prev.get("state") or ("已确认" if o.get("s_status") == "shipped" else "待确认")
        rows.append({
            "id": cid, "order": o["id"], "sku": code, "product": o["title"], "owner": o.get("owner") or "chenxm",
            "type": "成交提成", "base": margin, "rate": 0.10, "amount": amt, "state": st,
            "refund": is_ref, "manual_refund": bool(prev.get("manual_refund")),
            "at": o.get("paid", "近期"), "cost": cost, "fees": fee_sum,
        })

    for p in vs.DB.values():
        deliv_rate = 0.20 if p.get("kind") == "svc" else 0.10
        unit_margin = round(max(0.0, float(p.get("price") or 0) - float(p.get("cost") or 0) - float(p.get("price") or 0) * float(p.get("platform_fee_rate") or 0.03) - float(p.get("after_sale_reserve") or 0)), 2)
        for o in p.get("orders", []):
            if o.get("status") not in ("delivered", "done"):
                continue
            oid = f"V-{o['id']}"
            fees = wb.S.get("order_fees", {}).get(oid, {})
            extra_fee = sum(float(fees.get(k) or 0) for k in ("platform", "shipping", "repair", "other"))
            extra_ref = float(fees.get("refund") or 0)
            margin = round(max(0.0, unit_margin - extra_fee - extra_ref), 2) if float(o.get("amount") or 0) > 0 else unit_margin
            cid = f"CM-V-{o['id']}"
            prev = existing_state.get(cid, {})
            is_ref = bool(o.get("refund")) or extra_ref > 0 or bool(prev.get("manual_refund"))
            st = "已扣回" if is_ref else prev.get("state") or ("待确认" if o.get("paid_ago_min", 99) < 120 else "已确认")
            rows.append({
                "id": cid, "order": oid, "sku": p["code"], "product": p["name"], "owner": "chenxm",
                "type": "成交提成", "base": margin, "rate": deliv_rate, "amount": round(margin * deliv_rate, 2),
                "state": st, "refund": is_ref, "manual_refund": bool(prev.get("manual_refund")), "at": "近期",
            })
            crid = f"CM-C-{o['id']}"
            prev_c = existing_state.get(crid, {})
            st_c = "已扣回" if is_ref else prev_c.get("state") or st
            rows.append({
                "id": crid, "order": oid, "sku": p["code"], "product": p["name"], "owner": "zhoubb",
                "type": "建卡人分成", "base": margin, "rate": 0.05, "amount": round(margin * 0.05, 2),
                "state": st_c, "refund": is_ref, "manual_refund": bool(prev_c.get("manual_refund")), "at": "近期",
            })
        if p["id"] in ("v-game", "v-pzh"):
            aid = f"CM-AW-{p['id']}"
            prev_a = existing_state.get(aid, {})
            award_amt = 100.0 if p.get("listing_type") == "route" else 20.0
            rows.append({
                "id": aid, "order": "—", "sku": p["code"], "product": p["name"], "owner": "chenxm",
                "type": "上新奖", "base": 200.0 if p.get("listing_type") == "route" else 20.0,
                "rate": 0.5 if p.get("listing_type") == "route" else 1.0,
                "amount": award_amt, "state": prev_a.get("state") or ("待确认" if p["id"] == "v-game" else "已确认"),
                "refund": bool(prev_a.get("manual_refund")), "manual_refund": bool(prev_a.get("manual_refund")), "at": "11-10",
            })
    return rows


def sync_commission_summary():
    import workbench_stub as wb

    COMMISSION[:] = _compute_commission_ledger()
    ok_sum = round(sum(r["amount"] for r in COMMISSION if r["state"] == "已确认" and not r["refund"]), 2)
    pend_sum = round(sum(r["amount"] for r in COMMISSION if r["state"] == "待确认" and not r["refund"]), 2)
    for uname in ("chenxm", "zhoubb", "admin"):
        wb.S["commission"][uname] = {
            "day_ok": round(ok_sum * 0.25, 2),
            "day_pend": round(pend_sum * 0.5, 2),
            "mon_ok": round(ok_sum, 2),
            "mon_pend": round(pend_sum, 2),
        }
        wb.S["ledger"][uname] = [
            {"t": r["at"], "src": f"{r['product']} · {r['type']}", "amt": -r["amount"] if r["refund"] else r["amount"],
             "st": "ok" if r["state"] == "已确认" else "pend"}
            for r in COMMISSION[:6]
        ]


def reset_state():
    CLEAN_CASES.clear()
    IMAGE_LIBRARIES.clear()
    PRICEBOOK[:] = copy.deepcopy(_default_pricebook())
    INQUIRIES[:] = copy.deepcopy(_default_inquiries())
    EXTRAS_STORE.clear()
    if _CTX["Session"] is not None:
        db = _db()
        try:
            from app.models import CrawlProduct, ListingApproval, Sku
            cp_map = {}
            for cp in db.query(CrawlProduct).all():
                if cp.last_price is not None:
                    cp_map[cp.name] = float(cp.last_price)
                    if cp.keyword:
                        cp_map.setdefault(cp.keyword, float(cp.last_price))
            ap_sale: dict[Any, float] = {}
            for ap in db.query(ListingApproval).all():
                if ap.price:
                    ap_sale[ap.sku_id] = float(ap.price)
            now = datetime.utcnow()
            all_skus = db.query(Sku).order_by(Sku.sku_code).all()
            # 预热核心样板 + 代表性历史库存（其余 200+ 件支持按需毫秒级懒加载，兼顾秒级启动与5大队列丰富样本）
            showcase_codes = {
                "990001540233-A", "990001540233-B", "990001540215", "990001540009",
                "990001540213", "990001540203", "DEMO-PUR-LITE-01", "990001549229",
                "990001540026", "990001540232",
            }
            for idx, sk in enumerate(all_skus):
                if sk.sku_code not in showcase_codes and idx >= 38:
                    continue
                market = cp_map.get(f"{sk.brand or ''} {sk.model or ''}".strip()) or cp_map.get(sk.model or "")
                days = max(0, (now - sk.inbound_at).days) if sk.inbound_at else 0
                crawlless = (sk.model == "25M2N3200W")
                spu_c = (sk.spu or {}).get("code") if isinstance(sk.spu, dict) else ""
                c = _seed_cleaning_case(
                    sk.sku_code, sk.product_name, sk.model or sk.product_name,
                    sk.spec or sk.condition_grade or "标准配置",
                    float(sk.cost_price or 0), market, days,
                    brand=sk.brand or "",
                    spu_code=spu_c or "",
                    api_suggest_price=float(sk.suggest_price) if sk.suggest_price else None,
                    api_current_sale_price=ap_sale.get(sk.id),
                    crawlless=crawlless,
                )
                # 演示滑块风控队列与低于成本队列代表样板
                if sk.sku_code == "DEMO-PUR-LITE-01":
                    # 模拟市场下跌触发低于采购成本围栏，进入「失败·低于成本」队列供演示人工复核
                    for s in c["raw_samples"]:
                        if s.get("include"):
                            s["price"] = max(160, round(float(s["price"]) * 0.62))
                    _machine_screen(c)
                elif sk.sku_code == "990001540213":
                    # 模拟离散度偏高（>25%）触发「待复核」门禁样板
                    inc_list = [s for s in c["raw_samples"] if s.get("include")]
                    if len(inc_list) >= 4:
                        inc_list[0]["price"] = round(float(inc_list[0]["price"]) * 0.78)
                        inc_list[-1]["price"] = round(float(inc_list[-1]["price"]) * 1.18)
                    _machine_screen(c)
                CLEAN_CASES[sk.sku_code] = c
        finally:
            db.close()
        for pb in PRICEBOOK:
            if pb["id"] not in CLEAN_CASES:
                CLEAN_CASES[pb["id"]] = _seed_cleaning_case(
                    pb["id"], f"{pb['model']} {pb['config']}", pb["model"], pb["config"],
                    float(pb["paid"] or pb["deal"] or pb["ref"] or 1000), float(pb["ref"] or pb["suggest"] or 1200), 0,
                    spu_code=f"SPU-{pb['id']}",
                    api_suggest_price=float(pb["suggest"] or 0) or None,
                    api_current_sale_price=float(pb["ref"] or 0) or None,
                )
        # 典型防呆样板 1：2K 240Hz 走量屏在闲鱼错爬成 ¥200（混入75Hz老款/漏液屏），触发基准+模型反推标红阻断
        err_case = _seed_cleaning_case(
            "SEL-2K240-ERR200",
            "泰坦军团 P2710S 27英寸 2K 240Hz Fast IPS",
            "P2710S",
            "27英寸 / 2560x1440 / 240Hz / Fast IPS",
            0.0,
            200.0,
            0,
            brand="泰坦军团",
            spu_code="SPU-P2710S-2K240",
        )
        err_case["spuPolicy"]["minListingPrice"] = None
        if isinstance(err_case["spuPolicy"].get("fence"), dict):
            err_case["spuPolicy"]["fence"]["minListingPrice"] = None
        for idx_s, s in enumerate(err_case["raw_samples"]):
            if s.get("include"):
                s["price"] = 198 + (idx_s % 5)
                s["title"] = "泰坦军团 P2710S 显示器 27寸闲置自用正常出（卖家标错后缀，实为75Hz办公老款）"
        _machine_screen(err_case)
        CLEAN_CASES["SEL-2K240-ERR200"] = err_case

        # 典型兜底样板 2：1万型号库中冷门无在售 2K 200Hz(OC) 二线走量屏，触发 95% 走量规格桶兜底
        cold_case = _seed_cleaning_case(
            "SEL-2K180-FALLBACK",
            "科睿 G2721P 27英寸 2K 200Hz(OC) Fast IPS",
            "G2721P",
            "27英寸 / 2560x1440 / 200Hz / Fast IPS",
            0.0,
            518.0,
            0,
            brand="科睿",
            spu_code="SPU-G2721P-2K200",
            crawlless=True,
        )
        CLEAN_CASES["SEL-2K180-FALLBACK"] = cold_case
        sync_commission_summary()


_CATALOG_INDEX: dict[str, dict[str, Any]] | None = None


def _lookup_catalog_model(code: str) -> dict[str, Any] | None:
    global _CATALOG_INDEX
    if _CATALOG_INDEX is None:
        _CATALOG_INDEX = {}
        import json as _json
        import os as _os
        _here = _os.path.dirname(_os.path.abspath(__file__))
        for _cand in (
            _os.path.join(_here, "..", "前端", "public", "data", "catalog-snapshot.json"),
            _os.path.join(_here, "..", "dist", "data", "catalog-snapshot.json"),
        ):
            if _os.path.exists(_cand):
                with open(_cand, "r", encoding="utf-8") as _f:
                    _snap = _json.load(_f)
                for _m in _snap.get("mk", []):
                    _n = str(_m.get("n") or "").strip()
                    if _n:
                        _CATALOG_INDEX[_n.upper()] = _m
                        _parts = _n.split(None, 1)
                        if len(_parts) == 2:
                            _CATALOG_INDEX.setdefault(_parts[1].upper(), _m)
                break
    return _CATALOG_INDEX.get(str(code or "").strip().upper())


def _get_or_init_case(code: str) -> dict[str, Any]:
    if code in CLEAN_CASES:
        return CLEAN_CASES[code]
    db = _db()
    try:
        from app.models import CrawlProduct, ListingApproval, Sku
        sk = db.query(Sku).filter((Sku.sku_code == code) | (Sku.model == code)).first()
        if sk:
            cp = db.query(CrawlProduct).filter(
                (CrawlProduct.name == f"{sk.brand or ''} {sk.model or ''}".strip())
                | (CrawlProduct.name == (sk.model or ""))
                | (CrawlProduct.keyword == (sk.model or ""))
            ).first()
            ap = db.query(ListingApproval).filter(ListingApproval.sku_id == sk.id).order_by(ListingApproval.version.desc()).first()
            market = float(cp.last_price) if (cp and cp.last_price is not None) else None
            days = max(0, (datetime.utcnow() - sk.inbound_at).days) if sk.inbound_at else 0
            spu_c = (sk.spu or {}).get("code") if isinstance(sk.spu, dict) else ""
            c = _seed_cleaning_case(
                sk.sku_code, sk.product_name, sk.model or sk.product_name,
                sk.spec or "标准配置", float(sk.cost_price or 0), market, days,
                brand=sk.brand or "",
                spu_code=spu_c or "",
                api_suggest_price=float(sk.suggest_price) if sk.suggest_price else None,
                api_current_sale_price=float(ap.price) if (ap and ap.price) else None,
                crawlless=(sk.model == "25M2N3200W"),
            )
            CLEAN_CASES[sk.sku_code] = c
            CLEAN_CASES[code] = c
            return c
        cp_only = db.query(CrawlProduct).filter((CrawlProduct.name == code) | (CrawlProduct.keyword == code)).first()
        if cp_only:
            c = _seed_cleaning_case(
                code, cp_only.name, cp_only.keyword or cp_only.name, "选品库参考配置",
                0.0, float(cp_only.last_price) if cp_only.last_price is not None else 900.0, 0,
                spu_code=f"CAT-{code}",
            )
            CLEAN_CASES[code] = c
            return c
    finally:
        db.close()
    pb = next((x for x in PRICEBOOK if x["id"] == code or x["model"] == code), None)
    if pb:
        c = _seed_cleaning_case(
            pb["id"], f"{pb['model']} {pb['config']}", pb["model"], pb["config"],
            float(pb["paid"] or pb["deal"] or pb["ref"] or 500), float(pb["ref"] or pb["suggest"] or 700), 0,
            spu_code=f"SPU-{pb['id']}",
        )
        CLEAN_CASES[code] = c
        return c
    cat_m = _lookup_catalog_model(code)
    if cat_m:
        from spec_baseline_engine import infer_brand_and_model
        raw_n = str(cat_m.get("n") or code)
        raw_s = str(cat_m.get("s") or "选品型号库同步")
        br, md = infer_brand_and_model(raw_n)
        has_p = bool(cat_m.get("p"))
        ev0 = evaluate_monitor_pricing(raw_n, raw_s, float(cat_m["p"]) if has_p else None, br)
        c = _seed_cleaning_case(
            code,
            f"{br} {md}".strip() if br else raw_n,
            md or code,
            raw_s,
            0.0,
            float(cat_m["p"]) if has_p else float(ev0.get("fallbackSalePrice") or 650.0),
            0,
            brand=br,
            spu_code=f"CAT-{md or code}",
            crawlless=not has_p,
        )
        CLEAN_CASES[code] = c
        return c
    c = _seed_cleaning_case(code, code, code, "选品型号现采", 0.0, 990.0, 0, spu_code=f"CAT-{code}")
    CLEAN_CASES[code] = c
    return c


def _sibling_codes_for_spu(spu_code: str, exclude_code: str = "") -> list[str]:
    if not spu_code or spu_code.startswith("UNBOUND-"):
        return []
    out = []
    for k, c in CLEAN_CASES.items():
        if k != exclude_code and c.get("spuCode") == spu_code and k == c.get("code"):
            out.append(k)
    return out


def _case_out(c: dict[str, Any]) -> dict[str, Any]:
    spu_code = c.get("spuCode") or f"UNBOUND-{c['code']}"
    return {
        "code": c["code"],
        "spuCode": spu_code,
        "siblingCodes": _sibling_codes_for_spu(spu_code, exclude_code=c["code"]),
        "brand": c.get("brand") or "",
        "model": c["model"],
        "name": c["name"],
        "config": c["config"],
        "cost": c["cost"],
        "floor": c["floor"],
        "ratio": c["ratio"],
        "stockAgeDays": c["stockAgeDays"],
        "crawlBatch": c.get("crawlBatch", 1),
        "snapshotId": c["snapshotId"],
        "snapshotUrl": c["snapshotUrl"],
        "crawledAt": c["crawledAt"],
        "spuPolicy": copy.deepcopy(c.get("spuPolicy") or {}),
        "queryRuns": copy.deepcopy(c.get("queryRuns") or []),
        "perQueryLogs": copy.deepcopy(c.get("perQueryLogs") or []),
        "candidatePreview": copy.deepcopy(c.get("candidatePreview") or {}),
        "aiSuggestion": copy.deepcopy(c.get("aiSuggestion")),
        "aiWebSearchResults": copy.deepcopy(c.get("aiWebSearchResults") or []),
        "wmsWritebacks": copy.deepcopy(c.get("wmsWritebacks") or []),
        "strategy": dict(c["strategy"]),
        "stats": copy.deepcopy(c.get("stats") or {}),
        "baselineEval": copy.deepcopy(c.get("baselineEval") or {}),
        "samples": copy.deepcopy(c["raw_samples"]),
        "versions": copy.deepcopy(c["versions"]),
        "invalidatedHistory": copy.deepcopy(c.get("invalidatedHistory") or []),
        "activeVersion": copy.deepcopy(c["activeVersion"]),
        "confirmedPrice": c["confirmedPrice"],
        "overrideReason": c["overrideReason"],
        "reviewNote": c["reviewNote"],
        "reviewedBy": c["reviewedBy"],
        "reviewedAt": c["reviewedAt"],
        "step": c["step"],
    }


# ==================================================================
# 1. 闲鱼真实搜索页 HTML 快照（高保真复刻 goofish.com/search + goofish.js .xianyu-blacklist-card）
# ==================================================================
@router.get("/api/demo/snapshots/{snap_id}", response_class=HTMLResponse, summary="渲染闲鱼爬虫原始搜索页 DOM 快照")
def render_snapshot(snap_id: str, q: str = "all", focus: str | None = None):
    code = snap_id[5:] if snap_id.startswith("SNAP-") else snap_id
    case = _get_or_init_case(code)
    return HTMLResponse(render_authentic_goofish_dom_snapshot(case, q=q, focus=focus))


# ==================================================================
# 2. xianyu-seller-pilot v0.2.0 闲鱼快照价格清洗 API（5大队列 / 6大品类 / SPU 12词策略 / AI纠改 / 联网核查 / WMS回写）
# ==================================================================
@router.get("/api/price-clean/category-modes", summary="获取6大品类全局搜索拆词/组合规则")
def api_get_category_modes(u=Depends(get_current_user)):
    return {"items": get_category_search_modes()}


@router.put("/api/price-clean/category-modes", summary="保存6大品类全局搜索拆词/组合规则并同步继承态SPU")
def api_put_category_modes(body: dict, u=Depends(get_current_user)):
    modes = body.get("modes") if isinstance(body.get("modes"), dict) else body
    saved = save_category_search_modes(modes)
    for c in CLEAN_CASES.values():
        pol = c.get("spuPolicy") or {}
        if ((pol.get("search") or {}).get("mode") or "inherit_category") == "inherit_category":
            c["spuPolicy"] = enrich_spu_policy(
                pol,
                spu_key=c.get("spuCode") or c["code"],
                sku_code=c["code"],
                brand=c.get("brand") or "",
                model=c["model"],
                name=c["name"],
            )
            _machine_screen(c)
    return {"ok": True, "items": saved}


@router.get("/api/price-clean/skus", summary="全部型号与货号的价格清洗进度 + 5大任务队列统计")
def list_cleaning_cases(u=Depends(get_current_user)):
    seen_codes: set[str] = set()
    items = []
    q_counts = {
        "all": 0,
        "failed": 0,
        "failed_empty": 0,
        "failed_invalid_price": 0,
        "failed_risk_control": 0,
        "pending": 0,
        "success": 0,
        "success_100_119": 0,
        "success_120_plus": 0,
        "success_150_plus": 0,
        "success_200_plus": 0,
        "review": 0,
    }
    for k, c in CLEAN_CASES.items():
        real_code = c["code"]
        if real_code in seen_codes:
            continue
        seen_codes.add(real_code)
        st = c.get("stats") or {}
        cp = c.get("candidatePreview") or compute_v020_candidate_preview_and_logs(c)
        qb = cp.get("queueBucket") or "success"
        sb = cp.get("subBucket") or ""
        q_counts["all"] += 1
        if qb in q_counts:
            q_counts[qb] += 1
        if qb == "failed" and f"failed_{sb}" in q_counts:
            q_counts[f"failed_{sb}"] += 1
        elif qb == "success":
            short_sb = sb.replace("purchase_", "")
            if f"success_{short_sb}" in q_counts:
                q_counts[f"success_{short_sb}"] += 1

        items.append({
            "code": real_code,
            "spuCode": c.get("spuCode") or "",
            "brand": c.get("brand") or "",
            "model": c["model"],
            "name": c["name"],
            "displayName": ((c.get("spuPolicy") or {}).get("localization") or {}).get("displayName") or c["name"],
            "cost": c["cost"],
            "floor": c["floor"],
            "cleanedAverage": st.get("cleanedAverage"),
            "median": st.get("median"),
            "recommendedPrice": st.get("recommendedPrice"),
            "confirmedPrice": c["confirmedPrice"],
            "step": c["step"],
            "queueBucket": qb,
            "subBucket": sb,
            "queueLabel": cp.get("queueLabel") or "",
            "reviewOnly": bool(cp.get("reviewOnly")),
            "reviewReasons": cp.get("reviewReasons") or [],
            "baselineTrack": (c.get("baselineEval") or {}).get("track") or "",
            "sanityBlocked": bool((c.get("baselineEval") or {}).get("sanityBlocked")),
            "includedCount": st.get("validCount", 0),
            "rejectedCount": st.get("rejectedCount", 0),
            "queryCount": len((c.get("spuPolicy") or {}).get("effectiveQueries") or []),
            "stockAgeDays": c["stockAgeDays"],
            "crawledAt": c["crawledAt"],
        })
    return {"items": items, "queueCounts": q_counts}


@router.get("/api/price-clean/skus/{code}", summary="获取单个货号/型号的闲鱼快照 + 五重筛选与预计算均价详情")
def get_cleaning_case(code: str, u=Depends(get_current_user)):
    c = _get_or_init_case(code)
    return _case_out(c)


def _sync_spu_policy_to_siblings(source_case: dict[str, Any], sync_samples: bool = False) -> None:
    spu_code = source_case.get("spuCode") or ""
    if not spu_code or spu_code.startswith("UNBOUND-"):
        return
    for sib_code in _sibling_codes_for_spu(spu_code, exclude_code=source_case["code"]):
        sib = CLEAN_CASES.get(sib_code)
        if not sib:
            continue
        sib["spuPolicy"] = copy.deepcopy(source_case["spuPolicy"])
        if sync_samples:
            sib["raw_samples"] = copy.deepcopy(source_case["raw_samples"])
            sib["queryRuns"] = copy.deepcopy(source_case["queryRuns"])
            sib["dedupedCount"] = source_case.get("dedupedCount", 0)
            sib["crawledAt"] = source_case.get("crawledAt", "")
            sib["crawlBatch"] = source_case.get("crawlBatch", 1)
            if not sib.get("confirmedPrice"):
                sib["step"] = "human_review"
        _machine_screen(sib)


def _apply_spu_policy_patch(c: dict[str, Any], patch: dict[str, Any]) -> None:
    pol = c.setdefault("spuPolicy", {})
    spu_key = c.get("spuCode") or c["code"]
    c["spuPolicy"] = apply_v020_spu_policy_patch(
        pol,
        patch,
        spu_key=spu_key,
        brand=c.get("brand") or "",
        model=c["model"],
        name=c["name"],
    )
    _sync_spu_policy_to_siblings(c, sync_samples=False)


@router.post("/api/price-clean/skus/{code}/crawl", summary="首次抓取或重抓闲鱼快照并执行五重机器初筛（同SPU兄弟件同步共享快照）")
def run_machine_crawl(code: str, body: dict | None = None, u=Depends(get_current_user)):
    c = _get_or_init_case(code)
    b = body or {}
    if "spuPolicy" in b and isinstance(b["spuPolicy"], dict):
        _apply_spu_policy_patch(c, b["spuPolicy"])
    c["riskControlPaused"] = False
    c["crawlBatch"] = int(c.get("crawlBatch") or 1) + (1 if c["raw_samples"] else 0)
    center = float(b.get("centerPrice") or c.get("centerHint") or (c["cost"] * 1.48 if c["cost"] else 620))
    samples, q_runs, deduped_cnt = _build_v1_candidates(
        c.get("brand") or "", c["model"], c["name"], center, c["spuPolicy"], batch_ver=c["crawlBatch"],
    )
    c["raw_samples"] = samples
    c["queryRuns"] = q_runs
    c["dedupedCount"] = deduped_cnt
    c["crawledAt"] = datetime.now().strftime("%Y-%m-%d %H:%M")
    c["step"] = "human_review"
    _machine_screen(c)
    _sync_spu_policy_to_siblings(c, sync_samples=True)
    return _case_out(c)


@router.post("/api/price-clean/skus/{code}/invalidate-recrawl", summary="【作废重新爬】作废当前快照与均价结果，按最新 SPU 12词策略重抓闲鱼快照")
def invalidate_and_recrawl(code: str, body: dict | None = None, u=Depends(get_current_user)):
    c = _get_or_init_case(code)
    b = body or {}
    old_stats = c.get("stats") or {}
    if c.get("raw_samples"):
        c.setdefault("invalidatedHistory", []).append({
            "batch": c.get("crawlBatch", 1),
            "crawledAt": c.get("crawledAt") or "",
            "oldCleanedAverage": old_stats.get("cleanedAverage"),
            "oldConfirmedPrice": c.get("confirmedPrice"),
            "reason": str(b.get("reason") or "员工判定快照需更新，作废重爬").strip(),
            "invalidatedBy": getattr(u, "name", u.username),
            "invalidatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        })

    if "spuPolicy" in b and isinstance(b["spuPolicy"], dict):
        _apply_spu_policy_patch(c, b["spuPolicy"])

    c["riskControlPaused"] = False
    c["crawlBatch"] = int(c.get("crawlBatch") or 1) + 1
    center = float(c.get("centerHint") or (c["cost"] * 1.48 if c["cost"] else 620))
    samples, q_runs, deduped_cnt = _build_v1_candidates(
        c.get("brand") or "", c["model"], c["name"], center, c["spuPolicy"], batch_ver=c["crawlBatch"],
    )
    c["raw_samples"] = samples
    c["queryRuns"] = q_runs
    c["dedupedCount"] = deduped_cnt
    c["crawledAt"] = datetime.now().strftime("%Y-%m-%d %H:%M")
    c["confirmedPrice"] = None
    c["activeVersion"] = None
    c["step"] = "human_review"
    _machine_screen(c)
    _sync_spu_policy_to_siblings(c, sync_samples=True)
    return {
        **_case_out(c),
        "msg": f"已作废上一轮结果并完成第 {c['crawlBatch']} 轮多关键词重爬（当前共 {len(c['spuPolicy'].get('effectiveQueries') or [])} 个检索词），新清洗均价 ¥{c['stats'].get('recommendedPrice') or '—'}",
    }


@router.post("/api/price-clean/skus/{code}/ai-correct", summary="AI 型号纠改：识别内部工厂码，自动生成中文俗称、最多12个别名与多关键词策略")
def ai_correct_model(code: str, body: dict | None = None, u=Depends(get_current_user)):
    c = _get_or_init_case(code)
    b = body or {}
    sug = generate_ai_correction(c.get("brand") or "", c["model"], c["name"])
    c["aiSuggestion"] = sug
    if b.get("applyAndRecrawl"):
        _apply_spu_policy_patch(c, {
            "searchMode": "explicit",
            "queries": sug["suggestedQueries"],
            "displayName": sug["suggestedDisplayName"],
            "searchAliases": sug["suggestedAliases"],
        })
        return invalidate_and_recrawl(code, {"reason": "采纳 AI 型号纠改与中文别名重爬闲鱼快照"}, u=u)
    return {**_case_out(c), "msg": "AI 已完成型号别名诊断，可一键套用并重爬"}


@router.post("/api/price-clean/skus/{code}/web-evidence", summary="联网核查证据（aiWebSearchResults）：抓取京东/ZOL/值得买规格与残值参考")
def fetch_web_evidence(code: str, u=Depends(get_current_user)):
    c = _get_or_init_case(code)
    center = float((c.get("stats") or {}).get("cleanedAverage") or c.get("centerHint") or (c["cost"] * 1.45 if c["cost"] else 680))
    c["aiWebSearchResults"] = generate_web_evidence(c.get("brand") or "", c["model"], c["name"], center)
    return {**_case_out(c), "msg": f"已完成全网参数与二手残值核查（共 {len(c['aiWebSearchResults'])} 条权威来源）"}


@router.post("/api/price-clean/skus/{code}/wms-writeback", summary="回写 WMS 标准商品名并执行 GET 读回强校验留痕")
def wms_writeback_name(code: str, body: dict, u=Depends(get_current_user)):
    c = _get_or_init_case(code)
    new_name = str(body.get("newName") or "").strip()
    if len(new_name) < 3:
        raise HTTPException(400, "请输入有效的标准商品名称（至少 3 个字符）")
    before_name = c["name"]
    db = _db()
    verified_get_name = new_name
    try:
        from app.models import Sku
        sk = db.query(Sku).filter(Sku.sku_code == code).first()
        if sk:
            sk.product_name = new_name
            db.commit()
            db.refresh(sk)
            verified_get_name = sk.product_name
    finally:
        db.close()
    c["name"] = verified_get_name
    rec = record_wms_writeback(
        code,
        c.get("spuCode") or code,
        before_name,
        verified_get_name,
        getattr(u, "name", u.username),
    )
    _machine_screen(c)
    return {
        **_case_out(c),
        "writebackRecord": rec,
        "msg": f"已回写 WMS 商品名并通过 GET 读回强校验：「{verified_get_name}」",
    }


@router.post("/api/image-library/skus/{code}/refill-lane", summary="product-image-service 坏图池一键扩搜补满正式池（转入好图列表）")
def refill_bad_image_lane(code: str, u=Depends(get_current_user)):
    lib_state = _init_image_library_for_sku(code)
    pfx = lib_state.get("imgPrefix") or "MON1"
    existing_ids = {it["id"] for it in lib_state["items"]}
    extra_meta = [
        (6, "xiaohongshu.com", "900×900", 0.74, "good", "正式池 · 开箱成色特写"),
        (7, "suning.com", "900×900", 0.69, "ok", "模糊池 · 背部接口细节"),
        (8, "weibo.com", "900×900", 0.64, "ok", "模糊池 · 自然光窗台"),
        (9, "pconline.com.cn", "900×900", 0.60, "ok", "模糊池 · 极简灰底正侧"),
        (10, "ithome.com", "900×900", 0.88, "good", "正式池 · 点亮屏幕实测"),
        (11, "chiphell.com", "900×900", 0.82, "good", "正式池 · 底座支架特写"),
        (12, "v2ex.com", "900×900", 0.77, "good", "正式池 · 全套配件合拍"),
    ]
    for idx, dom, res, conf, qg, lbl in extra_meta:
        iid = f"LIB-{idx}"
        if iid not in existing_ids:
            lib_state["items"].append({
                "id": iid,
                "url": f"/api/demo-img/library/{pfx}-lib-{idx}.jpg",
                "sourceType": "crawled_library",
                "sourceLabel": lbl,
                "domain": dom,
                "resolution": res,
                "confidence": conf,
                "qualityGrade": qg,
                "defaultWave": "recommended",
                "filterCode": "",
                "machineReason": f"重搜补池通过 pHash 去重 · 型号置信度 {conf:.2f}",
                "humanWave": None,
            })
    lib_state["imageLane"] = "good"
    lib_state["formalPoolCount"] = 36
    db = _db()
    try:
        from app.models import Sku
        sk = db.query(Sku).filter(Sku.sku_code == code).first()
        if sk and isinstance(sk.spu, dict):
            spu_copy = dict(sk.spu)
            spu_copy["image_lane"] = "good"
            sk.spu = spu_copy
            db.commit()
    finally:
        db.close()
    return {
        **_serialize_image_library(code),
        "msg": "已完成多引擎重搜补图：正式池已满 36 张，自动转入「好图列表 (Good Lane)」！",
    }


@router.patch("/api/price-clean/skus/{code}/settings", summary="调整 SPU 屏蔽词/挂牌价围栏或口径并实时重算均价")
def update_clean_settings(code: str, body: dict, u=Depends(get_current_user)):
    c = _get_or_init_case(code)
    for key in ("categoryMode", "selectedType", "conditionFilter"):
        if key in body and body[key] is not None:
            c["strategy"][key] = body[key]
    if "spuPolicy" in body and isinstance(body["spuPolicy"], dict):
        _apply_spu_policy_patch(c, body["spuPolicy"])
    _machine_screen(c)
    return _case_out(c)


@router.patch("/api/price-clean/skus/{code}/samples/{sid}", summary="人工点选卡片：恢复误杀计入均价 / 标为非目标剔除（实时重算平均价与中位价）")
def toggle_sample(code: str, sid: str, body: dict, u=Depends(get_current_user)):
    c = _get_or_init_case(code)
    r = next((x for x in c["raw_samples"] if x["id"] == sid), None)
    if not r:
        raise HTTPException(404, "没有这条快照卡片")
    if "include" in body:
        inc = bool(body["include"])
        reason = str(body.get("reason") or "").strip()
        r["include"] = inc
        r["humanTouched"] = True
        r["reason"] = (reason or "人工标记为非目标商品剔除") if not inc else "人工核对恢复 · 计入平均价"
    _machine_screen(c)
    return _case_out(c)


@router.post("/api/price-clean/skus/{code}/confirm", summary="【确认 / 修改】确认价格生效（遵循 price-candidate.js 三重安全门禁），可选一键直接上架")
def confirm_and_apply(code: str, body: dict, u=Depends(get_current_user)):
    c = _get_or_init_case(code)
    try:
        price = _int_yuan(body.get("price") or 0)
    except Exception:
        price = 0
    if price <= 0:
        raise HTTPException(400, "请输入大于 0 的确认售价")

    inc_samples = [r for r in c["raw_samples"] if r.get("include")]
    if not inc_samples:
        raise HTTPException(400, "至少保留 1 条闲鱼有效挂牌才能确认")

    cost = float(c.get("cost") or 0)
    override_reason = str(body.get("overrideReason") or "").strip()
    note = str(body.get("note") or "").strip()
    force_review = bool(body.get("forceReviewOverride"))
    cp = c.get("candidatePreview") or compute_v020_candidate_preview_and_logs(c)

    if cost > 0 and price < cost and len(override_reason) < 2:
        raise HTTPException(400, f"确认售价 ¥{price} 低于采购成本 ¥{_int_yuan(cost)}（亏损倒挂拦截），如属滞销清仓请填写原因")
    if cp.get("reviewOnly") and not force_review and len(override_reason) < 2 and len(note) < 2:
        reasons_txt = "；".join(cp.get("reviewReasons") or ["触发复核门禁"])
        raise HTTPException(400, f"当前处于「待复核 (reviewOnly)」锁定态：{reasons_txt}。请先剔除异常极值卡片/重爬快照，或勾选「人工复核放行」并填写≥2字说明。")

    publish_shops = list(body.get("publishShops") or [])
    published_labels: list[str] = []

    if publish_shops and not code.startswith("PB-"):
        pub_res = publish_from_library(
            code,
            {
                "shops": [{"shopId": sid, "price": price} for sid in publish_shops],
                "overrideReason": override_reason or note,
            },
            u=u,
        )
        published_labels = pub_res.get("published") or []
    else:
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
        ver_num = len(c["versions"]) + 1
        avg_v = (c.get("stats") or {}).get("cleanedAverage")
        mode_note = "确认采用清洗均价" if (avg_v and abs(price - round(avg_v)) <= 1) else f"人工修改定价为 ¥{price}（原均价 ¥{avg_v or '—'}）"
        ver = {
            "version": ver_num,
            "price": price,
            "priceType": "清洗均价",
            "cleanedAverage": avg_v,
            "median": (c.get("stats") or {}).get("median"),
            "samplesCount": len(inc_samples),
            "confirmedBy": getattr(u, "name", u.username),
            "confirmedAt": now_str,
            "validUntil": (datetime.now() + timedelta(days=7)).strftime("%Y-%m-%d"),
            "overrideReason": override_reason,
            "note": note or mode_note,
        }
        c["versions"].append(ver)
        c["activeVersion"] = ver
        c["confirmedPrice"] = price
        c["overrideReason"] = override_reason
        c["reviewNote"] = ver["note"]
        c["reviewedBy"] = ver["confirmedBy"]
        c["reviewedAt"] = now_str
        c["step"] = "active"
        c["apiCurrentSalePrice"] = price
        compute_v020_candidate_preview_and_logs(c, api_current_sale_price=price, api_suggest_price=c.get("apiSuggestPrice"))

        db = _db()
        try:
            from app.models import CrawlPrice, CrawlProduct, Sku, SkuAutoListing
            sk = db.query(Sku).filter(Sku.sku_code == code).first()
            model_name = (sk.model if sk else c["model"]) or ""
            if model_name:
                cp = db.query(CrawlProduct).filter(CrawlProduct.name == model_name).first()
                today = date.today()
                if cp is None:
                    cp = CrawlProduct(name=model_name, keyword=model_name, enabled=True, last_price=Decimal(str(price)), last_price_date=today, note="人工确认闲鱼清洗价")
                    db.add(cp)
                    db.flush()
                else:
                    cp.last_price = Decimal(str(price))
                    cp.last_price_date = today
                row = db.query(CrawlPrice).filter(CrawlPrice.product_id == cp.id, CrawlPrice.crawl_date == today).first()
                raw_meta = {
                    "source": "cleaned_average",
                    "cleanedAverage": avg_v,
                    "medianPrice": (c.get("stats") or {}).get("median"),
                    "validCount": len(inc_samples),
                    "validPrices": sorted(float(x["price"]) for x in inc_samples),
                    "snapshotId": c["snapshotId"],
                }
                if row is None:
                    db.add(CrawlPrice(product_id=cp.id, crawl_date=today, price=Decimal(str(price)), raw=raw_meta))
                else:
                    row.price = Decimal(str(price))
                    row.raw = raw_meta
            if sk:
                sk.suggest_price = Decimal(str(price))
                gap = db.query(SkuAutoListing).filter(SkuAutoListing.sku_id == sk.id).first()
                if gap and gap.last_error in ("market_below_cost", "爬虫一直没爬到行情价"):
                    gap.stage = "READY"
                    gap.last_error = "已确认闲鱼清洗价，待选图直接上架"
            db.commit()
        finally:
            db.close()

    for pb in PRICEBOOK:
        if pb["model"] == c["model"] or pb["id"] == code:
            pb["ref"] = price
            pb["suggest"] = max(price, pb["suggest"] or price)
            pb["ver"] = f"v{int(''.join(filter(str.isdigit, pb['ver'] or '1')) or 1) + 1}"
            pb["from"] = datetime.now().strftime("%m-%d")
            pb["to"] = (datetime.now() + timedelta(days=7)).strftime("%m-%d")
            pb["status"] = "已生效"
            pb["fb"] = f"已同步闲鱼清洗价 ¥{price}"

    return {
        **_case_out(c),
        "published": published_labels,
        "msg": f"已确认售价 ¥{price}" + (f" 并直接上架到 {len(published_labels)} 个店铺（{'、'.join(published_labels)}）" if published_labels else "（已同步更新行情与价格表）"),
    }


@router.post("/api/listing-approvals/skus/{sku_code}/direct-publish", summary="兼容直发入口：保存选图与售价并直接上架")
def direct_publish(sku_code: str, body: dict, u=Depends(get_current_user)):
    items = body.get("shops") or []
    mapped = [
        {
            "shopId": e.get("shop_id") or e.get("shopId"),
            "price": e.get("price"),
            "images": e.get("images"),
        }
        for e in items
    ]
    return publish_from_library(
        sku_code,
        {"shops": mapped, "overrideReason": body.get("overrideReason") or ""},
        u=u,
    )


# ==================================================================
# 3. B10 采购价格表 API
# ==================================================================
@router.get("/api/demo/pricebook")
def get_pricebook(u=Depends(get_current_user)):
    return {"items": PRICEBOOK}


@router.post("/api/demo/pricebook")
def add_pricebook(body: dict, u=Depends(get_current_user)):
    model = str(body.get("model") or "").strip()
    if not model:
        raise HTTPException(400, "先填型号")
    row = {
        "id": f"PB-{len(PRICEBOOK) + 1:03d}",
        "model": model,
        "config": str(body.get("config") or "").strip(),
        "ref": float(body.get("ref") or 0),
        "suggest": float(body.get("suggest") or 0),
        "limit": float(body.get("limit") or 0),
        "deal": float(body.get("deal") or 0),
        "paid": float(body.get("paid") or 0),
        "rebate": float(body.get("rebate") or 0),
        "status": "已生效" if body.get("directConfirm") else "待核",
        "ver": "v1",
        "from": datetime.now().strftime("%m-%d"),
        "to": (datetime.now() + timedelta(days=7)).strftime("%m-%d"),
        "fb": str(body.get("fb") or "").strip(),
    }
    PRICEBOOK.insert(0, row)
    CLEAN_CASES[row["id"]] = _seed_cleaning_case(row["id"], f"{row['model']} {row['config']}", row["model"], row["config"], float(row["paid"] or row["deal"] or row["ref"] or 500), float(row["ref"] or pb_suggest(row)), 0)
    return row


def pb_suggest(row: dict) -> float:
    return float(row.get("suggest") or 700)


@router.patch("/api/demo/pricebook/{pid}")
def update_pricebook(pid: str, body: dict, u=Depends(get_current_user)):
    row = next((x for x in PRICEBOOK if x["id"] == pid), None)
    if not row:
        raise HTTPException(404, "价格表条目不存在")
    for k in ("ref", "suggest", "limit", "deal", "paid", "rebate", "fb", "config", "model", "status"):
        if k in body:
            row[k] = body[k]
    return row


@router.post("/api/demo/pricebook/batch")
def batch_pricebook(body: dict, u=Depends(get_current_user)):
    ids = set(body.get("ids") or [])
    pct = float(body.get("pct") or 0)
    direct = bool(body.get("directConfirm"))
    changed = 0
    for r in PRICEBOOK:
        if r["id"] in ids:
            r["_prev"] = {k: r.get(k) for k in ("ref", "suggest", "limit", "deal", "paid", "status", "ver", "from", "to")}
            if r.get("suggest"):
                r["suggest"] = round(float(r["suggest"]) * (1 + pct / 100))
            if r.get("limit"):
                r["limit"] = round(float(r["limit"]) * (1 + pct / 100))
            if direct:
                n = int("".join(filter(str.isdigit, r.get("ver") or "1")) or 1) + 1
                r["ver"] = f"v{n}"
                r["status"] = "已生效"
                r["from"] = datetime.now().strftime("%m-%d")
                r["to"] = (datetime.now() + timedelta(days=7)).strftime("%m-%d")
            else:
                r["status"] = "待核"
            changed += 1
    return {"ok": True, "changed": changed, "items": PRICEBOOK}


@router.post("/api/demo/pricebook/{pid}/confirm")
def confirm_pricebook(pid: str, body: dict | None = None, u=Depends(get_current_user)):
    row = next((x for x in PRICEBOOK if x["id"] == pid), None)
    if not row:
        raise HTTPException(404, "价格表条目不存在")
    b = body or {}
    row["_prev"] = {k: row.get(k) for k in ("ref", "suggest", "limit", "deal", "paid", "status", "ver", "from", "to")}
    for k in ("ref", "suggest", "limit", "deal", "paid", "rebate", "fb"):
        if k in b:
            row[k] = b[k]
    n = int("".join(filter(str.isdigit, row.get("ver") or "1")) or 1) + 1
    row["ver"] = f"v{n}"
    row["status"] = "已生效"
    row["from"] = datetime.now().strftime("%m-%d")
    row["to"] = (datetime.now() + timedelta(days=7)).strftime("%m-%d")
    return row


@router.post("/api/demo/pricebook/{pid}/rollback")
def rollback_pricebook(pid: str, u=Depends(get_current_user)):
    row = next((x for x in PRICEBOOK if x["id"] == pid), None)
    if not row or not row.get("_prev"):
        raise HTTPException(400, "该行没有可回退的旧版本")
    prev = row.pop("_prev")
    row.update(prev)
    return row


# ==================================================================
# 4. C08 提成账本 API
# ==================================================================
@router.get("/api/demo/commission")
def get_commission(u=Depends(get_current_user)):
    if not COMMISSION:
        sync_commission_summary()
    return {"items": COMMISSION}


@router.post("/api/demo/commission/recalc")
def recalc_commission(u=Depends(get_current_user)):
    sync_commission_summary()
    return {"ok": True, "items": COMMISSION}


@router.post("/api/demo/commission/{cid}/{action}")
def commission_action(cid: str, action: str, u=Depends(get_current_user)):
    r = next((x for x in COMMISSION if x["id"] == cid), None)
    if not r:
        raise HTTPException(404, "没有这笔提成流水")
    if action == "confirm":
        r["refund"] = False
        r["manual_refund"] = False
        r["state"] = "已确认"
    elif action == "claw":
        r["refund"] = True
        r["manual_refund"] = True
        r["state"] = "已扣回"
    elif action == "unclaw":
        r["refund"] = False
        r["manual_refund"] = False
        r["state"] = "待确认"
    else:
        raise HTTPException(400, "未知操作")
    sync_commission_summary()
    return {"ok": True, "item": r, "items": COMMISSION}


# ==================================================================
# 5. G02 询单与报价 → 真实成交建单联动
# ==================================================================
@router.get("/api/demo/inquiries")
def get_inquiries(u=Depends(get_current_user)):
    return {"items": INQUIRIES}


@router.post("/api/demo/inquiries")
def create_inquiry(body: dict, u=Depends(get_current_user)):
    import virtual_stub as vs
    buyer = str(body.get("buyer") or "").strip()
    if not buyer:
        raise HTTPException(400, "请写买家称呼")
    pid = str(body.get("pid") or "").strip()
    prod = vs.DB.get(pid) if pid else None
    row = {
        "id": f"XJ-{2600 + len(INQUIRIES) + 1}",
        "platform": body.get("platform") or "闲鱼",
        "buyer": buyer,
        "product": (prod["name"] if prod else str(body.get("product") or "").strip()) or "（待补产品）",
        "pid": pid,
        "owner": body.get("owner") or u.username,
        "state": "新询",
        "amount": float(body.get("amount") or (prod["price"] if prod else 0)),
        "source": body.get("source") or body.get("platform") or "闲鱼",
        "at": datetime.now().strftime("%m-%d %H:%M"),
        "quotes": [],
        "follow": [],
        "lost": "",
        "order_id": "",
    }
    INQUIRIES.insert(0, row)
    return row


@router.patch("/api/demo/inquiries/{qid}")
def patch_inquiry(qid: str, body: dict, u=Depends(get_current_user)):
    q = next((x for x in INQUIRIES if x["id"] == qid), None)
    if not q:
        raise HTTPException(404, "询单不存在")
    for k in ("owner", "state"):
        if k in body:
            q[k] = body[k]
    return q


@router.post("/api/demo/inquiries/{qid}/quote")
def add_inquiry_quote(qid: str, body: dict, u=Depends(get_current_user)):
    import virtual_stub as vs
    q = next((x for x in INQUIRIES if x["id"] == qid), None)
    if not q:
        raise HTTPException(404, "询单不存在")
    price = float(body.get("price") or 0)
    if price <= 0:
        raise HTTPException(400, "报价必须大于 0")
    prod = vs.DB.get(q.get("pid") or "")
    warn = ""
    if prod and float(prod.get("cost") or 0) > 0:
        pct = float(prod.get("floor_pct") or (105 if prod.get("delivery") == "card" else 130))
        floor = round(float(prod["cost"]) * (pct / 100), 2)
        if price < floor and not body.get("allowBelowFloor"):
            warn = f"低于产品底线 ¥{floor}（进价 ¥{prod['cost']} × {pct:.0f}%），已留痕提示"
    elif prod and float(prod.get("price") or 0) > 0 and price < round(float(prod["price"]) * 0.7, 2):
        warn = f"低于服务标准参考价 ¥{prod['price']} 的 7 折，注意亏工时风险"
    v = (q["quotes"][-1]["v"] if q["quotes"] else 0) + 1
    q["quotes"].append({
        "v": v, "price": price, "valid": str(body.get("valid") or "7天"),
        "note": str(body.get("note") or "").strip(), "accepted": False, "warn": warn,
    })
    q["amount"] = price
    q["state"] = "已报价"
    return {"item": q, "warn": warn}


@router.post("/api/demo/inquiries/{qid}/accept")
def accept_inquiry_quote(qid: str, body: dict, u=Depends(get_current_user)):
    q = next((x for x in INQUIRIES if x["id"] == qid), None)
    if not q:
        raise HTTPException(404, "询单不存在")
    v = int(body.get("v") or 0)
    hit = None
    for x in q["quotes"]:
        x["accepted"] = (x["v"] == v)
        if x["accepted"]:
            hit = x
    if not hit:
        raise HTTPException(404, "对应报价版本不存在")
    q["amount"] = hit["price"]
    q["state"] = "待客户"
    return q


@router.post("/api/demo/inquiries/{qid}/follow")
def follow_inquiry(qid: str, body: dict, u=Depends(get_current_user)):
    q = next((x for x in INQUIRIES if x["id"] == qid), None)
    if not q:
        raise HTTPException(404, "询单不存在")
    txt = str(body.get("text") or "").strip()
    if not txt:
        raise HTTPException(400, "请填写跟进内容")
    q["follow"].append({"t": datetime.now().strftime("%m-%d %H:%M"), "text": txt})
    if q["state"] == "新询":
        q["state"] = "跟进中"
    return q


@router.post("/api/demo/inquiries/{qid}/to-order")
def convert_inquiry_to_order(qid: str, u=Depends(get_current_user)):
    import virtual_stub as vs
    q = next((x for x in INQUIRIES if x["id"] == qid), None)
    if not q:
        raise HTTPException(404, "询单不存在")
    if q["state"] == "已成交" and q.get("order_id"):
        return {"item": q, "msg": f"已关联订单 {q['order_id']}"}
    acc = next((v for v in q.get("quotes") or [] if v.get("accepted")), None)
    deal_price = float(acc["price"] if acc else q.get("amount") or 0)
    if deal_price <= 0:
        raise HTTPException(400, "请先确定成交报价再转订单")
    prod = vs.DB.get(q.get("pid") or "")
    oid_num = 12000 + len(INQUIRIES) + sum(len(p.get("orders", [])) for p in vs.DB.values())
    if prod:
        prod["orders"].insert(0, {"id": oid_num, "buyer": f"买家 · {q['buyer']}", "amount": deal_price, "paid_ago_min": 5, "status": "delivered", "hit": [], "refund": False})
        prod["week_sales"] = int(prod.get("week_sales") or 0) + 1
    q["state"] = "已成交"
    q["amount"] = deal_price
    q["order_id"] = f"V-{oid_num}"
    sync_commission_summary()
    return {"item": q, "order_id": q["order_id"], "msg": f"已按成交价 ¥{deal_price} 生成订单 {q['order_id']} 并重算提成"}


@router.post("/api/demo/inquiries/{qid}/lost")
def mark_inquiry_lost(qid: str, body: dict, u=Depends(get_current_user)):
    q = next((x for x in INQUIRIES if x["id"] == qid), None)
    if not q:
        raise HTTPException(404, "询单不存在")
    reason = str(body.get("reason") or "").strip()
    if len(reason) < 4:
        raise HTTPException(400, "丢单原因至少写 4 个字")
    q["lost"] = reason
    q["state"] = "已丢单"
    return q


# ==================================================================
# 6. 汇率换算 / 虚拟阶段预算阈值扩展
# ==================================================================
@router.get("/api/demo/fx")
def get_fx(u=Depends(get_current_user)):
    return FX_CONFIG


@router.put("/api/demo/fx")
def update_fx(body: dict, u=Depends(get_current_user)):
    if "jpy_to_cny" in body:
        v = float(body["jpy_to_cny"] or 0)
        if v <= 0 or v > 1:
            raise HTTPException(400, "日元汇率应在 0~1 之间")
        FX_CONFIG["jpy_to_cny"] = round(v, 5)
    if "freight_tax_pct" in body:
        FX_CONFIG["freight_tax_pct"] = max(0.0, min(100.0, float(body["freight_tax_pct"] or 0)))
    FX_CONFIG["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M")
    return FX_CONFIG


@router.get("/api/demo/product-extras/{pid}")
def get_product_extras(pid: str, u=Depends(get_current_user)):
    return EXTRAS_STORE.get(pid, {"stageBudget": 500, "stopLossPct": 8.0, "recheckDays": 7, "decision": "", "note": ""})


@router.put("/api/demo/product-extras/{pid}")
def put_product_extras(pid: str, body: dict, u=Depends(get_current_user)):
    cur = EXTRAS_STORE.setdefault(pid, {"stageBudget": 500, "stopLossPct": 8.0, "recheckDays": 7, "decision": "", "note": ""})
    for k in ("stageBudget", "stopLossPct", "recheckDays", "decision", "note"):
        if k in body:
            cur[k] = body[k]
    return cur
