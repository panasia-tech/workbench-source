# 媒体资料服务（media-service）

禅道任务 #2「交付独立 OSS 视频与教材服务」的服务端。每份资料一个固定链接 `https://<域名>/m/<资料ID>`，三个工作台和钉钉 Wiki 只存这个链接；打开时服务端判权限、签一个有时效的 OSS 地址，浏览器直接从 OSS 读视频。

## 受众

| audience | 谁能看 |
|---|---|
| `public` | 公开宣发。`confirm-public` 逐份确认后访客直接看；没确认前只给员工看 |
| `staff` | 登录了的员工 |
| `roles` | `roles` 里列出的 ERP 角色或平台分组（统一登录带过来的 `erp_role`、`groups`） |
| `external` | 只认外部凭证（`pass-create` 开，限定资料、有到期、可收回） |

`MEDIA_ADMIN_ROLES` 里的角色什么都能看。外部凭证每次取播放地址都回库查，收回后立刻取不到新地址，已签出去的地址按 `MEDIA_SIGN_TTL_SECONDS` 失效。员工会话 `MEDIA_SESSION_TTL_HOURS` 到期后重新登录。

## 统一登录

Authentik 应用 `media`（提供方「PanAsia 媒体资料」），照员工工作台的样子建：机密客户端、回调严格匹配、只放 ERP 同步来的号（策略「PanAsia 只放 ERP 同步来的员工」），不在门户列表里露。本服务要 `openid profile erp` 三个作用域：`erp` 是专门加的映射「PanAsia 媒体资料：ERP 员工 ID 和角色」，给 `erp_sub`、`erp_role`；`groups`（平台分组名）跟着 profile 给。

- 人按 `erp_sub`（ERP 员工 ID）认，不用统一登录自己的 `sub`（那是散列 ID）；没有 `erp_sub` 的号登不进来。
- 能看哪些资料按 ERP 角色（`ADMIN`、`WAREHOUSE`…）和平台分组（`ERP管理员`…）算，配的时候大小写随意。
- 这个应用不在 ERP「能进哪些系统」卡片里，同步不碰它的绑定。

## 版本

`upload` 每次传到新路径 `media/<资料ID>/v<N>/`，回读大小和 sha256（存在对象元数据 `x-oss-meta-sha256`）对上才算通过，没通过的版本不能发布。`publish` 切换已发布版本，`rollback` 回到上一次发布前的版本，固定链接不变。母版用 `--master` 一起传，只存不播。

## 播放页怎么续地址

播放、拖动前发现地址快过期，或者播放出错（OSS 过期回 403），播放页会重新取地址，记住进度和是否在播，换完接着放；连续失败三次才提示出错。

## 本机跑

```bash
uv venv --python 3.12 && uv pip install -e '.[dev]'
cp .env.example .env   # 填 MEDIA_SESSION_SECRET，MEDIA_DEV_LOGIN=true
.venv/bin/python -m scripts.mediactl add wh-basic-01 "第1课" --audience roles --roles warehouse
.venv/bin/python -m scripts.mediactl upload wh-basic-01 第1课_720p轻量版.mp4
.venv/bin/python -m scripts.mediactl publish wh-basic-01 1
.venv/bin/uvicorn app.main:app --port 8095
# 浏览器开 http://127.0.0.1:8095/auth/dev-login?role=warehouse&next=/m/wh-basic-01
.venv/bin/python -m pytest
```

开发登录打开时，没登录的人会被直接当成员工登录进去，所以本机看不出访客效果；访客要用不带 cookie 的请求验。

## 批量导入

首批 25 集按清单一次导入，格式写在 `app/manifest.py` 开头。先预演再真跑，重复跑只传有变化的：

```bash
.venv/bin/python -m scripts.mediactl import 首批资料/清单.csv --dry-run
.venv/bin/python -m scripts.mediactl import 首批资料/清单.csv --by 老邹
```

受众 public 的资料导入后还要发布人逐份 `confirm-public`，访客才看得到。

## 首批资料

仓库通用基础课 6 课（只给仓管：`WAREHOUSE,仓管`）、工作台业务教程 19 集（全体员工），每集 720p 轻量版播放、1080p 母版只存不播，配套旁白稿 / 逐字稿在线阅读。源文件在钉钉公司网盘：

