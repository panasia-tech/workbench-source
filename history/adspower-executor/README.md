# AdsPower 执行端（闲鱼上下架 + 消息采集）

> 群控系统的**浏览器形态执行端**：用 AdsPower 指纹浏览器替代 Android 执行机，
> 在浏览器里登录闲鱼网页版，复刻群控 App 的核心能力——上下架 / 改价 / 消息采集 / 聊天回复。
>
> 对标系统：`groupcontrol-server`（调度中心，**复用不改架构**）+ `groupcontrol-app`（Android 执行端，本项目是它的浏览器等价物）。

## 一、定位与架构

沿用群控「**大脑在服务端，执行端只是手**」的架构：

```
groupcontrol-server（调度/风控/流程引擎/消息入库）
        │  MQTT 原语 RPC（协议不变）
        ▼
adspower-executor（本项目，每个进程负责一个 AdsPower 环境）
        │  AdsPower Local API (http://local.adspower.net:50325)
        ▼
指纹浏览器环境（Playwright 走 CDP 接管）── 闲鱼网页版
```

- 执行端注册为**新设备类型**（`device.kind = browser`），走同一套 enroll / 心跳 / MQTT topic。
- 服务端流程引擎针对浏览器设备走**网页版流程实现**（`publish_flow_web` 等，服务端配套新增），
  执行端只暴露原语，不含业务逻辑。
- 一机一号语义保持：一个 AdsPower 环境 = 一台"设备" = 绑定一个闲鱼账号。

## 二、原语对齐表（Android 无障碍 → 浏览器）

现有 op 全集来自 `groupcontrol-server/app/flow/transport.py` + 设备端 `PrimitiveExecutor.kt`，
浏览器等价实现如下（**payload schema 保持不变**，服务端流程代码无感）：

| op | Android 实现 | 浏览器实现 |
|---|---|---|
| `screencap` | takeScreenshot (JPEG) | `page.screenshot` |
| `tap(x,y)` | dispatchGesture | `page.mouse.click(x, y)` |
| `swipe` | dispatchGesture | `page.mouse.wheel` / 拖拽 |
| `long_press` | dispatchGesture | `mouse.down/up` 延时 |
| `key(BACK/HOME/WAKEUP)` | 全局按键 | `page.go_back()` / 导航到指定 URL |
| `set_text` | 无障碍/IME 注入 | `locator.fill()` / `keyboard.type()` |
| `dump_nodes` | 拍扁控件树 `{desc,cls,clickable,center,size}` | **DOM/AX 树拍扁成同一 schema**（Playwright `page.accessibility.snapshot` + JS 遍历兜底），服务端 `chat_parse` 等解析逻辑可最大程度复用 |
| `node_click` / `node_long_click` | performAction 语义点击 | 按 desc 匹配节点后 `click()`（DOM 原生点击，天然等价语义点击） |
| `launch_app(pkg)` | 拉起闲鱼 App | `page.goto(闲鱼网页版 URL)` |
| `force_stop` | 回主页 | 关页重开 / 重新 goto |
| `push_media(url)` | 下载进相册 | **下载到本地临时目录即可**，上架时 `input[type=file].set_input_files()`，比手机链路简单很多 |
| `clear_media` | 清相册 | 清临时目录 |
| `screen_size` | 分辨率 | `page.viewport_size` |
| `self_check` | 环境自检 | 浏览器存活 / 登录态 / 页面可达性检查 |

## 三、功能范围（与群控任务类型一一对应）

| 任务类型 | 说明 | 优先级 |
|---|---|---|
| `chat_scan` | 消息采集：会话列表 → 未读会话 → 气泡抓取 → 上报入库 | 先做 |
| `chat_reply` | 聊天回复：按 peer_key 进会话 → 输入 → 发送 → 回读校验 | 先做 |
| `goods_delist` / `goods_relist` | 下架 / 重新上架（title+price 双锚定位商品行） | 其次 |
| `goods_reprice` | 改价 | 其次 |
| `goods_publish` | 上架（图片上传走 file input，无相册链路） | 最后（依赖最重） |
| `goods_polish` | 擦亮 | 视网页版是否支持 |

