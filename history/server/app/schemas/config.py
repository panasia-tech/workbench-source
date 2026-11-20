from pydantic import BaseModel, Field


class PurchaseAccountOut(BaseModel):
    code: str = Field(description="采购账号编码")
    label: str = Field(description="采购账号显示名称")


class ConfigLocationOut(BaseModel):
    code: str = Field(description="库位编码")
    zone: str | None = Field(default=None, description="库区")


class ConfigSaleShopOut(BaseModel):
    code: str = Field(description="店铺编码")
    label: str = Field(description="店铺显示名称")
    xianyu_user_name: str = Field(description="闲鱼用户名")


class PurchaseExampleOut(BaseModel):
    screenshot_url: str = Field(description="采购截图示例URL")
    product_url: str = Field(description="商品链接示例URL")


class AppConfigOut(BaseModel):
    purchase_accounts: list[PurchaseAccountOut] = Field(description="启用的采购账号列表")
    locations: list[ConfigLocationOut] = Field(default=[], description="启用的库位列表")
    sale_shops: list[ConfigSaleShopOut] = Field(default=[], description="启用的销售店铺列表")
    purchase_examples: PurchaseExampleOut | None = Field(default=None, description="采购示例图")
    pickup_address: str = Field(default="", description="聊天「发送仓库位置」发给买家的自提地址；管理员在聊天页里填")
