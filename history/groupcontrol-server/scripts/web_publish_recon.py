"""发布页 DOM 侦察(只读为主):dump_nodes + 关键结构输出 + 截图。

用法: adspower-executor/.venv/bin/python scripts/web_publish_recon.py
"""
import json
import sys
import time

sys.path.insert(0, ".")
from app.flow.web.goods_flows_web import _flat  # noqa: E402
from app.flow.web.local_transport import LocalPlaywrightTransport  # noqa: E402

STRUCT_JS = r"""
() => {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const info = (el) => {
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return {
      tag: el.tagName, cls: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
      id: el.id || '', ph: el.getAttribute('placeholder') || '',
      text: (el.textContent || '').trim().slice(0, 60),
      visible: st.display !== 'none' && st.visibility !== 'hidden' && r.width >= 2 && r.height >= 2,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      accept: el.getAttribute('accept') || '',
    };
  };
  return {
    url: location.href,
    files: q('input[type=file]').map(info),
    editors: q('[contenteditable], div[class*="editor--"], textarea').map(info),
    ant_inputs: q('input.ant-input').map(info),
    radios: q('input[type=radio]').map((el) => ({...info(el),
      checked: el.checked,
      label: (el.closest('label') || el.parentElement || {}).textContent?.trim().slice(0, 30) || ''})),
    checkboxes: q('input[type=checkbox]').map((el) => ({...info(el), checked: el.checked,
      label: (el.closest('label') || el.parentElement || {}).textContent?.trim().slice(0, 30) || ''})),
    upload_wrappers: q('[class*="ant-upload-wrapper"], [class*="ant-upload"]').map(info).slice(0, 10),
  };
}
"""


def main():
    t = LocalPlaywrightTransport()
    try:
        t.launch_app("https://www.goofish.com/publish")
        time.sleep(6)
        with open("shots/pub_recon_top.jpg", "wb") as f:
            f.write(t.screencap())
        data = t._submit(t.page.evaluate(STRUCT_JS))
        print(json.dumps(data, ensure_ascii=False, indent=1))
        nodes = _flat(t.dump_nodes())
        with open("shots/pub_recon_dump.json", "w", encoding="utf-8") as f:
            json.dump(nodes, f, ensure_ascii=False, indent=1)
        # 关键文本节点(发布按钮/所在地/发货方式/草稿弹窗)
        for n in nodes:
            d = (n.get("desc") or "")
            if any(k in d for k in ("发布", "所在地", "发货", "草稿", "继续编辑", "放弃", "添加首图",
                                    "智能识别", "取消", "确定", "包邮", "自提")):
                print("NODE:", json.dumps(n, ensure_ascii=False))
    finally:
        t.close()


if __name__ == "__main__":
    main()
