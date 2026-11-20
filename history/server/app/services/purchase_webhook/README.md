# 采购入站 Webhook 对接文档

外部采购服务把采购相关数据推送到本 ERP。本 ERP 为**接收方**，采用 inbox 模式：
验签 → 幂等去重 → 原样落库（`purchase_webhook_event` 表）→ 回 200。业务解析（映射进
采购单等）由下游独立处理，不在收件请求内完成。

## Endpoint

```
POST https://<你的域名>/api/purchase-webhook/ingest
Content-Type: application/json
```

## 请求头

| Header | 说明 |
|---|---|
| `X-Webhook-Timestamp` | 发起时的 unix 秒（字符串） |
| `X-Webhook-Signature` | `sha256=` + `hex(HMAC_SHA256(secret, f"{timestamp}." + <原始body字节>))` |

- 密钥 `secret` 为双方约定的共享密钥（HMAC-SHA256），由我方在 `.secrets` 中配置
  `PURCHASE_WEBHOOK_SECRET`。轮换期我方可同时保留旧密钥 `PURCHASE_WEBHOOK_SECRET_PREV`，
  新旧任一验签通过即可。
- 时间戳与服务器时间之差超过 `PURCHASE_WEBHOOK_TOLERANCE_SECONDS`（默认 300 秒）拒收（防重放）。
- 签名针对**原始请求体字节**计算，请勿对 JSON 重新序列化后再签。

## 请求体（通用信封）

```json
{
  "event_id": "evt_20260703_0001",
  "event_type": "purchase.order.created",
  "occurred_at": "2026-07-03T10:00:00+08:00",
  "data": { }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `event_id` | 是 | 事件全局唯一 ID，用于幂等；重复推送同一 ID 视为同一事件 |
| `event_type` | 否 | 事件类型字符串，取值双方后续约定，我方先不校验 |
| `occurred_at` | 否 | 事件发生时间 ISO8601（带时区最佳） |
| `data` | 否 | 业务负载，我方整体存档，不校验内部结构 |

## 响应

| 场景 | HTTP | Body |
|---|---|---|
| 接收成功 | 200 | `{"code":0,"msg":"ok","id":"<记录id>"}` |
| 重复事件（幂等命中） | 200 | `{"code":0,"msg":"duplicate","id":"<记录id>"}` |
| 验签失败 | 401 | `{"code":401,"msg":"signature mismatch"}` |
| 时间戳过期 | 401 | `{"code":401,"msg":"timestamp expired"}` |
| body 缺 event_id / 非法 JSON | 400 | `{"code":400,"msg":"..."}` |
| webhook 总开关关闭 | 503 | `{"code":503,"msg":"disabled"}` |

**约定：只有 HTTP 2xx 表示我方已可靠收妥，可停止重推。** 收到非 2xx 请做指数退避重试。
我方内部解析失败不影响收件（仍回 2xx），由我方内部补偿。

## 签名示例（Python）

```python
import hashlib, hmac, json, time, requests

SECRET = "DEMO_ONLY_REDACTED"
url = "https://<你的域名>/api/purchase-webhook/ingest"
body = json.dumps({
    "event_id": "evt_20260703_0001",
    "event_type": "purchase.order.created",
    "occurred_at": "2026-07-03T10:00:00+08:00",
    "data": {"order_no": "PO-9"},
}, separators=(",", ":")).encode()  # 用发出的确切字节做签名

ts = str(int(time.time()))
sig = "sha256=" + hmac.new(SECRET.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()

resp = requests.post(url, data=body, headers={
    "Content-Type": "application/json",
    "X-Webhook-Timestamp": ts,
    "X-Webhook-Signature": sig,
})
print(resp.status_code, resp.json())
```

## 管理端（内部，需登录态）

| 接口 | 角色 | 说明 |
|---|---|---|
| `GET /api/purchase-webhook/events` | ADMIN / PURCHASER | 分页查看收件，可按 `status`/`event_type` 过滤 |
| `GET /api/purchase-webhook/events/{id}` | ADMIN / PURCHASER | 查看单条（含原始 payload） |
| `POST /api/purchase-webhook/events/{id}/retry` | ADMIN | 置回 PENDING，供下游重新解析 |
| `POST /api/purchase-webhook/events/{id}/ignore` | ADMIN | 标记为无需处理 |

## 下一阶段（事件类型确定后）

新增 `dispatcher.py`：扫 `status=PENDING` 的事件，按 `event_type` 路由到 handler，
解析成 `PurchaseOrder`/物流等，成功回填 `ref_type`/`ref_id`/`status=DONE`，失败置
`FAILED`+`error`。驱动方式用 systemd timer 定时扫描。
