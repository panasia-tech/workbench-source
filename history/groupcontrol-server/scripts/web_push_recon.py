"""M2 调研：闲鱼网页版消息到达时，页面上究竟发生了什么。

# 要回答的问题

现在会话靠 chat_scan 每 5 分钟轮询一轮拉取，而 M1 的兜底判定要求 50 秒内知道
「买家发了消息且没人回」。5 分钟的粒度撑不起 50 秒的承诺。

转 AdsPower 网页版之后页面握在自己手里，理论上可以挂监听拿到实时事件。这个脚本
就是去确认「理论上」到底成不成立——会上说了：**确认可行性后再落地，不拍脑袋定方案**。

具体要弄清三件事：
  1. 有没有长连接（WebSocket），新消息是不是从它下来的；
  2. 如果没有，是不是轮询，轮询的是哪个接口、多久一次；
  3. 有没有一个稳定的、能识别「这是一条新消息」的信号。

# 怎么用

    cd groupcontrol-server
    ../adspower-executor/.venv/bin/python scripts/web_push_recon.py --seconds 180

默认挑一个正在跑的环境。脚本**只观察不操作**：不点任何按钮、不发任何消息，
只打开会话页然后听。唯一的副作用与 chat_scan 相同——打开会话页会让闲鱼侧
未读变已读。

调研期间请在另一台设备用买家号给该账号发一条消息，脚本会把那一刻前后的
网络活动标出来。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import Counter
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from playwright.sync_api import sync_playwright  # noqa: E402

from app.flow.web.local_transport import discover_ws_endpoint  # noqa: E402

IM_URL = "https://www.goofish.com/im"
# 登录态判定与生产路径 (read_chats_web._ensure_login) 同一个信号：
# 页头昵称元素 class 含 nick-- 且文本非空 = 已登录。
#
# ⚠️ 别用「页面上有没有登录字样」这种反向匹配：未登录时 /im 的导航栏就只写两个字
# 「登录」，任何找「扫码登录 / 请先登录」的正则都会漏掉，然后给出一份看似可用、
# 实则全是登录页流量的调研结论（本脚本第一次跑就栽在这）。
# 排除表与 parse.LOGIN_ENTRY_TEXTS 同源(JS 侧无法直接 import,所以这里显式对齐;
# tests/test_login_nick.py 守着 Python 那份)。
LOGIN_NICK_JS = """() => {
  const ENTRY = ['登录','登录/注册','注册/登录','请登录','立即登录','登录注册','sign in','signin','login'];
  const el = [...document.querySelectorAll('[class*="nick--"]')].find(e => {
    const t = (e.textContent || '').trim();
    if (!t || ENTRY.includes(t.toLowerCase())) return false;
    return e.getBoundingClientRect().top < window.innerHeight * 0.15;
  });
  return el ? el.textContent.trim().slice(0, 40) : '';
}"""
# 交叉校验：扫码登录轮询在跑 = 页面停在登录二维码上
QRCODE_POLL = re.compile(r"passport\.goofish\.com/newlogin/qrcode", re.I)
# 消息相关的接口名片段（观察到的都记，这里只用于highlight）
MSG_HINT = re.compile(r"message|msg|im|chat|conversation|session|sync|poll|notice", re.I)

OUT_DIR = Path(__file__).resolve().parent / "web_push_recon_out"

# 调研会捞到凭据：ACCS 的长连接 URL 里直接带 ?token=AAAD…，mtop 请求里有
# _m_h5_tk / sid / uid。这些落盘或贴进聊天就等于泄登录态，所以打印和存盘前
# 一律打码——调研要的是「有没有长连接、频率多少」，从来不需要令牌本身。
_SECRET_PAT = re.compile(
    r"((?:token|sid|_m_h5_tk|uid|reg-uid|reg-sid|access[_-]?token|sign)[\"'=:\s]+)([A-Za-z0-9_\-%.]{6,})",
    re.I)


def redact(text: str) -> str:
    if not text:
        return text
    return _SECRET_PAT.sub(lambda m: f"{m.group(1)}<redacted:{len(m.group(2))}chars>", str(text))


def _ws_for(user_id: str | None) -> str:
    """指定环境的 CDP 端点；不指定则退回第一个在跑的。

    机器上同时会有销售、行情多个环境在跑，默认取第一个很容易连错账号——
    调研必须落在一个**已登录闲鱼**的销售环境上。
    """
    if not user_id:
        return discover_ws_endpoint()
    import urllib.request
    with urllib.request.urlopen(
            "http://127.0.0.1:50325/api/v1/browser/local-active", timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    for item in (data.get("data") or {}).get("list") or []:
        if item.get("user_id") == user_id:
            ws = (item.get("ws") or {}).get("puppeteer")
            if ws:
                return ws
    raise RuntimeError(f"环境 {user_id} 不在运行中，先启动它")


def _now() -> str:
    return datetime.now().strftime("%H:%M:%S")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--seconds", type=int, default=180, help="观察时长，默认 180 秒")
    ap.add_argument("--ws", help="直接指定 CDP ws 端点")
    ap.add_argument("--user-id", help="指定 AdsPower 环境（默认取第一个在跑的）")
    ap.add_argument("--keep-open", action="store_true", help="结束后不关闭页面")
    ap.add_argument("--force", action="store_true",
                    help="未登录也继续观察（只在排查登录流程本身时用）")
    args = ap.parse_args()

    ws_endpoint = args.ws or _ws_for(args.user_id)
    print(f"[{_now()}] 连接 {ws_endpoint[:60]}…")

    sockets: list[dict] = []
    frames: list[dict] = []
    responses: list[dict] = []

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(ws_endpoint)
        ctx = browser.contexts[0] if browser.contexts else browser.new_context()
        page = ctx.new_page()

        def on_ws(ws):
            sockets.append({"url": redact(ws.url), "at": time.time()})
            print(f"[{_now()}] ⇄ WebSocket 打开: {redact(ws.url)[:130]}")

            def rec(payload):
                body = payload if isinstance(payload, str) else f"<binary {len(payload)}B>"
                frames.append({"at": time.time(), "url": redact(ws.url), "dir": "in",
                               "len": len(payload), "body": redact(body[:2000])})

            def snd(payload):
                body = payload if isinstance(payload, str) else f"<binary {len(payload)}B>"
                frames.append({"at": time.time(), "url": redact(ws.url), "dir": "out",
                               "len": len(payload), "body": redact(body[:2000])})

            ws.on("framereceived", rec)
            ws.on("framesent", snd)
            ws.on("close", lambda _=None: print(f"[{_now()}] ⇄ WebSocket 关闭"))

        page.on("websocket", on_ws)

        def on_response(resp):
            try:
                req = resp.request
                if req.resource_type not in ("xhr", "fetch"):
                    return
                responses.append({"at": time.time(), "url": redact(resp.url),
                                  "method": req.method, "status": resp.status})
            except Exception:
                pass

        page.on("response", on_response)

        page.goto(IM_URL, wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_timeout(5_000)

        nick = page.evaluate(LOGIN_NICK_JS) or ""
        logged_in = bool(nick)
        print(f"[{_now()}] 登录态: {('已登录 · ' + nick) if logged_in else '❌ 未登录'}")
        if not logged_in:
            print("        该环境没登录闲鱼，观察到的只会是登录页流量，没有参考价值。")
            print("        请先在 AdsPower 里打开这个环境扫码登录，再跑本脚本。")
            if not args.force:
                page.close()
                browser.close()
                raise SystemExit(2)

        print(f"[{_now()}] 开始观察 {args.seconds}s —— 请用买家号给该账号发一条消息")
        deadline = time.time() + args.seconds
        while time.time() < deadline:
            page.wait_for_timeout(1_000)
            left = int(deadline - time.time())
            if left % 30 == 0 and left > 0:
                print(f"[{_now()}] …剩余 {left}s（WS 帧 {len(frames)} · XHR {len(responses)}）")

        if not args.keep_open:
            page.close()
        browser.close()

    _report(logged_in, sockets, frames, responses, args.seconds)


def _report(logged_in, sockets, frames, responses, seconds) -> None:
    OUT_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    raw = OUT_DIR / f"recon-{stamp}.json"
    raw.write_text(json.dumps({
        "logged_in": logged_in, "seconds": seconds,
        "sockets": sockets, "frames": frames, "responses": responses,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n" + "=" * 64)
    print(f"登录态          : {'已登录' if logged_in else '未登录（以下结论不可用）'}")
    print(f"WebSocket 连接  : {len(sockets)} 条")
    for s in sockets:
        print(f"    {s['url'][:110]}")
    print(f"WS 帧           : {len(frames)}（in {sum(1 for f in frames if f['dir']=='in')}"
          f" / out {sum(1 for f in frames if f['dir']=='out')}）")

    # 长连接是不是活的：只有心跳还是有业务负载
    inbound = [f for f in frames if f["dir"] == "in"]
    if inbound:
        sizes = Counter("小(<200B)" if f["len"] < 200 else "大(>=200B)" for f in inbound)
        print(f"    入向帧大小分布: {dict(sizes)}")
        print("    入向样本（前 3 条大帧）:")
        for f in [x for x in inbound if x["len"] >= 200][:3]:
            print(f"      {redact(f['body'])[:200]}")

    print(f"\nXHR/fetch       : {len(responses)} 次")
    hosts = Counter()
    paths = Counter()
    for r in responses:
        m = re.match(r"https?://([^/]+)(/[^?]*)", r["url"])
        if m:
            hosts[m.group(1)] += 1
            paths[f"{m.group(1)}{m.group(2)}"] += 1
    print("    次数最多的接口（前 8）:")
    for path, n in paths.most_common(8):
        flag = " ← 可能与消息相关" if MSG_HINT.search(path) else ""
        rate = f"{seconds / n:.0f}s/次" if n > 1 else "1 次"
        print(f"      {n:>4}  {rate:>9}  {path[:90]}{flag}")

    # 未登录时观察到的全是登录页流量，任何「结论」都是假的
    qr = [r for r in responses if QRCODE_POLL.search(r["url"])]
    if qr:
        print(f"\n⚠️ 观察到 {len(qr)} 次扫码登录轮询 —— 这个环境停在登录页，"
              "下面的接口统计反映的是登录流程，不是消息链路。")

    print("\n判断：")
    if qr:
        print("  ❌ 调研无效：环境未登录。先登录再跑。")
    elif sockets and any(f["len"] >= 200 for f in inbound):
        print("  ✅ 有长连接且有业务负载 —— 实时推送可行，落地方式是挂 WS 帧监听。")
    elif sockets:
        print("  ⚠️ 有长连接但只看到小帧（疑似心跳）—— 需要在观察窗口内确实收到一条新消息"
              "才能判定；请确认调研期间真的发了消息。")
    else:
        repeated = [(p, n) for p, n in paths.items() if n >= 3 and MSG_HINT.search(p)]
        if repeated:
            p0, n0 = max(repeated, key=lambda x: x[1])
            print(f"  ⚠️ 没有 WebSocket，但存在高频轮询接口：{p0}（约 {seconds/n0:.0f}s/次）。")
            print("     落地方式退化为「跟随页面自身的轮询节奏」，而不是真推送。")
        else:
            print("  ❌ 既没有长连接，也没看到明显的消息轮询 —— 需要延长观察时长，"
                  "或确认该页面是不是消息主页面。")
    print(f"\n原始数据: {raw}")
    print("=" * 64)


if __name__ == "__main__":
    main()
