# groupcontrol-desktop — 群控桌面端(Electron)

替代 `groupcontrol-adb` 命令行守护的桌面版:设备检测 + 保活 + 每台设备 scrcpy 独立投屏弹窗。保活逻辑移植自 `groupcontrol-adb/gc_adb`。

## 功能

- 每 5s 轮询 adb 设备:状态灯(绿=GcService 在跑 / 黄=服务未跑 / 红=掉线)、型号、当前前台 app
- 服务保活由群控 App 自身体系承担(看门狗/开机自启/划卡自救),桌面**不再自动拉活**,只保留手动「拉活」按钮
- 自动补权限(可开关):无障碍/悬浮窗/电池白名单/appops/输入法/防息屏常亮,检测不足即用 adb 补齐
- 无障碍看门狗:每轮检查 `enabled_accessibility_services`,掉绑瞬间自动取证(logcat 过滤 greeze/accessibility/am_kill + dumpsys accessibility,存档到 userData/a11y-evidence/)并自动重开(需「USB 调试(安全设置)」;重开失败 60s 节流重试)
- 账号风控状态:从 gc 服务端拉取账号状态(token 放 userData/gc-server.json),冻结/封禁在昵称下标红,操作列给「解冻」入口
- 闲鱼昵称:gc_identity.json(新版 App 直读)为主,uiautomator 抓取(旧版 App)兜底,持久化到 userData/gc-names.json;投屏窗口标题带昵称
- 群控 App 版本检查:启动+每 30 分钟比对服务器 version.json,可一键下载新版(下载后装App/初始化即装新版)
- 「打开屏幕」:按设备拉起 scrcpy 独立窗口;「拉活」:手动拉回前台
- 「装App」:`adb install -r` 随包的群控执行端 APK
- 「初始化」:新手机一键配好(启用+切换群控输入法、开无障碍、防息屏/常亮、电池白名单、后台/悬浮窗/后台弹出界面权限、安装统一版本闲鱼、adb 采集 SN/双IMEI/手机号上报 gc 服务器)
- adb server 异常自愈(kill 残留进程重启,失败诊断 5037 占用者);「重启连接」手动重启 adb
- 日志窗 + 日志落盘(userData/gc.log,>2MB 截断)

## 开发

```bash
npm install
npm start
```

adb / scrcpy 定位顺序:环境变量 `GC_ADB` / `GC_SCRCPY` → 打包资源目录 → `vendor/scrcpy/` → `../groupcontrol-adb/群控守护/scrcpy/` → PATH。

## 打包(Windows 安装包)

1. 下载 scrcpy win64(<https://github.com/Genymobile/scrcpy/releases>),解压为 `vendor/scrcpy/`(内含 scrcpy.exe、adb.exe、scrcpy-server 及 dll)。**vendor 不进 git**(第三方二进制、体积大)。
2. 把执行端 release APK 放 `vendor/app/gc-app.apk`(gradle `assembleRelease` 产物,改名而来)——界面里的「装App」按钮用它给手机 adb install。
3. (推荐)把**锁定版本的闲鱼 APK(7.25.80)**放 `vendor/app/xianyu.apk`——「初始化」按钮会用它统一各机闲鱼版本(坐标级流程的前提),`-d` 允许降级。
4. `npm run dist` → 产物 `release/群控守护安装包.exe`(NSIS 一键安装包)

客户双击安装包:静默装到 `%LocalAppData%\Programs\群控守护`(无需管理员),自动建桌面+开始菜单快捷方式;之后从快捷方式启动,直接读硬盘,**不像 portable 版那样每次自解压**。卸载走系统"应用和功能"即可。
