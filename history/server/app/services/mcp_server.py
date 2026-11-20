"""只读 MCP 服务：供外部协作开发者通过 MCP 客户端(Claude/Cursor 等)接入。

对外只暴露三类**只读**能力：
  - list_api_endpoints  列出本后端全部 HTTP 接口(方法/路径/名称/摘要)
  - list_tables / describe_table  查看库结构
  - query_database      执行只读 SQL(仅 SELECT / WITH)

安全分两层(双保险)：
  1. 数据库层：走 settings.mcp_database_url 指定的**只读账号**(只授 SELECT)。
     即使代码护栏被绕过，DB 也拒绝任何写操作。
  2. 代码层：_guard_readonly_sql 只放行单条 SELECT/WITH，拦截多语句与写关键字，
     执行放在事务里并最终 rollback，另对结果行数封顶。

接入鉴权：挂载处的 ASGI 中间件校验 `Authorization: Bearer <mcp_api_key>`，
见 app/main.py 的 _mcp_auth_asgi。
"""

from __future__ import annotations

import re

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from app.config import settings

# 延迟 import：仅在 mcp_enabled 时才需要 mcp 依赖，避免未装包时拖垮整个服务启动。
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings


def _build_transport_security() -> TransportSecuritySettings:
    """MCP 传输层默认开 DNS-rebinding 防护(只信 localhost)，远程域名会被判 Invalid Host。
    设了 mcp_allowed_hosts 就按白名单放行，没设就关掉该防护(已有 Bearer 强鉴权兜底)。"""
    hosts = [h.strip() for h in (settings.mcp_allowed_hosts or "").split(",") if h.strip()]
    if not hosts:
        return TransportSecuritySettings(enable_dns_rebinding_protection=False)
    allowed_hosts = []
    allowed_origins = []
    for h in hosts:
        allowed_hosts += [h, f"{h}:443", f"{h}:80"]
        allowed_origins += [f"https://{h}", f"http://{h}"]
    allowed_hosts += ["127.0.0.1", "127.0.0.1:8000", "localhost", "localhost:8000"]
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=allowed_hosts,
        allowed_origins=allowed_origins,
    )


# ── 只读数据库引擎 ────────────────────────────────────────────────────────────
_readonly_engine: Engine | None = None


def _get_readonly_engine() -> Engine:
    global _readonly_engine
    if _readonly_engine is None:
        url = settings.mcp_database_url or settings.database_url
        _readonly_engine = create_engine(
            url,
            pool_pre_ping=True,
            pool_recycle=3600,
            connect_args={"charset": "utf8mb4"},
        )
    return _readonly_engine


# ── SQL 只读护栏 ──────────────────────────────────────────────────────────────
_WRITE_KEYWORDS = re.compile(
    r"\b("
    r"insert|update|delete|replace|merge|upsert|"
    r"drop|alter|create|truncate|rename|"
    r"grant|revoke|"
    r"call|do|handler|load|lock|unlock|"
    r"set|use|commit|rollback|start|begin|savepoint|"
    r"into\s+outfile|into\s+dumpfile"
    r")\b",
    re.IGNORECASE,
)


def _strip_sql_comments(sql: str) -> str:
    # 去掉 -- 行注释、# 行注释、/* */ 块注释，防止把写语句藏在注释后混过关键字检查
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)
    sql = re.sub(r"--[^\n]*", " ", sql)
    sql = re.sub(r"#[^\n]*", " ", sql)
    return sql


def _guard_readonly_sql(sql: str) -> str:
    raw = (sql or "").strip()
    if not raw:
        raise ValueError("SQL 不能为空")

    cleaned = _strip_sql_comments(raw).strip()
    # 允许末尾一个分号，但不允许多语句
    body = cleaned[:-1] if cleaned.endswith(";") else cleaned
    if ";" in body:
        raise ValueError("只允许执行单条语句，禁止分号拼接多语句")

    lowered = body.lstrip().lower()
    if not (lowered.startswith("select") or lowered.startswith("with")):
        raise ValueError("只允许 SELECT / WITH 查询语句")

    if _WRITE_KEYWORDS.search(body):
        raise ValueError("检测到写操作或危险关键字，已拒绝（本接口只读）")

    return body


