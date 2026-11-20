# 咸鱼卖家巡航台（Electron 桌面端）

本目录是当前唯一保留的咸鱼卖家巡航台主项目。它已从原 `erp-miniprogram` 混合仓库中独立出来；ERP 小程序、管理后台、FastAPI 后端、群控和 PDA 不属于本项目。

目录边界：

- `src/`、`scripts/`、`tests/`：运行代码、回归脚本和 E2E 资产
- `docs/`：需求、决策、事故和测试记录
- `design/redesign/`：原卖家巡航台设计稿与验证产物
- `docs/business/xm08/`：采购销售工程及卖家巡航业务资料
- `legacy/`：仅保留历史 RPA 入口，不作为当前启动入口

运行前请在本目录执行 `npm ci`，不要回到旧的 ERP 混合仓库目录安装依赖。

替换原安卓无障碍 APP（`../xianyu-crawler/`）。内嵌 Chromium（`WebContentsView`）打开 **goofish.com 网页版**，
读 DOM 文本取价（无需 OCR），多个闲鱼登录态并发分摊关键词，常驻后台运行、可最小化/收托盘、不强制置顶。

关键词行情模式现在支持两种来源。默认推荐本地 Excel 任务中心；没有本地清单时仍兼容旧的 CRAWLER 服务端任务：
- `POST /api/auth/crawler-login` 取 token
- `GET /api/market/crawl-tasks` 取全部启用商品
- `POST /api/market/prices` 上报价格

本地模式不依赖服务端任务接口：登录页选择「直接使用本机 Excel」后，在「任务中心」导入可替换的 `.xlsx/.xls/.xlsm`。当前 Excel 会成为稳定任务清单，每次采集只产生运行记录，不会重复创建任务；替换后的旧清单会自动归档，并保留历史运行记录与最近行情榜。型号清洗接入可热插拔的大模型（本次回归使用 Qwen `qwen3.8-max`，也可切换其他已适配供应商）；历史任务会在启动/开爬前自动迁移并清洗，无需重新导入；Key 只从 Electron 用户数据目录的 `llm-private.json` 或私有环境变量读取，不进入任务数据、日志或 Git。

## 运行

```bash
npm install
npm run dev        # 开发（热更）
npm run build      # 构建到 out/
npm run dist:mac   # 打 dmg（需 electron-builder）
```

## Linux 服务器 H5 控制台（Phase 05）

生产裸机安装 Camoufox 时，先在 Linux 服务器使用 sudo scripts/deploy/install-camoufox-linux.sh；脚本固定 Node.js 22+、camoufox-cli 0.7.3、CLI 路径和浏览器运行时目录，然后再启用 deploy/systemd/xianyu-server.service。

服务器独立入口不启动 Electron。开发/fixture 可以显式使用 fake provider：

```bash
npm ci
export SERVER_HOST=127.0.0.1 SERVER_PORT=3080 BROWSER_PROVIDER=fake
export XIAN_YU_SERVER_DATA_DIR=/var/lib/xianyu-server
npm run server:http
```

员工访问服务器地址即可打开 H5 控制台，登录后可查看、创建、停止任务并接收 SSE 状态；任务/账号元数据写入 SQLite，文件走服务器 artifact 目录。生产部署模板在 `deploy/`（Docker Compose、Nginx、systemd、备份/回滚脚本）。

生产环境必须使用 Node.js 22+ 和 Camoufox CLI，不能使用 fake provider：

```bash
export NODE_ENV=production BROWSER_PROVIDER=camoufox CAMOUFOX_USE_CLI=true
export CAMOUFOX_REQUIRE_INSTALLED_RUNTIME=true
export ALLOW_FAKE_PROVIDER=false SERVER_HOST=0.0.0.0 SERVER_PORT=3080
export XIAN_YU_SERVER_DATA_DIR=/var/lib/xianyu-server
node scripts/deploy/server-preflight.mjs
npm run server:http
```

