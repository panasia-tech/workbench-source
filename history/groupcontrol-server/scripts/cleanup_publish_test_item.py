"""轮询重试删除 punish 风控中的测试商品(1083329736537)。

punish 滑块拦在详情页 API,不过滑块、只等冷却;每 4min 试一次,最多 12 次。
结果追加到 shots/cleanup_retry.log。
"""
import json
import sys
import time

sys.path.insert(0, ".")
from app.flow.web.goods_flows_web import _flat, _seller_button, _click_dialog_confirm
from app.flow.web.local_transport import LocalPlaywrightTransport
from app.flow.web.publish_flow_web import _check_risk

ITEM_URL = "https://www.goofish.com/item?id=1083329736537"


def log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open("shots/cleanup_retry.log", "a", encoding="utf-8") as f:
        f.write(line + "\n")


def main() -> None:
    t = LocalPlaywrightTransport()
    try:
        for attempt in range(1, 13):
            try:
                t.launch_app(ITEM_URL)
                time.sleep(8)
                nodes = _flat(t.dump_nodes())
                _check_risk(nodes, t)
            except Exception as ex:
                log(f"第{attempt}次: 风控仍在({ex})")
                time.sleep(240)
                continue
            btn = _seller_button(nodes, "删除")
            if not btn:
                log(f"第{attempt}次: 风控已过但无删除按钮,截图存 shots/cleanup_no_btn.png")
                with open("shots/cleanup_no_btn.png", "wb") as f:
                    f.write(t.screencap())
                return
            t.tap(btn["cx"], btn["cy"])
            time.sleep(3)
            nodes = _flat(t.dump_nodes())
            _check_risk(nodes, t)
            _click_dialog_confirm(t, nodes, lambda n: open(f"shots/{int(time.time())}_cleanup_{n}.png", "wb").write(t.screencap()), "del")
            time.sleep(3)
            nodes = _flat(t.dump_nodes())
            joined = " ".join((n.get("desc") or "") for n in nodes)
            hits = [k for k in ("已删除", "被删掉", "不存在", "已下架", "失效") if k in joined]
            with open("shots/cleanup_done.png", "wb") as f:
                f.write(t.screencap())
            log(f"第{attempt}次: 已点删除,删后提示={hits}")
            return
        log("12 次重试仍未冷却,商品仍在售,需人工处理")
    finally:
        t.close()


if __name__ == "__main__":
    main()
