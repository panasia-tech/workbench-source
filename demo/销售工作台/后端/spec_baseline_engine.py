"""选品规格底座、95%走量款兜底、爬价防呆拦截与基准反向校准引擎。

核心业务铁律（2026-11-18 拍板定稿）：
1. 来源站双口径分工：
   - 宏观全品类大纲站（BookOff 2735类目 / 爱回收28大类 / 闲鱼43榜 / HardOff）：管「类型全覆盖」，哪怕具体型号漏也没关系；
   - 垂类具体型号站（屏库网 / 中关村ZOL / 太平洋产品库 / GSMArena / TechPowerUp）：单品类掏空 1 万个具体型号并挂好硬参数。
2. 显示器三路定价分流（按市面 1000 元分界走量款 vs 高端款）：
   - 【95% 走量款（市面 ≤ ¥1000 普通 LCD 屏）】：
     * 刷新率直接按「最高超频 OC 刷新率」算，不管原生面板多少；
     * 爬到闲鱼价 → 正常直接用实爬价，但必须过「基准防呆尺」（例如 2K 240Hz 走量屏收货底价都要 ¥400~520，闲鱼若错爬成 ¥200 坏屏/支架/老后缀，系统+模型反推直接标红阻断，绝不填入）；
     * 没爬到闲鱼价（那两三千个冷门型号）→ 优先用同规格档（同品牌档+分辨率+超频Hz档+面板）已爬出真实型号的中位价融合手册基准公式兜底；
     * 反向调优 → 拿这 95% 走量款的闲鱼实爬大盘反向对比当前基准，预留人工拍板调基价/调倍率的决策台。
   - 【5% 高端稀缺款（市面 > ¥1000，如 2K 240Hz OLED、ROG 旗舰、300Hz+ 超高刷、双模、带鱼屏、高端4K/5K/6K）】：
     * 市面上货少、缺乏同档参考，不设单独公式兜底价，直接按闲鱼爬取价算；
     * 闲鱼没爬到就标「高端款无在售（不套走量公式，人工看一眼）」；但若爬出 ¥150~¥300 支架/碎屏假价照样触发低价防呆拦截。
   - 【卓威 ZOWIE 独立体系（XL / XQ 全系）】：
     * 唯一有单独价格体系的品牌，保值率与普通商品不在一条线，按完整后缀与 DyAc 代际独立核价。
3. 多品类规格坑位预留：
   - 复杂品类预留完整规格槽：显示器（已全量落地）、手机/平板/笔记本/Apple、电脑DIY硬件（显卡/CPU/内存/固态）、数码影像与穿戴、电竞外设；
   - 简单标品不折腾：扫拖地机器人、空气净化器、吹风机、脱毛仪、音响等维持「品牌 → 型号」直接爬闲鱼。
"""
from __future__ import annotations

import copy
import json
import os
import re
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.deps import get_current_user

router = APIRouter(prefix="/api/spec-baseline", tags=["选品规格底座与走量兜底防呆台"])

HERE = os.path.dirname(os.path.abspath(__file__))

# ------------------------------------------------------------------ 1. 来源站双口径定义
SOURCE_DUAL_CALIBERS: list[dict[str, Any]] = [
    {
        "caliber": "macro_outline",
        "title": "口径 A · 宏观全品类大纲站（管广度：类型全覆盖、防漏赛道）",
        "summary": "具体型号往往漏得一塌糊涂或只有商品名，但它有极全的类目树和大纲，用来锁死几十万种商品「有哪些品类赛道可做」。",
        "examples": [
            {"name": "BookOff 全量类目树", "scale": "6大根类 · 2,735个细分目录 · 209采购品类", "role": "二手全品类宏观大纲底座"},
            {"name": "爱回收公开目录大纲", "scale": "28个3C数码细分类 · 979个品牌归属", "role": "国内二手3C回收品类骨架"},
            {"name": "闲鱼 43 个手机类目榜", "scale": "43个高流动性二手类目 · 1.5万活跃卖家", "role": "国内真实二手高周转赛道雷达"},
            {"name": "HardOff / 2nd STREET / CeX", "scale": "全球15个有数据综合二手站", "role": "海外二手长尾品类补充大纲"},
        ],
    },
    {
        "caliber": "vertical_deep",
        "title": "口径 B · 垂类精钻具体型号站（管深度：单品类掏空 1 万个型号 + 硬参数）",
        "summary": "没有全品类，但在各自垂直领域能把上万个具体型号和尺寸/分辨率/超频Hz/芯片/容量一次性抓齐，供闲鱼精准爬虫与同档兜底。",
        "examples": [
            {"name": "屏库网 / 中关村ZOL / 太平洋产品库", "scale": "显示器 8,044~10,000+ 具体型号", "role": "抓齐尺寸、分辨率、最高(超频)Hz、面板类型"},
            {"name": "TechPowerUp / 京东硬件参数库", "scale": "显卡 / CPU / 主板 / 固态上万型号", "role": "抓齐芯片组核心、AIC一二线品牌档、显存容量"},
            {"name": "GSMArena / EveryMac / 爱回收机型库", "scale": "Apple 全系 / 手机 / 平板 / 笔记本", "role": "抓齐芯片代际、内存、存储容量、国行/外版锁态"},
            {"name": "DPReview / 佳明库 / RTINGS 外设库", "scale": "相机镜头 / 智能穿戴 / 磁轴键鼠耳机", "role": "抓齐卡口恒定光圈、表盘尺寸、三模/轴体代际"},
        ],
    },
]

# ------------------------------------------------------------------ 2. 显示器核心规则状态（支持反向校准人工拍板修改）
DEFAULT_MONITOR_RULES: dict[str, Any] = {
    "version": "v2026.11.18-r1",
    "updatedAt": "2026-11-18 17:55",
    "updatedBy": "系统初始化（依据《电竞显示器采购价格说明 2026.11.05》+ 95%走量边界）",
    "volumeCeilingPrice": 1000,  # 市面 ≤ 1000 元归为 95% 走量款，> 1000 元归为 5% 高端款按实爬算
    "hzPolicy": "overclock_max",  # 直接按超频最高刷新率归档，不管原生面板多少
    "baseSpecPrices": {
        "office_1k": {"label": "办公低刷 · 1K (60~100Hz)", "res": "1K", "hzTier": "office", "baseBuy": 95.0, "defaultResaleMult": 2.15},
        "office_2k": {"label": "办公低刷 · 2K (60~100Hz)", "res": "2K", "hzTier": "office", "baseBuy": 165.0, "defaultResaleMult": 2.10},
        "office_4k": {"label": "办公低刷 · 4K (60~100Hz普通LCD)", "res": "4K", "hzTier": "office", "baseBuy": 280.0, "defaultResaleMult": 2.05},
        "1k_180": {"label": "走量四档① · 1K 180Hz档 (120~200Hz)", "res": "1K", "hzTier": "180", "baseBuy": 150.0, "defaultResaleMult": 1.95},
        "2k_180": {"label": "走量四档② · 2K 180Hz档 (120~200Hz)", "res": "2K", "hzTier": "180", "baseBuy": 250.0, "defaultResaleMult": 1.85},
        "1k_240": {"label": "走量四档③ · 1K 240Hz档 (201~280Hz)", "res": "1K", "hzTier": "240", "baseBuy": 250.0, "defaultResaleMult": 1.80},
        "2k_240": {"label": "走量四档④ · 2K 240Hz档 (201~280Hz)", "res": "2K", "hzTier": "240", "baseBuy": 400.0, "defaultResaleMult": 1.72},
    },
    "brandTiers": {
        "super_tier1": {
            "label": "超一线品牌",
            "multiplier": 1.50,
            "brands": ["LG", "三星", "Samsung", "ROG", "玩家国度"],
            "note": "ASUS 普通/TUF 不进本档；ROG 只乘一次 1.50 不叠加",
        },
        "tier1": {
            "label": "一线成熟品牌",
            "multiplier": 1.30,
            "brands": ["AOC", "AGON", "飞利浦", "Philips", "优派", "ViewSonic", "华硕", "ASUS", "TUF", "微星", "MSI", "宏碁", "Acer", "技嘉", "GIGABYTE", "AORUS", "戴尔", "Dell", "外星人", "Alienware", "明基", "BenQ", "联想", "Lenovo", "惠普", "HP"],
            "note": "明基普通/MOBIUZ 归 1.30；卓威 ZOWIE 单独拎出不套此表",
        },
        "tier2": {
            "label": "二线基准品牌",
            "multiplier": 1.00,
            "brands": ["HKC", "惠科", "KTC", "康冠", "科睿", "KOORUI", "泰坦军团", "TITAN ARMY", "盛色", "SANC", "联合创新", "INNOCN", "小米", "Redmi", "创维", "蚂蚁电竞", "雷神", "机械军团", "熊猫", "iiyama"],
            "note": "有正规主体与售后按 1.00 基准；未知正规品牌先核实不直接打五折",
        },
        "generic": {
            "label": "无牌/贴牌杂牌",
            "multiplier": 0.50,
            "brands": ["杂牌", "无牌", "贴牌", "白牌"],
            "note": "身份、规格、售后三项缺失才按 ×0.50",
        },
    },
    "panelMultipliers": {
        "oled": {"label": "真 OLED（WOLED / QD-OLED / Tandem）", "multiplier": 1.50, "note": "多数乘完后市面售价 > ¥1000，归入 5% 高端款直接按闲鱼实爬算"},
        "lcd": {"label": "普通 LCD / Mini LED 背光（IPS / Fast IPS / Nano IPS / VA / TN / MiniLED）", "multiplier": 1.00, "note": "Mini LED 是背光不是 OLED，面板系数仍为 1.00"},
    },
    "sanityThresholds": {
        "minSaleVsBuyRatio": 1.08,   # 闲鱼挂牌价低于采购目标价 1.08 倍（甚至低于采购价本身，如 2K240 爬出 ¥200 < ¥400）立即判定错爬假价拦截
        "minSaleVsBucketMedian": 0.52,  # 闲鱼挂牌价低于同规格桶实爬中位价 52% 判定混入坏屏/支架/老后缀拦截
        "highEndAbsurdFloor": 450.0,  # 5% 高端款（OLED/4K高刷/360Hz+）若实爬低于 ¥450 必为配件/尸体假价拦截
        "zowieAbsurdFloor": 420.0,   # 卓威 ZOWIE 全系若实爬低于 ¥420 判定混入损坏/假冒/空支架拦截
    },
}

