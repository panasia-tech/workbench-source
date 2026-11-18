"""AdsPower 群控矩阵中心（全浏览器执行端架构 · 演示后端）。

架构对齐（2026-11 用户确认）：
1. 安卓真机已全面废弃，100% 切换为 AdsPower 指纹浏览器执行端（`adspower-executor / gc-ads`，`device.kind = browser`）：
   - 一窗一号一独享家宽代理 IP，Local API `127.0.0.1:50325`（1次/秒节流）+ Playwright CDP 接管闲鱼网页版 `goofish.com`
   - 看门狗 10s 崩溃自愈 + `identity.py` 读网页版登录昵称防发错号软闸 + `im_watch.py` 常驻 `/im` 秒级消息门铃
   - 密码与 2FA 种子（`fakey`）服务端加密托管注入 AdsPower Authenticator，员工免明文一键开窗 / 领 6 位动态码
2. 零主管层层审批卡点：
   - 洗图直接上架 → 自动进入 AdsPower 错峰排期队列（同号第 1 票立即下发，后续票按 25 分钟间隔错峰，超日限10票或排期偏密自动均衡引导空闲店铺）
   - 存量在售智能调价 → 系统算涨/降/观察/锁价建议，员工确认即下发执行（破成本底线或 ≥1万元高价品填 ≥3 字原因留痕即过，不设主管审批流）
3. 每日 15:30 自动抓取闲鱼小铺数据（留存原始网页截图，空数据记 null 绝不乱填 0）。
"""
from __future__ import annotations

import copy
import hashlib
import time
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.deps import get_current_user
from dispatch_policy_bridge import get_shop_dispatch_status

router = APIRouter(prefix="/api/gc-hub", tags=["AdsPower 群控中心"])

_SESSION_FACTORY = None
_IDS: dict[str, Any] = {}


def init(session_factory, ids: dict[str, Any]):
    global _SESSION_FACTORY, _IDS
    _SESSION_FACTORY = session_factory
    _IDS = ids or {}
    _reset_state()


def _now_hm(offset_min: int = 0) -> str:
    return (datetime.now() + timedelta(minutes=offset_min)).strftime("%H:%M")


def _now_full(offset_min: int = 0) -> str:
    return (datetime.now() + timedelta(minutes=offset_min)).strftime("%Y-%m-%d %H:%M")


ENVS: list[dict[str, Any]] = []
TASKS: list[dict[str, Any]] = []
REPRICE_ITEMS: list[dict[str, Any]] = []
REPRICE_LOGS: list[dict[str, Any]] = []
METRICS_ROWS: list[dict[str, Any]] = []


def _seed_envs() -> list[dict[str, Any]]:
    return [
        {
            "env_id": "k1j1yxdc",
            "serial": "#41",
            "host": "WIN-GC-01（富阳工位A）",
            "group_name": "gc-sales",
            "purpose": "销售主力店",
            "shop_group": "数码主力组 · 1号窗",
            "entity_type": "企业店",
            "shop_key": "guoguo",
            "shop_nick": "果果数码",
            "reported_nick": "果果数码",
            "owner": "陈小满",
            "proxy": "杭州联通独享家宽 · 122.224.81.14:20081",
            "cdp_state": "running",
            "watchdog": "active",
            "im_doorbell": "listening",
            "listed_count": 168,
            "listed_limit": 300,
            "today_published": 4,
            "daily_limit": 10,
            "last_pub_min_ago": 32,
            "next_slot_at": "现在可立即发",
            "last_active_min": 8,
            "polished_today": True,
            "reprice_channel": "闲管家 API 同步改价",
            "listings": [
                {"item_id": "8941102301", "sku_code": "513211540233-A", "title": "飞利浦 27M2N5510P 27英寸 2K显示器", "price": 1020, "cost": 640, "status": "LIVE", "views": 642, "wants": 19, "wuyoumai": False, "aged_days": 9, "img": "/api/demo-img/MON1-1.jpg"},
                {"item_id": "8941102388", "sku_code": "513211549229-B", "title": "戴森 HT01 Airstrait 吹风直发器", "price": 1680, "cost": 1100, "status": "LIVE", "views": 890, "wants": 27, "wuyoumai": False, "aged_days": 18, "img": "/api/demo-img/DYS-1.jpg"},
                {"item_id": "8941102412", "sku_code": "513211540215", "title": "飞利浦 25M2N3200W 25英寸电竞屏", "price": 599, "cost": 420, "status": "LIVE", "views": 310, "wants": 8, "wuyoumai": False, "aged_days": 22, "img": "/api/demo-img/MON2-1.jpg"},
            ],
        },
        {
            "env_id": "k1j2m8pq",
            "serial": "#42",
            "host": "WIN-GC-01（富阳工位A）",
            "group_name": "gc-sales",
            "purpose": "销售主力店",
            "shop_group": "数码主力组 · 2号窗",
            "entity_type": "企业店",
            "shop_key": "xiaoman",
            "shop_nick": "小满优选",
            "reported_nick": "小满优选",
            "owner": "陈小满",
            "proxy": "杭州电信独享家宽 · 115.236.44.92:20082",
            "cdp_state": "running",
            "watchdog": "active",
            "im_doorbell": "listening",
            "listed_count": 112,
            "listed_limit": 300,
            "today_published": 2,
            "daily_limit": 10,
            "last_pub_min_ago": 9,
            "next_slot_at": _now_hm(16),
            "last_active_min": 11,
            "polished_today": True,
            "reprice_channel": "闲管家 API 同步改价",
            "listings": [
                {"item_id": "8941203901", "sku_code": "BQAFLF1XF01011", "title": "小米 空气净化器 4LITE 除醛家用", "price": 359, "cost": 260, "status": "LIVE", "views": 418, "wants": 14, "wuyoumai": False, "aged_days": 6, "img": "/api/demo-img/PUR-1.jpg"},
                {"item_id": "8941203981", "sku_code": "513211549229", "title": "戴森 HT01 电吹风 吹直一体", "price": 1650, "cost": 1100, "status": "LIVE", "views": 520, "wants": 11, "wuyoumai": True, "aged_days": 27, "img": "/api/demo-img/DYS-2.jpg"},
                {"item_id": "8941204055", "sku_code": "513211540203", "title": "盈色 D75V 27寸高清办公显示器", "price": 399, "cost": 280, "status": "DELISTED", "views": 126, "wants": 2, "wuyoumai": False, "aged_days": 19, "img": "/api/demo-img/MON1-2.jpg"},
            ],
        },
        {
            "env_id": "k1j3z4vn",
            "serial": "#43",
            "host": "WIN-GC-01（富阳工位A）",
            "group_name": "gc-sales",
            "purpose": "销售主力店",
            "shop_group": "电竞硬件组 · 1号窗",
            "entity_type": "标准店",
            "shop_key": "zhouzhou",
            "shop_nick": "周周二手",
            "reported_nick": "周周二手",
            "owner": "周小北",
            "proxy": "杭州移动独享家宽 · 112.17.108.35:20083",
            "cdp_state": "running",
            "watchdog": "active",
            "im_doorbell": "listening",
            "listed_count": 94,
            "listed_limit": 300,
            "today_published": 1,
            "daily_limit": 10,
            "last_pub_min_ago": 54,
            "next_slot_at": "现在可立即发",
            "last_active_min": 42,
            "polished_today": False,
            "reprice_channel": "AdsPower 自动下架新价重发",
            "listings": [
                {"item_id": "8941308812", "sku_code": "513211540009", "title": "创维 F24G30F 24寸 144Hz 电竞显示器", "price": 468, "cost": 330, "status": "LIVE", "views": 289, "wants": 9, "wuyoumai": False, "aged_days": 3, "img": "/api/demo-img/MON2-1.jpg"},
                {"item_id": "8941308890", "sku_code": "BQAFLF1XF01011-B", "title": "小米 空气净化器 4LITE 卧室静音款", "price": 365, "cost": 260, "status": "LIVE", "views": 195, "wants": 5, "wuyoumai": False, "aged_days": 16, "img": "/api/demo-img/PUR-2.jpg"},
            ],
        },
        {
            "env_id": "k1j4r7tw",
            "serial": "#44",
            "host": "WIN-GC-01（富阳工位A）",
            "group_name": "gc-sales",
            "purpose": "销售主力店",
            "shop_group": "电竞硬件组 · 2号窗",
            "entity_type": "标准店",
            "shop_key": "fanya_esport",
            "shop_nick": "泛亚电竞严选",
            "reported_nick": "泛亚电竞严选",
            "owner": "周小北",
            "proxy": "宁波联通独享家宽 · 60.190.212.67:20084",
            "cdp_state": "cooldown",
            "cooldown_left_min": 14,
            "watchdog": "active",
            "im_doorbell": "listening",
            "listed_count": 143,
            "listed_limit": 300,
            "today_published": 6,
            "daily_limit": 10,
            "last_pub_min_ago": 4,
            "next_slot_at": _now_hm(14),
            "last_active_min": 4,
            "polished_today": True,
            "reprice_channel": "闲管家 API 同步改价",
            "listings": [
                {"item_id": "8941405102", "sku_code": "ROG-OLED-27", "title": "ROG 超神 27 PG27UCDM 4K 240Hz OLED 旗舰整机套装", "price": 12800, "cost": 9600, "status": "LIVE", "views": 1120, "wants": 34, "wuyoumai": False, "aged_days": 11, "img": "/api/demo-img/MON_ROG-1.jpg"},
            ],
        },
        {
            "env_id": "k1j5b2kx",
            "serial": "#45",
            "host": "WIN-GC-02（富阳工位B）",
            "group_name": "gc-sales",
            "purpose": "销售主力店",
            "shop_group": "区域仓配组 · 1号窗",
            "entity_type": "标准店",
            "shop_key": "hangcheng",
            "shop_nick": "杭城数码仓",
            "reported_nick": "小北私人闲置号",
            "owner": "周小北",
            "proxy": "嘉兴电信独享家宽 · 183.134.91.20:20085",
            "cdp_state": "running",
            "watchdog": "active",
            "im_doorbell": "paused",
            "listed_count": 78,
            "listed_limit": 300,
            "today_published": 0,
            "daily_limit": 10,
            "last_pub_min_ago": 240,
            "next_slot_at": "串号软闸拦截中",
            "last_active_min": 55,
            "polished_today": False,
            "reprice_channel": "AdsPower 自动下架新价重发",
            "listings": [
                {"item_id": "8941501120", "sku_code": "513211540026", "title": "飞利浦 27M2N55 27英寸 IPS 显示器", "price": 799, "cost": 580, "status": "LIVE", "views": 174, "wants": 3, "wuyoumai": False, "aged_days": 14, "img": "/api/demo-img/MON1-1.jpg"},
            ],
        },
        {
            "env_id": "k1j6q9lm",
            "serial": "#46",
            "host": "WIN-GC-02（富阳工位B）",
            "group_name": "gc-sales",
            "purpose": "轻量上新店",
            "shop_group": "区域仓配组 · 2号窗",
            "entity_type": "个人店",
            "shop_key": "zhoubei_per",
            "shop_nick": "周北办公外设",
            "reported_nick": "",
            "owner": "周小北",
            "proxy": "绍兴联通独享家宽 · 220.191.55.18:20086",
            "cdp_state": "expired",
            "watchdog": "active",
            "im_doorbell": "offline",
            "listed_count": 62,
            "listed_limit": 300,
            "today_published": 0,
            "daily_limit": 10,
            "last_pub_min_ago": 600,
            "next_slot_at": "待重登恢复",
            "last_active_min": 190,
            "polished_today": False,
            "reprice_channel": "AdsPower 自动下架新价重发",
            "listings": [
                {"item_id": "8941602209", "sku_code": "513211540232", "title": "飞利浦 25M2N32 25英寸办公屏幕", "price": 539, "cost": 390, "status": "LIVE", "views": 92, "wants": 1, "wuyoumai": False, "aged_days": 8, "img": "/api/demo-img/MON2-2.jpg"},
            ],
        },
        {
            "env_id": "k1j7v5hs",
            "serial": "#47",
            "host": "WIN-GC-02（富阳工位B）",
            "group_name": "gc-virtual",
            "purpose": "虚拟卡券专营店",
            "shop_group": "卡券服务组 · 1号窗",
            "entity_type": "企业店",
            "shop_key": "xy_xm",
            "shop_nick": "小满卡券严选",
            "reported_nick": "小满卡券严选",
            "owner": "陈小满",
            "proxy": "杭州电信独享家宽 · 115.236.44.99:20087",
            "cdp_state": "running",
            "watchdog": "active",
            "im_doorbell": "listening",
            "listed_count": 45,
            "listed_limit": 300,
            "today_published": 3,
            "daily_limit": 10,
            "last_pub_min_ago": 40,
            "next_slot_at": "现在可立即发",
            "last_active_min": 6,
            "polished_today": True,
            "reprice_channel": "闲管家 + 阿奇索联动",
            "listings": [
                {"item_id": "8941709901", "sku_code": "VC-A1-0101", "title": "麦当劳 鸡牛双堡双人餐电子券 全国通用秒发", "price": 46, "cost": 36, "status": "LIVE", "views": 1850, "wants": 146, "wuyoumai": False, "aged_days": 12, "img": "/api/demo-img/V-mcd.jpg"},
            ],
        },
        {
            "env_id": "k1j8p3cf",
            "serial": "#48",
            "host": "WIN-GC-02（富阳工位B）",
            "group_name": "gc-purchase",
            "purpose": "采购谈价专窗（只读门铃）",
            "shop_group": "采购专用隔离窗",
            "entity_type": "采购专窗",
            "shop_key": "pur_01",
            "shop_nick": "阿诚收数码显示器",
            "reported_nick": "阿诚收数码显示器",
            "owner": "采购组",
            "proxy": "杭州联通独享家宽 · 122.224.81.88:20088",
            "cdp_state": "running",
            "watchdog": "active",
            "im_doorbell": "listening",
            "listed_count": 0,
            "listed_limit": 0,
            "today_published": 0,
            "daily_limit": 0,
            "last_pub_min_ago": 0,
            "next_slot_at": "采购号禁发销售品",
            "last_active_min": 2,
            "polished_today": True,
            "reprice_channel": "—",
            "listings": [],
        },
    ]


