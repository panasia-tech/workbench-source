> ## ⚠️ 这个项目已被取代，别再打包分发它
>
> 守护端现在是 **`groupcontrol-desktop`**（Electron 桌面应用），保活逻辑已从这里
> 移植过去，并且多了设备状态灯、scrcpy 投屏、一键初始化、无障碍看门狗、账号风控
> 状态这些这里没有的东西。生产分发的就是它：
> <http://127.0.0.1:8000> 上的「群控守护端」。
>
> 这里留作参考实现（`gc_adb/` 是那套保活逻辑的原始出处），**不要再从这里出包**。
> 2026-09-16 有人（我）照着 build.bat 在 Windows 打包机上打出了一个 exe，
> 才发现打的是退役的这一份——所以把这段写在最上面。

# groupcontrol-adb — 群控 ADB 保活 / 投屏守护

电脑端守护进程。**不替代现有执行层**(手机 app + 无障碍 + MQTT 照旧),只用 ADB 补两个短板:

- **息屏** → 永不自动息屏 + 充电常亮 + 需要时唤醒
- **被杀后台**(MIUI 冻结)→ 电池白名单 + 后台权限 + 掉出前台自动拉回前台

外加：一键为每台设备拉起 **QtScrcpy / scrcpy** 投屏，方便在电脑上观察。

```
业务执行：手机 app + 无障碍 + MQTT + server 调度      ← 原样保留
保活息屏：本项目(ADB 守护)                           ← 解决被杀/息屏
观察介入：QtScrcpy / scrcpy 投屏                       ← 电脑看多台
```

## 为什么能解决被杀后台

MIUI 不会冻结**前台** app。守护每轮检测每台设备：app 是否在前台、GcService 是否在跑；掉了就 `am start` 拉回前台（可选带 `--ez autostart true` 让 app 自动启动 GcService）。配合防息屏 + 电池白名单，设备就能稳定在线。

> 心跳数据曾显示 app「上线一下又被冻」——这套守护就是为消除那种情况。

## 环境

- Python 3.10+
- `adb` 在 PATH（mac：`brew install android-platform-tools`；Windows：QtScrcpy 包内自带，或装 platform-tools）
- 手机开启「USB 调试」；MIUI 还需开「USB 调试(安全设置)」才能模拟点击/装应用

```bash
pip install -r requirements.txt
cp config.example.yaml config.yaml   # 按需改
python main.py -c config.yaml
```

mac 开发调试、Windows 正式跑，同一份代码。

## 连接设备

- **USB**：插上即可，`adb devices` 能看到。多台用带独立供电的 USB hub。
- **无线**(省线，依赖 WiFi 稳定)：
  ```bash
  adb -s <serial> tcpip 5555
  adb connect <手机IP>:5555
  ```

## 配置要点(config.yaml)

| 项 | 说明 |
|---|---|
| `package` / `main_activity` | 已填好本项目对应的 `com.erp.groupcontrol` / `.ui.MainActivity` |
| `keepalive.*` | 各保活开关，默认全开 |
| `keepalive.autostart_extra` | `am start` 带 `--ez autostart true`。**需 app 配合**（见下），不改 app 设 false |
| `scrcpy.enabled` | 开启后为每台设备自动拉起投屏；`bin` 指向 scrcpy 可执行文件 |
| `report.enabled` | 把 ADB 物理在线状态上报 server（端点待 server 侧新增，见 monitor.py 注释）|

## 配套的 app 小改动(可选，但推荐)

让 ADB 拉活能顺带启动 GcService，在 `MainActivity` 加几行读 intent extra：

```kotlin
// onCreate / onNewIntent 里
if (intent?.getBooleanExtra("autostart", false) == true
        && GcBus.state.value == GcConnState.DISCONNECTED
        && prefs.brokerHost.isNotBlank()) {
    GcService.start(this)
}
```

之后守护的 `am start … --ez autostart true` 就能一步拉起 app + 启动 GcService。不改也行，只是被杀后 GcService 首次仍需人工点一次「启动」。

## 与 QtScrcpy 的关系

QtScrcpy 是**现成投屏工具**（多设备屏幕墙，直接下载用）。本项目负责**保活**；投屏可以：
1. 单独开 QtScrcpy 看（推荐，零配置）；或
2. 让守护用 `scrcpy.enabled` 自动为每台设备拉 `scrcpy` 窗口（QtScrcpy 内含 scrcpy 内核，也可指向独立 scrcpy）。

## GUI 版(tkinter,双击即用)

`main_gui.py` 是图形界面入口:选配置 → 启动/停止 → 窗口内看日志;首次启动自动在 exe 旁生成 `config.yaml`。打包:

```
pyinstaller --onefile --noconsole --name gc-adb-guardian --collect-all adbutils --add-data "config.example.yaml;." main_gui.py
```

> 功能更全的 Electron 桌面端(设备表格 + 投屏管理)见 `../groupcontrol-desktop/`。

## 打包成 exe 分发给其他 Windows 电脑

目标机**无需装 Python**,双击即用。⚠️ **exe 必须在一台 Windows 上打包**(PyInstaller 不跨平台,mac 打不了 win exe)。

**在一台 Windows 机上打包:**
1. 装 Python 3.10+(安装时勾选 *Add Python to PATH*)
2. 把本项目拷过去,双击 **`build.bat`**(自动装 PyInstaller + 依赖并打包)
3. 产物:`dist\gc-adb-guardian.exe`

**组装分发包**(拷给其它电脑的文件夹):
```
群控守护\
├── gc-adb-guardian.exe   ← 从 dist\ 拷来
├── config.yaml           ← 复制 config.example.yaml 改;adb_path 设成  adb\adb.exe
├── adb\                  ← platform-tools:adb.exe + AdbWinApi.dll + AdbWinUsbApi.dll
└── 使用说明.txt
```

**其它电脑使用:** 改好 `config.yaml` → 双击 `gc-adb-guardian.exe`。adb 随包带,不依赖系统安装。

> platform-tools 下载:<https://developer.android.com/tools/releases/platform-tools> —— 解压后把 `adb.exe` 及两个 dll 放进分发包的 `adb\`。
> 投屏(QtScrcpy)是另一个独立 GUI,各电脑自行安装,与本守护并行使用。

## 目录

```
gc_adb/
  adb.py         # ADB 封装(adbutils)：枚举设备 + shell
  keepalive.py   # 防息屏 + 电池白名单 + 前台检测 + 拉活
  monitor.py     # 健康检测 + 可选上报 server
  daemon.py      # 主循环编排
main.py          # 入口
config.example.yaml
```
