"""网页版发布 本地真实联调(用户已授权的真实操作测试)。

对 AdsPower 环境 k1esvnuc(东魏诚恳的椰子蟹)执行完整 web 发布:
  1. dry_run 填单(图片/描述/价格/包邮/所在地)→ 不发,验证全部填写步骤
  2. 真实发布测试商品(PIL 生成纯色「测试」图,文案声明自动测试,¥1,包邮)
  3. 进详情页验证 → 点「删除」清理(无忧卖商品下架被平台拦截,删除是可靠路径)
  4. 回 personal 在售列表验证宝贝消失
证据:每步 result JSON + shots/ 截图。纪律:动作间隔 ≥1.5s;命中滑块风控即中止上报。

用法:
  ./demo scripts/web_publish_local.py [--skip-dry-run]
"""
import argparse
import functools
import http.server
import json
import sys
import threading
import time

sys.path.insert(0, ".")
from app.flow.web.goods_flows_web import (  # noqa: E402
    _click_dialog_confirm,
    _collect_all_cards,
    _flat,
    _seller_button,
)
from app.flow.web.local_transport import LocalPlaywrightTransport  # noqa: E402
from app.flow.web.publish_flow_web import _check_risk, run_publish_web  # noqa: E402

DESC = "【测试商品】系统自动测试发布,请勿拍下,稍后删除"
IMG_PATH = "/tmp/gc_test_publish.jpg"
ITEM_URL = "https://www.goofish.com/item?id={}"
TITLE_PREFIX = DESC[:12]


def _serve_img() -> tuple[http.server.HTTPServer, str]:
    """起个临时 HTTP 服务喂测试图(push_media 吃的是 URL)。"""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory="/tmp")
    srv = http.server.HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_port}/gc_test_publish.jpg"


def _delete_item(t, item_id: str, out: dict) -> None:
    """详情页「删除」→ 确认弹窗「确定」→ 详情页/列表双重验证。"""
    t.launch_app(ITEM_URL.format(item_id))
    time.sleep(4)
    out["delete_before"] = "shots/e2e_delete_before.jpg"
    with open(out["delete_before"], "wb") as f:
        f.write(t.screencap())
    nodes = _flat(t.dump_nodes())
    _check_risk(nodes, t)
    btn = _seller_button(nodes, "删除")
    if not btn:
        raise RuntimeError(f"详情页(item_id={item_id})未找到「删除」按钮")
    t.tap(btn["cx"], btn["cy"])
    time.sleep(2.5)
    nodes = _flat(t.dump_nodes())
    _check_risk(nodes, t)
    _click_dialog_confirm(t, nodes, lambda name: _shot(t, name), "delete")
    out["delete_confirmed"] = "shots/e2e_delete_confirmed.jpg"
    with open(out["delete_confirmed"], "wb") as f:
        f.write(t.screencap())
    # 删除后详情页应提示不存在/已删除
    time.sleep(2)
    nodes = _flat(t.dump_nodes())
    gone_hint = any(k in " ".join((n.get("desc") or "") for n in nodes)
                    for k in ("已删除", "不存在", "已下架", "失效"))
    out["delete_gone_hint"] = gone_hint


def _shot(t, name: str) -> str:
    path = f"shots/{int(time.time())}_{name}.png"
    with open(path, "wb") as f:
        f.write(t.screencap())
    return path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-dry-run", action="store_true")
    args = ap.parse_args()
    srv, img_url = _serve_img()
    t = LocalPlaywrightTransport()
    out: dict = {"img_url": img_url, "spec_desc": DESC}
    try:
        if not args.skip_dry_run:
            print(">>> 1. dry_run 填单(不发) ...", flush=True)
            spec = {"images": [img_url], "description": DESC, "price": 1,
                    "shipping": {"mode": "free"}, "location": "杭州",
                    "confirm_publish": False, "dry_run": True}
            started = time.time()
            out["dry_run"] = run_publish_web(t, spec)
            out["dry_run"]["elapsed_sec"] = round(time.time() - started, 1)
            print(json.dumps(out["dry_run"], ensure_ascii=False, indent=2), flush=True)
            if not out["dry_run"].get("ok"):
                print("!!! dry_run 失败,中止(不真发)", flush=True)
                return
            print(">>> dry_run 通过,等 5s 后真实发布 ...", flush=True)
            time.sleep(5)

        print(">>> 2. 真实发布 ...", flush=True)
        spec = {"images": [img_url], "description": DESC, "price": 1,
                "shipping": {"mode": "free"}, "location": "杭州",
                "attrs": {"成色": "轻微使用痕迹"},
                "confirm_publish": True, "dry_run": False}
        started = time.time()
        out["publish"] = run_publish_web(t, spec)
        out["publish"]["elapsed_sec"] = round(time.time() - started, 1)
        print(json.dumps(out["publish"], ensure_ascii=False, indent=2), flush=True)
        with open("shots/e2e_published.jpg", "wb") as f:
            f.write(t.screencap())
        item_id = out["publish"].get("item_id")
        if not out["publish"].get("ok") and not out["publish"].get("published"):
            print("!!! 发布未成功且未点发布/无 itemId,无需清理", flush=True)
            return
        if not item_id:
            print("!!! 已发布但拿不到 itemId——需人工进在售列表找「测试」并删除!", flush=True)
            return

        print(f">>> 3. 进详情页验证并删除 item_id={item_id} ...", flush=True)
        time.sleep(15)   # 发布后立刻连跳详情页易触发 punish 滑块,先让页面喘口气
        try:
            _delete_item(t, item_id, out)

            print(">>> 4. 回在售列表验证消失 ...", flush=True)
            time.sleep(3)
            from app.flow.web.goods_flows_web import _collect_all_cards
            t.launch_app("https://www.goofish.com/personal")
            time.sleep(4)
            cards = _collect_all_cards(t, *t.screen_size())
            gone = not any(c["title"] and TITLE_PREFIX in c["title"] for c in cards)
            out["verify"] = {"item_deleted_from_list": gone,
                             "titles": [c["title"] for c in cards][:10]}
            with open("shots/e2e_final.jpg", "wb") as f:
                f.write(t.screencap())
            print(json.dumps(out["verify"], ensure_ascii=False, indent=2), flush=True)
            print(f"\n>>> 结果: 发布 ok={out['publish'].get('ok')} item_id={item_id} "
                  f"删除后列表消失={gone}", flush=True)
            if not gone:
                print("!!! 删除后列表仍见测试宝贝——需人工处理!", flush=True)
        except Exception as ex:
            out["cleanup_error"] = str(ex)
            print(f"!!! 清理阶段异常(商品可能仍在售,需人工/稍后处理): {ex}", flush=True)
    finally:
        t.close()
        srv.shutdown()
        with open("shots/e2e_publish_result.json", "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        print("result → shots/e2e_publish_result.json", flush=True)


if __name__ == "__main__":
    main()