# 卓威 ZOWIE 独立价格参考表（唯一拥有独立价格体系的品牌）
DEFAULT_ZOWIE_PRICE_TABLE: list[dict[str, Any]] = [
    {"code": "Z01", "model": "XL2411", "size": 24.0, "res": "1K", "hz": 144, "panel": "TN", "dyac": "无 DyAc", "buyTarget": 260, "xianyuAnchor": 480, "note": "老款DVI-DL满刷；注意区分XL2411P/K"},
    {"code": "Z02", "model": "XL2411P", "size": 24.0, "res": "1K", "hz": 144, "panel": "TN", "dyac": "无 DyAc", "buyTarget": 320, "xianyuAnchor": 560, "note": "带DP接口；不是小底座XL2411K"},
    {"code": "Z03", "model": "XL2411K", "size": 24.0, "res": "1K", "hz": 144, "panel": "TN", "dyac": "DyAc", "buyTarget": 480, "xianyuAnchor": 780, "note": "小底座K系入门DyAc；保值率远高于普通144Hz"},
    {"code": "Z04", "model": "XL2430", "size": 24.0, "res": "1K", "hz": 144, "panel": "TN", "dyac": "无 DyAc", "buyTarget": 340, "xianyuAnchor": 590, "note": "带S Switch控制器，无DyAc"},
    {"code": "Z05", "model": "XL2540", "size": 24.5, "res": "1K", "hz": 240, "panel": "TN", "dyac": "无 DyAc", "buyTarget": 620, "xianyuAnchor": 980, "note": "240Hz无DyAc老款；严禁当XL2546收"},
    {"code": "Z06", "model": "XL2540K", "size": 24.5, "res": "1K", "hz": 240, "panel": "Fast TN", "dyac": "无 DyAc", "buyTarget": 780, "xianyuAnchor": 1220, "note": "K系小底座240Hz无DyAc；勿付2546K溢价"},
    {"code": "Z07", "model": "XL2546", "size": 24.5, "res": "1K", "hz": 240, "panel": "TN", "dyac": "DyAc", "buyTarget": 850, "xianyuAnchor": 1350, "note": "初代240Hz DyAc；核对S Switch与遮光翼"},
    {"code": "Z08", "model": "XL2546S", "size": 24.5, "res": "1K", "hz": 240, "panel": "Fast TN", "dyac": "DyAc+", "buyTarget": 980, "xianyuAnchor": 1520, "note": "老底座DyAc+快速液晶版"},
    {"code": "Z09", "model": "XL2546K", "size": 24.5, "res": "1K", "hz": 240, "panel": "Fast TN", "dyac": "DyAc+", "buyTarget": 1180, "xianyuAnchor": 1780, "note": "二手硬通货主力款！小底座+DyAc+"},
    {"code": "Z10", "model": "XL2546X", "size": 24.5, "res": "1K", "hz": 240, "panel": "Fast TN", "dyac": "DyAc 2", "buyTarget": 1650, "xianyuAnchor": 2380, "note": "升级DyAc 2双背光；区别于280Hz的X+"},
    {"code": "Z11", "model": "XL2540X+", "size": 24.1, "res": "1K", "hz": 280, "panel": "New Fast TN", "dyac": "无 DyAc", "buyTarget": 1350, "xianyuAnchor": 1950, "note": "280Hz入门X+无DyAc 2；别与2546X+混价"},
    {"code": "Z12", "model": "XL2546X+", "size": 24.1, "res": "1K", "hz": 280, "panel": "New Fast TN", "dyac": "DyAc 2", "buyTarget": 1880, "xianyuAnchor": 2680, "note": "24.1寸280Hz DyAc 2"},
    {"code": "Z13", "model": "XL2566K", "size": 24.5, "res": "1K", "hz": 360, "panel": "Fast TN", "dyac": "DyAc+", "buyTarget": 1950, "xianyuAnchor": 2790, "note": "360Hz K系经典竞技屏"},
    {"code": "Z14", "model": "XL2566X+", "size": 24.1, "res": "1K", "hz": 400, "panel": "New Fast TN", "dyac": "DyAc 2", "buyTarget": 2550, "xianyuAnchor": 3580, "note": "400Hz DyAc 2；别当360Hz K版"},
    {"code": "Z15", "model": "XL2586X", "size": 24.1, "res": "1K", "hz": 540, "panel": "Fast TN", "dyac": "DyAc 2", "buyTarget": 3600, "xianyuAnchor": 4950, "note": "540Hz顶级FPS竞技屏"},
    {"code": "Z16", "model": "XL2586X+", "size": 24.1, "res": "1K", "hz": 600, "panel": "New Fast TN", "dyac": "DyAc 2", "buyTarget": 4200, "xianyuAnchor": 5680, "note": "600Hz旗舰X+"},
    {"code": "Z17", "model": "XQ2566X", "size": 24.1, "res": "2K", "hz": 360, "panel": "QHD Fast TN", "dyac": "DyAc 3", "buyTarget": 3300, "xianyuAnchor": 4580, "note": "新XQ系2K 360Hz DyAc 3"},
    {"code": "Z18", "model": "XQ2766X", "size": 27.0, "res": "2K", "hz": 360, "panel": "QHD Fast TN", "dyac": "DyAc 3", "buyTarget": 3500, "xianyuAnchor": 4850, "note": "27寸2K 360Hz DyAc 3"},
    {"code": "Z19", "model": "XL2731", "size": 27.0, "res": "1K", "hz": 144, "panel": "TN", "dyac": "无 DyAc", "buyTarget": 420, "xianyuAnchor": 690, "note": "27寸FHD 144Hz无DyAc"},
    {"code": "Z20", "model": "XL2731K", "size": 27.0, "res": "1K", "hz": 165, "panel": "TN", "dyac": "DyAc", "buyTarget": 580, "xianyuAnchor": 890, "note": "27寸165Hz K系小底座"},
    {"code": "Z21", "model": "XL2740", "size": 27.0, "res": "1K", "hz": 240, "panel": "TN", "dyac": "无 DyAc", "buyTarget": 680, "xianyuAnchor": 1080, "note": "27寸240Hz无DyAc"},
    {"code": "Z22", "model": "XL2746S", "size": 27.0, "res": "1K", "hz": 240, "panel": "Fast TN", "dyac": "DyAc+", "buyTarget": 1050, "xianyuAnchor": 1620, "note": "27寸240Hz DyAc+"},
    {"code": "Z23", "model": "XL2746K", "size": 27.0, "res": "1K", "hz": 240, "panel": "Fast TN", "dyac": "DyAc+", "buyTarget": 1220, "xianyuAnchor": 1850, "note": "27寸K系小底座DyAc+"},
    {"code": "Z24", "model": "XL2730", "size": 27.0, "res": "2K", "hz": 144, "panel": "TN", "dyac": "无 DyAc", "buyTarget": 520, "xianyuAnchor": 820, "note": "27寸2K 144Hz，勿混为1K的XL2731"},
]

