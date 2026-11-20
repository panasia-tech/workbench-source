"""虚拟商品 / 服务的演示接口（内存数据）。

真实 ERP 服务端里**没有**这一块：没有卡券库存、发货检查、退款名单、产品卡、成熟度。
这里按《虚拟产品体系方案》第 2、3、5、6 节和阿奇索口径，先把接口形状做出来，当作给程序员的接口说明。
所有数据是演示数据；重启后回到初始状态。
"""
from __future__ import annotations

import copy
import re
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException

from app.deps import get_current_user

router = APIRouter(prefix="/api/virtual", tags=["虚拟商品（演示接口）"])

TODAY = datetime.now()
D = lambda days: (TODAY - timedelta(days=days)).strftime("%Y-%m-%d")  # noqa: E731

# 8 步 SOP（方案第 5 节）
SOP = [
    (1, "领线索，挂节点", "领取记录", "已挂到 Gallery 节点，查过没有重复"),
    (2, "看三个榜", "闲鱼、淘宝、京东的截图和数字", "销量、价格带、卖家数都有；没有的写「无」"),
    (3, "查取得路径", "主路径、备路径、进价、资格", "每条路径有来源证据"),
    (4, "算账", "单笔贡献算式", "费用逐项列出，缺的写待核，不填 0"),
    (5, "小额实测", "买 1 份、交付、核销的凭证", "客户侧真实能用"),
    (6, "他人复现", "另一位员工照产品卡再做一遍", "不看原作者也能做成"),
    (7, "二审并直接上架", "产品卡 + 上架文案 / 图", "人工二审确认定价与规则即直接上架"),
    (8, "周复盘", "销量、退款、成本变化", "继续、扩大、调整、暂停或退出"),
]
DELIVERY = {"card": "有卡券（每单发不同的码）", "nocard": "无卡券（人人发同一份内容）", "topup": "直充 / 代充", "manual": "人工服务", "selfserve": "程序自助（码券化）"}


def batch(i, supplier, cost, qty, left, exp, days):
    return {"id": f"B{i:03d}", "supplier": supplier, "cost": cost, "qty": qty, "left": left, "expire": exp, "date": D(days)}


def order(i, buyer, amount, ago_min, status, hit=None, refund=False):
    return {"id": f"O{i:04d}", "buyer": buyer, "amount": amount, "paid_ago_min": ago_min, "status": status, "hit": hit or [], "refund": refund}


def sig(sales, lo, hi, sellers, rank, days=3):
    return {"sales": sales, "price_lo": lo, "price_hi": hi, "sellers": sellers, "rank": rank, "date": D(days)}


def P(**k):
    base = dict(
        platforms=["闲鱼", "淘宝"], region="全国", valid="购买后 90 天", owner="陈小满", listing_type="follow", step=8,
        platform_fee_rate=0.016, after_sale_reserve=1.0, auto_delivery=True,
        checks={"refund_limit": 2, "blacklist": True, "prev_unconfirmed": True},
        stock=None, orders=[], refund_list=[], peers=[], signals={}, sourcing={}, notes={},
        compliance={"level": "B", "lawyer": "unsubmitted", "note": ""}, review=[], decision="继续", points=None, capacity=None,
        week_sales=0, refund_rate=0.0, source_tag="榜单爬虫", evidence=[], auto_refund=True, evidence_log=[],
    )
    base.update(k)
    return base


SRC_PEER = "闲鱼同行样本 · output/xianyu-peer-sample-20261031/商品1000条.csv（2026-10-31 采，1000 条）"
SRC_GROK = "Grok《虚拟产品调研》· AI商品清单1000.csv（Drive 2026-11-10）"
NOT_YET = {"sales": 0, "price_lo": 0, "price_hi": 0, "sellers": 0, "rank": 0, "date": "", "note": "未采集：淘宝、京东榜单爬虫（B11）还没接入"}



# ======================================================================================
# 技术服务（远程操作类）的「学习 → 三产物 → 对客交付」全流程。
# 依据：output/工作台-程序员终极交接-20261101/docs/服务远控/（Windows 服务工作台双口径选型、补充硬验收、学习到交付合同）、
#       虚拟产品与服务调研 SOP（AI 旁听远程做单学习法）、业务模块 13。
# 口径 B（同行学习）：同行用任意远控操作「公司的隔离 Windows」，公司在这台机器上自己采集三路证据（osquery 工具清单 / Fibratus 后台事件 / OBS 录屏）
#                     + 终端命令与输出 + 下载来源。口径 A（对客交付）：公司 Agent 经向日葵（备用 ToDesk）操作客户 Windows。
# 三个成品：业务员手绘教程 MP4、说明 SOP（含工具下载清单和完整终端操作手册）、可独立复现的执行 Skill（AI agent 的 Computer Use SKILL）。
# 说明：这里的数字和画面都是演示数据，不是真实采集；真实的采集器、渲染、复现由程序员按合同做。没有的步骤不编造。
# ======================================================================================
LEARN_NODES = [
    (1, "立项：服务研究卡", "销售员 / Agent", "要学的是一个具体的服务结果（不是宽泛的「维修」）：客户场景、设备 / 系统 / 版本、原始现象或错误码、同行与供给、报价与时效。"),
    (2, "先复现原始问题", "销售员 / 技术", "先把客户的问题自己复现一遍，记下真实错误码、Windows 环境和画面。没有复现过，后面所有验证都没有对照。"),
    (3, "找同行，谈可接范围", "销售员", "核同行能接什么、用什么工具、交付条件和报价；急单和学习单分开关联；沟通记录留痕。"),
    (4, "准备公司学习机", "技术 / 现场", "一台与日常经营账号、支付、客户资料隔离的 Windows；我方人员在场；需要插拔、拍摄的物理动作由指定人员配合。"),
    (5, "开会话，检查三路采集", "采集端", "建学习会话；检查三路都在记录：工具清单、后台操作事件、屏幕录像；终端命令与下载来源另有采集。缺一类先处理采集，不开始。"),
    (6, "同行远程操作", "同行", "同行用任意远控（向日葵、ToDesk 都行）操作公司这台电脑；证据由公司自己的采集器留，不依赖远控软件有没有录像。我方全程在场，越界（翻文件、装无关软件）立即断连。"),
    (7, "标记关键节点", "Agent / 销售员", "报警、弹窗、验证、失败、管理员权限、重启、解决——这些最有价值，单独标时间码。观察、同行说明、推断分开写。"),
    (8, "验证原问题", "执行方", "回到最初的问题，验证是否真的恢复。工具显示成功、进度 100%、命令已发出，都不算恢复。"),
    (9, "保全证据，补录缺口，结束会话", "销售员 / Agent", "先保全证据和实际结果，再断开同行、改相关凭据、清理。缺的命令、脚本、下载来源列成补录清单请同行补，不让 Agent 猜。"),
    (10, "做三个成品", "Agent / 程序员渲染", "① 业务员手绘教程 MP4（给人看，人可以兜底）；② 说明 SOP（工具下载清单 + 完整终端操作手册）；③ 执行 Skill（给 AI agent 用的 Computer Use SKILL）。"),
    (11, "在干净 Windows 上独立复现", "技术", "另一套干净的 Windows，只靠 Skill 或 SOP 重做一遍，得到同一个业务结果。GUI 动作按当前画面重新定位，不重放录屏里的固定坐标。"),
    (12, "进可售服务能力库", "技术 / 二审确认", "复现通过、三个成品齐了，才登记成可售的服务能力，带版本号；以后改动出新版本，不覆盖旧的。登记时写明执行方式：Computer Use（AI 看屏幕、临场判断，每次可能略有不同），还是已经把跑稳的步骤固化成 RPA（流程写死，高频、结果必须一致的环节用）。"),
    (13, "客户对接与远控接入", "云端 Codex Desktop + 专属 Skill", "客户下单后，对接客户这件重复劳动由智能体接手：发接入指引（教客户装、配向日葵或 ToDesk）、取临时识别码、确认授权范围、接入后核对设备。要用云端的 Codex Desktop 加这项服务的专属 Skill，不是一个裸 API 能做的。人只在异常时介入。"),
    (14, "对客交付", "员工联络 + Agent 操作", "订单绑定服务版本和客户授权的设备；Agent 按专属 Skill 操作，每一步动作后看新画面确认；急单、疑难可转同行；Agent 卡住时人按「教程视频 + SOP」兜底；结束验证问题恢复、请客户改凭据、撤销接入。一小时完工是时效要求。"),
]


def _learn_preset():
    return {
        "case": {"goal": "处理《三角洲行动》启动时跳出的「检测到虚拟化」报警", "scene": "客户电脑玩《三角洲行动》时弹出虚拟化相关报警，进不去游戏", "env": "Windows 11 · 版本和机型待客户补（示意）",
                 "symptom": "原始现象：启动后弹出虚拟化报警（真实错误码、截图：待复现时记录）", "peer": "闲鱼同行 · 「游戏报错处理」（演示）", "price": "¥39（演示）", "sla": "1 小时"},
        "stage": 9,
        "done": {"1": True, "2": True, "3": True, "4": True, "5": True, "6": True, "7": True, "8": True},
        "env_ok": {"isolated": True, "present": True},
        "session": {"id": "LS-20261111-001", "machine": "公司学习机 A（演示）", "remote": "ToDesk（同行自选，演示）", "segments": 2, "started": "10:12", "ended": ""},
        "capture": {
            "tools": {"name": "工具与环境清单（osquery）", "state": "ok", "detail": "前后环境对比：新出现 7 个工具 / 程序（演示数值）"},
            "events": {"name": "后台操作事件（Fibratus 被动捕获）", "state": "ok", "detail": "1,284 条事件，已生成时间轴（演示数值）"},
            "video": {"name": "屏幕录像（OBS 本机）", "state": "ok", "detail": "共 42 分 10 秒，2 段（中间重启分段）（演示数值）"},
            "terminal": {"name": "终端命令与输出", "state": "missing", "detail": "只看到启动了命令行程序，没有命令正文和输出：要同行补录"},
            "downloads": {"name": "下载的工具和来源", "state": "partial", "detail": "浏览器下载记录有；在终端里下载的来源没取到：要同行补录"},
        },
        "keynodes": [
            {"t": "00:03:12", "kind": "警告", "text": "出现游戏的虚拟化报警（演示）"},
            {"t": "00:11:40", "kind": "重启", "text": "同行要求重启，会话分成第 2 段（演示）"},
            {"t": "00:18:05", "kind": "解决", "text": "报警不再出现（还没有验证原问题）（演示）"},
        ],
        "verify": {"state": "pending", "note": ""},
        "outputs": {
            "sop": {"name": "说明 SOP", "state": "draft", "detail": "已有：环境、工具清单、步骤框架。缺：终端操作手册（命令正文）"},
            "video": {"name": "业务员手绘教程 MP4", "state": "none", "detail": "还没有视频文件。分镜、动画代码都不算「已交视频」，要有能完整播放的 MP4"},
            "skill": {"name": "执行 Skill（Computer Use SKILL）", "state": "none", "detail": "缺终端命令和下载来源证据，不能生成可执行 Skill，只能停在「待补证」"},
        },
        "repro": {"state": "none", "note": ""},
        "library": {"state": "none", "version": ""},
        "supplements": [],
        "log": [],
        "runner": {"name": "云端 Codex Desktop（带 Computer Use）", "skill": "这项服务的专属 Skill（复现通过后绑定版本）", "remote": "向日葵官方 MCP（首选）/ ToDesk（备用）",
                   "state": "未接入", "note": "要程序员把云端 Codex Desktop、专属 Skill、向日葵 MCP 接起来并在干净 Windows 上验收；现在界面里是演示数据"},
    }



def peer(n, lo, hi, med, note=""):
    return {"sales": n, "price_lo": lo, "price_hi": hi, "sellers": n, "rank": 0, "date": "2026-10-31", "median": med, "note": note or f"同样本里同类 {n} 条挂牌"}


