"""探针2:点分类下拉,看选项结构。"""
import json
import sys
import time

sys.path.insert(0, ".")
from app.flow.web.goods_flows_web import _flat
from app.flow.web.local_transport import LocalPlaywrightTransport

t = LocalPlaywrightTransport()
try:
    w, h = t.screen_size()
    nodes = _flat(t.dump_nodes())
    # 分类行是 ant-select:desc 为当前值的节点,找「软件」文本节点
    cur = next((n for n in nodes if "软件" in (n.get("desc") or "")), None)
    print("当前分类节点:", json.dumps(cur, ensure_ascii=False))
    if cur:
        t.tap(cur["cx"], cur["cy"])
        time.sleep(2)
    with open("shots/probe_cat2.png", "wb") as f:
        f.write(t.screencap())
    nodes = _flat(t.dump_nodes())
    # dump 所有可见节点,重点:弹层里的选项
    interesting = [n for n in nodes
                   if any(k in (n.get("cls") or "") for k in ("ant-select", "cate", "tree", "option", "modal", "drawer"))
                   or (n.get("desc") or "").strip() in
                   ("分类", "其他", "闲置", "数码", "家电", "母婴", "图书", "服饰")]
    for n in interesting[:60]:
        print(json.dumps(n, ensure_ascii=False))
finally:
    t.close()