# ------------------------------------------------------------------ 3. 手册 77 款官方图鉴（M01-M26, P01-P20, Z01-Z24, N01-N07）
HANDBOOK_53_NON_ZOWIE: list[dict[str, Any]] = [
    # M01-M26 常见 LCD 图鉴
    {"code": "M01", "brand": "AOC", "model": "24G2", "size": 23.8, "res": "1K", "hz": 144, "panel": "IPS", "buyTarget": 195, "formula": "150 × 1.3", "track": "volume_95", "note": "老款144Hz IPS，与24G2SP/24G4分开"},
    {"code": "M02", "brand": "AOC", "model": "24G2SP", "size": 23.8, "res": "1K", "hz": 165, "panel": "IPS", "buyTarget": 195, "formula": "150 × 1.3", "track": "volume_95", "note": "DP最高165Hz，HDMI最高144Hz"},
    {"code": "M03", "brand": "AOC", "model": "24G4", "size": 23.8, "res": "1K", "hz": 180, "panel": "Fast IPS", "buyTarget": 195, "formula": "150 × 1.3", "track": "volume_95", "note": "23.8寸180Hz走量主力款"},
    {"code": "M04", "brand": "AOC", "model": "24G4H", "size": 23.8, "res": "1K", "hz": 200, "panel": "Fast IPS", "buyTarget": 195, "formula": "150 × 1.3", "track": "volume_95", "note": "200Hz归180档，勿省略H后缀"},
    {"code": "M05", "brand": "AOC", "model": "25G3ZM", "size": 24.5, "res": "1K", "hz": 240, "panel": "VA", "buyTarget": 325, "formula": "250 × 1.3", "track": "volume_95", "note": "240Hz VA面板，勿当成IPS"},
    {"code": "M06", "brand": "AOC", "model": "Q27G4F", "size": 27.0, "res": "2K", "hz": 180, "panel": "Fast IPS", "buyTarget": 325, "formula": "250 × 1.3", "track": "volume_95", "note": "27寸2K 180Hz一线走量爆款"},
    {"code": "M07", "brand": "AOC", "model": "Q27G4ZR", "size": 27.0, "res": "2K", "hz": 260, "panel": "Fast IPS", "buyTarget": 520, "formula": "400 × 1.3", "track": "volume_95", "note": "OC 260Hz按超频归入2K 240档"},
    {"code": "M08", "brand": "KTC", "model": "H24T09P", "size": 23.8, "res": "1K", "hz": 165, "panel": "Fast IPS", "buyTarget": 150, "formula": "150 × 1.0", "track": "volume_95", "note": "二线1K 180档标准件"},
    {"code": "M09", "brand": "KTC", "model": "H27T22S", "size": 27.0, "res": "2K", "hz": 180, "panel": "Fast IPS", "buyTarget": 250, "formula": "250 × 1.0", "track": "volume_95", "note": "二线2K 180档代表机型"},
    {"code": "M10", "brand": "科睿", "model": "G2721P", "size": 27.0, "res": "2K", "hz": 200, "panel": "Fast IPS", "buyTarget": 250, "formula": "250 × 1.0", "track": "volume_95", "note": "最高200Hz归入2K 180档"},
    {"code": "M11", "brand": "泰坦军团", "model": "P2510S", "size": 24.5, "res": "2K", "hz": 240, "panel": "Fast IPS", "buyTarget": 400, "formula": "400 × 1.0", "track": "volume_95", "note": "24.5寸小钢炮2K 240Hz，不是1080P"},
    {"code": "M12", "brand": "小米", "model": "G27i", "size": 27.0, "res": "1K", "hz": 165, "panel": "Fast IPS", "buyTarget": 150, "formula": "150 × 1.0", "track": "volume_95", "note": "P27FBB-RGGL，与2026新版分开"},
    {"code": "M13", "brand": "小米", "model": "G Pro 27i", "size": 27.0, "res": "2K", "hz": 180, "panel": "Fast IPS MiniLED", "buyTarget": 250, "formula": "250 × 1.0", "track": "volume_95", "note": "1152分区MiniLED属LCD，不乘OLED系数"},
    {"code": "M14", "brand": "飞利浦", "model": "27M1N5500ZA/69", "size": 27.0, "res": "2K", "hz": 170, "panel": "Nano IPS", "buyTarget": 325, "formula": "250 × 1.3 (OC 170Hz按超频算)", "track": "volume_95", "note": "OC 170Hz按超频直归一线2K 180档"},
    {"code": "M15", "brand": "优派", "model": "XG2431", "size": 23.8, "res": "1K", "hz": 240, "panel": "Fast IPS", "buyTarget": 325, "formula": "250 × 1.3", "track": "volume_95", "note": "FHD 240Hz PureXP"},
    {"code": "M16", "brand": "华硕", "model": "TUF VG259QM", "size": 24.5, "res": "1K", "hz": 280, "panel": "Fast IPS", "buyTarget": 325, "formula": "250 × 1.3", "track": "volume_95", "note": "OC 280Hz按TUF一线1.3归1K 240档"},
    {"code": "M17", "brand": "华硕", "model": "TUF VG27AQ", "size": 27.0, "res": "2K", "hz": 165, "panel": "IPS", "buyTarget": 325, "formula": "250 × 1.3", "track": "volume_95", "note": "OC 165Hz归2K 180档；区分AQ1A"},
    {"code": "M18", "brand": "微星", "model": "G244F", "size": 23.8, "res": "1K", "hz": 170, "panel": "Rapid IPS", "buyTarget": 195, "formula": "150 × 1.3", "track": "volume_95", "note": "OC 170Hz归1K 180档；区分G244F E2"},
    {"code": "M19", "brand": "微星", "model": "MAG 255XF", "size": 24.5, "res": "1K", "hz": 300, "panel": "Rapid IPS", "buyTarget": None, "formula": "300Hz高刷按实爬算", "track": "highend_5", "note": "300Hz跨出四档，直接看闲鱼实爬价"},
    {"code": "M20", "brand": "技嘉", "model": "G24F 2", "size": 23.8, "res": "1K", "hz": 180, "panel": "SS IPS", "buyTarget": 195, "formula": "150 × 1.3", "track": "volume_95", "note": "OC 180Hz直算；区别于初代G24F"},
    {"code": "M21", "brand": "技嘉", "model": "M27Q X", "size": 27.0, "res": "2K", "hz": 240, "panel": "SS IPS", "buyTarget": 520, "formula": "400 × 1.3", "track": "volume_95", "note": "27寸2K 240Hz，核对Rev版本"},
    {"code": "M22", "brand": "宏碁", "model": "Nitro XV252Q F", "size": 24.5, "res": "1K", "hz": 390, "panel": "IPS", "buyTarget": None, "formula": "OC 390Hz高刷按实爬算", "track": "highend_5", "note": "F后缀OC 390Hz，按闲鱼实爬价算"},
    {"code": "M23", "brand": "外星人", "model": "AW2523HF", "size": 24.5, "res": "1K", "hz": 360, "panel": "Fast IPS", "buyTarget": None, "formula": "5%高端款按实爬算", "track": "highend_5", "note": "360Hz外星人，>1000元直接按实爬算"},
    {"code": "M24", "brand": "外星人", "model": "AW2524H", "size": 24.5, "res": "1K", "hz": 500, "panel": "Fast IPS", "buyTarget": None, "formula": "5%高端款按实爬算", "track": "highend_5", "note": "OC 500Hz高端竞技款，按实爬算"},
    {"code": "M25", "brand": "戴尔", "model": "S2721DGF", "size": 27.0, "res": "2K", "hz": 165, "panel": "Fast IPS", "buyTarget": 325, "formula": "250 × 1.3", "track": "volume_95", "note": "DP 165Hz一线2K 180档"},
    {"code": "M26", "brand": "微星", "model": "G274QPF", "size": 27.0, "res": "2K", "hz": 170, "panel": "Rapid IPS", "buyTarget": 325, "formula": "250 × 1.3", "track": "volume_95", "note": "OC 170Hz一线2K 180档；区分QD/E2"},
    # P01-P20 高端、OLED与特殊规格（5% 高端稀缺款，市面均 >1000 元，实战中直接按闲鱼实爬价算！）
    {"code": "P01", "brand": "LG", "model": "27GR95QE-B", "size": 26.5, "res": "2K", "hz": 240, "panel": "OLED", "buyTarget": 900, "formula": "5%高端OLED·按闲鱼实爬算（手册底线¥900）", "track": "highend_5", "note": "2K 240Hz OLED市面>1000元，按实爬算；区分27GS95QE"},
    {"code": "P02", "brand": "LG", "model": "27GX790A-B", "size": 26.5, "res": "2K", "hz": 480, "panel": "WOLED", "buyTarget": None, "formula": "5%高端款·直接按闲鱼实爬算", "track": "highend_5", "note": "QHD 480Hz WOLED稀缺旗舰"},
    {"code": "P03", "brand": "LG", "model": "32GS95UE-B", "size": 32.0, "res": "4K双模", "hz": 480, "panel": "OLED", "buyTarget": None, "formula": "5%高端双模·直接按闲鱼实爬算", "track": "highend_5", "note": "4K 240Hz / FHD 480Hz双模，勿写4K 480Hz"},
    {"code": "P04", "brand": "LG", "model": "27GP950-B", "size": 27.0, "res": "4K", "hz": 160, "panel": "Nano IPS", "buyTarget": None, "formula": "5%高端4K·直接按闲鱼实爬算", "track": "highend_5", "note": "OC 160Hz Nano IPS（非OLED）"},
    {"code": "P05", "brand": "LG", "model": "34GS95QE-B", "size": 34.0, "res": "带鱼2K", "hz": 240, "panel": "OLED", "buyTarget": None, "formula": "5%高端带鱼·直接按闲鱼实爬算", "track": "highend_5", "note": "21:9 3440×1440曲面OLED"},
    {"code": "P06", "brand": "三星", "model": "Odyssey OLED G6 G60SD", "size": 27.0, "res": "2K", "hz": 360, "panel": "QD-OLED", "buyTarget": None, "formula": "5%高端OLED·直接按闲鱼实爬算", "track": "highend_5", "note": "2K 360Hz OLED，核实G60SD铭牌"},
    {"code": "P07", "brand": "三星", "model": "Odyssey OLED G9 G95SC", "size": 49.0, "res": "超宽双2K", "hz": 240, "panel": "OLED", "buyTarget": None, "formula": "5%高端超宽·直接按闲鱼实爬算", "track": "highend_5", "note": "49寸5120×1440 OLED G9"},
    {"code": "P08", "brand": "三星", "model": "Odyssey Neo G9 G95NC", "size": 57.0, "res": "超宽双4K", "hz": 240, "panel": "VA MiniLED", "buyTarget": None, "formula": "5%高端超宽·直接按闲鱼实爬算", "track": "highend_5", "note": "57寸MiniLED背光LCD，非OLED"},
    {"code": "P09", "brand": "ROG", "model": "PG27AQDP", "size": 26.5, "res": "2K", "hz": 480, "panel": "WOLED", "buyTarget": None, "formula": "5%高端旗舰·直接按闲鱼实爬算", "track": "highend_5", "note": "ROG 2K 480Hz，勿与AQDM/AQWP混收"},
    {"code": "P10", "brand": "ROG", "model": "PG27AQWP-W", "size": 26.5, "res": "2K双模", "hz": 720, "panel": "Tandem WOLED", "buyTarget": None, "formula": "5%高端双模·直接按闲鱼实爬算", "track": "highend_5", "note": "2K 540Hz / HD(720p) 720Hz双模"},
    {"code": "P11", "brand": "ROG", "model": "XG27UCG", "size": 27.0, "res": "4K双模", "hz": 320, "panel": "Fast IPS", "buyTarget": None, "formula": "5%高端双模·直接按闲鱼实爬算", "track": "highend_5", "note": "4K 160Hz / FHD 320Hz双模IPS"},
    {"code": "P12", "brand": "ROG", "model": "PG248QP", "size": 24.1, "res": "1K", "hz": 540, "panel": "E-TN", "buyTarget": None, "formula": "5%高端旗舰·直接按闲鱼实爬算", "track": "highend_5", "note": "OC 540Hz E-TN竞技旗舰"},
    {"code": "P13", "brand": "ROG", "model": "XG248QSG Ace", "size": 24.1, "res": "1K", "hz": 610, "panel": "Super TN", "buyTarget": None, "formula": "5%高端旗舰·直接按闲鱼实爬算", "track": "highend_5", "note": "OC 610Hz Super TN"},
    {"code": "P14", "brand": "ROG", "model": "PG27UCDM", "size": 26.5, "res": "4K", "hz": 240, "panel": "QD-OLED", "buyTarget": None, "formula": "5%高端旗舰·直接按闲鱼实爬算", "track": "highend_5", "note": "4K 240Hz QD-OLED DP2.1a"},
    {"code": "P15", "brand": "ROG", "model": "XG27AQDPG", "size": 26.5, "res": "2K", "hz": 500, "panel": "QD-OLED", "buyTarget": None, "formula": "5%高端旗舰·直接按闲鱼实爬算", "track": "highend_5", "note": "QHD 500Hz QD-OLED"},
    {"code": "P16", "brand": "微星", "model": "MPG 271QRX QD-OLED", "size": 26.5, "res": "2K", "hz": 360, "panel": "QD-OLED", "buyTarget": None, "formula": "5%高端OLED·直接按闲鱼实爬算", "track": "highend_5", "note": "2K 360Hz QD-OLED"},
    {"code": "P17", "brand": "AOC", "model": "AG276QZD2", "size": 26.5, "res": "2K", "hz": 240, "panel": "QD-OLED", "buyTarget": 780, "formula": "5%高端OLED·按闲鱼实爬算（手册底线¥780）", "track": "highend_5", "note": "QD-OLED市面>1000元直接按实爬算；区分QZD"},
    {"code": "P18", "brand": "技嘉", "model": "AORUS FO32U2P", "size": 31.5, "res": "4K", "hz": 240, "panel": "QD-OLED", "buyTarget": None, "formula": "5%高端OLED·直接按闲鱼实爬算", "track": "highend_5", "note": "32寸4K 240Hz，注意P后缀"},
    {"code": "P19", "brand": "外星人", "model": "AW3423DWF", "size": 34.2, "res": "带鱼2K", "hz": 165, "panel": "QD-OLED", "buyTarget": None, "formula": "5%高端带鱼·直接按闲鱼实爬算", "track": "highend_5", "note": "FreeSync 165Hz，勿混写DW 175Hz"},
    {"code": "P20", "brand": "外星人", "model": "AW3423DW", "size": 34.2, "res": "带鱼2K", "hz": 175, "panel": "QD-OLED", "buyTarget": None, "formula": "5%高端带鱼·直接按闲鱼实爬算", "track": "highend_5", "note": "G-SYNC Ultimate 175Hz QD-OLED"},
    # N01-N07 新规格观察（1000Hz与多模）
    {"code": "N01", "brand": "宏碁", "model": "Predator XB253Q U1", "size": 24.5, "res": "1K", "hz": 1000, "panel": "IPS", "buyTarget": None, "formula": "新品观察·按实爬/单议", "track": "highend_5", "note": "1000Hz待上市观察款"},
    {"code": "N02", "brand": "宏碁", "model": "Nitro XV275U Z2", "size": 27.0, "res": "2K多模", "hz": 520, "panel": "IPS MiniLED", "buyTarget": None, "formula": "新品多模·按实爬/单议", "track": "highend_5", "note": "QHD 275 / FHD 360 / HD 520Hz"},
    {"code": "N03", "brand": "三星", "model": "Odyssey G6 G60H", "size": 27.0, "res": "2K双模", "hz": 1040, "panel": "IPS", "buyTarget": None, "formula": "新品双模·按实爬/单议", "track": "highend_5", "note": "QHD 600Hz / HD 1040Hz"},
    {"code": "N04", "brand": "三星", "model": "Odyssey G8 G80HS", "size": 32.0, "res": "6K双模", "hz": 330, "panel": "IPS", "buyTarget": None, "formula": "新品6K·按实爬/单议", "track": "highend_5", "note": "6K 165Hz / 3K 330Hz"},
    {"code": "N05", "brand": "三星", "model": "Odyssey G8 G80HF", "size": 27.0, "res": "5K双模", "hz": 360, "panel": "IPS", "buyTarget": None, "formula": "新品5K·按实爬/单议", "track": "highend_5", "note": "5K 180Hz / QHD 360Hz"},
    {"code": "N06", "brand": "宏碁", "model": "Predator XB273K V7", "size": 27.0, "res": "4K双模", "hz": 500, "panel": "IPS", "buyTarget": None, "formula": "新品双模·按实爬/单议", "track": "highend_5", "note": "4K 160Hz / FHD 500Hz"},
    {"code": "N07", "brand": "LG", "model": "25G590B-B", "size": 24.5, "res": "1K", "hz": 1100, "panel": "IPS", "buyTarget": None, "formula": "OC 1100Hz新品·按实爬/单议", "track": "highend_5", "note": "1000Hz原生 / 1100Hz OC"},
]

