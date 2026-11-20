"""调试:发布表单填满后底部「发布」按钮点了 3 次纹丝不动的原因排查。

手段:monkeypatch 让 flow 填完单、跳过发布 tapping(阻断 y>0.72h 的 tap 并把
_close_stray_layers 改为只设标志),_leave_publish 改为 no-op(保住现场),
然后对「发布」按钮做系统体检 + 三种点击方式对比(JS el.click / CDP mouse / locator),
观察哪种能真正提交。全程收集 console/pageerror。

用法:
  adspower-executor/.venv/bin/python scripts/web_publish_debug.py
"""
import functools
import http.server
import json
import sys
import threading
import time

sys.path.insert(0, ".")
import app.flow.web.publish_flow_web as pfw  # noqa: E402
from app.flow.web.local_transport import LocalPlaywrightTransport  # noqa: E402

DESC = "【测试商品】系统自动测试发布,请勿拍下,稍后删除"
IMG_PATH = "/tmp/gc_test_publish.jpg"


def _serve_img():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory="/tmp")
    srv = http.server.HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_port}/gc_test_publish.jpg"


PROBE_JS = """
() => {
  const out = {buttons: [], errors: [], hasErrorCount: 0, url: location.href};
  const cands = [...document.querySelectorAll('button')]
    .filter(b => (b.textContent || '').trim() === '发布');
  for (const b of cands) {
    const r = b.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    let cover = null;
    if (top && !b.contains(top)) {
      cover = {tag: top.tagName, cls: top.className && String(top.className).slice(0, 80)};
    }
    out.buttons.push({
      tag: b.tagName, cls: String(b.className).slice(0, 120),
      disabled: b.disabled, rect: {x: r.x, y: r.y, w: r.width, h: r.height},
      cx, cy, cover,
      ariaDisabled: b.getAttribute('aria-disabled'),
      pointerEvents: getComputedStyle(b).pointerEvents,
    });
  }
  for (const e of document.querySelectorAll('.ant-form-item-explain-error')) {
    out.errors.push((e.textContent || '').trim());
  }
  out.hasErrorCount = document.querySelectorAll('.ant-form-item-has-error').length;
  return out;
}
"""

CLICK_JS = """
() => {
  const b = [...document.querySelectorAll('button')]
    .filter(x => (x.textContent || '').trim() === '发布')
    .sort((a, c) => c.getBoundingClientRect().y - a.getBoundingClientRect().y)[0];
  if (!b) return 'NO_BUTTON';
  b.scrollIntoView();
  b.click();
  return 'CLICKED';
}
"""


def _shot(t, name):
    p = f"shots/{int(time.time())}_dbg_{name}.png"
    with open(p, "wb") as f:
        f.write(t.screencap())
    return p