def _seed_tasks() -> list[dict[str, Any]]:
    return [
        {
            "id": "GC-T908",
            "task_type": "goods_publish",
            "type_label": "AdsPower 网页上架",
            "env_id": "k1j2m8pq",
            "shop_nick": "小满优选",
            "sku_code": "513211540233-B",
            "title": "飞利浦 27M2N5510P 27寸 IPS 100Hz",
            "price": 1018,
            "status": "SCHEDULED",
            "scheduled_at": _now_hm(16),
            "created_at": _now_hm(-9),
            "step_detail": "同号 25 分钟错峰排期等待中（上一票 9 分钟前刚发完，防机械铺货限流）",
            "item_id": "",
            "screenshot": "",
            "error_code": "",
        },
        {
            "id": "GC-T907",
            "task_type": "goods_publish",
            "type_label": "AdsPower 网页上架",
            "env_id": "k1j4r7tw",
            "shop_nick": "泛亚电竞严选",
            "sku_code": "513211540213",
            "title": "创维 F25G37F 25寸 165Hz 电竞显示器",
            "price": 519,
            "status": "FAILED",
            "scheduled_at": _now_hm(-4),
            "created_at": _now_hm(-5),
            "step_detail": "publish_flow_web -> step_submit 捕获 punish iframe 滑块验证，已自动熔断冷却 18 分钟（绝不硬闯滑块）",
            "item_id": "",
            "screenshot": "/api/demo-img/GC-ERR-PUNISH.jpg",
            "error_code": "punish_slider",
        },
        {
            "id": "GC-T906",
            "task_type": "goods_delist",
            "type_label": "联动下架",
            "env_id": "k1j2m8pq",
            "shop_nick": "小满优选",
            "sku_code": "513211549229",
            "title": "戴森 HT01 电吹风（无忧卖旧链接清理）",
            "price": 1650,
            "status": "BLOCKED",
            "scheduled_at": _now_hm(-28),
            "created_at": _now_hm(-29),
            "step_detail": "网页版点击下架弹出「该宝贝已加入无忧卖」终态拦截（不盲目重试，可一键切换闲管家 API 协同下架）",
            "item_id": "8941203981",
            "screenshot": "/api/demo-img/GC-ERR-WUYOU.jpg",
            "error_code": "wuyoumai_intercept",
        },
        {
            "id": "GC-T905",
            "task_type": "chat_scan",
            "type_label": "消息采集巡检",
            "env_id": "k1j6q9lm",
            "shop_nick": "周北办公外设",
            "sku_code": "—",
            "title": "常驻 /im 会话未读扫描",
            "price": 0,
            "status": "FAILED",
            "scheduled_at": _now_hm(-45),
            "created_at": _now_hm(-45),
            "step_detail": "self_check 检测到 goofish.com 登录 Cookie 已失效，已冻结该窗口派单，待唤起专窗免密重登",
            "item_id": "",
            "screenshot": "/api/demo-img/GC-ERR-LOGIN.jpg",
            "error_code": "cookie_expired",
        },
        {
            "id": "GC-T904",
            "task_type": "goods_publish",
            "type_label": "AdsPower 网页上架",
            "env_id": "k1j2m8pq",
            "shop_nick": "小满优选",
            "sku_code": "BQAFLF1XF01011",
            "title": "小米 空气净化器 4LITE（input[file] 高清原图上传）",
            "price": 359,
            "status": "SUCCESS",
            "scheduled_at": _now_hm(-9),
            "created_at": _now_hm(-10),
            "step_detail": "已完成：input[type=file] 上传 3 张独立主图 → AI 描述 → 回读真实 item_id=8941203901",
            "item_id": "8941203901",
            "screenshot": "",
            "error_code": "",
        },
        {
            "id": "GC-T903",
            "task_type": "goods_polish",
            "type_label": "日常曝光维护",
            "env_id": "k1j1yxdc",
            "shop_nick": "果果数码",
            "sku_code": "账号级",
            "title": "全店在售宝贝曝光刷新 + 30分钟真实浏览活跃留痕",
            "price": 0,
            "status": "SUCCESS",
            "scheduled_at": _now_hm(-50),
            "created_at": _now_hm(-51),
            "step_detail": "已完成账号活跃留痕与在售曝光刷新",
            "item_id": "",
            "screenshot": "",
            "error_code": "",
        },
    ]


