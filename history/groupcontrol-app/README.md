# 群控执行端 App（groupcontrol-app）

闲鱼群控系统的**安卓执行端**：常驻手机/云机，通过 MQTT 连调度中心领任务，用无障碍模拟操作真闲鱼 App 完成商品上下架、发布、改价、消息回复、小铺数据抓取，并把执行结果回传。

> 定位：**纯执行端，无销售 UI**。销售用的「聚合版闲鱼」界面在小程序端，调度中枢是另起的 Python + FastAPI 后端。本 App 只负责“听指令、操作闲鱼、报结果”。

## 技术栈
- 原生 Android + Kotlin，minSdk 24 / targetSdk 34，AGP 8.1.4 / Gradle 8.14
- MQTT 5 客户端：HiveMQ MQTT Client（连自建 EMQX）
- 无障碍：AccessibilityService（仅作用于闲鱼 `com.taobao.idlefish`）

## MQTT 协议（手机 ↔ 后端）
Broker：EMQX（自建）。鉴权：MQTT 用户名 = `device_id`，密码 = `device_token`（后台建设备时下发），ACL 限每台设备只能收发自己 `gc/{device_id}/#`。

> 生产 Broker 是腾讯云生产机 127.0.0.1 上的 EMQX（和 service.example.invalid、groupcontrol-server 同机）；本地开发用 docker `gc-emqx`（`groupcontrol-server/docker/`）。
> 鉴权/ACL 走 **HTTP hook 回调 groupcontrol-server**，故 **EMQX 必须能访问到后端**——上生产时二者要同机或网络可达。

| 方向 | Topic | QoS | 说明 |
|---|---|---|---|
| 后端→设备 指令 | `gc/{device_id}/cmd` | 1 | 领任务，帧 `{task_id, task_type, payload}` |
| 设备→后端 状态 | `gc/{device_id}/report` | 1 | `{task_id, status, progress, mark, error, result}` |
| 设备→后端 日志 | `gc/{device_id}/log` | 0 | best-effort |
| 在线状态 | `gc/{device_id}/status` | 1 retained | 上线发 `{online:true}`；断线由 LWT 遗嘱发 `{online:false}` |
| 全体广播 | `gc/broadcast/cmd` | 1 | 全员控制指令 |

`status` 回传值：`run→RUNNING / wait→WAITING / end→SUCCESS / error→FAILED`。

## 任务类型（GcProtocol）
- 业务类（待接无障碍）：`goods_list_up`/`goods_list_down`/`goods_publish`/`goods_reprice`/`chat_reply`/`shop_data_scrape`
- 控制类（已可跑）：`set_phone_info`（上报机型）/`clear_img`（清缓存）/`restart_xy`（拉起闲鱼）/`restart_aj`/`clear_task`/`remove_task`

## 代码结构
```
gc/GcProtocol.kt   Topic 约定 + 指令解析 + 回传帧构造 + 任务/状态常量
gc/Prefs.kt        配置：EMQX 主机/端口/TLS + device_id + device_token
gc/GcMqttClient.kt HiveMQ 封装：连接/LWT/订阅/回传/自动重连
gc/GcService.kt    常驻前台服务，持有连接与执行器（START_STICKY + 开机自启）
gc/TaskExecutor.kt 指令分发：控制类已实现，业务类转无障碍（占位）
gc/GcBus.kt        Service↔UI 状态/日志总线
gc/BootReceiver.kt 开机/更新后自动拉起
auto/XianyuAccessibilityService.kt  闲鱼无障碍执行器（骨架，业务流程待补）
ui/MainActivity.kt 配置 + 启停 + 状态/日志
```

## 构建
```bash
# 需 local.properties 指向装了 android-34 平台的 SDK：
echo 'sdk.dir=/path/to/android-sdk' > local.properties
./gradlew :app:assembleDebug
# 产物 app/build/outputs/apk/debug/app-debug.apk

# 正式（签名）包：需 keystore.properties + gc-release.jks（均已 gitignore，不在库里）
# 缺这两个文件时 release 构建不挂签名（不会报错，但产物装不上）
./gradlew :app:assembleRelease
# 产物 app/build/outputs/apk/release/app-release.apk
```

