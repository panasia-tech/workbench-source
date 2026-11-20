"""browser 设备(AdsPower 指纹浏览器 × 闲鱼网页版)流程集。

与手机流程同构:流程函数只依赖 Transport 原语(screencap/tap/swipe/key/dump_nodes/…),
不 import playwright——Playwright 只出现在本地联调用的 local_transport.py,
生产由 adspower-executor 经 MQTT RPC 提供同签名原语。
"""
