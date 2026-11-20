# 采购工作台 V6 本地 Demo

源码来自 `outputs/采购工作台-闲鱼监控融合全栈版-20261119`。Vue 工作台位于 `web/`，Node.js/SQLite 服务与初始化数据位于 `server/`，共用过滤链和地区数据位于 `shared/`。

## 启动

需要 Node.js 24 和 npm。在本目录执行：

```sh
npm ci
npm run build
DEMO_PASSWORD="$(node -e 'console.log(crypto.randomUUID())')"
printf '本地演示密码 %s\n' "$DEMO_PASSWORD"
DEMO_PASSWORD="$DEMO_PASSWORD" npm start
```

打开 [本地工作台](http://127.0.0.1:5860/)，使用终端显示的密码。五个演示账号共用本次首次启动设置的密码。

| 账号 | 视角 |
| --- | --- |
| `liming` | 采购员，已通过三道练习 |
| `newbie` | 新采购员，须完成三道练习后解锁 |
| `zhaocg` | 仓管验货 |
| `chenkj` | 财务对账核销 |
| `wangzg` | 采购主管审批 |

可用 `PORT` 调整端口，用 `DEMO_DB_PATH` 指定独立的 SQLite 演示库。默认库为 `data/panasia_v6.sqlite`，首次启动由源码初始化。再次打开同一数据库时使用原先设定的演示密码。要自行设置新密码，用新库文件再启动。JWT 签名密钥在服务启动时随机生成，重启后重新登录。

## 验证

```sh
npm test
```

验收脚本自行创建临时数据库和随机密码，最后清理。覆盖角色鉴权、新人拦截、行情与账号保护、合成商品抓取/转单、对账补抓、仓管验货、财务与提成闭环，以及视频 HTTP 206。

## 演示范围

本包以本机样本运行，钉钉连接测试本机计算签名并返回模拟结果。商品命中、聊天、快递、财务和其他第三方状态使用演示数据。网站地址使用保留域名，支付示例、微信号、运单号等改为合成值。生产身份、站外消息、实盘下单及外部自动化部署不属于这个 Demo。Electron 的第三方桌面适配骨架与相关配置另有依赖，未作为 Web 全栈 Demo 源码纳入。服务保留该适配骨架原使用的本地兼容 API。

`public/evidence/` 的图卡和验货视频及 `public/media/` 的七章无声演示视频均为合成素材。应用可直接使用附带文件；如需重新生成素材，安装 Python、Pillow、FFmpeg 和中文字体后运行 `python3 scripts/gen_samples.py`。非默认字体位置由 `DEMO_FONT` 指定。