# ------------------------------------------------------------------ 4. 全部 6 大品类规格坑位预留表（选品前置台）
DEFAULT_CATEGORY_SLOTS: list[dict[str, Any]] = [
    {
        "id": "monitor",
        "name": "电竞与办公显示器",
        "status": "active_full",
        "statusLabel": "已全量落地（手册77款 + 8,044型号库）",
        "modelScale": "8,044 ~ 10,000+ 个具体型号",
        "verticalSources": ["屏库网 Panelook", "中关村在线 ZOL", "太平洋产品库", "厂商官方规格页"],
        "specFields": ["品牌倍率档 (1.5 / 1.3 / 1.0 / 0.5)", "分辨率 (1K / 2K / 4K / 带鱼 / 双模)", "最高刷新率（直接按超频 OC 算）", "面板类型（真OLED vs 普通LCD/MiniLED）"],
        "splitRule": "95% 千元内走量款套「规格兜底 + 假价防呆」；5% 千元上高端稀缺款（OLED/ROG旗舰/双模）不套公式直接按闲鱼实爬算；唯独卓威 ZOWIE 走独立价格表。",
        "sanityExample": "2K 240Hz 走量屏收货底价 ¥400~520，闲鱼若错爬成 ¥200（坏屏/支架/75Hz老款），系统+模型反推当场标红拦截。",
        "galleryViews": ["品牌 + 规格（默认）", "95%走量 vs 5%高端 vs 卓威", "规格档位矩阵", "面板类型", "价格清洗状态"],
    },
    {
        "id": "apple_mobile",
        "name": "手机 / 平板 / 笔记本 / Apple 全系",
        "status": "reserved_ready",
        "statusLabel": "规格坑位已预留（选品可直接配）",
        "modelScale": "3,000 ~ 12,000 个细分配置 SKU",
        "verticalSources": ["EveryMac", "GSMArena", "爱回收 29,583 机型目录", "京东产品参数库"],
        "specFields": ["机型代际 & 芯片（M1~M4 / A15~A18 / 骁龙）", "运行内存（8G / 16G / 24G / 32G）", "存储容量（128G / 256G / 512G / 1TB）", "地区与锁态（国行 / 港版 / 美版卡贴有锁）"],
        "splitRule": "国行标准走量容量按「同代芯片基准 + 内存/硬盘阶梯差价」兜底与防呆；顶配定制机（如 64G+4TB）直接按闲鱼实爬算；外版有锁机强制隔离防混洗。",
        "sanityExample": "MacBook Air M3 16G+512G 若误把美版监管锁/坏屏机 ¥2,100 爬进国行池，按芯片+容量底线自动标红拦截。",
        "galleryViews": ["品牌 + 芯片容量（默认）", "国行走量 vs 顶配定制", "存储容量阶梯", "价格状态"],
    },
    {
        "id": "pc_diy",
        "name": "电脑 DIY 硬件（显卡 / CPU / 内存 / 固态）",
        "status": "reserved_ready",
        "statusLabel": "规格坑位已预留（复刻显示器倍率法）",
        "modelScale": "4,000 ~ 8,000 个板卡/颗粒型号",
        "verticalSources": ["TechPowerUp GPU/CPU DB", "中关村硬件库", "京东自营板卡目录"],
        "specFields": ["核心芯片组（如 RTX 4060 / 4060Ti / i5-14600K）", "AIC/厂商梯队（旗舰猛禽超龙 ×1.12 / 御三家 ×1.05 / 二线丐版 ×1.00）", "显存/容量与代际（8G·16G / DDR4·DDR5 / 1T·2T）", "盒装散片 / 矿卡高危标记"],
        "splitRule": "90% 甜点走量型号（60/70系显卡、i5/R5 CPU、常规固态）套「芯片组基准价 × 品牌档」兜底与防呆；80/90级旗舰显卡直接按闲鱼实爬算。",
        "sanityExample": "RTX 4060Ti 8G 若闲鱼爬出 ¥650（实为拆芯空散热器壳或故障卡），低于芯片组防呆底线立即拦截。",
        "galleryViews": ["品牌 + 芯片组（默认）", "甜点走量 vs 旗舰卡", "显存/容量档", "价格状态"],
    },
    {
        "id": "camera_wearable",
        "name": "数码影像与穿戴（相机 / 镜头 / 佳明手表）",
        "status": "reserved_ready",
        "statusLabel": "规格坑位已预留（轻量两级细分）",
        "modelScale": "1,500 ~ 5,000 个机身/镜头/表款",
        "verticalSources": ["DPReview 器材库", "索尼/佳能/富士卡口目录", "Garmin 佳明全系表库"],
        "specFields": ["机身代际 / 套机或单机身", "镜头卡口（E / RF / Z / XF）+ 焦段恒定光圈", "手表尺寸（42 / 47 / 51mm）+ 太阳能/蓝宝石版"],
        "splitRule": "常规走量机身/入门定焦头用同卡口规格桶防呆（严防单机身混入套机或遮光罩配件价）；大三元/GM大师头稀缺款直接按实爬算。",
        "sanityExample": "索尼 A7M4 单机身若误爬手柄/电池租赁 ¥300 或把 28-70 套机当单机身算，自动触发防呆。",
        "galleryViews": ["品牌 + 卡口/尺寸（默认）", "机身 vs 镜头", "价格状态"],
    },
    {
        "id": "peripherals",
        "name": "电竞外设（磁轴键盘 / 游戏耳机 / 旗舰鼠标）",
        "status": "reserved_ready",
        "statusLabel": "规格坑位已预留（模组+轴体分档）",
        "modelScale": "1,000 ~ 3,000 个外设型号",
        "verticalSources": ["RTINGS 外设库", "外设天梯榜", "天猫/京东外设目录"],
        "specFields": ["连接方式（有线 / 2.4G无线三模 / 8K接收器）", "核心轴体/传感器（磁轴 / 3395 / 3950）", "配列尺寸（60% / 75% / 98%）"],
        "splitRule": "百元~千元内国产磁轴/无线鼠套同模组走量兜底；Wooting 原厂、Finalmouse 限量等高保值款独立拎出按实爬算。",
        "sanityExample": "三模旗舰鼠标若爬出 ¥49（实为单卖脚贴/接收器/防滑贴），按三模底线直接过滤。",
        "galleryViews": ["品牌 + 模组轴体（默认）", "走量外设 vs 独立保值款", "价格状态"],
    },
    {
        "id": "simple_flat",
        "name": "简单标品（扫拖机器人 / 净化器 / 吹风机 / 脱毛仪 / 音响）",
        "status": "simple_keep",
        "statusLabel": "保持极简（不拆复杂规格树）",
        "modelScale": "每类仅 10 ~ 50 个主力型号",
        "verticalSources": ["品牌官网在售表", "闲鱼热销榜", "在库历史 SPU 表"],
        "specFields": ["仅「品牌 → 型号」（顶多区分上下水版/普通版）"],
        "splitRule": "总共就十几个型号，完全不用搞复杂面板/刷新率兜底！直接按「品牌+型号」爬闲鱼快照 + 过滤耗材（滤芯/风嘴/尘袋/底座）即可。",
        "sanityExample": "戴森 HT01 / 云鲸 J4 直接通过屏蔽词剔除风嘴、清洁液、基站配件与 <100 元引流价。",
        "galleryViews": ["品牌 → 型号（极简平铺）"],
    },
]

# 运行态可变状态（支持前端实时调参、拍板保存）
_STATE: dict[str, Any] = {
    "monitorRules": copy.deepcopy(DEFAULT_MONITOR_RULES),
    "zowieTable": copy.deepcopy(DEFAULT_ZOWIE_PRICE_TABLE),
    "categorySlots": copy.deepcopy(DEFAULT_CATEGORY_SLOTS),
    "decisionLogs": [
        {
            "id": "DEC-INIT-01",
            "at": "2026-11-18 17:50",
            "actor": "老板定稿",
            "action": "确立 95% 千元内走量款套规格兜底与防呆、5% 千元上高端款直接按实爬算、卓威 ZOWIE 独立价格表；刷新率一律按超频最高值归档。",
        }
    ],
}

# 确定性型号前缀 → 品牌识别规则（只认 100% 无歧义的厂商专属前缀，有歧义绝不乱猜！）
_DETERMINISTIC_MODEL_PREFIXES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^(XL\d{4}|XQ\d{4})", re.I), "卓威 ZOWIE"),
    (re.compile(r"^(ROG\b|PG\d{2,3}[A-Z]|XG\d{2,3}[A-Z]{2,})", re.I), "ROG"),
    (re.compile(r"^(TUF\b|VG\d{3}[A-Z]|PA\d{3}[A-Z]|VA\d{3}[A-Z]|VP\d{3}[A-Z]|VZ\d{3}[A-Z])", re.I), "华硕"),
    (re.compile(r"^(AGP?\d{3}[A-Z]|Q2[47]G\d|2[457]G\d|U2[78]G\d|CU34G|CQ27G|CQ32G|2[247]B\d|Q27P\d|U27P\d|I2[2347]\d{2})", re.I), "AOC"),
    (re.compile(r"^(2[47]M[12]N|32M[12]N|2[47]E[12]N|27[125689]E|24[1236]E|BDM\d)", re.I), "飞利浦"),
    (re.compile(r"^(27GP\d|27GR\d|27GS\d|27GN\d|27GL\d|27GX\d|27UL\d|27UP\d|27UQ\d|32GP\d|32GQ\d|32GR\d|32GS\d|32UN\d|32UP\d|34GP\d|34GN\d|34GS\d|34WN\d|34WP\d|34WQ\d|24GN\d|25G590)", re.I), "LG"),
    (re.compile(r"^(MAG\s?\d{3}|MPG\s?\d{3}|OPTIX\b|G2[457][1234][A-Z]|MD2[47]\d)", re.I), "微星"),
    (re.compile(r"^(XV2[4578]\d|XB2[578]\d|KG2[4578]\d|CB2[478]\d|ED2[47]\d|NITRO\b|PREDATOR\b)", re.I), "宏碁"),
    (re.compile(r"^(AW2[57]\d{2}|AW3[248]\d{2})", re.I), "外星人"),
    (re.compile(r"^(S2[47]2[125]\d?[A-Z]|U2[457]2[01234][A-Z]|P2[2347]2[1234][A-Z]|E2[247]2[01234][A-Z])", re.I), "戴尔"),
    (re.compile(r"^(VX2[4578]\d{2}|VX32\d{2}|XG2431|VA2[247]\d{2}-)", re.I), "优派"),
    (re.compile(r"^(M2[78]Q|M32Q|M32U|G24F|G27F|G27Q|G27FC|G27QC|G32QC|GS27Q|GS32Q|FO27Q|FO32U|FI27Q|FI32U|AORUS\b)", re.I), "技嘉"),
    (re.compile(r"^(ODYSSEY\b|LS2[47]\d|LC2[47]\d|C2[47]F39|C32F39|C27G[57]|C32G[57]|S27DG|S32BG)", re.I), "三星"),
    (re.compile(r"^(H2[47]T\d{2}|M27T\d{2}|M27P\d|G27P6)", re.I), "KTC"),
    (re.compile(r"^(IG27|SG27|MG2[457]|VG2[47]\d|TG27|CG27|T2[47]\d)", re.I), "HKC"),
    (re.compile(r"^(P2[457][15A-Z]\d|P32A\d|C32C\d)", re.I), "泰坦军团"),
    (re.compile(r"^(XUB2[47]|GB2[4578]|G2730HSU)", re.I), "iiyama"),
    (re.compile(r"^(ANT\d{3})", re.I), "蚂蚁电竞"),
    (re.compile(r"^(EX2[457]\d{2}|PD2[57]\d{2}|GW2[47]\d{2}|EW2[478]\d{2}|MOBIUZ\b)", re.I), "明基"),
]

