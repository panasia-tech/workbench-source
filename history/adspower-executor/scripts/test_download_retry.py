"""push_media 下图：网络抖动、图床 5xx 再试，403/404 不试。不连网：假 httpx.get。

11-11 焕新重发撞上一次 SSL EOF，只试一次就失败，旧链接已删的货空到了第二天。

跑法：.venv/bin/python scripts/test_download_retry.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402

from gc_ads import primitives  # noqa: E402
from gc_ads.primitives import PrimitiveExecutor  # noqa: E402

URL = "https://example.com/a.jpg"


def _run(responses):
    """responses：依次返回的结果，异常实例就抛。返回 (结果或异常, 调用次数, 睡过的秒数)。"""
    calls, sleeps = [], []
    queue = list(responses)

    def fake_get(url, **kw):
        calls.append(url)
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return httpx.Response(item, content=b"img", request=httpx.Request("GET", url))

    orig_get, orig_sleep = primitives.httpx.get, primitives.time.sleep
    primitives.httpx.get, primitives.time.sleep = fake_get, sleeps.append
    try:
        try:
            out = PrimitiveExecutor._download(URL)
        except Exception as exc:  # noqa: BLE001
            out = exc
    finally:
        primitives.httpx.get, primitives.time.sleep = orig_get, orig_sleep
    return out, len(calls), sleeps


def main():
    eof = httpx.ConnectError("[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol")

    out, n, sleeps = _run([eof, 200])
    assert out == b"img" and n == 2 and sleeps == [2.0], (out, n, sleeps)

    out, n, sleeps = _run([503, httpx.ReadTimeout("t"), 200])
    assert out == b"img" and n == 3 and sleeps == [2.0, 5.0], (out, n, sleeps)

    out, n, _ = _run([eof, eof, eof])
    assert isinstance(out, httpx.ConnectError) and n == 3, (out, n)

    out, n, _ = _run([502, 502, 502])
    assert isinstance(out, httpx.HTTPStatusError) and n == 3, (out, n)

    out, n, sleeps = _run([403])
    assert isinstance(out, httpx.HTTPStatusError) and n == 1 and sleeps == [], (out, n)

    print("ok")


if __name__ == "__main__":
    main()
