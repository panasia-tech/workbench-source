from datetime import date
from decimal import Decimal

from pydantic import BaseModel, Field, computed_field

from app.schemas._tz import CNDatetime


# ---------- 管理端：商品 watch list CRUD ----------
class CrawlProductCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128, description="商品展示名(唯一)")
    keyword: str | None = Field(default=None, max_length=128, description="闲鱼实际搜索词;为空则用展示名")
    enabled: bool = Field(default=True, description="是否参与爬取")
    sort_order: int = Field(default=0, description="排序序号")
    note: str | None = Field(default=None, max_length=255, description="备注")


class CrawlProductUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128, description="商品展示名(唯一)")
    keyword: str | None = Field(default=None, max_length=128, description="闲鱼实际搜索词;为空则用展示名")
    enabled: bool | None = Field(default=None, description="是否参与爬取")
    sort_order: int | None = Field(default=None, description="排序序号")
    note: str | None = Field(default=None, max_length=255, description="备注")


class CrawlProductOut(BaseModel):
    id: str = Field(description="主键 ID")
    name: str = Field(description="商品展示名(唯一)")
    keyword: str | None = Field(description="闲鱼实际搜索词;为空则用展示名")
    enabled: bool = Field(description="是否参与爬取")
    sort_order: int = Field(description="排序序号")
    note: str | None = Field(description="备注")
    last_price: Decimal | None = Field(description="最新价(当天有则当天,否则最近一次爬到的)")
    last_price_date: date | None = Field(description="最新价对应日期")
    last_crawled_at: CNDatetime | None = Field(description="最近一次爬取时间")
    created_at: CNDatetime = Field(description="创建时间")
    updated_at: CNDatetime = Field(description="更新时间")

    model_config = {"from_attributes": True}


class CrawlProductPage(BaseModel):
    items: list[CrawlProductOut] = Field(description="当前页商品列表")
    total: int = Field(description="总条数")


class CrawlImportResult(BaseModel):
    total: int = Field(description="文件内有效数据行")
    created: int = Field(description="新建")
    updated: int = Field(description="更新已有")
    skipped: int = Field(description="文件内重名被合并的条数")
    deleted: int = Field(default=0, description="覆盖导入时被删除的旧商品数(连同其历史行情)")


# ---------- 设备端：待爬任务 ----------
class CrawlTaskOut(BaseModel):
    id: str = Field(description="主键 ID")
    name: str = Field(description="商品展示名")
    keyword: str = Field(description="搜索词(已回退处理:keyword 为空时返回 name)")

    model_config = {"from_attributes": True}


# ---------- 设备端：上传行情 ----------
class CrawlPriceUpload(BaseModel):
    """product_id 与 product_name 二选一。

    巡航台的任务来自本机 Excel,没有 ERP 的 product_id,只能按型号名上报;
    按名上报时若监控清单里没有该型号,服务端自动登记一条(enabled=True)。
    """

    product_id: str | None = Field(default=None, description="监控商品 ID;与 product_name 二选一")
    product_name: str | None = Field(
        default=None, description="型号名;与 product_id 二选一。清单中不存在时自动登记"
    )
    crawl_date: date | None = Field(default=None, description="爬取日期;不传则用服务端中国日界今天")
    price: Decimal = Field(
        description="行情价。口径以 raw.source 为准:cleaned_average=清洗后平均挂牌价(巡航台 v0.2+)、"
        "lowest_listing=第一页最低挂牌价(旧爬虫)、近7日成交均价(OCR)"
    )
    trend_delta: Decimal | None = Field(default=None, description="较上周涨跌(跌为负)")
    search_heat: int | None = Field(default=None, description="搜索热度(X 人在搜)")
    raw: dict | None = Field(default=None, description="原始截取文本/搜索词/设备号,便于复核")


# ---------- 设备端：上传行情页截图，服务端 OCR ----------
class CrawlOcrUpload(BaseModel):
    product_id: str = Field(description="监控商品 ID")
    image_base64: str = Field(description="行情页截图(base64,可带或不带 data: 前缀)")
    crawl_date: date | None = Field(default=None, description="爬取日期;不传则用服务端中国日界今天")


# ---------- 历史行情 ----------
class CrawlPriceOut(BaseModel):
    id: str = Field(description="主键 ID")
    crawl_date: date = Field(description="行情日期(中国日界)")
    price: Decimal = Field(description="行情价,口径见 price_basis")
    trend_delta: Decimal | None = Field(description="较上周涨跌(跌为负)")
    search_heat: int | None = Field(description="搜索热度(X 人在搜)")
    created_at: CNDatetime = Field(description="创建时间")
    raw: dict | None = Field(default=None, exclude=True)

    model_config = {"from_attributes": True}

    @computed_field(description="价格口径:成交均价 / 平均挂牌价 / 最低挂牌价;旧数据没记来源为空")
    @property
    def price_basis(self) -> str | None:
        source = (self.raw or {}).get("source")
        return PRICE_BASIS.get(source) if source else None


# 同一张表里混着三种来源,只有闲鱼「行情」页 OCR 那条是平台给的成交均价
PRICE_BASIS = {
    "ocr": "成交均价",
    "cleaned_average": "平均挂牌价",
    "lowest_listing": "最低挂牌价",
}