def _seed_reprice() -> list[dict[str, Any]]:
    return [
        {
            "id": "RP-01",
            "sku_code": "ATV4K-128-003",
            "name": "Apple TV 4K 三代 128G 港版全套",
            "grade": "95新 · 原盒配件齐",
            "tier": "1000-3000元档",
            "env_id": "k1j1yxdc",
            "shop_nick": "果果数码",
            "channel": "闲管家 API 同步改价",
            "cost": 760,
            "floor_price": 880,
            "current_price": 999,
            "market_median": 1060,
            "suggest_price": 1049,
            "sample_count": 28,
            "confidence": "高",
            "stock_days": 5,
            "views_7d": 790,
            "inquiries_7d": 14,
            "action": "up",
            "reason": "近3日闲鱼有效清洗中位价连涨 ¥60（28条样本），本链接近7日 14 人询单、库存仅 1 台，建议上调至 ¥1,049 多赚差价",
            "state": "pending",
            "locked_until": "",
        },
        {
            "id": "RP-02",
            "sku_code": "513211549229",
            "name": "戴森 HT01 Airstrait 电吹风直发器",
            "grade": "9成新 · 轻微使用痕",
            "tier": "1000-3000元档",
            "env_id": "k1j2m8pq",
            "shop_nick": "小满优选",
            "channel": "闲管家 API 同步改价",
            "cost": 1100,
            "floor_price": 1265,
            "current_price": 1650,
            "market_median": 1520,
            "suggest_price": 1499,
            "sample_count": 31,
            "confidence": "高",
            "stock_days": 30,
            "views_7d": 520,
            "inquiries_7d": 2,
            "action": "down",
            "reason": "在库已满 30 天（第 4 滞销周期），当前挂牌 ¥1,650 高于最新闲鱼清洗中位价 ¥1,520，建议下调至 ¥1,499 加速回款（仍净赚 ¥399）",
            "state": "pending",
            "locked_until": "",
        },
        {
            "id": "RP-03",
            "sku_code": "513211540203",
            "name": "盈色 D75V 27寸办公显示器",
            "grade": "95新",
            "tier": "300-1000元档",
            "env_id": "k1j3z4vn",
            "shop_nick": "周周二手",
            "channel": "AdsPower 下架原图新价重发",
            "cost": 280,
            "floor_price": 322,
            "current_price": 399,
            "market_median": 368,
            "suggest_price": 359,
            "sample_count": 19,
            "confidence": "高",
            "stock_days": 19,
            "views_7d": 180,
            "inquiries_7d": 1,
            "action": "down",
            "reason": "同型号闲鱼近期挂牌集中在 ¥355~375，库龄 19 天进入第 3 周期，建议微调 ¥40 贴近成交甜点区",
            "state": "pending",
            "locked_until": "",
        },
        {
            "id": "RP-04",
            "sku_code": "ROG-OLED-27",
            "name": "ROG 超神 27 PG27UCDM 4K 240Hz OLED 旗舰整机套装",
            "grade": "99新 · 仅开箱实测",
            "tier": "10000元以上高价值档",
            "env_id": "k1j4r7tw",
            "shop_nick": "泛亚电竞严选",
            "channel": "闲管家 API 同步改价",
            "cost": 9600,
            "floor_price": 10800,
            "current_price": 12800,
            "market_median": 12350,
            "suggest_price": 12299,
            "sample_count": 11,
            "confidence": "中",
            "stock_days": 11,
            "views_7d": 1120,
            "inquiries_7d": 9,
            "action": "down",
            "reason": "≥1万元高价值单品：禁止混入普通批量盲点通过！需核对成色配件后单条填写确认说明（留痕直接生效，无主管审批等待）",
            "state": "pending",
            "locked_until": "",
        },
        {
            "id": "RP-05",
            "sku_code": "513211540026",
            "name": "飞利浦 27M2N55 27英寸显示器",
            "grade": "95新",
            "tier": "300-1000元档",
            "env_id": "k1j5b2kx",
            "shop_nick": "杭城数码仓",
            "channel": "AdsPower 下架原图新价重发",
            "cost": 580,
            "floor_price": 667,
            "current_price": 799,
            "market_median": 785,
            "suggest_price": 789,
            "sample_count": 5,
            "confidence": "低",
            "stock_days": 14,
            "views_7d": 174,
            "inquiries_7d": 3,
            "action": "watch",
            "reason": "今日有效闲鱼同款样本仅 5 条（置信度低），价差不足 2%，系统建议暂不改价、继续观察下一轮快照",
            "state": "pending",
            "locked_until": "",
        },
        {
            "id": "RP-06",
            "sku_code": "513211540233-A",
            "name": "飞利浦 27M2N5510P 27英寸 2K显示器",
            "grade": "95新",
            "tier": "1000-3000元档",
            "env_id": "k1j1yxdc",
            "shop_nick": "果果数码",
            "channel": "闲管家 API 同步改价",
            "cost": 640,
            "floor_price": 736,
            "current_price": 1020,
            "market_median": 995,
            "suggest_price": 1020,
            "sample_count": 24,
            "confidence": "高",
            "stock_days": 9,
            "views_7d": 642,
            "inquiries_7d": 8,
            "action": "locked",
            "reason": "买家「阿杰-数码控」正在接待台谈单议价中，已自动锁价 7 天防谈单中途价格跳变",
            "state": "locked",
            "locked_until": (datetime.now() + timedelta(days=6)).strftime("%m-%d"),
        },
    ]


