from decimal import Decimal

from pydantic import BaseModel, Field

from app.schemas._tz import CNDatetime


class AssetIntakeIn(BaseModel):
    """资产录入（新建、修改共用）：建库存要的字段 + 群控上架真正用到的字段。

    标题和正文由闲鱼 AI 看图写，不收。
    """

    product_type: str = Field(description="商品类型（后台配的商品种类，缺图时 AI 补图按它出提示词）")
    brand: str = Field(description="品牌")
    model: str = Field(description="型号")
    spec: str | None = Field(default=None, description="配置，如 i5-8500/16G/512G、27寸 2K")
    serial_number: str = Field(description="序列号")
    condition_grade: str = Field(description="成色：95新/9新/85新/8新")
    price: Decimal = Field(description="售价（元），必须大于 0")
    express_fee: Decimal | None = Field(default=None, ge=0, description="运费，不填按一口价 0 元发")
    images: list[str] = Field(default_factory=list, description="商品实拍图 1–9 张，第一张做封面")
    desc: str | None = Field(default=None, description="瑕疵/配件说明，闲鱼 AI 写不出正文时用它兜底")
    cost_price: Decimal = Field(default=Decimal("0"), ge=0, description="成本价，不填按 0")
    source_asset_no: str | None = Field(default=None, description="来源系统里的资产编号，对账用")
    location_code: str | None = Field(default=None, description="库位，选填（不知道就留空，仓管之后补）")
    remark: str | None = Field(default=None, description="内部备注，不给买家看")
    allow_duplicate_source: bool = Field(
        default=False, description="来源资产编号已录过时会 409，前端确认是另一台后置 true 重提"
    )


class AssetIntakeResult(BaseModel):
    sku_code: str = Field(description="生成的货号")
    can_publish: bool = Field(description="录入人能不能直接上架（仓管/销售/管理员），能就给「去上架」")


class AssetIntakeListItem(BaseModel):
    sku_code: str = Field(description="货号")
    product_name: str = Field(description="商品名（品牌 型号）")
    spec: str | None = Field(default=None, description="配置")
    serial_number: str | None = Field(default=None, description="序列号")
    source_asset_no: str | None = Field(default=None, description="来源资产编号")
    price: Decimal | None = Field(default=None, description="售价")
    cover_url: str | None = Field(default=None, description="封面（已签名）")
    status: str = Field(description="pending/listing/on_sale/to_ship/sold/locked/loss/split")
    status_label: str = Field(description="状态文案")
    editable: bool = Field(description="还没上架，录入人可以改")
    entered_by_name: str | None = Field(default=None, description="录入人")
    created_at: CNDatetime = Field(description="录入时间")


class AssetIntakeOut(AssetIntakeListItem):
    product_type: str | None = Field(default=None, description="商品类型")
    brand: str | None = Field(default=None, description="品牌")
    model: str | None = Field(default=None, description="型号")
    condition_grade: str | None = Field(default=None, description="成色")
    express_fee: Decimal | None = Field(default=None, description="运费")
    images: list[str] = Field(default_factory=list, description="商品实拍图（已签名）")
    desc: str | None = Field(default=None, description="瑕疵/配件说明")
    cost_price: Decimal | None = Field(default=None, description="成本价")
    location_code: str | None = Field(default=None, description="库位")
    remark: str | None = Field(default=None, description="内部备注")


class AssetIntakeListResponse(BaseModel):
    items: list[AssetIntakeListItem]
    total: int
    page: int
    size: int
