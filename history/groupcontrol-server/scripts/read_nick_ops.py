"""运维兜底:老 APK 端上读昵称失败时,服务端直接驱动在线设备读闲鱼昵称并注册账号。

用法(在 gc-api 主机上,venv python):
  1) 驱动+截图:  python -m scripts.read_nick_ops [device_id ...]
     缺省对所有「在线但 reported_nick 为空」的设备执行。每台:
     WAKEUP → 拉起闲鱼(等 4s)→ dump 试读 → 点「我的」tab(desc「我的，未选中状态」,
     兜底「我的」)→ 等 2.5s 再 dump → screencap 存 shots/nick_<dev8>_<ts>.jpg。
     打印 dump 顶部区域的昵称候选(dump 只带 contentDescription,原生 text 读不到时以截图为准)。
  2) 回填注册:  python -m scripts.read_nick_ops --set-nick <device_id>=<昵称> [...]
     按 nick 唯一键 upsert 账号(语义同 mqtt_bridge._apply_identity:激活设备=本机、
     本机不再是其它账号的激活设备、device.account_id/reported_nick 一并落)。
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import sqlite3
import sys
import urllib.request
from datetime import datetime
from pathlib import Path
from uuid import uuid4

import aiomqtt

from app.config import settings

logger = logging.getLogger("read_nick_ops")

XIANYU_PKG = "com.taobao.idlefish"
DB_PATH = Path(__file__).resolve().parent.parent / "gc.db"
SHOTS_DIR = Path(__file__).resolve().parent.parent / "shots"

# 昵称候选排除词(「我的」页固定文案/数字)
_STOPWORDS = {"我的", "编辑资料", "个人主页", "粉丝", "关注", "获赞", "浏览", "收藏", "足迹",
              "昵称未填写", "设置", "客服中心", "闲鱼玩家", "会员名"}


class OpsBridge:
    """独立 client id 的运维 RPC 桥(不与生产 gc-backend 抢会话;rpc_resp 按 req_id 各认各的)。"""

    def __init__(self) -> None:
        self._pending: dict[str, asyncio.Future] = {}
        self._client: aiomqtt.Client | None = None

    async def __aenter__(self):
        self._cm = aiomqtt.Client(
            hostname=settings.mqtt_host, port=settings.mqtt_port,
            username=settings.mqtt_backend_username, password=settings.mqtt_backend_password,
            identifier=f"gc-ops-{uuid4().hex[:8]}",
        )
        self._client = await self._cm.__aenter__()
        await self._client.subscribe("gc/+/rpc_resp", qos=1)
        self._listener = asyncio.create_task(self._listen())
        return self

    async def __aexit__(self, *exc):
        self._listener.cancel()
        await self._cm.__aexit__(*exc)

    async def _listen(self):
        async for msg in self._client.messages:
            try:
                data = json.loads(msg.payload)
                fut = self._pending.get(data.get("req_id"))
                if fut and not fut.done():
                    fut.set_result(data)
            except Exception:
                continue

    async def rpc(self, device_id: str, op: str, args: dict | None = None, timeout: float = 15.0) -> dict:
        req_id = uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        try:
            await self._client.publish(f"gc/{device_id}/rpc",
                                       json.dumps({"req_id": req_id, "op": op, "args": args or {}}), qos=1)
            resp = await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(req_id, None)
        if not resp.get("ok"):
            raise RuntimeError(f"{op} 失败: {resp.get('err')}")
        return resp.get("data") or {}


def _nick_candidates(nodes: list[dict], screen_h: int) -> list[str]:
    """dump 顶部区域的「像昵称」文本(dump 只有 contentDescription;原生 text 读不到,以截图为准)。"""
    out = []
    for n in nodes:
        t = (n.get("desc") or "").strip()
        if not t or len(t) > 20 or n.get("cy", 0) > screen_h * 0.35:
            continue
        if t in _STOPWORDS or t.isdigit():
            continue
        out.append(t)
    return out


async def drive_one(br: OpsBridge, device_id: str) -> None:
    short = device_id[:8]
    logger.info("[%s] WAKEUP + 拉起闲鱼", short)
    await br.rpc(device_id, "key", {"code": "WAKEUP"})
    await br.rpc(device_id, "launch_app", {"pkg": XIANYU_PKG})
    await asyncio.sleep(4)
    size = await br.rpc(device_id, "screen_size")
    screen_h = int(size.get("h") or 2400)

    nodes = (await br.rpc(device_id, "dump_nodes"))["nodes"]
    cands = _nick_candidates(nodes, screen_h)
    if not cands:
        for desc in ("我的，未选中状态", "我的"):
            try:
                await br.rpc(device_id, "node_click", {"desc": desc})
                logger.info("[%s] 已点「我的」tab (desc=%r)", short, desc)
                break
            except RuntimeError:
                continue
        await asyncio.sleep(2.5)
        nodes = (await br.rpc(device_id, "dump_nodes"))["nodes"]
        cands = _nick_candidates(nodes, screen_h)

    shot = await br.rpc(device_id, "screencap", {"quality": 70})
    SHOTS_DIR.mkdir(exist_ok=True)
    path = SHOTS_DIR / f"nick_{short}_{datetime.utcnow():%Y%m%d_%H%M%S}.jpg"
    path.write_bytes(base64.b64decode(shot["image_b64"]))
    logger.info("[%s] 昵称候选=%r 截图=%s", short, cands, path)
    print(json.dumps({"device_id": device_id, "candidates": cands, "shot": str(path)},
                     ensure_ascii=False))


def _online_without_nick() -> list[str]:
    con = sqlite3.connect(DB_PATH)
    try:
        rows = con.execute(
            "SELECT id FROM gc_device WHERE status='ONLINE' AND (reported_nick IS NULL OR reported_nick='')"
        ).fetchall()
        return [r[0] for r in rows]
    finally:
        con.close()


def set_nick(device_id: str, nick: str) -> None:
    """注册/认领账号(nick 唯一键)+ 激活设备=本机 + device.account_id/reported_nick 落库。"""
    # 账号走 HTTP bind(ORM 管默认值),与 mqtt_bridge 的 upsert 语义一致
    req = urllib.request.Request(
        "http://127.0.0.1:8100/api/gc/accounts/bind",
        data=json.dumps({"nick": nick, "device_id": device_id}).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    acc = json.loads(urllib.request.urlopen(req, timeout=10).read())
    con = sqlite3.connect(DB_PATH, timeout=10)
    try:
        # 一机一号:本机不再充当其它账号的激活设备
        con.execute("UPDATE gc_account SET device_id=NULL WHERE device_id=? AND id<>?",
                    (device_id, acc["id"]))
        con.execute("UPDATE gc_device SET account_id=?, reported_nick=? WHERE id=?",
                    (acc["id"], nick, device_id))
        con.commit()
    finally:
        con.close()
    logger.info("已注册:%s → account=%s device=%s", nick, acc["id"][:8], device_id[:8])
    print(json.dumps({"ok": True, "nick": nick, "account_id": acc["id"], "device_id": device_id},
                     ensure_ascii=False))


async def _drive(device_ids: list[str]) -> None:
    async with OpsBridge() as br:
        for did in device_ids:
            try:
                await drive_one(br, did)
            except Exception as e:
                logger.error("[%s] 驱动失败: %s", did[:8], e)
                print(json.dumps({"device_id": did, "error": str(e)}, ensure_ascii=False))
            await asyncio.sleep(2)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = sys.argv[1:]
    if args and args[0] == "--set-nick":
        for pair in args[1:]:
            did, _, nick = pair.partition("=")
            if not did or not nick:
                raise SystemExit(f"--set-nick 格式: <device_id>=<昵称>,收到 {pair!r}")
            set_nick(did, nick)
        return
    device_ids = args or _online_without_nick()
    if not device_ids:
        logger.info("没有「在线但昵称为空」的设备")
        return
    asyncio.run(_drive(device_ids))


if __name__ == "__main__":
    main()
