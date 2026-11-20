"""网页版下架+重新上架 本地真实联调(用户已授权的真实操作测试)。

对低价测试宝贝「顺睿吹风机 灰紫配色 ¥9」(item_id=1073268049033,AdsPower 环境 k1esvnuc)执行:
  1. run_delist_web 真实下架
  2. 间隔 ≥10s
  3. run_relist_web 重新上架恢复原状
  4. 校验在售列表能再看到它

证据:每步 result JSON + shots/ 截图(操作前后各一张)。
纪律:动作间 ≥1.5s;页面跳转 ≥2s;命中滑块风控即中止上报,不过滑块。
测试完必须恢复原状(宝贝回到在售)。

说明:沙发(1082054516652)/电竞桌子(1082054456277)均为无忧卖商品,网页版下架被平台
拦截(toast「为保障无忧卖流量推广效果…」),不能作测试商品;吹风机详情页无无忧卖标记。

用法:
  ./demo scripts/web_delist_local.py
"""
import json
import sys
import time

sys.path.insert(0, ".")
from app.flow.web.goods_flows_web import run_delist_web, run_relist_web  # noqa: E402
from app.flow.web.local_transport import LocalPlaywrightTransport  # noqa: E402

# 测试商品(2026-09-09 探测:在售列表「松能 白色款 ¥99」,详情页 id=1079117719374)
# (沙发/电竞桌子/吹风机/台式主机均已实测是无忧卖商品、网页版下架被平台拦截,逐个换候选)
TEST_SPEC = {"item_id": "1079117719374", "title": "松能 白色款", "price": 99}
RELAY_SEC = 12       # 下架→重上间隔(纪律要求 ≥10s)


def main():
    t = LocalPlaywrightTransport()
    out = {"spec": TEST_SPEC}
    try:
        # ---- 操作前留证:在售列表能看到目标
        t.launch_app("https://www.goofish.com/personal")
        time.sleep(4)
        with open("shots/e2e_before.jpg", "wb") as f:
            f.write(t.screencap())
        time.sleep(2)

        # ---- 1. 真实下架
        print(">>> run_delist_web ...", flush=True)
        started = time.time()
        out["delist"] = run_delist_web(t, dict(TEST_SPEC))
        out["delist"]["elapsed_sec"] = round(time.time() - started, 1)
        print(json.dumps(out["delist"], ensure_ascii=False, indent=2), flush=True)
        if not out["delist"].get("ok"):
            print("!!! 下架失败——不测重上(避免对状态未知的商品操作),需人工核对", flush=True)
            return
        with open("shots/e2e_after_delist.jpg", "wb") as f:
            f.write(t.screencap())

        # ---- 2. 间隔 ≥10s
        print(f">>> 等待 {RELAY_SEC}s 后重新上架 ...", flush=True)
        time.sleep(RELAY_SEC)

        # ---- 3. 重新上架恢复原状
        print(">>> run_relist_web ...", flush=True)
        started = time.time()
        out["relist"] = run_relist_web(t, dict(TEST_SPEC))
        out["relist"]["elapsed_sec"] = round(time.time() - started, 1)
        print(json.dumps(out["relist"], ensure_ascii=False, indent=2), flush=True)
        with open("shots/e2e_after_relist.jpg", "wb") as f:
            f.write(t.screencap())

        # ---- 4. 终态校验:在售列表再看到它(流程内已校验,这里再截图留证)
        time.sleep(3)
        t.launch_app("https://www.goofish.com/personal")
        time.sleep(4)
        with open("shots/e2e_final.jpg", "wb") as f:
            f.write(t.screencap())

        restored = bool(out["relist"].get("ok"))
        out["restored"] = restored
        print(f"\n>>> 结果: 下架 ok={out['delist'].get('ok')}  重上 ok={out['relist'].get('ok')}"
              f"  恢复原状={restored}", flush=True)
        if not restored:
            print("!!! 重新上架失败——宝贝未恢复在售,需人工处理!", flush=True)
    finally:
        t.close()
        with open("shots/e2e_result.json", "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        print("result → shots/e2e_result.json", flush=True)


if __name__ == "__main__":
    main()
