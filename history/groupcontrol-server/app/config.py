import os

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """群控调度中心配置。默认读 .env；本地 dev 用 SQLite，生产切 MySQL + EMQX 真参数。"""

    model_config = SettingsConfigDict(
        env_file=os.getenv("ENV_FILE", ".env"), env_file_encoding="utf-8", extra="ignore"
    )

    port: int = 8100  # 避开 ERP 主服务 8000

    # dev 默认 SQLite 单文件，零依赖跑通链路；生产设 mysql+pymysql://...
    database_url: str = "sqlite:///./gc.db"

    # EMQX 连接（后端桥以“超级用户”身份连，用于订报表/发指令）
    mqtt_host: str = "127.0.0.1"
    mqtt_port: int = 1883
    mqtt_backend_username: str = "gc-backend"
    mqtt_backend_password: str = "gc-backend-secret"

    # EMQX HTTP 鉴权钩子会带这个共享密钥（可选，置空则不校验来源）
    emqx_hook_secret: str = ""

    jwt_secret: str = ""   # 与主 ERP 同一密钥(HS256),生产经 env/.secrets 注入;验小程序带来的登录令牌

    # app enroll(HTTP 引导)共享密钥:app POST /api/gc/enroll 须带同值;为空则拒发(403),
    # 姿势对齐 jwt_secret「空则拒验」——未配置时不放行匿名 enroll。
    gc_enroll_secret: str = ""
    # 群控鉴权第二步(2026-10-06):守护端/行情台在用的运维接口(任务、执行单元、账号、
    # 设备列表、补设备信息)是否强制员工令牌。先以 False 上线——不带令牌照常放行但记
    # 日志,看清还有哪台守护端没登录;都登上了再在 .env 写 OPS_AUTH_ENFORCED=true 重启,
    # 不用发版;出了岔子改回 false 即可。
    ops_auth_enforced: bool = False

    # 个人 API Key(wk_ 前缀,工作台签发)链式验证(见 app/personal_key.py):
    # 收到 wk_ 开头的 Bearer 就转发给 ERP /api/auth/me 换员工身份(role 是 ERP 员工角色),
    # 不直接调工作台——gc 的权限模型全是 ERP 角色,链式一步拿到,免角色映射、免配新密钥。
    erp_auth_me_url: str = "http://127.0.0.1:8000"

    # ---- 调度循环参数 ----
    dispatch_interval_sec: float = 3.0       # Dispatcher 扫描间隔
    watchdog_interval_sec: float = 15.0      # Watchdog 扫描间隔
    aging_interval_sec: float = 300.0        # Aging 扫描间隔(5min)
    # 单流程任务超时(RUNNING 超过即判失败收尸)。
    # 300s 会误杀发布：实测一条发布 9 步真机耗时就要 330s+（闲鱼 AI 生成描述要等、
    # 每个原语都含 MQTT 往返 + 服务端 OCR），再加发布后回读标题还要多导航一趟。
    # 更麻烦的是收尸只是服务端放弃，**设备上的流程仍在继续跑**，于是「服务端判失败、
    # 商品其实发出去了」——账实不符还会诱发重复铺货。宁可给足时间，让流程自己收尾。
    task_timeout_sec: int = 900
    # PENDING 超龄清理:超过 12 小时还没派出去的任务(账号冻结/设备长期离线/账号已删)自动取消。
    task_pending_max_age_sec: int = 12 * 3600
    # DISPATCHED 卡死清理:已发首帧但设备始终没接,超过 1 小时自动取消。
    task_dispatched_max_age_sec: int = 3600
    # 流程级硬超时(线程自杀):超过即让流程线程自己抛 FlowTimeout 退出。
    # 与 task_timeout_sec 的区别:watchdog 收尸只改 DB,杀不掉挂死的线程——挂死流程
    # 会无限重试 RPC,线程+连接+截图对象堆积,数小时后把 gc-api 撑到 OOM(08-06 实测)。
    # 600s > 发布全流程实测上限(~500s 含回读),不误伤正常单。
    # 08-30:开动作留痕(gc_trace_actions)后每动作 +1~1.5s 截图,全流程会超过 600 → 放宽到 900。
    flow_hard_timeout_sec: int = 900
    # 动作留痕开关:每个动作原语执行后截一帧 + 记一条动作日志(trace/<task>/ 下,actions.json 索引)。
    # 排查「点了没反应/点错了」类问题的现场证据;截图有约 1/s 节流,全流程会慢 ~1-2 分钟,平时可关。
    gc_trace_actions: bool = True
    # 这些任务类型不截图留痕(逗号分隔)。chat_scan 一天几百单、只读,留痕每个动作要多截一张图
    # 传 OSS,一轮扫描拖慢十几秒,新消息进库就跟着晚。要排查扫描问题时把它从这里去掉
    gc_trace_skip_task_types: str = "chat_scan"
    flow_pool_size: int = 100                # 流程并发上限(有界线程池;实际同时活跃≤在线设备数,每账号仍受30s节流+日配额+作息窗)
    op_min_interval_sec: float = 30.0        # 同账号两次操作最小间隔(反风控节流)
    # 聊天扫描周期(chat_scan job 建单间隔)。2026-08-18 由 120s 拉长到 300s:每轮 read_chats 都要
    # 强杀+冷启动一次闲鱼(flow/ready.py 范式),而生产日志里绝大多数轮次是「未读 0 行,本轮进 0」——
    # 白跑一趟却把设备状态重置一遍,跟人工操作和长流程(发布一单几十秒~几分钟)频繁互撞。
    chat_scan_interval_sec: int = 300
    # 保活 + 登录体检(B4.1 同款,见 flow/web/keepalive_web.py):浏览器号闲着超过这么久就开一次闲鱼首页,
    # 掉了先点「快速进入」自救,救不了冻号叫人。不受作息窗口限制——夜里过期也要在早上第一单之前发现。
    # 白天消息巡检每 5 分钟本就在开页面,号不闲,基本轮不到它;主要跑在夜里。
    keepalive_enabled: bool = True
    keepalive_interval_sec: int = 600
    # 浏览器号判掉登录后先不叫人:这段时间内每 3 分钟派保活再救(刷新 + 快速进入),还没登回才通知
    login_lost_notify_grace_sec: int = 1800
    login_lost_retry_interval_sec: int = 180
    # 售出巡检(flow/web/sold_scan_web.py):浏览器号定时读个人中心「已售出」,按 item_id 在详情页确认后
    # 把卖掉的在架账本标 SOLD,ERP sold_sync 接着锁库存、下架别的号上的同款。网页版聊天页的商品卡没有标题,
    # chat_scan 那条在浏览器号上从没对上过一单(2026-10-17 生产核实)。只读:只点 tab、只开详情页。
    # 受账号作息窗口限制(夜里下架作业也不派,夜里查出来也只能等早上)。关掉:.env 写 SOLD_SCAN_ENABLED=false 重启。
    sold_scan_enabled: bool = True
    sold_scan_interval_sec: int = 1800
    sold_scan_max_confirm: int = 5            # 单轮最多开几个详情页确认,其余下一轮
    # 50 秒未回复自动兜底(M1)。会上定的阈值就是 50s——平台把回复率算进考核。
    # 兜底建的是普通 chat_reply 任务,照样过 op_min_interval_sec 反风控节流,
    # 所以「到点」不等于「立刻发出」。
    #
    # ⚠️ 默认**关闭**。这个开关一旦打开就会自动给真实买家发消息——会真的出现在
    # 别人的聊天窗口里,撤不回来。这类副作用必须是有人明确点头才发生的,不能
    # 因为代码部署上去就默默开始发。上线前先用 GET /api/gc/chat/overdue 看一段
    # 时间:确认判定命中的确实是该兜底的会话,再把它打开。
    # 消息门铃(M2):执行端常驻 /im 看到未读上涨 → 立刻建一单 chat_scan,不等下一轮周期。
    # 这条链路**只是把扫描提前**,不新增任何对外动作(不发消息、不点页面),所以默认开。
    # 关掉只是退回 chat_scan_interval_sec 的周期粒度,功能不缺、只是慢。
    # 远程取回来的日志包落在哪。默认 ./logs_inbox，与截图证据同一套思路（本地目录即可，
    # 不必上 OSS：日志是排障用的临时产物，看完就该删）。
    log_inbox_dir: str = "./logs_inbox"
    chat_hint_enabled: bool = True
    # 同账号两次门铃建单的最小间隔。在途 chat_scan 本就去重(jobs.create_chat_scan),
    # 这道只是防执行端异常刷帧把任务表刷满。
    chat_hint_min_interval_sec: float = 20.0
    # ---- 链接焕新(在架满 N 天没卖掉就删掉重发,jobs.create_refresh_listing)----
    # 开关和每天几点跑在 ERP(LISTING_REFRESH_ENABLED + systemd timer):挑单子、给发布内容是它的事。
    # 这里只管「哪些链接算该焕新、一天焕新几条」。
    listing_refresh_min_age_days: int = 7       # 老板定的:一个链接 7 天没卖掉就删掉重发
    # 每个号每天最多焕新几条。重发也是一次发布,和当天新入库的货抢同一份日发布配额(默认 100),
    # 焕新把配额吃光的话新货就发不出去。超出的按「最老的先」排到第二天。
    listing_refresh_per_account_daily: int = 100   # 11-06 用户定:10 太低,开到 100(实际还受账号日发布配额管)
    # 最近这么多小时有买家来问过的链接先不删:买家手里是旧链接,一删他就下不了单。下一轮再看。
    listing_refresh_buyer_quiet_hours: int = 48
    chat_autoreply_enabled: bool = False
    chat_autoreply_threshold_sec: int = 50
    # 巡检间隔要明显小于阈值,否则平均延迟会把 50s 拖成 50+interval。
    chat_autoreply_interval_sec: float = 15.0
    chat_autoreply_batch_limit: int = 200
    # ---- 聊天里发图片 / 视频(聊天页「+」面板:实拍、相册、拍摄)----
    # ⚠️ 默认**关闭**。网页版聊天框的上传控件还没在真号上摸过(选择器、发不发得了视频都没实测),
    # 打开前先用自己两个号互发测通。关着时接口直接拒,不建单、不碰买家。
    chat_media_enabled: bool = False
    # 网页版 /im 输入框的上传控件(Playwright 选择器,取页面上第一个匹配)。实测后按真实 DOM 改
    chat_media_input_selector: str = 'input[type="file"]'
    # 读聊天时留几份会话页 HTML,用来核对商品卡里到底有什么(0=不留,重启后重新计数)
    chat_html_sample_limit: int = 20
    # ---- 心跳(app HTTP 每 5s 上报;比 MQTT LWT 最慢 3min 快一个数量级,且能识破进程冻结的假在线)----
    heartbeat_scan_interval_sec: float = 5.0  # 后台扫描离线设备的间隔
    heartbeat_timeout_sec: int = 15           # 超过此秒数无心跳即判 OFFLINE(=3×心跳周期,容一次抖动)

    # ---- 新买家消息通知(Server酱→企微通道;聊天接待 1c)----
    serverchan_sendkey: str = ""   # Server酱 SendKey;空=关闭推送。密钥进 env/.secrets,勿入 git
    # 消息响应考核经 ERP 本机内部接口给员工发钉钉/企微（ERP 与群控同机）
    erp_internal_base: str = "http://127.0.0.1:8000"
    # ERP 来的发布(含链接焕新的删和重发)交给执行端之前,回 ERP 再核一次还能不能发(app/erp_precheck.py)。
    # ERP 明确说不能发才取消;ERP 连不上/超时/报错照常发,只记日志——再核本身出故障不卡发布,所以默认开。
    erp_publish_precheck_enabled: bool = True
    erp_publish_precheck_timeout_sec: float = 5.0
    # True：问不到 ERP 就先不发（DEV14 收紧）；False：照旧 fail-open，避免 ERP 宕机卡死全网发布
    erp_publish_precheck_fail_closed: bool = False
    chat_sla_interval_sec: int = 30
    notify_cooldown_sec: int = 300 # 推送冷却窗;免费版每日限额(约5条),必须聚合+冷却
    # ---- 企微应用直发(优先于 Server酱;无每日限额。需企微后台「企业可信IP」加本机公网IP)----
    wecom_corpid: str = ""
    wecom_corpsecret: str = ""
    wecom_agentid: str = ""
    wecom_touser: str = "@all"

    # ---- 服务端 OCR(截图→文字+坐标,供流程引擎锚点定位)----
    # 配置统一走 pydantic settings(从 .env 读);**不要**用 os.getenv——生产 systemd 不注入环境变量。
    # 2026-08-17 起**只有一条路**:远程 GPU OCR 微服务(家用 Windows + RTX 5070,ssh -R 反向隧道)。
    # 已下掉的:石榴/zndjs 付费云 OCR(不再花钱)、服务器本机 RapidOCR(无 GPU + onnxruntime 内存泄漏)。
    # 没有兜底是刻意的,原因与后果见 app/flow/ocr.py 模块 docstring;部署见 win_ocr/README.md。
    gc_ocr_http_url: str = ""             # 必填,例:http://127.0.0.1:8600/ocr;留空则 ocr() 抛错
    gc_ocr_http_token: str = ""           # 弱鉴权 token(请求头 X-OCR-Token),与 Windows 侧同值
    gc_ocr_http_timeout: float = 30.0     # 单次识别 HTTP 超时(秒)
    # 连接级失败重试预算,要盖过 Windows 侧进程重启+CUDA 预热窗口(~5~10s),又别拖长整条流程
    gc_ocr_http_retries: int = 5
    gc_ocr_http_retry_sleep: float = 2.0

    # ---- 截图证据 OSS(可选;未配则存本地 ./shots)----
    oss_endpoint: str = ""
    oss_key: str = ""
    oss_secret: str = ""
    oss_bucket: str = ""
    oss_shot_prefix: str = "gc/shots/"


settings = Settings()
