> # ⚠️ 本项目已废弃，请勿在此修改
>
> 职能已由 [`xianyu-seller-pilot/`](../xianyu-seller-pilot/) 完整承接（Vue3 + Element Plus
> 外壳、行情采集、WMS、AdsPower 驱动、角色菜单）。本目录仅作历史留存，**不接受新改动**，
> 也不再构建发布。在这里改代码不会进入任何一个在跑的客户端。
>
> ## 但不要删除同名的用户数据目录
>
> `xianyu-seller-pilot` 的 electron-store 名字**仍然是 `xianyu-electron`**
> （见 `xianyu-seller-pilot/src/main/store.js`），所以
> `~/Library/Application Support/xianyu-electron/` 是**在跑的桌面端的活数据**
> （账号配置、任务快照、merchant-batch-all.json 等）。删掉它等于清空线上配置。
> 本目录（源码）和那个目录（数据）只是重名，没有从属关系。
>
> 下线背景见整合方案 S2：三个 Electron 应用合并为一个外壳。

# 闲鱼行情爬虫（Electron 桌面端）

替换原安卓无障碍 APP（`../xianyu-crawler/`）。内嵌 Chromium（`WebContentsView`）打开 **goofish.com 网页版**，
读 DOM 文本取价（无需 OCR），多个闲鱼登录态并发分摊关键词，常驻后台运行、可最小化/收托盘、不强制置顶。

后端**零改动**，仍走 CRAWLER 角色：
- `POST /api/auth/crawler-login` 取 token
- `GET /api/market/crawl-tasks` 取全部启用商品
- `POST /api/market/prices` 上报价格

## 运行

```bash
npm install
npm run dev        # 开发（热更）
npm run build      # 构建到 out/
npm run dist:mac   # 打 dmg（需 electron-builder）
```

## 使用流程

1. 登录页：CRAWLER 账号（生产 `crawler01 / crawler888888`）。服务器地址写死在主进程（`store.js` 默认 `http://127.0.0.1:8000`），用户不可见。
2. **账号配置**：新增账号（每个 = 一个独立 cookie 分区的闲鱼登录态）、启用/停用、设节流/每日定时。
3. **预览**：浏览器式 tab，选中账号 →「闲鱼首页(扫码登录)」扫码登录该账号。可见即可手动操作。
4. 顶栏「开始爬取」：拉全量任务，按启用账号数本地轮询切片，各账号并发串行其分片，读价后上报。
5. **爬取内容**：本机实时爬取日志（分页，价格/来源/账号/状态）。窗口可最小化或关闭收托盘，爬取继续。

## 取价口径

`goofish.js` 注入脚本：优先读「行情成交均价」（`source=market_quote`），网页无则取搜索结果第 1 页
最低在售价（`source=lowest_listing`，element 级 `¥xxx` 取最小，排促销噪声），二者皆无记失败、不上报脏值。

## 结构

```
src/main/        index.js(窗口/托盘/IPC) api.js(后端) session-manager.js(每账号视图)
                 goofish.js(读价) scheduler.js(分配/队列/定时) store.js(加密token/配置/日志)
src/preload/     contextBridge → window.erp.*
src/renderer/    Vue3 + Element Plus：Login / Console / Accounts / Prices / Preview
```