PRODUCTS = [
    # ---------------- 码券类（A1 餐饮券）：价格带、挂牌数来自闲鱼同行样本的真实行 ----------------
    P(id="v-mcd", code="VC-A1-0101", name="麦当劳 鸡牛双堡双人餐电子券", brand="麦当劳", face="双人餐 · 全国门店通用", kind="virt", cover="mcd",
      path=["A 码券类", "A1 餐饮券", "连锁快餐饮品", "麦当劳"], delivery="card", cost=36, price=46, week_sales=29, refund_rate=0.021,
      stock={"avail": 31, "locked": 1, "sold": 214, "void": 3, "warn_at": 10, "stop_at": 0,
             "batches": [batch(4, "券商（演示）", 36, 60, 31, D(-70), 6), batch(3, "券商（演示）", 36, 100, 0, D(-50), 30)]},
      orders=[order(1031, "买家 · 小鹿", 46, 3, "delivered"), order(1030, "买家 · 阿杰", 46, 20, "delivered"), order(1029, "买家 · yoyo", 46, 75, "delivered")],
      signals={"闲鱼": peer(25, 15.99, 61.2, 41.66, "样本里麦当劳 25 条；对标同行 1084382196124 双人餐 ¥47.66"), "淘宝": NOT_YET, "京东": NOT_YET},
      peers=[{"platform": "闲鱼", "shop": "同行挂牌 1084382196124", "price": 47.66, "sales": 0, "url": ""}, {"platform": "闲鱼", "shop": "同行挂牌 1082501390718（自助机核销，自动发货）", "price": 55.89, "sales": 0, "url": ""}],
      sourcing={"main": "券商批量拿货（演示）", "backup": "抢券群手工收", "cost": 36, "qualify": "无", "quota": "每周最多 100 张"},
      notes={"script": "券码 + 兑换步骤自动发送；到店出示即可。", "guide": "麦当劳 App → 我的 → 优惠券 → 兑换。", "refund": "未发码可退；已发码不退。", "stop": "连续 3 张券码被反馈已用 → 立刻下架并找券商。"},
      compliance={"level": "A", "lawyer": "passed", "note": "连锁快餐券，转让规则无限制（演示结论，以律师正式意见为准）。"},
      evidence=[SRC_PEER + " 第 1 条"], source_tag="榜单爬虫 · 闲鱼同行样本", review=[{"week": "本周", "sales": 29, "refunds": 1, "cost_delta": "+0"}]),
    P(id="v-kfc", code="VC-A1-0102", name="肯德基 随心配 2+1 单人餐三件套", brand="肯德基", face="单人餐 · 主食小食甜品任选", kind="virt", cover="kfc",
      path=["A 码券类", "A1 餐饮券", "连锁快餐饮品", "肯德基"], delivery="card", cost=15.2, price=19.9, week_sales=18, refund_rate=0.028,
      stock={"avail": 4, "locked": 0, "sold": 96, "void": 1, "warn_at": 10, "stop_at": 0, "batches": [batch(2, "券商（演示）", 15.2, 40, 4, D(-60), 9)]},
      orders=[order(2011, "买家 · 栗子", 19.9, 6, "delivered"), order(2010, "买家 · 大白", 19.9, 48, "delivered")],
      signals={"闲鱼": peer(5, 16.51, 48.29, 23.09, "样本里肯德基 5 条；对标 1089555827590 随心配 2+1 ¥18.9"), "淘宝": NOT_YET, "京东": NOT_YET},
      peers=[{"platform": "闲鱼", "shop": "同行挂牌 1089555827590", "price": 18.9, "sales": 0, "url": ""}],
      sourcing={"main": "券商批量拿货（演示）", "backup": "无", "cost": 15.2, "qualify": "无", "quota": "每周 40 张"},
      notes={"script": "券码自动发送。", "guide": "肯德基 App → 兑换。", "refund": "未发码可退。", "stop": "渠道断货 3 天 → 暂停。"},
      compliance={"level": "A", "lawyer": "passed", "note": ""}, evidence=[SRC_PEER + " 肯德基 5 条"], source_tag="榜单爬虫 · 闲鱼同行样本"),
    P(id="v-pzh", code="VC-A1-0103", name="必胜客 双人套餐 9 件套", brand="必胜客", face="披萨/牛排 8 选 1 · 可堂食外带", kind="virt", cover="pzh",
      path=["A 码券类", "A1 餐饮券", "连锁快餐饮品", "必胜客"], delivery="card", cost=70, price=86, week_sales=7, refund_rate=0.0,
      stock={"avail": 22, "locked": 1, "sold": 41, "void": 0, "warn_at": 8, "stop_at": 0, "batches": [batch(1, "券商（演示）", 70, 30, 22, D(-80), 5)]},
      orders=[order(3008, "买家 · 老周", 86, 7, "held", ["买家上一单还没确认收货"]), order(3007, "买家 · 琪琪", 86, 90, "delivered")],
      signals={"闲鱼": peer(1, 87.5, 87.5, 87.5, "样本里必胜客仅 1 条：1088092309449 ¥87.5"), "淘宝": NOT_YET, "京东": NOT_YET},
      peers=[{"platform": "闲鱼", "shop": "同行挂牌 1088092309449", "price": 87.5, "sales": 0, "url": ""}],
      sourcing={"main": "券商批量拿货（演示）", "backup": "无", "cost": 70, "qualify": "无", "quota": "每周 30 张"},
      notes={"script": "券码 + 使用规则。", "guide": "必胜客小程序 → 我的券。", "refund": "未发码可退。", "stop": "核销失败率 > 10% → 下架。"},
      compliance={"level": "A", "lawyer": "passed", "note": ""}, evidence=[SRC_PEER + " 必胜客 1 条"], source_tag="榜单爬虫 · 闲鱼同行样本"),
    P(id="v-dmn", code="VC-A1-0104", name="达美乐 四人餐（2 披萨 + 4 小吃 + 4 饮料）", brand="达美乐", face="四人餐 · 含配送", kind="virt", cover="dmn",
      path=["A 码券类", "A1 餐饮券", "连锁快餐饮品", "达美乐"], delivery="card", cost=104, price=128, week_sales=5, refund_rate=0.04,
      stock={"avail": 0, "locked": 0, "sold": 38, "void": 1, "warn_at": 6, "stop_at": 0, "batches": [batch(2, "券商（演示）", 104, 30, 0, D(-45), 20)]},
      orders=[order(4005, "买家 · 悠悠", 128, 11, "waiting", ["卡券库存 0，没有码可发"])],
      signals={"闲鱼": peer(1, 130.33, 130.33, 130.33, "样本里达美乐 1 条：800018056335 ¥130.33（浙江）"), "淘宝": NOT_YET, "京东": NOT_YET},
      peers=[{"platform": "闲鱼", "shop": "同行挂牌 800018056335", "price": 130.33, "sales": 0, "url": ""}],
      sourcing={"main": "券商批量拿货（演示）", "backup": "无", "cost": 104, "qualify": "无", "quota": "每周 20 张"},
      notes={"script": "券码自动发送。", "guide": "达美乐小程序 → 兑换。", "refund": "未发码可退。", "stop": "无货时自动暂停上架。"},
      compliance={"level": "A", "lawyer": "passed", "note": ""}, evidence=[SRC_PEER + " 达美乐 1 条"], source_tag="榜单爬虫 · 闲鱼同行样本"),
    P(id="v-wls", code="VC-A1-0105", name="华莱士 双人随心拼 7 件套（温州通用）", brand="华莱士", face="双人餐 · 温州 200+ 家门店", kind="virt", cover="wls",
      path=["A 码券类", "A1 餐饮券", "连锁快餐饮品", "华莱士"], delivery="card", cost=14, price=19.9, week_sales=26, refund_rate=0.11,
      region="浙江 · 温州", stock={"avail": 44, "locked": 0, "sold": 312, "void": 6, "warn_at": 10, "stop_at": 0, "batches": [batch(3, "券商（演示）", 14, 80, 44, D(-40), 8)]},
      orders=[order(5021, "买家 · 森森", 19.9, 15, "delivered", refund=True), order(5020, "买家 · 木木", 19.9, 66, "delivered", refund=True), order(5019, "买家 · 栗子", 19.9, 120, "delivered")],
      signals={"闲鱼": peer(8, 5.38, 27.29, 16.79, "样本里华莱士 8 条；温州/宁波同款 ¥19.99，24 小时自动发货"), "淘宝": NOT_YET, "京东": NOT_YET},
      peers=[{"platform": "闲鱼", "shop": "同行挂牌 1064718884848（温州）", "price": 19.99, "sales": 0, "url": ""}, {"platform": "闲鱼", "shop": "同行挂牌 1061998455969（宁波）", "price": 19.99, "sales": 0, "url": ""}],
      sourcing={"main": "券商批量拿货（演示）", "backup": "无", "cost": 14, "qualify": "无", "quota": "每周 80 张"},
      notes={"script": "券码 + 适用门店说明。", "guide": "华莱士小程序 → 券包。", "refund": "未发码可退。", "stop": "退款率 > 8% → 暂停，先查是不是门店不通用。"},
      compliance={"level": "B", "lawyer": "unsubmitted", "note": ""}, evidence=[SRC_PEER + " 华莱士 8 条"], source_tag="榜单爬虫 · 闲鱼同行样本",
      review=[{"week": "本周", "sales": 26, "refunds": 3, "cost_delta": "+0"}, {"week": "上周", "sales": 22, "refunds": 2, "cost_delta": "+0"}], decision="调整"),
    P(id="v-jp", code="VC-A1-0201", name="温州滨江万象城 花潮日料自助 一位", brand="花潮日料自助", face="精致套餐 · 一位", kind="virt", cover="jp",
      path=["A 码券类", "A1 餐饮券", "正餐", "日本料理"], delivery="card", cost=205, price=249, week_sales=0, refund_rate=0.0, step=4, region="浙江 · 温州",
      platforms=["闲鱼"], signals={"闲鱼": peer(45, 144.69, 1752, 268, "样本里日料自助 45 条，中位 ¥268；同行温州滨江万象城花潮 ¥258"), "淘宝": NOT_YET, "京东": NOT_YET},
      peers=[{"platform": "闲鱼", "shop": "同行挂牌（温州滨江万象城花潮日料自助 专用链接）", "price": 258, "sales": 0, "url": ""}],
      stock={"avail": 0, "locked": 0, "sold": 0, "void": 0, "warn_at": 3, "stop_at": 0, "batches": []},
      sourcing={"main": "商家团购渠道（待核）", "backup": "无", "cost": 205, "qualify": "待核", "quota": "待核"}, source_tag="榜单爬虫 · 闲鱼同行样本",
      notes={"script": "券码 + 预约说明。", "guide": "待写。", "refund": "待定。", "stop": "待定。"},
      compliance={"level": "B", "lawyer": "reviewing", "note": "团购券是否允许转让，等律师意见。"}, evidence=[SRC_PEER + " 日料自助 45 条"]),
    P(id="v-xdq", code="VC-A5-0101", name="奉化雪窦山 雪窦寺 成人门票", brand="雪窦山景区", face="成人票 · 不含景交车", kind="virt", cover="xdq",
      path=["A 码券类", "A5 门票", "景区", "雪窦山"], delivery="card", cost=82, price=105, week_sales=11, refund_rate=0.0, region="浙江 · 宁波奉化",
      stock={"avail": 18, "locked": 0, "sold": 57, "void": 0, "warn_at": 6, "stop_at": 0, "batches": [batch(2, "景区合作渠道（演示）", 82, 30, 18, D(-90), 15)]},
      orders=[order(6011, "买家 · 阿宁", 105, 40, "delivered"), order(6010, "买家 · 小七", 105, 200, "delivered")],
      signals={"闲鱼": peer(114, 8.9, 2000, 95, "样本里「门票」114 条；对标 奉化雪窦山雪窦寺成人门票 ¥109"), "淘宝": NOT_YET, "京东": NOT_YET},
      peers=[{"platform": "闲鱼", "shop": "同行挂牌（奉化雪窦山雪窦寺门票）", "price": 109, "sales": 0, "url": ""}],
      sourcing={"main": "景区合作渠道（演示）", "backup": "无", "cost": 82, "qualify": "无", "quota": "每周 30 张"},
      notes={"script": "电子票二维码。", "guide": "到景区扫码入园。", "refund": "出票前可退。", "stop": "景区停售即下架。"},
      compliance={"level": "A", "lawyer": "passed", "note": ""}, evidence=[SRC_PEER + " 门票 114 条"], source_tag="榜单爬虫 · 闲鱼同行样本"),
    P(id="v-tz", code="VC-A8-0001", name="台州中盛 · 餐饮优惠线索", brand="台州中盛", face="商场餐饮名单与增量核验", kind="virt", cover="tz",
      path=["A 码券类", "A8 地方活动券", "台州", "中盛"], delivery="card", cost=0, price=0, week_sales=0, refund_rate=0.0, listing_type="trial", step=1, region="浙江 · 台州",
      platforms=["闲鱼"], signals={"闲鱼": NOT_YET, "淘宝": NOT_YET, "京东": NOT_YET}, peers=[], source_tag="智能体长跑 · 浙江餐饮待调研任务",
      sourcing={"main": "待核", "backup": "待核", "cost": 0, "qualify": "待核", "quota": "待核"},
      notes={"script": "待写。", "guide": "待写。", "refund": "待定。", "stop": "活动结束或规则禁止转让 → 立刻下架。"},
      compliance={"level": "C", "lawyer": "unsubmitted", "note": "地方活动券、抢券后转卖：活动规则是否限制转让，待律师。"},
      evidence=["浙江餐饮-待调研任务.csv 任务 task_d01cea3855ed113200f9a85（台州中盛 · 餐饮名单与增量核验，2 条来源）"]),
    # ---------------- 服务类：价格、时长、成本、可信度来自 Grok 清单的真实行 ----------------
    P(id="v-cad", code="VC-C2-0037", name="CAD 平面图描图代画（图片/PDF 转 DWG）", brand="自营服务", face="1 张图纸", kind="svc", cover="cad",
      path=["C 服务类", "C2 AI 操作服务", "设计 / 工程", "CAD 描图代画"], delivery="manual", cost=12, price=58, week_sales=24, refund_rate=0.04, valid="交付后 3 天内可修改",
      capacity={"week_limit": 40, "booked": 24, "queue": [{"id": "q1", "buyer": "买家 · 工程部小陈", "slot": "今天 18:00 前", "state": "accepted", "due_min": 52}, {"id": "q2", "buyer": "买家 · 装修李", "slot": "待约", "state": "new", "due_min": 58}]},
      orders=[order(7031, "买家 · 工程部小陈", 58, 8, "delivered"), order(7030, "买家 · 装修李", 58, 240, "delivered")],
      signals={"闲鱼": {"sales": 0, "price_lo": 50, "price_hi": 2000, "sellers": 0, "rank": 1, "date": "2026-11-10", "note": "Grok #37：闲鱼 50–2000 元/单；闲鱼卖家 3 个月营收 7 万，首日 80 咨询"}, "淘宝": {"sales": 0, "price_lo": 5, "price_hi": 10, "sellers": 0, "rank": 1, "date": "2026-11-10", "note": "Grok #37：淘宝 5–10 元/张起；猪八戒 5 元/张起"}, "京东": NOT_YET},
      peers=[{"platform": "淘宝", "shop": "Grok #37 实查链接（www.218s.cn）", "price": 8, "sales": 0, "url": ""}],
      sourcing={"main": "AI 工作流 + 人工校对（赛马中）", "backup": "手工描图", "cost": 12, "qualify": "无", "quota": "每周 40 张"},
      notes={"script": "客户发图，1 小时–1 天交付 DWG。", "guide": "要求清晰原图；尺寸标注以客户为准。", "refund": "不满意可退，扣已耗时。", "stop": "退款率 > 8% → 暂停接单，复盘。"},
      compliance={"level": "B", "lawyer": "passed", "note": ""}, evidence=[SRC_GROK + " #37（实查链接，母条）"], source_tag="智能体长跑 · Grok 第三轮",
      review=[{"week": "本周", "sales": 24, "refunds": 1, "cost_delta": "+0"}]),
    P(id="v-bnb", code="VC-C2-0015", name="民宿房源图调色精修（真实照片，不虚构）", brand="自营服务", face="整套 20 张", kind="svc", cover="bnb",
      path=["C 服务类", "C2 AI 操作服务", "图片-民宿", "照片精修"], delivery="manual", cost=5, price=299, week_sales=0, refund_rate=0.0, listing_type="trial", step=3, platforms=["闲鱼", "小红书"], valid="交付后 7 天内可修改",
      signals={"闲鱼": {"sales": 0, "price_lo": 10, "price_hi": 30, "sellers": 0, "rank": 0, "date": "2026-11-10", "note": "Grok #15（估算）：10–30 元/张，整套 20 张 200–500 元"}, "淘宝": NOT_YET, "京东": NOT_YET}, peers=[],
      sourcing={"main": "image2 工作流（赛马中）", "backup": "手工精修", "cost": 5, "qualify": "只做真实照片精修，不生成不存在的设施（Airbnb/美团/携程都禁止）", "quota": "待定"}, source_tag="智能体长跑 · Grok 第三轮",
      notes={"script": "客户发原图，1 天交付。", "guide": "平台禁止 AI 生成不存在的设施，只做精修、海报、文案。", "refund": "不满意可退。", "stop": "平台投诉即停。"},
      compliance={"level": "B", "lawyer": "unsubmitted", "note": ""}, evidence=[SRC_GROK + " #15（估算）"]),
    P(id="v-ppt", code="VC-C2-0079", name="AI PPT 代做（基础 / 标准 / 高级）", brand="自营服务", face="1 份 PPT", kind="svc", cover="ppt",
      path=["C 服务类", "C2 AI 操作服务", "办公", "AI PPT"], delivery="manual", cost=8, price=100, week_sales=17, refund_rate=0.06, valid="交付后 3 天内可修改",
      capacity={"week_limit": 20, "booked": 19, "queue": [{"id": "q1", "buyer": "买家 · 研究生小周", "slot": "明天 10:00", "state": "scheduled", "due_min": 40}]},
      orders=[order(8012, "买家 · 研究生小周", 100, 20, "delivered"), order(8011, "买家 · 创业者老林", 100, 180, "delivered")],
      signals={"闲鱼": {"sales": 0, "price_lo": 50, "price_hi": 200, "sellers": 0, "rank": 2, "date": "2026-11-10", "note": "Grok #79：基础 50 / 标准 100 / 高级 200；闲鱼头部商家月销几百上千单；复盘 90 单 5400 元（博主自称）"}, "淘宝": {"sales": 0, "price_lo": 100, "price_hi": 300, "sellers": 0, "rank": 0, "date": "2026-11-10", "note": "猪八戒 100–300 元"}, "京东": NOT_YET},
      peers=[{"platform": "闲鱼", "shop": "Grok #79 来源（www.cpengx.cn）", "price": 100, "sales": 0, "url": ""}],
      sourcing={"main": "Gamma 会员（约 120 元/月）+ 人工校对", "backup": "WPS AI", "cost": 8, "qualify": "无", "quota": "每周 20 份"},
      notes={"script": "客户发提纲，1.5 小时交付。", "guide": "要提纲 + 风格偏好。", "refund": "不满意可退。", "stop": "退款率 > 8% → 暂停。"},
      compliance={"level": "B", "lawyer": "passed", "note": ""}, evidence=[SRC_GROK + " #79（博主自称）"], source_tag="智能体长跑 · Grok 第三轮"),
    P(id="v-xhs", code="VC-C2-0070", name="小红书种草笔记代写（图文）", brand="自营服务", face="1 篇图文", kind="svc", cover="xhs",
      path=["C 服务类", "C2 AI 操作服务", "文案", "小红书种草"], delivery="manual", cost=3, price=120, week_sales=0, refund_rate=0.0, listing_type="trial", step=5, platforms=["闲鱼", "小红书"],
      signals={"闲鱼": {"sales": 0, "price_lo": 50, "price_hi": 400, "sellers": 0, "rank": 0, "date": "2026-11-10", "note": "Grok #70：纯文案 50–120；图文 80–200；测评 200–400（博主自称）"}, "淘宝": NOT_YET, "京东": NOT_YET}, peers=[],
      sourcing={"main": "AI 文案 + 人工润色", "backup": "无", "cost": 3, "qualify": "无", "quota": "每周 20 篇"}, source_tag="智能体长跑 · Grok 第三轮",
      notes={"script": "客户给产品信息，当天交付。", "guide": "提供卖点和图。", "refund": "不满意可改一次。", "stop": "平台限流即停。"},
      compliance={"level": "B", "lawyer": "unsubmitted", "note": ""}, evidence=[SRC_GROK + " #70（博主自称）"]),
    P(id="v-vid", code="VC-C2-0053", name="短视频代剪（15–30 秒商品展示）", brand="自营服务", face="1 条", kind="svc", cover="vid",
      path=["C 服务类", "C2 AI 操作服务", "视频", "短视频代剪"], delivery="manual", cost=2, price=28, week_sales=33, refund_rate=0.015, valid="交付后 1 天内可修改",
      capacity={"week_limit": 80, "booked": 33, "queue": []},
      orders=[order(9042, "买家 · 淘宝小店主", 28, 30, "delivered"), order(9041, "买家 · 档口老板", 84, 120, "delivered")],
      signals={"闲鱼": {"sales": 0, "price_lo": 20, "price_hi": 28, "sellers": 0, "rank": 0, "date": "2026-11-10", "note": "Grok #53：28 元/条起；批量 3 条起 25，8 条起 20（实查链接）"}, "淘宝": NOT_YET, "京东": NOT_YET},
      peers=[{"platform": "站外", "shop": "Grok #53 实查链接（www.ukezhitan.com）", "price": 28, "sales": 0, "url": ""}],
      sourcing={"main": "剪映 AI + 人工校对", "backup": "无", "cost": 2, "qualify": "无", "quota": "每周 80 条"},
      notes={"script": "客户发素材，当天交付。", "guide": "素材要横竖屏一致。", "refund": "不满意可返工一次。", "stop": "返工率高 → 复盘。"},
      compliance={"level": "A", "lawyer": "passed", "note": ""}, evidence=[SRC_GROK + " #53（实查链接）"], source_tag="智能体长跑 · Grok 第三轮",
      review=[{"week": "本周", "sales": 33, "refunds": 0, "cost_delta": "+0"}]),
    P(id="v-and", code="VC-C1-0001", name="安卓刷机服务", brand="自营服务", face="到店 / 远程 · 1 台", kind="svc", cover="flash",
      path=["C 服务类", "C1 设备技术服务", "安卓刷机"], delivery="manual", cost=40, price=99, week_sales=11, refund_rate=0.0, valid="服务后 7 天内保修", region="杭州 · 到店 / 远程",
      capacity={"week_limit": 15, "booked": 9, "queue": [{"id": "q1", "buyer": "买家 · 阿远", "slot": "周六 10:00", "state": "scheduled", "due_min": 300}, {"id": "q2", "buyer": "买家 · 贝贝（急单）", "slot": "待约", "state": "new", "due_min": 6}]},
      orders=[order(9107, "买家 · 阿远", 99, 400, "delivered"), order(9106, "买家 · 贝贝（急单）", 99, 54, "delivered")],
      signals={"闲鱼": {"sales": 0, "price_lo": 79, "price_hi": 149, "sellers": 55, "rank": 3, "date": "2026-11-10", "note": "同行手机救护站 ¥99（演示）；Grok 清单无此条，C1 来自方案"}, "淘宝": NOT_YET, "京东": NOT_YET},
      peers=[{"platform": "闲鱼", "shop": "同行挂牌（演示）", "price": 99, "sales": 0, "url": ""}],
      sourcing={"main": "自有人员交付", "backup": "合作维修店", "cost": 40, "qualify": "会刷机", "quota": "每周 15 台"},
      notes={"script": "接单后约时间；刷完发验收截图。", "guide": "先备份；刷机有风险，签知情同意。", "refund": "未开工可退；开工后按进度。", "stop": "报错率高 → 暂停接单。"},
      compliance={"level": "B", "lawyer": "reviewing", "note": "设备归属证明、留存材料。"}, evidence=["方案 C1 设备技术服务（价格为演示数值）"], source_tag="人工来源",
      review=[{"week": "本周", "sales": 11, "refunds": 0, "cost_delta": "+0"}], learn=None),  # learn 在下面 _attach 里补
    P(id="v-game", code="VC-C1-0002", name="《三角洲行动》虚拟化报警处理（远程）", brand="自营服务", face="远程 · 1 台", kind="svc", cover="game",
      path=["C 服务类", "C1 设备技术服务", "游戏报错处理", "三角洲行动 · 虚拟化报警"], delivery="manual", cost=0, price=39, week_sales=0, refund_rate=0.0, valid="服务后 7 天内保修", region="全国 · 远程",
      step=5, listing_type="route", orders=[], capacity={"week_limit": 20, "booked": 0, "queue": []},
      signals={"闲鱼": {"sales": 0, "price_lo": 20, "price_hi": 99, "sellers": 0, "rank": 0, "date": "2026-11-11", "note": "同行有人卖游戏报错处理（具体数字待采集，演示）"}, "淘宝": NOT_YET, "京东": NOT_YET},
      peers=[{"platform": "闲鱼", "shop": "同行挂牌（演示）", "price": 39, "sales": 0, "url": ""}],
      sourcing={"main": "同行远程操作学习 → 做成教程 + Skill → 自有人员 / Agent 交付", "backup": "转同行交付（急单、疑难）", "cost": 0, "qualify": "无（学会之前先走同行路线）", "quota": "每周 20 单"},
      notes={"script": "接单 → 客户授权设备 → 临时识别码 → 按 Skill / SOP 操作 → 画面验证。", "guide": "客户不告诉我们密码、验证码；远控结束让客户改相关凭据。", "refund": "没解决可退。", "stop": "复现不通过 → 暂停接单，转同行。"},
      compliance={"level": "B", "lawyer": "reviewing", "note": "远程接入客户电脑，要留授权记录（演示）。"}, evidence=["用户业务描述（三角洲行动虚拟化报警）；服务远控交接包"], source_tag="人工来源",
      review=[], decision="还没上架", learn=_learn_preset()),
    P(id="v-gpt", code="VC-B1-0001", name="ChatGPT Plus 月卡代充", brand="OpenAI", face="Plus · 1 个月", kind="virt", cover="chatgpt",
      path=["B 数字权益类", "B1 AI 会员", "ChatGPT"], delivery="topup", cost=138, price=168, week_sales=14, refund_rate=0.05, valid="充值后 30 天",
      orders=[order(10010, "买家 · Leo", 168, 20, "delivered"), order(10009, "买家 · 青柠", 168, 95, "delivered")],
      signals={"闲鱼": {"sales": 0, "price_lo": 150, "price_hi": 210, "sellers": 0, "rank": 1, "date": "2026-11-10", "note": "Grok 第一轮：代充 / 成品号 / 发卡话题 7 天 4,799 条（账号口径）"}, "淘宝": NOT_YET, "京东": NOT_YET},
      sourcing={"main": "代充货源接口（国际渠道）", "backup": "手工充值", "cost": 138, "qualify": "需稳定支付渠道", "quota": "不限"},
      notes={"script": "充值完成后截图回传。", "guide": "买家提供账号邮箱，不要密码。", "refund": "未充值可退。", "stop": "渠道封号或涨价 → 暂停。"},
      compliance={"level": "C", "lawyer": "risk", "note": "账号共享 / 代持，平台协议风险（演示结论）。"}, evidence=["Grok 第一轮 X 账号调研（代充话题热度）"], source_tag="智能体长跑 · Grok 第一轮"),
]


