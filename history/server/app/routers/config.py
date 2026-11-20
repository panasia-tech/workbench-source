from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import get_current_user, require_roles

from app.models import Staff

from app.schemas.config import (
    AppConfigOut,
    ConfigLocationOut,
    ConfigSaleShopOut,
    PurchaseAccountOut,
    PurchaseExampleOut,
)
from app.services.app_config import (
    list_enabled_locations,
    list_enabled_purchase_accounts,
    list_enabled_sale_shops,
)
from app.services.app_settings import PICKUP_ADDRESS, get_setting
from app.services.oss import OssNotConfiguredError
from app.services.purchase_examples import purchase_example_urls



router = APIRouter(prefix="/api/config", tags=["config"])





@router.get("", summary="查询应用基础配置", response_model=AppConfigOut)

def get_app_config(

    db: Session = Depends(get_db),

    _: Staff = Depends(get_current_user),

):

    accounts = [

        PurchaseAccountOut(code=row.code, label=row.label)

        for row in list_enabled_purchase_accounts(db)

    ]

    locations = [

        ConfigLocationOut(code=row.code, zone=row.zone) for row in list_enabled_locations(db)

    ]

    sale_shops = [

        ConfigSaleShopOut(code=row.code, label=row.label, xianyu_user_name=row.xianyu_user_name)

        for row in list_enabled_sale_shops(db)

    ]



    try:
        purchase_examples = PurchaseExampleOut(**purchase_example_urls())
    except OssNotConfiguredError:
        purchase_examples = None

    return AppConfigOut(
        purchase_accounts=accounts,
        locations=locations,
        sale_shops=sale_shops,
        purchase_examples=purchase_examples,
        pickup_address=get_setting(db, PICKUP_ADDRESS),
    )


class McpInfoOut(BaseModel):
    enabled: bool = Field(description="MCP 服务是否启用")
    url: str = Field(description="MCP 接入地址(streamable http)")
    key: str = Field(description="MCP 接入密钥(Bearer);仅 ADMIN 可见")


@router.get("/mcp-info", summary="查询 MCP 接入信息(仅 ADMIN)", response_model=McpInfoOut)
def get_mcp_info(_: Staff = Depends(require_roles())):
    """只读 MCP 的接入信息,供小程序「账号设置 → MCP 与使用说明」页展示。

    require_roles() 空参 = 仅 ADMIN 放行(deps 里 ADMIN 恒过,其余角色全拒)。
    key 是只读账号的 Bearer 密钥,等同只读库凭据,绝不放给非 ADMIN。
    """
    enabled = bool(settings.mcp_enabled and settings.mcp_api_key)
    return McpInfoOut(
        enabled=enabled,
        url="http://127.0.0.1:8000" if enabled else "",
        key=settings.mcp_api_key if enabled else "",
    )


