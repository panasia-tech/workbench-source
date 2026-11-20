from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="MEDIA_", extra="ignore")

    # 对外地址：固定链接、登录回调、本地存储的签名地址都以它为前缀
    base_url: str = "http://127.0.0.1:8095"
    database_url: str = "sqlite:///./data/media.db"

    # 登录会话与本地签名共用的密钥，没配不让启动
    session_secret: str = ""
    session_ttl_hours: int = 12

    # local：文件放 local_root，本服务自己签名、自己出文件（开发和测试用）；oss：私有桶 + 签名地址
    storage: str = "local"
    local_root: str = "./storage"
    # 签名地址有效期。播放页过期后会自己换新地址，这里只决定多久换一次
    sign_ttl_seconds: int = 7200

    oss_endpoint: str = ""
    oss_bucket: str = ""
    oss_access_key_id: str = ""
    oss_access_key_secret: str = ""
    # 桶绑的自定义 HTTPS 域名（例 http://127.0.0.1:8000）。新开的账号用默认域名打开视频会被强制下载
    oss_cname: str = ""
    # 上传：大文件分片并发数和单次请求超时（秒）。家里上行带宽小时并发别开大，不然分片写超时
    oss_upload_threads: int = 2
    oss_timeout_seconds: int = 120
    # 新上传的对象默认存储类型：Standard / IA（低频）
    oss_storage_class: str = "Standard"

    # 统一登录（OIDC）。ERP 是账号来源，登录后带 erp_role 和 groups，受众按这两个判
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: str = ""
    oidc_role_claim: str = "erp_role"
    oidc_groups_claim: str = "groups"

    # 工作台取「培训视频」目录用的服务令牌（GET /api/catalog）；空 = 不开这个接口
    catalog_token: str = ""

    # 费用估算和提醒（mediactl usage）。单价按阿里云 OSS 中国内地按量付费，以实际账单为准
    price_egress_per_gb: float = 0.5  # 外网流出，元/GB
    price_storage_per_gb_month: float = 0.12  # 标准存储（本地冗余），元/GB/月
    alert_monthly_yuan: float = 0  # 本月估算超过这个数就提醒；0 = 不提醒
    alert_webhook: str = ""  # 钉钉群机器人 Webhook 地址
    alert_webhook_secret: str = ""  # 机器人安全设置选「加签」时的密钥

    # 开发登录：/auth/dev-login?role=warehouse 直接发会话，生产必须关
    dev_login: bool = False
    # 这些角色或分组能看所有资料
    admin_roles: str = "admin"

    @property
    def admin_role_set(self) -> set[str]:
        return {r.strip().casefold() for r in self.admin_roles.split(",") if r.strip()}

    @property
    def secure_cookies(self) -> bool:
        return self.base_url.startswith("https://")


@lru_cache
def get_settings() -> Settings:
    return Settings()