# ── MCP 实例与工具 ────────────────────────────────────────────────────────────
# stateless_http：无会话态，便于挂到现有 FastAPI/uvicorn 且天然适配 nginx 反代。
# streamable_http_path="/"：子 app 内部路由挂根，配合 main.py 的 app.mount("/mcp", ...)
# 得到最终端点就是 /mcp（否则默认会变成 /mcp/mcp）。
mcp = FastMCP(
    "erp-readonly",
    stateless_http=True,
    streamable_http_path="/",
    transport_security=_build_transport_security(),
)


def _describe_routes() -> list[dict]:
    """从已构建的 FastAPI app 抓路由表。运行期 import 避免与 main 循环依赖。"""
    from app.main import app as fastapi_app

    rows: list[dict] = []
    for route in fastapi_app.routes:
        methods = getattr(route, "methods", None)
        path = getattr(route, "path", None)
        if not path or not methods:
            continue
        for m in sorted(methods):
            if m in ("HEAD", "OPTIONS"):
                continue
            rows.append(
                {
                    "method": m,
                    "path": path,
                    "name": getattr(route, "name", "") or "",
                    "summary": getattr(route, "summary", "") or "",
                }
            )
    rows.sort(key=lambda r: (r["path"], r["method"]))
    return rows


@mcp.tool()
def list_api_endpoints() -> str:
    """列出本 ERP 后端的全部 HTTP 接口（方法、路径、名称、摘要）。只读。"""
    rows = _describe_routes()
    lines = [f"共 {len(rows)} 个接口:", ""]
    lines += [
        f"{r['method']:6} {r['path']}"
        + (f"    # {r['summary'] or r['name']}" if (r["summary"] or r["name"]) else "")
        for r in rows
    ]
    return "\n".join(lines)


@mcp.tool()
def list_tables() -> str:
    """列出当前数据库中的所有表名。只读。"""
    with _get_readonly_engine().connect() as conn:
        names = [row[0] for row in conn.execute(text("SHOW TABLES"))]
    return "\n".join(names) if names else "(空库)"


@mcp.tool()
def describe_table(table: str) -> str:
    """查看某张表的字段结构（列名/类型/是否可空/键/默认值）。只读。

    Args:
        table: 表名（仅允许字母数字下划线）。
    """
    if not re.fullmatch(r"[A-Za-z0-9_]+", table or ""):
        raise ValueError("非法表名")
    with _get_readonly_engine().connect() as conn:
        # 反引号包裹，表名已白名单化(仅 \w)，无注入面
        rows = conn.execute(text(f"SHOW FULL COLUMNS FROM `{table}`")).mappings().all()
    if not rows:
        return f"表 {table} 无字段或不存在"
    header = "字段\t类型\t可空\t键\t默认\t注释"
    body = [
        f"{r['Field']}\t{r['Type']}\t{r['Null']}\t{r['Key']}\t{r['Default']}\t{r.get('Comment', '')}"
        for r in rows
    ]
    return "\n".join([f"表 {table}:", header, *body])


@mcp.tool()
def query_database(sql: str, limit: int = 200) -> str:
    """执行只读 SQL 查询（仅允许 SELECT / WITH），返回结果行。

    安全说明：连接使用只读数据库账号；代码层同时拦截写操作与多语句，执行后回滚。

    Args:
        sql: 单条 SELECT/WITH 查询语句。
        limit: 返回行数上限（客户端侧再截断），默认 200，硬顶见服务端配置。
    """
    body = _guard_readonly_sql(sql)
    cap = max(1, min(int(limit or 200), settings.mcp_query_max_rows))

    engine = _get_readonly_engine()
    with engine.connect() as conn:
        trans = conn.begin()
        try:
            result = conn.execute(text(body))
            cols = list(result.keys())
            fetched = result.fetchmany(cap + 1)
        finally:
            trans.rollback()  # 只读：无论如何都回滚，绝不落盘

    truncated = len(fetched) > cap
    rows = fetched[:cap]
    lines = [f"列: {', '.join(cols)}", f"返回 {len(rows)} 行" + ("（已截断，还有更多）" if truncated else ""), ""]
    lines += ["\t".join("NULL" if v is None else str(v) for v in row) for row in rows]
    return "\n".join(lines)