_KNOWN_BRAND_PREFIXES: tuple[str, ...] = (
    "卓威 ZOWIE", "卓威", "ZOWIE", "泰坦军团", "机械军团", "联合创新", "蚂蚁电竞", "外星人", "Alienware",
    "哈曼卡顿", "西部数据", "HyperX", "Wooting", "SONOS", "Ulike", "Intel",
    "ROG", "玩家国度", "HKC", "AOC", "AGON", "KTC", "LG", "云鲸", "优派", "佳明", "创维",
    "华硕", "ASUS", "TUF", "宏碁", "Acer", "小米", "Redmi", "微星", "MSI", "技嘉", "GIGABYTE", "AORUS",
    "戴森", "熊猫", "盛色", "SANC", "科睿", "KOORUI", "联想", "苹果", "Apple", "金士顿", "雷神",
    "飞利浦", "Philips", "三星", "Samsung", "戴尔", "Dell", "惠普", "HP", "明基", "BenQ", "iiyama",
)

_FMT1_RE = re.compile(r"(\d+(?:\.\d+)?)英寸\s*/\s*(\d+)\s*[x×]\s*(\d+)\s*/\s*(\d+)\s*Hz\s*/?\s*([^/]+)?", re.I)
_FMT2_SIZE_RE = re.compile(r"尺寸\s*[:：]\s*(\d+(?:\.\d+)?)\s*英寸", re.I)
_FMT2_RES_RE = re.compile(r"分辨率\s*[:：]\s*(\d+)\s*[x×]\s*(\d+)", re.I)
_FMT2_HZ_RE = re.compile(r"刷新率\s*[:：]\s*(\d+)\s*Hz", re.I)
_FMT2_PANEL_RE = re.compile(r"面板类型\s*[:：]\s*([^/\s]+)", re.I)

# 在库常见热销型号规格补充字典（针对 catalog-snapshot 里备注为「按在库 SPU 自动同步」的在库型号）
_INSTOCK_MONITOR_SPECS: dict[str, dict[str, Any]] = {
    "Q27G3XMN": {"brand": "AOC", "size": 27.0, "res": "2K", "hz": 180, "panel": "VA MiniLED"},
    "P24H3GC": {"brand": "泰坦军团", "size": 23.8, "res": "1K", "hz": 180, "panel": "Fast IPS"},
    "27GR95GE": {"brand": "LG", "size": 26.5, "res": "2K", "hz": 240, "panel": "OLED"},
    "PG248QP": {"brand": "ROG", "size": 24.1, "res": "1K", "hz": 540, "panel": "E-TN"},
    "24G15N": {"brand": "AOC", "size": 23.8, "res": "1K", "hz": 180, "panel": "VA"},
    "G24H1": {"brand": "HKC", "size": 23.8, "res": "1K", "hz": 200, "panel": "Fast IPS"},
    "C32C1S": {"brand": "泰坦军团", "size": 31.5, "res": "2K", "hz": 240, "panel": "VA"},
    "MG27H3Q1": {"brand": "HKC", "size": 27.0, "res": "2K", "hz": 180, "panel": "Fast IPS"},
    "MAG245FX24": {"brand": "微星", "size": 23.8, "res": "1K", "hz": 240, "panel": "Rapid IPS"},
    "VX2563HDPRO": {"brand": "优派", "size": 24.5, "res": "1K", "hz": 300, "panel": "Fast IPS"},
    "27M2N5510P": {"brand": "飞利浦", "size": 27.0, "res": "2K", "hz": 180, "panel": "Fast IPS"},
    "27M2N5511P": {"brand": "飞利浦", "size": 27.0, "res": "2K", "hz": 180, "panel": "Fast IPS"},
    "25M2N3200": {"brand": "飞利浦", "size": 24.5, "res": "1K", "hz": 180, "panel": "Fast IPS"},
    "X71Q27": {"brand": "科睿", "size": 27.0, "res": "2K", "hz": 180, "panel": "Fast IPS"},
    "X71QH": {"brand": "科睿", "size": 27.0, "res": "2K", "hz": 240, "panel": "Fast IPS"},
    "VG25BQM": {"brand": "华硕", "size": 24.5, "res": "1K", "hz": 280, "panel": "Fast IPS"},
    "VG258QM": {"brand": "华硕", "size": 24.5, "res": "1K", "hz": 280, "panel": "TN"},
    "XG259CMS": {"brand": "ROG", "size": 24.5, "res": "1K", "hz": 310, "panel": "Fast IPS"},
    "27GS820": {"brand": "KTC", "size": 27.0, "res": "2K", "hz": 180, "panel": "Fast IPS"},
    "H27T22S3": {"brand": "KTC", "size": 27.0, "res": "2K", "hz": 180, "panel": "Fast IPS"},
    "24G10ZNE": {"brand": "AOC", "size": 23.8, "res": "1K", "hz": 240, "panel": "Fast VA"},
    "PF25FA9": {"brand": "熊猫", "size": 24.5, "res": "1K", "hz": 180, "panel": "Fast IPS"},
    "VX3276-4K-MHD": {"brand": "优派", "size": 31.5, "res": "4K", "hz": 60, "panel": "VA"},
    "P2510G24.5": {"brand": "泰坦军团", "size": 24.5, "res": "1K", "hz": 180, "panel": "Fast IPS"},
    "P2710S": {"brand": "泰坦军团", "size": 27.0, "res": "2K", "hz": 240, "panel": "Fast IPS"},
    "P27W2V": {"brand": "泰坦军团", "size": 27.0, "res": "4K", "hz": 160, "panel": "Fast IPS"},
    "MG25H3F": {"brand": "HKC", "size": 24.5, "res": "1K", "hz": 240, "panel": "Fast IPS"},
    "VG243": {"brand": "HKC", "size": 23.8, "res": "1K", "hz": 165, "panel": "VA"},
    "EG270U": {"brand": "宏碁", "size": 27.0, "res": "2K", "hz": 165, "panel": "IPS"},
    "MZQ27F240": {"brand": "机械军团", "size": 27.0, "res": "2K", "hz": 240, "panel": "Fast IPS"},
    "G7PROMAX": {"brand": "盛色", "size": 27.0, "res": "2K", "hz": 240, "panel": "Fast IPS"},
    "F24G30F": {"brand": "创维", "size": 23.8, "res": "1K", "hz": 180, "panel": "Fast IPS"},
    "D75V": {"brand": "盛色", "size": 27.0, "res": "2K", "hz": 75, "panel": "IPS"},
}


def _norm_key(s: str) -> str:
    return re.sub(r"[\s\-_/·()（）【】\[\]]+", "", str(s or "")).upper()


def get_all_handbook_models() -> list[dict[str, Any]]:
    zowie_cards = [
        {
            "code": z["code"],
            "brand": "卓威 ZOWIE",
            "model": z["model"],
            "size": z["size"],
            "res": z["res"],
            "hz": z["hz"],
            "panel": z["panel"],
            "dyac": z["dyac"],
            "buyTarget": z["buyTarget"],
            "xianyuAnchor": z["xianyuAnchor"],
            "formula": f"卓威独立表（DyAc: {z['dyac']}）",
            "track": "zowie_independent",
            "note": z["note"],
        }
        for z in _STATE["zowieTable"]
    ]
    return HANDBOOK_53_NON_ZOWIE + zowie_cards


def infer_brand_and_model(raw_name: str, explicit_brand: str = "") -> tuple[str, str]:
    name = str(raw_name or "").strip()
    if explicit_brand:
        eb = explicit_brand.strip()
        if name.upper().startswith(eb.upper()):
            return eb, name[len(eb):].strip() or name
        return eb, name
    for b in _KNOWN_BRAND_PREFIXES:
        if name.upper().startswith(b.upper()):
            rest = name[len(b):].strip() or name
            # 区分华硕 ROG / TUF / 卓威
            if b.upper() in ("华硕", "ASUS") and re.match(r"^(ROG\b|PG\d|XG\d{2,3}[A-Z]{2,})", rest, re.I):
                return "ROG", rest
            if b.upper() in ("明基", "BENQ") and re.match(r"^(XL\d|XQ\d|ZOWIE)", rest, re.I):
                return "卓威 ZOWIE", rest
            if b.upper() in ("ZOWIE", "卓威"):
                return "卓威 ZOWIE", rest
            if b.upper() == "玩家国度":
                return "ROG", rest
            return b, rest
    for pat, brand in _DETERMINISTIC_MODEL_PREFIXES:
        if pat.search(name):
            return brand, name
    return "", name


def parse_monitor_spec(raw_name: str, note: str = "", explicit_brand: str = "") -> dict[str, Any] | None:
    brand, model = infer_brand_and_model(raw_name, explicit_brand)
    nk = _norm_key(model)

    # 1) 命中手册 77 款精校字典（先全表精确匹配，再按型号长度降序防短后缀吞长后缀，如 XL2546 不吞 XL2546K/X+！）
    hb_all = get_all_handbook_models()
    hm_exact = next((hm for hm in hb_all if _norm_key(hm["model"]) == nk), None)
    if not hm_exact:
        for hm in sorted(hb_all, key=lambda x: len(_norm_key(x["model"])), reverse=True):
            mk_norm = _norm_key(hm["model"])
            if len(mk_norm) >= 6 and nk.endswith(mk_norm):
                hm_exact = hm
                break
    if hm_exact:
        hm = hm_exact
        return {
            "brand": hm["brand"] or brand,
            "model": hm["model"],
            "size": float(hm["size"]),
            "res": hm["res"],
            "hz": int(hm["hz"]),
            "panel": hm["panel"],
            "dyac": hm.get("dyac", ""),
            "handbookCode": hm["code"],
            "handbookNote": hm["note"],
        }

    # 2) 命中在库热销补充字典（同样先精确匹配，再按长度降序）
    if nk in {_norm_key(k) for k in _INSTOCK_MONITOR_SPECS}:
        sp = next(v for k, v in _INSTOCK_MONITOR_SPECS.items() if _norm_key(k) == nk)
        return {
            "brand": brand or sp["brand"],
            "model": model,
            "size": float(sp["size"]),
            "res": sp["res"],
            "hz": int(sp["hz"]),
            "panel": sp["panel"],
            "dyac": "",
            "handbookCode": "",
            "handbookNote": "",
        }
    for mk_code, sp in sorted(_INSTOCK_MONITOR_SPECS.items(), key=lambda kv: len(kv[0]), reverse=True):
        if len(_norm_key(mk_code)) >= 6 and nk.endswith(_norm_key(mk_code)):
            return {
                "brand": brand or sp["brand"],
                "model": model,
                "size": float(sp["size"]),
                "res": sp["res"],
                "hz": int(sp["hz"]),
                "panel": sp["panel"],
                "dyac": "",
                "handbookCode": "",
                "handbookNote": "",
            }

    # 3) 解析 catalog-snapshot 格式 1：「27英寸 / 2560x1440 / 180Hz / IPS」
    s = str(note or "")
    m1 = _FMT1_RE.search(s)
    if m1:
        size = float(m1.group(1))
        w, h = int(m1.group(2)), int(m1.group(3))
        hz = int(m1.group(4))
        panel = (m1.group(5) or "IPS").strip()
        return {
            "brand": brand,
            "model": model,
            "size": size,
            "res": _classify_res_pixels(w, h),
            "hz": hz,
            "panel": panel,
            "dyac": "",
            "handbookCode": "",
            "handbookNote": "",
        }

    # 4) 解析 catalog-snapshot 格式 2：「尺寸:31.5英寸 / ... / 面板类型:VA / ... / 分辨率:2560×1440 / ... / 刷新率:144Hz」
    ms = _FMT2_SIZE_RE.search(s)
    mr = _FMT2_RES_RE.search(s)
    mh = _FMT2_HZ_RE.search(s)
    if ms and mr and mh:
        mp = _FMT2_PANEL_RE.search(s)
        return {
            "brand": brand,
            "model": model,
            "size": float(ms.group(1)),
            "res": _classify_res_pixels(int(mr.group(1)), int(mr.group(2))),
            "hz": int(mh.group(1)),
            "panel": (mp.group(1).strip() if mp else "IPS"),
            "dyac": "",
            "handbookCode": "",
            "handbookNote": "",
        }

    # 5) 自由文本提取（如业务员在清洗台或配置字段里写「27寸 2K 240Hz IPS」）
    combo = f"{raw_name} {note}".upper()
    hz_m = re.search(r"(\d{2,4})\s*HZ", combo)
    if hz_m or any(k in combo for k in ("2K", "4K", "1080P", "OLED", "显示器", "寸")):
        res = "4K" if "4K" in combo or "3840" in combo else "带鱼2K" if "3440" in combo else "2K" if "2K" in combo or "2560" in combo or "QHD" in combo else "1K"
        hz = int(hz_m.group(1)) if hz_m else (240 if "240" in combo else 180 if "180" in combo else 144 if "144" in combo else 165)
        sz_m = re.search(r"(\d{2}(?:\.\d)?)\s*(?:寸|英寸)", combo)
        size = float(sz_m.group(1)) if sz_m else 27.0
        panel = "QD-OLED" if "QD-OLED" in combo else "WOLED" if "WOLED" in combo else "OLED" if "OLED" in combo else "MiniLED" if "MINI" in combo else "TN" if re.search(r"\bTN\b", combo) else "VA" if re.search(r"\bVA\b", combo) else "Fast IPS"
        return {
            "brand": brand,
            "model": model,
            "size": size,
            "res": res,
            "hz": hz,
            "panel": panel,
            "dyac": "",
            "handbookCode": "",
            "handbookNote": "",
        }

    return None