员工只需要浏览器访问 HTTPS 地址；Camoufox、账号 Cookie、代理、任务数据和调度 Worker 均留在 Linux 服务器。真实 Linux provider、闲鱼登录、WMS/AI 凭据和员工浏览器验收仍须按 `docs/test-reports/phase-06-h5-full-business-transport.md` 的门禁执行，fake fixture 不能代替生产成功。

如需与旧版并行比较，可使用 `electron-builder.workbench.yml` 打包「闲鱼行情工作台」；它使用独立的 appId、安装目录和新图标，不会覆盖 `/Applications/闲鱼行情爬虫.app`：

```bash
npx electron-builder --mac --config electron-builder.workbench.yml --publish never
```

已导入主页清单后，如需后台小批量验证，可显式启动 `闲鱼行情爬虫.app --seller-crawl --seller-max=10`；也可以直接指定 Excel 文件，由程序读取“唯一卖家主页”工作表后自动启动：

```bash
闲鱼行情爬虫.app/Contents/MacOS/闲鱼行情爬虫 \
  --seller-crawl \
  --seller-source="/path/to/闲鱼RPA城市榜卖家主页交付.xlsx" \
  --seller-max=0
```

`--seller-max=0` 表示处理全部待采集主页；每周重新采集时追加 `--seller-reset`。新安装默认启用每周一 03:00 计划，也可以在 UI 中调整或关闭。不带这些参数时不会自动启动卖家采集，也不会触发关键词模式。

## 使用流程

1. 登录页：可用 CRAWLER 账号登录，也可以直接选择「直接使用本机 Excel」进入本地模式。
2. **任务中心**：导入/替换 Excel，按分类查看任务，查看内置 sample；旧清单进入历史任务，完成采集后最近行情榜自动更新。
3. **账号配置**：新增账号（每个 = 一个独立 cookie 分区的闲鱼登录态）、启用/停用、设节流。首次使用在预览页扫码登录闲鱼。
4. **预览**：浏览器式 tab，选中账号 →「闲鱼首页(扫码登录)」扫码登录该账号。可见即可手动操作。
5. 顶栏「立即开爬」：优先使用当前 Excel 清单，按启用账号数本地轮询切片，各账号并发串行其分片；本地模式结果保存在本机，不自动上报服务端。
6. **行情记录**：查看本机实时结果日志；有页面快照的记录可直接点击「查看快照」，回看抓取当时的闲鱼网页版 DOM 页面。窗口可最小化或关闭收托盘，爬取继续。

## 三次清洗与 AI 纠改队列

每条型号严格按三道清洗处理，前一步不覆盖原始历史，失败会留下状态并进入后续队列：

1. **Excel 型号清洗**：导入 Excel 后按批次调用当前配置的大模型标准化品牌、型号和搜索词；同时保留本地确定性规则。已覆盖常见错写，例如「华硕 G259CMS → 华硕 VG259CMS」「HKC CG24H3D / CG24H3S / CG25H4 → HKC 24H3D / 24H3S / 25H4」。
2. **AI 纠改**：无在售、采集失败、错误价格或采购价倒挂时，自动调用一次当前配置的大模型检查品牌/型号写法；模型必须给出一个候选，低置信度候选进入「AI 人工复核」。队列执行后会用候选型号和放宽搜索策略自动复核，人工可继续打回。
3. **人工打回后联网核查**：如果人工判断 AI 候选仍错误，点击“AI错误·联网核查”才调用一次当前供应商支持的联网接口（Qwen 走 Responses `web_search`，智谱走 `search_std`），只保存证据，不自动改型号或发布；结果回到人工复核，确认后才移出队列。
4. **采购价兜底**：行情发布前以 Excel 的采购价/成本价为硬下限；行情价低于采购价时一律拦截，不允许模型放行，防止采购倒挂。采购价缺失时只执行确定性价格规则。

使用的三类提示词和字段约束记录在 `docs/requirements/2026-08-23-qwen3.8-hot-swap.md` 与相关测试报告中。Qwen 型号纠错使用官方 Responses API，要求严格 JSON，并在程序侧做字段校验和本地确定性规则兜底，以便稳定解析结构化结果。

