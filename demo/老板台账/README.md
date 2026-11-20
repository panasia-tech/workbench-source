# 老板台账 V3 桌面 Demo

源自桌面版构建 `anchor-boss-master-ledger-desktop-20261118-v8`。包括账务与资产台账、密码库、开店双轨教程、治理审核、设备遥测、派单容量，以及老板、总经办、主管、员工四种演示入口。

## 本机启动

需要 Python 3.10 或更高版本和一个支持现代 JavaScript 的浏览器。Python 标准库和随包前端文件即可运行，无需安装 npm 或 pip 依赖。

```bash
bash ./启动全量台账.sh
```

浏览器打开 [http://localhost:5370](http://localhost:5370)。端口被占用时可用 `LEDGER_PORT=15370 bash ./启动全量台账.sh`，然后访问对应端口。用 `Ctrl+C` 停止服务。macOS 也可用 `启动全量台账.command`。

首次启动在本目录 `.demo-runtime/` 生成 SQLite 库和本机随机密钥。界面「恢复标准样本」会重建演示库。演示密码和 TOTP 秘钥在运行时生成。真实账户、设备、历史、网络和身份数据可用本目录的合成案例替代。

## 验证

```bash
python3 tests/verify_demo.py
```

验证会在临时目录启动独立实例，覆盖四角色、两条跨轨硬闸、治理二级审核、CSV、TOTP、数据完整性和重启后密钥持久化。

## 目录

- `web/` 包括 HTML、CSS 和 JavaScript 源码，由本地 HTTP 服务直接提供。
- `ledger_server.py` 提供业务 API。`db_init_and_seed.py` 定义 SQLite 表、约束、触发器和初始化，`demo_seed.py` 与各模块 seed 构造新样本。
- `数据库与迁移/` 存放 PostgreSQL 041–046 增量 SQL，作为研发参考。其前置生产基础表需由对应系统提供，本机 Demo 使用独立 SQLite 模型。

本交付将演示服务固定在 `127.0.0.1`，保留 AdsPower 接口与离线反馈，禁用联机调用。治理资源链接使用 `.invalid` 占位地址。WebAuthn 保留演示流程，正式 SSO、实际 Face ID 跨设备链路、PostgreSQL、OA、钉钉、ERP、真实设备和 AdsPower 接入需在对应环境单独验证。角色由界面切换，用于功能演示。
