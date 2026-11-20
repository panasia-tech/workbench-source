# CloudBase → MySQL 数据迁移工具集

把 `wms-8g7f6vae1ef8f780` 环境的 NoSQL 集合迁移到本地 MySQL。
约 27 张本地新表已通过 Alembic `024_cloudbase_migration` 创建。

## 决策摘要(执行时遵循)

| 项 | 处理方式 |
|---|---|
| 历史数据 | **全量导入**(`event_log` 8.4w / `logistics_track_events` 8k 全部入库) |
| 金额单位 | 云端 `*Fen` → 本地 **元**,`Numeric(12,2)`,自动 ÷100 + 2 位小数 |
| 软删除 | 云端 `isDeleted/deleted=true` 的文档**直接跳过**,不入库 |
| `issue_tickets` | **合并到 inspection.mismatch_remark**(不新建表) |
| `idempotency_records / sessions / backup_snapshots / login_failures / legacy_inventory_snapshot* / sys_user / sys_department` | **不迁移** |
| `employee_wechat_bindings` | 字段已并入 `staff.openid`,不单独建表 |

## 目录结构

```
server/scripts/migration/
├── README.md                此文件
├── common.py                字段/时间/金额转换 + ID 映射 + JSONL 读取
├── fetch_cloud.py           调用 tcb-cli 把云端 collection 导出到 data/cloud_dump/<col>.jsonl
├── run_migration.py         主入口,按依赖拓扑执行所有 ETL step
└── etl/
    ├── __init__.py          所有 step 的注册中心(STEPS 列表)
    ├── users_payment.py     users + payment_accounts(其他模块的依赖)
    ├── purchase.py          purchase_orders → purchase_order
    ├── sales.py             sales_orders → sale_order
    ├── items.py             items → sku(自动生成占位 inspection)
    ├── inventory.py         inventory_ledger → stock_event
    ├── xianyu.py            xianyu_listings → sku_listing_info
    ├── payment_txn.py       payment_bindings + payment_transactions
    ├── audit.py             audit_runs + audit_tasks + audit_issues
    ├── ops.py               ops_tasks
    ├── negotiation.py       negotiation_tasks
    ├── slow_moving.py       slow_moving_restock_records
    ├── price_adjustment.py  price_adjustments + price_adjustment_logs
    ├── inventory_req.py     inventory_manual_requests + inventory_listing_tasks
    ├── asset.py             asset_devices / tasks / records / reduction_requests
    ├── schedule.py          staff_schedule_logs / overrides / holiday_requests
    ├── todo.py              todo_task_templates / assignments / logs
    ├── api_key.py           llm_api_keys → api_key
    ├── export.py            export_tasks → export_task
    ├── event_log.py         event_log (按 2000 条分批 commit)
    ├── logistics.py         logistics_track_events (按 2000 条分批 commit)
    └── issue_merge.py       issue_tickets → inspection.mismatch_remark
```

## 执行流程

### 1. 先跑 Alembic 升级,建表

```bash
cd server
alembic upgrade head
```

预期输出包含 `Running upgrade 023_ai_redraw -> 024_cloudbase_migration`。

### 2. 导出云端数据到 JSONL

```bash
# 安装 tcb CLI(如未安装)
npm i -g @cloudbase/cli
tcb login

# 全部导出
python3 -m scripts.migration.fetch_cloud --all

# 或单个集合
python3 -m scripts.migration.fetch_cloud --collection users --collection items
```

如果你已经从 CloudBase MCP 或控制台手动导出,把 `<collection>.jsonl`
放进 `server/data/cloud_dump/` 即可,无需再跑 fetch_cloud。

JSONL 每行一条文档,顶层有 `_id` 字段。

### 3. 执行 ETL

```bash
# 跑全部,按拓扑顺序
python3 -m scripts.migration.run_migration

# 只跑核心几个 step
python3 -m scripts.migration.run_migration --only users payment_accounts purchase_orders items

# 跳过历史数据
python3 -m scripts.migration.run_migration --skip event_log logistics_track_events

# 只看会跑什么不真写库
python3 -m scripts.migration.run_migration --dry-run
```

ID 映射(cloud_id → local_id)持久化到 `data/cloud_dump/id_map.json`,
可在多次执行间复用,实现增量/补跑。

## 关键约定

### 字段映射(共享转换函数)

| 云端 | 本地 | 处理 |
|---|---|---|
| `{"$date": 1772213912350}` | `DateTime` | `parse_dt()` → UTC naive datetime |
| `amountFen: 15000` | `Numeric(12,2)` | `fen_to_yuan()` → `Decimal('150.00')` |
| `isDeleted=true / deleted=true` | (跳过) | `is_soft_deleted()` 返回 True 时不入库 |
| 32-hex cloud `_id` | 36-uuid local id | `IdMapper.get_or_new()` 自动建映射 |
| 关联字段(`purchaseOrderId` 等) | 本地 FK | `mapper.get("purchase_orders", cloud_id)` |

### 状态映射(部分)

