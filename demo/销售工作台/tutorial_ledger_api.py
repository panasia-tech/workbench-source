#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
销售工作台（含外部客服 V3 单应用合入）· 原生「教程与视频台账」API 模块 (2026-11-24)
零第三方依赖：SQLite (WAL) + 服务端岗位 RBAC（外部客服独立视图与物理隔离）+ 修订历史审计。
统一挂载于销售工作台 h5_server.py (/api/tutorials/*)。
"""
from __future__ import annotations

import copy
import datetime
import json
import os
import re
import sqlite3
import threading
from urllib.parse import parse_qs, unquote, urlparse

RELEASE_VERSION = "V6-20261124-merged-cs"
CS_TUTORIAL_VERSION = "V6.1-CS-20261124"
SEED_VERSION = "2026-11-24.3-cs7"
RUNTIME_DIR = os.environ.get(
    "CS_RUNTIME_DIR",
    os.path.expanduser("~/Library/Caches/panasia-gallery-stitch-20261113"),
)
os.makedirs(RUNTIME_DIR, exist_ok=True)
DB_PATH = os.path.join(RUNTIME_DIR, "tutorial_ledger.sqlite")
DB_LOCK = threading.Lock()

# 已实核存在的钉钉 Wiki 稳定节点（Step 6 新建索引/员工PDF后会回填更新常量）
WIKI_NODES = {
    "sales_home": "y20BglGWO2ZB6yQRiDlD25R08A7depqY",
    "sales_spec": "OG9lyrgJPzaqQx70uPBPb5E0WzN67Mw4",
    "sales_ai_manual": "b9Y4gmKWrP5pynLDTrpKDOd1JGXn6lpz",
    "sales_h5": "MyQA2dXW7eplaKOETd6dxP3gJzlwrZgb",
    "shared_intro_video": "P0MALyR8kl5DyXpYsMEM4ky4W3bzYmDO",
    "main_video": "P0MALyR8kl5DyXpYsMEM4e6gW3bzYmDO",
    "cs_video": "P0MALyR8kl5DyXpYsMZd5O1vW3bzYmDO",
    "change_video": "7QG4Yx2JpL5rPazvcpYpObj7J9dEq3XD",
    "ui_charter": "1OQX0akWmxAM02eyfNoOlbyn8GlDd3mE",
    "ui_error_report": "l6Pm2Db8D49lkzyNiyGG4Egz8xLq0Ee4",
    "dev_norm": "vNG4YZ7JnPBj0zyKToEXK4qXW2LD0oRE",
    "handoff": "OG9lyrgJPzaqQx70uPpL1XBLWzN67Mw4",
    "listing": "b9Y4gmKWrP5pynLDTr5qypZZJGXn6lpz",
    "role": "G53mjyd80pDo1GmEczkEP0NX86zbX04v",
    "manual": "X6GRezwJlA5gBpx3ujbqmk5L8dqbropQ",
    "dual_lib": "1DKw2zgV2PMoYdjETdA3Re508B5r9YAn",
    "tutorial_index": "GZLxjv9VGqMl2mDpIqYNLrrO86EDybno",
    "employee_pdf": "vNG4YZ7JnPBj0zyKToqMNz7qW2LD0oRE",
}


def wiki_url(key_or_id: str) -> str:
    nid = WIKI_NODES.get(key_or_id, key_or_id)
    return f"https://alidocs.dingtalk.com/i/nodes/{nid}" if nid else ""


OUTSOURCE_ACTORS = {"outsource_lu", "outsource_zhang", "outsource_wang", "cs_newbie", "newbie_cs"}
SUPERVISOR_ACTORS = {"admin", "supervisor", "boss", "heyucheng", "xuweinan"}

SEED_NODES = [
    {
        "node_id": "SALES-SHARED-00",
        "parent_group": "00｜公司共用开场与跨台交接",
        "title": "公司共用开场：实物链 + 虚拟链全单与五台岗位交接",
        "workbench": "销售工作台",
        "scope": "shared",
        "roles": ["销售业务员", "销售主管", "外部外包客服", "跨台研发参考"],
        "route_entry": "#/today",
        "help_keys": ["shared-overview", "handoff", "tutorials", "rd-main"],
        "business_basis": "《程序员规范全集》第3节＋《各工作台原生教程与视频台账实施说明》第3节",
        "owner": "何雨诚（口径确认）/ 销售主管",
        "applicable_version": RELEASE_VERSION,
        "video_wiki_url": wiki_url("shared_intro_video"),
        "video_title": "泛亚全公司业务全貌共用开场-720p-20261119（复用章）",
        "timecode": "00:00",
        "video_source_status": "旧音色基线（720p 实物链已有 18:33；待按 2026-11-24 规范补录虚拟链全单+片尾节点地图+千问官方预置音色）",
        "wiki_url": wiki_url("sales_home"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "codex_entry": "任意工作台任务页「？」→ 打开本节点 / Codex 按业务节点领取线索或复核",
        "skill_name": "panasia-cross-workbench-overview",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请结合共用开场节点交接红线，核对当前订单/线索在采购、仓管、销售、客服、台账间的上下游状态。",
        "expected_evidence": "明确上游输入材料、下游交付对象、异常升级责任人与 409 状态互锁结果。",
        "manual_trigger": "虚拟线索只有结果无步骤、跨工作台 409 状态冲突、或新同事首日不理解交接边界时。",
        "manual_fallback_doc": wiki_url("handoff"),
        "manual_fallback_video": wiki_url("change_video"),
        "coverage_status": "待更新",
        "fallback_status": "已配兜底",
        "gap_reason": "旧共用开场仅含实物链+5条握手；需补齐虚拟链「外部线索→同行在售→赛马→产品卡→交付→售后回传」实操段与片尾 Wiki 节点地图，并用千问官方预置音色重录。",
        "last_verified_by": "Agent 盘点初筛（待发起人确认）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "SALES-TODAY-01",
        "parent_group": "01｜销售日常工作与协同",
        "title": "「今天」红黄绿任务队列、加派改派交接与 60 秒协同接力",
        "workbench": "销售工作台",
        "scope": "sales",
        "roles": ["销售业务员", "销售主管"],
        "route_entry": "#/today",
        "help_keys": ["today", "today-top", "today-picks", "today-team", "today-assign", "d-assign", "d-collab", "d-comm", "d-count", "d-dev", "d-ent", "d-exc", "d-hist", "d-imgtask", "d-list", "d-picks", "d-plan", "d-progress", "d-team"],
        "business_basis": "《泛亚工作台 UI 设计总纲领 v1.1》首屏问题箱与单步向导",
        "owner": "销售主管",
        "applicable_version": RELEASE_VERSION,
        "video_wiki_url": wiki_url("main_video"),
        "video_title": "销售工作台-全量业务与研发讲解-20261119（章节 08）",
        "timecode": "21:15",
        "video_source_status": "已有 720p 实机演示段（旧音色基线，V6 桌面定稿对齐中）",
        "wiki_url": wiki_url("sales_home"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "codex_entry": "销售工作台 #/today → 点击「？」或向 Codex 传入任务单号",
        "skill_name": "sales-today-dispatch-guard",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请检查我名下今日红灯任务优先级，核对改派三项交接上下文（已完成/未完成/下一步）是否齐全。",
        "expected_evidence": "红灯清零、改派保留交接上下文且原负责人失权。",
        "manual_trigger": "遇到未见过的新异常（点右上角「遇到没见过的情况」）或 60 秒协同请求无人接听转主管。",
        "manual_fallback_doc": wiki_url("role"),
        "manual_fallback_video": "",
        "coverage_status": "可用",
        "fallback_status": "Skill 已覆盖无需兜底",
        "gap_reason": "",
        "last_verified_by": "Agent 盘点初筛（待主管确认 V6）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "SALES-LEARN-02",
        "parent_group": "01｜销售日常工作与协同",
        "title": "新人三关练习（实物/虚拟/服务）与岗前解锁门禁",
        "workbench": "销售工作台",
        "scope": "sales",
        "roles": ["新同事", "销售业务员", "销售主管"],
        "route_entry": "#/learn",
        "help_keys": ["learn", "learn-practice", "learn-video"],
        "business_basis": "零培训上岗与真实任务前置练习硬锁（practice_done）",
        "owner": "销售主管",
        "applicable_version": RELEASE_VERSION,
        "video_wiki_url": wiki_url("main_video"),
        "video_title": "销售工作台-全量业务与研发讲解-20261119（章节 08）",
        "timecode": "22:40",
        "video_source_status": "已有 720p 实机演示段（旧音色基线）",
        "wiki_url": wiki_url("manual"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "codex_entry": "销售工作台 #/learn → 完成 3 关模拟练习（假数据不写生产）",
        "skill_name": "sales-onboarding-3gates",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "我在新人练习第 N 步遇到拦截提示，请帮我解释这条防呆规则背后的真实风险。",
        "expected_evidence": "实物/虚拟/服务三类各达 3/3 通过，顶部黄条门禁自动解除。",
        "manual_trigger": "练习步骤报错或对规则判例有疑问时。",
        "manual_fallback_doc": wiki_url("manual"),
        "manual_fallback_video": "",
        "coverage_status": "可用",
        "fallback_status": "Skill 已覆盖无需兜底",
        "gap_reason": "",
        "last_verified_by": "Agent 盘点初筛（待主管确认 V6）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "SALES-SRC-03",
        "parent_group": "02｜选品与库存双 Library 全链路",
        "title": "来源台账双口径（宏观类目 vs 垂类型号）与 BOOKOFF 选品库",
        "workbench": "销售工作台",
        "scope": "sales",
        "roles": ["销售业务员", "选品专员", "销售主管"],
        "route_entry": "#/sources",
        "help_keys": ["sources", "bookoff", "bl-main", "sel-src"],
        "business_basis": "《销售工作台｜选品与历史库存双 Library 全流程 v1.0》",
        "owner": "销售主管",
        "applicable_version": RELEASE_VERSION,
        "video_wiki_url": wiki_url("main_video"),
        "video_title": "销售工作台-全量业务与研发讲解-20261119（章节 14）",
        "timecode": "37:00",
        "video_source_status": "已有 720p 实机演示段（旧音色基线）",
        "wiki_url": wiki_url("dual_lib"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "codex_entry": "#/sources & #/bookoff → 右上角「？」/ Codex 型号与类目对照",
        "skill_name": "sales-bookoff-macro-taxonomy",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请用宏观类目库确定二级品类路径，并从垂类型号库查出该型号完整物理参数与别称。",
        "expected_evidence": "类目归属准确、有图样本筛选口径（默认有图）与垂类参数出处可查。",
        "manual_trigger": "目标型号同时不在 BOOKOFF 与垂类参数库、或存在别名歧义时。",
        "manual_fallback_doc": wiki_url("dual_lib"),
        "manual_fallback_video": "",
        "coverage_status": "可用",
        "fallback_status": "Skill 已覆盖无需兜底",
        "gap_reason": "",
        "last_verified_by": "Agent 盘点初筛（待主管确认 V6）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "SALES-SPEC-04",
        "parent_group": "02｜选品与库存双 Library 全链路",
        "title": "选品规格兜底基准、95%走量/5%高端/卓威24款与 2K240 红框防呆",
        "workbench": "销售工作台",
        "scope": "sales",
        "roles": ["销售业务员", "选品专员", "销售主管"],
        "route_entry": "#/spec-baseline",
        "help_keys": ["spec-baseline", "spec-base", "selphys", "sel-price", "sel-id"],
        "business_basis": "7,901 款显示器三路定价分流与异常低价红框阻断规格",
        "owner": "销售主管",
        "applicable_version": RELEASE_VERSION,
        "video_wiki_url": wiki_url("main_video"),
        "video_title": "销售工作台-全量业务与研发讲解-20261119（章节 15-16）",
        "timecode": "39:53",
        "video_source_status": "已有 720p 实机演示段（旧音色基线）",
        "wiki_url": wiki_url("dual_lib"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "codex_entry": "#/spec-baseline & #/selphys → 调用选品定价防呆 Skill 校对基准带",
        "skill_name": "sales-spec-baseline-guard",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请校验该型号属于 95% 走量款、5% 高端 OLED/双模还是卓威 24 款，确认后缀精确匹配且无碎屏假低价污染。",
        "expected_evidence": "分流档位、后缀长度匹配结果与合理参考价区间。",
        "manual_trigger": "爬虫样本低于同档底线触发红框拦截、或发现新增超频/双模型号无法自动归档时。",
        "manual_fallback_doc": wiki_url("dual_lib"),
        "manual_fallback_video": wiki_url("change_video"),
        "coverage_status": "可用",
        "fallback_status": "已配兜底",
        "gap_reason": "",
        "last_verified_by": "Agent 盘点初筛（待主管确认 V6）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "SALES-WASH-PRICE-05",
        "parent_group": "02｜选品与库存双 Library 全链路",
        "title": "历史库存第 1 步洗价格：巡航台 v0.2.0 12 词快照与 review_only 拦截",
        "workbench": "销售工作台",
        "scope": "sales",
        "roles": ["销售业务员", "销售主管"],
        "route_entry": "#/wash",
        "help_keys": ["pricing", "wash", "price-cleaning"],
        "business_basis": "巡航台 v0.2.0 三道门禁、四事实隔离与 130% 成本红线",
        "owner": "销售主管",
        "applicable_version": RELEASE_VERSION,
        "video_wiki_url": wiki_url("main_video"),
        "video_title": "销售工作台-全量业务与研发讲解-20261119（章节 17）",
        "timecode": "46:07",
        "video_source_status": "已有 720p 实机演示段（旧音色基线）",
        "wiki_url": wiki_url("dual_lib"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "codex_entry": "#/wash → 点进单品进入 #/price-cleaning/:id 核对 12 词快照",
        "skill_name": "sales-price-cleaning-pilot",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请对照闲鱼 12 搜索词快照、成本×130% 底线与价差 25% 规则，核对这台机器是否触发 review_only。",
        "expected_evidence": "至少 3 条有效同价型样本、剔除原因记录与写后 GET 一致性校验。",
        "manual_trigger": "出现 2K240Hz 错爬成 200 元被锁定在 review_only、缺成本或无行情样本时。",
        "manual_fallback_doc": wiki_url("listing"),
        "manual_fallback_video": wiki_url("change_video"),
        "coverage_status": "可用",
        "fallback_status": "已配兜底",
        "gap_reason": "",
        "last_verified_by": "Agent 盘点初筛（待主管确认 V6）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "SALES-WASH-IMG-06",
        "parent_group": "02｜选品与库存双 Library 全链路",
        "title": "历史库存第 2 步洗图片：三栏图库、跨店哈希防重与零审批直发",
        "workbench": "销售工作台",
        "scope": "sales",
        "roles": ["销售业务员", "销售主管"],
        "route_entry": "#/image-cleaning",
        "help_keys": ["publish", "image-cleaning", "detail", "gallery", "g-counts", "g-group", "g-pool", "p-age", "p-facts", "p-flow", "p-issues", "p-links", "p-price", "p-shops", "flow-3", "flow-4", "ue-img", "ue-unit", "ue-sample"],
        "business_basis": "大库三栏图池分店防铺货、60 秒撤回与零主管阻塞直发",
        "owner": "销售主管",
        "applicable_version": RELEASE_VERSION,
        "video_wiki_url": wiki_url("main_video"),
        "video_title": "销售工作台-全量业务与研发讲解-20261119（章节 18）",
        "timecode": "49:08",
        "video_source_status": "已有 720p 实机演示段（旧音色基线）",
        "wiki_url": wiki_url("listing"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "codex_entry": "#/image-cleaning/:id → 淘汰杂图后提交各店互不重复图组",
        "skill_name": "sales-image-dedup-dispatch",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请检查多店铺主图哈希与瑕疵图标签，确保瑕疵照只给人看不作为自动主图，各店首图无雷同。",
        "expected_evidence": "各店分配图片无哈希冲突，提交后进入群控错峰队列并保留 60 秒撤回记录。",
        "manual_trigger": "大库净图数量不足每个号分一组、或超过 60 秒需要更正已发布内容时。",
        "manual_fallback_doc": wiki_url("listing"),
        "manual_fallback_video": "",
        "coverage_status": "可用",
        "fallback_status": "Skill 已覆盖无需兜底",
        "gap_reason": "",
        "last_verified_by": "Agent 盘点初筛（待主管确认 V6）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "SALES-GC-07",
        "parent_group": "03｜群控多店排程与防风控",
        "title": "群控 4 页矩阵：8 环境健康、错峰上下架联动、库龄调价与 15:30 日报",
        "workbench": "销售工作台",
        "scope": "sales",
        "roles": ["销售业务员", "销售主管"],
        "route_entry": "#/gc-matrix",
        "help_keys": ["gc-matrix", "gc-queue", "gc-reprice", "gc-metrics"],
        "business_basis": "单号每日 10 票错峰、锁单联动下架与 046 策略脱敏（禁透出金额红线）",
        "owner": "销售主管",
        "applicable_version": RELEASE_VERSION,
        "video_wiki_url": wiki_url("main_video"),
        "video_title": "销售工作台-全量业务与研发讲解-20261119（章节 19）",
        "timecode": "51:39",
        "video_source_status": "已有 720p 实机演示段（旧音色基线）",
        "wiki_url": wiki_url("sales_spec"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "codex_entry": "#/gc-matrix / #/gc-queue / #/gc-reprice / #/gc-metrics",
        "skill_name": "sales-group-control-scheduler",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请核对今日群控队列错峰间隔（20–30 分钟）、联动下架单完成状态及 14/28 天库龄调价队列。",
        "expected_evidence": "8 个浏览器环境健康绿灯、锁单无超卖、15:30 小铺日报异常清零。",
        "manual_trigger": "群控节点离线、联动下架失败告警或需临时停发时。",
        "manual_fallback_doc": wiki_url("sales_spec"),
        "manual_fallback_video": "",
        "coverage_status": "可用",
        "fallback_status": "已配兜底",
        "gap_reason": "",
        "last_verified_by": "Agent 盘点初筛（待主管确认 V6）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "SALES-VIRT-INTEL-08",
        "parent_group": "04｜虚拟产品与技术服务（含验证模板）",
        "title": "虚拟选品：外部线索 Gallery、同行在售证据、同行渠道与赛马立项",
        "workbench": "销售工作台",
        "scope": "sales",
        "roles": ["销售业务员", "虚拟选品运营", "销售主管"],
        "route_entry": "#/virt-intel",
        "help_keys": ["selvirt", "stages", "v-checks", "v-issues", "v-law", "v-money", "v-review", "v-signals", "v-source", "pe-opp"],
        "business_basis": "《销售工作台虚拟产品｜外部情报与在售商品 Gallery 专项报告（2026-11-24）》",
        "owner": "销售主管",
        "applicable_version": RELEASE_VERSION,
        "video_wiki_url": wiki_url("main_video"),
        "video_title": "销售工作台-全量业务与研发讲解-20261119（虚拟章节复用）",
        "timecode": "54:45",
        "video_source_status": "旧版通用总览段（2026-11-24 已上线 #/virt-intel 外部情报大模块，待补录新版手绘+实机片段）",
        "wiki_url": wiki_url("sales_spec"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "codex_entry": "#/virt-intel → 点击业务分类进入「线索 Gallery / 在售商品 Gallery / 同行与渠道 / 赛马与盈利建卡」",
        "skill_name": "sales-virtual-intel-gallery",
        "skill_status": "待核",
        "codex_prompt_hint": "请将这条外部线索/同行链接关联到对应业务分类节点，保留出处定位并区分综合群与细分节点归属。",
        "expected_evidence": "原链接/消息游标定位、在售快照、可比价格带样本数与赛马记录。",
        "manual_trigger": "同行仅晒收入无步骤、链接失效下架或跨平台交付范围不可比时，标记「待补证/待核」交运营/主管。",
        "manual_fallback_doc": wiki_url("sales_home"),
        "manual_fallback_video": "",
        "coverage_status": "待更新",
        "fallback_status": "待主管按需补录",
        "gap_reason": "2026-11-24 新增「外部线索 / 同行在售 / 赛马 / QQ 企微增量游标」需求，须重录带独立手绘对比图的通用讲解视频并由主管核准 Skill。",
        "last_verified_by": "Agent 盘点初筛（待主管确认 V6）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "SALES-VIRT-CAD-09",
        "parent_group": "04｜虚拟产品与技术服务（含验证模板）",
        "title": "验证模板①·CAD 描图：纸图转 DWG、尺寸校核、Codex+Skill 与复杂图层人工兜底",
        "workbench": "销售工作台",
        "scope": "sales",
        "roles": ["销售业务员", "虚拟制作专员", "销售主管"],
        "route_entry": "#/virt-intel?node=cad-trace&tab=racing",
        "help_keys": ["selvirt", "skills"],
        "business_basis": "《各工作台原生教程与视频台账实施说明》第 4 节验证模板「CAD 描图」",
        "owner": "销售主管",
        "applicable_version": RELEASE_VERSION,
        "video_wiki_url": wiki_url("main_video"),
        "video_title": "销售工作台-全量业务与研发讲解-20261119（虚拟节点章节）",
        "timecode": "55:10",
        "video_source_status": "暂复用虚拟选品总览章节（待按 CAD 描图 4 段手绘骨架+DWG 实机复测重录）",
        "wiki_url": wiki_url("dev_norm"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "codex_entry": "销售工作台 #/virt-intel?node=cad-trace → CAD 描图节点同题赛马 → Codex 调用 CAD Vectorize Skill",
        "skill_name": "cad-paper-to-dwg-check",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请使用脱敏客户原图、已知标注尺寸和目标 DWG 版本生成矢量图纸，输出后自动重开 DWG 复测关键比例与闭合图层。",
        "expected_evidence": "可编辑 DWG 文件、尺寸复测对照表、客户缺尺寸补问记录（如有）。",
        "manual_trigger": "客户原图缺失关键尺寸、纸图污损严重或成品无法自动复测/出现复杂多专业叠加图层时，停止自动交付。",
        "manual_fallback_doc": wiki_url("manual"),
        "manual_fallback_video": wiki_url("sales_home"),
        "coverage_status": "待复核",
        "fallback_status": "已配兜底",
        "gap_reason": "通用视频时间码 55:10 为总览章节；待补录独立 CAD 手绘对比段（纸图 vs 矢量 vs 尺寸校验）及真实 DWG 桌面软件复测片段并由主管确认。",
        "last_verified_by": "Agent 盘点初筛（待主管确认）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "SALES-VIRT-CARD-10",
        "parent_group": "04｜虚拟产品与技术服务（含验证模板）",
        "title": "虚拟商品三步建卡与卡密池低水位防超卖",
        "workbench": "销售工作台",
        "scope": "sales",
        "roles": ["销售业务员", "销售主管"],
        "route_entry": "#/virt-new",
        "help_keys": ["virt-new", "virtstock", "pe-stages", "pe-ticket", "pe-profit", "pe-order"],
        "business_basis": "对标阿奇索/闲管家三步大页建卡与低水位自动停售",
        "owner": "销售主管",
        "applicable_version": RELEASE_VERSION,
        "video_wiki_url": wiki_url("main_video"),
        "video_title": "销售工作台-全量业务与研发讲解-20261119（章节 20）",
        "timecode": "55:30",
        "video_source_status": "已有 720p 实机演示段（旧音色基线）",
        "wiki_url": wiki_url("sales_spec"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "codex_entry": "#/virt-new & #/item/virt/:id → 检查卡密库存、发货前置校验与自动停售阈值",
        "skill_name": "sales-virtual-card-stock-guard",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请核对虚拟产品卡的适用地域、有效期、核销规则及卡密库存安全水位，确认断货自动停售开关已启用。",
        "expected_evidence": "产品卡八步门禁完成记录、卡密水位告警与发卡回执。",
        "manual_trigger": "卡密池告警不足、外部直充通道报错或品牌活动页规则变更下线时。",
        "manual_fallback_doc": wiki_url("sales_spec"),
        "manual_fallback_video": "",
        "coverage_status": "可用",
        "fallback_status": "Skill 已覆盖无需兜底",
        "gap_reason": "",
        "last_verified_by": "Agent 盘点初筛（待主管确认 V6）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "SALES-SVC-DELTA-11",
        "parent_group": "04｜虚拟产品与技术服务（含验证模板）",
        "title": "验证模板②·《三角洲行动》技术服务：症状复现、Codex+Skill 排障与人工兜底",
        "workbench": "销售工作台",
        "scope": "sales",
        "roles": ["销售业务员", "远程技术专员", "销售主管"],
        "route_entry": "#/skills",
        "help_keys": ["skills", "service", "svc-1", "svc-8", "svc-12", "svc-14"],
        "business_basis": "《各工作台原生教程与视频台账实施说明》第 4 节验证模板「三角洲技术服务」＋服务 14 节点防呆",
        "owner": "销售主管",
        "applicable_version": RELEASE_VERSION,
        "video_wiki_url": wiki_url("main_video"),
        "video_title": "销售工作台-全量业务与研发讲解-20261119（服务技能台账节点）",
        "timecode": "56:00",
        "video_source_status": "暂复用服务技能与程序化交付章节（待补录三角洲虚拟化报警独立手绘+实操排障片段）",
        "wiki_url": wiki_url("dev_norm"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "codex_entry": "#/skills（Service Skill 台账）→ 启动干净环境复现或远控会话 → 触发核准 Skill",
        "skill_name": "delta-force-vm-alert-remediation",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请先在隔离环境复现客户《三角洲行动》虚拟化报警报错，区分系统环境状态与可观察症状，再用已核准 Skill 排查并二次验证启动。",
        "expected_evidence": "完整报错截图/版本信息、三路采集核验、干净环境复现通过凭证与复测启动截图。",
        "manual_trigger": "Skill 无法定位新报错、客户设备有特殊安全软件拦截或需专业人员修改 BIOS/驱动时，立即保留报错与版本信息转人工。",
        "manual_fallback_doc": wiki_url("sales_ai_manual"),
        "manual_fallback_video": wiki_url("sales_home"),
        "coverage_status": "待复核",
        "fallback_status": "已配兜底",
        "gap_reason": "待补录三角洲服务专项手绘原理（症状vs环境状态隔离）+ 远控实操回退片段，并由业务主管核准最新报错码处理表。",
        "last_verified_by": "Agent 盘点初筛（待主管确认）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "SALES-SVC-DELIVER-12",
        "parent_group": "04｜虚拟产品与技术服务（含验证模板）",
        "title": "技术服务程序化预约、核销与 14 节点学习→交付闭环",
        "workbench": "销售工作台",
        "scope": "sales",
        "roles": ["销售业务员", "远程技术专员", "销售主管"],
        "route_entry": "#/program",
        "help_keys": ["program", "pg-main", "pe-program", "svc-queue", "svc-evidence", "svc-outputs", "svc-redline", "svc-runner"],
        "business_basis": "服务 14 步防呆（禁向同行索要密码、必用学习机、三成品同版入库）",
        "owner": "销售主管",
        "applicable_version": RELEASE_VERSION,
        "video_wiki_url": wiki_url("main_video"),
        "video_title": "销售工作台-全量业务与研发讲解-20261119（章节 20）",
        "timecode": "56:20",
        "video_source_status": "已有 720p 实机演示段（14 节点分步专项小视频待逐节点补录）",
        "wiki_url": wiki_url("sales_spec"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "codex_entry": "#/program & #/item/svc/:id → 预约时段核销 + 三成品校验",
        "skill_name": "sales-remote-service-delivery",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请核对当前服务订单绑定的设备 session 与隔离环境确认，确保密码/验证码不落库且三成品齐全。",
        "expected_evidence": "预约时段锁、远控会后确认与干净环境复现通过记录。",
        "manual_trigger": "同行拒绝提供关键命令、多台同名设备混淆或 RPA/ComputerUse 卡死时按人工兜底接管。",
        "manual_fallback_doc": wiki_url("sales_ai_manual"),
        "manual_fallback_video": "",
        "coverage_status": "待更新",
        "fallback_status": "已配兜底",
        "gap_reason": "总览章节已覆盖，svc-1 至 svc-14 单步精细实拍 MP4 仍标待录，需按 2026-11-24 分镜模板分批补录。",
        "last_verified_by": "Agent 盘点初筛（待主管确认 V6）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "SALES-ORDER-13",
        "parent_group": "05｜订单出库、报价与经营复盘",
        "title": "订单四种红灯对账、强制扫码核对货号与 30 秒出库撤回",
        "workbench": "销售工作台",
        "scope": "sales",
        "roles": ["销售业务员", "销售主管"],
        "route_entry": "#/orders",
        "help_keys": ["orders", "ship", "o-deadline", "o-fees"],
        "business_basis": "防错发硬锁（扫码货号 != 订单货号拦截 / 严禁一机两卖 / 17:00 时限）",
        "owner": "销售主管",
        "applicable_version": RELEASE_VERSION,
        "video_wiki_url": wiki_url("main_video"),
        "video_title": "销售工作台-全量业务与研发讲解-20261119（章节 20）",
        "timecode": "56:40",
        "video_source_status": "已有 720p 实机演示段（旧音色基线）",
        "wiki_url": wiki_url("listing"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "codex_entry": "#/orders → 点选红灯订单执行补抓/选货/扫码出库",
        "skill_name": "sales-order-reconcile-ship",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请检查今日漏抓/对不上货/状态不同步红灯订单，确认扫码货号与绑定单品一致且未触发 409 退单锁。",
        "expected_evidence": "扫码校验通过、运单回填成功且全店联动下架。",
        "manual_trigger": "平台状态与系统不一致、买家改地址或触发 409 急停拦截时。",
        "manual_fallback_doc": wiki_url("handoff"),
        "manual_fallback_video": "",
        "coverage_status": "可用",
        "fallback_status": "Skill 已覆盖无需兜底",
        "gap_reason": "",
        "last_verified_by": "Agent 盘点初筛（待主管确认 V6）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "SALES-OPS-14",
        "parent_group": "05｜订单出库、报价与经营复盘",
        "title": "询单报价锁版、采购价格表 7 天版、周期复盘与提成账本",
        "workbench": "销售工作台",
        "scope": "sales",
        "roles": ["销售业务员", "销售主管"],
        "route_entry": "#/ops",
        "help_keys": ["ops", "ops-main", "inquiry", "iq-main", "pricebook", "pb-main", "cycles", "cy-main", "commission", "cm-main"],
        "business_basis": "报价版本绑定（原订单保留 v1）+ 采购价表二审 7 天版 + 退款倒扣核对",
        "owner": "销售主管",
        "applicable_version": RELEASE_VERSION,
        "video_wiki_url": wiki_url("main_video"),
        "video_title": "销售工作台-全量业务与研发讲解-20261119（章节 20）",
        "timecode": "57:00",
        "video_source_status": "已有 720p 实机演示段（旧音色基线）",
        "wiki_url": wiki_url("sales_spec"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "codex_entry": "#/ops / #/inquiry / #/pricebook / #/cycles / #/commission",
        "skill_name": "sales-ops-pricebook-commission",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请核对当前询单引用报价版本、采购价格表 7 天有效期与本月提成账本退款扣回明细。",
        "expected_evidence": "v1/v2 版本不串单、失效版本禁新建引用、提成与财务对齐。",
        "manual_trigger": "价格表到期需重审、或提成归属争议需主管介入核定时。",
        "manual_fallback_doc": wiki_url("sales_spec"),
        "manual_fallback_video": "",
        "coverage_status": "可用",
        "fallback_status": "Skill 已覆盖无需兜底",
        "gap_reason": "",
        "last_verified_by": "Agent 盘点初筛（待主管确认 V6）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "SALES-ASSIST-15",
        "parent_group": "06｜内外部接待协同与客户沉淀",
        "title": "销售台内部接待 #/reception、5 分钟/15 分钟超时排他接管 #/assist 与 #/crm",
        "workbench": "销售工作台",
        "scope": "sales",
        "roles": ["销售业务员", "销售主管"],
        "route_entry": "#/assist",
        "help_keys": ["reception", "assist", "crm", "crm-main", "rc-agent", "rc-guard", "rc-link", "as-find", "as-list", "as-media", "as-note", "as-slot"],
        "business_basis": "外包与内部协同接力契约（排他锁 + 130% 成本红线 + 大客户池沉淀）",
        "owner": "销售主管",
        "applicable_version": RELEASE_VERSION,
        "video_wiki_url": wiki_url("main_video"),
        "video_title": "销售工作台-全量业务与研发讲解-20261119（章节 13）",
        "timecode": "34:18",
        "video_source_status": "已有 720p 实机演示段（旧音色基线）",
        "wiki_url": wiki_url("sales_spec"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "codex_entry": "#/reception & #/assist & #/crm → 认领外包升级单并附交还备注",
        "skill_name": "sales-internal-assist-takeover",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请汇总当前待接管外包会话的上下文与成本底线，准备给外包坐席的黄色幕后锦囊或交还备注。",
        "expected_evidence": "排他锁交接日志完整、毛利底线未泄密、高意向客户入 CRM。",
        "manual_trigger": "买家要求大额折让突破 130% 红线、或出现恶意差评威胁。",
        "manual_fallback_doc": wiki_url("handoff"),
        "manual_fallback_video": "",
        "coverage_status": "可用",
        "fallback_status": "Skill 已覆盖无需兜底",
        "gap_reason": "",
        "last_verified_by": "Agent 盘点初筛（待主管确认 V6）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "CS-ONBOARD-01",
        "parent_group": "07｜外部客服独立视图（单应用合并入销售工作台）",
        "title": "外部客服·新人首日 3 关情景通关与三栏极简上岗",
        "workbench": "销售工作台",
        "scope": "cs",
        "roles": ["外部外包客服", "客服新人", "销售业务员", "销售主管"],
        "route_entry": "?as=cs_newbie 或 #/cs-workbench",
        "help_keys": ["learn", "newbie_sandbox"],
        "business_basis": "60 秒 3 关防踩坑通关门禁（缺实拍/砍价/站外引流）＋物理脱敏三栏极简工作台",
        "owner": "客服/销售主管",
        "applicable_version": CS_TUTORIAL_VERSION,
        "video_wiki_url": wiki_url("G53mjyd80pDo1GmEczlNNNey86zbX04v"),
        "video_title": "CS-ONBOARD-01｜外部新人客服3关情景通关与三栏极简上岗（Serena 1080p 独立成片）",
        "timecode": "00:00",
        "video_source_status": "待人工复核 · Serena 官方预置音色 1080p 独立成片已回读校验（00:00 起播）",
        "wiki_url": "https://alidocs.dingtalk.com/i/nodes/ZQYprEoWonANyZL4iXDa0lOZ81waOeDk?utm_scene=team_space",
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "local_video_url": "/cs-tutorials/CS-ONBOARD-01.mp4",
        "source_url": wiki_url("NkDwLng8ZLDqxG6gcpxGd00jVKMEvZBY"),
        "source_wiki_url": wiki_url("NkDwLng8ZLDqxG6gcpxGd00jVKMEvZBY"),
        "revision": CS_TUTORIAL_VERSION,
        "human_review_status": "pending",
        "external_review_status": "none",
        "external_reference": {},
        "codex_entry": "?as=cs_newbie → 锁定横幅「立即去做 3 关练习解锁」或「？」→ 本节点独立子页",
        "skill_name": "cs-first-day-3step-gate",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请核查周小萌（cs_newbie）3 关练习门禁状态，确认外包视角仅展示脱敏 CS 节点且非授权内部接口返回 403。",
        "expected_evidence": "完成 3 关情景演练后保护锁自动解除，仅加载脱敏客服节点，内部选品/成本返回 403。",
        "manual_trigger": "3 关练习连续卡关、页面误显内部拿货价或需要重温三栏动线时。",
        "manual_fallback_doc": "https://alidocs.dingtalk.com/i/nodes/ZQYprEoWonANyZL4iXDa0lOZ81waOeDk?utm_scene=team_space",
        "manual_fallback_video": wiki_url("G53mjyd80pDo1GmEczlNNNey86zbX04v"),
        "coverage_status": "待人工复核",
        "fallback_status": "已配兜底",
        "gap_reason": "",
        "last_verified_by": "Agent 字节校验上传（待人工复核）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "CS-REALSHOT-01",
        "parent_group": "07｜外部客服独立视图（单应用合并入销售工作台）",
        "title": "外部客服·三栏极简接待、WMS 四关全绿选机与一件一拍直发",
        "workbench": "销售工作台",
        "scope": "cs",
        "roles": ["外部外包客服", "客服新人", "销售业务员", "销售主管"],
        "route_entry": "#/cs-workbench（售前标签）",
        "help_keys": ["chat", "copilot_card"],
        "business_basis": "并入客服 V3：发货前必须在 WMS 挑四关全绿单品发实拍图与通电视频（缺视频 60s 催仓管）",
        "owner": "客服/销售主管",
        "applicable_version": CS_TUTORIAL_VERSION,
        "video_wiki_url": wiki_url("pGBa2Lm8aGpqdKP2hREXArGoVgN7R35y"),
        "video_title": "CS-REALSHOT-01｜三栏极简接待、WMS四关全绿选机与一件一拍直发（Serena 1080p 独立成片）",
        "timecode": "00:00",
        "video_source_status": "待人工复核 · Serena 官方预置音色 1080p 独立成片已回读校验（00:00 起播）",
        "wiki_url": wiki_url("Exel2BLV5zkl16Oeu7mNpgjRJgk9rpMq"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "local_video_url": "/cs-tutorials/CS-REALSHOT-01.mp4",
        "source_url": wiki_url("b9Y4gmKWrP5pynLDTrjwgg00JGXn6lpz"),
        "source_wiki_url": wiki_url("b9Y4gmKWrP5pynLDTrjwgg00JGXn6lpz"),
        "revision": CS_TUTORIAL_VERSION,
        "human_review_status": "pending",
        "external_review_status": "none",
        "external_reference": {},
        "codex_entry": "#/cs-workbench（或 ?as=outsource_lu）→ 顶部/右栏「？」→ CS-REALSHOT-01 专属子页",
        "skill_name": "cs-pre-ship-realshot-select",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请帮我核对这笔待发货订单在右栏同款槽位里哪台四关全绿可用，并生成发货前实拍发送检查表。",
        "expected_evidence": "绑定唯一四关全绿货号，买家收到实拍照片+通电视频回执（100% 前置执行）。",
        "manual_trigger": "商品链接认不出 WMS 货号、或仓库同款机器全部缺通电视频超过 60 秒。",
        "manual_fallback_doc": wiki_url("Exel2BLV5zkl16Oeu7mNpgjRJgk9rpMq"),
        "manual_fallback_video": wiki_url("pGBa2Lm8aGpqdKP2hREXArGoVgN7R35y"),
        "coverage_status": "待人工复核",
        "fallback_status": "已配兜底",
        "gap_reason": "",
        "last_verified_by": "Agent 字节校验上传（待人工复核）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "CS-WARRANTY-02",
        "parent_group": "07｜外部客服独立视图（单应用合并入销售工作台）",
        "title": "外部客服·富阳法院保修激活卡自动触发与静默推仓发问毫秒熔断",
        "workbench": "销售工作台",
        "scope": "cs",
        "roles": ["外部外包客服", "客服新人", "销售业务员", "销售主管"],
        "route_entry": "#/cs-workbench（售前 · 自动发图与自动发货池）",
        "help_keys": ["warranty_card", "auto_ship", "autoship", "auto_rules"],
        "business_basis": "发货前自动发「杭州市富阳区人民法院管辖」保修激活卡＋30 分钟静默观察＋买家发问毫秒暂停",
        "owner": "客服/销售主管",
        "applicable_version": CS_TUTORIAL_VERSION,
        "video_wiki_url": wiki_url("Exel2BLV5zkl16Oeu7mNvXgPJgk9rpMq"),
        "video_title": "CS-WARRANTY-02｜富阳法院保修激活卡自动触发与静默发问毫秒熔断（Serena 1080p 独立成片）",
        "timecode": "00:00",
        "video_source_status": "待人工复核 · Serena 官方预置音色 1080p 独立成片已回读校验（00:00 起播）",
        "wiki_url": wiki_url("1DKw2zgV2PMoYdjETdPl3BkG8B5r9YAn"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "local_video_url": "/cs-tutorials/CS-WARRANTY-02.mp4",
        "source_url": wiki_url("dxXB52LJqn5XymZ9i2MD3kg78qjMp697"),
        "source_wiki_url": wiki_url("dxXB52LJqn5XymZ9i2MD3kg78qjMp697"),
        "revision": CS_TUTORIAL_VERSION,
        "human_review_status": "pending",
        "external_review_status": "none",
        "external_reference": {},
        "codex_entry": "#/cs-workbench → 顶栏「🖼 自动发图」/「📦 自动发货池」→「？」专属子页",
        "skill_name": "cs-warranty-silent-ship-fuse",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请检查该订单保修激活卡与杭州市富阳区人民法院管辖条款是否发出、买家是否在观察期内发问触发熔断暂停。",
        "expected_evidence": "保修激活卡确认流水或发问熔断红警响应记录与 WAVE 波次推仓单号。",
        "manual_trigger": "买家不同意保修管辖条款、或在静默期突然发问质疑机器成色故障。",
        "manual_fallback_doc": wiki_url("1DKw2zgV2PMoYdjETdPl3BkG8B5r9YAn"),
        "manual_fallback_video": wiki_url("Exel2BLV5zkl16Oeu7mNvXgPJgk9rpMq"),
        "coverage_status": "待人工复核",
        "fallback_status": "已配兜底",
        "gap_reason": "",
        "last_verified_by": "Agent 字节校验上传（待人工复核）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "CS-REFUND-409-03",
        "parent_group": "07｜外部客服独立视图（单应用合并入销售工作台）",
        "title": "外部客服·0 秒退款三步引导图、409 红屏急停锁打包面单与永久禁关单",
        "workbench": "销售工作台",
        "scope": "cs",
        "roles": ["外部外包客服", "客服新人", "销售业务员", "销售主管"],
        "route_entry": "#/cs-workbench（售后标签）",
        "help_keys": ["auto_refund", "emergency_intercept"],
        "business_basis": "0 秒自动发退款理由图＋拣货台 409 红屏拦截＋永久禁卖方主动关单（鱼力值 165 红线）",
        "owner": "客服/销售主管",
        "applicable_version": CS_TUTORIAL_VERSION,
        "video_wiki_url": wiki_url("G53mjyd80pDo1GmEczgxMAP286zbX04v"),
        "video_title": "CS-REFUND-409-03｜退款0秒手机UI三步引导图与WMS 409红屏急停截单（Serena 1080p 独立成片）",
        "timecode": "00:00",
        "video_source_status": "待人工复核 · Serena 官方预置音色 1080p 独立成片已回读校验（00:00 起播）",
        "wiki_url": wiki_url("NkDwLng8ZLDqxG6gcpxGnpvNVKMEvZBY"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "local_video_url": "/cs-tutorials/CS-REFUND-409-03.mp4",
        "source_url": wiki_url("OG9lyrgJPzaqQx70uPzmnKMDWzN67Mw4"),
        "source_wiki_url": wiki_url("OG9lyrgJPzaqQx70uPzmnKMDWzN67Mw4"),
        "revision": CS_TUTORIAL_VERSION,
        "human_review_status": "pending",
        "external_review_status": "none",
        "external_reference": {},
        "codex_entry": "#/cs-workbench 售后标签 → 409 急停处「？」专属子页",
        "skill_name": "cs-refund-409-hard-stop",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "买家申请退款/改地址且货在打包台，请帮我核对 409 急停锁状态与退回原货架指令，绝不主动关闭订单。",
        "expected_evidence": "0 秒退款引导图回执、409 锁面单回执与仓管待归架确认。",
        "manual_trigger": "顺丰快递已被揽收无法 409 拦回、或买家坚持投诉不选「不想要了/协商一致」。",
        "manual_fallback_doc": wiki_url("NkDwLng8ZLDqxG6gcpxGnpvNVKMEvZBY"),
        "manual_fallback_video": wiki_url("G53mjyd80pDo1GmEczgxMAP286zbX04v"),
        "coverage_status": "待人工复核",
        "fallback_status": "已配兜底",
        "gap_reason": "",
        "last_verified_by": "Agent 字节校验上传（待人工复核）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "CS-ESCALATE-05",
        "parent_group": "07｜外部客服独立视图（单应用合并入销售工作台）",
        "title": "外部客服·问题订单三类判别与 60 秒一键跨部门呼救（催仓/呼销售）",
        "workbench": "销售工作台",
        "scope": "cs",
        "roles": ["外部外包客服", "客服新人", "销售业务员", "销售主管"],
        "route_entry": "#/cs-workbench（问题订单标签）",
        "help_keys": ["collab_escalate"],
        "business_basis": "C6 熔断 / C7 缺通电视频 60s 催仓 / C8 链接未绑 WMS 货号＋阻断外部网盘风险链接",
        "owner": "客服/销售主管",
        "applicable_version": CS_TUTORIAL_VERSION,
        "video_wiki_url": wiki_url("gpG2NdyVX3v6oEy9c5GNnA4OWMwvDqPk"),
        "video_title": "CS-ESCALATE-05｜问题订单三类判别与60秒一键跨部门呼救（Serena 1080p 独立成片）",
        "timecode": "00:00",
        "video_source_status": "待人工复核 · Serena 官方预置音色 1080p 独立成片已回读校验（00:00 起播）",
        "wiki_url": wiki_url("vNG4YZ7JnPBj0zyKTo93QoLaW2LD0oRE"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "local_video_url": "/cs-tutorials/CS-ESCALATE-05.mp4",
        "source_url": wiki_url("l6Pm2Db8D49lkzyNiy9lY5qQ8xLq0Ee4"),
        "source_wiki_url": wiki_url("l6Pm2Db8D49lkzyNiy9lY5qQ8xLq0Ee4"),
        "revision": CS_TUTORIAL_VERSION,
        "human_review_status": "pending",
        "external_review_status": "none",
        "external_reference": {},
        "codex_entry": "#/cs-workbench 问题订单标签 / 跨部门协同处「？」专属子页",
        "skill_name": "cs-abnormal-60s-escalate",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请统计今日全部问题订单（C6 熔断 / C7 缺视频 / C8 未绑货号）的 60 秒呼救平均响应时长，并标出超时未接管单据。",
        "expected_evidence": "缺视频 60s 直达仓管补拍、未绑货号 60s 推达内部销售、外部网盘链接 100% 阻断。",
        "manual_trigger": "仓管补拍或内部绑货超过 60 秒无回流、或买家索要网盘附件检验。",
        "manual_fallback_doc": wiki_url("vNG4YZ7JnPBj0zyKTo93QoLaW2LD0oRE"),
        "manual_fallback_video": wiki_url("gpG2NdyVX3v6oEy9c5GNnA4OWMwvDqPk"),
        "coverage_status": "待人工复核",
        "fallback_status": "已配兜底",
        "gap_reason": "",
        "last_verified_by": "Agent 字节校验上传（待人工复核）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "CS-TAKEOVER-06",
        "parent_group": "07｜外部客服独立视图（单应用合并入销售工作台）",
        "title": "内部销售·排他接管锁、超限让利与退回防甩锅交接（陈小满协同台）",
        "workbench": "销售工作台",
        "scope": "cs",
        "roles": ["销售业务员", "销售主管", "外部外包客服"],
        "route_entry": "?as=chenxm#/cs-workbench（工作 → 外部客服）",
        "help_keys": ["takeover_handoff"],
        "business_basis": "销售与客服合入单应用后：内部接管开启排他只读锁防撞单＋超 ¥20 让利＋无效甩锅退回记分",
        "owner": "客服/销售主管",
        "applicable_version": CS_TUTORIAL_VERSION,
        "video_wiki_url": wiki_url("y20BglGWO2ZB6yQRiD0zG96m8A7depqY"),
        "video_title": "CS-TAKEOVER-06｜排他接管锁、超限让利与退回防甩锅交接（Serena 1080p 独立成片）",
        "timecode": "00:00",
        "video_source_status": "待人工复核 · Serena 官方预置音色 1080p 独立成片已回读校验（00:00 起播）",
        "wiki_url": wiki_url("QBnd5ExVEvDlXZQrca2rGeNyJyeZqMmz"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "local_video_url": "/cs-tutorials/CS-TAKEOVER-06.mp4",
        "source_url": wiki_url("GZLxjv9VGqMl2mDpIq1Ln9y386EDybno"),
        "source_wiki_url": wiki_url("GZLxjv9VGqMl2mDpIq1Ln9y386EDybno"),
        "revision": CS_TUTORIAL_VERSION,
        "human_review_status": "pending",
        "external_review_status": "none",
        "external_reference": {},
        "codex_entry": "?as=chenxm#/cs-workbench → 跨部门协同「排他接管」旁「？」专属子页",
        "skill_name": "cs-internal-takeover-handoff",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请审查全部内部销售接管单的排他锁状态记录、>¥20 超限让利审批原因，以及被陈小满退回的无效甩锅详情。",
        "expected_evidence": "接管期间外包端只读锁死无撞话、完结交回外包留痕、无效甩锅入 KPI 审计。",
        "manual_trigger": "买家砍价击穿最低销售底价保护线、或出现双方抢答撞单冲突。",
        "manual_fallback_doc": wiki_url("QBnd5ExVEvDlXZQrca2rGeNyJyeZqMmz"),
        "manual_fallback_video": wiki_url("y20BglGWO2ZB6yQRiD0zG96m8A7depqY"),
        "coverage_status": "待人工复核",
        "fallback_status": "已配兜底",
        "gap_reason": "",
        "last_verified_by": "Agent 字节校验上传（待人工复核）",
        "last_verified_at": "2026-11-24",
    },
    {
        "node_id": "CS-GUARD-KPI-04",
        "parent_group": "07｜外部客服独立视图（单应用合并入销售工作台）",
        "title": "外部客服·防封外发守卫、反作弊雷达与五防全维绩效考核",
        "workbench": "销售工作台",
        "scope": "cs",
        "roles": ["外部外包客服", "客服新人", "销售业务员", "销售主管"],
        "route_entry": "#/cs-workbench（底部外发守卫 + 顶栏「全维考核」）",
        "help_keys": ["kpi", "manual_all"],
        "business_basis": "50s 兜底不计人工回复＋单字 1/手机号/微信双端拦截＋14 项 CSV 结算导出",
        "owner": "客服/销售主管",
        "applicable_version": CS_TUTORIAL_VERSION,
        "video_wiki_url": wiki_url("bva6QBXJwa5myYekU72m756XWn4qY5Pr"),
        "video_title": "CS-GUARD-KPI-04｜外发合规守卫、防作弊与五防绩效考核口径（Serena 1080p 独立成片）",
        "timecode": "00:00",
        "video_source_status": "待人工复核 · Serena 官方预置音色 1080p 独立成片已回读校验（00:00 起播）",
        "wiki_url": wiki_url("yQod3RxJKGXlx0zahY4ABMXRJkb4Mw9r"),
        "h5_url": wiki_url("sales_h5"),
        "pdf_url": wiki_url("employee_pdf"),
        "local_video_url": "/cs-tutorials/CS-GUARD-KPI-04.mp4",
        "source_url": wiki_url("1zknDm0WRanqQP0YUdxPRgv38BQEx5rG"),
        "source_wiki_url": wiki_url("1zknDm0WRanqQP0YUdxPRgv38BQEx5rG"),
        "revision": CS_TUTORIAL_VERSION,
        "human_review_status": "pending",
        "external_review_status": "none",
        "external_reference": {},
        "codex_entry": "#/cs-workbench → 顶栏「全维考核 ▾」→ 五防口径「？」专属子页",
        "skill_name": "cs-outbound-guard-and-kpi",
        "skill_status": "Skill 已核",
        "codex_prompt_hint": "请导出今日全坐席外发守卫拦截明细、50s 兜底挂机剔除原因，生成可供财务与主管复核的 14 项指标 CSV 核对单。",
        "expected_evidence": "站外微信/手机 0 放行、3 分人工率剔除 50s 挂机水分、CSV 结算可回溯。",
        "manual_trigger": "谐音字绕过风控、或对群控延迟与绩效扣除口径有异议需主管复核。",
        "manual_fallback_doc": wiki_url("yQod3RxJKGXlx0zahY4ABMXRJkb4Mw9r"),
        "manual_fallback_video": wiki_url("bva6QBXJwa5myYekU72m756XWn4qY5Pr"),
        "coverage_status": "待人工复核",
        "fallback_status": "已配兜底",
        "gap_reason": "",
        "last_verified_by": "Agent 字节校验上传（待人工复核）",
        "last_verified_at": "2026-11-24",
    },
]


def resolve_actor_role(actor_id: str) -> tuple[str, str]:
    aid = (actor_id or "chenxm").strip().lower()
    if aid in OUTSOURCE_ACTORS:
        return "outsource_cs", "外部外包客服（隔离独立视图）"
    if aid in SUPERVISOR_ACTORS:
        return "supervisor", "销售/业务主管（全量可维护）"
    return "sales", "内部销售业务员（全量只读消费）"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tutorial_meta (
            key TEXT PRIMARY KEY,
            val TEXT NOT NULL
        );
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tutorial_nodes (
            node_id TEXT PRIMARY KEY,
            sort_order INTEGER NOT NULL,
            parent_group TEXT NOT NULL,
            title TEXT NOT NULL,
            workbench TEXT NOT NULL,
            scope TEXT NOT NULL CHECK (scope IN ('shared', 'sales', 'cs')),
            roles_json TEXT NOT NULL,
            route_entry TEXT NOT NULL,
            help_keys_json TEXT NOT NULL,
            business_basis TEXT NOT NULL,
            owner TEXT NOT NULL,
            applicable_version TEXT NOT NULL,
            video_wiki_url TEXT NOT NULL,
            video_title TEXT NOT NULL,
            timecode TEXT NOT NULL,
            video_source_status TEXT NOT NULL,
            wiki_url TEXT NOT NULL,
            h5_url TEXT NOT NULL,
            pdf_url TEXT NOT NULL,
            codex_entry TEXT NOT NULL,
            skill_name TEXT NOT NULL,
            skill_status TEXT NOT NULL,
            codex_prompt_hint TEXT NOT NULL,
            expected_evidence TEXT NOT NULL,
            manual_trigger TEXT NOT NULL,
            manual_fallback_doc TEXT NOT NULL,
            manual_fallback_video TEXT NOT NULL,
            coverage_status TEXT NOT NULL,
            fallback_status TEXT NOT NULL,
            gap_reason TEXT NOT NULL,
            last_verified_by TEXT NOT NULL,
            last_verified_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            source_url TEXT NOT NULL DEFAULT '',
            source_wiki_url TEXT NOT NULL DEFAULT '',
            local_video_url TEXT NOT NULL DEFAULT '',
            revision TEXT NOT NULL DEFAULT '',
            human_review_status TEXT NOT NULL DEFAULT 'pending',
            external_review_status TEXT NOT NULL DEFAULT 'none',
            external_reference_json TEXT NOT NULL DEFAULT '{}'
        );
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tutorial_history (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            node_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            actor TEXT NOT NULL,
            action TEXT NOT NULL,
            summary TEXT NOT NULL,
            before_status TEXT NOT NULL DEFAULT '',
            after_status TEXT NOT NULL DEFAULT ''
        );
        """
    )
    existing_cols = {r[1] for r in conn.execute("PRAGMA table_info(tutorial_nodes)").fetchall()}
    extra_cols = [
        ("source_url", "TEXT NOT NULL DEFAULT ''"),
        ("source_wiki_url", "TEXT NOT NULL DEFAULT ''"),
        ("local_video_url", "TEXT NOT NULL DEFAULT ''"),
        ("revision", "TEXT NOT NULL DEFAULT 'sales-v6-20261124-r1'"),
        ("human_review_status", "TEXT NOT NULL DEFAULT 'pending'"),
        ("external_review_status", "TEXT NOT NULL DEFAULT 'none'"),
        ("external_reference_json", "TEXT NOT NULL DEFAULT '{}'"),
    ]
    for col_name, col_def in extra_cols:
        if col_name not in existing_cols:
            conn.execute(f"ALTER TABLE tutorial_nodes ADD COLUMN {col_name} {col_def};")
    return conn


CONN = _connect()


def _seed_db(conn: sqlite3.Connection, force: bool = False) -> None:
    row = conn.execute("SELECT val FROM tutorial_meta WHERE key = 'seed_version'").fetchone()
    if not force and row and row[0] == SEED_VERSION:
        return
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if force:
        conn.execute("DELETE FROM tutorial_nodes")
    else:
        all_ids = [n["node_id"] for n in SEED_NODES]
        placeholders = ",".join("?" for _ in all_ids)
        conn.execute(
            f"DELETE FROM tutorial_nodes WHERE node_id NOT IN ({placeholders})",
            all_ids,
        )
    for idx, n in enumerate(SEED_NODES, 1):
        params = (
            n["node_id"],
            idx,
            n["parent_group"],
            n["title"],
            n["workbench"],
            n["scope"],
            json.dumps(n["roles"], ensure_ascii=False),
            n["route_entry"],
            json.dumps(n["help_keys"], ensure_ascii=False),
            n["business_basis"],
            n["owner"],
            n["applicable_version"],
            n["video_wiki_url"],
            n["video_title"],
            n["timecode"],
            n["video_source_status"],
            n["wiki_url"],
            n["h5_url"],
            n["pdf_url"],
            n["codex_entry"],
            n["skill_name"],
            n["skill_status"],
            n["codex_prompt_hint"],
            n["expected_evidence"],
            n["manual_trigger"],
            n["manual_fallback_doc"],
            n["manual_fallback_video"],
            n["coverage_status"],
            n["fallback_status"],
            n["gap_reason"],
            n["last_verified_by"],
            n["last_verified_at"],
            now,
            n.get("source_url") or n.get("source_wiki_url", ""),
            n.get("source_wiki_url") or n.get("source_url", ""),
            n.get("local_video_url", ""),
            n.get("revision", ""),
            n.get("human_review_status", ""),
            n.get("external_review_status", "none"),
            json.dumps(n.get("external_reference") or {}, ensure_ascii=False),
        )
        conflict_sql = """ON CONFLICT(node_id) DO UPDATE SET
                sort_order = excluded.sort_order,
                parent_group = excluded.parent_group,
                title = excluded.title,
                workbench = excluded.workbench,
                scope = excluded.scope,
                roles_json = excluded.roles_json,
                route_entry = excluded.route_entry,
                help_keys_json = excluded.help_keys_json,
                business_basis = excluded.business_basis,
                owner = excluded.owner,
                applicable_version = excluded.applicable_version,
                video_wiki_url = excluded.video_wiki_url,
                video_title = excluded.video_title,
                timecode = excluded.timecode,
                video_source_status = excluded.video_source_status,
                wiki_url = excluded.wiki_url,
                h5_url = excluded.h5_url,
                pdf_url = excluded.pdf_url,
                codex_entry = excluded.codex_entry,
                skill_name = excluded.skill_name,
                skill_status = excluded.skill_status,
                codex_prompt_hint = excluded.codex_prompt_hint,
                expected_evidence = excluded.expected_evidence,
                manual_trigger = excluded.manual_trigger,
                manual_fallback_doc = excluded.manual_fallback_doc,
                manual_fallback_video = excluded.manual_fallback_video,
                coverage_status = excluded.coverage_status,
                fallback_status = excluded.fallback_status,
                gap_reason = excluded.gap_reason,
                last_verified_by = excluded.last_verified_by,
                last_verified_at = excluded.last_verified_at,
                updated_at = excluded.updated_at,
                source_url = excluded.source_url,
                source_wiki_url = excluded.source_wiki_url,
                local_video_url = excluded.local_video_url,
                revision = excluded.revision,
                human_review_status = excluded.human_review_status,
                external_review_status = excluded.external_review_status,
                external_reference_json = excluded.external_reference_json"""
        conn.execute(
            f"""
            INSERT INTO tutorial_nodes (
                node_id, sort_order, parent_group, title, workbench, scope,
                roles_json, route_entry, help_keys_json, business_basis, owner,
                applicable_version, video_wiki_url, video_title, timecode,
                video_source_status, wiki_url, h5_url, pdf_url, codex_entry,
                skill_name, skill_status, codex_prompt_hint, expected_evidence,
                manual_trigger, manual_fallback_doc, manual_fallback_video,
                coverage_status, fallback_status, gap_reason, last_verified_by,
                last_verified_at, updated_at,
                source_url, source_wiki_url, local_video_url, revision,
                human_review_status, external_review_status, external_reference_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            {conflict_sql};
            """,
            params,
        )
    conn.execute(
        """
        INSERT INTO tutorial_meta (key, val) VALUES ('seed_version', ?)
        ON CONFLICT(key) DO UPDATE SET val = excluded.val;
        """,
        (SEED_VERSION,),
    )
    conn.execute(
        """
        INSERT INTO tutorial_history (node_id, created_at, actor, action, summary, before_status, after_status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "SALES-SHARED-00",
            now,
            "system",
            "cs7_upgrade",
            f"外部客服（并入销售独立视图）7 个独立节点升级为 00:00 起播独立 1080p Serena 成片 + 专属 Wiki 子页 + 可编辑源码包（保留上游 SALES-* 未改 · 种子 {SEED_VERSION}）",
            "旧复用章节/断链",
            "待人工复核",
        ),
    )
    conn.commit()


with DB_LOCK:
    _seed_db(CONN, force=False)


_NODE_COLS = [
    "node_id", "sort_order", "parent_group", "title", "workbench", "scope",
    "roles_json", "route_entry", "help_keys_json", "business_basis", "owner",
    "applicable_version", "video_wiki_url", "video_title", "timecode",
    "video_source_status", "wiki_url", "h5_url", "pdf_url", "codex_entry",
    "skill_name", "skill_status", "codex_prompt_hint", "expected_evidence",
    "manual_trigger", "manual_fallback_doc", "manual_fallback_video",
    "coverage_status", "fallback_status", "gap_reason", "last_verified_by",
    "last_verified_at", "updated_at",
    "source_url", "source_wiki_url", "local_video_url", "revision",
    "human_review_status", "external_review_status", "external_reference_json",
]
_SELECT_COLS = ", ".join(_NODE_COLS)


def _row_to_node(r) -> dict:
    raw = dict(zip(_NODE_COLS, r))
    raw["source_wiki_url"] = raw.get("source_wiki_url") or raw.get("source_url") or ""
    raw["source_url"] = raw.get("source_url") or raw.get("source_wiki_url") or ""
    raw["review_status"] = "待人工复核" if raw.get("human_review_status") != "reviewed" else "已人工复核"
    raw["roles"] = json.loads(raw.pop("roles_json"))
    raw["help_keys"] = json.loads(raw.pop("help_keys_json"))
    ext_raw = raw.pop("external_reference_json", "{}")
    try:
        raw["external_reference"] = json.loads(ext_raw) if ext_raw else {}
    except Exception:
        raw["external_reference"] = {}
    raw["index_url"] = wiki_url("tutorial_index") or "#/tutorials"
    return raw


def _json_resp(code: int, obj: dict) -> tuple[int, str, bytes]:
    return code, "application/json; charset=utf-8", json.dumps(obj, ensure_ascii=False).encode("utf-8")


def _extract_actor(headers, params: dict, body: dict | None = None) -> str:
    if params.get("actor"):
        return str(params["actor"][0]).strip()
    if body and body.get("actor"):
        return str(body["actor"]).strip()
    if headers:
        for h in ("X-ERP-Actor", "X-CS-Actor"):
            val = headers.get(h)
            if val:
                return str(val).strip()
    return "chenxm"


def _can_access_node(role: str, node: dict) -> bool:
    if role == "outsource_cs":
        return node["scope"] in ("shared", "cs")
    return True


def _build_summary(nodes: list[dict]) -> dict:
    total = len(nodes)
    usable = sum(1 for n in nodes if n["coverage_status"] == "可用")
    gaps = sum(1 for n in nodes if n["coverage_status"] != "可用")
    skill_verified = sum(1 for n in nodes if n["skill_status"] == "Skill 已核")
    with_fallback = sum(1 for n in nodes if n["fallback_status"] == "已配兜底")
    cs_count = sum(1 for n in nodes if n["scope"] == "cs")
    return {
        "total": total,
        "usable": usable,
        "gaps": gaps,
        "skillVerified": skill_verified,
        "withFallback": with_fallback,
        "csCount": cs_count,
    }


def handle_tutorial_request(
    method: str, raw_path: str, headers, body_bytes: bytes = b""
) -> tuple[int, str, bytes] | None:
    """处理 /api/tutorials/* 请求；非台账路由返回 None。"""
    parsed = urlparse(raw_path)
    path = unquote(parsed.path)
    if not path.startswith("/api/tutorials/"):
        return None
    params = parse_qs(parsed.query)

    if method == "GET":
        actor_id = _extract_actor(headers, params)
        role, role_label = resolve_actor_role(actor_id)

        if path == "/api/tutorials/ledger":
            req_scope = (params.get("scope") or ["all"])[0].strip()
            if role == "outsource_cs" and req_scope == "sales":
                return _json_resp(
                    403,
                    {
                        "ok": False,
                        "error": "权限隔离拦截：外部外包客服仅可访问独立客服视图与公司共用开场，禁止访问内部销售节点。",
                    },
                )
            with DB_LOCK:
                rows = CONN.execute(
                    f"SELECT {_SELECT_COLS} FROM tutorial_nodes ORDER BY sort_order ASC"
                ).fetchall()
                history_rows = CONN.execute(
                    "SELECT seq, node_id, created_at, actor, action, summary, before_status, after_status "
                    "FROM tutorial_history ORDER BY seq DESC LIMIT 30"
                ).fetchall()
            all_visible = [
                _row_to_node(r)
                for r in rows
                if _can_access_node(role, _row_to_node(r))
            ]
            if req_scope == "cs":
                filtered = [n for n in all_visible if n["scope"] in ("cs", "shared")]
            elif req_scope == "sales" and role != "outsource_cs":
                filtered = [n for n in all_visible if n["scope"] in ("sales", "shared")]
            elif req_scope == "gaps":
                filtered = [n for n in all_visible if n["coverage_status"] != "可用"]
            else:
                filtered = all_visible

            history = [
                {
                    "seq": h[0],
                    "nodeId": h[1],
                    "createdAt": h[2],
                    "actor": h[3],
                    "action": h[4],
                    "summary": h[5],
                    "beforeStatus": h[6],
                    "afterStatus": h[7],
                }
                for h in history_rows
                if role != "outsource_cs" or h[1].startswith(("CS-", "SALES-SHARED"))
            ]
            return _json_resp(
                200,
                {
                    "ok": True,
                    "actor": actor_id,
                    "role": role,
                    "roleLabel": role_label,
                    "canEdit": role == "supervisor",
                    "allowedViews": ["cs", "gaps"] if role == "outsource_cs" else ["all", "sales", "cs", "gaps"],
                    "version": RELEASE_VERSION,
                    "indexUrl": wiki_url("tutorial_index"),
                    "employeePdfUrl": wiki_url("employee_pdf"),
                    "summary": _build_summary(all_visible),
                    "nodes": filtered,
                    "history": history,
                },
            )

        if path.startswith("/api/tutorials/node/"):
            node_id = path[len("/api/tutorials/node/"):].strip("/")
            with DB_LOCK:
                row = CONN.execute(
                    f"SELECT {_SELECT_COLS} FROM tutorial_nodes WHERE node_id = ?", (node_id,)
                ).fetchone()
                if not row:
                    return _json_resp(404, {"ok": False, "error": f"未找到节点 {node_id}"})
                node = _row_to_node(row)
                if not _can_access_node(role, node):
                    return _json_resp(
                        403,
                        {
                            "ok": False,
                            "error": f"权限隔离拦截：外部客服无权读取内部销售节点 {node_id}",
                        },
                    )
                hist = CONN.execute(
                    "SELECT seq, node_id, created_at, actor, action, summary, before_status, after_status "
                    "FROM tutorial_history WHERE node_id = ? ORDER BY seq DESC LIMIT 20",
                    (node_id,),
                ).fetchall()
            return _json_resp(
                200,
                {
                    "ok": True,
                    "actor": actor_id,
                    "role": role,
                    "canEdit": role == "supervisor",
                    "node": node,
                    "history": [
                        {
                            "seq": h[0],
                            "nodeId": h[1],
                            "createdAt": h[2],
                            "actor": h[3],
                            "action": h[4],
                            "summary": h[5],
                            "beforeStatus": h[6],
                            "afterStatus": h[7],
                        }
                        for h in hist
                    ],
                },
            )

        if path.startswith("/api/tutorials/by-help/"):
            help_key = path[len("/api/tutorials/by-help/"):].strip("/")
            with DB_LOCK:
                rows = CONN.execute(
                    f"SELECT {_SELECT_COLS} FROM tutorial_nodes ORDER BY sort_order ASC"
                ).fetchall()
            all_nodes = [_row_to_node(r) for r in rows]
            matched = None
            if role == "outsource_cs":
                matched = next(
                    (n for n in all_nodes if n["scope"] in ("cs", "shared") and help_key in n["help_keys"]),
                    None,
                )
            if not matched:
                matched = next((n for n in all_nodes if help_key in n["help_keys"]), None)
            if not matched:
                matched = next(
                    (
                        n
                        for n in all_nodes
                        if n["node_id"] == ("CS-REALSHOT-01" if role == "outsource_cs" else "SALES-SHARED-00")
                    ),
                    all_nodes[0] if all_nodes else None,
                )
            if not matched:
                return _json_resp(404, {"ok": False, "error": "台账暂无节点"})
            if not _can_access_node(role, matched):
                return _json_resp(
                    403,
                    {
                        "ok": False,
                        "error": f"权限隔离拦截：外部客服无权访问内部帮助节点 {help_key}",
                    },
                )
            return _json_resp(
                200,
                {
                    "ok": True,
                    "actor": actor_id,
                    "role": role,
                    "node": matched,
                },
            )

        if path == "/api/tutorials/coverage-manifest":
            req_scope = (params.get("scope") or ["all"])[0].strip()
            if role == "outsource_cs" and req_scope == "sales":
                return _json_resp(403, {"ok": False, "error": "权限隔离拦截：外部客服无权读取销售覆盖清单。"})
            with DB_LOCK:
                rows = CONN.execute(
                    f"SELECT {_SELECT_COLS} FROM tutorial_nodes ORDER BY sort_order ASC"
                ).fetchall()
            visible = [
                _row_to_node(r)
                for r in rows
                if _can_access_node(role, _row_to_node(r))
            ]
            if req_scope == "sales" and role != "outsource_cs":
                visible = [n for n in visible if n["scope"] in ("sales", "shared")]
            elif req_scope == "cs":
                visible = [n for n in visible if n["scope"] in ("cs", "shared")]
            cov_entries = []
            for n in visible:
                ent = {
                    "node_id": n["node_id"],
                    "wiki_url": n["wiki_url"],
                    "video_url": n["video_wiki_url"],
                    "timecode": n["timecode"],
                    "scope": n["scope"],
                    "coverage_status": n["coverage_status"],
                    "skill_name": n["skill_name"],
                    "skill_status": n["skill_status"],
                    "fallback_status": n["fallback_status"],
                }
                if n.get("source_wiki_url"):
                    ent["render_project"] = {
                        "source_url": n["source_wiki_url"],
                        "revision": n.get("revision") or "sales-v6-20261124-r1",
                        "human_review_status": n.get("human_review_status") or "pending",
                    }
                if isinstance(n.get("external_reference"), dict) and n["external_reference"].get("source_url"):
                    ent["external_reference"] = n["external_reference"]
                cov_entries.append(ent)
            return _json_resp(
                200,
                {
                    "ok": True,
                    "version": RELEASE_VERSION,
                    "scope": req_scope,
                    "index_url": wiki_url("tutorial_index"),
                    "required_nodes": [n["node_id"] for n in visible],
                    "entries": cov_entries,
                    "summary": _build_summary(visible),
                },
            )

        return _json_resp(404, {"ok": False, "error": "Unknown GET /api/tutorials endpoint"})

    if method in ("POST", "PATCH"):
        try:
            body = json.loads((body_bytes or b"{}").decode("utf-8"))
        except Exception:
            return _json_resp(400, {"ok": False, "error": "Invalid JSON"})
        actor_id = _extract_actor(headers, params, body)
        role, role_label = resolve_actor_role(actor_id)

        if role != "supervisor":
            return _json_resp(
                403,
                {
                    "ok": False,
                    "error": f"权限不足（当前：{role_label}）。只有业务/销售主管可维护与核验教程台账。",
                },
            )

        if path == "/api/tutorials/reset":
            with DB_LOCK:
                CONN.execute("DELETE FROM tutorial_history")
                _seed_db(CONN, force=True)
            return _json_resp(200, {"ok": True, "reset": True, "version": RELEASE_VERSION})

        if path.startswith("/api/tutorials/node/") and path.endswith("/update"):
            node_id = path[len("/api/tutorials/node/"):-len("/update")].strip("/")
            editable = {
                "coverage_status",
                "human_review_status",
                "fallback_status",
                "skill_status",
                "video_wiki_url",
                "video_title",
                "timecode",
                "video_source_status",
                "manual_trigger",
                "manual_fallback_doc",
                "manual_fallback_video",
                "gap_reason",
                "owner",
                "applicable_version",
                "last_verified_by",
                "last_verified_at",
            }
            if "timecode" in body and not re.fullmatch(r"(?:[0-9]{1,2}:)?[0-5][0-9]:[0-5][0-9]", str(body["timecode"])):
                return _json_resp(400, {"ok": False, "error": "时间码格式须为 MM:SS 或 HH:MM:SS"})

            now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            today = datetime.datetime.now().strftime("%Y-%m-%d")
            with DB_LOCK:
                row = CONN.execute(f"SELECT {_SELECT_COLS} FROM tutorial_nodes WHERE node_id = ?", (node_id,)).fetchone()
                if not row:
                    return _json_resp(404, {"ok": False, "error": f"未找到节点 {node_id}"})
                prev = _row_to_node(row)
                updates = {}
                for k in editable:
                    if k in body and body[k] is not None:
                        updates[k] = str(body[k]).strip()
                if not updates:
                    return _json_resp(400, {"ok": False, "error": "未提供任何可更新字段"})
                updates.setdefault("last_verified_by", f"{actor_id}（主管复核）")
                updates.setdefault("last_verified_at", today)
                updates["updated_at"] = now

                set_sql = ", ".join(f"{k} = ?" for k in updates)
                CONN.execute(
                    f"UPDATE tutorial_nodes SET {set_sql} WHERE node_id = ?",
                    [*updates.values(), node_id],
                )
                note = str(body.get("note") or "").strip()
                summary = note or (
                    f"主管更新 {node_id}：覆盖={updates.get('coverage_status', prev['coverage_status'])}"
                    f"，时间码={updates.get('timecode', prev['timecode'])}"
                )
                CONN.execute(
                    """
                    INSERT INTO tutorial_history (node_id, created_at, actor, action, summary, before_status, after_status)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        node_id,
                        now,
                        actor_id,
                        "supervisor_verify_update",
                        summary,
                        prev["coverage_status"],
                        updates.get("coverage_status", prev["coverage_status"]),
                    ),
                )
                CONN.commit()
                new_row = CONN.execute(f"SELECT {_SELECT_COLS} FROM tutorial_nodes WHERE node_id = ?", (node_id,)).fetchone()
                hist = CONN.execute(
                    "SELECT seq, node_id, created_at, actor, action, summary, before_status, after_status "
                    "FROM tutorial_history WHERE node_id = ? ORDER BY seq DESC LIMIT 20",
                    (node_id,),
                ).fetchall()
            return _json_resp(
                200,
                {
                    "ok": True,
                    "node": _row_to_node(new_row),
                    "history": [
                        {
                            "seq": h[0],
                            "nodeId": h[1],
                            "createdAt": h[2],
                            "actor": h[3],
                            "action": h[4],
                            "summary": h[5],
                            "beforeStatus": h[6],
                            "afterStatus": h[7],
                        }
                        for h in hist
                    ],
                },
            )

        return _json_resp(404, {"ok": False, "error": "Unknown POST /api/tutorials endpoint"})

    return _json_resp(405, {"ok": False, "error": "Method not allowed"})
