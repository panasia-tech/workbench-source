"""微信 jscode2session 的 AppSecret 不能出现在日志里（httpx INFO 会把完整 URL 打出来）。"""
import asyncio
import logging
from types import SimpleNamespace

import httpx
import pytest

from app.logging_config import configure_logging
from app.services import wechat


def _mock_wx_client(monkeypatch, handler, secret):
    """让 code_to_openid 走真实 httpx.AsyncClient，只把 transport 换成 MockTransport。"""
    monkeypatch.setattr(
        wechat,
        "settings",
        SimpleNamespace(wx_appid="wx-test-appid", wx_secret=secret),
    )
    seen = {}
    real_client = httpx.AsyncClient

    def wrapped(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return handler(request)

    transport = httpx.MockTransport(wrapped)

    def client(**kwargs):
        return real_client(transport=transport, **kwargs)

    monkeypatch.setattr(wechat.httpx, "AsyncClient", client)
    return seen


def test_jscode2session_does_not_log_secret(monkeypatch, caplog):
    configure_logging()

    secret = "DEMO_ONLY_REDACTED"
    seen = _mock_wx_client(
        monkeypatch,
        lambda request: httpx.Response(200, json={"openid": "openid-1", "session_key": "sk"}),
        secret,
    )

    # 如果 httpx 还在 INFO，caplog 一定能收到；现在的配置应该把它压住
    caplog.set_level(logging.DEBUG)
    data = asyncio.run(wechat.code_to_openid("wx-code-1"))

    assert data["openid"] == "openid-1"
    assert secret in seen["url"], "测试请求本身必须带 secret，才能证明日志断言有意义"
    assert secret not in caplog.text
    assert "jscode2session" not in caplog.text
    assert not [r for r in caplog.records if r.name.startswith(("httpx", "httpcore"))]
    assert logging.getLogger("httpx").getEffectiveLevel() == logging.WARNING
    assert logging.getLogger("httpcore").getEffectiveLevel() == logging.WARNING


def test_jscode2session_http_error_does_not_expose_secret(monkeypatch, caplog):
    """raise_for_status() 的异常字符串会带 URL；这条路径也必须脱敏。"""
    configure_logging()

    secret = "DEMO_ONLY_REDACTED"
    seen = _mock_wx_client(monkeypatch, lambda request: httpx.Response(500, text="oops"), secret)

    caplog.set_level(logging.DEBUG)
    with pytest.raises(ValueError) as exc:
        asyncio.run(wechat.code_to_openid("wx-code-2"))

    assert secret in seen["url"]
    assert secret not in str(exc.value)
    assert "jscode2session" not in str(exc.value)
    assert secret not in caplog.text


def test_jscode2session_network_error_does_not_expose_secret(monkeypatch):
    """网络异常也不能把原始 httpx 异常（含请求 URL）带到上层日志。"""
    configure_logging()

    secret = "DEMO_ONLY_REDACTED"

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    _mock_wx_client(monkeypatch, handler, secret)

    with pytest.raises(ValueError) as exc:
        asyncio.run(wechat.code_to_openid("wx-code-3"))

    assert secret not in str(exc.value)
    assert "jscode2session" not in str(exc.value)
    assert "boom" not in str(exc.value)


def test_business_info_logs_are_not_suppressed(caplog):
    """只压 httpx/httpcore，业务 logger 的 INFO 仍然要能看到；httpx 的 WARNING 也保留。"""
    configure_logging()
    caplog.set_level(logging.INFO)
    logging.getLogger("app.test.business").info("business-info-visible")
    logging.getLogger("httpx").warning("http-warning-visible")
    assert "business-info-visible" in caplog.text
    assert "http-warning-visible" in caplog.text


def test_configure_logging_overrides_info_levels():
    """就算别处先把 httpx 调成 INFO，应用启动时的配置也要把它压回 WARNING。"""
    logging.getLogger("httpx").setLevel(logging.INFO)
    logging.getLogger("httpcore").setLevel(logging.INFO)
    configure_logging()
    assert logging.getLogger("httpx").getEffectiveLevel() == logging.WARNING
    assert logging.getLogger("httpcore").getEffectiveLevel() == logging.WARNING
