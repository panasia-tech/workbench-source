"""上传采购录入示例图到 OSS public/purchase/examples/（public-read）。"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.config import settings
from app.services.oss import OssNotConfiguredError, canonical_public_url, get_oss_bucket
from app.services.purchase_examples import PRODUCT_KEY, PUBLIC_DIR, SCREENSHOT_KEY

DEFAULT_SOURCE_DIR = Path(r"C:\Users\Administrator\Desktop\erp测试")


def _pick_sources(source_dir: Path) -> tuple[Path, Path]:
    files = sorted(source_dir.glob("*.png"))
    if len(files) < 2:
        raise FileNotFoundError(f"需要至少 2 张 PNG，当前目录：{source_dir}")
    screenshot = next((f for f in files if "订单" in f.stem), files[-1])
    product = next((f for f in files if f != screenshot), files[0])
    return screenshot, product


def _upload_public(key: str, file_path: Path) -> str:
    bucket = get_oss_bucket()
    content = file_path.read_bytes()
    headers = {"Content-Type": "image/png"}
    bucket.put_object(key, content, headers=headers)
    return canonical_public_url(key)


def main() -> int:
    source_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SOURCE_DIR
    if not source_dir.is_dir():
        print(f"源目录不存在：{source_dir}")
        return 1
    try:
        screenshot_src, product_src = _pick_sources(source_dir)
    except FileNotFoundError as exc:
        print(exc)
        return 1
    try:
        get_oss_bucket()
    except OssNotConfiguredError as exc:
        print(exc)
        return 1

    print(f"源目录：{source_dir}")
    print(f"订单截图示例：{screenshot_src.name} -> {SCREENSHOT_KEY}")
    print(f"商品图示例：{product_src.name} -> {PRODUCT_KEY}")

    screenshot_url = _upload_public(SCREENSHOT_KEY, screenshot_src)
    product_url = _upload_public(PRODUCT_KEY, product_src)

    print("\n上传完成：")
    print("screenshot_url:", screenshot_url)
    print("product_url:", product_url)
    print(f"\n对象前缀：{PUBLIC_DIR}/")
    print("小程序通过 /api/config 的 purchase_examples 获取签名 URL。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