def _classify_res_pixels(w: int, h: int) -> str:
    if w >= 5120 and h >= 2880:
        return "5K/6K"
    if w >= 5120 and h <= 2160:
        return "超宽双2K/4K"
    if w >= 3440 and h < 2000:
        return "带鱼2K"
    if w >= 2560 and h <= 1080:
        return "带鱼1K"
    if w >= 3840:
        return "4K"
    if w >= 2560:
        return "2K"
    return "1K"


def is_true_oled(panel: str) -> bool:
    u = str(panel or "").upper()
    if "MINI" in u or "QLED" in u:
        return False
    return "OLED" in u


def resolve_brand_tier(brand: str, model: str = "") -> tuple[str, str, float]:
    """返回 (tier_key, tier_label, multiplier)。卓威单独返回 zowie。"""
    b = str(brand or "").strip()
    m = str(model or "").strip().upper()
    if "卓威" in b or "ZOWIE" in b.upper() or re.match(r"^(XL\d{4}|XQ\d{4})", m):
        return "zowie", "卓威 ZOWIE 独立体系", 1.0
    if "ROG" in b.upper() or "玩家国度" in b or re.match(r"^(PG\d{2,3}|XG\d{2,3}[A-Z]{2,}|ROG\b)", m):
        mult = float(_STATE["monitorRules"]["brandTiers"]["super_tier1"]["multiplier"])
        return "super_tier1", "超一线 (×1.50)", mult

    rules = _STATE["monitorRules"]["brandTiers"]
    for tkey in ("super_tier1", "tier1", "tier2", "generic"):
        grp = rules[tkey]
        for cand in grp["brands"]:
            if b and (b.upper() == cand.upper() or cand.upper() in b.upper()):
                return tkey, f"{grp['label']} (×{grp['multiplier']:.2f})", float(grp["multiplier"])
    # 缺品牌或未收录正规品牌默认按 1.00 基准预估，不乱打五折
    return "tier2", "基准档/待核品牌 (×1.00)", float(rules["tier2"]["multiplier"])


def _round_half(val: float) -> float:
    return round(val * 2.0) / 2.0


# 预计算的各走量规格桶真实闲鱼锚点价（从 catalog-snapshot 实爬样本与在库实盘初始化，随规则联动）
_BUCKET_CRAWLED_MEDIANS: dict[str, dict[str, Any]] = {
    "tier2:office_1k": {"sampleCount": 14, "crawledMedian": 215.0},
    "tier1:office_1k": {"sampleCount": 19, "crawledMedian": 268.0},
    "tier2:office_2k": {"sampleCount": 11, "crawledMedian": 355.0},
    "tier1:office_2k": {"sampleCount": 15, "crawledMedian": 438.0},
    "tier2:office_4k": {"sampleCount": 13, "crawledMedian": 585.0},
    "tier1:office_4k": {"sampleCount": 16, "crawledMedian": 735.0},
    "super_tier1:office_4k": {"sampleCount": 7, "crawledMedian": 880.0},
    "tier2:1k_180": {"sampleCount": 26, "crawledMedian": 328.0},
    "tier1:1k_180": {"sampleCount": 31, "crawledMedian": 395.0},
    "super_tier1:1k_180": {"sampleCount": 8, "crawledMedian": 465.0},
    "tier2:2k_180": {"sampleCount": 29, "crawledMedian": 518.0},
    "tier1:2k_180": {"sampleCount": 34, "crawledMedian": 685.0},
    "super_tier1:2k_180": {"sampleCount": 9, "crawledMedian": 790.0},
    "tier2:1k_240": {"sampleCount": 18, "crawledMedian": 435.0},
    "tier1:1k_240": {"sampleCount": 22, "crawledMedian": 565.0},
    "super_tier1:1k_240": {"sampleCount": 7, "crawledMedian": 660.0},
    "tier2:2k_240": {"sampleCount": 21, "crawledMedian": 688.0},
    "tier1:2k_240": {"sampleCount": 24, "crawledMedian": 865.0},
    "super_tier1:2k_240": {"sampleCount": 6, "crawledMedian": 980.0},
}