def _learn_fresh(case):
    """新立项：从第 1 步开始。采集、证据、成品全部是「还没有」。"""
    miss = lambda name: {"name": name, "state": "missing", "detail": "还没开始"}  # noqa: E731
    return {
        "case": {"goal": case.get("goal", ""), "scene": case.get("scene", ""), "env": case.get("env", ""), "symptom": "", "peer": "", "price": case.get("price", ""), "sla": "1 小时"},
        "stage": 1, "done": {}, "env_ok": {"isolated": False, "present": False},
        "session": {"id": "", "machine": "", "remote": "", "segments": 0, "started": "", "ended": ""},
        "capture": {"tools": miss("工具与环境清单（osquery）"), "events": miss("后台操作事件（Fibratus 被动捕获）"), "video": miss("屏幕录像（OBS 本机）"),
                    "terminal": miss("终端命令与输出"), "downloads": miss("下载的工具和来源")},
        "keynodes": [], "verify": {"state": "pending", "note": ""},
        "outputs": {"sop": {"name": "说明 SOP", "state": "none", "detail": "还没有"}, "video": {"name": "业务员手绘教程 MP4", "state": "none", "detail": "还没有"},
                    "skill": {"name": "执行 Skill（Computer Use SKILL）", "state": "none", "detail": "还没有"}},
        "repro": {"state": "none", "note": ""}, "library": {"state": "none", "version": ""}, "supplements": [], "log": [],
        "runner": {"name": "云端 Codex Desktop（带 Computer Use）", "skill": "这项服务的专属 Skill（复现通过后绑定版本）", "remote": "向日葵官方 MCP（首选）/ ToDesk（备用）",
                   "state": "未接入", "note": "要程序员把云端 Codex Desktop、专属 Skill、向日葵 MCP 接起来并在干净 Windows 上验收；现在界面里是演示数据"},
    }