def _seed_metrics() -> list[dict[str, Any]]:
    return [
        {
            "env_id": "k1j1yxdc",
            "shop_nick": "果果数码",
            "host": "WIN-GC-01",
            "owner": "陈小满",
            "captured_at": "今日 15:31:12",
            "status": "ok",
            "visit_uv": 1420,
            "exposure_cnt": 21840,
            "exposure_uv": 9620,
            "exposure_chg_pct": 18.6,
            "browse_cnt": 3490,
            "browse_uv": 1310,
            "inquiry_cnt": 56,
            "pay_orders": 9,
            "pay_amount": 11480.0,
            "refund_orders": 0,
            "online_products": 168,
            "sold_products": 9,
            "fans_total": 482,
            "fans_new": 14,
            "resp_3min_rate": 91.4,
            "first_resp_sec": 76,
            "screenshots": ["/api/demo-img/GC-SHOP-OVW.jpg", "/api/demo-img/GC-SHOP-FUNNEL.jpg", "/api/demo-img/GC-SHOP-CS.jpg"],
        },
        {
            "env_id": "k1j2m8pq",
            "shop_nick": "小满优选",
            "host": "WIN-GC-01",
            "owner": "陈小满",
            "captured_at": "今日 15:32:05",
            "status": "ok",
            "visit_uv": 1000,
            "exposure_cnt": 14261,
            "exposure_uv": 6787,
            "exposure_chg_pct": 11.2,
            "browse_cnt": 2310,
            "browse_uv": 928,
            "inquiry_cnt": 31,
            "pay_orders": 5,
            "pay_amount": 6146.0,
            "refund_orders": 1,
            "online_products": 112,
            "sold_products": 5,
            "fans_total": 211,
            "fans_new": 6,
            "resp_3min_rate": 88.4,
            "first_resp_sec": 108,
            "screenshots": ["/api/demo-img/GC-SHOP-OVW.jpg", "/api/demo-img/GC-SHOP-FUNNEL.jpg", "/api/demo-img/GC-SHOP-CS.jpg"],
        },
        {
            "env_id": "k1j3z4vn",
            "shop_nick": "周周二手",
            "host": "WIN-GC-01",
            "owner": "周小北",
            "captured_at": "今日 15:33:18",
            "status": "ok",
            "visit_uv": 610,
            "exposure_cnt": 7820,
            "exposure_uv": 3910,
            "exposure_chg_pct": -36.4,
            "browse_cnt": 620,
            "browse_uv": 388,
            "inquiry_cnt": 12,
            "pay_orders": 0,
            "pay_amount": 0.0,
            "refund_orders": 0,
            "online_products": 94,
            "sold_products": 0,
            "fans_total": 139,
            "fans_new": 1,
            "resp_3min_rate": 61.5,
            "first_resp_sec": 685,
            "screenshots": ["/api/demo-img/GC-SHOP-OVW.jpg", "/api/demo-img/GC-SHOP-FUNNEL.jpg", "/api/demo-img/GC-SHOP-CS.jpg"],
        },
        {
            "env_id": "k1j4r7tw",
            "shop_nick": "泛亚电竞严选",
            "host": "WIN-GC-01",
            "owner": "周小北",
            "captured_at": "今日 15:34:40",
            "status": "ok",
            "visit_uv": 1180,
            "exposure_cnt": 18920,
            "exposure_uv": 8410,
            "exposure_chg_pct": 6.8,
            "browse_cnt": 2690,
            "browse_uv": 1105,
            "inquiry_cnt": 39,
            "pay_orders": 4,
            "pay_amount": 16920.0,
            "refund_orders": 0,
            "online_products": 143,
            "sold_products": 4,
            "fans_total": 356,
            "fans_new": 9,
            "resp_3min_rate": 85.0,
            "first_resp_sec": 132,
            "screenshots": ["/api/demo-img/GC-SHOP-OVW.jpg", "/api/demo-img/GC-SHOP-FUNNEL.jpg", "/api/demo-img/GC-SHOP-CS.jpg"],
        },
        {
            "env_id": "k1j5b2kx",
            "shop_nick": "杭城数码仓",
            "host": "WIN-GC-02",
            "owner": "周小北",
            "captured_at": "今日 15:35:22",
            "status": "ok",
            "visit_uv": 340,
            "exposure_cnt": 4950,
            "exposure_uv": 2410,
            "exposure_chg_pct": -32.8,
            "browse_cnt": 310,
            "browse_uv": 232,
            "inquiry_cnt": 7,
            "pay_orders": 0,
            "pay_amount": 0.0,
            "refund_orders": 0,
            "online_products": 78,
            "sold_products": 0,
            "fans_total": 88,
            "fans_new": 0,
            "resp_3min_rate": 79.2,
            "first_resp_sec": 195,
            "screenshots": ["/api/demo-img/GC-SHOP-OVW.jpg", "/api/demo-img/GC-SHOP-FUNNEL.jpg"],
        },
        {
            "env_id": "k1j6q9lm",
            "shop_nick": "周北办公外设",
            "host": "WIN-GC-02",
            "owner": "周小北",
            "captured_at": "抓取失败（Cookie过期）",
            "status": "missing",
            # 严格遵守需求铁律：没抓到的数据保留为 None（前端显示 —/待补抓），绝不乱填 0！
            "visit_uv": None,
            "exposure_cnt": None,
            "exposure_uv": None,
            "exposure_chg_pct": None,
            "browse_cnt": None,
            "browse_uv": None,
            "inquiry_cnt": None,
            "pay_orders": None,
            "pay_amount": None,
            "refund_orders": None,
            "online_products": None,
            "sold_products": None,
            "fans_total": None,
            "fans_new": None,
            "resp_3min_rate": None,
            "first_resp_sec": None,
            "screenshots": ["/api/demo-img/GC-ERR-LOGIN.jpg"],
        },
        {
            "env_id": "k1j7v5hs",
            "shop_nick": "小满卡券严选",
            "host": "WIN-GC-02",
            "owner": "陈小满",
            "captured_at": "今日 15:36:10",
            "status": "ok",
            "visit_uv": 1890,
            "exposure_cnt": 29400,
            "exposure_uv": 13500,
            "exposure_chg_pct": 26.4,
            "browse_cnt": 4620,
            "browse_uv": 2180,
            "inquiry_cnt": 48,
            "pay_orders": 64,
            "pay_amount": 4820.0,
            "refund_orders": 2,
            "online_products": 45,
            "sold_products": 18,
            "fans_total": 615,
            "fans_new": 29,
            "resp_3min_rate": 96.8,
            "first_resp_sec": 18,
            "screenshots": ["/api/demo-img/GC-SHOP-OVW.jpg", "/api/demo-img/GC-SHOP-FUNNEL.jpg", "/api/demo-img/GC-SHOP-CS.jpg"],
        },
    ]


def _reset_state():
    ENVS.clear()
    ENVS.extend(_seed_envs())
    TASKS.clear()
    TASKS.extend(_seed_tasks())
    REPRICE_ITEMS.clear()
    REPRICE_ITEMS.extend(_seed_reprice())
    REPRICE_LOGS.clear()
    REPRICE_LOGS.extend([
        {
            "id": "RL-001",
            "at": _now_full(-130),
            "who": "陈小满",
            "sku_code": "513211540009",
            "name": "创维 F24G30F 24寸显示器",
            "shop_nick": "周周二手",
            "old_price": 499,
            "new_price": 468,
            "channel": "AdsPower 下架原图新价重发",
            "reason": "确认采纳行情下调建议",
            "effect": "改价后 2 小时浏览 +34%，已出 1 单",
        }
    ])
    METRICS_ROWS.clear()
    METRICS_ROWS.extend(_seed_metrics())


def _env_view(e: dict[str, Any]) -> dict[str, Any]:
    v = copy.deepcopy(e)
    v["entity"] = e.get("shop_group") or "标准销售组"
    is_purchase = e["group_name"] == "gc-purchase"
    nick_ok = is_purchase or e["cdp_state"] == "expired" or (bool(e["reported_nick"]) and e["reported_nick"] == e["shop_nick"])
    v["nick_match"] = nick_ok
    issues: list[dict[str, str]] = []
    if e["cdp_state"] == "expired":
        issues.append({"lvl": "red", "text": "闲鱼网页版 Cookie 已过期掉线，派单与门铃已暂停：请点「唤起专窗 + 领动态码」免密恢复"})
    elif not nick_ok:
        issues.append({"lvl": "red", "text": f"防发错号软闸拦截：绑定店铺「{e['shop_nick']}」≠ 窗口实登「{e['reported_nick'] or '未读到'}」，严禁派发上架"})
    elif e["cdp_state"] == "cooldown":
        issues.append({"lvl": "amb", "text": f"命中闲鱼滑块风控（punish iframe），自动熔断冷却还剩 {e.get('cooldown_left_min', 12)} 分钟"})

    dp = get_shop_dispatch_status(e.get("shop_key") or e.get("shop_nick") or "")
    v["dispatch_state"] = dp["dispatch_state"]
    v["dispatch_badge"] = dp["dispatch_badge"]
    v["dispatch_hint"] = dp["dispatch_hint"]
    if not is_purchase:
        if dp["dispatch_state"] == "schedule_full":
            issues.append({"lvl": "red", "text": "当期排期已满 · 暂停派新，新商品请分配至空闲店铺"})
        elif dp["dispatch_state"] == "prefer_idle":
            issues.append({"lvl": "amb", "text": "近期排期较密，新洗商品建议优先分配至空闲店铺"})
        if e["today_published"] >= e["daily_limit"]:
            issues.append({"lvl": "amb", "text": f"今日已发满 {e['daily_limit']} 票上限，新票顺延明日"})
        if e["last_active_min"] > 30 and e["cdp_state"] == "running" and nick_ok:
            issues.append({"lvl": "amb", "text": f"已 {e['last_active_min']} 分钟无活跃浏览痕迹（规范要求工作时间每 30 分钟一次），建议点一键活跃擦亮"})

    v["issues"] = issues
    v["lvl"] = "red" if any(i["lvl"] == "red" for i in issues) else ("amb" if issues else "grn")
    v["flow_divert"] = (not is_purchase) and (dp["dispatch_state"] in ("prefer_idle", "schedule_full") or e["today_published"] >= e["daily_limit"] or e["listed_count"] >= e["listed_limit"])
    return v


def _linked_conflicts() -> list[dict[str, Any]]:
    """扫描孤品锁单/已售但仍有其它 AdsPower 窗口挂着 LIVE 链接的冲突项（含多件/虚拟品对比说明）。"""
    out = []
    # 1. 戴森 513211549229-B（买家-小林 已锁单 ¥1680，但果果数码 k1j1yxdc 仍在架 LIVE）
    for env in ENVS:
        for ls in env["listings"]:
            if ls["sku_code"] == "513211549229-B" and ls["status"] == "LIVE":
                out.append({
                    "sku_code": "513211549229-B",
                    "name": "戴森 HT01 电吹风（孤品一机一码）",
                    "kind_rule": "孤品实物 · 任一号锁单即全号联动下架",
                    "sold_info": "买家「小林」已在小满优选拍下锁单（¥1,680）",
                    "lingering_shops": [{"env_id": env["env_id"], "shop_nick": env["shop_nick"], "item_id": ls["item_id"], "price": ls["price"]}],
                    "lvl": "red",
                })
            elif ls["sku_code"] == "BQAFLF1XF01011-B" and ls["status"] == "LIVE":
                out.append({
                    "sku_code": "BQAFLF1XF01011-B",
                    "name": "小米 空气净化器 4LITE（孤品一机一码）",
                    "kind_rule": "孤品实物 · 任一号锁单即全号联动下架",
                    "sold_info": "买家「阿杰」已在果果数码拍下锁单（¥359）",
                    "lingering_shops": [{"env_id": env["env_id"], "shop_nick": env["shop_nick"], "item_id": ls["item_id"], "price": ls["price"]}],
                    "lvl": "red",
                })
    return out