此外有一条**不走任务体系**的常驻能力：**消息门铃**（`gc_ads/im_watch.py`）。
它常驻一张 `/im` 页，未读角标一上涨就发一帧 `chat_hint` 提示服务端「现在就扫一轮」，
把「知道有新消息」的延迟从一轮周期扫描（服务端默认 300s）压到秒级。
**服务的是采购账号**——AdsPower 这批环境是采购端，销售留在安卓 App 群控
（2026-09-13 定的划分）；采购跟卖家谈价抢单，五分钟才知道对面回话就晚了。
纯只读，不点不发；挂了只退回周期扫描。

入库结构（`gc_conversation` / `gc_chat_message` + `dedup_key`）与售出土账、通知链路全部在服务端，本项目不涉及。

## 四、目录结构

```
adspower-executor/
├── README.md               # 本文档
├── requirements.txt
├── config.example.yaml
├── config.yaml             # 本地实际配置（含 environments 环境清单，不进 git）
├── main.py                 # 执行端入口：enroll → 连 MQTT → 原语执行循环（--user-id 指定环境）
├── manage.py               # 运维 CLI：doctor / list / capacity / start / stop / status / run
├── run/supervisor.json     # 进程状态落盘（pid/日志/人工停止标记，运行期生成）
├── logs/executor_<uid>.log # 每环境一个 executor 日志（运行期生成）
└── gc_ads/
    ├── config.py           # 配置加载（单环境兜底 + environments 多环境清单）
    ├── enroll.py           # 设备注册 + 5s 心跳（身份文件按环境隔离 device_identity_<uid>.json）
    ├── mqtt_client.py      # MQTT 连接、topic 订阅、rpc_resp/report/status/log 帧
    ├── adspower.py         # AdsPower Local API 客户端（start/stop/active/local-active → 拿 CDP 端点）
    ├── doctor.py           # 安装/进程/API/套餐/上游依赖 全面体检（只读）
    ├── supervisor.py       # 多环境进程管理：一键起停、三方对账、看门狗自愈
    ├── driver.py           # Playwright 接管浏览器：页面导航、登录态检查、页面恢复
    ├── selectors.py        # 闲鱼网页版选择器与 URL 常量（集中一处，页面改版只改这里）
    ├── primitives.py       # 原语执行器：op 分发，输出对齐 §二 的 schema
    ├── im_watch.py         # 消息门铃：常驻 /im，未读上涨 → chat_hint 帧（只读，不点不发）
    ├── logs.py             # 本地日志：按天切分、留 30 天、打包前打码
    ├── hot_code.py         # 代码热更新：加载器 + 下载器（三条安全线见 §四-D）
    └── identity.py         # 读闲鱼网页版当前账号昵称 → identity 帧上报
```

## 四-A、部署形态 A：打包程序（彻底形态，操作员机器零依赖）

```bash
./build.sh      # macOS/Linux → dist/gc-ads/
build.bat       # Windows   → dist\gc-ads\（必须在 Windows 上打，PyInstaller 不能跨平台）
```

产物是**自带运行时的程序目录**：Python、playwright driver（node 运行时）、全部依赖都打进去了，
目标机器**不需要装 Python，不需要跑 setup**。交付 = 把整个 `gc-ads` 目录拷走：

```
gc-ads/
├── gc-ads(.exe)     # 程序入口（executor 与运维 CLI 合一）
├── _internal/       # 内置运行时（勿动）
└── config.yaml      # 首启缺失时自动从内置模板生成，再人工填 server/secret/environments
```

> 形态说明：用过 onefile 单 exe，实测不可用——supervisor 拉起子进程后父进程退出，
> 子进程读不到已清理的 _MEI 解压目录（base_library.zip FileNotFoundError）。
> 故用 onedir 目录形态（2026-09-09 实测全链路通过）；且多环境拉起不用每进程解压 50MB。

用法与 manage.py 完全同构（程序同时承载 executor 与运维 CLI）：

```bash
gc-ads doctor                      # 体检
gc-ads executor --user-id <env>    # 单跑一个执行端（一般不用手动，supervisor 会拉）
gc-ads start / stop / status       # 一键起停（supervisor 自动用 exe 子命令拉 executor）
gc-ads run                         # 看门狗
```