任务中心的「自动开爬」支持每日时间，例如 `02:00`；勾选「开机后自动驻留后台」后，程序会注册为系统登录项，保证到点时应用已在后台运行。

任务中心的「搜索词黑名单」支持每行配置一个词，例如 `芯片回收`、`维修`、`配件`。采集时会检查闲鱼真实商品卡片的标题/描述，命中黑名单的卡片不参与最低价计算；每次双关键词搜索会分别保存当前页面的 DOM 快照，详情记录默认展示选中最低价所在的搜索页面。

## 卖家主页采集（新增）

侧栏「卖家主页采集」是独立于关键词模式的新任务流：导入 `.txt/.csv/.json/.jsonl/.ndjson/.xlsx/.xls` 中的 Goofish/淘宝卖家主页链接后，程序只滚动卖家主页列表卡片，保存主图、标题、价格、商品链接和在售/已售状态，不进入单个商品详情。也可以从旧程序的卖家主页队列只读导入，旧程序原有关键词采集链路不受影响。

- 每个账号对同一卖家最多采集 1000 个商品；在售列表先采，剩余额度才采已售列表。若首个账号触顶且还有其它已启用账号，后续账号会跳过已采商品继续补采；只有没有可用账号时才按 1000 条触顶。
- 支持小批量验证、暂停后续跑、每周自动重采；遇到未登录、验证或页面异常会记录为需处理/失败，不会绕过平台限制。
- 商品明细追加保存到 Electron 用户数据目录的 `seller-items.jsonl`，主页清单和断点分别保存为 `seller-sources.json`、`seller-progress.jsonl`，不会把大批量记录写入原关键词行情表。
- 该模式不调用任何大语言模型或 AI 服务，Electron + Chromium 即可独立运行；服务器登录仅用于现有 CRAWLER 鉴权，卖家商品明细先保存在本机。

## 取价口径

`goofish.js` 注入脚本：Excel 任务依次搜索“型号”和“品牌 + 型号”，只读取搜索结果第 1 页真实卡片，按商品 ID/链接去重后，剔除低于 100 元的诱饵和黑名单不相干商品，再计算清洗后的平均挂牌价（`source=cleaned_average`）。二者皆无记失败、不上报脏值；旧服务端任务没有拆分字段时仍搜索原关键词。

行情价格低于 100 元时按错误价处理：不进入正常行情榜、不上报，并自动在系统“下载”文件夹生成错误型号 Excel，包含原品牌/型号、抓取价、实际搜索词及员工更正品牌/型号、扫码确认、处理备注列。多个低价诱饵会全部排除；例如 `39、39、300、319、366` 会采用 `328.33` 的清洗后平均价。结果页的“看构成”可以查看两次搜索、参与平均的有效挂牌、剔除的低价和对应链接。

每次真实采集会使用 Electron `HTMLComplete` 将抓取结束时已经渲染的闲鱼网页版和图片、CSS 等资源一起保存为 HTML DOM 快照，不执行页面脚本；旧历史记录若在此功能上线前产生，则会显示“暂无快照”。低于 100 元的错误价快照会额外显示红色“价格错误”水印和半透明商品卡片遮罩/叉线，原图仍可见。

员工填写错误 Excel 的“员工更正品牌/员工更正型号”后，可以直接重新导入；任务中心会优先使用更正值，留空时才回退原品牌/型号。

## 结构

```
src/main/        index.js(窗口/托盘/IPC) api.js(后端) session-manager.js(每账号视图)
                 goofish.js + scheduler.js(关键词执行/每日调度)
                 task-store.js(Excel 清单/历史运行/行情榜/本地设置)
                 seller-goofish.js + seller-scheduler.js + seller-store.js(卖家主页模式)
src/preload/     contextBridge → window.erp.*
src/renderer/    Vue3 + Element Plus：Login / Console / TaskCenter / Accounts / Prices / Preview
```
