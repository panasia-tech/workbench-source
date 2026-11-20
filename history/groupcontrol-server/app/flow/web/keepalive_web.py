"""保活 + 登录体检(网页版):号闲着时隔一阵打开一次闲鱼首页,看页头还有没有昵称。

照着 B4.1 做(它每个号约 10 分钟在后台开一次闲鱼首页、每小时查一遍登录态):
- 登着 → 什么都不做,这一趟就是让会话「有人在用」;
- 页头没昵称 → 先试「保持登录状态」「快速进入」(web/login.py),点回来了照样算成功;
- 还是没有 → login=True,runner 冻号、发「去哪个窗口重新登录」;人登回来后执行端报出昵称,
  mqtt_bridge 自动解冻。
所以夜里会话过期,早上不会等到第一单上架才发现——这里先发现、先自救,救不了先叫人。

什么时候建单、隔多久,见 scheduler._keepalive_pass。只读+点登录按钮,不碰任何业务页面。
"""
from __future__ import annotations

import logging
import time

from app.flow.engine import LoginRequired, RiskHit
from app.flow.transport import FlowTimeout
from app.flow.web.goods_flows_web import _flat, _local_shot_sink, _mk_save_shot
from app.flow.web.login import recover_login
from app.flow.web.parse import find_login_nick
from app.flow.web.publish_flow_web import _check_risk

logger = logging.getLogger("gc.keepalive_web")

HOME_URL = "https://www.goofish.com/"


def run_keepalive_web(transport, spec: dict, shot_sink=None) -> dict:
    t = transport
    save_shot = _mk_save_shot(t, shot_sink or _local_shot_sink)
    result = {"ok": True, "done": ["keepalive"], "failed_step": None,
              "reason": None, "shot": None, "risk": None}
    try:
        t.launch_app(HOME_URL)
        time.sleep(4)
        _, h = t.screen_size()
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes, t)
        if not find_login_nick(nodes, h):
            again = recover_login(t, HOME_URL, _flat, lambda ns: _check_risk(ns, t))
            if again is None or not find_login_nick(again, h):
                raise LoginRequired("网页版未登录(首页无账号昵称)", save_shot("login_keepalive"))
            logger.info("保活:会话过期,已自救登回")
            result["recovered"] = True
    except RiskHit as ex:
        result = {"ok": False, "done": [], "failed_step": "keepalive",
                  "reason": str(ex), "shot": ex.shot, "risk": ex.anchor}
    except LoginRequired as ex:
        result = {"ok": False, "done": [], "failed_step": "keepalive",
                  "reason": ex.reason, "shot": ex.shot, "risk": None, "login": True}
    except FlowTimeout as ex:
        result = {"ok": False, "done": [], "failed_step": "keepalive",
                  "reason": str(ex), "shot": None, "risk": None}
    except Exception as ex:
        logger.warning("keepalive_web 未预期异常: %s", ex)
        result = {"ok": False, "done": [], "failed_step": "keepalive",
                  "reason": str(ex), "shot": None, "risk": None}
    return result
