"""应用日志级别。

httpx / httpcore 默认在 INFO 级别打印「HTTP Request: GET <完整 URL>」。
微信登录的 jscode2session 把 AppSecret 放在 query string 里，这条日志会把密钥
整条打进 journalctl。这里把它们压到 WARNING：连接错误、重试等告警仍然保留，
只是不再逐条打印请求地址。其他业务 logger 不受影响。
"""
import logging

# 只调整这两个第三方 HTTP 客户端 logger，不动 root 和业务 logger
_NOISY_HTTP_LOGGERS = ("httpx", "httpcore")


def configure_logging() -> None:
    for name in _NOISY_HTTP_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