def _learn_done():
    """安卓刷机：演示里是「已学成、已入库」的状态，用来展示对客交付那一步。"""
    L = _learn_preset()
    L["case"] = {"goal": "安卓手机刷机（具体机型 / 固件 / 工具按订单）", "scene": "客户手机卡在开机界面或要换系统", "env": "客户 Windows 电脑 + 手机（机型按订单）", "symptom": "原始现象按订单记录",
                 "peer": "同行手机救护站（演示）", "price": "¥99（演示）", "sla": "1 小时"}
    L["stage"] = 14
    L["done"] = {str(i): True for i in range(1, 9)}
    L["session"].update({"id": "LS-20261105-003", "ended": "11:40", "segments": 1})
    for k in ("terminal", "downloads"):
        L["capture"][k] = {"name": L["capture"][k]["name"], "state": "ok", "detail": "命令正文、输出、下载来源都已取得并与时间码关联（演示）"}
    L["verify"] = {"state": "ok", "note": "手机能正常开机进系统，已让客户当面确认（演示）"}
    L["outputs"] = {
        "sop": {"name": "说明 SOP", "state": "ready", "detail": "含工具下载清单、完整终端操作手册、判断分支、验收和异常升级（演示）"},
        "video": {"name": "业务员手绘教程 MP4", "state": "built", "detail": "12 分 05 秒，已完整播放检查（演示）", "file": "tutorials/android-flash-v1.mp4"},
        "skill": {"name": "执行 Skill（Computer Use SKILL）", "state": "verified", "detail": "v1.0；在干净 Windows 上独立复现通过（演示）"},
    }
    L["repro"] = {"state": "ok", "note": "干净 Windows 上只靠 Skill 重做一遍，手机正常开机（演示）"}
    L["library"] = {"state": "listed", "version": "v1.0"}
    L["runner"] = {"name": "云端 Codex Desktop（带 Computer Use）", "skill": "安卓刷机 专属 Skill v1.0", "remote": "向日葵官方 MCP（首选）/ ToDesk（备用）", "state": "演示：已接入",
                   "note": "演示数据。真实要程序员接通并验收"}
    L["onboarding"] = {"steps": [
        {"t": "发接入指引（教客户装向日葵）", "state": "done", "who": "Agent"}, {"t": "客户装好、生成临时识别码", "state": "done", "who": "客户"},
        {"t": "确认客户授权的设备和范围", "state": "done", "who": "Agent + 员工"}, {"t": "接入并核对设备（不是同名设备、不是列表第一个）", "state": "done", "who": "Agent"}]}
    L["delivery"] = {"remote": "向日葵（首选，官方 MCP）；ToDesk 备用", "orders": [
        {"id": "D-9108", "buyer": "买家 · 阿远", "device": "客户 Windows（已授权）", "remote": "向日葵 · 临时识别码", "state": "Agent 按 Skill 操作中（4 / 6 步）", "due_min": 38},
    ]}
    return L

for _p in PRODUCTS:
    if _p["id"] == "v-and":
        _p["learn"] = _learn_done()
        _p["step"] = 8

DB = {p["id"]: p for p in PRODUCTS}
INIT = copy.deepcopy(DB)


def _steps(p):
    out = []
    for n, title, give, done_when in SOP:
        if p["listing_type"] == "follow" and n in (5, 6):
            st = "skip"
        elif n < p["step"]:
            st = "done"
        elif n == p["step"]:
            st = "cur"
        else:
            st = "todo"
        out.append({"n": n, "title": title, "give": give, "done_when": done_when, "state": st})
    return out


def _learn_nodes(L):
    d = L["done"]
    flags = {i: bool(d.get(str(i))) for i in range(1, 9)}
    flags[8] = flags[8] or L["verify"]["state"] != "pending"
    flags[4] = flags[4] and L["env_ok"]["isolated"] and L["env_ok"]["present"]
    flags[9] = bool(L["session"]["ended"])
    o = L["outputs"]
    flags[10] = o["sop"]["state"] == "ready" and o["video"]["state"] == "built" and o["skill"]["state"] in ("generated", "verified")
    flags[11] = L["repro"]["state"] == "ok"
    flags[12] = L["library"]["state"] == "listed"
    flags[13] = bool((L.get("delivery") or {}).get("orders"))   # 已有订单接入 = 对接这步做完了
    flags[14] = False
    nodes, cur = [], None
    for n, title, role, desc in LEARN_NODES:
        if cur is None and not flags[n]:
            cur = n
        nodes.append({"n": n, "title": title, "role": role, "desc": desc, "state": "done" if flags[n] else ("cur" if cur == n else "todo")})
    return nodes


def _sync_commission():
    try:
        import pricing_stub
        pricing_stub.sync_commission_summary()
    except Exception:
        pass


def _view(p):
    v = copy.deepcopy(p)
    if v.get("stock") and "vault" in v["stock"]:
        raw_v = v["stock"].pop("vault") or []
        v["stock"]["vault_masked"] = [_mask_card(x) for x in raw_v[:10]]
    v["steps"] = _steps(p)
    if p.get("learn"):
        v["learn_nodes"] = _learn_nodes(p["learn"])
    v["delivery_label"] = DELIVERY[p["delivery"]]
    v["floor_pct"] = float(p.get("floor_pct") or (105 if p["delivery"] == "card" else 130))
    cost = float(p.get("cost") or 0)
    price = float(p.get("price") or 0)
    fee = round(price * float(p.get("platform_fee_rate") or 0), 2)
    reserve = float(p.get("after_sale_reserve") or 0)
    v["floor_price"] = round(cost * v["floor_pct"] / 100, 2) if cost > 0 else 0
    v["unit_contribution"] = round(price - cost - fee - reserve, 2)
    return v


@router.get("/products", summary="虚拟商品 / 服务列表（演示）")
def list_products(_=Depends(get_current_user)):
    return {"items": [_view(p) for p in DB.values()], "sop": [{"n": a, "title": b} for a, b, _c, _d in SOP]}


@router.get("/products/{pid}", summary="一张产品卡（演示）")
def one(pid: str, _=Depends(get_current_user)):
    if pid not in DB:
        raise HTTPException(404, "没有这张产品卡")
    return _view(DB[pid])


@router.post("/products/{pid}/restock", summary="补货：入一批卡券（支持粘贴原始卡密自动洗重或直接填张数）")
def restock(pid: str, body: dict, _=Depends(get_current_user)):
    p = DB.get(pid)
    if not p or not p.get("stock"):
        raise HTTPException(404, "这张产品卡没有卡密库存池")
    raw_cards = str(body.get("raw_cards") or "").strip()
    dedup_info = None
    if raw_cards:
        parsed = _parse_card_lines(raw_cards, existing_vault=p["stock"].get("vault") or [])
        n = parsed["net_imported"]
        if n <= 0:
            raise HTTPException(400, f"粘贴的卡密经去重后有效张数为 0（共过滤重复/空行 {parsed['duplicates_removed'] + parsed['empty_removed']} 条）")
        p["stock"].setdefault("vault", []).extend(parsed["unique_cards"])
        dedup_info = parsed
    else:
        n = int(body.get("n") or 0)
        if n <= 0:
            raise HTTPException(400, "补多少张要写清楚（或直接粘贴卡密文本）")
    s = p["stock"]
    s["avail"] += n
    exp_str = str(body.get("expire") or D(-90)).strip() or D(-90)
    s["batches"].insert(0, batch(len(s["batches"]) + 1, body.get("supplier") or "手工补货", p["cost"], n, n, exp_str, 0))
    if dedup_info:
        s["last_dedup"] = {k: dedup_info[k] for k in ("raw_lines", "empty_removed", "duplicates_removed", "net_imported", "duplicate_samples")}
    for o in p["orders"]:   # 缺货等着的单，自动发出
        if o["status"] == "waiting" and s["avail"] > 0:
            o["status"] = "delivered"
            o["hit"] = []
            s["avail"] -= 1
            s["sold"] += 1
    return _view(p)


@router.post("/products/{pid}/orders/{oid}/release", summary="放行被发货检查拦住的单")
def release(pid: str, oid: str, _=Depends(get_current_user)):
    p = DB[pid]
    o = next((x for x in p["orders"] if x["id"] == oid), None)
    if not o:
        raise HTTPException(404, "没有这笔订单")
    o["status"] = "delivered"
    o["hit"] = []
    if p.get("stock") and p["stock"]["avail"] > 0:
        p["stock"]["avail"] -= 1
        p["stock"]["sold"] += 1
    _sync_commission()
    return _view(p)


@router.post("/products/{pid}/pricing", summary="直接更新虚拟/服务产品进价、售价与底线倍数（人工二审生效并重算提成）")
def update_pricing(pid: str, body: dict, u=Depends(get_current_user)):
    p = DB.get(pid)
    if not p:
        raise HTTPException(404, "没有这张产品卡")
    price = float(body["price"]) if body.get("price") is not None else float(p.get("price") or 0)
    cost = float(body["cost"]) if body.get("cost") is not None else float(p.get("cost") or 0)
    floor_pct = float(body["floor_pct"]) if body.get("floor_pct") is not None else float(p.get("floor_pct") or (105 if p["delivery"] == "card" else 130))
    fee_rate = float(body["platform_fee_rate"]) if body.get("platform_fee_rate") is not None else float(p.get("platform_fee_rate") or 0.016)
    reserve = float(body["after_sale_reserve"]) if body.get("after_sale_reserve") is not None else float(p.get("after_sale_reserve") or 1.0)
    if price <= 0:
        raise HTTPException(400, "售价必须大于 0")
    floor = round(cost * floor_pct / 100, 2) if cost > 0 else 0
    override_reason = str(body.get("override_reason") or "").strip()
    if floor > 0 and price < floor and len(override_reason) < 3:
        raise HTTPException(400, f"售价 ¥{price} 低于底线 ¥{floor}（进价 ¥{cost} × {floor_pct}%），请填写低于底线原因")
    p["price"] = round(price, 2)
    p["cost"] = round(cost, 2)
    p["floor_pct"] = round(floor_pct, 2)
    p["platform_fee_rate"] = round(fee_rate, 4)
    p["after_sale_reserve"] = round(reserve, 2)
    p.setdefault("evidence_log", []).append({
        "step": p["step"],
        "who": getattr(u, "name", u.username),
        "data": {"定价更新": f"售价 ¥{p['price']} / 进价 ¥{p['cost']} / 底线 {p['floor_pct']}%" + (f"（放行原因：{override_reason}）" if override_reason else "")},
        "t": datetime.now().strftime("%m-%d %H:%M"),
    })
    _sync_commission()
    return _view(p)


@router.post("/products/{pid}/refund-list", summary="手动加入退款名单")
def add_refund(pid: str, body: dict, _=Depends(get_current_user)):
    p = DB[pid]
    p["refund_list"].append({"buyer": body.get("buyer") or "买家 · 新增", "count": 2, "source": "手动", "since": D(0)})
    return _view(p)


@router.post("/products/{pid}/auto-delivery", summary="开 / 关自动发货")
def auto_delivery(pid: str, body: dict, _=Depends(get_current_user)):
    DB[pid]["auto_delivery"] = bool(body.get("on"))
    return _view(DB[pid])


@router.post("/products/{pid}/advance", summary="这一步做完，推进到下一步：必填证据和格式服务端同样校验，缺证据交不上去")
def advance(pid: str, body: dict | None = None, u=Depends(get_current_user)):
    p = DB[pid]
    ev = (body or {}).get("evidence")
    if p["step"] < 8:
        if not isinstance(ev, dict) or not ev:
            raise HTTPException(400, "这一步要交的证据还没填：缺证据交不上去")
        empty = [k for k, v in ev.items() if not str(v).strip()]
        if empty:
            raise HTTPException(400, "还缺：" + "、".join(empty) + "。缺的写「待核」，不要空着")
        zero = [k for k, v in ev.items() if str(v).strip() in ("0", "0.0", "0.00")]
        if zero:
            raise HTTPException(400, "「" + "、".join(zero) + "」填了 0：缺数据写「待核」，不要填 0")
        p.setdefault("evidence_log", []).append({"step": p["step"], "who": u.name, "data": ev, "t": datetime.now().strftime("%m-%d %H:%M")})
    if p["step"] >= 8:
        raise HTTPException(400, "已经在售，下一步是周复盘")
    nxt = p["step"] + 1
    if p["listing_type"] == "follow" and nxt in (5, 6):
        nxt = 7
    p["step"] = nxt
    return _view(p)


@router.post("/products/{pid}/svc/{qid}/{action}", summary="服务订单往下走：接单 → 约时间 → 交付 → 买家确认；急单疑难转同行")
def svc_step(pid: str, qid: str, action: str, body: dict | None = None, _=Depends(get_current_user)):
    p = DB[pid]
    q = next((x for x in (p.get("capacity") or {}).get("queue", []) if x["id"] == qid), None)
    if not q:
        raise HTTPException(404, "没有这条服务订单")
    flow = {"accept": ("new", "accepted"), "schedule": ("accepted", "scheduled"), "deliver": ("scheduled", "delivered"), "confirm": ("delivered", "done")}
    if action == "handoff":
        if q["state"] in ("delivered", "done"):
            raise HTTPException(400, "已经交付了，不用转")
        q["state"] = "handoff"
        q["slot"] = "已转给同行接手（带着原始现象、已做动作、环境和材料）"
        return _view(p)
    if action not in flow:
        raise HTTPException(400, "不认识这个动作")
    need, nxt = flow[action]
    if q["state"] != need:
        raise HTTPException(400, "这一步要等上一步做完：现在是「%s」" % q["state"])
    if action == "schedule":
        q["slot"] = (body or {}).get("slot") or "周六 10:00"
    q["state"] = nxt
    if nxt == "done":
        p["week_sales"] += 1
        _sync_commission()
    return _view(p)


@router.post("/products/{pid}/auto-refund", summary="自动同意 / 自动拒绝退款（阿奇索口径）：未发货自动同意，已发货转人工")
def auto_refund(pid: str, body: dict, _=Depends(get_current_user)):
    DB[pid]["auto_refund"] = bool(body.get("on"))
    return _view(DB[pid])


REVEALS: list[dict] = []


@router.post("/products/{pid}/orders/{oid}/reveal", summary="显示卡密（留痕：谁、什么时候、哪一单）")
def reveal(pid: str, oid: str, u=Depends(get_current_user)):
    p = DB[pid]
    if not any(x["id"] == oid for x in p["orders"]):
        raise HTTPException(404, "没有这笔订单")
    REVEALS.append({"who": u.name, "pid": pid, "oid": oid, "t": datetime.now().strftime("%H:%M:%S")})
    vault = (p.get("stock") or {}).get("vault") or []
    code_val = vault[0] if vault else ("CODE-" + oid[-4:] + "-DEMO")
    return {"code": code_val, "log": [r for r in REVEALS if r["pid"] == pid][-5:]}


def _gaps(L):
    return [k for k in ("terminal", "downloads") if L["capture"][k]["state"] != "ok"]


