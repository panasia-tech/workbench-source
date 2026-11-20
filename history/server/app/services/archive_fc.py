"""调用阿里云函数打包归档媒体。"""



from __future__ import annotations



import hashlib

import hmac

import json



import httpx



from app.config import settings

from app.services.archive_collect import OrderMediaBundle

from app.services.oss import sign_download_url





class ArchiveFcNotConfiguredError(Exception):

    pass





def build_fc_payload(batch_no: str, bundles: list[OrderMediaBundle]) -> dict:

    orders = []

    for bundle in bundles:

        files = []

        for item in bundle.files:

            archive_path = f"{bundle.month_folder}/{bundle.order_date}/{bundle.order_no}/{item.archive_name}"

            files.append(

                {

                    "object_key": item.object_key,

                    "archive_path": archive_path,

                    "source_url": item.source_url,

                }

            )

        orders.append(

            {

                "order_no": bundle.order_no,

                "month": bundle.month_folder,

                "date": bundle.order_date,

                "files": files,

            }

        )

    package_key = f"archive/packages/{batch_no}.zip"

    return {

        "batch_no": batch_no,

        "bucket": settings.oss_bucket,

        "endpoint": settings.oss_endpoint,

        "public_base": settings.oss_public_base,

        "output_object_key": package_key,

        "orders": orders,

    }





def _sign_fc_body(body: str) -> str | None:

    secret = settings.archive_fc_sign_secret

    if not secret:

        return None

    return hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()





async def invoke_archive_pack(batch_no: str, bundles: list[OrderMediaBundle]) -> dict:

    payload = build_fc_payload(batch_no, bundles)

    url = settings.archive_fc_url

    if not url:

        raise ArchiveFcNotConfiguredError("订单归档未配置，请设置 ARCHIVE_FC_URL")



    body = json.dumps(payload, ensure_ascii=False)

    headers = {"Content-Type": "application/json"}

    signature = _sign_fc_body(body)

    if signature:

        headers["X-Archive-Signature"] = signature



    async with httpx.AsyncClient(timeout=120.0) as client:

        resp = await client.post(url, content=body.encode(), headers=headers)

        resp.raise_for_status()

        data = resp.json()

    if isinstance(data, dict) and "body" in data and "statusCode" in data:

        inner = data["body"]

        data = json.loads(inner) if isinstance(inner, str) else inner

    package_key = data.get("package_object_key") or payload["output_object_key"]

    package_url = data.get("package_url") or sign_download_url(package_key)

    return {

        "request_id": data.get("request_id") or data.get("requestId"),

        "status": data.get("status", "READY"),

        "package_object_key": package_key,

        "package_url": package_url,

        "message": data.get("message"),

    }