def evaluate_monitor_pricing(
    raw_name: str,
    note: str = "",
    crawled_price: float | None = None,
    explicit_brand: str = "",
) -> dict[str, Any]:
    """核心统一评估函数：输出分流轨道（95%走量 / 5%高端 / 卓威独立）、手册基准价、实爬防呆结论与无样本兜底价。"""
    rules = _STATE["monitorRules"]
    th = rules["sanityThresholds"]
    spec = parse_monitor_spec(raw_name, note, explicit_brand)
    if not spec:
        return {
            "supported": False,
            "track": "non_monitor",
            "trackLabel": "普通标品（按品牌+型号直爬）",
            "sanityStatus": "normal" if crawled_price else "uncrawled",
            "effectivePrice": round(crawled_price) if crawled_price else None,
        }

    brand = spec["brand"]
    model = spec["model"]
    res = spec["res"]
    hz = int(spec["hz"])  # 严格按超频最高刷新率归档！
    panel = spec["panel"]
    oled = is_true_oled(panel)
    tier_key, tier_label, brand_mult = resolve_brand_tier(brand, model)
    panel_mult = float(rules["panelMultipliers"]["oled" if oled else "lcd"]["multiplier"])

    # ---------------- 分支 A：卓威 ZOWIE 独立价格体系 ----------------
    if tier_key == "zowie":
        nk = _norm_key(model)
        zmatch = next((z for z in _STATE["zowieTable"] if _norm_key(z["model"]) == nk), None)
        if not zmatch:
            zmatch = next(
                (z for z in sorted(_STATE["zowieTable"], key=lambda x: len(_norm_key(x["model"])), reverse=True) if nk.endswith(_norm_key(z["model"]))),
                None,
            )
        buy_target = float(zmatch["buyTarget"]) if zmatch else (1180.0 if hz >= 240 else 480.0)
        anchor = float(zmatch["xianyuAnchor"]) if zmatch else round(buy_target * 1.55)
        dyac = zmatch["dyac"] if zmatch else ("DyAc+/DyAc 2" if hz >= 240 else "待核DyAc")

        sanity_status = "uncrawled"
        sanity_reason = "尚未爬到闲鱼有效样本，已匹配卓威独立参考表（不混入普通TN走量档）。"
        effective_price = anchor
        price_source = "卓威独立表兜底参考"
        blocked = False

        if crawled_price is not None and crawled_price > 0:
            if crawled_price < max(float(th["zowieAbsurdFloor"]), buy_target * 0.72):
                sanity_status = "blocked_absurd_low"
                blocked = True
                effective_price = anchor
                price_source = "实爬假价已阻断 · 改显卓威参考锚点"
                sanity_reason = (
                    f"🚨 防呆尺标红阻断：{model}（{dyac}）卓威独立收货底线 ¥{buy_target:.0f}、同款闲鱼行情约 ¥{anchor:.0f}，"
                    f"本次爬出 ¥{crawled_price:.0f} 严重失真（AI反推：高概率混入无DyAc老型号、单卖遮光翼/S-Switch控制器或坏屏尸体机），严禁直接填入！"
                )
            else:
                sanity_status = "crawled_verified"
                effective_price = round(crawled_price)
                price_source = "闲鱼实爬价（通过卓威防呆核验）"
                sanity_reason = f"✓ 闲鱼实爬 ¥{crawled_price:.0f} 与卓威 {model}（{dyac}）保值区间吻合，直接采用实爬价。"

        return {
            "supported": True,
            "spec": spec,
            "track": "zowie_independent",
            "trackLabel": "卓威 ZOWIE 独立价格体系",
            "brandTier": tier_label,
            "bucketKey": f"zowie:{hz}hz",
            "bucketLabel": f"卓威独立档 · {res} {hz}Hz ({dyac})",
            "buyBaseline": buy_target,
            "formulaText": f"卓威专表（不套普通TN公式 · {dyac}）",
            "bucketCrawledMedian": anchor,
            "fallbackSalePrice": round(anchor),
            "crawledPrice": crawled_price,
            "sanityStatus": sanity_status,
            "sanityBlocked": blocked,
            "sanityReason": sanity_reason,
            "effectivePrice": round(effective_price) if effective_price else None,
            "priceSource": price_source,
        }

    # ---------------- 判断规格桶与是否跨入 5% 高端稀缺款（市面 > ¥1000） ----------------
    bucket_id: str | None = None
    if res in ("1K", "2K") and not oled and hz <= 280:
        if hz <= 110:
            bucket_id = f"office_{res.lower()}"
        elif hz <= 200:
            bucket_id = f"{res.lower()}_180"
        else:
            bucket_id = f"{res.lower()}_240"
    elif res == "4K" and not oled and hz <= 100:
        # 普通 4K 60~100Hz 办公 LCD 二手市面价约 ¥550~¥880（千元内走量款）；4K 高刷电竞(>100Hz)才属千元以上高端款
        bucket_id = "office_4k"

    # 计算四档/办公采购基准价（按超频最高刷新率直接算）
    buy_baseline: float | None = None
    formula_text = ""
    est_market_price: float | None = None

    if bucket_id and bucket_id in rules["baseSpecPrices"]:
        bcfg = rules["baseSpecPrices"][bucket_id]
        base_buy = float(bcfg["baseBuy"])
        buy_baseline = _round_half(base_buy * brand_mult * panel_mult)
        formula_text = f"¥{base_buy:.0f}({bcfg['label'].split('·')[-1].strip()}) × {brand_mult:.2f}(品牌) = ¥{buy_baseline:g}"
        med_info = _BUCKET_CRAWLED_MEDIANS.get(f"{tier_key}:{bucket_id}") or _BUCKET_CRAWLED_MEDIANS.get(f"tier2:{bucket_id}")
        bucket_median = float(med_info["crawledMedian"]) if med_info else round(buy_baseline * float(bcfg["defaultResaleMult"]))
        est_market_price = bucket_median
    elif res in ("1K", "2K") and oled and 120 <= hz <= 280:
        # 手册第 4 页虽写了 OLED 1.5x 采购上限（如 400*1.5*1.5=900），但二手市面售价远超 1000 元，属于 5% 高端款！
        b_key = f"{res.lower()}_{'180' if hz <= 200 else '240'}"
        base_buy = float(rules["baseSpecPrices"][b_key]["baseBuy"])
        buy_baseline = _round_half(base_buy * brand_mult * panel_mult)
        formula_text = f"手册OLED收货上限 ¥{buy_baseline:g}（市面>¥1000，销售按实爬算）"

    # 判定是否属于 5% 高端稀缺款（OLED / 双模 / 带鱼 / 4K高刷 / ≥300Hz / 预估或实爬市面价 > ¥1000）
    is_highend = (
        oled
        or hz >= 300
        or bucket_id is None
        or "双模" in res
        or (est_market_price is not None and est_market_price > float(rules["volumeCeilingPrice"]))
        or (crawled_price is not None and crawled_price > float(rules["volumeCeilingPrice"]) and (bucket_id is None or hz >= 240))
    )

    # ---------------- 分支 B：5% 高端稀缺款（> ¥1000，不套公式兜底，直接按闲鱼实爬价算） ----------------
    if is_highend:
        floor_price = max(float(th["highEndAbsurdFloor"]), (buy_baseline or 500.0) * 0.85)
        if crawled_price is not None and crawled_price > 0:
            if crawled_price < floor_price:
                return {
                    "supported": True,
                    "spec": spec,
                    "track": "highend_5",
                    "trackLabel": "5% 高端稀缺款（>¥1000 · 直接按实爬算）",
                    "brandTier": tier_label,
                    "bucketKey": f"highend:{res}:{hz}hz:{'oled' if oled else 'lcd'}",
                    "bucketLabel": f"高端稀缺 · {res} {hz}Hz {panel}",
                    "buyBaseline": buy_baseline,
                    "formulaText": formula_text or "高端稀缺款不设走量公式基准",
                    "bucketCrawledMedian": None,
                    "fallbackSalePrice": None,
                    "crawledPrice": crawled_price,
                    "sanityStatus": "blocked_absurd_low",
                    "sanityBlocked": True,
                    "sanityReason": (
                        f"🚨 高端款假价拦截：{res} {hz}Hz {panel} 属千元以上高端稀缺款，闲鱼爬出 ¥{crawled_price:.0f} "
                        f"低于高端防呆底线 ¥{floor_price:.0f}（AI反推：混入碎屏烧屏尸体机、单卖底座电源或定金链接），已阻断填入！"
                    ),
                    "effectivePrice": None,
                    "priceSource": "实爬假价已阻断 · 待重爬闲鱼真机价",
                }
            return {
                "supported": True,
                "spec": spec,
                "track": "highend_5",
                "trackLabel": "5% 高端稀缺款（>¥1000 · 直接按实爬算）",
                "brandTier": tier_label,
                "bucketKey": f"highend:{res}:{hz}hz:{'oled' if oled else 'lcd'}",
                "bucketLabel": f"高端稀缺 · {res} {hz}Hz {panel}",
                "buyBaseline": buy_baseline,
                "formulaText": formula_text or "高端款不套走量公式 · 直接采信实爬",
                "bucketCrawledMedian": None,
                "fallbackSalePrice": None,
                "crawledPrice": crawled_price,
                "sanityStatus": "crawled_verified",
                "sanityBlocked": False,
                "sanityReason": f"✓ 5% 高端稀缺款（货少无同档大盘参考），直接采用闲鱼真实爬取价 ¥{crawled_price:.0f}。",
                "effectivePrice": round(crawled_price),
                "priceSource": "闲鱼实爬直算（5%高端款）",
            }
        return {
            "supported": True,
            "spec": spec,
            "track": "highend_5",
            "trackLabel": "5% 高端稀缺款（>¥1000 · 直接按实爬算）",
            "brandTier": tier_label,
            "bucketKey": f"highend:{res}:{hz}hz:{'oled' if oled else 'lcd'}",
            "bucketLabel": f"高端稀缺 · {res} {hz}Hz {panel}",
            "buyBaseline": buy_baseline,
            "formulaText": formula_text or "高端稀缺款不套 95% 走量兜底公式",
            "bucketCrawledMedian": None,
            "fallbackSalePrice": None,
            "crawledPrice": None,
            "sanityStatus": "highend_uncrawled",
            "sanityBlocked": False,
            "sanityReason": "高端稀缺款（市面>¥1000，同款极少无大盘参考），严格不套走量公式编造低价，待闲鱼多词重爬或人工单议。",
            "effectivePrice": None,
            "priceSource": "无在售（高端款不套公式兜底）",
        }

    # ---------------- 分支 C：95% 千元内走量款（核心主战场：规格兜底 + 防呆尺 + 反向校准） ----------------
    bcfg = rules["baseSpecPrices"][bucket_id]
    med_key = f"{tier_key}:{bucket_id}"
    med_entry = _BUCKET_CRAWLED_MEDIANS.get(med_key) or _BUCKET_CRAWLED_MEDIANS.get(f"tier2:{bucket_id}")
    bucket_median = float(med_entry["crawledMedian"]) if med_entry else round((buy_baseline or 200.0) * float(bcfg["defaultResaleMult"]))
    formula_sale = round((buy_baseline or 200.0) * float(bcfg["defaultResaleMult"]))
    # 走量兜底价：70% 权重取同规格桶真实已爬中位价 + 30% 权重取手册采购基准推算价（且绝不超过 999 元走量天花板）
    fallback_sale = min(999, round(bucket_median * 0.7 + formula_sale * 0.3))

    min_by_buy = (buy_baseline or 150.0) * float(th["minSaleVsBuyRatio"])
    min_by_med = bucket_median * float(th["minSaleVsBucketMedian"])
    absurd_floor = round(max(min_by_buy, min_by_med))

    if crawled_price is not None and crawled_price > 0:
        if crawled_price < absurd_floor:
            return {
                "supported": True,
                "spec": spec,
                "track": "volume_95",
                "trackLabel": "95% 走量款（≤¥1000 · 套基准防呆与兜底）",
                "brandTier": tier_label,
                "bucketKey": med_key,
                "bucketLabel": f"{bcfg['label']} · {tier_label.split(' ')[0]}",
                "buyBaseline": buy_baseline,
                "formulaText": formula_text,
                "bucketCrawledMedian": round(bucket_median),
                "fallbackSalePrice": fallback_sale,
                "absurdFloor": absurd_floor,
                "crawledPrice": crawled_price,
                "sanityStatus": "blocked_absurd_low",
                "sanityBlocked": True,
                "sanityReason": (
                    f"🚨 基准防呆尺标红阻断：本机属「{res} {hz}Hz（按超频算）· {panel}」，"
                    f"光收货基准价就要 ¥{buy_baseline:g}、同档走量闲鱼中位价 ¥{bucket_median:.0f}（防呆底线 ¥{absurd_floor}）！"
                    f"爬虫抓回的 ¥{crawled_price:.0f} 绝不可能是正常整机（AI反推：混入碎屏/漏液故障机、单卖支架底座或错爬成 1080P 60/75Hz 老后缀），已自动阻断填入！"
                ),
                "effectivePrice": fallback_sale,
                "priceSource": f"实爬 ¥{crawled_price:.0f} 假价已拦截 · 暂按同档兜底 ¥{fallback_sale}",
            }
        return {
            "supported": True,
            "spec": spec,
            "track": "volume_95",
            "trackLabel": "95% 走量款（≤¥1000 · 套基准防呆与兜底）",
            "brandTier": tier_label,
            "bucketKey": med_key,
            "bucketLabel": f"{bcfg['label']} · {tier_label.split(' ')[0]}",
            "buyBaseline": buy_baseline,
            "formulaText": formula_text,
            "bucketCrawledMedian": round(bucket_median),
            "fallbackSalePrice": fallback_sale,
            "absurdFloor": absurd_floor,
            "crawledPrice": crawled_price,
            "sanityStatus": "crawled_verified",
            "sanityBlocked": False,
            "sanityReason": (
                f"✓ 实爬价格通过防呆体检：闲鱼实爬 ¥{crawled_price:.0f} 高于收货基准 ¥{buy_baseline:g} "
                f"（防呆线 ¥{absurd_floor}），与同档走量中位价 ¥{bucket_median:.0f} 匹配，直接采用闲鱼实爬价！"
            ),
            "effectivePrice": round(crawled_price),
            "priceSource": "闲鱼实爬价（通过走量基准核验）",
        }

    # 闲鱼未爬到有效样本 → 触发 95% 走量款规格兜底！
    return {
        "supported": True,
        "spec": spec,
        "track": "volume_95",
        "trackLabel": "95% 走量款（≤¥1000 · 套基准防呆与兜底）",
        "brandTier": tier_label,
        "bucketKey": med_key,
        "bucketLabel": f"{bcfg['label']} · {tier_label.split(' ')[0]}",
        "buyBaseline": buy_baseline,
        "formulaText": formula_text,
        "bucketCrawledMedian": round(bucket_median),
        "fallbackSalePrice": fallback_sale,
        "absurdFloor": absurd_floor,
        "crawledPrice": None,
        "sanityStatus": "volume_fallback",
        "sanityBlocked": False,
        "sanityReason": (
            f"闲鱼暂无有效在售样本 → 已按「{res} · 超频{hz}Hz · {panel} · {tier_label.split(' ')[0]}」"
            f"同规格桶实爬中位价 ¥{bucket_median:.0f} + 手册收货基准 ¥{buy_baseline:g} 生成走量兜底价 ¥{fallback_sale}。"
        ),
        "effectivePrice": fallback_sale,
        "priceSource": f"同档走量兜底价（基准 ¥{buy_baseline:g}）",
    }


def _load_catalog_stats() -> dict[str, Any]:
    """扫描本地合成型号快照（catalog-snapshot.json），生成真实的 95%/5%/卓威 覆盖统计与反向校准表。"""
    candidates = [
        os.path.join(HERE, "..", "前端", "public", "data", "catalog-snapshot.json"),
        os.path.join(HERE, "..", "dist", "data", "catalog-snapshot.json"),
    ]
    snap_path = next((p for p in candidates if os.path.exists(p)), None)
    if not snap_path:
        return {"totalModels": 0, "monitors": 0, "volume95": 0, "highend5": 0, "zowie": 0, "fallbackCovered": 0}

    with open(snap_path, "r", encoding="utf-8") as f:
        snap = json.load(f)

    seen: dict[str, dict[str, Any]] = {}
    for m in snap.get("mk", []):
        k = _norm_key(m.get("n", ""))
        old = seen.get(k)
        if not old or (not old.get("p") and m.get("p")):
            seen[k] = m

    totals = {
        "totalUniqueModels": len(seen),
        "monitorsTotal": 0,
        "volumeCount": 0,
        "highendCount": 0,
        "zowieCount": 0,
        "crawledValidCount": 0,
        "volumeFallbackCoveredCount": 0,
        "highendUncrawledCount": 0,
    }
    bucket_counts: dict[str, int] = {}

    for m in seen.values():
        p = float(m["p"]) if m.get("p") else None
        ev = evaluate_monitor_pricing(m.get("n", ""), m.get("s", ""), p)
        if not ev.get("supported"):
            continue
        totals["monitorsTotal"] += 1
        tk = ev["track"]
        if tk == "volume_95":
            totals["volumeCount"] += 1
            bk = ev.get("bucketKey", "")
            bucket_counts[bk] = bucket_counts.get(bk, 0) + 1
            if ev["sanityStatus"] == "volume_fallback":
                totals["volumeFallbackCoveredCount"] += 1
            elif ev["sanityStatus"] == "crawled_verified":
                totals["crawledValidCount"] += 1
        elif tk == "highend_5":
            totals["highendCount"] += 1
            if ev["sanityStatus"] == "crawled_verified":
                totals["crawledValidCount"] += 1
            else:
                totals["highendUncrawledCount"] += 1
        elif tk == "zowie_independent":
            totals["zowieCount"] += 1
            if ev["sanityStatus"] == "crawled_verified":
                totals["crawledValidCount"] += 1

    totals["volumeSharePct"] = round(totals["volumeCount"] * 100.0 / max(1, totals["monitorsTotal"]), 1)
    totals["bucketModelCounts"] = bucket_counts
    return totals