@router.post("/products/{pid}/learn/{action}", summary="技术服务：学习到交付全流程。每个闸门服务端同样校验，缺证据过不去")
def learn_step(pid: str, action: str, body: dict | None = None, u=Depends(get_current_user)):
    p = DB.get(pid)
    if not p or not p.get("learn"):
        raise HTTPException(404, "这张产品卡没有学习到交付流程")
    L, b = p["learn"], (body or {})
    cap, out = L["capture"], L["outputs"]
    now = datetime.now().strftime("%m-%d %H:%M")
    if action == "confirm_env":
        if not L["done"].get("3"):
            raise HTTPException(400, "先完成第 3 步（找同行，谈可接范围），再准备学习机。")
        if not (b.get("isolated") and b.get("present")):
            raise HTTPException(400, "要先确认两件事才能开始：① 这台学习机是隔离的，没有任何正式运营账号、支付工具、客户资料；② 我方人员全程在场。缺一件都不能开始。")
        L["env_ok"] = {"isolated": True, "present": True}
        L["done"]["4"] = True
    elif action == "supplement":
        ch, content = b.get("channel"), (b.get("content") or "").strip()
        if ch not in ("terminal", "downloads"):
            raise HTTPException(400, "不认识的补录项")
        if b.get("unavailable"):
            cap[ch]["state"] = "unknown"
            cap[ch]["detail"] = "同行也拿不到，已标「未知」，不补造。这一项没补齐，不能放行 Skill。"
        else:
            if len(content) < 6:
                raise HTTPException(400, "补录的正文不能空：命令正文、输出，或下载的网址、文件名。拿不到就点「同行也拿不到」，不要编。")
            cap[ch]["state"] = "ok"
            cap[ch]["detail"] = "同行补录，已和时间码关联：" + (content[:40] + "…" if len(content) > 40 else content)
        L["supplements"].append({"channel": ch, "who": u.name, "t": now, "unavailable": bool(b.get("unavailable"))})
    elif action == "step":
        n = int(b.get("n") or 0)
        if n not in (1, 2, 3, 6):
            raise HTTPException(400, "这一步不是用这个动作完成的")
        if n > 1 and not L["done"].get(str(n - 1)):
            raise HTTPException(400, f"先完成第 {n - 1} 步，再做第 {n} 步。")
        c = L["case"]
        t = lambda k: (b.get(k) or "").strip()  # noqa: E731
        if n == 1:
            if len(t("goal")) < 6 or len(t("scene")) < 4 or len(t("env")) < 3:
                raise HTTPException(400, "研究卡要写清楚：要学的具体服务结果（不是宽泛的「维修」）、客户场景、设备和系统版本。缺的写「待核」，不要空着。")
            c.update(goal=t("goal"), scene=t("scene"), env=t("env"), price=t("price") or c.get("price", ""))
            p["name"] = t("goal")
        elif n == 2:
            if len(t("symptom")) < 6:
                raise HTTPException(400, "要写下复现时看到的真实现象：错误码、弹窗文字、Windows 环境。没复现出来就别往下走。")
            c["symptom"] = "原始现象：" + t("symptom")
        elif n == 3:
            if len(t("peer")) < 2 or len(t("scope")) < 4:
                raise HTTPException(400, "要写清楚找的是哪位同行，他能接什么、用什么工具、交付条件。密码、验证码不要写进来。")
            c["peer"] = t("peer") + "（可接范围：" + t("scope") + "）"
            c["price"] = t("price") or c.get("price", "")
        elif n == 6:
            if not L["session"]["id"]:
                raise HTTPException(400, "还没开会话、没检查三路采集，同行不能开始操作。")
            if len(t("note")) < 4:
                raise HTTPException(400, "写一句同行大概做了什么、有没有越界（我方全程在场）。")
            L["session"]["started"] = L["session"]["started"] or now[-5:]
        L["done"][str(n)] = True
    elif action == "start_capture":
        if not (L["env_ok"]["isolated"] and L["env_ok"]["present"]):
            raise HTTPException(400, "先完成第 4 步：确认学习机是隔离的、我方在场。")
        miss = [nm for k, nm in (("tools", "工具与环境清单"), ("events", "后台操作事件"), ("video", "屏幕录像")) if not b.get(k)]
        if miss:
            raise HTTPException(400, "三路采集要都在记录才能开始，还缺：" + "、".join(miss) + "。先处理采集，再开始。")
        mach, rem = (b.get("machine") or "").strip(), (b.get("remote") or "").strip()
        if len(mach) < 2 or len(rem) < 2:
            raise HTTPException(400, "写清楚是哪台学习机、同行用的什么远控。")
        L["session"].update(id="LS-" + datetime.now().strftime("%Y%m%d-%H%M"), machine=mach, remote=rem, segments=1)
        for k in ("tools", "events", "video"):
            L["capture"][k]["state"] = "ok"
            L["capture"][k]["detail"] = "在记录（演示：实际由采集器记录，数字待程序员接入）"
        for k in ("terminal", "downloads"):
            L["capture"][k]["state"] = "missing"
            L["capture"][k]["detail"] = "采集入口已开；同行操作后若没取到正文 / 来源，要补录"
        L["done"]["5"] = True
    elif action == "keynode":
        if not L["done"].get("6"):
            raise HTTPException(400, "同行还没操作完，先完成第 6 步，再标关键节点。")
        t_, kind, text = (b.get("t") or "").strip(), (b.get("kind") or "").strip(), (b.get("text") or "").strip()
        if not t_ or kind not in ("警告", "弹窗", "验证", "失败", "重启", "解决") or len(text) < 3:
            raise HTTPException(400, "关键节点要有时间码、类型（警告 / 弹窗 / 验证 / 失败 / 重启 / 解决）和一句话说明。看不清的写「未知」，别猜。")
        L["keynodes"].append({"t": t_, "kind": kind, "text": text})
        L["done"]["7"] = True
    elif action == "verify":
        if not L["done"].get("7"):
            raise HTTPException(400, "先完成第 7 步（标记关键节点），再验证原问题。")
        note = (b.get("note") or "").strip()
        if len(note) < 4:
            raise HTTPException(400, "要写清楚怎么验证的、结果是什么。工具显示成功、进度 100% 都不算恢复。")
        L["verify"] = {"state": "ok" if b.get("ok") else "fail", "note": note}
        L["done"]["8"] = True
    elif action == "finish":
        if L["verify"]["state"] == "pending":
            raise HTTPException(400, "先验证原问题有没有恢复，再保全证据、结束会话。")
        L["session"]["ended"] = now[-5:]
    elif action == "build":
        which = b.get("which")
        if which == "sop":
            if not L["session"]["ended"]:
                raise HTTPException(400, "先结束学习会话、保全证据，再整理 SOP。")
            g = _gaps(L)
            out["sop"] = {"name": out["sop"]["name"], "state": "draft" if g else "ready",
                          "detail": ("还缺终端操作手册 / 下载来源，先停在草稿" if g else "含工具下载清单、完整终端操作手册、判断分支、验收和异常升级")}
        elif which == "video":
            f, sec = (b.get("file") or "").strip(), int(b.get("seconds") or 0)
            if not f.lower().endswith(".mp4") or sec <= 0:
                raise HTTPException(400, "「已交视频」要有能完整播放的 MP4 文件（路径和时长）。分镜、动画代码、HTML 都不算视频。")
            out["video"] = {"name": out["video"]["name"], "state": "built", "detail": f"{sec // 60} 分 {sec % 60} 秒，已完整播放检查", "file": f}
        elif which == "skill":
            g = _gaps(L)
            if g:
                names = {"terminal": "终端命令正文和输出", "downloads": "下载工具的来源"}
                raise HTTPException(400, "缺「" + "、".join(names[k] for k in g) + "」的证据，不能生成可执行 Skill，只能停在「待补证」：请同行补录，不让模型把没看到的步骤编成一键脚本。")
            out["skill"] = {"name": out["skill"]["name"], "state": "generated", "detail": "已生成，还没在干净 Windows 上复现，不能放行"}
        else:
            raise HTTPException(400, "不认识的成品")
    elif action == "repro":
        if out["skill"]["state"] not in ("generated", "verified", "failed"):
            raise HTTPException(400, "还没有 Skill，没法复现。")
        note = (b.get("note") or "").strip()
        if len(note) < 4:
            raise HTTPException(400, "写清楚在哪套干净 Windows、怎么做的、结果是什么。")
        ok = bool(b.get("ok"))
        L["repro"] = {"state": "ok" if ok else "fail", "note": note}
        out["skill"]["state"] = "verified" if ok else "failed"
        out["skill"]["detail"] = "在干净 Windows 上独立复现通过" if ok else "复现没通过，回去补证据或补演示"
    elif action == "release":
        if out["skill"]["state"] != "verified":
            raise HTTPException(400, "Skill 还没在干净 Windows 上独立复现通过，不能进可售服务能力库。")
        if out["sop"]["state"] != "ready" or out["video"]["state"] != "built":
            raise HTTPException(400, "三个成品要齐：SOP 要定稿、教程视频要有 MP4。Agent 卡住时人要靠它们兜底。")
        L["library"] = {"state": "listed", "version": "v1.0"}
        p["step"] = 8
    elif action == "onboard":
        if L["library"]["state"] != "listed":
            raise HTTPException(400, "这项服务还没进可售服务能力库，不能对客交付：先走完前面的步骤；急单先转同行。")
        buyer = (b.get("buyer") or "买家 · 演示客户").strip()
        L["onboarding"] = {"steps": [
            {"t": "发接入指引（教客户装向日葵、生成临时识别码）", "state": "done", "who": "Agent"},
            {"t": "客户装好并给出临时识别码", "state": "done", "who": "客户"},
            {"t": "确认客户授权的设备和范围", "state": "done", "who": "Agent + 员工"},
            {"t": "接入并核对设备（不是同名设备、不是列表第一个）", "state": "done", "who": "Agent"}]}
        L["delivery"] = {"remote": "向日葵（首选，官方 MCP）；ToDesk 备用", "orders": [
            {"id": "D-" + now.replace("-", "").replace(":", "").replace(" ", "")[:8], "buyer": buyer, "device": "客户 Windows（已授权）", "remote": "向日葵 · 临时识别码", "state": "Agent 已接入，按专属 Skill 准备操作", "due_min": 55}]}
    elif action == "reset":
        p["learn"] = _learn_done() if pid == "v-and" else (_learn_preset() if pid == "v-game" else _learn_fresh(p["learn"]["case"] if p.get("learn") else {}))
        return _view(p)
    elif action == "handoff":
        L.setdefault("log", []).append({"t": now, "who": u.name, "text": b.get("text") or "转同行交付"})
    else:
        raise HTTPException(404, "不认识的动作")
    L.setdefault("log", []).append({"t": now, "who": u.name, "text": action})
    return _view(p)



# ======================================================================================
# 服务 Skill 台账：每一项服务能力（Skill）一行，按服务类型分类（像餐饮卡券那样一层层分）。
# 分类树依据：业务模块 13（系统配置、数据迁移、网络诊断、游戏报错处理、安卓恢复……按具体环境、问题、交付结果细分）和已有的 C 类服务路径。
# 两种 Skill：远程操作类（同行实操学习 → Computer Use Skill，要复现通过才入库）、AI 工作流类（内容生成 + 人工校对）。
# 数字（成交、成功率、耗时、版本日期）是演示值，不是真实统计。
# ======================================================================================
SKILL_TREE = [
    {"id": "C1", "name": "C1 设备技术服务", "note": "远程操作类：同行实操学习 → 教程 + SOP + Computer Use Skill → 复现 → 对客交付", "kind": "remote", "leaves": [
        {"id": "C1-1", "name": "系统配置"}, {"id": "C1-2", "name": "数据迁移"}, {"id": "C1-3", "name": "网络诊断"},
        {"id": "C1-4", "name": "游戏报错处理"}, {"id": "C1-5", "name": "安卓恢复 / 刷机"}]},
    {"id": "C2", "name": "C2 AI 操作服务", "note": "AI 工作流类：AI 生成 + 人工校对，赛马选出最稳的工作流", "kind": "workflow", "leaves": [
        {"id": "C2-1", "name": "设计 / 工程"}, {"id": "C2-2", "name": "图片-民宿"}, {"id": "C2-3", "name": "办公"},
        {"id": "C2-4", "name": "文案"}, {"id": "C2-5", "name": "视频"}]},
]
SKILL_LEAF = {"游戏报错处理": "C1-4", "安卓刷机": "C1-5", "设计 / 工程": "C2-1", "图片-民宿": "C2-2", "办公": "C2-3", "文案": "C2-4", "视频": "C2-5"}
SKILL_META = {  # 演示值
    "v-and": {"deps": ["刷机工具（合法来源，按订单机型）", "手机驱动", "向日葵客户端（客户侧）"], "stats": {"orders": 11, "ok": 91, "avg_min": 46, "to_peer": 1}, "owner": "陈小满",
              "log": [{"v": "v1.0", "date": "2026-11-05", "note": "首版：干净 Windows 独立复现通过；教程 MP4、SOP、Skill 三样齐"}], "risk": "刷机有风险，先备份、签知情同意（演示）"},
    "v-game": {"deps": ["待同行补录后写入（现在不编）"], "stats": {"orders": 0, "ok": None, "avg_min": None, "to_peer": 0}, "owner": "陈小满", "log": [], "risk": "缺终端命令和下载来源证据，不能生成可执行 Skill"},
    "v-cad": {"deps": ["AI 工作流（图转 DWG）", "人工校对"], "stats": {"orders": 24, "ok": 96, "avg_min": 55, "to_peer": 0}, "owner": "陈小满", "log": [{"v": "v0.3", "date": "2026-11-08", "note": "赛马中：AI 工作流 vs 手工描图（演示）"}], "risk": "清晰原图才能保证质量"},
    "v-bnb": {"deps": ["image2 工作流", "人工校对"], "stats": {"orders": 0, "ok": None, "avg_min": None, "to_peer": 0}, "owner": "陈小满", "log": [{"v": "v0.1", "date": "2026-11-09", "note": "赛马中（演示）"}], "risk": "只做真实照片精修，不生成不存在的设施"},
    "v-ppt": {"deps": ["Gamma 会员", "WPS AI（备用）", "人工校对"], "stats": {"orders": 9, "ok": 94, "avg_min": 90, "to_peer": 0}, "owner": "陈小满", "log": [{"v": "v0.2", "date": "2026-11-07", "note": "基础 / 标准 / 高级三档（演示）"}], "risk": "—"},
    "v-xhs": {"deps": ["AI 文案", "人工润色"], "stats": {"orders": 12, "ok": 92, "avg_min": 40, "to_peer": 0}, "owner": "陈小满", "log": [{"v": "v0.2", "date": "2026-11-07", "note": "图文种草（演示）"}], "risk": "—"},
    "v-vid": {"deps": ["剪映 AI", "人工校对"], "stats": {"orders": 33, "ok": 97, "avg_min": 30, "to_peer": 0}, "owner": "陈小满", "log": [{"v": "v0.4", "date": "2026-11-06", "note": "15–30 秒商品展示（演示）"}], "risk": "素材横竖屏要一致"},
}