config.yaml、device_identity_*.json、logs/、run/、tmp/ 全部落在**程序目录里**，
与启动时的 cwd 无关（双击、计划任务、开机启动都安全）。

## 四-B、部署形态 B：源码 + Python（开发/运维机）

```bash
# macOS / Linux
./setup.sh
# Windows
setup.bat
```

脚本做四件事：**找/装 Python ≥3.10**（macOS 用 brew、Windows 用 winget 自动装，
装不了则给手动安装指引）→ 建 `.venv` → 装依赖 → 跑 `manage.py doctor` 体检收尾。

两个部署友好性设计：
- 执行端只用 Playwright 的 **CDP 接管**（连 AdsPower 已开的浏览器），
  **不需要 `playwright install` 下载浏览器**——Python 部署最大的坑天然不存在。
- `doctor` 体检包含 Python 版本 / 是否跑在 .venv / 依赖完整性三项，
  新机器装完跑一遍就知道环境对不对。

## 四-D、代码热更新（改一行不用重打 48MB 的包）

业务代码（`gc_ads` / `main.py` / `manage.py`）被 PyInstaller 编进 exe 的 PYZ，
所以从前改一行就得在 Windows 上重打包、每台工位重下 48MB。现在打包入口
`gcads.py` 里挂了一个加载器：

```
exe 旁边有 code/ 且校验通过 → 从那里加载业务代码
否则                        → 用包里内置的那份
```

**必须是 sys.meta_path 而不是 sys.path**：PyInstaller 的 FrozenImporter 排在
sys.path 之前，光把目录塞进 sys.path，`import gc_ads` 仍会命中包里那份。
同理，加载器启用后要把已经 import 的 `gc_ads` 从 `sys.modules` 里清掉——
入口本身就是 `from gc_ads import hot_code` 起的。

发版：

```bash
.venv/bin/python scripts/publish_code.py --code-version 2 --version-name 0.1.1 --notes "改了什么"
rsync -av --delete release/code/ erp-txy:/www/wwwroot/gc-app/gc-ads-code/
```

端上每 6 小时查一次（与清日志同一节奏），**只下载不热替换正在跑的进程**——
下次启动或看门狗重启才生效，不在半路换掉自己脚下的地板。

三条安全线（下载并执行代码，值得写明）：
1. 清单里的路径必须落在 `code/` 里，`../` 一类一律拒绝；
2. 每个文件逐个校验 md5，坏一个就整体不换（不是"能下几个是几个"）；
3. 起不来自动回退：启用时立 `.boot-pending`，跑起来后撤掉；下次启动若标记还在，
   说明上一版加载成功却没跑起来（最阴的一类坏版本），隔离到 `code.bad/` 并退回内置版本。

> ⚠️ 这套机制本身要**随一次 Windows 打包**上去：现在分发页上那个 exe 里还没有加载器。
> 也就是「再打最后一次包，之后改业务代码就只传几十 KB」。

## 四-E、本地日志与远程取回

两端（执行端 / 桌面端）都按天切分、只留 **30 天**（`gc_ads/logs.py`）。
服务端要日志时不推送，只**下一条待办**；端上每次心跳与每次启动都问一句：

```bash
# 下待办（最近 7 天）
curl -X POST http://127.0.0.1:8000 \
  -H 'Content-Type: application/json' \
  -d '{"owner_kind":"device","owner_id":"<device_id>","days":7,"note":"排查门铃"}'
# 看回传情况
curl 'http://127.0.0.1:8000'
```

在线就立刻传，不在线就下次启动补传——**一条路覆盖两种情况**。
日志出门前统一打码（token/password 只留长度），包里不含任何凭据。

## 四-C、运维层（manage.py / gc-ads exe）

 AdsPower 侧的安装检测、实例盘点、一键起停、崩溃自愈全部收口在 `manage.py`：

