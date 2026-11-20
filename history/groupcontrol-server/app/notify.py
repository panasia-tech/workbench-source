"""新买家消息 → 企微推送(聊天接待 1c)。

设计:
- 通道:**企微应用直发优先**(corpid/secret/agentid,无每日限额;需「企业可信IP」含本机);
  未配置或失败时回退 **Server酱**(form-urlencoded POST 到 sctapi.ftqq.com/<SENDKEY>.send)。
  收件人边界(采购+销售收、管理员不收)由企微 touser / Server酱后台通道决定,代码不按角色分发。
- 免费版每日限额(Server酱约 5 条)→ 全局聚合+冷却:冷却窗内新增的 inbound 消息累计进 pending,
  过窗后发一条汇总提醒;发送失败保留 pending,下个窗口重试。
"""

import json
import logging
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

from app import storage
from app.config import settings
from app.models import NotifyState
from app.task_replay import build_replay

logger = logging.getLogger("gc.notify")

K_PENDING = "chat_pending_new"             # 累计待提醒的新增 inbound 数
K_PENDING_DETAILS = "chat_pending_details" # 累计待提醒的会话明细(JSON 数组)
K_LAST_NOTIFIED = "chat_last_notified_at"  # 上次成功推送时间(ISO)
K_REFRESH_NOTIFIED_DAY = "refresh_problem_notified_day"  # 链接焕新出岔子:今天推过没有
K_RESTART_PAUSE_NOTIFIED_DAY = "restart_pause_notified_day"  # 巡航台暂停没恢复:今天推过没有

# 明细行上限:企微 text 保守截 600 字,12 行典型行宽(~45 字)≈550 字,超出用「等 N 个会话」收口
MAX_DETAIL_LINES = 12


def _get(db, key: str) -> str | None:
    row = db.get(NotifyState, key)
    return row.value if row else None


def _set(db, key: str, value: str) -> None:
    row = db.get(NotifyState, key)
    if not row:
        row = NotifyState(key=key)
        db.add(row)
    row.value = value
    # SessionLocal 是 autoflush=False:不落盘的话,同会话后续 _get 读不到刚写的行
    db.flush()


def _post(url: str, fields: dict) -> dict:
    """真实发送:form-urlencoded POST,返回解析后的 JSON。抽出来便于单测替换,避免引 httpx。"""
    data = urllib.parse.urlencode(fields).encode("utf-8")
    req = urllib.request.Request(url, data=data)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def notify(title: str, desp: str, poster=None) -> bool:
    """POST Server酱;sendkey 未配置为 no-op。返回是否送达(code==0)。失败只记日志不抛。"""
    key = settings.serverchan_sendkey
    if not key:
        return False
    poster = poster or _post
    try:
        body = poster(f"https://sctapi.ftqq.com/{key}.send",
                      {"title": title[:32], "desp": desp})
        ok = isinstance(body, dict) and body.get("code") == 0
        if not ok:
            logger.warning("Server酱返回非成功: %r", body)
        return ok
    except Exception:
        logger.exception("Server酱推送失败")
        return False


# ==================== 企微应用直发(优先通道;无每日限额)====================
# 参考 notify-wecom-server.mjs:msgtype=text 才能经微信插件直出全文(markdown 只在企微 App 可见)。
# 前提:企微后台该应用的「企业可信IP」含本机公网 IP,否则 message/send 报 60020。
_token_cache: dict = {"token": None, "expires_at": 0.0}  # 进程内缓存;单 worker 足够


def _get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def _post_json(url: str, payload: dict) -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def _wecom_configured() -> bool:
    return bool(settings.wecom_corpid and settings.wecom_corpsecret and settings.wecom_agentid)