def build_calibration_rows(catalog_stats: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """生成「95%走量款基准策略 vs 闲鱼实爬大盘」反向校验与人工拍板对比表（A4 预留决策位）。"""
    rules = _STATE["monitorRules"]
    bcounts = (catalog_stats or {}).get("bucketModelCounts", {})
    rows: list[dict[str, Any]] = []

    pairs = [
        ("tier2", "1k_180"),
        ("tier1", "1k_180"),
        ("tier2", "2k_180"),
        ("tier1", "2k_180"),
        ("tier2", "1k_240"),
        ("tier1", "1k_240"),
        ("tier2", "2k_240"),
        ("tier1", "2k_240"),
        ("super_tier1", "2k_240"),
        ("tier2", "office_1k"),
        ("tier2", "office_2k"),
    ]
    for tkey, bid in pairs:
        bcfg = rules["baseSpecPrices"][bid]
        tcfg = rules["brandTiers"][tkey]
        buy_base = _round_half(float(bcfg["baseBuy"]) * float(tcfg["multiplier"]))
        med_info = _BUCKET_CRAWLED_MEDIANS.get(f"{tkey}:{bid}", {"sampleCount": 10, "crawledMedian": round(buy_base * 1.8)})
        crawled_med = float(med_info["crawledMedian"])
        expected_sale = round(buy_base * float(bcfg["defaultResaleMult"]))
        dev_pct = round((crawled_med - expected_sale) * 100.0 / max(1.0, expected_sale), 1)
        margin_yuan = round(crawled_med - buy_base)
        margin_pct = round(margin_yuan * 100.0 / max(1.0, crawled_med), 1)

        if dev_pct <= -12:
            verdict = "闲鱼实爬偏低 · 建议关注是否下调收货基价"
            verdict_lvl = "amb"
        elif dev_pct >= 12:
            verdict = "闲鱼行情坚挺 · 当前收货基准安全垫充足"
            verdict_lvl = "grn"
        else:
            verdict = "基准与闲鱼大盘高度吻合（偏差 ±12% 内）"
            verdict_lvl = "acc"

        rows.append({
            "key": f"{tkey}:{bid}",
            "specBucketId": bid,
            "brandTierKey": tkey,
            "bucketTitle": f"{tcfg['label']} · {bcfg['label']}",
            "catalogModelCount": bcounts.get(f"{tkey}:{bid}", 0),
            "crawledSampleModels": med_info["sampleCount"],
            "baseSpecBuy": float(bcfg["baseBuy"]),
            "brandMultiplier": float(tcfg["multiplier"]),
            "currentBuyTarget": buy_base,
            "expectedFormulaSale": expected_sale,
            "xianyuCrawledMedian": crawled_med,
            "deviationPct": dev_pct,
            "estimatedGrossMargin": margin_yuan,
            "estimatedGrossMarginPct": margin_pct,
            "verdict": verdict,
            "verdictLvl": verdict_lvl,
        })
    return rows


# 预置典型防呆与分流测试样例（供业务员/老板在选品基准台一键点选验证）
PRESET_SANITY_CASES: list[dict[str, Any]] = [
    {
        "id": "case_absurd_2k240",
        "label": "🚨 典型漏洞复现：2K 240Hz 错爬成 ¥200（坏屏/支架假价拦截）",
        "name": "泰坦军团 P2710S",
        "note": "27英寸 / 2560x1440 / 240Hz / Fast IPS",
        "crawledPrice": 200,
    },
    {
        "id": "case_oc_180",
        "label": "⚡ 超频直算：原生165Hz / 超频180Hz 一线屏（直接按180档算）",
        "name": "技嘉 G24F 2",
        "note": "23.8英寸 / 1920x1080 / 180Hz / SS IPS",
        "crawledPrice": 398,
    },
    {
        "id": "case_volume_fallback",
        "label": "🛡 冷门无样本兜底：二线 2K 180Hz 闲鱼没爬到（同档走量兜底）",
        "name": "科睿 G2721P",
        "note": "27英寸 / 2560x1440 / 200Hz / Fast IPS",
        "crawledPrice": None,
    },
    {
        "id": "case_highend_oled",
        "label": "💎 5% 高端稀缺款：ROG 2K 480Hz OLED（>¥1000 不套公式直接按实爬算）",
        "name": "ROG PG27AQDP",
        "note": "26.5英寸 / 2560x1440 / 480Hz / WOLED",
        "crawledPrice": 5850,
    },
    {
        "id": "case_highend_uncrawled",
        "label": "💎 5% 高端无在售：LG 32寸 4K240/FHD480 双模 OLED（不套走量公式编低价）",
        "name": "LG 32GS95UE-B",
        "note": "32英寸 / 3840x2160 / 480Hz / OLED",
        "crawledPrice": None,
    },
    {
        "id": "case_zowie_independent",
        "label": "🏆 卓威独立价格体系：ZOWIE XL2546K DyAc+（唯一独立保值表）",
        "name": "卓威 ZOWIE XL2546K",
        "note": "24.5英寸 / 1920x1080 / 240Hz / Fast TN",
        "crawledPrice": 1790,
    },
]


# ------------------------------------------------------------------ 5. FastAPI 路由接口
@router.get("/overview")
def api_spec_baseline_overview(_user=Depends(get_current_user)):
    cstats = _load_catalog_stats()
    return {
        "sourceDualCalibers": SOURCE_DUAL_CALIBERS,
        "monitorRules": _STATE["monitorRules"],
        "categorySlots": _STATE["categorySlots"],
        "catalogStats": cstats,
        "calibrationRows": build_calibration_rows(cstats),
        "zowieTable": _STATE["zowieTable"],
        "handbookModels": get_all_handbook_models(),
        "presetCases": [
            {**c, "eval": evaluate_monitor_pricing(c["name"], c["note"], c["crawledPrice"])}
            for c in PRESET_SANITY_CASES
        ],
        "decisionLogs": _STATE["decisionLogs"],
    }


@router.post("/evaluate")
def api_evaluate_single_model(body: dict[str, Any], _user=Depends(get_current_user)):
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "请输入型号名称或规格描述")
    note = str(body.get("note") or "")
    brand = str(body.get("brand") or "")
    raw_p = body.get("crawledPrice")
    cp = float(raw_p) if raw_p not in (None, "", 0, "0") else None
    return evaluate_monitor_pricing(name, note, cp, brand)


@router.post("/calibration/decide")
def api_save_calibration_decision(body: dict[str, Any], user=Depends(get_current_user)):
    """预留给老板/程序员跑完 1 万个型号后的反向调优拍板入口（改四档基价 / 改品牌倍率 / 改走量分界线）。"""
    rules = _STATE["monitorRules"]
    changes: list[str] = []

    if isinstance(body.get("baseSpecPrices"), dict):
        for bid, val in body["baseSpecPrices"].items():
            if bid in rules["baseSpecPrices"] and val is not None:
                nv = round(float(val), 1)
                ov = rules["baseSpecPrices"][bid]["baseBuy"]
                if nv != ov:
                    rules["baseSpecPrices"][bid]["baseBuy"] = nv
                    changes.append(f"{rules['baseSpecPrices'][bid]['label']} 基价 ¥{ov:g}→¥{nv:g}")

    if isinstance(body.get("brandMultipliers"), dict):
        for tkey, val in body["brandMultipliers"].items():
            if tkey in rules["brandTiers"] and val is not None:
                nv = round(float(val), 2)
                ov = rules["brandTiers"][tkey]["multiplier"]
                if nv != ov:
                    rules["brandTiers"][tkey]["multiplier"] = nv
                    changes.append(f"{rules['brandTiers'][tkey]['label']} 倍率 ×{ov:.2f}→×{nv:.2f}")

    if body.get("volumeCeilingPrice") is not None:
        nv = int(float(body["volumeCeilingPrice"]))
        if nv != rules["volumeCeilingPrice"]:
            changes.append(f"走量/高端分界线 ¥{rules['volumeCeilingPrice']}→¥{nv}")
            rules["volumeCeilingPrice"] = nv

    if isinstance(body.get("zowiePatch"), dict):
        zm = body["zowiePatch"]
        for row in _STATE["zowieTable"]:
            if row["code"] == zm.get("code") or row["model"] == zm.get("model"):
                if zm.get("buyTarget") is not None:
                    row["buyTarget"] = round(float(zm["buyTarget"]))
                if zm.get("xianyuAnchor") is not None:
                    row["xianyuAnchor"] = round(float(zm["xianyuAnchor"]))
                changes.append(f"卓威 {row['model']} 独立价更新为 收¥{row['buyTarget']}/锚¥{row['xianyuAnchor']}")

    actor = getattr(user, "name", None) or getattr(user, "username", "主管")
    note = str(body.get("note") or "").strip()
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
    ver_num = len(_STATE["decisionLogs"]) + 1
    rules["version"] = f"v2026.11.18-r{ver_num}"
    rules["updatedAt"] = now_str
    rules["updatedBy"] = actor

    summary = "；".join(changes) if changes else "人工确认当前基准参数无误并留痕"
    if note:
        summary = f"{summary}（备注：{note}）"
    _STATE["decisionLogs"].insert(0, {
        "id": f"DEC-{ver_num:03d}",
        "at": now_str,
        "actor": actor,
        "action": summary,
    })

    cstats = _load_catalog_stats()
    return {
        "ok": True,
        "version": rules["version"],
        "monitorRules": rules,
        "calibrationRows": build_calibration_rows(cstats),
        "zowieTable": _STATE["zowieTable"],
        "decisionLogs": _STATE["decisionLogs"],
    }


@router.post("/categories/{cat_id}")
def api_update_category_slot(cat_id: str, body: dict[str, Any], user=Depends(get_current_user)):
    """在选品前置台编辑/扩充任意复杂品类（手机苹果/DIY显卡硬件/相机穿戴/外设）的预留规格字段与防呆规则。"""
    slot = next((s for s in _STATE["categorySlots"] if s["id"] == cat_id), None)
    if not slot:
        raise HTTPException(404, f"未找到品类槽位 {cat_id}")
    if isinstance(body.get("specFields"), list) and body["specFields"]:
        slot["specFields"] = [str(x).strip() for x in body["specFields"] if str(x).strip()]
    if body.get("splitRule"):
        slot["splitRule"] = str(body["splitRule"]).strip()
    if body.get("sanityExample"):
        slot["sanityExample"] = str(body["sanityExample"]).strip()
    if body.get("status"):
        slot["status"] = str(body["status"])
    if body.get("statusLabel"):
        slot["statusLabel"] = str(body["statusLabel"])

    actor = getattr(user, "name", None) or getattr(user, "username", "业务员")
    _STATE["decisionLogs"].insert(0, {
        "id": f"SLOT-{len(_STATE['decisionLogs']) + 1:03d}",
        "at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "actor": actor,
        "action": f"更新品类「{slot['name']}」选品规格坑位配置",
    })
    return {"ok": True, "slot": slot, "categorySlots": _STATE["categorySlots"]}
