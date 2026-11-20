"""OA/台账 MCP 客户端封装（本 ERP 作 MCP 客户端，Streamable HTTP + X-Mcp-Api-Key）。

对外只暴露同步 `call_tool(tool, arguments) -> remote_id|None`：
- 成功 → 返回 OA 记录 id（拿不到则 None）；
- 幂等重复("该来源数据已存在") → 视为成功（数据已在），返回 None；
- 未找到用户映射(sync_staff_user 未迁移) → 抛 OaMappingMissingError（不可重试，挂 BLOCKED_NO_MAPPING）；
- 其它业务错误(参数校验/枚举非法) → 抛 OaPushError(retriable=False)；
- 连接/超时/协议错误 → 抛 OaPushError(retriable=True)。

worker 线程内以 asyncio.run 驱动（MCP client 仅 async）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re

from app.config import settings

logger = logging.getLogger(__name__)


class OaPushError(Exception):
    """OA 推送失败。retriable=True 表示可重试（连接/超时/未知）。"""

    def __init__(self, message: str, *, retriable: bool = True):
        super().__init__(message)
        self.message = message
        self.retriable = retriable


class OaMappingMissingError(OaPushError):
    """OA 侧找不到该员工映射（未迁移）。不可重试，需 OA 侧补迁移。"""

    def __init__(self, message: str):
        super().__init__(message, retriable=False)


def is_configured() -> bool:
    return bool((settings.oa_mcp_url or "").strip() and (settings.oa_mcp_api_key or "").strip())


_ID_RE = re.compile(r"(?:记录ID|ID|id)\s*[=＝:：]\s*(\d+)")


def _collect_text(result) -> str:
    parts = []
    for block in (getattr(result, "content", None) or []):
        t = getattr(block, "text", None)
        if t:
            parts.append(t)
    return "\n".join(parts)


def _try_json(text: str):
    text = (text or "").strip()
    if not text or text[0] not in "{[":
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def _is_duplicate(msg: str) -> bool:
    return ("已存在" in msg) or ("重复同步" in msg) or ("禁止重复" in msg)


def _is_mapping_missing(msg: str) -> bool:
    return ("未找到" in msg and ("映射" in msg or "用户" in msg)) or ("未迁移" in msg)


def _interpret(result) -> str | None:
    """把 CallToolResult 解释为 remote_id；失败抛 OaPushError/OaMappingMissingError。"""
    text = _collect_text(result)
    is_error = bool(getattr(result, "isError", False))

    data = getattr(result, "structuredContent", None)
    if not isinstance(data, dict):
        data = _try_json(text)

    success = None
    message = text
    remote_id = None
    if isinstance(data, dict):
        inner = data.get("result") if isinstance(data.get("result"), dict) else data
        if "success" in inner:
            success = bool(inner.get("success"))
        message = str(inner.get("message") or text or "")
        rid = inner.get("id")
        if rid is None:
            rid = inner.get("recordId")
        if rid is not None:
            remote_id = str(rid)

    msg = (message or "").strip()

    # 幂等重复：数据已在 OA，视为成功
    if _is_duplicate(msg):
        logger.info("OA 幂等重复，按成功处理：%s", msg)
        return remote_id

    if is_error or success is False:
        if _is_mapping_missing(msg):
            raise OaMappingMissingError(msg or "未找到该第三方用户对应的系统用户映射")
        # 业务级错误（参数/枚举）：重试无益
        raise OaPushError(msg or "OA 返回失败", retriable=False)

    # 成功
    if remote_id is None:
        m = _ID_RE.search(text or "")
        if m:
            remote_id = m.group(1)
    return remote_id


async def _call_tool_async(tool: str, arguments: dict) -> str | None:
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    url = settings.oa_mcp_url.strip()
    headers = {"X-Mcp-Api-Key": settings.oa_mcp_api_key.strip()}
    timeout = float(settings.oa_push_timeout_seconds or 15)

    async with streamablehttp_client(url, headers=headers, timeout=timeout) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(tool, arguments=arguments)
    return _interpret(result)


def call_tool(tool: str, arguments: dict) -> str | None:
    """同步入口（供 worker 线程调用）。失败抛 OaPushError（含 retriable 标记）。"""
    if not is_configured():
        raise OaPushError("OA MCP 未配置(oa_mcp_url/oa_mcp_api_key)", retriable=False)
    try:
        return asyncio.run(_call_tool_async(tool, arguments))
    except OaPushError:
        raise
    except Exception as exc:  # 连接/超时/协议等 → 可重试
        raise OaPushError(f"{type(exc).__name__}: {exc}", retriable=True) from exc
