#!/usr/bin/env python3
"""
Generate 7 dedicated single-node External CS Wiki Markdown files (zero backticks in headings),
create 7 dedicated DingTalk Wiki subpages inside folder 9E05BDRVQ2mlZOPbiZ2zb3LvJ63zgkYA,
and surgically update ONLY the External CS rows in index GZLxjv9VGqMl2mDpIqYNLrrO86EDybno.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

BASE = Path("/Users/user/Documents/ChatGPT/行政管理/outputs/外部客服V3-独立节点教程与源码-20261124")
WORKSPACE = "gBVzxOgnqwlNMGOa"
CS_FOLDER = "9E05BDRVQ2mlZOPbiZ2zb3LvJ63zgkYA"
INDEX_DOC = "GZLxjv9VGqMl2mDpIqYNLrrO86EDybno"

NODES = [
    {
        "node_id": "CS-ONBOARD-01",
        "doc_name": "CS-ONBOARD-01｜外部新人客服3关情景通关与三栏极简上岗",
        "role": "外部新人客服（cs_newbie）/ 外部外包客服（outsource_lu）",
        "entry": "?as=cs_newbie 或 #/cs-workbench",
        "skill": "cs-first-day-3step-gate",
        "duration_label": "01:25",
        "case": "首日新人账号「周小萌（cs_newbie）」初始处于「3关待解锁(0/3)」保护锁状态，输入框与主发图按钮锁定，避免新人首日误发违禁词或盲答有货。",
        "purpose": "帮助零基础外部客服在 3 分钟内完成 60 秒情景防踩坑通关，掌握「左三类标签（售前/售后/问题订单）— 中间对话 — 右栏高亮主按钮」极简桌面动线及手边「？」十要素卡片用法。",
        "steps": [
            "登录电脑端外部客服工作台（1440px 宽屏基准），观察顶栏「3关待解锁(0/3)」状态与底部黄色保护锁横幅。",
            "点击底部锁定横幅右侧蓝色按钮「立即去做 3 关练习解锁」，打开沙盒情景演练弹窗（与真实买家订单物理隔离）。",
            "依次完成「缺仓管通电实拍视频」「买家砍价超权限」「买家诱导加微信站外引流」3 道高频红线选择题，达成 3/3 解锁。",
            "解锁后按左栏「售前 / 售后 / 问题订单」红标倒计时顺序点开会话，右栏看当前进度卡片亮什么主按钮就点什么。",
            "遇到术语或边界拿不准时，随时点击顶栏或卡片右侧蓝色「？」，展开十要素锦囊并直接播放本节点 00:00 独立教程视频。",
        ],
        "codex_prompt": "请核查周小萌（cs_newbie）3 关练习门禁状态，确认外包视角仅展示脱敏 CS 节点且非授权内部接口返回 403。",
        "expected": "3 关通关后保护锁自动解除；外包视角物理隔离内部采购进价与选品节点；首日零误触平台红线。",
        "stop_rules": "1. 3 关模拟题连续答错卡关时，先停手阅读本页与手边「？」十要素说明；2. 若界面异常显示内部拿货价或选品底表，立即停手截图上报管理员校验权限；3. 严禁使用个人微信、QQ 或私人账号绕开工作台代发任何消息。",
        "takeover": "业务疑问一键呼叫「内部兜底销售（陈小满）」接管；账号或权限异常反馈销售主管核查。",
    },
    {
        "node_id": "CS-REALSHOT-01",
        "doc_name": "CS-REALSHOT-01｜三栏极简接待、WMS四关全绿选机与一件一拍直发",
        "role": "外部外包客服（主力接待）/ 内部兜底销售",
        "entry": "#/cs-workbench（售前标签）",
        "skill": "cs-pre-ship-realshot-select",
        "duration_label": "01:11",
        "case": "拼多多买家「林先生8821」（订单 PDD-261116-9920 · ¥1390 · 戴森 HD08 吹风机）已付款要求挑成色好的机器并核对序列号；同款在库 3 台，其中 2 台绿灯可挑、1 台缺通电视频被系统锁死禁选。",
        "purpose": "确保每一笔已付款实物订单 100% 锁定「WMS 四关全检通过 + 高清实拍图 + 通电试机视频」全齐备的唯一真机货号，杜绝网图应付、错发漏检与货不对板纠纷。",
        "steps": [
            "在左栏「售前」队列点击带倒计时的红标会话（如「林先生8821 · 待挑货发实拍+保修卡」）。",
            "在右栏「仓库实拍（一件一拍）」分槽区选择带绿点的可售槽位（如「95新 ¥1390」，货号 513211549229-A），严禁强选带锁图标的灰色阻塞槽位。",
            "核对右栏实拍缩略图（含主机配件全景与 1mm 轻微收纳印微距图）及「播放仓管通电实拍视频（1080p）」。",
            "点击任意实拍缩略图打开高清大图灯箱，核验左下角白底条码货号与原厂序列号（B6P-CN-RJA8821A）清晰无误。",
            "点击右栏上方蓝色主按钮「发实拍图/视频 + 自动发保修激活卡」，一键将本机实拍与保修确认卡发入聊天窗。",
        ],
        "codex_prompt": "请帮我核对这笔待发货订单在右栏同款槽位里哪台四关全绿可用，并生成发货前实拍发送检查表。",
        "expected": "订单唯一绑定四关全绿货号，买家聊天窗收到对应真机实拍图、微距瑕疵说明与通电视频，且自动跟发保修激活卡进入第 2 阶段。",
        "stop_rules": "1. 商品链接标红「未绑 WMS 货号」时立即停手，严禁口头盲答有货；2. 同款绿灯槽位售罄、仅剩缺通电视频槽位超过 60 秒时立即停手；3. 严禁去百度/同行店铺找网图或绕开系统私发图片。",
        "takeover": "缺通电视频点右栏「一键催仓管 60 秒补拍」；未绑货号点「一键呼叫内部销售 60 秒绑定 WMS 货号」，绿灯就绪后再发送。",
    },
    {
        "node_id": "CS-WARRANTY-02",
        "doc_name": "CS-WARRANTY-02｜富阳法院保修激活卡自动触发与静默发问毫秒熔断",
        "role": "外部外包客服 / 内部兜底销售",
        "entry": "#/cs-workbench（售前标签 · 自动发图与自动发货池）",
        "skill": "cs-warranty-silent-ship-fuse",
        "duration_label": "01:40",
        "case": "京东咚咚买家「陈工」（JD-261116-5519 · ¥3450 · 群晖 DS923+ 四盘位 NAS，货号 513211770201）已收到实拍与《店铺质保服务激活确认卡》（含杭州市富阳区人民法院管辖约定），回复「同意」后秒激活并推入顺丰波次 WAVE-261118-09。",
        "purpose": "通过场景化自动发图完成发货前质保及管辖权约定留痕；买家回复「同意」或静默期满无异议自动推仓出库，买家一旦发问则毫秒级熔断停发，兼顾效率与零带病发货。",
        "steps": [
            "发完本机实拍后，确认聊天窗已自动紧跟发出《店铺质保服务激活确认卡》（黄框明示：争议提交杭州市富阳区人民法院诉讼管辖）。",
            "若需手动重发，可点击输入框右上方「手动发场景图」选择保修激活卡，或在顶栏「自动发图(3)」抽屉查看及微调随图话术。",
            "用快捷短语温和引导买家核对实拍无异议后直接回复「同意」二字。",
            "买家回复「同意」（或 30 分钟静默观察窗内零追问），顶部自动亮绿标「保修已激活（富阳法院管辖生效）」并推入顺丰波次。",
            "打开顶栏「自动发货池」查看四列泳道；若买家中途发问触发「疑问熔断·待人工介入」，必须先人工解答消除疑虑，再点击绿色「恢复推仓」。",
        ],
        "codex_prompt": "请核对陈工订单保修激活卡触发记录、杭州市富阳区人民法院管辖条款回执，及静默观察窗内所有疑问熔断日志。",
        "expected": "100% 发货订单留存富阳法院管辖保修卡记录；同意或静默期满自动生成 WAVE 波次号；存疑会话 100% 毫秒级截停。",
        "stop_rules": "1. 买家对成色、划痕或配件仍有未解疑问时，严禁强点「恢复推仓」；2. 买家明确拒绝保修卡或要求删改法院管辖条款时立即停手；3. 买家改口不想要时转入售后退款/409 截单流程。",
        "takeover": "管辖条款异议或特殊质保承诺诉求，一律转交内部销售陈小满或主管核定，外包不得私改法务口径。",
    },
    {
        "node_id": "CS-REFUND-409-03",
        "doc_name": "CS-REFUND-409-03｜退款0秒手机UI三步引导图与WMS 409红屏急停截单",
        "role": "外部外包客服 / 仓管协同 / 内部销售",
        "entry": "#/cs-workbench（售后标签）",
        "skill": "cs-refund-409-hard-stop",
        "duration_label": "01:33",
        "case": "售后双案例：① 淘宝「王女士」（TB-261116-6612 · ¥1020）未入波次申请退款错选质量原因，系统 0 秒自动发手机 UI 三步引导图改「不想要了/协商一致」秒退；② 抖店「张同学」（DY-261116-3318 · ¥1380）已入波次 WAVE-261116-04 拣货中，触发 409 红屏急停截单。",
        "purpose": "第一时间自动引导未发货买家改选无责原因实现 0 秒极速退款免排队，同时对已进入仓库波次拣货的订单实施 409 强冲突锁单拦截，严防货款两空与违规关闭订单扣分。",
        "steps": [
            "切至左栏「售后」标签，先看会话抬头状态是否带有「已进波次拣货」标识。",
            "对未进波次订单（如王女士）：确认聊天窗已在 0 秒自动发出《手机 UI 三步选“不想要了/协商一致”引导图》，配合快捷话术引导买家点修改申请秒退到账。",
            "对已进波次拣货订单（如张同学）：右栏弹出红框警告「该单已在仓管拣货中（WAVE-261116-04）」，切勿口头直接答应秒退。",
            "立即点击右栏红色主按钮「立即下发 409 红屏急停拦截仓库面单」（也可在顶栏自动发货池第 4 列点 409 拦截）。",
            "待仓库回传包裹已截留归位确认后，再引导买家按三步图提交「不想要了 / 协商一致」完成退款；全程严禁主动点「卖家关闭订单」（防闲鱼鱼力值 165 扣罚红线）。",
        ],
        "codex_prompt": "请核查今日全部退款申请的 0 秒引导图触发记录，以及 WAVE-* 拣货中触发 WMS 409 急停的仓库截单闭环结果。",
        "expected": "未拣货单买家改选「不想要了/协商一致」后系统自动秒退；拣货中订单 100% 下发 409 急停并获仓库截留回执，零错发漏拦、零违规关单。",
        "stop_rules": "1. 快递已打包扫揽收出库（超过仓库截单点）立即停手，严禁点同意仅退款；2. 仓库超过 5 分钟未回传 409 截留结果时停手催办；3. 买家坚持选质量问题索赔运费或赔偿金时立即停手。",
        "takeover": "已揽收件转仓管与内部销售发起快递拦截并提醒买家拒签；质量索赔纠纷一键转内部销售陈小满判责处理。",
    },
    {
        "node_id": "CS-ESCALATE-05",
        "doc_name": "CS-ESCALATE-05｜问题订单三类判别与60秒一键跨部门呼救",
        "role": "外部外包客服 / 仓管 / 内部兜底销售",
        "entry": "#/cs-workbench（问题订单标签）",
        "skill": "cs-abnormal-60s-escalate",
        "duration_label": "01:28",
        "case": "问题订单三类实况：C6「阿杰_数码控」（买家发问触发毫秒熔断停发）、C7「设备迷老周」（华硕 ROG 缺仓管通电视频）、C8「设计小李」（商品链接未绑 WMS 货号 + 附带外部百度网盘风险链接）。",
        "purpose": "把所有卡壳、缺件、认不出货号或带风险外链的异常单集中收口在「问题订单」队列，通过 60 秒一键跨部门呼救直达仓管高拍仪或内部销售首页红灯队列，杜绝外包瞎猜与误点木马外链。",
        "steps": [
            "点击左栏「问题订单」红色计数标签，按倒计时紧迫度逐单点开排查。",
            "遇到 C7「缺通电视频阻塞」（设备迷老周）：严禁口头保证屏幕无坏点，直接点击右栏黄色主按钮「一键催仓管 60 秒补拍通电视频」，待视频回传解锁后再发实拍。",
            "遇到 C8「链接未绑 WMS 货号」（设计小李）：观察聊天窗红框「外部风险链接（外包端已安全阻断请勿点击）」，严禁复制打开外部网盘，点击右栏「一键呼叫内部销售 60s 绑定 WMS 货号」。",
            "如遇砍价超 ¥20 或签收后报修，也可展开右下角「跨部门协同 · 409急停 · 内部接管」折叠面板，按四宫格呼救按钮一键精准派单。",
        ],
        "codex_prompt": "请统计今日全部问题订单（C6 熔断 / C7 缺视频 / C8 未绑货号）的 60 秒呼救平均响应时长，并标出超时未接管单据。",
        "expected": "缺视频单 60 秒推达仓管补拍；未绑货号单 60 秒推达内部销售绑货；风险网盘链接 100% 阻断零点击。",
        "stop_rules": "1. 右栏已有明确成色、微距、标价答案的常规咨询，严禁懒惰滥点呼救甩锅；2. 仓管未回传视频或销售未绑完货号前，严禁口头承诺“有货马上发”；3. 严禁点开任何网盘、短链或第三方文件。",
        "takeover": "实物补拍由仓管工位 60 秒承接；绑货号、外链核验与超限议价由内部销售陈小满排他接管。",
    },
    {
        "node_id": "CS-TAKEOVER-06",
        "doc_name": "CS-TAKEOVER-06｜排他接管锁、超限让利与退回防甩锅交接",
        "role": "内部兜底销售（陈小满）/ 外部外包客服 / 销售主管",
        "entry": "?as=chenxm#/cs-workbench（销售工作台左栏：工作 → 外部客服）",
        "skill": "cs-internal-takeover-handoff",
        "duration_label": "01:41",
        "case": "外部客服 V3 单应用合入销售工作台后，内部销售「陈小满」无需切换独立后台，直接在左侧「工作 → 外部客服」接管超 ¥20 砍价单与疑难单；对「王阿强」把常规成色问题乱甩锅的行为执行「退回外包并记无效转接（×4）」。",
        "purpose": "规范外包与内部销售在统一工作台内的权责交接：用排他接管锁防止两人同时回复买家撞话，用超限代发券守住价格底线，用无效甩锅退回机制堵住推诿。",
        "steps": [
            "内部销售在《销售工作台》左栏「工作」分组点击「外部客服」，顶栏确认当前身份为「陈小满 · 在岗」。",
            "点开外包呼叫升级的会话，展开右栏底部「跨部门协同 · 409急停 · 内部接管」面板。",
            "点击「接管会话」开启排他接管锁（lock）：此时外包客服端自动变为只读旁观模式，确保同一时刻只有一人对客发声。",
            "在授权范围内执行「绑定 WMS 货号」或「代发 >¥20 超限折扣券」；解决完毕后点击「退回外包继续跟进」，将后续发实拍与盯物流交还原坐席。",
            "若核查发现右栏本有现成答案、属外包偷懒乱转接，点击「退回外包并记无效转接」，系统自动写入全维考核反作弊雷达留痕。",
        ],
        "codex_prompt": "请审查全部内部销售接管单的排他锁状态记录、>¥20 超限让利审批原因，以及被陈小满退回的无效甩锅详情。",
        "expected": "接管期间 100% 单人排他锁定零撞话；超限让利笔笔留痕不破底价；完结后平滑交回外包闭环，无效甩锅准确归因。",
        "stop_rules": "1. 排他锁生效期间外包严禁从千牛/飞鸽/闲鱼原生客户端绕开抢答；2. 买家砍价击穿销售工作台最低保护底价时，内部销售同样须停手升级销售主管审批；3. 严禁微信群口头交接而不在系统上锁。",
        "takeover": "突破商品底价红线或重大客诉赔付，由内部销售升级销售主管（何雨诚/邹主管）拍板核准。",
    },
    {
        "node_id": "CS-GUARD-KPI-04",
        "doc_name": "CS-GUARD-KPI-04｜外发合规守卫、防作弊与五防绩效考核口径",
        "role": "外部外包客服 / 客服与销售主管 / 财务结算",
        "entry": "#/cs-workbench（底部外发守卫 + 顶栏「全维考核」）",
        "skill": "cs-outbound-guard-and-kpi",
        "duration_label": "01:38",
        "case": "林小鹿在聊天框误输「加我微信13800138000私下发图」被外发守卫实时红框锁死发送键；顶栏全维考核大盘公示林小鹿首响 21s、3分人工率 98.4%、实拍 100%，并揪出「王阿强·机器人兜底挂机漏回 ×9」与「刷单字尾响拦截 ×2」。",
        "purpose": "在敲字发送前 100% 物理拦截微信号、手机号与单字刷尾响行为，保护 24 家店铺账号不被平台封禁，并用剔除 50s 机器人水分的真实人工指标公平核算外包日奖。",
        "steps": [
            "在聊天输入框打字时，若误含 11 位手机号、微信号、站外链接或纯单字「1」刷尾响，输入框上方立即弹出红色「外发守卫实时拦截」提示且发送按钮置灰锁死。",
            "遇到买家索要微信看图，删掉违规词，点击输入框上方「防站外引流标准婉拒」快捷短语芯片，在平台站内直接发高清实拍与视频。",
            "点击顶栏「全维考核」展开五防绩效与反作弊大盘，核对本人 5 大核心卡：今日接待 UV、首响中位数（目标 ≤30s）、3分钟人工回复率（目标 ≥96%，剔除 50s 机器人兜底未补回）、发货前实拍执行率（100%）、尾响满意度与预估日奖。",
            "查看下方「反作弊预警雷达」与「五大平台 24 店接待矩阵」，确认无挂机漏回、无效甩锅或刷尾响记录；月底/日结可点击右上角「导出 CSV 结算单」留档。",
        ],
        "codex_prompt": "请导出今日全坐席外发守卫拦截明细、50s 兜底挂机剔除原因，生成可供财务与主管复核的 14 项指标 CSV 核对单。",
        "expected": "站外微信号/手机号与单字刷尾响 100% 拦截 0 放行；3 分钟人工真回率真实剔除机器人挂机水分；CSV 结算单可追溯。",
        "stop_rules": "1. 严禁使用谐音字、拆字、图片暗码变相留微信号/手机号（一经审计直接清退）；2. 对绩效剔除单有异议时停手保留单号与审计流水，禁止私改统计口径；3. 守卫异常离线时暂停群发并报修。",
        "takeover": "绩效异议与申诉导出 CSV 连同会话单号交客服/销售主管复核签字，财务凭核准台账结算。",
    },
]


def assert_no_backticks_in_headings(md: str, label: str) -> None:
    for line in md.splitlines():
        if re.match(r"^#{1,6}\s+", line) and "`" in line:
            raise ValueError(f"Heading contains backtick in {label}: {line}")


def build_node_markdown(n: dict, video_url: str, source_url: str) -> str:
    steps_md = "\n".join(f"{i}. {s}" for i, s in enumerate(n["steps"], 1))
    md = f"""> **当前复核状态**：`待人工复核`（本独立节点视频、源码与专属说明页已由 Agent 按 `2026-11-24` 规范生成并字节级回读校验，尚未经过业务发起人或对应主管本人最终复核，请勿视同已人工签收）

