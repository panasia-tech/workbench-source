# 销售工作台 Demo 源码

本目录以 2026-11-13 Stitch H5 的 Vue 源码和 2026-11-20 双视角 H5 取景所用的本机演示后端为基础。前端保留工作台、实物和虚拟选品、实物库、价图清洗、账号矩阵和队列、订单、价格表及学习说明等入口，后端保留相应的演示接口与价格、规格规则。

## 本地启动

准备 Node.js 20 或更新版本、npm 和带 pip 的 Python 3.12 或更新版本。本包在 Node.js 24.22.3、npm 10.9.4、Python 3.15.2 与 macOS Chromium 中验证。

在本目录先构建前端，再装入独立 Python 环境。

```sh
cd 前端
npm ci
npm run build
cd ..
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

保持两个终端同时运行，从本目录执行以下命令。

```sh
.venv/bin/python 后端/demo_server.py
```

```sh
.venv/bin/python h5_server.py
```

浏览器打开 `http://127.0.0.1:5341/?as=chenxm#/today`。页面使用本包自动签发的短期演示令牌。源码内置口令只匹配本地合成角色。右上可切换角色，或替换 `as` 为 `admin`、`zhoubb`、`linxiao`、`newbie`。改端口时，两终端使用同一 `STITCH_DEMO_PORT`，H5 终端可设置 `H5_PORT`。Windows 使用 `.venv\\Scripts\\python.exe`。

## 演示路径

- 在「今天」查看任务，进入「实物库存」打开示例货号 990001540233-A。进入「历史库存清洗」核对待洗、缺图与在架状态。
- 打开 `#/price-cleaning/SEL-2K240-ERR200` 查看错价核验样例，打开 `#/image-cleaning/990001540233-A` 查看三栏图池。
- 用「跨店上下架队列」和「订单」核对演示队列与货号；用 BOOKOFF 查「技術」检验日文样本搜索。

## 数据与功能范围

- 原取景版本借用本机缓存中的 ERP 基础服务。本包仅包含工作台使用的少量 SQLAlchemy 模型和本地适配 API。仓库、行情与订单来自演示样例，库存缺口服务返回空清单。
- 数量、货号、图片和行情目录均为合成或演示值。三类图片由接口生成并标注用途，查重按去参数后的 URL 判重。BOOKOFF 启动时建立 4 行商品的合成样本，供类目和搜索使用。
- 正式系统地址已换成占位，平台链接用于展示或在本地解析。发布、爬取、聊天、群控、仓储、老板台账、Wiki 和教程媒体均为本地演示或留作界面入口。配置、业务状态都由本机演示代码处理。教程模块使用现有文字和交互导览，录制视频未随包提供。
- 销售演示后端默认新建临时目录，设置 `SALES_RUNTIME_DIR` 可以保存演示配置。后端重启重置业务样例，BOOKOFF 样本在本目录 `.demo-runtime/`。
