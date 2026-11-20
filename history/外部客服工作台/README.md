# 客服工作台 (`yucheng2004/erp-support-workbench`)

本仓库用于独立开发泛亚 **外部客服工作台** 的前后端功能。范围覆盖多平台聚合接待（售前/售后/问题订单）、WMS 一件一拍实拍前置核验、静默自动发货与疑问熔断、分场景自动发图（含富阳法院管辖保修激活卡与退款 3 步手机 UI 引导图）、外包 RBAC 物理脱敏、跨工作台 60 秒协同及 14 项反作弊全维绩效考核。

## 目录说明

- `docs/CS_WORKBENCH_V1_SPEC.md`：**V1 全量研发业务规格、接口映射、验收用例与开工前待确认清单**（截止：`2026-11-22 18:00`）
- `docs/CS_WORKBENCH_DEMO_RUNBOOK.md`：**V1 渐进折叠版 GUI Demo 实跑与自动化校验说明**
- `demo/`：**发起人已确认的 V3 渐进折叠全功能版可运行 GUI Demo**（`cs_server.py` + `源码/` + `tests/verify_cs_closed_loop.py`）
- `server/`、`admin-web/`、`h5/`、`miniprogram/`：自 ERP 集成基线（`9b890c7ec9234a4184c5087ea689bf933c2c7ac7`）拆出的既有会话、客服助手（`chat_assist.py`）与时效统计（`ChatSla.vue`）源码

## 协作与交付规范

- 研发需求、进展、交付与验收统一在[禅道](http://127.0.0.1:8000)原卡管理；提交 PR 时关联对应禅道需求编号与测试证据。
- 业务规则与版本发布入口见钉钉【客服工作台】知识库（`gBVzxOqZ64M8pGOa`），通用研发规范见[程序员知识库](https://alidocs.dingtalk.com/i/spaces/gBVzxO9dJ5Qa4GOa/overview)。
- 生产账号、密钥和真实业务数据留在受管系统，严禁写入代码库。
