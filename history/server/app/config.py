import os

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # 默认读 .env（生产）；沙箱/本地测试用 ENV_FILE=.env.dev 切换
    model_config = SettingsConfigDict(
        env_file=os.getenv("ENV_FILE", ".env"), env_file_encoding="utf-8", extra="ignore"
    )

    port: int = 8000
    # 工作台爬虫租约:多久没续租算失联、可以被别人接手。
    # 太短,网络抖一下就被抢走;太长,机器关了半天没人能接手。
    workbench_lease_ttl_sec: int = 90
    # 上架状态兜底对账:多久跑一轮、只碰多久没动过的行、每轮最多几件。
    # grace 是为了不跟上架页的 WS 轮询(3s 一拍)抢同一批行。
    gc_reconcile_interval_sec: int = 300
    gc_reconcile_grace_min: int = 10
    gc_reconcile_batch: int = 20
    database_url: str = "mysql+pypostgresql://demo:demo@localhost/erp_monitor?charset=utf8mb4"

    wx_appid: str = ""
    wx_secret: str = ""
    # 企微自建应用，跟群控用同一个应用。没配齐通知就只有站内待办。
    # 生产 IP 127.0.0.1 要在应用的「企业可信IP」里，否则一律 60020
    wecom_corpid: str = ""
    wecom_corpsecret: str = ""
    wecom_agentid: str = ""
    # 钉钉企业内部应用「ERP」：入职建待分配账号、离职删号（services/dingtalk_sync.py）。
    # 事件走 Stream 长连接（scripts/run_dingtalk_stream.py），不用公网回调。
    # H5 钉钉工作台免登也用这套凭证：前端 dd.requestAuthCode 需要 corpId（DINGTALK_CORP_ID）。
    dingtalk_client_id: str = ""
    dingtalk_client_secret: str = ""
    dingtalk_agent_id: str = ""
    dingtalk_corp_id: str = ""
    # 总开关。没开时监听只记日志不动账号；对账脚本的 --dry-run 不受它管
    dingtalk_sync_enabled: bool = False
    # 只处理这些钉钉 userid（逗号分隔），试运行用；空=全公司
    dingtalk_sync_only_userids: str = ""
    # 建号、删号后通知谁（钉钉 userid，逗号分隔），一般是管理员
    dingtalk_notify_userids: str = ""
    # 技术部新人填了 GitHub 邮箱/用户名，自动邀请进这些仓库（services/github_invite.py）。
    # 令牌要对仓库有管理权限（fine-grained：Administration 读写）；没配只记下账号，配好后在后台补发
    github_invite_token: str = ""
    github_invite_repos: str = "superzou2021/erp-miniprogram"
    jwt_secret: str = "dev-secret-change-me"
    jwt_expire_minutes: int = 10080

    oss_region: str = "oss-cn-hangzhou"
    oss_bucket: str = ""
    oss_access_key_id: str = ""
    oss_access_key_secret: str = ""
    oss_endpoint: str = "https://oss-cn-hangzhou.aliyuncs.com"
    oss_public_base: str = ""

    archive_fc_url: str = ""
    archive_fc_sign_secret: str = ""

    # ---- OCR（付款凭证/闲鱼订单/销售单/SKU标签/行情/成色扫描 六处共用）----
    # 2026-08-17 起改用自建 OCR 微服务：一台家用 Windows(RTX 5070) 跑 RapidOCR+CUDA，
    # 经 ssh -R 反向隧道挂在本机 127.0.0.1:8600（与群控 groupcontrol-server 同一个服务，
    # 详见 groupcontrol-server/win_ocr/README.md）。已下掉付费的 zndjs 云 OCR。
    # ⚠️ 没有兜底：那台机器或隧道一挂，这六处 OCR 功能一起不可用（员工侧会看到报错）。
    ocr_http_url: str = "http://127.0.0.1:8600/ocr"
    ocr_http_token: str = ""      # 与 Windows 侧 GC_OCR_HTTP_TOKEN 同值；空=不校验
    ocr_http_timeout: float = 60.0
    kuaidi_user: str = ""

    # ── 接口文档(Swagger/ReDoc/openapi.json)访问路径 ──────────────────────
    # 安全:文档会暴露全量接口与字段结构。默认藏在带随机 token 的私密路径下,
    # 老的 /docs、/redoc、/openapi.json 一律 404。轮换:改 .env 的 DOCS_TOKEN 后重启
    # (无需改代码);彻底关闭文档:把 DOCS_TOKEN 置空。
    docs_token: str = "public-demo"

    # 开发环境账号密码登录（供小程序 dev 模式，生产应关闭）
    allow_dev_login: bool = True

    # 登录防暴力尝试（所有账号密码登录的门共用，规则见 app/services/login_throttle.py）。
    # 万一误伤（比如整个办公室被锁），.env 里置 false 重启即关
    login_throttle_enabled: bool = True

    # 群控调度中心：执行端离线判定阈值（秒），超过未心跳视为掉线（供巡检任务用）
    gc_heartbeat_timeout_seconds: int = 90

    # ── 群控（groupcontrol-server :8100，真机自动化）：上下架/待发货 ──
    # 店铺 = gc 账号镜像(gc_bridge.shop_sync.sync_gc_shops 自动同步),ERP 按 SaleShop.gc_account_id 解析。
    gc_server_base_url: str = "http://127.0.0.1:8100"
    # 总开关：关闭时上架/下架接口直接报错（无回退链路）。
    gc_publish_enabled: bool = False
    # 发布是否真点「发布」（False=只填不发，真机联调期先 dry-run）。
    gc_publish_confirm: bool = False
    # 链接焕新：在架满 7 天没卖掉的链接删掉重发（老板 2026-10-13 定）。每天由 systemd timer
    # 跑一次 scripts/run_listing_refresh.py，几点跑看 timer。「几天算老、一个号一天焕新几条、
    # 买家在聊的先不动」在群控的 .env（LISTING_REFRESH_*），这边只判货还在不在库、现组发布内容。
    listing_refresh_enabled: bool = False

    # ── 入库后自动上架流水线（解析 SPU → 行情定价 → 等议价 → 下发群控）──────────
    # 总开关：关闭则入库不登记、worker 不推进（已登记的行原地不动，随时可再开）。
    auto_listing_enabled: bool = False
    # worker 轮询间隔（秒）。阶段推进本身很轻，主要成本在等行情/等议价，不必太密。
    auto_listing_interval_seconds: int = 60
    # 单轮最多推进多少行，防止一次把库和群控打满。
    auto_listing_batch_size: int = 50
    # 没有验货实拍图时，按解析出的 SPU 文生图补一张上架图。
    # 走的是 AI 重绘那套供应商，只有 apinebula 支持文生图（alapi 必须给参考图）。
    auto_listing_generate_images: bool = True
    # 文生图提示词模板，{spu} 会被替换成解析出的「品牌 型号」。
    auto_listing_image_prompt: str = (
        "电商白底商品主图：{spu}。正面 45 度视角，产品居中占画面八成，纯白背景，"
        "柔和影棚布光，真实产品摄影质感，高清，无文字、无水印、无人物"
    )

    # ALAPI（gpt-image-2 重绘，异步任务流水线）
    alapi_token: str = ""
    alapi_base_url: str = "https://v3.alapi.cn"

    # apinebula（gpt-image-2，OpenAI 兼容图像接口，同步返回 base64）
    # 文生图 /v1/images/generations，图生图 /v1/images/edits。密钥放 .env，勿提交。
    apinebula_api_key: str = ""
    apinebula_base_url: str = "https://apinebula.ai/v1"
    apinebula_model: str = "gpt-image-2"

    # AI 重绘供应商：alapi（异步任务）或 apinebula（OpenAI 兼容同步）。
    # 改 .env 的 REDRAW_PROVIDER 切换，无需改代码。
    redraw_provider: str = "alapi"

    # 图片爬虫（product-image-service，京东云，公网 http://127.0.0.1:8000）
    # 按 SPU 搜同款图，员工在它的 /employee 页审过后转存一张当 AI 重绘的参考图。
    # 令牌 = 它 .env 里的 EMPLOYEE_ACCESS_TOKEN（走 cookie employee_access）。两项都填才启用。
    product_image_base_url: str = ""
    product_image_token: str = ""

    # 去闲鱼水印的补图放京东云跑（11-10 用户定；本机 7G 内存放不下 LaMa）：
    # ERP 照旧取图、存图、写记录，只把图片字节交给它补。地址如 http://127.0.0.1:8000，
    # 令牌 = 京东云 stacks/dewatermark/.env 的 DEWATERMARK_TOKEN。不填就在本机跑（要装 requirements-dewatermark.txt）。
    dewatermark_remote_url: str = ""
    dewatermark_remote_token: str = ""

    # 阿里云市场 69码（商品条码）查询（快鸟 icode，cmapi00067757）
    # 简单身份认证用 AppCode，放 .env，勿提交。
    barcode_query_appcode: str = ""
    barcode_query_base_url: str = "https://icode.market.alicloudapi.com"

    # 支付宝开放平台（公钥模式，RSA2）
    alipay_app_id: str = ""
    # 应用私钥：PKCS8 格式，可填单行 base64 或带 -----BEGIN----- 的 PEM
    alipay_app_private_key: str = ""
    # 支付宝公钥：开放平台「应用信息-接口加签方式」里复制的支付宝公钥（不是应用公钥）
    alipay_public_key: str = ""
    alipay_gateway: str = "https://openapi.alipay.com/gateway.do"
    alipay_sign_type: str = "RSA2"
    alipay_notify_url: str = ""
    # 商户 PID（2088 开头）。用于校验回调/查单里的 seller_id 确实是本商户，防跨商户串单。
    # 留空则跳过该校验并打 warning，正式收款前务必填。
    alipay_seller_id: str = ""
    # 自提收款码用哪个产品出码：
    #   wap       = 手机网站支付(alipay.trade.wap.pay)，把签名后的收银台 URL 编成二维码。
    #               企业已开通即可用，无需另行签约。
    #   precreate = 当面付(alipay.trade.precreate)，支付宝原生收款码，体验最好，需签约「当面付」。
    # 两种模式下的通知验签、查单、金额校验、幂等出库、过期清扫完全一致，切换只影响出码这一步。
    alipay_pickup_mode: str = "wap"
    # 二维码里放的地址。留空则直接编码支付宝长 URL（码很密、难扫，但扫码后无中间页）；
    # 填成本服务公网前缀（如 http://127.0.0.1:8000）则编码短跳转链，码清爽但可能多一次提示页。
    # 仅 wap 模式生效。
    alipay_pay_redirect_base: str = ""
    # 接口内容加密 AES 密钥（base64）。开放平台「接口内容加密方式」开启后必填：
    # 请求 biz_content 会被 AES 加密并带 encrypt_type=AES，响应也为密文。留空则不加密。
    alipay_encrypt_key: str = ""
    # 大台账对账：企业支付宝第三方应用授权的回调地址，要和开放平台应用里填的「授权回调地址」一字不差
    ledger_alipay_auth_redirect: str = "http://127.0.0.1:8000"
    # 授权令牌加密密钥（任意长字符串）；留空则由 jwt_secret 派生。生产应单独配，且不能随手换（换了旧令牌解不开）
    ledger_secret_key: str = ""
    # 密码库主密钥：64 位十六进制（openssl rand -hex 32）。只放 .env，老板离线另存一份；丢了库里的密码全解不开，
    # 换了旧的也解不开。留空 = 密码库存不了也看不了
    ledger_vault_kek: str = ""
    # 密码库主人（能看明文的人）的工号，逗号分隔。故意不做成页面上能改
    ledger_vault_owners: str = ""

    # 采购入站 webhook（外部采购服务 → 本 ERP 推送采购数据）
    # HMAC-SHA256 共享密钥；生产放 .secrets，勿提交。留空则拒收所有请求。
    purchase_webhook_secret: str = ""
    # 备用密钥：轮换过渡期用，新旧任一验签通过即可。轮换完成后清空。
    purchase_webhook_secret_prev: str = ""
    # 时间戳容忍窗口（秒），防重放；请求头 X-Webhook-Timestamp 与服务器时间之差超过则拒收。
    purchase_webhook_tolerance_seconds: int = 300
    # 总开关：关闭后 /ingest 直接 503（不影响管理端查询）。
    purchase_webhook_enabled: bool = True

    # 沙箱临时开关：自提扫码收款不走真实支付，生成收款单后直接判为成功并出库
    # （沙箱无法真正完成支付，先不打断流程；改为必须上传至少 1 张成交凭证作为留证）
    # 上正式环境前务必改回 false
    pickup_payment_auto_success: bool = False

    # ── 只读 MCP 服务（供外部协作开发者接入，列接口 + 查库，仅读）────────────────
    # 总开关：关闭后 /mcp 直接 404，不加载 MCP 依赖。
    mcp_enabled: bool = False
    # 接入密钥（Bearer）。留空则即使 enabled 也拒绝所有请求（防误开裸奔）。放 .secrets，勿提交。
    mcp_api_key: str = ""
    # 查库用的**只读** MySQL 连接串（专用只读账号，只授了 SELECT）。
    # 留空则回退到主 database_url（不推荐：等于用可写账号，仅靠代码护栏兜底）。
    mcp_database_url: str = ""
    # 单次查询最多返回行数，防止把整表拉爆。
    mcp_query_max_rows: int = 1000
    # 允许的 Host 白名单(逗号分隔)，用于 MCP 传输层 DNS-rebinding 防护。
    # 例：service.example.invalid。留空则关闭该防护(已有 Bearer 强鉴权兜底)。
    mcp_allowed_hosts: str = ""

    # ── OA/台账 MCP 数据推送（本 ERP 作 MCP **客户端**，把数据推给外部 OA/台账系统）──────
    # 总开关：关闭则所有入队/投递全部跳过，业务无感（灰度/回退用）。
    oa_push_enabled: bool = False
    # OA 的 MCP 端点(Streamable HTTP)，如 http://host:8080/mcp。留空视为未配置→跳过推送。
    oa_mcp_url: str = ""
    # 接入密钥，放入请求头 X-Mcp-Api-Key。放 .env/.secrets，勿提交。留空则即使 enabled 也不推。
    oa_mcp_api_key: str = ""
    # 推送来源系统标识(幂等键前缀/OA 侧 sourceSystem)。
    oa_push_source_system: str = "erp"
    # 单条 outbox 最大重试次数，超过标 FAILED。
    oa_push_max_attempts: int = 8
    # 调用 OA MCP 的超时(秒)。
    oa_push_timeout_seconds: int = 15
    # KPI 月目标(JSON 串)：{"role:SALES": 100000, "staff:<uuid>": 120000}。无目标者跳过该 KPI。
    oa_kpi_targets: str = ""

    # ── 员工工作台（妙搭）免登录进 H5（见 services/miaoda_entry.py）──────
    # 工作台 iframe 带一次性 entry_token 打开 H5，本服务拿它去这里换员工身份。
    erp_bridge_verify_url: str = "https://jcn8yz7sgrhq.feishuapp.com/app/app_17f07m6338x/openapi/erp/verify"
    # 工作台发的 key（名为 erp-bridge-verify，只授权 verify 这一条路由）。只放 .env，勿提交、勿下发浏览器。
    # 留空则工作台进入回 503，H5 照常走账号密码登录。
    erp_bridge_api_key: str = ""
    # 反方向：工作台服务端调 ERP 只读计数用的 key（routers/miaoda.py，Bearer）。只认 /api/miaoda/ 下的
    # 接口，别的接口照常要员工登录。留空则那些接口回 503。只放 .env，勿提交。
    miaoda_api_key: str = ""
    # ── 个人 API Key（wk_ 前缀，工作台「我的 → API Key」签发）：全系统个人通行证 ──────────────
    # ERP 收到 wk_ 开头的 Bearer 就去这里换身份（见 services/wk_verify.py、deps.get_current_user）。
    # 只读通道：wk_ 来的非 GET 请求一律 403。verify 端点要系统级 key（工作台 .env 的
    # APIKEY_VERIFY_API_KEYS 里名为 erp 的那把），只放 .env，勿提交、勿下发浏览器。留空则 wk_ 一律 401。
    workbench_verify_url: str = "http://127.0.0.1:8000"
    workbench_verify_key: str = ""

    # ── 统一登录：ERP 当账号来源（OIDC 提供方，见 services/oidc_provider.py）──────────────
    # Authentik（id.panasia.fun）把 ERP 配成登录源，员工在统一登录页点「ERP 账号」，到 ERP 的页面输
    # ERP 账号密码。总开关关着时 /api/oidc/* 一律 404；开了但下面没配齐，接口回 503、启动日志写清缺什么。
    oidc_enabled: bool = False
    # 发行方，也是各端点的前缀。nginx 已经把 /api/ 转给本服务，例：http://127.0.0.1:8000
    oidc_issuer: str = ""
    # 登记的客户端（就是 Authentik 那个登录源）。secret 至少 24 位（openssl rand -hex 24），只放 .env
    oidc_client_id: str = ""
    oidc_client_secret: str = ""
    # 只认这里登记过的回调地址（逗号分隔，逐字比对），例：http://127.0.0.1:8000
    oidc_redirect_uris: str = ""
    # 签 id_token 的 RSA 私钥（PEM，≥2048 位）。优先读文件；也可以直接把 PEM 填进 OIDC_SIGNING_KEY（换行写成 \n）。
    # 没有不会自动生成：openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out oidc-signing.pem
    oidc_signing_key_file: str = ""
    oidc_signing_key: str = ""

    # ── 统一登录：ERP 员工 → Authentik 的同步（scripts/run_authentik_sync.py，见 services/authentik_sync.py）──
    # 建号、改名、停用、组成员都从 ERP 推过去。开关关着时只能 --dry-run 预演，不改 Authentik。
    authentik_sync_enabled: bool = False
    authentik_url: str = "http://127.0.0.1:8000"
    # Authentik 的 API token（服务账号建的，Bearer）。只放 .env，勿提交。
    authentik_api_token: str = ""
    # 同步建的号都放在这个路径下，同步只认「这个路径 + attributes.erp_sub」的号，别的号一律不碰
    authentik_user_path: str = "erp"
    authentik_timeout_seconds: float = 15.0
    # 「能进哪些系统」（services/authentik_access.py）：按平台分组在统一登录的应用上加减绑定，跟着上面的同步一起跑。
    # 关着时真跑跳过这一段，预演照样算出会改什么。打开前先在 Authentik 建好两条策略、给服务账号补权限（见接入说明第七节）。
    authentik_access_sync_enabled: bool = False

    # ── 统一登录：ERP 员工 → Frappe（hr.panasia.fun）的开号和角色（scripts/run_frappe_sync.py，见 services/frappe_sync.py）──
    # 按平台分组给 Frappe 角色（后台「统一登录」页配），停用的人在 Frappe 里也停。开关关着时只能 --dry-run 预演。
    frappe_sync_enabled: bool = False
    frappe_sync_url: str = "http://127.0.0.1:8000"
    # Frappe 里给同步专门建的 API 用户的 key / secret（Authorization: token key:secret）。不能是 Administrator 的：
    # 同步靠「号是这个 API 用户建的」认自己的号。只放 .env，勿提交。
    frappe_sync_api_key: str = ""
    frappe_sync_api_secret: str = ""
    frappe_sync_timeout_seconds: float = 20.0

    # ── 禅道（zentao.panasia.fun）按 ERP 账号认人（routers/zentao_link.py）──
    # 禅道服务器拿这个 token 来问「这个员工 ID / 钉钉 userid 是 ERP 的谁、还在不在职、是不是管理员」。
    # 空着接口回 404。只放 .env，勿提交；禅道那边存在 /opt/zentao/dingtalk/erp-link.json。
    zentao_link_token: str = ""


settings = Settings()