```bash
.venv/bin/python manage.py doctor     # 体检：安装路径+版本/进程/Local API/套餐能力/上游依赖（只读）
.venv/bin/python manage.py list       # 环境清单：配置 × AdsPower 运行态 × executor 进程态 三方对账
.venv/bin/python manage.py capacity   # 实例容量：当前运行数 + 套餐说明（--probe 主动逐个开环境测上限）
.venv/bin/python manage.py start      # 一键启动全部启用环境（或跟 user_id 指定）；幂等
.venv/bin/python manage.py stop       # 停止（--browser 连浏览器一起关；默认只停 executor）
.venv/bin/python manage.py run        # 前台看门狗：executor 崩溃 10s 内拉起、浏览器掉了重开
.venv/bin/python manage.py envs       # 按用途盘点环境（无归属的会被标出来）
.venv/bin/python manage.py envs --create "行情爬虫" --purpose 行情   # 按用途新建，出生即有归属
.venv/bin/python manage.py envs --delete <id...>                    # 删除（不可逆，需二次确认）
.venv/bin/python manage.py groups     # 看归属全景；--assign <用途> --envs <id...> 调整归属
.venv/bin/python manage.py sync-envs  # 把 API 里的环境固化进 config.yaml（仅批量改名/切 env_source: config 时需要）
```

要点：
- **环境归属：同机两个驱动各管各的。** 桌面端 seller-pilot 和本执行端都在驱动 AdsPower，
  若认领同一个环境会抢同一个浏览器的标签页。边界用 AdsPower 分组划，`adspower.env_purposes`
  是用途登记表（分组名 → 谁驱动），本端只认领 `adspower.env_group` 那个分组。
  **没有分组的环境谁也不碰**——opt-in 比 opt-out 安全：漏分组只是不被纳管，
  而不是被错误的一方抢走。`manage.py envs --create` 强制指定用途（AdsPower 的
  `user/create` 本就必填 group_id），所以经 CLI 建出来的环境不会有归属空档。
- **环境清单默认直接从 AdsPower 拉**（`adspower.env_source: api`，走 `user/list`，需付费版套餐）。
  在 AdsPower 里新建环境后**不用改配置**，最迟一个 `env_cache_sec`（默认 60s）后自动纳管，
  备注名也直接取环境名。`config.yaml` 的 `environments:` 退化成**覆盖项**：给环境起人工备注名，
  或用 `enabled: false` 把某个环境排除在纳管之外；没写到的环境一律纳管。
- **降级是自动的**：套餐降回免费版（`user/list` 返回 paid subscriptions only）或 Local API
  不可达时，自动回退到 `config.yaml` 的 `environments`。想完全脱离 API 枚举就设
  `env_source: config`，行为与改造前一致；先跑一次 `sync-envs` 把清单固化下来。
- **Local API 限流 1 次/秒**：客户端按 AdsPower 进程做类级别节流并对撞限重试一次。
  跨进程（桌面端 seller-pilot 打同一个 Local API）也可能撞，靠这次重试兜底。
- **实例并发上限无 API 可查**：start 撞限时 AdsPower 会返回明确错误，supervisor 如实上报、
  继续其余环境，绝不静默吞掉；`capacity --probe` 可主动探测（会真实开浏览器）。
- 人工 `stop` 过的环境带 stopped 标记，看门狗不会擅自拉起；崩溃（kill -9）才会被自愈。
- 状态文件 `run/supervisor.json` 是多进程共享事实来源，supervisor 每次操作前重读
  （2026-09-09 实测：不重读会出现看门狗内存态过期、kill 后不拉起的 bug）。

## 五、服务端配套改动（在 groupcontrol-server，不在本仓库）

1. `Device` 增加 `kind` 字段（`android` / `browser`），enroll 时上报。
2. 流程路由：`Task → account.device.kind == browser` 时走网页版流程模块
   （`flow/publish_flow_web.py`、`flow/read_chats_web.py` 等），与手机版并存。
3. `chat_parse` 增加 DOM 版输入适配（或让 `dump_nodes` 输出严格对齐现有 schema 直接复用）。
4. 调度/风控/配额/熔断语义与设备形态无关，不动。
5. `mqtt_bridge` 接 `kind=chat_hint` 帧（消息门铃）：立刻给该设备的账号建一单 `chat_scan`，
   受 `chat_hint_enabled` / `chat_hint_min_interval_sec` 约束，在途任务仍由
   `jobs.create_chat_scan` 去重。周期扫描保持不动——门铃是加速通道，不是替代品。

