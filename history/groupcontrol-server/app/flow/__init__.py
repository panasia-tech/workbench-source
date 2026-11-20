"""闲鱼自动化流程引擎(服务端,V2「大脑」)。

设计:流程步骤逻辑与「怎么操作设备」解耦。
- Transport 提供设备原语(截屏/点/滑/输入/dump/拉起应用),两实现:
  · AdbTransport   —— 本地 ADB 直连真机,开发/调试用
  · MqttRpcTransport —— 经 MQTT 原语 RPC 驱动远端手机,生产用
- Engine 在 Transport 之上做 OCR 锚点 + 重试 + 异常兜底(截图),与传输无关。
- publish_flow / delist_flow / reprice_flow 的步骤代码只依赖 Engine,
  dev(ADB)与 prod(MQTT)跑同一套流程,零改动。
"""
