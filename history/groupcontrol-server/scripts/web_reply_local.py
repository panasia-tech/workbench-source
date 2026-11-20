"""网页版 chat_reply 本地联调:LocalPlaywrightTransport 直连 AdsPower 浏览器跑 run_reply_chat_web。

用法(用 adspower-executor 的 venv,里面有 playwright):
  ./demo scripts/web_reply_local.py [peer_key] [text]

**只跑 dry_run=true**:文本填入输入框并回读校验,绝不点发送(不骚扰真实买家)。
真实发送(dry_run=false)不在本脚本触发;生产由 groupcontrol-server 任务系统调用。
"""
import json
import logging
import sys
import time

sys.path.insert(0, ".")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
from app.flow.web.local_transport import LocalPlaywrightTransport  # noqa: E402
from app.flow.web.reply_chat_web import run_reply_chat_web  # noqa: E402


def main():
    peer_key = sys.argv[1] if len(sys.argv) > 1 else "811892395"
    text = sys.argv[2] if len(sys.argv) > 2 else "测试输入请勿介意"
    spec = {"conversation_id": "", "peer_key": peer_key, "text": text, "dry_run": True}
    t = LocalPlaywrightTransport()
    try:
        started = time.time()
        result = run_reply_chat_web(t, spec)
    finally:
        t.close()
    result["elapsed_sec"] = round(time.time() - started, 1)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