def _wecom_token(getter=None) -> str:
    getter = getter or _get_json
    now = time.time()
    if _token_cache["token"] and _token_cache["expires_at"] > now + 60:
        return _token_cache["token"]
    body = getter("https://qyapi.weixin.qq.com/cgi-bin/gettoken"
                  f"?corpid={settings.wecom_corpid}&corpsecret={settings.wecom_corpsecret}")
    token = isinstance(body, dict) and body.get("access_token")
    if not token:
        raise RuntimeError(f"gettoken 失败: {body!r}")
    _token_cache.update(token=token, expires_at=now + float(body.get("expires_in", 7200)) - 300)
    return token


def notify_wecom(title: str, desp: str, *, getter=None, poster=None) -> bool:
    """企微应用直发 text 消息。未配置为 no-op;失败只记日志不抛,调用方回退 Server酱。"""
    if not _wecom_configured():
        return False
    poster = poster or _post_json
    try:
        token = _wecom_token(getter=getter)
        # text 上限 2048 字节,中文 3 字节/字,保守截 600 字
        content = (f"{title}\n\n{desp}" if desp else title)[:600]
        body = poster(
            f"https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token={token}",
            {"touser": settings.wecom_touser or "@all", "msgtype": "text",
             "agentid": int(settings.wecom_agentid), "text": {"content": content}},
        )
        ok = isinstance(body, dict) and body.get("errcode") == 0
        if not ok:
            hint = "(60020=可信IP未配:企微后台该应用「企业可信IP」加本机公网IP)" \
                if isinstance(body, dict) and body.get("errcode") == 60020 else ""
            logger.warning("企微推送返回非成功: %r %s", body, hint)
            if isinstance(body, dict) and body.get("errcode") in (40014, 42001):
                _token_cache.update(token=None, expires_at=0.0)  # token 失效:清缓存下次重取
        return ok
    except Exception:
        logger.exception("企微推送失败")
        return False


def _send(title: str, desp: str, *, poster=None) -> bool:
    """发送入口:企微直发优先,未配置或失败则回退 Server酱。poster 仅透传给 Server酱(单测用)。"""
    if notify_wecom(title, desp):
        return True
    return notify(title, desp, poster=poster)


def notify_refresh_problem(db, title: str, desp: str, *, day: str, poster=None) -> bool:
    """链接焕新删了旧链接、新的没确认发上去:一天最多推一条(day 是北京日界)。

    Server酱免费额度一天约 5 条,企微又被可信 IP 拦着,得把额度留给买家消息。同一天后面的
    同类岔子只记日志:第二天的焕新会自动重发,行情台任务列表里也看得到每一单。
    状态落 gc_notify_state,由调用方随业务事务 commit;没发出去不记,下一条再试。
    """
    if _get(db, K_REFRESH_NOTIFIED_DAY) == day:
        return False
    if not _send(title, desp, poster=poster):
        return False
    _set(db, K_REFRESH_NOTIFIED_DAY, day)
    return True


def notify_restart_pause(db, count: int, *, now: datetime, poster=None) -> bool:
    """巡航台暂停后执行端一直没回来:一天最多推一条,北京时间 09:00~23:00 才推。
    状态由调用方 commit;没发出去不记,下一轮再试。"""
    cn = now + timedelta(hours=8)
    day = cn.date().isoformat()
    if not 9 <= cn.hour < 23 or _get(db, K_RESTART_PAUSE_NOTIFIED_DAY) == day:
        return False
    if not _send("巡航台暂停后没恢复",
                 f"{count} 个执行端暂停超过 1 小时还没回来,消息和上架都停着。"
                 "不重启电脑就回巡航台点「不重启了，继续」;已重启就打开巡航台和 AdsPower。",
                 poster=poster):
        return False
    _set(db, K_RESTART_PAUSE_NOTIFIED_DAY, day)
    return True


# ==================== 现场截图:image 消息 / 签名直链 ====================
# 风控「闲鱼账号要人工处理」这类通知,光有文字远程看不出现场。企微发图两步:
# media/upload(multipart/form-data,字段 media,≤10MB JPG/PNG)拿 media_id →
# message/send msgtype=image。Server酱通道发不了图,降级为 24h 签名直链拼进文本。