def _skill_entries():
    out = []
    for p in DB.values():
        if p.get("kind") != "svc":
            continue
        leaf = p.get("leaf_id") or SKILL_LEAF.get(p["path"][2] if len(p["path"]) > 2 else "")
        l1 = "C1" if "C1" in p["path"][1] else "C2"
        meta = SKILL_META.get(p["id"], {"deps": [], "stats": {"orders": p.get("week_sales", 0), "ok": None, "avg_min": None, "to_peer": 0}, "owner": p.get("owner", ""), "log": [], "risk": "—"})
        e = {"id": "SK-" + p["code"].replace("VC-", ""), "name": p["name"], "product_id": p["id"], "cover": p.get("cover", "svc"), "l1": l1, "leaf": leaf, "path": p["path"], "kind": "remote" if p.get("learn") else "workflow",
             "owner": meta["owner"], "deps": meta["deps"], "stats": meta["stats"], "log": meta["log"], "risk": meta["risk"], "case": None, "exec": meta.get("exec") or ("Computer Use（AI 看屏幕临场判断）；还没有固化成 RPA 的步骤" if p.get("learn") else "AI 工作流 + 人工校对；稳定后可把固定环节写成流程")}
        L = p.get("learn")
        if L:
            gaps = [k for k in ("terminal", "downloads") if L["capture"][k]["state"] != "ok"]
            nodes = _learn_nodes(L)
            cur = next((n for n in nodes if n["state"] == "cur"), None)
            listed = L["library"]["state"] == "listed"
            e.update(version=L["library"]["version"] or "", status="listed" if listed else "learning",
                     status_label=("已入库 " + L["library"]["version"]) if listed else "学习中",
                     step=(f"第 {cur['n']}/{len(nodes)} 步 · {cur['title']}" if cur else "已完成"),
                     outputs={k: v["state"] for k, v in L["outputs"].items()}, evidence={"ok": 5 - len([1 for c in L["capture"].values() if c["state"] != "ok"]), "total": 5, "gaps": gaps},
                     repro=L["repro"]["state"], runner=L["runner"]["name"] if L.get("runner") else "", remote=L["runner"]["remote"] if L.get("runner") else "", case=L["case"]["goal"])
        else:
            e.update(version="v0.x（赛马中）", status="racing", status_label="赛马中", step="AI 工作流 vs 手工，选最稳的", outputs=None, evidence=None, repro="none",
                     runner="AI 工作流 + 人工校对", remote="—", case=p["notes"].get("script", ""))
        out.append(e)
    return out


@router.get("/skills", summary="服务 Skill 台账：分类树 + 每项服务能力一行（演示）")
def skills(_=Depends(get_current_user)):
    items = _skill_entries()
    tree = copy.deepcopy(SKILL_TREE)
    for g in tree:
        g["count"] = 0
        for lf in g["leaves"]:
            lf["count"] = len([i for i in items if i["leaf"] == lf["id"]])
            lf["listed"] = len([i for i in items if i["leaf"] == lf["id"] and i["status"] == "listed"])
            g["count"] += lf["count"]
    return {"tree": tree, "items": items}



@router.post("/skills", summary="服务立项：在某个服务类型下新建一项服务能力，从「学习到交付」第 1 步开始")
def new_skill(body: dict | None = None, u=Depends(get_current_user)):
    b = body or {}
    leaf = next((lf for g in SKILL_TREE for lf in g["leaves"] if lf["id"] == b.get("leaf")), None)
    grp = next((g for g in SKILL_TREE if any(lf["id"] == b.get("leaf") for lf in g["leaves"])), None)
    if not leaf or grp["kind"] != "remote":
        raise HTTPException(400, "先选一个服务类型。（远程操作类才走学习到交付；AI 工作流类走赛马。）")
    name = (b.get("name") or "").strip()
    if len(name) < 6:
        raise HTTPException(400, "服务名称要写具体：例如「处理《三角洲行动》启动时的虚拟化报警」，不要写「维修」。")
    n = len([x for x in DB if x.startswith("v-new")]) + 1
    pid = f"v-new{n}"
    DB[pid] = P(id=pid, code=f"VC-C1-{100 + n:04d}", name=name, brand="自营服务", face="远程 · 1 台", kind="svc", cover="svc",
                path=["C 服务类", grp["name"], leaf["name"], name], delivery="manual", cost=0, price=0, week_sales=0, refund_rate=0.0, valid="服务后 7 天内保修", region="全国 · 远程",
                step=5, listing_type="route", orders=[], capacity={"week_limit": 20, "booked": 0, "queue": []},
                sourcing={"main": "同行远程操作学习 → 教程 + Skill → Agent 交付", "backup": "转同行交付", "cost": 0, "qualify": "无", "quota": "待定"},
                notes={"script": "接单 → 客户授权设备 → 临时识别码 → 按 Skill 操作 → 画面验证。", "guide": "客户不告诉我们密码、验证码。", "refund": "没解决可退。", "stop": "复现不通过 → 暂停接单。"},
                compliance={"level": "B", "lawyer": "unsubmitted", "note": ""}, evidence=["新立项（演示）"], source_tag="人工来源", review=[], decision="还没上架",
                learn=_learn_fresh({"goal": name, "scene": (b.get("scene") or "").strip(), "env": (b.get("env") or "").strip(), "price": (b.get("price") or "").strip()}))
    DB[pid]["leaf_id"] = leaf["id"]
    return _view(DB[pid])



# ======================================================================================
# 虚拟商品新增全流程 + 同行工具软件调研对标（阿奇索91卡券 / 闲管家 / 鱼店长 / 福禄橙券 / 发卡网）
# 核心规则：
#   1. 一步一个大页面：分类与同行摸底 → 取得路径与算账底线 → 卡密洗重与阿奇索防骗直发
#   2. 机器初审 + 员工核对直接落地（零层层主管审批）：
#      - 有同行在售证据 → 走「跟卖型 follow」，免第 5/6 步实测，人工确认即直接上架（step=8）
#      - 无同行在售证据 → 强制走「路测型 route」，建卡后落入第 5 步「小额实测」（严禁跳步直发）
# ======================================================================================

VALID_COVERS = {
    "starbucks", "mcd", "kfc", "pzh", "dmn", "dominos", "wls", "greentea",
    "jp", "xdq", "tz", "local_fuyang", "jdcard", "clean_jd", "clean_mt",
    "bus_tokyo", "chatgpt", "claude", "steam", "points", "svc", "cad",
    "bnb", "ppt", "vid", "xhs", "flash", "game",
}

COVER_OPTIONS = [
    {"id": "starbucks", "label": "星巴克 / 咖啡茶饮"},
    {"id": "mcd", "label": "麦当劳 / 连锁快餐"},
    {"id": "kfc", "label": "肯德基 / 炸鸡汉堡"},
    {"id": "jdcard", "label": "商超礼品卡 / 购物卡"},
    {"id": "chatgpt", "label": "AI 会员 / 数字订阅"},
    {"id": "claude", "label": "大模型 / 效率软件"},
    {"id": "steam", "label": "游戏点卡 / CDK / 影音"},
    {"id": "ppt", "label": "网盘资料包 / 模板素材"},
    {"id": "xdq", "label": "景区门票 / 酒旅出行"},
    {"id": "local_fuyang", "label": "地方商场活动券"},
    {"id": "points", "label": "积分兑换 / 自助预约码"},
    {"id": "svc", "label": "在线人工交付服务"},
]

VIRT_CATEGORIES = [
    {
        "big": "A 码券类",
        "kind": "virt",
        "desc": "电子兑换码、二维码、团购券、礼品卡（卖一张少一张，默认底线 105%）",
        "subs": [
            {"code": "A1", "name": "A1 餐饮券", "leaf_hint": "连锁快餐饮品 / 正餐自助", "delivery": "card", "floor_pct": 105, "cover": "starbucks"},
            {"code": "A2", "name": "A2 礼品卡/购物卡", "leaf_hint": "商超卡 / 电商卡 / 加油卡", "delivery": "card", "floor_pct": 103, "cover": "jdcard"},
            {"code": "A3", "name": "A3 生活服务券", "leaf_hint": "家政保洁 / 洗车 / 洗衣", "delivery": "card", "floor_pct": 108, "cover": "clean_jd"},
            {"code": "A4", "name": "A4 出行票", "leaf_hint": "地铁巴士 / 接送机 / 贵宾厅", "delivery": "card", "floor_pct": 108, "cover": "bus_tokyo"},
            {"code": "A5", "name": "A5 门票", "leaf_hint": "景区 / 乐园 / 展览电影", "delivery": "card", "floor_pct": 108, "cover": "xdq"},
            {"code": "A7", "name": "A7 话费电费充值", "leaf_hint": "三网话费 / 电费慢充快充", "delivery": "topup", "floor_pct": 104, "cover": "jdcard"},
            {"code": "A8", "name": "A8 地方活动券", "leaf_hint": "本地综合体 / 银行地方立减券", "delivery": "card", "floor_pct": 115, "cover": "local_fuyang"},
        ],
    },
    {
        "big": "B 数字权益类",
        "kind": "virt",
        "desc": "会员直充、激活码 CDK、网盘课程素材（标准数字交付，默认底线 115%~130%）",
        "subs": [
            {"code": "B1", "name": "B1 AI 会员", "leaf_hint": "ChatGPT / Claude / 绘图会员", "delivery": "topup", "floor_pct": 115, "cover": "chatgpt"},
            {"code": "B2", "name": "B2 影音/网盘会员", "leaf_hint": "B站 / 爱优腾 / 百度夸克网盘", "delivery": "topup", "floor_pct": 110, "cover": "steam"},
            {"code": "B3", "name": "B3 软件授权/素材库", "leaf_hint": "正版激活码 / 设计素材网盘包", "delivery": "nocard", "floor_pct": 130, "cover": "ppt"},
            {"code": "B4", "name": "B4 游戏点卡/CDK", "leaf_hint": "Steam 充值码 / 主机点卡 / 礼包码", "delivery": "card", "floor_pct": 108, "cover": "steam"},
        ],
    },
    {
        "big": "C 服务类",
        "kind": "svc",
        "desc": "把代订、积分兑换或 AI 服务包装成标准化卡券/预约码出售（毛利高，默认底线 130%）",
        "subs": [
            {"code": "C2", "name": "C2 AI 操作服务", "leaf_hint": "AI 精修 / 代画 / PPT / 视频", "delivery": "manual", "floor_pct": 130, "cover": "cad"},
            {"code": "C3", "name": "C3 积分代订/自助预约", "leaf_hint": "积分换酒店机票 / 自助预约码", "delivery": "selfserve", "floor_pct": 130, "cover": "points"},
        ],
    },
]

VIRT_SHOPS = [
    {"id": "xy_xm", "platform": "闲鱼", "label": "闲鱼 · 小满卡券严选", "mode": "闲管家+阿奇索联动"},
    {"id": "xy_zz", "platform": "闲鱼", "label": "闲鱼 · 周周生活特惠", "mode": "闲管家+阿奇索联动"},
    {"id": "xy_fy", "platform": "闲鱼", "label": "闲鱼 · 泛亚数字权益号", "mode": "闲管家+阿奇索联动"},
    {"id": "tb_zy", "platform": "淘宝", "label": "淘宝 · 泛亚自动发卡店", "mode": "阿奇索千牛直连"},
]

PEER_TOOLS = [
    {
        "id": "agiso",
        "name": "阿奇索 (Agiso) + 91卡券仓库",
        "badge": "自动发卡与防骗标杆",
        "platforms": ["闲鱼", "淘宝/天猫", "拼多多", "抖店", "快手"],
        "strengths": [
            "「91卡券」独立卡种池：区分唯一卡密（一人一码卖完即扣）与固定内容（网盘链接循环发），批量粘码自动洗重",
            "付款秒发 + 自动改发货状态（闲鱼自动点「无需寄件」并聊天窗推卡密+使用教程）",
            "三大防白嫖闸门：历史退款≥N次拦截转人工、黑名单拦截、上一笔未确认收货禁发新码（防连拍套卡）",
            "智能售后分流：未发码退款秒同意保店铺评分；已发码退款一律转人工核查核销状态",
        ],
        "blindspots": "只管「发卡与拦截」，完全没有选品同行比价、C01 取得路径合规留痕、毛利底线防倒挂与业务员提成分账。",
        "our_absorption": "第 3 步完整内建 91卡券式粘贴洗重预览、低库存预警/售罄停发，并默认开启三大防骗闸门与智能退单分流。",
    },
    {
        "id": "xianguanjia",
        "name": "闲管家（闲鱼官方生态 ERP）",
        "badge": "多号矩阵铺货与重发",
        "platforms": ["闲鱼（单主体最高绑 30 个闲鱼号）"],
        "strengths": [
            "一套商品资料一键同步铺货到多个闲鱼号，支持按地区/门店差异化挂牌",
            "「售出自动补库存重新上架」：解决闲鱼单品成交即下架痛点，保持链接权重不断流",
            "30 号聚合聊天客服台 + 售前关键词自动秒回 + 每日定时自动擦亮",
        ],
        "blindspots": "偏重群控铺货与聊天接待，缺乏批次进价台账、无同行产品强制路测闸门及算账底线。",
        "our_absorption": "第 3 步加入多号矩阵勾选上架 + 「售出自动补库存重发」与「每日自动擦亮」标准开关。",
    },
    {
        "id": "yudianzhang",
        "name": "鱼店长",
        "badge": "同行爆款采集跟卖",
        "platforms": ["闲鱼（深度打通阿奇索）"],
        "strengths": [
            "快速抓取同行在售爆款标题、价格区间与想要数，辅助跟卖选品",
            "建品同时直接绑定阿奇索发卡规则，跟卖铺品效率高",
        ],
        "blindspots": "员工容易盲目跟卖无货源或亏本引流链接，缺乏利润锚点校验。",
        "our_absorption": "第 1 步内建同行挂牌与三榜信号录入，机器据此自动分流「跟卖直发（免5/6步）」与「无同行强制路测」。",
    },
    {
        "id": "fulu_chengquan",
        "name": "福禄开放平台 / 橙券供应链",
        "badge": "零库存 API 直充货源",
        "platforms": ["全平台 API 直充 / 批采拿卡"],
        "strengths": [
            "覆盖影音会员、餐饮茶饮、商超卡、三网话费等标准化权益，来一单调 API 充一单，0 库存积压",
            "上游进价波动或通道维护实时回调，防止售价低于拿货价倒挂亏损",
        ],
        "blindspots": "标准品毛利较薄（3%~8%），且不覆盖地方商场活动券（A8）、积分代订与自研 AI 服务。",
        "our_absorption": "第 2/3 步支持「直充/代充」模式（免囤卡密）、上游涨价自动熔断阈值，以及「严禁索要买家密码/验证码」硬约束。",
    },
    {
        "id": "liandong_dujiao",
        "name": "链动小铺 / 独角数卡",
        "badge": "极简建卡与自助提卡 UX",
        "platforms": ["独立 H5 发卡页 / 私域自助核销"],
        "strengths": [
            "业界最清爽的分步建品体验：分类 → 算账定价 → 粘卡洗重 → 一键开售，新手 2 分钟上手",
            "买家凭提取码/预约码进 H5 自助兑换或选时段，省去人工客服反复沟通",
        ],
        "blindspots": "站外链接不能直接在闲鱼公域裸发（易判站外引流违规）。",
        "our_absorption": "吸收其极简 3 步大页面建卡交互，并将自助提卡理念用于内部「程序自助预约码（selfserve）」交付形态。",
    },
]