## 六、开发路线与当前状态（2026-09-09）

- ✅ **M0 跑通环境**：AdsPower Local API（用 127.0.0.1:50325，local.adspower.net 会被代理劫持）→ Playwright CDP 接管 → 登录态校验。网页版能力边界已核实：消息/发布/下架/删除可用；**改价不可用**（须走手机版或闲管家 API）。
- ✅ **M1 协议接入**：enroll（kind=browser）/5s 心跳/MQTT/原语全集（含 tab 管理 op）经真实链路验证，调度中心可派单。
- ✅ **M2 消息采集**：web chat_scan 全链路（虚拟滚动会话列表 → userId peer_key → 气泡方向/时间戳解析 → 服务端入库复用），E2E 经 MQTT 派发 SUCCESS。
- ✅ **M3 下架/重上**：各环节真实验证；**本账号商品全部加入无忧卖导致网页版下架被平台拦截**（流程已能识别拦截 toast 并干净失败，拦截=终态勿重试）；relist 代码完成待非无忧卖商品补测。
- ✅ **M5 聊天回复**：dry_run 验证通过（定位会话→填入→回读）；真实发送待测试号验证（不骚扰真实买家）。
- ✅ **M4 上架**：真实发布+删除全绿（item_id 回读、列表校验、详情页删除清理；分类兜底「其他闲置」解决 AI 识别到网页不支持分类的卡点）。
- ✅ **E2E 生产链路**：chat_reply(dry_run) 与 goods_delist 经调度中心 MQTT 真实派发验证；delist 走完全部环节后被平台无忧卖拦截干净失败（预期行为）。
- 🟡 **消息门铃（M2 实时化，2026-09-13）**：常驻 /im + WS 帧当门铃 + DOM 未读上涨判据，
  执行端与服务端两侧代码与回归就绪；真实环境已验「常驻页开得起来、账号认得出、
  会话行取得到、业务页不被顶掉、无新消息时零误触发」。**尚缺一次真消息的端到端**
  （需要有人给采购号发一条，本端不会自己发消息去凑验证）。

## 九、已知边界与遗留

1. **改价：闲鱼网页版无此能力**（详情页只有下架/删除，/publish?id= 非编辑模式）。改价走手机版执行端或闲管家 API。
2. **无忧卖商品网页版不可下架**（平台拦截，toast 提示去「无忧卖-售卖中」）。本测试账号商品全是无忧卖；若业务账号不用无忧卖则不受影响。
3. **风控滑块**：punish iframe 探测已实现（命中即熔断，不过滑块）；冷却约 15-20 分钟自动解除。
4. chat_reply 真实发送（dry_run=false）代码就绪未实测——需测试号验证，不能用真实买家。
5. relist 的「重新上架」按钮结构待非无忧卖商品补测。
6. 执行端 `ensure_page` 在多 goofish tab 的脏环境下可能锚错 tab，建议启动时清理多余 tab。
7. 服务端 `tests/test_publish_spec.py` 有 8 个**既有**失败（英文 regex 断言对中文文案），与本次改动无关。

## 七、风险与待验证项

1. **闲鱼网页版能力边界**：发布/下架/消息入口在网页版是否完整可用，需 M0 阶段人工核实——这是整个项目的前提。
2. 网页版页面结构变动频繁，选择器层要做成可配置的（selector 集中一处，不散落流程代码里）。
3. 登录态保活：依赖 AdsPower 环境持久化 + 定期 self_check 发现掉登录后冻结账号（复用服务端 `login` 类熔断）。
4. 风控锚点（验证码/安全验证）命中即停，与手机端同一原则：绝不重试。

## 八、参考（现有实现）

- 协议：`groupcontrol-server/app/mqtt_bridge.py`、`api.py`（enroll/heartbeat/mqtt auth）
- 原语定义：`groupcontrol-server/app/flow/transport.py`；设备端 `groupcontrol-app/.../gc/PrimitiveExecutor.kt`
- 消息解析：`groupcontrol-server/app/chat_parse.py`、`flow/read_chats.py`
- 发布流程：`groupcontrol-server/app/flow/publish_flow_v2.py`（步骤分解思路可搬，实现重写）
