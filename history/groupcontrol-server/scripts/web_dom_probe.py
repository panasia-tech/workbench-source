"""网页版 DOM 探针(一次性):连 AdsPower 浏览器,goto /im,dump 扁平节点存 /tmp/web_im_nodes.json。

用法(用 adspower-executor 的 venv,里面有 playwright):
  ./demo scripts/web_dom_probe.py [url]
"""
import json
import sys
import time

sys.path.insert(0, ".")
from app.flow.web.local_transport import LocalPlaywrightTransport  # noqa: E402


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "https://www.goofish.com/im"
    t = LocalPlaywrightTransport()
    try:
        print("current page:", t.page.url)
        t.launch_app(url)
        time.sleep(5)
        print("after goto:", t.page.url)
        nodes = t.dump_nodes()
        with open("/tmp/web_im_nodes.json", "w", encoding="utf-8") as f:
            json.dump(nodes, f, ensure_ascii=False, indent=1)
        with open("/tmp/web_im_shot.jpg", "wb") as f:
            f.write(t.screencap())
        print(f"nodes={len(nodes)} -> /tmp/web_im_nodes.json, shot -> /tmp/web_im_shot.jpg")
        for n in nodes:
            d = (n["desc"] or "")[:60].replace("\n", "|")
            print(f'cy={n["center"][1]:>5} cx={n["center"][0]:>5} clk={int(n["clickable"])} cls={n["cls"][:70]:<70} {d}')
    finally:
        t.close()


if __name__ == "__main__":
    main()