- 视频（轻量版 + 母版）：`/公司资料/公司宣发与培训资料_20261108/MP4视频归档_2026-11-03/Documents/培训/` 下的 `仓库通用基础课_成片视频`、`工作台业务教程_手绘动画`（母版在子目录 `成片_1080p_全19集`）。另一份 `02_公司视频_本机成片与母版/…/工作台业务教程_手绘动画` 缺第 03、10 集，别用
- 旁白稿、逐字稿：`/公司资料/公司宣发与培训资料_20261108/01_教材与宣发文案/培训/`；19 集逐字稿按「第 N 集」拆成了每集一份

清单在 `manifests/首批/清单.csv`（文件按清单里的相对路径放在它旁边就能重跑）。资料 ID：`wh-basic-01`～`06`、`wb-guide-01`～`19`。

## 员工工作台的「培训视频」

工作台学习中心（/my/learning）按员工在统一登录里的分组，从 `GET /api/catalog` 取他能看的视频，按课程分组列出，点开进这里的固定链接。工作台 .env 加两行，没配这一区就不显示：

```
MEDIA_BASE_URL=http://127.0.0.1:8000
MEDIA_CATALOG_TOKEN=<和媒体服务 .env 里同一个>
```

## 费用

存储和外网流量按阿里云 OSS 中国内地按量付费算：标准存储（本地冗余）0.12 元/GB/月（[计费说明](https://help.aliyun.com/zh/oss/billing-overview)）；外网流出流量官方定价页是动态页面抓不到，先按 0.5 元/GB 估（[旧版计费示例](https://help.aliyun.com/zh/oss/billing-examples)），两个单价都在 `.env` 里可改，以实际账单为准。

| 项 | 估算 |
|---|---|
| 首批轻量视频 397 MiB | 存储约 0.05 元/月 |
| 母版 | 只存确认要留的；就算 11-03 归档的 121 GiB 全存，也只是约 14.5 元/月 |
| 员工看课 | 一个人把首批 25 集看一遍约 0.39 GB ≈ 0.2 元；20 个人各看一遍约 4 元 |
| 公开宣发 | 按一条 100 MB 估，每 1000 次播放约 98 GB ≈ 49 元，是费用的大头 |
| 请求 | 每万次几分钱，忽略 |

- 地域华东 2（上海），全部用**标准存储**：低频访问每 GB 每月只省几分钱，首批不到 1 GB，省不到 1 元，反而多出取回费和最短存储时长。母版以后多了再对单个前缀设生命周期转低频。
- 费用主要在外网流量，跟播放次数走，所以提醒按播放估：每次取播放地址记一笔（同一人同一天同一版本算一次，按视频大小算流量，是上限），`mediactl usage` 看本月，`--alert` 超过 `MEDIA_ALERT_MONTHLY_YUAN` 往钉钉群发一次。阿里云自己的预算告警要费用中心权限，现在的子账号没有。

## 部署（腾讯生产机 erp-txy，域名 media.panasia.fun）

`*.panasia.fun` 是泛解析，`media.panasia.fun` 已经指到生产机，不用加解析。统一登录只登记了 `http://127.0.0.1:8000`，换域名要先到 Authentik 改提供方「PanAsia 媒体资料」的回调。

1. **代码和环境**：放 `/www/wwwroot/media-service`，用机器上的 `/usr/bin/python3.12` 建 venv：`python3.12 -m venv .venv && .venv/bin/pip install .`。`data/` 放 SQLite，要能写。
   **首批资料库已经备好**（25 集已传进 panasia-media 并校验，见下面「首批资料」）：把私有桶里的 `deploy/media-首批.db` 下载成 `data/media.db` 再启动，不用重新导入。填好 `.env` 后在服务目录下跑：

   ```bash
   set -a; . ./.env; set +a
   .venv/bin/python -c "import os,oss2; b=oss2.Bucket(oss2.Auth(os.environ['MEDIA_OSS_ACCESS_KEY_ID'],os.environ['MEDIA_OSS_ACCESS_KEY_SECRET']),os.environ['MEDIA_OSS_ENDPOINT'],os.environ['MEDIA_OSS_BUCKET']); b.get_object_to_file('deploy/media-首批.db','data/media.db')"
   .venv/bin/python -m scripts.mediactl list   # 应该列出 25 份、都是「已发布 v1」
   ```
2. **`.env`**（权限 600，照 `.env.example`）：
   - `MEDIA_BASE_URL=http://127.0.0.1:8000`，`MEDIA_DATABASE_URL=sqlite:////www/wwwroot/media-service/data/media.db`
   - `MEDIA_SESSION_SECRET`：新生成一串随机值（`python3 -c "import secrets;print(secrets.token_hex(32))"`）
   - `MEDIA_STORAGE=oss`、`MEDIA_OSS_ENDPOINT=https://oss-cn-shanghai.aliyuncs.com`、`MEDIA_OSS_BUCKET=panasia-media`；钥匙暂用 ERP 那把：`/www/wwwroot/py-api/.env` 里的 `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET`。`MEDIA_OSS_CNAME` **不配**（自定义域名还没 HTTPS）
   - `MEDIA_OIDC_*` 照 `.env.example`；`MEDIA_OIDC_CLIENT_SECRET` 在 Authentik 后台 → 提供方「PanAsia 媒体资料」里复制
   - `MEDIA_DEV_LOGIN` 不写（默认关）。`MEDIA_ADMIN_ROLES=ADMIN,ERP管理员`（ERP 角色和统一登录分组两种写法都放上）
   - `MEDIA_CATALOG_TOKEN`：新生成一串随机值，**工作台 .env 里填同一个**（见下面「员工工作台」）
3. **systemd**：`media-api.service`，`uvicorn app.main:app --host 127.0.0.1 --port 8095 --proxy-headers`，WorkingDirectory 和 EnvironmentFile 指到上面。8095 端口 11-12 查过没人占。
4. **证书**：和 service.example.invalid 一样走 DNS 验证：`certbot certonly --authenticator dns-aliyun --dns-aliyun-credentials /etc/letsencrypt/aliyun.ini -d media.panasia.fun`。全局续期钩子会 reload nginx。
5. **nginx**：`/etc/nginx/conf.d/media.panasia.fun.conf`，443 反代 `127.0.0.1:8095`，带上 `X-Forwarded-Proto`/`X-Forwarded-For`；80 跳 443。视频不经过这里（浏览器直连 OSS），但 PDF 讲义由本服务转发，`proxy_buffering` 默认就行。`nginx -t` 过了再 reload。
6. **验收**：
   - `curl http://127.0.0.1:8000` 回 `{"ok":true}`；`/auth/dev-login` 回 404
   - 浏览器开一个员工资料的固定链接 → 跳统一登录 → 点「使用 ERP 账号」→ 回到播放页能播、能拖
   - 不登录直接请求 `/api/m/<资料ID>/play` 回 401
7. **每天的费用检查**：`media-usage.timer` 每天 09:00 跑一次 `.venv/bin/python -m scripts.mediactl usage --alert`（同一份 EnvironmentFile）。`.env` 里配 `MEDIA_ALERT_MONTHLY_YUAN=100` 和钉钉群机器人的 `MEDIA_ALERT_WEBHOOK`（安全设置选「加签」就再配 `MEDIA_ALERT_WEBHOOK_SECRET`）；机器人找老邹要建在哪个群。
8. **资料维护**在服务器上用命令行：`.venv/bin/python -m scripts.mediactl list` 等（见上面「本机跑」），要带上同一份 `.env`（`set -a; . ./.env; set +a`）。

## 上线前还缺

- 私有桶 `panasia-media`（上海）已建。RAM 子账号（只给这个桶的读写）和自定义域名的 HTTPS 都要主账号授权，暂时没有：先用 ERP 的 OSS 钥匙、走默认域名，视频直连 OSS 播放，PDF 由本服务转发预览。`media-oss.panasia.fun` 已绑桶（只通 HTTP），证书在生产机 certbot 里，有了证书权限后跑 `/root/media-oss/cert-deploy.sh` 再配 `MEDIA_OSS_CNAME`。
- 费用提醒的钉钉群机器人（Webhook）和提醒线，要老邹定建在哪个群。
- 钉钉 Wiki 里打开时的免登衔接。
- 三个工作台的教程入口换成固定链接。
- 首批真实视频（源文件在另一台 Mac 的 iCloud）。