VIRT_TEMPLATES = [
    {
        "id": "tpl_sbux_card",
        "label": "☕ 星巴克通兑券（跟卖直发 · 唯一卡密洗重）",
        "tag": "跟卖型 · 直发",
        "payload": {
            "cat_big": "A 码券类",
            "cat_sub": "A1 餐饮券",
            "cat_leaf": "连锁咖啡茶饮",
            "brand": "星巴克",
            "name": "星巴克 大杯手工调制饮品通兑电子券（全国门店秒发）",
            "face": "大杯 38 元档通兑 · 全国直营可用",
            "region": "全国（机场高铁迪士尼店除外）",
            "valid": "出码后 30 天内有效",
            "cover": "starbucks",
            "compliance_level": "A",
            "compliance_note": "标准连锁餐饮电子饮品券，支持正常转赠核销。",
            "peers": [
                {"platform": "闲鱼", "shop": "同行挂牌 · 卡券小铺99", "price": 26.9, "sales": 420, "url": "https://2.taobao.com/item-sbux-01"},
                {"platform": "闲鱼", "shop": "同行挂牌 · 咖啡自由官", "price": 27.5, "sales": 185, "url": "https://2.taobao.com/item-sbux-02"},
            ],
            "xianyu_signal": {"sales": 38, "price_lo": 24.5, "price_hi": 29.9, "sellers": 38, "median": 26.9},
            "profit_anchor": "批量折扣 / 券商拿货价差",
            "sourcing_main": "91卡券认证一级餐饮券商批采（招行/建行联名券包拆单）",
            "sourcing_backup": "橙券 API 实时直采通道（单张 ¥23.2 兜底）",
            "sourcing_qualify": "无买家身份限制，到店出示二维码或星巴克 App 绑定核销",
            "sourcing_quota": "每周稳定供货 300 张",
            "cost": 22.5,
            "price": 26.5,
            "floor_pct": 105,
            "platform_fee_rate": 0.016,
            "after_sale_reserve": 0.6,
            "delivery": "card",
            "supplier": "认证餐饮券商 · 华东仓",
            "expire": D(-45),
            "warn_at": 10,
            "raw_cards": "\n".join([
                "SBUX-2026-8841-9920----7361",
                "SBUX-2026-8841-9921----1048",
                "SBUX-2026-8841-9922----5582",
                "SBUX-2026-8841-9920----7361",
                "",
                "SBUX-2026-8841-9923----6619",
                "SBUX-2026-8841-9924----3905",
                "SBUX-2026-8841-9922----5582",
                "SBUX-2026-8841-9925----8174",
                "SBUX-2026-8841-9926----4420",
                "SBUX-2026-8841-9927----2913",
            ]),
            "shops": ["xy_xm", "xy_zz"],
            "auto_relist": True,
            "auto_polish": True,
            "auto_delivery": True,
            "auto_refund": True,
            "refund_limit": 2,
            "blacklist": True,
            "prev_unconfirmed": True,
            "max_per_buyer": 3,
            "script": "【24h自动秒发】您的星巴克大杯通兑券码已发出，到店直接出示二维码或打开星巴克App兑换即可。",
            "guide": "打开星巴克 App → 我的 → 好礼星星/礼券 → 输入券码与密码绑定，支持到店柜台或啡快点单使用。",
            "refund_rule": "未发码秒退；电子卡密一经发出不支持七天无理由退换。",
            "stop_rule": "库存归零自动停售；若连续 2 单反馈券码异常立即熔断下架并核查批次。",
        },
    },
    {
        "id": "tpl_netdisk_nocard",
        "label": "📦 AI设计素材网盘包（跟卖直发 · 无卡密循环发）",
        "tag": "跟卖型 · 固定内容",
        "payload": {
            "cat_big": "B 数字权益类",
            "cat_sub": "B3 软件授权/素材库",
            "cat_leaf": "AI 提示词与设计模板",
            "brand": "自营整理",
            "name": "2026 电商商品精修 AI 工作流与 500 套高转化主图 PSD 合集",
            "face": "夸克/百度双网盘永久更新版",
            "region": "全国 · 在线网盘秒发",
            "valid": "长期有效（包链接补链）",
            "cover": "ppt",
            "compliance_level": "A",
            "compliance_note": "自研整理与开源商用授权模板合集，已排查无侵权字体图片。",
            "peers": [
                {"platform": "闲鱼", "shop": "同行挂牌 · 设计素材库Pro", "price": 19.9, "sales": 610, "url": "https://2.taobao.com/item-psd-01"},
            ],
            "xianyu_signal": {"sales": 22, "price_lo": 9.9, "price_hi": 29.9, "sellers": 22, "median": 19.9},
            "profit_anchor": "服务效率 / AI 工具替代差",
            "sourcing_main": "公司内部视觉团队沉淀自研素材包（边际交付成本 ¥0.5）",
            "sourcing_backup": "百度网盘 + 夸克网盘双备份防和谐",
            "sourcing_qualify": "无限制，拍下自动发双网盘链接与提取码",
            "sourcing_quota": "无限量循环秒发",
            "cost": 1.0,
            "price": 18.8,
            "floor_pct": 130,
            "platform_fee_rate": 0.016,
            "after_sale_reserve": 0.5,
            "delivery": "nocard",
            "fixed_payload": "夸克网盘：https://pan.quark.cn/s/demo2026ai 提取码：8866 ｜ 备用百度盘：https://pan.baidu.com/s/1demoAi 提取码：paya",
            "shops": ["xy_xm", "xy_fy", "tb_zy"],
            "auto_relist": True,
            "auto_polish": True,
            "auto_delivery": True,
            "auto_refund": True,
            "refund_limit": 2,
            "blacklist": True,
            "prev_unconfirmed": True,
            "max_per_buyer": 1,
            "script": "【自动秒发】感谢拍下！上方双网盘链接含完整工作流与 500 套 PSD，建议先转存到自己网盘再下载。",
            "guide": "手机/电脑打开网盘链接输入提取码即可一键转存；如遇链接失效留言秒补。",
            "refund_rule": "网盘链接发出前可秒退；发出后因可复制性质不支持退款。",
            "stop_rule": "网盘链接巡检报失效时自动暂停发卡并提醒运营换链。",
        },
    },
    {
        "id": "tpl_bili_topup",
        "label": "📺 B站大会员年卡直充（跟卖直发 · 福禄/橙券代充）",
        "tag": "跟卖型 · 直充代充",
        "payload": {
            "cat_big": "B 数字权益类",
            "cat_sub": "B2 影音/网盘会员",
            "cat_leaf": "哔哩哔哩",
            "brand": "哔哩哔哩",
            "name": "哔哩哔哩 B站大会员年卡 12 个月官方手机号直充",
            "face": "大会员 12 个月（手机/平板/电脑通用）",
            "region": "全国 · 官方直充秒到",
            "valid": "到账后即时生效 365 天",
            "cover": "steam",
            "compliance_level": "A",
            "compliance_note": "正规上游数字权益 API 手机号直充，非共享号。",
            "peers": [
                {"platform": "闲鱼", "shop": "同行挂牌 · 权益直充中心", "price": 98.0, "sales": 890, "url": "https://2.taobao.com/item-bili-01"},
                {"platform": "淘宝", "shop": "某猫数字生活专营", "price": 108.0, "sales": 2000, "url": "https://item.taobao.com/bili-02"},
            ],
            "xianyu_signal": {"sales": 54, "price_lo": 92.0, "price_hi": 109.0, "sellers": 54, "median": 98.0},
            "profit_anchor": "批量折扣 / 券商拿货价差",
            "sourcing_main": "福禄开放平台官方直充 API（来一单充一单，0 库存）",
            "sourcing_backup": "橙券企业采购后台手动补单",
            "sourcing_qualify": "买家仅需提供 B站绑定手机号或 UID，严禁索要密码与验证码",
            "sourcing_quota": "API 授信池内不限量",
            "cost": 86.0,
            "price": 96.9,
            "floor_pct": 110,
            "platform_fee_rate": 0.016,
            "after_sale_reserve": 1.0,
            "delivery": "topup",
            "upstream": "福禄开放平台 API（备用：橙券直充）",
            "buyer_prompt": "请直接在备注或聊天窗发送【B站注册手机号或数字UID】，无需密码和短信验证码！填错账号无法撤回。",
            "price_hike_stop_pct": 4,
            "shops": ["xy_xm", "tb_zy"],
            "auto_relist": True,
            "auto_polish": True,
            "auto_delivery": True,
            "auto_refund": True,
            "refund_limit": 2,
            "blacklist": True,
            "prev_unconfirmed": True,
            "max_per_buyer": 2,
            "script": "核对您的充值手机号无误后 1~3 分钟官方直充到账，到账后自动回传充值流水单号。",
            "guide": "打开哔哩哔哩 App → 我的 → 大会员中心，即可查看到期时间顺延 12 个月。",
            "refund_rule": "未提交上游充值前可秒退；直充成功到账后不支持退换；上游充值失败全额自动退。",
            "stop_rule": "上游拿货价上涨超过 4%（> ¥89.4）或接口超时率 > 5% 自动熔断停售。",
        },
    },
    {
        "id": "tpl_fuyang_route",
        "label": "🎟 富阳商场 50 代 100 餐饮券（无同行 · 强制路测通道）",
        "tag": "路测型 · 锁第5步实测",
        "payload": {
            "cat_big": "A 码券类",
            "cat_sub": "A8 地方活动券",
            "cat_leaf": "杭州富阳",
            "brand": "富阳东方茂商场",
            "name": "杭州富阳东方茂 50 代 100 周末正餐通用代金券",
            "face": "100 元代金券（满 100 可用，可叠加 2 张）",
            "region": "浙江 · 杭州富阳",
            "valid": "活动期内周末可用（至下月底）",
            "cover": "local_fuyang",
            "compliance_level": "C",
            "compliance_note": "地方商场联合银联抢券活动，需实测非本人手机号能否到店扫码核销，并同步交律师审转让条款。",
            "peers": [],
            "xianyu_signal": {"sales": 0, "price_lo": 0, "price_hi": 0, "sellers": 0, "median": 0},
            "profit_anchor": "银行 / 平台活动补贴差",
            "sourcing_main": "本地银联云闪付周五 10 点抢券（实付 ¥50 抢 100 元券）",
            "sourcing_backup": "商场会员积分 5000 分加 ¥48 兑换",
            "sourcing_qualify": "需实测动态码截图或静态券码异地给买家能否顺畅核销（待第 5 步实测验证）",
            "sourcing_quota": "单号每周限抢 2 张，15 个员工协作号每周约 30 张",
            "cost": 50.0,
            "price": 72.0,
            "floor_pct": 115,
            "platform_fee_rate": 0.016,
            "after_sale_reserve": 2.0,
            "delivery": "card",
            "supplier": "银联周五地方抢券池（待实测后入库）",
            "expire": D(-30),
            "warn_at": 5,
            "raw_cards": "",
            "shops": ["xy_fy"],
            "auto_relist": True,
            "auto_polish": False,
            "auto_delivery": False,
            "auto_refund": True,
            "refund_limit": 2,
            "blacklist": True,
            "prev_unconfirmed": True,
            "max_per_buyer": 2,
            "script": "发券前请确认门店当日可用餐位；到店结账前联系客服获取最新核销码。",
            "guide": "东方茂 3-5F 参与活动的 18 家正餐门店收银台扫码核销（酒水锅底除外）。",
            "refund_rule": "未核销随时可退；活动结束未用支持过期退。",
            "stop_rule": "若第 5 步实测发现收银台强制校验云闪付实时动态码（截图不可用），立即终止立项下马。",
        },
    },
]


def _mask_card(c: str) -> str:
    s = c.strip()
    if len(s) <= 8:
        return s[:2] + "****" + s[-2:] if len(s) > 4 else "****"
    return s[:6] + " ···· " + s[-4:]


