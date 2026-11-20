# 台账（`yucheng2004/erp-ledger`）

本仓库用于独立开发台账及全工作台软基建治理总控台功能。当前涵盖：
1. **ERP 模块集成基线（`admin-web/`、`server/`）**：原路径保留来自 ERP 集成基线 `9b890c7ec9234a4184c5087ea689bf933c2c7ac7` 的模块源码，方便提出模块 PR 并集成回 ERP 共用底座（登录、共用组件、PostgreSQL 数据库和跨模块集成）。
2. **老板全量台账与全工作台治理总控台 · Demo V3 正式发单参考基线（`demo-v3/`、`specs/`）**：
   - 可检索业务与技术规格书：[`specs/SPEC_V3.md`](./specs/SPEC_V3.md)
   - 本地运行与 17 套端到端验收说明：[`specs/RUNBOOK_V3.md`](./specs/RUNBOOK_V3.md)
   - 统一双视角与 V3 变更说明 H5：[`specs/台账-V3-统一需求与双视角交接.html`](./specs/台账-V3-统一需求与双视角交接.html)
   - 完整可运行四端十视角 GUI Demo 与 PostgreSQL 迁移脚本（`041`~`046`）：[`demo-v3/`](./demo-v3/)

## 协作与发单约定

- 需求单及验收统一走[禅道](http://127.0.0.1:8000)（私有产品 `#8 老板工作台` / 项目 `#9 老板工作台`）。提交 PR 时附对应禅道需求编号及 7 类验收材料。
- 台账专属业务说明与发布入口在[泛亚｜台账知识库](https://alidocs.dingtalk.com/i/spaces/gBVzxOg3vJ2RqGOa/overview)；跨工作台共用规范在[程序员知识库](https://alidocs.dingtalk.com/i/spaces/gBVzxO9dJ5Qa4GOa/overview)。
- 跨模块联调用约定的接口、脱敏样例和必要的联调资料。生产账号、主密钥（`.vault_master.key` / KMS）和真实业务数据留在受管系统，严禁提交 Git。

## 快速自检 Demo V3 基线

```bash
# 运行全部 17 套端到端回归测试（零外部依赖）
python3 demo-v3/tests/verify_ledger_all.py

# 启动本地四端十视角 GUI（默认 http://127.0.0.1:5370）
bash demo-v3/启动全量台账.sh
```