def enqueue_publish_from_wash(sku_code: str, sk_obj: Any, validated_entries: list[tuple[Any, int, list[str]]], operator_name: str) -> list[dict[str, Any]]:
    """供第 2 步「洗图片点确认直接上架」调用的真实 AdsPower 错峰入队钩子！
    规则：
      - 匹配对应闲鱼店铺的 AdsPower 环境；
      - 若该号距离上一票 ≥ 25 分钟（且无在途排期），第 1 票立即执行成功并回读 item_id；
      - 若该号 25 分钟内刚发过票或同一批次多票，自动按 +25 分钟间隔错峰排入 SCHEDULED！
    """
    created_jobs = []
    title = f"{getattr(sk_obj, 'brand', '') or ''} {getattr(sk_obj, 'model', '') or getattr(sk_obj, 'product_name', '')}".strip() or sku_code
    cost = float(getattr(sk_obj, "cost_price", 0) or 0)

    for idx, (sh, price, clean_imgs) in enumerate(validated_entries):
        label = getattr(sh, "label", "") or str(sh)
        env = next((e for e in ENVS if e["shop_nick"] == label), None)
        env_id = env["env_id"] if env else "k1j1yxdc"
        recent_busy = env and env["last_pub_min_ago"] < 25
        tid = f"GC-T{910 + len(TASKS) + 1}"

        if not recent_busy:
            fake_item_id = str(8949000000 + abs(hash(f"{sku_code}:{label}:{time.time()}")) % 899999)
            job = {
                "id": tid,
                "task_type": "goods_publish",
                "type_label": "AdsPower 网页上架",
                "env_id": env_id,
                "shop_nick": label,
                "sku_code": sku_code,
                "title": title,
                "price": price,
                "status": "SUCCESS",
                "scheduled_at": "立即执行",
                "created_at": _now_hm(0),
                "step_detail": f"由 {operator_name} 洗图直发：input[file] 上传 {len(clean_imgs)} 张不重样图 → 回读 item_id={fake_item_id}",
                "item_id": fake_item_id,
                "screenshot": "",
                "error_code": "",
            }
            if env:
                env["today_published"] += 1
                env["listed_count"] += 1
                env["last_pub_min_ago"] = 0
                env["next_slot_at"] = _now_hm(25)
                # 更新或插入单号在架列表
                existing = next((x for x in env["listings"] if x["sku_code"] == sku_code), None)
                if existing:
                    existing.update(price=price, status="LIVE", img=clean_imgs[0])
                else:
                    env["listings"].insert(0, {
                        "item_id": fake_item_id,
                        "sku_code": sku_code,
                        "title": title,
                        "price": price,
                        "cost": int(cost),
                        "status": "LIVE",
                        "views": 1,
                        "wants": 0,
                        "wuyoumai": False,
                        "aged_days": 0,
                        "img": clean_imgs[0],
                    })
        else:
            wait_min = max(12, 25 - int(env["last_pub_min_ago"])) + idx * 25
            sched_str = _now_hm(wait_min)
            job = {
                "id": tid,
                "task_type": "goods_publish",
                "type_label": "AdsPower 错峰上架",
                "env_id": env_id,
                "shop_nick": label,
                "sku_code": sku_code,
                "title": title,
                "price": price,
                "status": "SCHEDULED",
                "scheduled_at": sched_str,
                "created_at": _now_hm(0),
                "step_detail": f"由 {operator_name} 洗图直发：同号 25 分钟防限流错峰保护，排期 {sched_str} 自动推入 AdsPower #{env_id}",
                "item_id": "",
                "screenshot": "",
                "error_code": "",
            }
            if env:
                env["next_slot_at"] = sched_str
        TASKS.insert(0, job)
        created_jobs.append(job)
    return created_jobs


