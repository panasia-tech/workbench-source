"""闲鱼网页版选择器与 URL 常量（2026-09-09 实测）。

所有选择器集中此处，页面改版只改这一个文件。
来源：2026-09-09 用 Playwright CDP 接管 AdsPower 环境（user_id=k1esvnuc），
在已登录态（昵称「东魏诚恳的椰子蟹」）下对 goofish.com 首页 /im 消息页实测 DOM。
闲鱼前端是 css-modules 打包，class 名带 ``--`` 哈希后缀，一律用 ``[class*="前缀--"]``
属性包含选择器，避免全量 class 名硬编码。
"""
from __future__ import annotations

# ---- URL ----
HOME_URL = "https://www.goofish.com"
CHAT_URL = "https://www.goofish.com/im"
PERSONAL_URL = "https://www.goofish.com/personal"   # 个人中心（宝贝管理：在售/已售出 tab）
PUBLISH_URL = "https://www.goofish.com/publish"     # 发布页

# ---- 登录态锚点 ----
# 实测：登录后 header 右上角显示昵称，元素 class 形如 nick--xxx--hash。
# 元素文本 = 当前登录昵称（如「东魏诚恳的椰子蟹」）；未登录时该元素不存在。
NICK_ANCHOR = '[class*="nick--"]'

# ---- IM 消息页（/im）----
# 实测：会话列表在左侧，虚拟滚动（rc-virtual-list）。
CONV_LIST_CONTAINER = "#conv-list-scrollable .rc-virtual-list-holder"  # 会话列表滚动容器
CONV_ITEM = '[class*="conversation-item--"]'   # 单个会话项（含昵称/摘要/时间）
UNREAD_BADGE = "sup.ant-badge-count"           # 未读角标；title 属性值 = 未读条数
CHAT_TOPBAR = '[class*="message-topbar--"]'    # 聊天窗口顶栏（对方昵称在此）
MESSAGE_LIST = '[class*="message-list-reverse--"]'  # 消息列表容器（倒序渲染）
MESSAGE_ROW = 'li.ant-list-item, [class*="message-row--"]'  # 单条消息行
CHAT_INPUT = "textarea"                        # 聊天输入框
