"""一次性 OSS 连通性探测（不启动服务）。"""

import re

import sys



import oss2



from app.config import settings

from app.services.oss import OssNotConfiguredError, generate_upload_token, get_oss_bucket





def mask(s: str, n: int = 4) -> str:

    if not s:

        return "(空)"

    if len(s) <= n + 2:

        return "***"

    return f"{s[:n]}***{s[-2:]}"





def infer_from_public_base(url: str) -> tuple[str, str] | None:

    m = re.match(r"https://([^.]+)\.oss-([^.]+)\.aliyuncs\.com", url or "")

    if not m:

        return None

    return m.group(1), m.group(2)





def try_bucket_info(endpoint: str, bucket_name: str) -> tuple[bool, str]:

    try:

        auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)

        b = oss2.Bucket(auth, endpoint, bucket_name)

        b.get_bucket_info()

        return True, "OK"

    except Exception as e:

        return False, f"{type(e).__name__}: {e}"





def main() -> int:

    print("=== OSS 配置检查 ===")

    print("OSS_BUCKET:", repr(settings.oss_bucket) if settings.oss_bucket else "(空)")

    print("OSS_ENDPOINT:", settings.oss_endpoint)

    print("OSS_PUBLIC_BASE:", settings.oss_public_base)

    print("OSS_ACCESS_KEY_ID:", mask(settings.oss_access_key_id))



    try:

        bucket = get_oss_bucket()

        print("get_oss_bucket(): 已连接")

    except OssNotConfiguredError as e:

        print("get_oss_bucket(): 失败 —", e)

        return 2



    try:

        token = generate_upload_token("_healthcheck/", "probe.txt")

    except Exception as e:

        print("generate_upload_token: 失败 —", e)

        return 1



    print("\n=== upload-token 探测 ===")

    print("object_key:", token.get("object_key"))

    print("upload_url 主机:", (token.get("upload_url") or "").split("/")[2][:60])



    key = "_healthcheck/probe.txt"

    try:

        bucket.put_object(key, b"erp-oss-probe")

        bucket.get_object(key)

        bucket.delete_object(key)

        print(f"\n读写删探测 ({key}): OK")

    except Exception as e:

        print(f"\n读写删探测: FAIL — {type(e).__name__}: {e}")

        return 1



    inferred = infer_from_public_base(settings.oss_public_base)

    if inferred:

        name, region = inferred

        if name != settings.oss_bucket:

            print(f"\n提示: OSS_PUBLIC_BASE 推断 bucket={name}，与 OSS_BUCKET 不一致")

        ep = f"https://oss-{region}.aliyuncs.com"

        if ep != settings.oss_endpoint:

            print(f"提示: 推断 endpoint={ep}，与 OSS_ENDPOINT 不一致")



    return 0





if __name__ == "__main__":

    sys.exit(main())