> release 与 debug 签名不同，**换包必须先 `adb uninstall com.erp.groupcontrol`**；卸载会清空无障碍授权与
> MIUI 自启动开关，**每次重装都要重做下面的 provision 三件套**，否则拔掉 USB 后 App 会在 30~40s 内被冻死。

## 执行机 provision（每台、每次重装 APK）
1. **安全中心 → 自启动 → 允许**（决定性开关；`adb cmd appops set … 10008 allow` 兜不住，MIUI 只认这个 Switch）
2. 省电策略 → **无限制**
3. 最近任务 → **锁定**卡片
4. 无障碍 → 启用「群控执行端」（`adb shell settings put secure enabled_accessibility_services com.erp.groupcontrol/com.erp.groupcontrol.auto.XianyuAccessibilityService` 可代劳）
5. **关闭锁屏密码**（屏一灭锁屏,流程全断;群控机不存隐私,直接关）
6. **内置微型 IME 设为默认输入法**（聊天回复 `ime_commit` 的注入通道;无人值守机不需要软键盘）:
   ```bash
   adb shell settings put secure enabled_input_methods "$(adb shell settings get secure enabled_input_methods):com.erp.groupcontrol/.inputmethod.GcInputMethodService"
   adb shell settings put secure default_input_method "com.erp.groupcontrol/.inputmethod.GcInputMethodService"
   # 要在机上手动打字时切回:settings put secure default_input_method com.sohu.inputmethod.sogou.xiaomi/.SogouIME
   ```

## 本地联调（无真机验证通信层）
1. 起本地 EMQX：`docker run -d --name emqx -p 1883:1883 -p 18083:18083 emqx/emqx:5`
2. App 里填 主机=电脑局域网IP、端口 1883、关 TLS、随便填 device_id/token（EMQX 默认允许匿名，或先关鉴权）
3. 点「启动」→ 状态应变「已连接」
4. 用 mqttx / mosquitto_pub 往 `gc/{device_id}/cmd` 发：
   `{"task_id":"t1","task_type":"set_phone_info"}`
   → App 日志显示收到，`gc/{device_id}/report` 收到 `run` 和带机型的 `end`。

## 已完成 / 待办

> 架构已于 2026-07-08 升级 V2：**流程逻辑全部收回服务端，App 只暴露原语**。
> 下方「无障碍业务流程」等 V1 条目已作废，详见 [`docs/01_架构复审与重构方案.md`](docs/01_架构复审与重构方案.md)。

- [x] MQTT 通信层：连接、鉴权、LWT 在线态、订阅指令、回传、自动重连、常驻前台、开机自启
- [x] 控制类任务真跑通（上报机型/清缓存/拉起闲鱼）
- [x] 后端（FastAPI + aiomqtt 桥）+ EMQX 鉴权/ACL hook 接入
- [x] **V2 原语执行器**:原语全部经真机 RPC 验证,与服务端 `flow/transport.py` 所需 op 零缺口;
  2026-07-29 新增 `ime_picker`/`ime_commit`(内置微型 IME,Flutter 输入框注入,见 `inputmethod/GcInputMethodService.kt`)
- [x] **聊天回复(1b)端到端**:服务端 `chat_reply` 任务 → 定位会话 → `ime_commit` 注入 → 点发送 → 列表预览校验,2026-07-29 小米12 真机跑通
- [x] **release 正式签名包**（`assembleRelease` + `keystore.properties`）
- [x] **脱离 adb 的真机连接**：手机纯 WiFi 直连 broker 拿到 ONLINE（此前均为 `adb reverse` 走 USB 隧道）
- [ ] **调度链路端到端**：建 job → Dispatcher 派发 → runner 跑 flow 真发一条（卡在手机 provision，非代码问题）
- [ ] 扫码配置 device_id/token —— release 包不能 `run-as` 写 prefs，32 位 hex 手输极痛，上量前必须做
- [ ] 无障碍被杀后的自恢复检测（现在被冻死后不会自愈，只能人工拉起）
- [ ] TLS(8883) 证书与生产参数（现走明文 1883）
- [x] 生产部署 EMQX + groupcontrol-server（腾讯云生产机）
```
