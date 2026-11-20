# 闲鱼自动化原型：ADB + 本地 OCR 点坐标

闲鱼是 **Flutter**，AccessibilityService 读不到控件树，只能**截图 → OCR 识别文字与坐标 → 按坐标点击/滑动/输入**。本目录是在 **Mac 上用 ADB 驱动真机 + 本地 OCR** 的开发原型，用来把闲鱼的上下架/发布/改价操作流程调通；成熟后再决定移植到端上还是走后端。

## OCR 选型：RapidOCR（本地部署）
- RapidOCR = PP-OCR 模型的 **ONNX 版**，`pip` 装完即带**中文模型、完全离线、Mac CPU 直接跑**，无需 PaddlePaddle 重型环境，也不依赖任何云 OCR（替代旧爬虫用的 zndjs 云 OCR）。
- 识别结果给出每段文字的**四点框**，取中心即点击坐标；截图像素坐标与 `adb input tap` 同一坐标系，直接对应。

## 安装
```bash
python3 -m venv .venv && . .venv/bin/activate
pip install rapidocr_onnxruntime      # 含中文模型
```

## 连接真机（关键）
```bash
adb devices          # 必须能看到设备且状态是 device，不是 unauthorized/offline
```
- 若为空或 `unauthorized`：手机开「开发者选项 → USB 调试」，插线后点弹窗**「允许」**。
- 无线调试：`adb connect <手机IP>:5555`。

## 用法
```bash
. .venv/bin/activate
python ocr_tap.py shot screen.png          # 截图存盘，先肉眼看识别对象
python ocr_tap.py read                      # 打印当前屏所有 (x,y) 置信度 文字
python ocr_tap.py find "行情"               # 找文字，输出命中中心坐标
python ocr_tap.py tap-text "我要卖"         # 找到并点击
python ocr_tap.py tap 540 1200              # 直接点坐标
python ocr_tap.py swipe 540 1600 540 600    # 上滑一屏
# 多设备：任意命令加 --serial <设备号>
```

## 中文输入的坑
`adb shell input text` **不支持中文**。发布/改价要输中文时，装 **ADBKeyboard** 输入法：
```bash
# 安装 ADBKeyboard.apk 后设为默认输入法，再广播输入：
adb shell ime set com.android.adbkeyboard/.AdbIME
adb shell am broadcast -a ADB_INPUT_TEXT --es msg "AOC 24G2 正常使用痕迹"
```
（后续把这步封进工具的 `input` 命令。）

## 与执行端 App 的关系
本原型和 `groupcontrol-app`（MQTT 执行端）是**同一套自动化的两个阶段**：
1. **现在**：Mac + ADB + 本地 OCR，快速迭代闲鱼操作流程（无需反复打包 APK）。
2. **之后**：把跑通的流程移植进 App —— 截图走无障碍 `takeScreenshot`，OCR 用端上 ML Kit / 端上 ONNX，点击用 `dispatchGesture`，由 MQTT 指令驱动。

## 待办
- [ ] 真机连上后跑通 `read`，确认闲鱼各页文字识别率
- [ ] 封装「发布商品」流程脚本（进发布页→填型号→AI帮写→选图→价格→发货模板→发布→回读 itemId）
- [ ] 「下架」「改价」流程脚本
- [ ] 中文输入接 ADBKeyboard
- [ ] 决定 OCR 最终落点（端上 / 后端）
