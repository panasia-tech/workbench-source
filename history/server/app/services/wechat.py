import httpx

from app.config import settings


async def code_to_openid(code: str) -> dict:
    if not settings.wx_appid or not settings.wx_secret:
        return {"openid": f"dev_{code}", "session_key": "dev"}
    url = "https://api.weixin.qq.com/sns/jscode2session"
    params = {
        "appid": settings.wx_appid,
        "secret": settings.wx_secret,
        "js_code": code,
        "grant_type": "authorization_code",
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, params=params)
    except httpx.HTTPError:
        # 不要把原始 httpx 异常往上抛：异常字符串里带着完整 URL（含 secret），
        # 被 uvicorn 记成 500 traceback 后一样会泄密。
        raise ValueError("微信登录请求失败") from None
    if resp.status_code >= 400:
        # 同理不用 raise_for_status()，避免 HTTPStatusError 把带 secret 的 URL 带进日志
        raise ValueError("微信登录服务暂时不可用") from None
    data = resp.json()
    if "errcode" in data and data["errcode"] != 0:
        raise ValueError(data.get("errmsg", "微信登录失败"))
    return data