## 一、节点定位与本节独立媒体入口

- **节点 ID**：`{n["node_id"]}`
- **归属工作台**：销售工作台（合入外部客服工作台 V3 · 纯电脑桌面宽屏端 `>=1200px` / `1440px` 基准）
- **适用岗位**：{n["role"]}
- **工作台直达位置**：`{n["entry"]}`（界面对应步骤旁「？」直接打开本专属页，不跳转总目录）
- **教程固定版本**：`V6.1-CS-20261124`（配音：千问官方预设音色 `Serena`，`1920x1080` 独立成片，无宠物元素）
- **本节点独立教程视频（从 00:00 起播 · {n["duration_label"]}）**：[点击观看 {n["node_id"]} 独立 MP4 视频]({video_url})
- **本节点渲染前可编辑源码包（含脚本/时间轴/分镜/素材）**：[点击下载 {n["node_id"]} 可编辑源码归档 (.tar.gz)]({source_url})

## 二、业务目的与真实脱敏案例

- **核心业务目的**：{n["purpose"]}
- **本节串联真实案例**：{n["case"]}

## 三、电脑端一步一步实操指引

{steps_md}

## 四、日常 Skill 与 Codex 协作方式

- **已核对绑定 Skill**：`{n["skill"]}`
- **直接向 Codex 交代的标准指令**：{n["codex_prompt"]}
- **预期完成结果与页面核验信号**：{n["expected"]}

