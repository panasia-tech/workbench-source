from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.routers import (
    workbench,
    chat_assist,
    price_history,
    product_image,
    spu_match,
    guide,
    internal_notify,
    internal_publish_check,
    zentao_link,
    dewatermark,
    account_profile,
    ai_image,
    alipay,
    archive,
    asset,
    asset_intake,
    auth,
    auto_listing,
    bargain,
    practice,
    price_clean,
    config,
    stock_gaps,
    sales_workbench,
    virtual_goods,
    ledger,
    dashboard,
    express,
    feedback,
    finance,
    gc_bind,
    gc_ops,
    inspection,
    inspection_ops,
    inventory,
    lawsuit,
    listing,
    listing_config,
    listing_ws,
    listing_approval,
    market,
    master,
    miaoda,
    ocr,
    oss,
    negotiation,
    negotiation_tasks,
    oidc,
    phone,
    purchase,
    purchase_webhook,
    purchase_platform,
    purchase_price,
    returns,
    sale_payment,
    sales,
    spu,
    sso,
    staff,
    switch_order,
)
from app.config import settings
from app.logging_config import configure_logging
from app.services.oss import OssNotConfiguredError
from app.services.condition_scan import shutdown_executor as shutdown_condition_scan
from app.services.redraw_worker import reclaim_stale_jobs, shutdown_executor

# httpx/httpcore 的 INFO 会把带 query 的完整 URL 打进日志（jscode2session 的 AppSecret）
configure_logging()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    import asyncio
    from contextlib import AsyncExitStack

    reclaim_stale_jobs()
    # 统一登录（ERP 当账号来源）：开了但没配好，启动日志里写清楚缺什么（/api/oidc 回 503，不影响别的功能）
    from app.services import oidc_provider

    oidc_provider.startup_check()
    # OA/台账推送：复位崩溃遗留的 RUNNING 行（导入本模块即注册 after_commit 投递监听器）
    from app.services import oa_push

    oa_push.reclaim_stale()

    # 自提收款：过期单清扫兜底（小程序退出后没人轮询，靠这个撤码/捞漏单）
    from app.services.pickup_payment import run_sweeper_loop

    sweeper_task = asyncio.create_task(run_sweeper_loop())

    # 自动上架：入库登记的流水线由这个常驻协程推着走（开关关着则每轮空转即返回）
    from app.services.auto_listing.worker import run_worker_loop as run_auto_listing_loop

    auto_listing_task = asyncio.create_task(run_auto_listing_loop())

    # 上架状态兜底对账：没人打开的货也要收敛。
    # 缺了它的后果是实测出来的：46 行卡在「上架中」，最老的一个多月——
    # 而群控那边早就有终态，只是没人替这些货去问一句。
    from app.services.gc_bridge.reconcile import run_reconcile_loop

    reconcile_task = asyncio.create_task(run_reconcile_loop())

    # 手动上架缺商品图:先 AI 生成主图,出图后由它接着下发(具名锁,两个 worker 只跑一份)
    from app.services.gc_bridge.ai_image_publish import run_loop as run_ai_image_publish_loop

    ai_image_publish_task = asyncio.create_task(run_ai_image_publish_loop())

    # 图片爬虫:跟进按 SPU 发起的搜图,员工审过的转存成 AI 重绘参考图(没配就空转)
    from app.services.product_image import run_loop as run_product_image_loop

    product_image_task = asyncio.create_task(run_product_image_loop())

    # 验货异常 10 分钟没人处理：催一次并升级给管理员
    from app.services.inspection_ops import run_escalation_loop

    inspection_escalation_task = asyncio.create_task(run_escalation_loop())

    async with AsyncExitStack() as stack:
        # 只读 MCP 服务：streamable-http 需要在其 session_manager 生命周期内运行
        if settings.mcp_enabled and settings.mcp_api_key:
            from app.services.mcp_server import mcp as _mcp
            await stack.enter_async_context(_mcp.session_manager.run())
        try:
            yield
        finally:
            sweeper_task.cancel()
            auto_listing_task.cancel()
            reconcile_task.cancel()
            ai_image_publish_task.cancel()
            product_image_task.cancel()
            inspection_escalation_task.cancel()
            shutdown_executor()
            shutdown_condition_scan()
            oa_push.shutdown_executor()


# ── 接口文档路径(防泄漏)────────────────────────────────────────────────
# 文档 = 全量接口/字段结构。藏到带 token 的私密前缀,老的 /docs、/redoc、/openapi.json
# 一律 404;DOCS_TOKEN 置空则彻底关闭文档。token 可在 .env 覆盖轮换(见 app/config.py)。
_docs_prefix = f"/{settings.docs_token.strip('/')}" if settings.docs_token.strip() else None
app = FastAPI(
    title="ERP 管理系统 API",
    version="0.3.0",
    lifespan=lifespan,
    openapi_url=f"{_docs_prefix}/openapi.json" if _docs_prefix else None,
    docs_url=f"{_docs_prefix}/docs" if _docs_prefix else None,
    redoc_url=f"{_docs_prefix}/redoc" if _docs_prefix else None,
)


