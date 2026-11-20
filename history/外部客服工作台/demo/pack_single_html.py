#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""将 Vite 编译出的 dist/ 打包成零外部依赖的《客服工作台-桌面版H5-单文件直开版.html》（双击直接可用）"""
import glob
import os
import re

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(BASE_DIR, "dist")
OUT_FILE = os.path.join(BASE_DIR, "客服工作台-桌面版H5-单文件直开版.html")


def build_single_html():
    css_files = sorted(glob.glob(os.path.join(DIST_DIR, "assets", "*.css")))
    js_files = sorted(glob.glob(os.path.join(DIST_DIR, "assets", "*.js")))
    if not css_files or not js_files:
        raise RuntimeError("dist/assets missing built CSS or JS files")

    css_text = "\n".join(open(p, "r", encoding="utf-8").read() for p in css_files)
    js_text = "\n".join(open(p, "r", encoding="utf-8").read() for p in js_files)
    # 防止内联脚本中出现 </script> 提前闭合标签
    safe_js = re.sub(r"</script>", r"<\/script>", js_text, flags=re.IGNORECASE)

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1440, initial-scale=1.0" />
    <title>泛亚外包客服工作台 · C端桌面版 (双击直开单文件完整版)</title>
    <style>
{css_text}
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module">
{safe_js}
    </script>
  </body>
</html>
"""
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Single-file HTML written: {OUT_FILE} ({os.path.getsize(OUT_FILE)} bytes)")


if __name__ == "__main__":
    build_single_html()