## 五、失败边界、停手条件与人工接管核验

- **遇到以下情况立即停手（严禁硬猜或越权承诺）**：{n["stop_rules"]}
- **人工兜底接管角色与动作**：{n["takeover"]}

## 六、台账修订与人工复核记录

- **版本号**：`V6.1-CS-20261124`（更新日期 `2026-11-24` · 成片时间码 `00:00` 独立起播）
- **配音音色**：千问官方预设音色 `Serena`
- **复核状态**：`待人工复核`（已上传钉盘并完成 SHA-256 字节回读比对；支持按时间码局部改稿重渲染）
"""
    assert_no_backticks_in_headings(md, n["node_id"])
    return md


def main() -> int:
    upload_res = json.loads((BASE / "wiki/upload_results.json").read_text(encoding="utf-8"))
    subpages_path = BASE / "wiki/subpages.json"
    subpages = json.loads(subpages_path.read_text(encoding="utf-8")) if subpages_path.exists() else {}

    for n in NODES:
        nid = n["node_id"]
        files = upload_res[nid]["files"]
        v_url = files["video"]["url"]
        s_url = files["source"]["url"]
        md = build_node_markdown(n, v_url, s_url)
        (BASE / "wiki" / f"{nid}.md").write_text(md, encoding="utf-8")

        if nid in subpages and subpages[nid].get("wiki_url"):
            print(f"[skip] Wiki subpage exists for {nid}: {subpages[nid]['wiki_url']}", flush=True)
            continue

        cmd = [
            "dws", "doc", "+create",
            "--workspace", WORKSPACE,
            "--folder", CS_FOLDER,
            "--name", n["doc_name"],
            "--content", "-",
            "--timeout", "120",
            "-y",
        ]
        print(f">>> Creating Wiki subpage for {nid} ...", flush=True)
        proc = subprocess.run(cmd, input=md, capture_output=True, text=True)
        node_id_created = None
        wiki_url = ""
        if proc.returncode == 0:
            out = json.loads(proc.stdout.strip())
            top_data = out.get("data") or {}
            doc_obj = top_data.get("result") or out.get("result") or out.get("doc") or out.get("node") or top_data or out
            node_id_created = (
                doc_obj.get("nodeId")
                or top_data.get("nodeId")
                or doc_obj.get("docId")
                or out.get("nodeId")
                or (out.get("target") or {}).get("nodeId")
            )
            wiki_url = (
                doc_obj.get("docUrl")
                or doc_obj.get("url")
                or top_data.get("docUrl")
                or top_data.get("url")
                or out.get("docUrl")
                or out.get("url")
                or (f"https://alidocs.dingtalk.com/i/nodes/{node_id_created}?utm_scene=team_space" if node_id_created else "")
            )
        else:
            # Handle partial_success where doc was created but normalizer altered minor whitespace/escapes
            err_txt = proc.stderr.strip() or proc.stdout.strip()
            try:
                err_obj = json.loads(err_txt)
                node_id_created = (
                    (err_obj.get("error") or {}).get("details", {}).get("data", {}).get("nodeId")
                )
            except Exception:
                node_id_created = None
            if node_id_created:
                vf = subprocess.run(["dws", "doc", "+fetch", "--doc", node_id_created], capture_output=True, text=True)
                if vf.returncode == 0:
                    f_obj = json.loads(vf.stdout.strip())
                    f_md = (f_obj.get("content") or {}).get("markdown") or ""
                    if n["node_id"] in f_md and "## 五、" in f_md:
                        wiki_url = (f_obj.get("content") or {}).get("docUrl") or f"https://alidocs.dingtalk.com/i/nodes/{node_id_created}?utm_scene=team_space"
            if not wiki_url:
                print("STDOUT:", proc.stdout, flush=True)
                print("STDERR:", proc.stderr, flush=True)
                raise SystemExit(f"Failed creating Wiki doc for {nid}")
        if not wiki_url:
            print("RAW CREATE OUTPUT:", json.dumps(out, ensure_ascii=False, indent=2), flush=True)
            raise SystemExit(f"Could not parse wiki_url for {nid}")
        subpages[nid] = {
            "node_id": nid,
            "doc_name": n["doc_name"],
            "wiki_node_id": node_id_created,
            "wiki_url": wiki_url,
            "video_url": v_url,
            "source_url": s_url,
            "revision": "V6.1-CS-20261124",
            "timecode": "00:00",
            "human_review_status": "pending",
        }
        subpages_path.write_text(json.dumps(subpages, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"  [ok] {nid} -> {wiki_url}", flush=True)

    # Always re-fetch latest index doc before patching CS rows so any concurrent SALES edits are preserved
    fetch_proc = subprocess.run(["dws", "doc", "+fetch", "--doc", INDEX_DOC], capture_output=True, text=True)
    if fetch_proc.returncode != 0:
        raise SystemExit(f"Failed fetching index doc: {fetch_proc.stderr}")
    latest_raw = json.loads(fetch_proc.stdout.strip())
    latest_md = latest_raw["content"]["markdown"]
    (BASE / "wiki/latest_sales_index_before_update.md").write_text(latest_md, encoding="utf-8")

    new_cs_rows = []
    for n in NODES:
        nid = n["node_id"]
        sp = subpages[nid]
        row = (
            f"| `{nid}` | {n['role']} | [{n['doc_name']}]({sp['wiki_url']})（`{n['entry']}`） | "
            f"[独立成片 MP4]({sp['video_url']}) · `00:00`（[源码包]({sp['source_url']})） | "
            f"`Skill 已核` · `{n['skill']}` | `待人工复核` · Serena 1080p 独立成片已回读校验；{n['takeover']} |"
        )
        new_cs_rows.append(row)

    updated_lines = []
    inserted_cs = False
    for ln in latest_md.splitlines():
        if ln.startswith("| `CS-"):
            if not inserted_cs:
                updated_lines.extend(new_cs_rows)
                inserted_cs = True
            continue
        if "仅展示共用开场与客服 4 节点" in ln:
            ln = ln.replace(
                "仅展示共用开场与客服 4 节点",
                "仅展示共用开场与外部客服 7 个独立节点（均配独立专属子页、00:00 起播独立 1080p MP4 与渲染前源码归档）",
            )
        if ln.startswith("5. 外部客服三栏极简接待与一件一拍直发"):
            ln = (
                "5. 外部客服新人 3 关通关（`CS-ONBOARD-01`）→ 三栏极简接待与一件一拍直发（`CS-REALSHOT-01`）"
                "→ 富阳法院保修激活卡与发问熔断（`CS-WARRANTY-02`）→ 0 秒退款图与 409 急停截单（`CS-REFUND-409-03`）"
                "→ 问题订单 60s 呼救（`CS-ESCALATE-05`）→ 内部销售排他接管与防甩锅（`CS-TAKEOVER-06`）"
                "→ 外发防封守卫与五防考核（`CS-GUARD-KPI-04`）"
            )
        if ln.strip() == "## 全部 20 个业务节点通用视频覆盖与人工兜底台账总表":
            ln = "## 全部 23 个业务节点通用视频覆盖与人工兜底台账总表（销售 16 节点 + 外部客服 7 独立节点）"
        updated_lines.append(ln)

    if not inserted_cs:
        raise RuntimeError("Did not find | `CS- rows in latest index doc!")

    final_index_md = "\n".join(updated_lines) + "\n"
    assert_no_backticks_in_headings(final_index_md, "updated_sales_index.md")
    (BASE / "wiki/updated_sales_index.md").write_text(final_index_md, encoding="utf-8")

    upd_proc = subprocess.run(
        ["dws", "doc", "+update", "--node", INDEX_DOC, "--command", "overwrite", "--content", "-", "--force", "-y"],
        input=final_index_md,
        capture_output=True,
        text=True,
    )
    if upd_proc.returncode != 0:
        print("UPD STDOUT:", upd_proc.stdout, flush=True)
        print("UPD STDERR:", upd_proc.stderr, flush=True)
        raise SystemExit("Failed updating index doc")
    print("Updated index doc cleanly:", upd_proc.stdout.strip(), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
