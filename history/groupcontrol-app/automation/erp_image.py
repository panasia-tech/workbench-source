"""从 ERP 的 OSS 取商品实拍图 → 本地 → 推进手机相册,供闲鱼发布选图。

ERP 商品图对象在 OSS bucket 的前缀:
  sku/product/   —— 商品实拍图(发布用这个)
  sku/location/  —— 库位图(勿用)
  inspection/    —— 验货/瑕疵图
  asset/*_order_* —— 订单成交截图(含买家隐私,严禁用于发布!)

凭证从 server/.env 读(OSS_ACCESS_KEY_ID/SECRET/ENDPOINT/BUCKET)。生产接入时改为:
按 SKU 从 ERP DB/接口拿该商品的 product_images 对象 key,再 fetch_key() 下载。

用法:
  python erp_image.py sample                 取 sku/product/ 一张样图 → /tmp/erp_product.jpg
  python erp_image.py key <object_key> [out]  按 key 下载
  python erp_image.py push <local.jpg>        推进手机相册(DCIM/Camera)+媒体扫描
"""

import os
import re
import subprocess
import sys
import time

_ENV_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "server", ".env")


def _bucket():
    import oss2
    env = dict(re.findall(r"^([A-Z_]+)=(.*)$", open(_ENV_PATH).read(), re.M))
    auth = oss2.Auth(env["OSS_ACCESS_KEY_ID"], env["OSS_ACCESS_KEY_SECRET"])
    return oss2.Bucket(auth, env["OSS_ENDPOINT"], env["OSS_BUCKET"])


def fetch_key(object_key: str, out: str = "/tmp/erp_product.jpg") -> str:
    """按 OSS 对象 key 下载到本地。"""
    _bucket().get_object_to_file(object_key, out)
    return out


def fetch_sample(out: str = "/tmp/erp_product.jpg") -> str:
    """取 sku/product/ 下第一张够大的实拍图(仅供原型联调)。"""
    import oss2
    b = _bucket()
    for o in oss2.ObjectIteratorV2(b, prefix="sku/product/"):
        if o.key.lower().endswith((".jpg", ".jpeg", ".png")) and o.size > 50000:
            b.get_object_to_file(o.key, out)
            print("下载", o.key, "->", out)
            return out
    raise RuntimeError("sku/product/ 下没找到合适图片")


def push_to_gallery(local: str, serial: str | None = None) -> str:
    """把本地图片推进手机相册并触发媒体扫描,返回设备上的路径。"""
    base = ["adb"] + (["-s", serial] if serial else [])
    remote = f"/sdcard/DCIM/Camera/erp_{int(time.time())}.jpg"
    subprocess.run(base + ["shell", "mkdir", "-p", "/sdcard/DCIM/Camera"], check=False)
    subprocess.run(base + ["push", local, remote], check=True)
    subprocess.run(base + ["shell", "am", "broadcast", "-a",
                           "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
                           "-d", f"file://{remote}"], check=False)
    return remote


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__); return
    if args[0] == "sample":
        fetch_sample()
    elif args[0] == "key":
        fetch_key(args[1], args[2] if len(args) > 2 else "/tmp/erp_product.jpg")
    elif args[0] == "push":
        print("推送到:", push_to_gallery(args[1]))
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