- `users.disabled=true` / `status=DISABLED` → `staff.status=DISABLED`
- `items.status=DELETED` → `sku.status=LOSS`
- `purchase_orders.status=WAIT_INBOUND` → `purchase_order.status=PENDING_INSPECT`
- `sales_orders.status=REVOKED` → `sale_order.status=COMPLETED`

## 已知约束 / 边界

1. **`Sku.purchase_order_id` UNIQUE**:本地模型要求一个采购单只能对应一个 SKU。
   云端如有多个 `items` 共享同一 `purchaseOrderId`,后续插入会被 DB 拒绝。
   迁移时通过 `db.merge` 收敛,实际只保留 ETL 顺序中的最后一条。
   如需 1:N,需要先放宽 `Sku.purchase_order_id` 的唯一约束。
2. **占位 Inspection**:每个 `items` 迁移会**强制生成一条** `inspection`
   (`status=DONE, result=PASSED, inspect_no=INS-MIG-<cloud_id>`),
   以满足 `Sku.inspection_id NOT NULL` 约束。迁移完成后可手工识别这些占位行。
3. **`payment_bindings.entity_id`**:已尝试映射到本地 PO/SO 的 local_id,
   未匹配上时**保留云端原 id 字符串**,后续可在 DB 中通过 join 修正。
4. **`event_log` / `logistics_track_events`**:每 2000 条 commit 一次,
   总耗时 ~5-10 分钟,期间 MySQL session 占用稳定。
5. **`issue_tickets`**:写入 `inspection.mismatch_remark`,
   多条会以 `\n` 追加,内容前缀 `[迁移自 issue_ticket]`。

## 失败排查

| 现象 | 原因 / 处理 |
|---|---|
| `IntegrityError: Duplicate entry` | 大概率已部分迁移,删除 id_map.json + truncate 对应表后重跑;或用 `db.merge` 已经自动处理重复 PK |
| `ForeignKeyViolation` | 上游 step 缺数据。例如 `inventory_ledger` 报错通常因为 `items` 跳过过多 |
| step 找不到 dump 文件 | `data/cloud_dump/<collection>.jsonl` 不存在,run_migration 会 WARNING 跳过 |
| 时间字段为 1970 | 云端 `$date` 是 0,parse_dt 返回 epoch;一般无影响,可在 DB 层过滤 |

## 后续清理

迁移结束后,建议:

```sql
-- 清理占位 inspection 标记
SELECT COUNT(*) FROM inspection WHERE inspect_no LIKE 'INS-MIG-%';

-- 验证金额
SELECT MIN(unit_price), MAX(unit_price), AVG(unit_price) FROM purchase_order;

-- 验证软删除已跳过
SELECT COUNT(*) FROM purchase_order WHERE remark LIKE '%测试垃圾清理%';
-- 预期: 0
```

## 2026-06 字段映射修复与重跑

首轮迁移存在字段错位:货号用了 `sn`(空值退到 32 位 hex,显示乱码)、`model`
被云端灌成了货号、真实序列号 `serialNo` 被忽略、验货单号用本地 UUID 前缀、
商品图只取了 `imageFiles` 截图。`etl/items.py` 与 `etl/purchase.py` 已修正
(货号=goodsCode、序列号=serialNo>sn、model 去伪、图片全量收集、跳过测试数据)。

### 重跑步骤(只需重跑这两个 step)

```bash
cd server

# 1. 预处理:把首轮迁移产生的旧货号先挪开,避免重跑时 UNIQUE 瞬时冲突
#    (迁移 SKU 的特征是占位验货单号 INS-MIG-*)
mysql ... <<'SQL'
UPDATE sku s JOIN inspection i ON s.inspection_id = i.id
SET s.sku_code = CONCAT('MIG~', s.id)
WHERE i.inspect_no LIKE 'INS-MIG-%';
SQL

# 2. 重跑(merge 按 id 幂等覆盖,id_map.json 保持不动)
python3 -m scripts.migration.run_migration --only purchase_orders items

# 3. 清理首轮混入、本次已跳过的测试数据
mysql ... <<'SQL'
DELETE FROM purchase_order WHERE order_no LIKE 'LPO-TEST%' OR external_order_no LIKE 'E2E%';
DELETE FROM sku WHERE serial_number LIKE 'E2ESN%' OR serial_number LIKE 'SN-POC%' OR serial_number LIKE 'SN_CODEX%';
-- 第 1 步挪开后没被重跑覆盖的,就是已不再迁移的残留(软删/测试),一并清掉
DELETE FROM sku WHERE sku_code LIKE 'MIG~%';
SQL
```

### 图片搬运(cloud:// → OSS)

数据库里所有媒体字段仍是 CloudBase fileID(`cloud://...`),新系统无法显示。
需要 `tcb login` 后执行:

```bash
python3 -m scripts.migration.migrate_media --dry-run   # 先看各表统计
python3 -m scripts.migration.migrate_media              # 下载→传 OSS→改写 DB
```

映射缓存在 `data/cloud_dump/media_map.json`,可中断重跑。
