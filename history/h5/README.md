# H5 / PWA 版

这里没有页面代码。`miniprogram/` 的 WXML / WXSS / JS 在构建时直接编译成网页——
小程序改了什么，H5 重新构建就有，不用两边各写一遍。线上地址 `http://127.0.0.1:8000`。

## 跑起来

```bash
cd h5
pnpm install
pnpm dev        # http://localhost:5180/h5/，/api 代理到 127.0.0.1:8000（H5_PROXY_TARGET 可改）
pnpm build      # 先体检（scripts/check-compat.mjs），过了才出 dist/
pnpm preview    # 本地看生产包（带 Service Worker）
```

## 小程序的东西在 H5 里是谁接的

| 小程序 | H5 |
|---|---|
| `.wxml` | `compiler/wxml.js` 编成 Vue 模板。`{{}}` 里的成员访问一律改成可选链：`a.b` 在 a 为空时渲染空，不抛错（和小程序一样） |
| `.wxss` | `compiler/wxss.js`：rpx → `calc(N * var(--rpx))`；`view`/`page` 等标签选择器换成 `wx-view`/`wx-page`；页面、组件样式 scoped |
| `.js`（CommonJS） | `compiler/cjs.js` 包成 ES 模块。`Page/Component/App` 只记下配置，交给 `src/runtime/` |
| 页面栈、`wx.navigateTo` 等 | `src/runtime/router.js`。和浏览器历史同步：安卓返回键 = navigateBack，弹层开着先关弹层 |
| `wx.*` | `src/runtime/wx/`，实现了哪些见 `names.js` |
| 内置组件 | `src/components/`（input / picker / switch / scroll-view / picker-view …） |
| 自定义 tabBar、弹窗、预览、扫码 | `src/shell/` |

## 只有 H5 才有的：`src/overrides/`

和 `miniprogram/` 同构，按文件顶替：

- `services/auth.js`、`services/request.js`、`config/env.js`：账号密码登录（`/api/auth/h5-login`）。
  接口回 401 先拿 `/api/auth/me` 复核，确实失效才回登录页。
  **退出不调 `/api/auth/logout`**：那个接口会清 openid，等于顺手解了这个人小程序的微信绑定。
- `pages/bind/`：登录页（小程序那份是「绑定微信」），挂备案号、「添加到桌面」。
- `patches.json`：只差几个字的地方（「重新绑定微信」→「重新登录」）。

小程序改了被顶替的那几个文件，H5 不会跟着变。动 `miniprogram/services/auth.js`、`request.js` 时看一眼这里。

## 电脑上：`src/desktop/`

屏宽 ≥1024（`src/runtime/viewport.js` 的 `isDesktop`，跟着窗口实时变）登录后换成管理后台的样子：
左侧菜单（`DesktopSide.vue`，入口和手机工作台同一张表 `miniprogram/services/workbench.js`）+ 顶栏面包屑（`DesktopTop.vue`），
手机导航栏和底部 tab 藏起来。后台样式全在 `src/styles/desktop.css`（`dk-` 开头：页面骨架、数字卡片、工具栏、表格、表单、详情、标签、按钮、分页）。

页面按 `miniprogram/` 同路径在 `src/desktop/` 下放这几样，都是可选的：

| 文件 | 作用 |
|---|---|
| `index.wxml` | 电脑版模板：≥1024 时代替原模板渲染，同一个页面实例、同一份 data 和方法。写法同 WXML，可以用 `table/thead/tbody/tr/th/td`；尺寸写 px |
| `index.desktop.js` | 电脑版才要的数据和方法（ESM）：`data` 合并；`methods` 同名的顶替原方法（原方法留在 `this.__mobile_名字`）；`onLoad/onShow/...` 接在原生命周期后面调。手机上也会加载，顶替的方法里要按 `isDesktop.value` 分流 |
| `index.wxss` | 接在原样式后面编译（同 scope）。给电脑版模板用的类名带页面前缀（如 `wh-dk-*`）；只想微调原模板的规则包在 `@media (min-width: 1024px)` 里 |

列表翻页用 `src/desktop/lib/pager.js` 的 `desktopPager`（表格 + 页码，每页 50 条，顶替 `reload/loadMore`）。范例：`pages/warehouse/`（列表）、`pages/workbench/`。
没有电脑版模板的页面在内容区里收成居中一列（默认 960，表单/详情 760，名单在 `src/shell/desktop-layout.js`）。
电脑版模板只读原页面的 data、只调原页面的方法：小程序改了字段名或方法名，`pnpm check` 会提示「绑了 xx，页面里没找到这个方法」；改了字段名它查不出来，要在电脑上点一遍。

几条容易踩的：
- `src/overrides/patches.json` 的文案补丁只打在小程序原模板上，电脑版模板吃不到。补丁加的入口（发货复核、验货凭证、逐项验货等）电脑版里是各自另放的，改补丁要两边一起改。
- 电脑版样式不跟着原样式的 `@import` 走：原页面 @import 了别的页面样式（如采购编辑页引采购录入页），电脑版补充样式要自己再写一份。
- 组件（`components/`、页面里的自定义组件）没有电脑版模板，在电脑上还是手机样子（如群控中心的设备、任务面板）。
- `.desktop.js` 里 import `miniprogram/` 下的文件时，有 H5 替换件的会自动换成替换件（编译器做的），不会用到小程序里写死的线上域名。
- 要撑满整屏高度的页面（聊天）根节点别用 `dk-page`（它跟着内容长高）；H5 里的 `vh` 本来就是内容区高度。
- 单列 `<picker>` 在电脑上是贴在框下面的下拉列表（多于 12 项带搜索），多列和月份还是滚轮。

## 体检

`pnpm check` 把每个页面、组件、样式过一遍编译器，再列出小程序用到、H5 没实现的 `wx.*` 接口和组件。
小程序新页面用了新接口，这里会报出来；编译不过的话 `pnpm build` 直接停。

## 和小程序不一样的地方

- 扫码：摄像头 + BarcodeDetector（iOS 没有原生的，用 zxing-wasm，wasm 跟站点走，离线也能扫）。扫不出来可以从相册识别或手动输入。
- 选图：系统的文件选择。照片长边压到 2560、PNG 截图转 JPEG（对应小程序的 compressed）；超过 50MB 的文件不上传，直接提示。
- 没有微信能力：`wx.login`、支付、订阅消息。调到了会提示「H5 暂不支持」。
- 事件对象的 `target` 等于 `currentTarget`（现有页面没用到 target）。

## 发版

后端要先有 `/api/auth/h5-login`（`server/app/routers/auth.py`）。nginx 的 `/h5/`、`/ws/` 两段在 `deploy/nginx/admin.conf`。

```bash
pnpm deploy
```

部署入口会构建、上传并核对线上 `release.json` 与 H5 页面，然后把成功状态提交到 GitHub Deployments。仓库的 `deployment_status` Webhook 自动调用「系统发版通知」机器人，在钉钉「【官方】产品与系统更新公告」群提醒负责程序员补齐四要素和截图／录屏。失败的构建、上传或线上核对会标记失败。

需要本机有已登录的 `gh`、`pnpm`、`rsync` 和原有 `erp-txy` SSH 授权。其他 SSH 别名可用 `pnpm deploy --host <别名>`。重发同一个部署事件会检查通知回执，发送状态未知时须先核对群消息。

新版本不会自动接管已经打开的页面：页面底部会出「有新版本 · 更新」，员工点了才刷新（免得正填到一半被刷掉）。

## 图标

`public/icons/` 由 `scripts/gen-icons.py` 生成（和登录页「泛」字徽标同款），已提交，平时不用跑。
