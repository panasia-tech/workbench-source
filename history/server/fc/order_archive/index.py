"""
阿里云函数：按 月/日/订单号 目录打包订单全流程 OSS 媒体。

部署：Python 3.10 运行时，配置环境变量 OSS_* 与 ARCHIVE_FC_SIGN_SECRET（与后端一致）。
HTTP 触发器接收 POST JSON（见 archive_fc.build_fc_payload）。
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import tempfile
import zipfile

import oss2


def _verify_signature(body: str, signature: str | None) -> None:
    secret = os.environ.get("ARCHIVE_FC_SIGN_SECRET", "")
    if not secret:
        return
    if not signature:
        raise PermissionError("missing signature")
    expected = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise PermissionError("invalid signature")


def _bucket():
    auth = oss2.Auth(os.environ["OSS_ACCESS_KEY_ID"], os.environ["OSS_ACCESS_KEY_SECRET"])
    return oss2.Bucket(auth, os.environ["OSS_ENDPOINT"], os.environ["OSS_BUCKET"])


def _handler(event, context):
    if isinstance(event, (bytes, str)):
        raw = event.decode() if isinstance(event, bytes) else event
        payload = json.loads(raw)
        headers = {}
    else:
        raw = event.get("body") if isinstance(event, dict) else None
        if raw is None:
            payload = event if isinstance(event, dict) else {}
            headers = {}
        else:
            body = raw.decode() if isinstance(raw, bytes) else raw
            payload = json.loads(body)
            headers = (event.get("headers") or {}) if isinstance(event, dict) else {}

    if isinstance(payload, dict) and "orders" not in payload and "body" in payload:
        inner = payload["body"]
        payload = json.loads(inner.decode() if isinstance(inner, bytes) else inner)

    signature = None
    for key, value in (headers or {}).items():
        if key.lower() == "x-archive-signature":
            signature = value
            break

    body_text = json.dumps(payload, ensure_ascii=False)
    _verify_signature(body_text, signature)

    bucket = _bucket()
    output_key = payload["output_object_key"]
    orders = payload.get("orders") or []

    with tempfile.TemporaryDirectory() as tmp:
        zip_path = os.path.join(tmp, "package.zip")
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for order in orders:
                for file_item in order.get("files") or []:
                    object_key = file_item["object_key"]
                    archive_path = file_item["archive_path"]
                    local_path = os.path.join(tmp, object_key.replace("/", "_"))
                    bucket.get_object_to_file(object_key, local_path)
                    zf.write(local_path, arcname=archive_path)
                    os.remove(local_path)

        bucket.put_object_from_file(output_key, zip_path)

    public_base = (payload.get("public_base") or os.environ.get("OSS_PUBLIC_BASE") or "").rstrip("/")
    package_url = f"{public_base}/{output_key}" if public_base else None

    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(
            {
                "status": "READY",
                "request_id": getattr(context, "request_id", None),
                "package_object_key": output_key,
                "package_url": package_url,
            },
            ensure_ascii=False,
        ),
    }


def handler(event, context):
    try:
        return _handler(event, context)
    except Exception as exc:
        return {
            "statusCode": 500,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"status": "FAILED", "message": str(exc)}, ensure_ascii=False),
        }