def _post_multipart(url: str, field: str, filename: str, blob: bytes) -> dict:
    """multipart/form-data POST(企微 media/upload 用),返回解析后的 JSON。
    手写 boundary 不引新依赖;抽出来与 _post/_post_json 同款,便于单测整体替换。"""
    boundary = f"----gcnotify{int(time.time() * 1000)}"
    head = (f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n").encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
    req = urllib.request.Request(
        url, data=head + blob + tail,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=30) as resp:   # 大图慢网给足时间
        return json.loads(resp.read().decode("utf-8") or "{}")


def notify_wecom_image(image_bytes: bytes, *, getter=None, uploader=None, poster=None) -> bool:
    """企微应用直发 image 消息:media/upload 拿 media_id → message/send。
    未配置为 no-op;任一步失败只记日志返回 False。token 失效(40014/42001)清缓存,
    与 notify_wecom 一致。"""
    if not _wecom_configured():
        return False
    uploader = uploader or _post_multipart
    poster = poster or _post_json
    try:
        token = _wecom_token(getter=getter)
        up = uploader(f"https://qyapi.weixin.qq.com/cgi-bin/media/upload"
                      f"?access_token={token}&type=image",
                      "media", "risk.jpg", image_bytes)
        media_id = isinstance(up, dict) and up.get("media_id")
        if not media_id:
            logger.warning("企微图片上传返回非成功: %r", up)
            if isinstance(up, dict) and up.get("errcode") in (40014, 42001):
                _token_cache.update(token=None, expires_at=0.0)  # upload 阶段 token 失效同样清缓存
            return False
        body = poster(
            f"https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token={token}",
            {"touser": settings.wecom_touser or "@all", "msgtype": "image",
             "agentid": int(settings.wecom_agentid), "image": {"media_id": media_id}},
        )
        ok = isinstance(body, dict) and body.get("errcode") == 0
        if not ok:
            hint = "(60020=可信IP未配:企微后台该应用「企业可信IP」加本机公网IP)" \
                if isinstance(body, dict) and body.get("errcode") == 60020 else ""
            logger.warning("企微图片推送返回非成功: %r %s", body, hint)
            if isinstance(body, dict) and body.get("errcode") in (40014, 42001):
                _token_cache.update(token=None, expires_at=0.0)
        return ok
    except Exception:
        logger.exception("企微图片推送失败")
        return False


def _download(url: str, timeout: float = 15) -> bytes | None:
    """下载截图直链字节;失败只记日志返回 None(留给调用方降级)。"""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.read()
    except Exception:
        logger.warning("截图直链下载失败 %s", url, exc_info=True)
        return None


def _shot_bytes(*, shot_key=None, task=None) -> bytes | None:
    """尽力拿现场截图字节:① ``shot_key`` 的 OSS 对象直读;② shot 没有而任务留了
    ``trace_key`` → build_replay(task) 取**最后一步**带 shot_url 的步骤下载。
    拿不到返回 None,全程只记日志不抛。"""
    if shot_key:
        try:
            blob = storage.load_blob(shot_key)
            if blob:
                return blob
        except Exception:
            logger.warning("截图读取失败 key=%s", shot_key, exc_info=True)
    trace_key = (getattr(task, "result", None) or {}).get("trace_key") if task is not None else None
    if not trace_key:
        return None
    try:
        steps = (build_replay(task) or {}).get("steps") or []
    except Exception:
        logger.warning("回放构建失败 task=%s", getattr(task, "id", "?"), exc_info=True)
        return None
    url = next((s.get("shot_url") for s in reversed(steps) if s.get("shot_url")), None)
    return _download(url) if url else None


def send_alert_with_shot(title: str, desp: str, *, shot_key=None, task=None,
                         poster=None, getter=None, uploader=None) -> bool:
    """人工告警:先发文本(同 ``_send`` 双通道),再尽力补一张现场截图。

    图字节拿到且企微在配 → 补发 image 消息;发不了图(企微未配置=走了 Server酱、
    或字节拿不到)而 ``shot_key`` 是 OSS key → 把 ``storage.signed_url`` 的 24h
    直链拼进文本末尾,让人至少有链接可点。任何一步失败只记日志,绝不影响文本通知本身。
    """
    image = _shot_bytes(shot_key=shot_key, task=task)
    final_desp = desp
    if image is None or not _wecom_configured():
        link = storage.signed_url(shot_key, expires=86400) if shot_key else None
        if link:
            final_desp = f"{desp}\n现场截图(24h): {link}" if desp else f"现场截图(24h): {link}"
    sent = _send(title, final_desp, poster=poster)
    if image is not None and _wecom_configured():
        if not notify_wecom_image(image, getter=getter, uploader=uploader):
            logger.info("截图推送未成功(文本已发),现场可看文本里的链接或后台回放")
    return sent


def _format_detail_line(i: int, d: dict) -> str:
    """一条明细 → 「N. 「账号」买家 昵称 咨询「标题」¥价格:"最新一句"」;标题/价格/文本缺省即跳段。"""
    line = f"{i}. 「{d.get('account') or '?'}」买家 {d.get('buyer') or '?'}"
    title = (d.get("title") or "").strip()
    if title:
        line += f" 咨询「{title}」"
        if d.get("price"):
            line += f"¥{d['price']}"
    text = (d.get("text") or "").strip()
    if text:
        line += f":\"{text}\""
    return line


def _format_desp(details: list[dict], pending: int) -> str:
    """有明细按会话出明细,没有回退旧的纯计数文案(向后兼容)。"""
    if not details:
        return f"自上次提醒新增 {pending} 条,请进小程序处理"
    lines = [f"新买家消息({len(details)} 个会话):"]
    for i, d in enumerate(details[:MAX_DETAIL_LINES], 1):
        lines.append(_format_detail_line(i, d))
    rest = len(details) - MAX_DETAIL_LINES
    if rest > 0:
        lines.append(f"等 {rest} 个会话")
    return "\n".join(lines)


def _load_details(db) -> list[dict]:
    try:
        raw = json.loads(_get(db, K_PENDING_DETAILS) or "[]")
    except (ValueError, TypeError):
        raw = []
    return raw if isinstance(raw, list) else []


def maybe_notify_new_messages(db, new_in_count: int, *, details: list[dict] | None = None,
                              now: datetime | None = None, poster=None) -> bool:
    """聚合+冷却判定:累计本次新增 inbound 与会话明细,过冷却窗且有积压则发一条汇总。

    details: 本轮新增 inbound 的会话明细(account/buyer/title/price/text),冷却窗内
    攒进 gc_notify_state,flush 时按会话出明细;不传则回退旧的纯计数文案。返回是否
    真正发出了推送。状态(pending/明细/上次推送时间)落 gc_notify_state,由调用方
    随业务事务一并 commit;发送失败保留 pending,下个窗口再试。
    """
    now = now or datetime.utcnow()
    pending = int(_get(db, K_PENDING) or 0) + max(int(new_in_count), 0)
    _set(db, K_PENDING, str(pending))
    stored = _load_details(db)
    if details:
        stored.extend(dict(d) for d in details)
        _set(db, K_PENDING_DETAILS, json.dumps(stored, ensure_ascii=False))
    if pending <= 0 or not settings.serverchan_sendkey:
        return False
    last = _get(db, K_LAST_NOTIFIED)
    if last:
        elapsed = (now - datetime.fromisoformat(last)).total_seconds()
        if elapsed < settings.notify_cooldown_sec:
            return False
    title = f"新买家消息 {len(stored)}个会话待处理" if stored else "新买家消息"
    if not _send(title, _format_desp(stored, pending), poster=poster):
        return False
    _set(db, K_PENDING, "0")
    _set(db, K_PENDING_DETAILS, "[]")
    _set(db, K_LAST_NOTIFIED, now.isoformat())
    return True