def main():
    srv, img_url = _serve_img()
    t = LocalPlaywrightTransport()
    out = {"console_tail": [], "pageerrors": []}

    async def _attach():
        t.page.on("console", lambda m: out["console_tail"].append(f"{m.type}@{time.time():.1f}:{m.text[:800]}"))
        t.page.on("pageerror", lambda e: out["pageerrors"].append(str(e)[:500]))
        t.page.on("request", lambda r: out.setdefault("requests", []).append(
            f"{time.time():.1f} {r.method} {r.url[:140]}") if r.method == "POST" else None)
    t._submit(_attach())
    h_holder = {"h": 0}

    # --- monkeypatch:填单后阻断发布区 tap,保住现场 ---
    orig_tap = t.tap
    block = {"on": False, "blocked": 0}

    def guarded_tap(x, y, *a, **k):
        if block["on"] and y > h_holder["h"] * 0.72:
            block["blocked"] += 1
            print(f"[tap blocked] ({x},{y})", flush=True)
            return
        return orig_tap(x, y, *a, **k)

    t.tap = guarded_tap

    def flag_only(tt, w, hh):
        block["on"] = True
        print("[flag] 进入发布 tapping 阶段,底部 tap 已阻断", flush=True)

    pfw._close_stray_layers = flag_only
    pfw._leave_publish = lambda *a, **k: print("[patch] _leave_publish no-op(保现场)", flush=True)

    try:
        print(">>> 跑 flow 填单(发布 tap 会被阻断,预期在 publish 步失败) ...", flush=True)
        w, h = t.screen_size()
        h_holder["h"] = h
        spec = {"images": [img_url], "description": DESC, "price": 1,
                "shipping": {"mode": "free"}, "location": "杭州",
                "attrs": {"成色": "轻微使用痕迹"},
                "confirm_publish": True, "dry_run": False}
        res = pfw.run_publish_web(t, spec)
        out["flow_result"] = res
        print(json.dumps(res, ensure_ascii=False, indent=2), flush=True)
        print(f">>> 被阻断的底部 tap 数={block['blocked']}(预期 ≥3)", flush=True)
        time.sleep(2)

        print(">>> 体检发布按钮 ...", flush=True)
        probe = t._submit(t.page.evaluate(PROBE_JS))
        out["probe"] = probe
        print(json.dumps(probe, ensure_ascii=False, indent=2), flush=True)
        _shot(t, "probed")

        btn = None
        for b in probe["buttons"]:
            if b["cy"] > h * 0.7 and not b["disabled"]:
                btn = b
        if not btn and probe["buttons"]:
            btn = probe["buttons"][0]
        if not btn:
            print("!!! 没找到发布按钮,放弃", flush=True)
            return

        def state(tag):
            time.sleep(3)
            st = t._submit(t.page.evaluate(
                "() => ({url: location.href, editor: !!document.querySelector('[class*=editor--]')})"))
            nodes_url = st["url"]
            print(f"    [{tag}] url={nodes_url} editor还在={st['editor']}", flush=True)
            out.setdefault("attempts", []).append({"tag": tag, **st})
            return st

        def dump_new_console(tag, from_idx):
            lines = out["console_tail"][from_idx:]
            print(f"    --- console 新增 {len(lines)} 条 [{tag}] ---", flush=True)
            for line in lines:
                print("      ", line.replace("\n", " | ")[:400], flush=True)
            return len(out["console_tail"])

        def dump_new_requests(tag, from_idx):
            reqs = out.get("requests", [])[from_idx:]
            print(f"    --- POST 请求新增 {len(reqs)} 条 [{tag}] ---", flush=True)
            for line in reqs:
                print("      ", line, flush=True)
            return len(out.get("requests", []))

        ci = len(out["console_tail"])
        ri = len(out.get("requests", []))

        # 方式0:授权地理位置后 JS click(console 里有「获取位置失败:用户拒绝了地理位置权限」)
        print(">>> 方式0: 授权 geolocation + set geolocation → JS click", flush=True)
        async def _geo():
            ctx = t.page.context
            await ctx.grant_permissions(["geolocation"], origin="https://www.goofish.com")
            try:
                await ctx.set_geolocation({"latitude": 30.27, "longitude": 120.15})
            except Exception as ex:
                out["geo_err"] = str(ex)
        t._submit(_geo())
        r = t._submit(t.page.evaluate(CLICK_JS))
        print(f"    click 返回 {r}", flush=True)
        st = state("geo_js_click")
        ci = dump_new_console("geo_js_click", ci)
        ri = dump_new_requests("geo_js_click", ri)
        if "/publish" not in st["url"]:
            print(">>> 授权地理位置后 JS click 成功提交!", flush=True)
            out["winner"] = "geo_js_click"
            _shot(t, "after_geo_click")
            _finish_submit(t, out)
            return

        # 方式1:JS el.click()
        print(">>> 方式1: JS el.click()", flush=True)
        r = t._submit(t.page.evaluate(CLICK_JS))
        print(f"    click 返回 {r}", flush=True)
        st = state("js_click")
        ci = dump_new_console("js_click", ci)
        ri = dump_new_requests("js_click", ri)
        if "/publish" not in st["url"]:
            print(">>> JS click 成功提交!", flush=True)
            out["winner"] = "js_click"
            _shot(t, "after_js_click")
            _finish_submit(t, out)
            return

        # 方式2:CDP mouse(与 transport.tap 同路径,但带 delay)
        print(">>> 方式2: CDP page.mouse.click", flush=True)
        t._submit(t.page.mouse.click(btn["cx"], btn["cy"], delay=150))
        st = state("mouse_click")
        ci = dump_new_console("mouse_click", ci)
        ri = dump_new_requests("mouse_click", ri)
        if "/publish" not in st["url"]:
            print(">>> mouse click 成功提交!", flush=True)
            out["winner"] = "mouse_click"
            _finish_submit(t, out)
            return

        # 方式3:Playwright locator click(自带等待/滚动)
        print(">>> 方式3: locator click", flush=True)
        try:
            t._submit(t.page.get_by_role("button", name="发布").last.click(timeout=5000))
        except Exception as ex:
            print(f"    locator click 异常: {ex}", flush=True)
        st = state("locator_click")
        ci = dump_new_console("locator_click", ci)
        ri = dump_new_requests("locator_click", ri)
        if "/publish" not in st["url"]:
            print(">>> locator click 成功提交!", flush=True)
            out["winner"] = "locator_click"
            _finish_submit(t, out)
            return

        print("!!! 所有方式均未推进,看截图和 console", flush=True)
        _shot(t, "all_failed")
    finally:
        print(">>> console 全部:", flush=True)
        for line in out["console_tail"]:
            print("   ", line.replace("\n", " | ")[:400], flush=True)
        print(">>> POST requests:", flush=True)
        for line in out.get("requests", []):
            print("   ", line, flush=True)
        print(">>> pageerrors:", flush=True)
        for line in out["pageerrors"][-10:]:
            print("   ", line, flush=True)
        with open("shots/dbg_publish_btn.json", "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        t.close()
        srv.shutdown()


def _finish_submit(t, out):
    """提交成功后收尾:等信息/跳页,截图,尝试读 itemId;然后调删除脚本逻辑由外层处理。"""
    import re
    for _ in range(10):
        time.sleep(2)
        url = t.page.url
        m = re.search(r"[?&]id=(\d+)", url)
        out["after_submit_url"] = url
        if m and "/publish" not in url:
            out["item_id"] = m.group(1)
            break
    _shot(t, "submitted")
    print(json.dumps({k: out[k] for k in ("winner", "after_submit_url", "item_id") if k in out},
                     ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