def _parse_card_lines(raw_text: str, existing_vault: list[str] | None = None) -> dict:
    if not raw_text or not raw_text.strip():
        return {
            "raw_lines": 0,
            "empty_removed": 0,
            "duplicates_removed": 0,
            "net_imported": 0,
            "unique_cards": [],
            "preview_masked": [],
            "duplicate_samples": [],
        }
    lines = raw_text.splitlines()
    seen = {re.sub(r"\s+", " ", x.strip()) for x in (existing_vault or []) if x.strip()}
    empty_removed = 0
    duplicates_removed = 0
    unique_cards: list[str] = []
    dup_samples: list[str] = []
    for ln in lines:
        s = ln.strip()
        if not s or s.startswith("#"):
            empty_removed += 1
            continue
        norm_key = re.sub(r"\s+", " ", s)
        if norm_key in seen:
            duplicates_removed += 1
            if len(dup_samples) < 5:
                dup_samples.append(_mask_card(s))
            continue
        seen.add(norm_key)
        unique_cards.append(s)
    return {
        "raw_lines": len(lines),
        "empty_removed": empty_removed,
        "duplicates_removed": duplicates_removed,
        "net_imported": len(unique_cards),
        "unique_cards": unique_cards,
        "preview_masked": [_mask_card(x) for x in unique_cards[:8]],
        "duplicate_samples": dup_samples,
    }


@router.get("/peer-tools", summary="同行虚拟商品工具软件调研对标矩阵 + 新增虚拟品分类字典与一键演示模板")
def get_peer_tools(_=Depends(get_current_user)):
    return {
        "tools": PEER_TOOLS,
        "categories": VIRT_CATEGORIES,
        "covers": COVER_OPTIONS,
        "shops": VIRT_SHOPS,
        "templates": VIRT_TEMPLATES,
    }


@router.post("/parse-cards", summary="阿奇索 91卡券式卡密粘贴预清洗（自动剔除空行与重复卡密）")
def parse_cards_api(body: dict | None = None, _=Depends(get_current_user)):
    b = body or {}
    res = _parse_card_lines(str(b.get("raw_cards") or ""))
    # 接口只回统计与脱敏预览，不回传明文全量列表以贴合安全规范
    return {k: v for k, v in res.items() if k != "unique_cards"}


@router.post("/products", summary="新增虚拟商品卡：机器初审（同行通道判定 + 底线倍数校验 + 卡密洗重）+ 员工核对直接上架/进路测")
def create_virtual_product(body: dict | None = None, u=Depends(get_current_user)):
    b = body or {}
    name = str(b.get("name") or "").strip()
    if len(name) < 4:
        raise HTTPException(400, "商品名称至少 4 个字，请写清品牌、面值或核心权益")
    cat_big = str(b.get("cat_big") or "A 码券类").strip()
    cat_sub = str(b.get("cat_sub") or "A1 餐饮券").strip()
    cat_leaf = str(b.get("cat_leaf") or "").strip()
    brand = str(b.get("brand") or "").strip() or "通用品牌"
    face = str(b.get("face") or "").strip() or "标准规格"
    delivery = str(b.get("delivery") or "card").strip()
    if delivery not in DELIVERY:
        raise HTTPException(400, f"不支持的交付形态：{delivery}")

    sourcing_main = str(b.get("sourcing_main") or (b.get("sourcing") or {}).get("main") or "").strip()
    if len(sourcing_main) < 2 or sourcing_main in ("0", "0.0"):
        raise HTTPException(400, "C01 优惠取得路径（主路径）必须如实填写，说不清利润来源不能建卡")
    profit_anchor = str(b.get("profit_anchor") or "批量折扣 / 券商拿货价差").strip()

    # 1. 清洗同行在售证据 → 机器自动判定「跟卖型 follow」vs「路测型 route」
    raw_peers = b.get("peers") or []
    valid_peers = []
    for xp in raw_peers:
        if not isinstance(xp, dict):
            continue
        shop = str(xp.get("shop") or "").strip()
        pr = float(xp.get("price") or 0)
        if shop and pr > 0:
            valid_peers.append({
                "platform": str(xp.get("platform") or "闲鱼").strip(),
                "shop": shop,
                "price": round(pr, 2),
                "sales": int(xp.get("sales") or 0),
                "url": str(xp.get("url") or "").strip(),
            })

    has_peers = len(valid_peers) > 0
    direct_publish = bool(b.get("direct_publish", True))
    if has_peers:
        listing_type = "follow"
        step = 8 if direct_publish else 7
        decision = "继续" if step == 8 else "待上架"
    else:
        # 硬闸门：无有效同行在售证据，严禁跳过实测直接上架，强制锁定路测第 5 步！
        listing_type = "route"
        step = 5
        decision = "实测验证中"

    # 2. 算账与底线防倒挂硬校验
    cost = round(float(b.get("cost") or 0), 2)
    price = round(float(b.get("price") or 0), 2)
    if price <= 0:
        raise HTTPException(400, "拟定售价必须大于 0")
    if cost < 0:
        raise HTTPException(400, "进价不能为负数")
    default_floor = 105 if delivery == "card" else 130
    floor_pct = round(float(b.get("floor_pct") or default_floor), 2)
    fee_rate = round(float(b.get("platform_fee_rate") if b.get("platform_fee_rate") is not None else 0.016), 4)
    reserve = round(float(b.get("after_sale_reserve") if b.get("after_sale_reserve") is not None else 1.0), 2)
    floor_price = round(cost * floor_pct / 100, 2) if cost > 0 else 0
    override_reason = str(b.get("override_reason") or "").strip()
    if floor_price > 0 and price < floor_price and len(override_reason) < 3:
        raise HTTPException(
            400,
            f"售价 ¥{price} 低于机器底线 ¥{floor_price}（进价 ¥{cost} × {floor_pct}%），请调高售价或填写≥3字的破底线说明",
        )

    # 3. 交付形态、卡密洗重入库与产能初始化
    stock = None
    capacity = None
    extra_delivery_meta: dict = {}
    dedup_summary = None

    if delivery == "card":
        parsed = _parse_card_lines(str(b.get("raw_cards") or ""))
        dedup_summary = {k: parsed[k] for k in ("raw_lines", "empty_removed", "duplicates_removed", "net_imported", "duplicate_samples")}
        avail = parsed["net_imported"]
        if step == 8 and avail <= 0:
            raise HTTPException(400, "唯一卡密商品直接上架前，请粘贴至少 1 张有效卡密（机器会自动洗重入库），或取消直发先存第 7 步")
        warn_at = max(1, int(b.get("warn_at") or 10))
        supplier = str(b.get("supplier") or "首批建卡导码").strip() or "首批建卡导码"
        exp_str = str(b.get("expire") or D(-60)).strip() or D(-60)
        batches = [batch(1, supplier, cost, avail, avail, exp_str, 0)] if avail > 0 else []
        stock = {
            "avail": avail,
            "locked": 0,
            "sold": 0,
            "void": 0,
            "warn_at": warn_at,
            "stop_at": 0,
            "batches": batches,
            "vault": parsed["unique_cards"],
            "last_dedup": dedup_summary,
        }
    elif delivery == "nocard":
        fixed_payload = str(b.get("fixed_payload") or "").strip()
        if step == 8 and len(fixed_payload) < 6:
            raise HTTPException(400, "无卡密固定内容商品直接上架前，请填写要自动发送的网盘链接/提取码或固定口令")
        extra_delivery_meta["fixed_payload"] = fixed_payload
    elif delivery == "topup":
        upstream = str(b.get("upstream") or sourcing_main).strip()
        buyer_prompt = str(b.get("buyer_prompt") or "请提供充值账号/手机号，严禁发送登录密码与验证码").strip()
        hike_pct = float(b.get("price_hike_stop_pct") or 5)
        extra_delivery_meta["topup_cfg"] = {
            "upstream": upstream,
            "buyer_prompt": buyer_prompt,
            "price_hike_stop_pct": hike_pct,
        }
    elif delivery == "selfserve":
        extra_delivery_meta["selfserve_cfg"] = {
            "portal_note": str(b.get("portal_note") or "买家付款自动发预约码，凭码进 H5 自助填写核销信息").strip(),
        }
    elif delivery == "manual":
        wk_limit = max(1, int(b.get("week_limit") or 30))
        capacity = {"week_limit": wk_limit, "booked": 0, "queue": []}

    # 4. 封面图兜底（确保 100% 命中已有真实图片，绝不断图）
    cover = str(b.get("cover") or "").strip()
    if cover not in VALID_COVERS:
        cover = {"card": "starbucks", "nocard": "ppt", "topup": "chatgpt", "selfserve": "points", "manual": "svc"}.get(delivery, "starbucks")

    kind = "svc" if cat_big.startswith("C") and delivery == "manual" else "virt"
    sub_code = cat_sub.split()[0] if cat_sub else "A1"
    seq = len(DB) + 101
    pid = f"v-custom-{seq}"
    while pid in DB:
        seq += 1
        pid = f"v-custom-{seq}"
    code = f"VC-{sub_code}-{seq:04d}"

    path = [cat_big, cat_sub]
    if cat_leaf:
        path.append(cat_leaf)
    path.append(brand if brand not in path else name[:10])

    # 5. 多店铺分发与平台汇总
    chosen_shop_ids = b.get("shops") or ["xy_xm"]
    shop_objs = [s for s in VIRT_SHOPS if s["id"] in chosen_shop_ids] or [VIRT_SHOPS[0]]
    platforms = list(dict.fromkeys([s["platform"] for s in shop_objs]))

    # 6. 三榜信号组装
    xy_sig_in = b.get("xianyu_signal") or {}
    if has_peers:
        prices = [x["price"] for x in valid_peers]
        lo = round(float(xy_sig_in.get("price_lo") or min(prices)), 2)
        hi = round(float(xy_sig_in.get("price_hi") or max(prices)), 2)
        med = round(float(xy_sig_in.get("median") or sorted(prices)[len(prices) // 2]), 2)
        cnt_s = int(xy_sig_in.get("sales") or len(valid_peers))
        xy_sig = peer(cnt_s, lo, hi, med, f"建卡摸底录入 {len(valid_peers)} 条同行挂牌，中位价 ¥{med}")
    else:
        xy_sig = {"sales": 0, "price_lo": 0, "price_hi": 0, "sellers": 0, "rank": 0, "date": D(0), "note": "无同行在售挂牌 → 系统强制锁定 8 步路测通道"}

    who_name = getattr(u, "name", None) or getattr(u, "username", "陈小满")
    now_str = datetime.now().strftime("%m-%d %H:%M")
    unit_profit = round(price - cost - round(price * fee_rate, 2) - reserve, 2)

    ev_log = [
        {"step": 1, "who": who_name, "t": now_str, "data": {"分类挂点": " › ".join(path), "通道初审": "跟卖型（有同行免实测）" if has_peers else "路测型（无同行锁实测）"}},
        {"step": 3, "who": who_name, "t": now_str, "data": {"利润锚点": profit_anchor, "主路径": sourcing_main, "进价": f"¥{cost}"}},
        {"step": 4, "who": who_name, "t": now_str, "data": {"单笔净贡献": f"¥{price} - ¥{cost} - 平台费 - 预留 = ¥{unit_profit}" + (f"（特批：{override_reason}）" if override_reason else "")}},
    ]
    if step == 8:
        ev_log.append({
            "step": 7,
            "who": who_name,
            "t": now_str,
            "data": {
                "人工复核直发": f"已绑定 {', '.join(s['label'] for s in shop_objs)} 直接上架（无主管审批卡点）",
                "交付与风控": f"{DELIVERY[delivery]} · 自动发货={'开' if b.get('auto_delivery', True) else '关'}" + (f" · 洗重净入库 {stock['avail']} 张" if stock else ""),
            },
        })

    new_prod = P(
        id=pid,
        code=code,
        name=name,
        brand=brand,
        face=face,
        kind=kind,
        cover=cover,
        path=path,
        platforms=platforms,
        region=str(b.get("region") or "全国").strip(),
        valid=str(b.get("valid") or "购买后 30 天内有效").strip(),
        owner=who_name,
        listing_type=listing_type,
        step=step,
        delivery=delivery,
        cost=cost,
        price=price,
        floor_pct=floor_pct,
        platform_fee_rate=fee_rate,
        after_sale_reserve=reserve,
        auto_delivery=bool(b.get("auto_delivery", step == 8)),
        auto_refund=bool(b.get("auto_refund", True)),
        checks={
            "refund_limit": max(1, int(b.get("refund_limit") or 2)),
            "blacklist": bool(b.get("blacklist", True)),
            "prev_unconfirmed": bool(b.get("prev_unconfirmed", True)),
            "max_per_buyer": max(1, int(b.get("max_per_buyer") or 2)),
        },
        stock=stock,
        capacity=capacity,
        peers=valid_peers,
        signals={"闲鱼": xy_sig, "淘宝": NOT_YET, "京东": NOT_YET},
        sourcing={
            "profit_anchor": profit_anchor,
            "main": sourcing_main,
            "backup": str(b.get("sourcing_backup") or "无").strip() or "无",
            "cost": cost,
            "qualify": str(b.get("sourcing_qualify") or "无特殊限制").strip(),
            "quota": str(b.get("sourcing_quota") or "按周补货").strip(),
        },
        notes={
            "script": str(b.get("script") or "付款后自动发送卡密/兑换指引。").strip(),
            "guide": str(b.get("guide") or "按页面说明兑换使用。").strip(),
            "refund": str(b.get("refund_rule") or "未发货秒退；已发货转人工核验。").strip(),
            "stop": str(b.get("stop_rule") or "库存归零或退款率 > 8% 自动暂停上架。").strip(),
        },
        compliance={
            "level": str(b.get("compliance_level") or "B").strip(),
            "lawyer": "unsubmitted",
            "note": str(b.get("compliance_note") or "新立项建卡，已排入律师常规合规抽检队列（不阻塞上架）。").strip(),
        },
        decision=decision,
        source_tag="新增虚拟品工作台 · 人工复核建卡",
        evidence=[f"{who_name} 于 {now_str} 通过新增虚拟品向导创建"],
        evidence_log=ev_log,
        shop_matrix={
            "shops": shop_objs,
            "auto_relist": bool(b.get("auto_relist", True)),
            "auto_polish": bool(b.get("auto_polish", True)),
        },
        **extra_delivery_meta,
    )

    # 插到字典最前面，Gallery 与选品列表第一眼即可看到新卡片
    reordered = {pid: new_prod, **DB}
    DB.clear()
    DB.update(reordered)
    _sync_commission()
    out = _view(DB[pid])
    if dedup_summary:
        out["dedup_summary"] = dedup_summary
    return out


@router.post("/reset", summary="演示：恢复初始数据")
def reset(_=Depends(get_current_user)):
    DB.clear()
    DB.update(copy.deepcopy(INIT))
    _sync_commission()
    return {"ok": True}