# ── Swagger/OpenAPI 中文化 ────────────────────────────────────────────────
# 各端点的中文 summary 直接写在路由装饰器上;这里把英文 tag(分组名)映射成中文展示。
_TAG_CN = {
    "ai-image": "AI 图片",
    "alipay": "支付宝",
    "archive": "归档",
    "asset": "资产设备",
    "asset-intake": "资产录入",
    "auth": "认证登录",
    "auto-listing": "自动上架",
    "config": "应用配置",
    "dashboard": "仪表盘",
    "express": "快递",
    "feedback": "匿名反馈",
    "finance": "财务",
    "gc-bind": "群控绑定",
    "inspection": "验货",
    "inventory": "库存",
    "lawsuit": "诉讼",
    "listing": "上架",
    "market": "行情监控",
    "master": "主数据",
    "negotiation": "议价",
    "negotiation-tasks": "议价单",
    "ocr": "OCR 识别",
    "oidc": "统一登录（ERP 账号来源）",
    "oss": "OSS 存储",
    "phone": "手机号",
    "pickup-payment": "自提收款",
    "purchase": "采购",
    "purchase-webhook": "采购 Webhook",
    "returns": "退货",
    "sales": "销售",
    "spu": "SPU 对照",
    "sso": "统一登录管理",
    "staff": "员工",
    "switch": "换机",
}


def _openapi_cn():
    from fastapi.openapi.utils import get_openapi

    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(title=app.title, version=app.version, routes=app.routes)
    for ops in schema["paths"].values():
        for op in ops.values():
            if isinstance(op, dict) and op.get("tags"):
                op["tags"] = [_TAG_CN.get(t, t) for t in op["tags"]]
    app.openapi_schema = schema
    return app.openapi_schema


app.openapi = _openapi_cn


@app.exception_handler(OssNotConfiguredError)
async def oss_not_configured(_request, exc: OssNotConfiguredError):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for r in (
    account_profile,
    auth,
    config,
    staff,
    master,
    oss,
    ocr,
    purchase,
    purchase_webhook,
    purchase_platform,
    purchase_price,
    inspection,
    inspection_ops,
    negotiation,
    negotiation_tasks,
    inventory,
    lawsuit,
    returns,
    sale_payment,
    sales,
    express,
    feedback,
    finance,
    gc_bind,
    gc_ops,
    dashboard,
    listing,
    listing_config,
    listing_ws,
    listing_approval,
    auto_listing,
    bargain,
    practice,
    price_clean,
    stock_gaps,
    sales_workbench,
    virtual_goods,
    ledger,
    market,
    spu,
    switch_order,
    archive,
    ai_image,
    alipay,
    asset,
    asset_intake,
    phone,
    workbench,
    miaoda,
    oidc,
    sso,
    chat_assist,
    price_history,
    product_image,
    spu_match,
    guide,
    internal_notify,
    internal_publish_check,
    zentao_link,
    dewatermark,
):
    app.include_router(r.router)

# 采购 webhook 对外 token-URL 端点（/v1/integrations/purchase/{token}）
app.include_router(purchase_webhook.public_router)
# 采购工作台 W10：执行端抓回来的买家订单，本机群控转进来
app.include_router(purchase_platform.internal)


@app.get("/health", summary="健康检查", tags=["系统"])
def health():
    return {"status": "ok", "database": "mysql"}


# ── 只读 MCP 服务挂载（/mcp）───────────────────────────────────────────────────
# 供外部协作开发者通过 MCP 客户端接入：列接口 + 查库（仅读）。
# 鉴权：ASGI 中间件校验 Authorization: Bearer <MCP_API_KEY>。
if settings.mcp_enabled and settings.mcp_api_key:
    from starlette.responses import PlainTextResponse

    from app.services.mcp_server import mcp as _mcp

    _mcp_asgi = _mcp.streamable_http_app()

    async def _mcp_auth_asgi(scope, receive, send):
        if scope["type"] != "http":
            await _mcp_asgi(scope, receive, send)
            return
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        auth = headers.get("authorization", "")
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        if not token:
            # 兼容部分客户端用自定义头传密钥
            token = headers.get("x-mcp-key", "").strip()
        if token != settings.mcp_api_key:
            resp = PlainTextResponse("unauthorized", status_code=401)
            await resp(scope, receive, send)
            return
        await _mcp_asgi(scope, receive, send)

    app.mount("/mcp", _mcp_auth_asgi)
