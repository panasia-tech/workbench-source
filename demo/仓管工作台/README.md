# 仓管工作台 V1 本地 Demo

源码来自 `outputs/仓管工作台-Stitch重设计-20261114` 的 V1 研发发单基线。Vue H5 和 PDA 共用 `源码/src/`，包含模拟数据。仓管服务端为 `warehouse_server.py`，仅使用 Python 标准库和 SQLite。保留工作台内可打开的开发蓝图，以及审计下载接口所需的业务清单 CSV。

## 启动

需要 Node.js 18+、npm 和带 SQLite 模块的 Python 3。在本目录执行：

```sh
npm --prefix 源码 ci
npm --prefix 源码 run build
python3 warehouse_server.py
```

打开 [员工工作台](http://127.0.0.1:5351/?as=linqg#/today)。可进入 [主管总控](http://127.0.0.1:5351/?as=admin#/supervisor)、[老板视角](http://127.0.0.1:5351/?as=boss#/boss) 和 [新人练习](http://127.0.0.1:5351/?as=newbie#/learn)。顶部菜单提供 PDA 演示。若更改端口，使用环境变量 `H5_PORT`；若要在不同演示间隔离数据，使用 `WH_RUNTIME_DIR` 指向新的目录。默认运行时目录为此处的 `.demo-runtime/`，由服务器自动创建，前端首次打开后将合成样本写入 SQLite。

## 演示范围

服务只监听本机。URL 中的 `as` 是演示角色开关，服务端按演示身份验证部分角色与新人闯关规则。生产环境的身份鉴权、真实扫码硬件、打印机、ERP、快递和企微联调需要另行实现和验收。采购运单、实物码、序列号、买家和收货地址采用合成值。教学弹窗使用源码生成的示意帧，纸面流程蓝图是本版应用自带的开发参考。历史截图、编译产物、独立直开 H5、培训视频、发单回执和业务数据库未随源码包附带。