def _metric_alerts(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    alerts = []
    for r in rows:
        if r["status"] == "missing":
            alerts.append({
                "env_id": r["env_id"],
                "shop_nick": r["shop_nick"],
                "lvl": "red",
                "kind": "今日小铺数据漏抓",
                "detail": "15:30 巡检时闲鱼网页版 Cookie 失效未取到数（指标已按规范留空 null，未填 0），请补抓",
            })
            continue
        if r["exposure_chg_pct"] is not None and r["exposure_chg_pct"] <= -30:
            alerts.append({
                "env_id": r["env_id"],
                "shop_nick": r["shop_nick"],
                "lvl": "red",
                "kind": "商品曝光暴跌 >30%",
                "detail": f"近7日曝光环比 {r['exposure_chg_pct']}%，疑似触发同质化限流或漏活跃，建议立即排查主图并执行擦亮重发",
            })
        if (r["browse_uv"] or 0) >= 150 and (r["pay_orders"] or 0) == 0:
            alerts.append({
                "env_id": r["env_id"],
                "shop_nick": r["shop_nick"],
                "lvl": "amb",
                "kind": "有浏览 0 支付",
                "detail": f"浏览 UV {r['browse_uv']} 人、询单 {r['inquiry_cnt']} 次但成交 0 笔，建议去「在售智能调价」下调挂牌价",
            })
        if r["resp_3min_rate"] is not None and r["resp_3min_rate"] < 70:
            alerts.append({
                "env_id": r["env_id"],
                "shop_nick": r["shop_nick"],
                "lvl": "red",
                "kind": "3分钟响应率过低",
                "detail": f"3分钟响应率仅 {r['resp_3min_rate']}%（红线 <70%），平均首响 {round((r['first_resp_sec'] or 0)/60, 1)} 分钟，请检查外包/门铃承接",
            })
    return alerts


@router.get("/badges", summary="左侧导航与经营中枢角标统计")
def get_badges(_=Depends(get_current_user)):
    evs = [_env_view(e) for e in ENVS]
    matrix_red = len([e for e in evs if e["lvl"] == "red"])
    conflicts = _linked_conflicts()
    failed_tasks = [t for t in TASKS if t["status"] in ("FAILED", "BLOCKED")]
    reprice_pend = [r for r in REPRICE_ITEMS if r["state"] == "pending" and r["action"] in ("up", "down")]
    m_alerts = [a for a in _metric_alerts(METRICS_ROWS) if a["lvl"] == "red"]
    return {
        "gc-matrix": matrix_red,
        "gc-queue": len(conflicts) + len(failed_tasks),
        "gc-reprice": len(reprice_pend),
        "gc-metrics": len(m_alerts),
    }


# ==============================================================================
# 页面 1：AdsPower 环境与闲鱼账号矩阵 (#/gc-matrix)
# ==============================================================================
@router.get("/matrix", summary="AdsPower 指纹浏览器环境 × 闲鱼账号矩阵全景")
def get_matrix(_=Depends(get_current_user)):
    items = [_env_view(e) for e in ENVS]
    sales_envs = [x for x in items if x["group_name"] != "gc-purchase"]
    w1 = [x for x in items if x["host"].startswith("WIN-GC-01")]
    w2 = [x for x in items if x["host"].startswith("WIN-GC-02")]
    return {
        "architecture_note": "已全面弃用安卓手机真机，100% 切换为 AdsPower 指纹浏览器 + Playwright CDP 执行端（一窗一号一独享家宽 IP）",
        "workstations": [
            {"host": "WIN-GC-01（富阳工位A）", "local_api": "127.0.0.1:50325 在线（1req/s 节流保护）", "watchdog": "gc-ads run 守护中（v0.7.2）", "envs": len(w1), "running": len([x for x in w1 if x["cdp_state"] == "running"])},
            {"host": "WIN-GC-02（富阳工位B）", "local_api": "127.0.0.1:50325 在线（1req/s 节流保护）", "watchdog": "gc-ads run 守护中（v0.7.2）", "envs": len(w2), "running": len([x for x in w2 if x["cdp_state"] == "running"])},
        ],
        "summary": {
            "total_envs": len(items),
            "online_cdp": len([x for x in items if x["cdp_state"] == "running"]),
            "doorbell_on": len([x for x in items if x["im_doorbell"] == "listening"]),
            "red_count": len([x for x in items if x["lvl"] == "red"]),
            "divert_count": len([x for x in sales_envs if x["flow_divert"]]),
            "total_listed": sum(x["listed_count"] for x in sales_envs),
        },
        "items": items,
    }


@router.post("/matrix/{env_id}/open-browser", summary="调用 AdsPower Local API 一键唤起隔离专窗（免明文密码自动填充）")
def open_adspower_window(env_id: str, u=Depends(get_current_user)):
    env = next((e for e in ENVS if e["env_id"] == env_id), None)
    if not env:
        raise HTTPException(404, "未找到该 AdsPower 环境")
    if env["cdp_state"] == "expired":
        env["cdp_state"] = "running"
        env["reported_nick"] = env["shop_nick"]
        env["im_doorbell"] = "listening"
        env["last_active_min"] = 1
        env["next_slot_at"] = "现在可立即发"
    return {
        "ok": True,
        "msg": f"已通过 Local API (127.0.0.1:50325) 唤起专窗 #{env_id}「{env['shop_nick']}」，密码已由加密总库自动注入填充（员工零明文接触）",
        "item": _env_view(env),
    }


@router.post("/matrix/{env_id}/totp", summary="免明文领用当前 30 秒窗口的 6 位 Authenticator 动态码（fakey）")
def get_env_totp(env_id: str, u=Depends(get_current_user)):
    env = next((e for e in ENVS if e["env_id"] == env_id), None)
    if not env:
        raise HTTPException(404, "未找到该 AdsPower 环境")
    slot = int(time.time()) // 30
    rem = 30 - (int(time.time()) % 30)
    digest = hashlib.sha256(f"{env_id}:{slot}".encode()).hexdigest()
    code = f"{int(digest[:8], 16) % 1000000:06d}"
    return {
        "env_id": env_id,
        "shop_nick": env["shop_nick"],
        "code": code,
        "valid_seconds": rem,
        "note": "服务端实时演算 6 位动态码（零密码、零 Base32 种子泄露），已记录审计日志",
    }


@router.post("/matrix/{env_id}/fix-nick", summary="校对恢复 AdsPower 窗口闲鱼账号昵称，解除防发错号软闸")
def fix_nick_mismatch(env_id: str, u=Depends(get_current_user)):
    env = next((e for e in ENVS if e["env_id"] == env_id), None)
    if not env:
        raise HTTPException(404, "未找到该环境")
    env["reported_nick"] = env["shop_nick"]
    env["im_doorbell"] = "listening"
    env["last_active_min"] = 1
    env["next_slot_at"] = "现在可立即发"
    return {
        "ok": True,
        "msg": f"已完成 #{env_id} self_check 身份帧核验：实登昵称已对齐「{env['shop_nick']}」，防发错号软闸解除！",
        "item": _env_view(env),
    }


@router.post("/matrix/polish-active", summary="批量下发每日免费曝光擦亮 + 30分钟真实浏览活跃留痕")
def batch_polish_and_active(body: dict | None = None, u=Depends(get_current_user)):
    b = body or {}
    target_ids = b.get("env_ids") or [e["env_id"] for e in ENVS if e["group_name"] != "gc-purchase" and e["cdp_state"] == "running"]
    count = 0
    who = getattr(u, "name", u.username)
    for e in ENVS:
        if e["env_id"] in target_ids and e["group_name"] != "gc-purchase":
            if e["cdp_state"] == "expired" or e["reported_nick"] != e["shop_nick"]:
                continue
            e["polished_today"] = True
            e["last_active_min"] = 1
            count += 1
            TASKS.insert(0, {
                "id": f"GC-T{910 + len(TASKS) + 1}",
                "task_type": "goods_polish",
                "type_label": "日常曝光擦亮",
                "env_id": e["env_id"],
                "shop_nick": e["shop_nick"],
                "sku_code": "账号级",
                "title": "全店在售曝光刷新 + 模拟浏览/看消息真实活跃留痕",
                "price": 0,
                "status": "SUCCESS",
                "scheduled_at": "立即执行",
                "created_at": _now_hm(0),
                "step_detail": f"由 {who} 触发：AdsPower #{e['env_id']} 已完成今日免费曝光刷新与活跃心跳",
                "item_id": "",
                "screenshot": "",
                "error_code": "",
            })
    return {"ok": True, "count": count, "msg": f"已为 {count} 个在线闲鱼窗口完成曝光擦亮与活跃留痕"}


# ==============================================================================
# 页面 2：上下架错峰队列、锁单全号联动下架 & 异常截图 (#/gc-queue)
# ==============================================================================
@router.get("/queue", summary="AdsPower 异步上下架队列 + 孤品锁单联动下架台 + 老化重发池")
def get_queue(_=Depends(get_current_user)):
    aged = []
    for e in ENVS:
        for ls in e["listings"]:
            if ls["aged_days"] >= 15 and ls["status"] in ("LIVE", "DELISTED"):
                aged.append({
                    "env_id": e["env_id"],
                    "shop_nick": e["shop_nick"],
                    **ls,
                })
    return {
        "stagger_rule": "同闲鱼账号第 1 票立即通过 AdsPower CDP 上传发布，同号后续票自动按 25 分钟间隔错峰排期；超日限 10 票或排期已满自动引导分配至空闲店铺。",
        "linked_conflicts": _linked_conflicts(),
        "aged_listings": aged,
        "tasks": TASKS,
        "counts": {
            "conflicts": len(_linked_conflicts()),
            "scheduled": len([t for t in TASKS if t["status"] == "SCHEDULED"]),
            "failed": len([t for t in TASKS if t["status"] in ("FAILED", "BLOCKED")]),
            "success": len([t for t in TASKS if t["status"] == "SUCCESS"]),
        },
    }


@router.post("/queue/linked-delist/{sku_code}", summary="一键扇出孤品全号联动下架（消除已锁单仍在其它号挂牌的超卖红灯）")
def run_linked_delist(sku_code: str, u=Depends(get_current_user)):
    who = getattr(u, "name", u.username)
    hit_shops = []
    for e in ENVS:
        for ls in e["listings"]:
            if ls["sku_code"] == sku_code and ls["status"] == "LIVE":
                ls["status"] = "DELISTED"
                e["listed_count"] = max(0, e["listed_count"] - 1)
                hit_shops.append(e["shop_nick"])
                TASKS.insert(0, {
                    "id": f"GC-T{910 + len(TASKS) + 1}",
                    "task_type": "goods_delist",
                    "type_label": "锁单联动下架",
                    "env_id": e["env_id"],
                    "shop_nick": e["shop_nick"],
                    "sku_code": sku_code,
                    "title": ls["title"],
                    "price": ls["price"],
                    "status": "SUCCESS",
                    "scheduled_at": "立即扇出",
                    "created_at": _now_hm(0),
                    "step_detail": f"由 {who} 执行孤品联动下架：AdsPower #{e['env_id']} 已将 item_id={ls['item_id']} 移入已下架仓库并回读确认",
                    "item_id": ls["item_id"],
                    "screenshot": "",
                    "error_code": "",
                })
    # 同步清除 workbench_stub 里的未联动下架冲突红点，使 Today / Gallery 实时变绿
    try:
        import workbench_stub as wb
        wb.PLAN["conflicts"] = [c for c in wb.PLAN.get("conflicts", []) if c.get("sku") != sku_code and not sku_code.startswith(str(c.get("sku") or ""))]
    except Exception:
        pass
    if not hit_shops:
        return {"ok": True, "msg": "该商品在其余账号已全部下架完毕"}
    return {"ok": True, "msg": f"已通过 AdsPower 联动下架 {', '.join(hit_shops)} 的同款在售链接，超卖风险已解除！"}


@router.post("/queue/execute-scheduled/{task_id}", summary="立即推进排期中的上架任务完成执行并回读 item_id")
def execute_scheduled_now(task_id: str, u=Depends(get_current_user)):
    t = next((x for x in TASKS if x["id"] == task_id), None)
    if not t:
        raise HTTPException(404, "没有找到该任务")
    fake_id = str(8949200000 + abs(hash(task_id)) % 799999)
    t["status"] = "SUCCESS"
    t["item_id"] = fake_id
    t["step_detail"] = f"已通过 AdsPower #{t['env_id']} 提前执行完成：input[file] 高清原图上传 → 回读 item_id={fake_id}"
    env = next((e for e in ENVS if e["env_id"] == t["env_id"]), None)
    if env:
        env["today_published"] += 1
        env["listed_count"] += 1
    return {"ok": True, "msg": f"任务 {task_id} 已执行完毕，回读闲鱼链接 ID：{fake_id}", "task": t}


@router.post("/queue/retry/{task_id}", summary="异常任务修复后一键重试 / 切换闲管家 API 兜底完成")
def retry_failed_task(task_id: str, body: dict | None = None, u=Depends(get_current_user)):
    t = next((x for x in TASKS if x["id"] == task_id), None)
    if not t:
        raise HTTPException(404, "没有找到该异常任务")
    env = next((e for e in ENVS if e["env_id"] == t["env_id"]), None)
    if t["error_code"] == "wuyoumai_intercept":
        t["status"] = "SUCCESS"
        t["step_detail"] = "已切换闲管家开放 API 通道协同下架该无忧卖商品，状态核对一致"
        if env:
            for ls in env["listings"]:
                if ls["sku_code"] == t["sku_code"]:
                    ls["status"] = "DELISTED"
        return {"ok": True, "msg": "已通过闲管家 API 协同完成无忧卖链接下架"}
    if env and env["cdp_state"] in ("expired", "cooldown"):
        env["cdp_state"] = "running"
        env["reported_nick"] = env["shop_nick"]
        env["im_doorbell"] = "listening"
        env.pop("cooldown_left_min", None)
    fake_id = t["item_id"] or str(8949500000 + abs(hash(task_id)) % 499999)
    t["status"] = "SUCCESS"
    t["item_id"] = fake_id if t["task_type"] == "goods_publish" else ""
    t["step_detail"] = f"异常已恢复，AdsPower #{t['env_id']} 重试执行成功" + (f"（item_id={fake_id}）" if t["item_id"] else "")
    return {"ok": True, "msg": f"异常任务 {task_id} 已恢复并执行成功！"}


@router.post("/queue/relist-aged", summary="对老化链接（≥15天）执行原图重发 / 仓库重新上架")
def relist_aged_items(body: dict | None = None, u=Depends(get_current_user)):
    b = body or {}
    item_ids = set(b.get("item_ids") or [])
    who = getattr(u, "name", u.username)
    done_cnt = 0
    for e in ENVS:
        for ls in e["listings"]:
            if (not item_ids and ls["aged_days"] >= 15) or (ls["item_id"] in item_ids):
                ls["status"] = "LIVE"
                ls["aged_days"] = 0
                done_cnt += 1
                TASKS.insert(0, {
                    "id": f"GC-T{910 + len(TASKS) + 1}",
                    "task_type": "goods_relist",
                    "type_label": "老化链接重上",
                    "env_id": e["env_id"],
                    "shop_nick": e["shop_nick"],
                    "sku_code": ls["sku_code"],
                    "title": ls["title"],
                    "price": ls["price"],
                    "status": "SUCCESS",
                    "scheduled_at": "立即执行",
                    "created_at": _now_hm(0),
                    "step_detail": f"由 {who} 触发老化激活：已在 AdsPower #{e['env_id']} 重新上架刷新权重（item_id={ls['item_id']}）",
                    "item_id": ls["item_id"],
                    "screenshot": "",
                    "error_code": "",
                })
    return {"ok": True, "count": done_cnt, "msg": f"已完成 {done_cnt} 条老化链接重新上架激活"}


# ==============================================================================
# 页面 3：存量在售商品「智能调价建议 + 人工批量复核台」(#/gc-reprice)
# ==============================================================================
@router.get("/reprice", summary="存量在售商品智能调价建议清单（严禁无脑一键涨跌 · 零主管审批卡点）")
def get_reprice(_=Depends(get_current_user)):
    counts = {
        "pending_all": len([r for r in REPRICE_ITEMS if r["state"] == "pending"]),
        "up": len([r for r in REPRICE_ITEMS if r["state"] == "pending" and r["action"] == "up"]),
        "down": len([r for r in REPRICE_ITEMS if r["state"] == "pending" and r["action"] == "down"]),
        "watch": len([r for r in REPRICE_ITEMS if r["state"] == "pending" and r["action"] == "watch"]),
        "locked": len([r for r in REPRICE_ITEMS if r["state"] == "locked"]),
        "done": len([r for r in REPRICE_ITEMS if r["state"] == "done"]),
    }
    return {
        "principle": "拒绝粗暴「全店一键涨50/降50」：系统每日结合闲鱼清洗行情、成本毛利、库龄周期与7日曝光询单生成逐条建议；员工复核确认即下发执行（破底线或≥1万元高价单填≥3字说明留痕即过，不设主管审批等待）。",
        "web_boundary_note": "因闲鱼网页版原生详情页无直接编辑价格入口，下发执行时系统按店铺自动走「闲管家 API 同步改价」或「AdsPower 自动下架旧链 + 原图新价重发（republish）」。",
        "counts": counts,
        "items": REPRICE_ITEMS,
        "logs": REPRICE_LOGS,
    }


@router.post("/reprice/act", summary="执行单条或批量调价复核动作（confirm / lock / watch / ignore）")
def act_reprice(body: dict, u=Depends(get_current_user)):
    act = str(body.get("action") or "confirm").strip()
    ids = body.get("ids") or []
    custom_prices = body.get("prices") or {}
    reason = str(body.get("reason") or "").strip()
    who = getattr(u, "name", u.username)

    if not ids:
        raise HTTPException(400, "请先选择要处理的在售商品")

    targets = [r for r in REPRICE_ITEMS if r["id"] in ids]
    if not targets:
        raise HTTPException(404, "未找到对应的调价条目")

    if act == "lock":
        for r in targets:
            r["state"] = "locked"
            r["action"] = "locked"
            r["locked_until"] = (datetime.now() + timedelta(days=7)).strftime("%m-%d")
        return {"ok": True, "msg": f"已将 {len(targets)} 条商品锁价 7 天，期间不再生成自动改价打扰"}

    if act == "ignore":
        for r in targets:
            r["state"] = "ignored"
        return {"ok": True, "msg": f"本轮已忽略 {len(targets)} 条调价建议（明日快照重算）"}

    if act == "confirm":
        applied = []
        skipped_high = []
        for r in targets:
            new_p = int(round(float(custom_prices.get(r["id"]) or r["suggest_price"])))
            if new_p <= 0:
                raise HTTPException(400, "调后售价必须大于 0")
            is_high_val = r["current_price"] >= 10000 or new_p >= 10000
            below_floor = new_p < r["floor_price"]
            if (is_high_val or below_floor) and len(reason) < 3:
                if len(targets) > 1:
                    skipped_high.append(r["name"])
                    continue
                why_tag = "≥1万元高价值单品" if is_high_val else f"低于毛利底线 ¥{r['floor_price']}"
                raise HTTPException(400, f"「{r['name']}」属于{why_tag}，请填写≥3字的二次确认留痕说明后直接下发（无需等主管审批）")

            old_p = r["current_price"]
            r["current_price"] = new_p
            r["suggest_price"] = new_p
            r["state"] = "done"

            # 同步更新环境在售列表价格
            env = next((e for e in ENVS if e["env_id"] == r["env_id"]), None)
            if env:
                for ls in env["listings"]:
                    if ls["sku_code"] == r["sku_code"]:
                        ls["price"] = new_p

            TASKS.insert(0, {
                "id": f"GC-T{910 + len(TASKS) + 1}",
                "task_type": "goods_reprice",
                "type_label": "在售复核改价",
                "env_id": r["env_id"],
                "shop_nick": r["shop_nick"],
                "sku_code": r["sku_code"],
                "title": r["name"],
                "price": new_p,
                "status": "SUCCESS",
                "scheduled_at": "立即执行",
                "created_at": _now_hm(0),
                "step_detail": f"由 {who} 复核通过：¥{old_p} → ¥{new_p}（经 {r['channel']} 同步生效）",
                "item_id": "",
                "screenshot": "",
                "error_code": "",
            })
            REPRICE_LOGS.insert(0, {
                "id": f"RL-{len(REPRICE_LOGS) + 1:03d}",
                "at": _now_full(0),
                "who": who,
                "sku_code": r["sku_code"],
                "name": r["name"],
                "shop_nick": r["shop_nick"],
                "old_price": old_p,
                "new_price": new_p,
                "channel": r["channel"],
                "reason": reason or "人工确认采纳系统行情建议价",
                "effect": "刚下发生效，7日曝光转化追踪中",
            })
            applied.append(r["name"])

        msg = f"已确认并下发 {len(applied)} 条改价任务！"
        if skipped_high:
            msg += f"（其中高价值/破底线商品 {', '.join(skipped_high)} 已按防呆规则自动跳过批量，请单独填说明确认）"
        return {"ok": True, "msg": msg, "applied_count": len(applied)}

    raise HTTPException(400, f"未知操作：{act}")


# ==============================================================================
# 页面 4：每日 15:30 闲鱼小铺数据抓取看板 + 异常标红 + 日报 (#/gc-metrics)
# ==============================================================================
@router.get("/metrics", summary="每日 15:30 闲鱼小铺数据汇总总览、转化漏斗、异常标红、原图留存与日报")
def get_shop_metrics(period: str = "7d", _=Depends(get_current_user)):
    factor = 0.16 if period == "1d" else 1.0
    rows = []
    for r in METRICS_ROWS:
        item = copy.deepcopy(r)
        if item["status"] == "ok" and period == "1d":
            for k in ("visit_uv", "exposure_cnt", "exposure_uv", "browse_cnt", "browse_uv", "inquiry_cnt", "pay_orders", "fans_new"):
                if item[k] is not None:
                    item[k] = max(0, int(round(item[k] * factor)))
            if item["pay_amount"] is not None:
                item["pay_amount"] = round(item["pay_amount"] * factor, 2)
        if item["status"] == "ok":
            item["ctr_pct"] = round((item["browse_uv"] / item["exposure_uv"]) * 100, 2) if item["exposure_uv"] else 0.0
            item["cvr_pct"] = round((item["pay_orders"] / item["browse_uv"]) * 100, 2) if item["browse_uv"] else 0.0
        else:
            item["ctr_pct"] = None
            item["cvr_pct"] = None
        rows.append(item)

    valid = [x for x in rows if x["status"] == "ok"]
    tot_exp_uv = sum(x["exposure_uv"] or 0 for x in valid)
    tot_brw_uv = sum(x["browse_uv"] or 0 for x in valid)
    tot_inq = sum(x["inquiry_cnt"] or 0 for x in valid)
    tot_orders = sum(x["pay_orders"] or 0 for x in valid)
    tot_amt = round(sum(x["pay_amount"] or 0 for x in valid), 2)
    avg_resp3 = round(sum(x["resp_3min_rate"] or 0 for x in valid) / max(1, len(valid)), 1)
    avg_first_sec = int(round(sum(x["first_resp_sec"] or 0 for x in valid) / max(1, len(valid))))

    alerts = _metric_alerts(METRICS_ROWS)

    # 按宿主机汇总排行
    by_host: dict[str, dict[str, Any]] = {}
    for x in rows:
        h = by_host.setdefault(x["host"], {"host": x["host"], "accounts": 0, "missing": 0, "exposure_cnt": 0, "inquiry_cnt": 0, "pay_amount": 0.0})
        h["accounts"] += 1
        if x["status"] != "ok":
            h["missing"] += 1
        else:
            h["exposure_cnt"] += x["exposure_cnt"] or 0
            h["inquiry_cnt"] += x["inquiry_cnt"] or 0
            h["pay_amount"] = round(h["pay_amount"] + (x["pay_amount"] or 0), 2)

    today_str = datetime.now().strftime("%Y-%m-%d")
    ranked = sorted(valid, key=lambda x: x["pay_amount"] or 0, reverse=True)
    md_lines = [
        f"# 群控小铺经营日报 {today_str}（{'近1天' if period == '1d' else '近7天'}口径 · 15:30 自动抓取）",
        "",
        "## 一、全矩阵总览",
        f"- 纳管销售闲鱼号：{len(rows)} 个（成功抓取 {len(valid)} 个，缺失待补抓 {len(rows) - len(valid)} 个）",
        f"- 总商品曝光 UV：{tot_exp_uv:,} 人 ｜ 总商品浏览 UV：{tot_brw_uv:,} 人（曝光点击率 {round(tot_brw_uv / max(1, tot_exp_uv) * 100, 2)}%）",
        f"- 总询单人次：{tot_inq:,} 次 ｜ 总成交笔数：{tot_orders} 笔 ｜ 总支付金额：¥{tot_amt:,.2f}",
        f"- 平均 3 分钟响应率：{avg_resp3}% ｜ 平均首次响应：{avg_first_sec} 秒",
        "",
        "## 二、今日标红异常（需重点处理）",
    ]
    for idx, a in enumerate(alerts, 1):
        md_lines.append(f"{idx}. 【{a['shop_nick']} · #{a['env_id']}】{a['kind']} —— {a['detail']}")
    md_lines += [
        "",
        "## 三、账号成交排行",
        "| 排名 | 闲鱼账号 | 支付金额 | 支付笔数 | 浏览UV | 询单人次 | 3分钟响应率 |",
        "|---:|---|---:|---:|---:|---:|---:|",
    ]
    for idx, r in enumerate(ranked, 1):
        md_lines.append(f"| {idx} | {r['shop_nick']} | ¥{r['pay_amount']:,.2f} | {r['pay_orders']} | {r['browse_uv']} | {r['inquiry_cnt']} | {r['resp_3min_rate']}% |")

    return {
        "period": period,
        "schedule_rule": "每日 15:30 自动巡检各 AdsPower 窗口抓取（闲鱼官方每日 15:00 前更新昨日全量数据）；未抓到字段严格存 null 绝不填 0，同时永久留存网页原图。",
        "summary": {
            "visit_uv": sum(x["visit_uv"] or 0 for x in valid),
            "exposure_cnt": sum(x["exposure_cnt"] or 0 for x in valid),
            "exposure_uv": tot_exp_uv,
            "browse_uv": tot_brw_uv,
            "inquiry_cnt": tot_inq,
            "pay_orders": tot_orders,
            "pay_amount": tot_amt,
            "avg_resp_3min": avg_resp3,
            "avg_first_sec": avg_first_sec,
            "fans_total": sum(x["fans_total"] or 0 for x in valid),
            "fans_new": sum(x["fans_new"] or 0 for x in valid),
            "refund_orders": sum(x["refund_orders"] or 0 for x in valid),
        },
        "traffic_sources": [
            {"name": "搜索自然流", "pct": 78.74},
            {"name": "闲鱼号主页", "pct": 13.59},
            {"name": "猜你喜欢推荐", "pct": 6.11},
            {"name": "同城与其他", "pct": 1.56},
        ],
        "alerts": alerts,
        "accounts": rows,
        "hosts": list(by_host.values()),
        "daily_markdown": "\n".join(md_lines),
    }


@router.post("/metrics/recapture/{env_id}", summary="异常账号恢复登录后一键补抓当日小铺数据与截图")
def recapture_shop_metrics(env_id: str, u=Depends(get_current_user)):
    row = next((r for r in METRICS_ROWS if r["env_id"] == env_id), None)
    if not row:
        raise HTTPException(404, "没有找到该账号")
    env = next((e for e in ENVS if e["env_id"] == env_id), None)
    if env and env["cdp_state"] == "expired":
        env["cdp_state"] = "running"
        env["reported_nick"] = env["shop_nick"]
        env["im_doorbell"] = "listening"
    row.update(
        captured_at=f"刚刚补抓 ({_now_hm(0)})",
        status="ok",
        visit_uv=285,
        exposure_cnt=4120,
        exposure_uv=1960,
        exposure_chg_pct=4.5,
        browse_cnt=410,
        browse_uv=268,
        inquiry_cnt=9,
        pay_orders=2,
        pay_amount=1078.0,
        refund_orders=0,
        online_products=62,
        sold_products=2,
        fans_total=94,
        fans_new=3,
        resp_3min_rate=86.2,
        first_resp_sec=92,
        screenshots=["/api/demo-img/GC-SHOP-OVW.jpg", "/api/demo-img/GC-SHOP-FUNNEL.jpg", "/api/demo-img/GC-SHOP-CS.jpg"],
    )
    return {"ok": True, "msg": f"已通过 AdsPower #{env_id} 完成「{row['shop_nick']}」小铺数据与三张原图补抓！"}


@router.post("/metrics/ask", summary="ERP 智能体经营数据自然语言问答（带小铺数据引用）")
def ask_metrics_agent(body: dict, _=Depends(get_current_user)):
    q = str(body.get("question") or "").strip()
    valid = [r for r in METRICS_ROWS if r["status"] == "ok"]
    if "0支付" in q or "没有支付" in q or "无支付" in q or "转化" in q:
        hits = [r for r in valid if (r["browse_uv"] or 0) > 0 and (r["pay_orders"] or 0) == 0]
        return {
            "summary": f"近 7 天共有 {len(hits)} 个账号「有浏览但 0 支付」，建议优先结合『在售智能调价』核查挂牌价是否偏高：",
            "cite": "数据源：shop_daily_metrics（近7天快照 · 15:30 批次）",
            "rows": [{"账号": r["shop_nick"], "AdsPower环境": r["env_id"], "浏览UV": r["browse_uv"], "询单人次": r["inquiry_cnt"], "支付笔数": 0, "负责人": r["owner"]} for r in hits],
        }
    if "跌" in q or "下降" in q or "掉流" in q or "曝光" in q:
        hits = sorted([r for r in valid if (r["exposure_chg_pct"] or 0) < 0], key=lambda x: x["exposure_chg_pct"] or 0)
        return {
            "summary": f"近 7 天曝光环比下滑超 30% 的预警账号共 {len([x for x in hits if x['exposure_chg_pct'] <= -30])} 个，需排查是否重图限流或漏做 30 分钟活跃：",
            "cite": "数据源：shop_daily_metrics.exposure_chg_pct",
            "rows": [{"账号": r["shop_nick"], "环比变化": f"{r['exposure_chg_pct']}%", "近7日曝光": r["exposure_cnt"], "3分钟响应率": f"{r['resp_3min_rate']}%", "负责人": r["owner"]} for r in hits],
        }
    if "响应" in q or "客服" in q or "慢" in q:
        hits = sorted(valid, key=lambda x: x["resp_3min_rate"] or 100)
        return {
            "summary": "按客服 3 分钟响应率从低到高排查如下（低于 70% 已标红提醒）：",
            "cite": "数据源：shop_daily_metrics（客服核心监控页快照）",
            "rows": [{"账号": r["shop_nick"], "3分钟响应率": f"{r['resp_3min_rate']}%", "平均首响": f"{r['first_resp_sec']}秒", "咨询询单": r["inquiry_cnt"], "负责人": r["owner"]} for r in hits[:4]],
        }
    top = sorted(valid, key=lambda x: x["pay_amount"] or 0, reverse=True)
    return {
        "summary": f"当前纳管矩阵近 7 天总成交 ¥{sum(x['pay_amount'] or 0 for x in valid):,.2f}，成交额冠军为「{top[0]['shop_nick']}」：",
        "cite": "数据源：shop_daily_metrics 全量汇总",
        "rows": [{"账号": r["shop_nick"], "宿主机": r["host"], "成交额": f"¥{r['pay_amount']:,.2f}", "支付笔数": r["pay_orders"], "3分钟响应率": f"{r['resp_3min_rate']}%"} for r in top[:5]],
    }
