"""ADB + 本地 OCR 的「截图 → 识别文字 → 按位置点击」原型工具。

闲鱼是 Flutter，无障碍读不到控件，只能截图 OCR 拿文字坐标再点。
本工具在 Mac 上通过 ADB 驱动真机，用 RapidOCR(本地 PP-OCR/ONNX，离线中文)识别，
用于开发/验证闲鱼上下架、发布、改价等操作流程；成熟后再移植到端上或后端。

依赖：pip install rapidocr_onnxruntime（含中文模型，首次运行离线可用）
用法：
  python ocr_tap.py shot [out.png]              截图保存
  python ocr_tap.py read                         识别当前屏所有文字+坐标
  python ocr_tap.py find "行情"                  找文字，打印命中框中心坐标
  python ocr_tap.py tap-text "我要卖"            找到文字并点击其中心
  python ocr_tap.py tap 540 1200                 直接点坐标
  python ocr_tap.py swipe 540 1600 540 600       滑动
  python ocr_tap.py input "AOC 24G2 正常使用痕迹"  输入文本(需焦点在输入框)
可加 --serial <设备号> 指定多设备中的一台。
"""

import subprocess
import sys
from io import BytesIO

import numpy as np

_engine = None


def engine():
    global _engine
    if _engine is None:
        from rapidocr_onnxruntime import RapidOCR
        _engine = RapidOCR()
    return _engine


def _adb_base(serial: str | None) -> list[str]:
    return ["adb"] + (["-s", serial] if serial else [])


_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def screencap(serial: str | None = None) -> bytes:
    """adb 截屏，返回 PNG 字节。

    小米 HyperOS 等会在 screencap 输出前注入 `[Warning] Multiple displays...` 一行，
    污染 PNG 头，故从 PNG magic 处切齐。
    """
    raw = subprocess.run(
        _adb_base(serial) + ["exec-out", "screencap", "-p"],
        capture_output=True, check=True,
    ).stdout
    idx = raw.find(_PNG_MAGIC)
    if idx > 0:
        raw = raw[idx:]
    return raw


def _to_ndarray(png: bytes) -> np.ndarray:
    import cv2
    arr = np.frombuffer(png, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError("截图解码失败（设备是否已授权 USB 调试？）")
    return img


def ocr(png: bytes) -> list[dict]:
    """返回 [{text, score, box(4点), center(x,y)}]。"""
    img = _to_ndarray(png)
    result, _ = engine()(img)
    out = []
    for box, text, score in (result or []):
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        out.append({
            "text": text,
            "score": float(score),
            "box": box,
            "center": (int(sum(xs) / 4), int(sum(ys) / 4)),
        })
    return out


def find(items: list[dict], target: str, contains: bool = True) -> dict | None:
    """在识别结果里找匹配文字，返回置信度最高的一条。"""
    if contains:
        cands = [it for it in items if target in it["text"]]
    else:
        cands = [it for it in items if it["text"].strip() == target]
    return max(cands, key=lambda it: it["score"]) if cands else None


def tap(x: int, y: int, serial: str | None = None) -> None:
    subprocess.run(_adb_base(serial) + ["shell", "input", "tap", str(x), str(y)], check=True)


def swipe(x1, y1, x2, y2, ms=300, serial=None) -> None:
    subprocess.run(
        _adb_base(serial) + ["shell", "input", "swipe", str(x1), str(y1), str(x2), str(y2), str(ms)],
        check=True,
    )


def input_text(text: str, serial: str | None = None) -> None:
    # adb input text 不支持中文；中文需走 ADBKeyboard 广播输入法（见 README）
    subprocess.run(_adb_base(serial) + ["shell", "input", "text", text], check=True)


def main():
    args = [a for a in sys.argv[1:]]
    serial = None
    if "--serial" in args:
        i = args.index("--serial")
        serial = args[i + 1]
        del args[i:i + 2]
    if not args:
        print(__doc__)
        return
    cmd = args[0]

    if cmd == "shot":
        out = args[1] if len(args) > 1 else "screen.png"
        open(out, "wb").write(screencap(serial))
        print(f"已保存 {out}")
    elif cmd == "read":
        for it in ocr(screencap(serial)):
            print(f"{it['center']}  {it['score']:.2f}  {it['text']}")
    elif cmd == "find":
        hit = find(ocr(screencap(serial)), args[1])
        print(hit["center"] if hit else "未找到", hit["text"] if hit else "")
    elif cmd == "tap-text":
        hit = find(ocr(screencap(serial)), args[1])
        if not hit:
            print("未找到，未点击"); sys.exit(2)
        x, y = hit["center"]
        tap(x, y, serial)
        print(f"已点击 {args[1]} @ ({x},{y})")
    elif cmd == "tap":
        tap(int(args[1]), int(args[2]), serial)
    elif cmd == "swipe":
        swipe(int(args[1]), int(args[2]), int(args[3]), int(args[4]), serial=serial)
    elif cmd == "input":
        input_text(args[1], serial)
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
