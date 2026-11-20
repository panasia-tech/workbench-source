"""网页版 /im 收尾:回到不选中任何会话的 /im。

流程点进某个会话后,业务标签页就一直停在那个会话里(/im 上 BACK 不起作用)。会话开着,
买家接着发来的消息会被页面当场标成已读:未读角标不涨,门铃(im_watch)不响,chat_scan
又只点有未读的会话——这些消息就一直进不了库。所以进过会话的流程收尾都重开一遍 /im
(打开 /im 不会自动选中会话,2026-09-13 实测)。
"""
import logging

IM_URL = "https://www.goofish.com/im"

logger = logging.getLogger("gc.im_nav")


def leave_conversation(t) -> None:
    try:
        t.launch_app(IM_URL)
    except Exception as ex:  # 收尾动作,失败不影响本单结果
        logger.info("回到 /im 失败(不影响结果):%s", ex)
