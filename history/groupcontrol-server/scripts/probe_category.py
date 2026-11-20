"""探针:看发布页顶部分类行结构(浏览器还停在填好的发布页)。"""
import sys
import time

sys.path.insert(0, ".")
from app.flow.web.goods_flows_web import _flat
from app.flow.web.local_transport import LocalPlaywrightTransport

JS = """
() => {
  const out = [];
  const els = document.querySelectorAll('[class*="category--"], [class*="cate--"], [class*="classify--"]');
  for (const e of els) {
    out.push({cls: String(e.className).slice(0, 100), text: (e.textContent || '').trim().slice(0, 120)});
  }
  // 找全页包含「分类」二字的可见行
  const rows = [];
  for (const e of document.querySelectorAll('div, span, label')) {
    const t = (e.textContent || '').trim();
    if (t === '分类' || t.startsWith('分类 ')) {
      const r = e.getBoundingClientRect();
      rows.push({tag: e.tagName, cls: String(e.className).slice(0, 80), text: t.slice(0, 80),
                 x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)});
    }
  }
  return {catEls: out, rows: rows.slice(0, 10)};
}
"""

t = LocalPlaywrightTransport()
try:
    w, h = t.screen_size()
    # 滚到顶部
    t._submit(t.page.evaluate("() => window.scrollTo(0, 0)"))
    time.sleep(1.5)
    data = t._submit(t.page.evaluate(JS))
    import json
    print(json.dumps(data, ensure_ascii=False, indent=2))
    with open("shots/probe_cat.png", "wb") as f:
        f.write(t.screencap())
finally:
    t.close()
