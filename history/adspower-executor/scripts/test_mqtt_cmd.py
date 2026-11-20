"""MQTT cmd 分发(update_code / restart / 未知指令)回归（纯离线，不起 MQTT 连接）。

钉死四条语义：
  1. task_type="update_code" 且接了 on_update_code → 回调被调度执行；
  2. 没接 on_update_code（老接线/老版本）→ 指令静默忽略，不炸；
  3. restart 指令只触发 on_restart，update_code 只触发 on_update_code，互不串；
  4. 未知 task_type / 非 cmd topic → 一律忽略；回调抛异常只记日志不上抛。

跑法：.venv/bin/python scripts/test_mqtt_cmd.py
"""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gc_ads import mqtt_client as mc  # noqa: E402
from gc_ads.config import Config  # noqa: E402


class _Msg:
    def __init__(self, topic: str, payload: dict):
        self.topic = topic
        self.payload = json.dumps(payload).encode("utf-8")


def _client(on_restart=None, on_update_code=None):
    return mc.GcMqttClient(Config(), "dev1", "tok", executor=None,
                           on_restart=on_restart, on_update_code=on_update_code)


def _run_captured(coro, _loop=None):
    """同步跑完 run_coroutine_threadsafe 要调度的协程，返回一个 result() 桩。"""
    asyncio.run(coro)

    class _F:
        def result(self, timeout=None):
            return None
    return _F()


def _dispatch(client, payload, topic="gc/dev1/cmd"):
    """把 _on_message 里的 run_coroutine_threadsafe 换成同步执行，断言回调副作用。"""
    real = mc.asyncio.run_coroutine_threadsafe
    mc.asyncio.run_coroutine_threadsafe = _run_captured
    try:
        client._on_message(None, None, _Msg(topic, payload))
    finally:
        mc.asyncio.run_coroutine_threadsafe = real


def test_update_code_triggers_callback():
    hits = []
    client = _client(on_update_code=lambda: hits.append("update") or asyncio.sleep(0))
    client._loop = object()          # 只要求非空(真值),调度已被替换成同步
    _dispatch(client, {"task_id": "t1", "task_type": "update_code", "payload": {}})
    assert hits == ["update"]


def test_update_code_without_callback_is_ignored():
    client = _client()               # 老接线：没传 on_update_code
    client._loop = object()
    _dispatch(client, {"task_id": "t1", "task_type": "update_code", "payload": {}})
    # 没回调时不该调度任何东西；走到这里没炸就是过


def test_restart_unaffected_and_not_cross_fired():
    hits = []
    client = _client(
        on_restart=lambda: hits.append("restart") or asyncio.sleep(0),
        on_update_code=lambda: hits.append("update") or asyncio.sleep(0),
    )
    client._loop = object()
    _dispatch(client, {"task_id": "t2", "task_type": "restart", "payload": {}})
    assert hits == ["restart"], "restart 不得触发 update_code 回调"
    _dispatch(client, {"task_id": "t3", "task_type": "update_code", "payload": {}})
    assert hits == ["restart", "update"]


def test_unknown_type_and_other_topic_ignored():
    hits = []
    rpc_hits = []

    class _FakeExecutor:
        async def execute(self, req_id, op, args):
            rpc_hits.append((req_id, op))
            return {"req_id": req_id, "ok": True, "data": {}, "err": None, "ts": 0}

    client = _client(
        on_restart=lambda: hits.append("restart") or asyncio.sleep(0),
        on_update_code=lambda: hits.append("update") or asyncio.sleep(0),
    )
    client.executor = _FakeExecutor()
    client._loop = object()
    _dispatch(client, {"task_id": "t4", "task_type": "frobnicate", "payload": {}})
    assert hits == [] and rpc_hits == [], "未知 task_type 谁都不许触发"
    # rpc topic 走 _handle_rpc(原语通道),不碰 cmd 回调——给假 executor 接住
    _dispatch(client, {"req_id": "r1", "op": "dump_nodes", "args": {}}, topic="gc/dev1/rpc")
    assert rpc_hits == [("r1", "dump_nodes")] and hits == []
    # payload 里带 task_type 的兼容形态:顶层 task_type=update_code 优先,不得被带偏
    _dispatch(client, {"task_id": "t6", "task_type": "update_code",
                       "payload": {"task_type": "restart"}})
    assert hits == ["update"], hits


def test_safe_update_code_swallows_exception():
    async def boom():
        raise RuntimeError("download blew up")

    client = _client(on_update_code=boom)
    asyncio.run(client._safe_update_code())      # 不抛即过;日志经 self.log 发出


def main():
    test_update_code_triggers_callback()
    test_update_code_without_callback_is_ignored()
    test_restart_unaffected_and_not_cross_fired()
    test_unknown_type_and_other_topic_ignored()
    test_safe_update_code_swallows_exception()
    print("test_mqtt_cmd: PASS")


if __name__ == "__main__":
    main()
