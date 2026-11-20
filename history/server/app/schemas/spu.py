from pydantic import BaseModel, Field

from app.schemas._tz import CNDatetime


# ---------- SPU 下挂的 SKU 编码 ----------
class SpuSkuOut(BaseModel):
    id: str = Field(description="主键 ID")
    spu_id: str = Field(description="所属 SPU ID")
    sku_code: str = Field(description="仓库/WMS 侧 SKU 编码(全局唯一)")
    placeholder_reason: str | None = Field(
        default=None, description="编码可疑的原因(临时码/占位数字/写成商品名等);正常编码为 null"
    )
    note: str | None = Field(description="备注")
    created_at: CNDatetime = Field(description="创建时间")

    model_config = {"from_attributes": True}


class SpuSkuAdd(BaseModel):
    """给某个 SPU 追加 SKU 编码。支持一次贴多行(换行/逗号/空格分隔)。"""

    sku_codes: list[str] = Field(min_length=1, description="SKU 编码列表;已存在于本 SPU 的自动跳过")
    note: str | None = Field(default=None, max_length=255, description="统一备注(选填)")


class SpuSkuUpdate(BaseModel):
    sku_code: str | None = Field(default=None, min_length=1, max_length=64, description="SKU 编码")
    note: str | None = Field(default=None, max_length=255, description="备注")
    spu_id: str | None = Field(default=None, description="改挂到别的 SPU(挂错款时纠错用)")


# ---------- SPU 主表 ----------
class SpuCreate(BaseModel):
    spu_code: str = Field(min_length=1, max_length=64, description="SPU 编码(唯一)")
    brand: str = Field(min_length=1, max_length=64, description="品牌")
    model: str | None = Field(default=None, max_length=128, description="型号")
    spec: str | None = Field(default=None, max_length=128, description="配置/地区后缀(影响报价,如 8+256G 国行)")
    enabled: bool = Field(default=True, description="是否启用")
    note: str | None = Field(default=None, max_length=255, description="备注")
    sku_codes: list[str] = Field(default_factory=list, description="同时挂上的 SKU 编码(选填)")


class SpuUpdate(BaseModel):
    spu_code: str | None = Field(default=None, min_length=1, max_length=64, description="SPU 编码(唯一)")
    brand: str | None = Field(default=None, min_length=1, max_length=64, description="品牌")
    model: str | None = Field(default=None, max_length=128, description="型号")
    spec: str | None = Field(default=None, max_length=128, description="配置/地区后缀(影响报价,如 8+256G 国行)")
    enabled: bool | None = Field(default=None, description="是否启用")
    note: str | None = Field(default=None, max_length=255, description="备注")


class SpuOut(BaseModel):
    id: str = Field(description="主键 ID")
    spu_code: str = Field(description="SPU 编码(唯一)")
    brand: str = Field(description="品牌")
    model: str | None = Field(description="型号")
    brand_model: str = Field(description="「品牌+型号」展示名(拼接得到,不落库)")
    spec: str | None = Field(default=None, description="配置/地区后缀")
    enabled: bool = Field(description="是否启用")
    note: str | None = Field(description="备注")
    sku_count: int = Field(description="已挂 SKU 编码数")
    real_sku_count: int = Field(description="其中的正式编码数(排除临时码/占位数字/商品名)")
    skus: list[SpuSkuOut] = Field(default_factory=list, description="已挂 SKU 编码明细")
    created_at: CNDatetime = Field(description="创建时间")
    updated_at: CNDatetime = Field(description="更新时间")

    model_config = {"from_attributes": True}


class SpuPage(BaseModel):
    items: list[SpuOut] = Field(description="当前页 SPU 列表")
    total: int = Field(description="总条数")


# ---------- 按 SKU 编码反查 ----------
class SpuLookupOut(BaseModel):
    """按 SKU 编码反查所属 SPU。找不到时 matched=false，其余字段为空。"""

    sku_code: str = Field(description="查询用的 SKU 编码")
    matched: bool = Field(description="是否命中对照表")
    spu_code: str | None = Field(default=None, description="命中的 SPU 编码")
    brand: str | None = Field(default=None, description="品牌")
    model: str | None = Field(default=None, description="型号")
    brand_model: str | None = Field(default=None, description="「品牌+型号」展示名")
    spu_id: str | None = Field(default=None, description="命中的 SPU ID")


# ---------- 待补编码清单 ----------
class SpuPendingOut(BaseModel):
    """仓库侧还没给出正式编码的款：一个可用编码都没有（挂了临时码/商品名也算没有）。"""

    spu_code: str = Field(description="SPU 编码")
    brand_model: str = Field(description="「品牌+型号」展示名")
    sku_count: int = Field(description="已挂编码数(全是不可用的)")
    codes: list[str] = Field(description="当前挂着的编码")
    reasons: list[str] = Field(description="每个编码对应的可疑原因")


# ---------- 导入结果 ----------
class SpuImportResult(BaseModel):
    total: int = Field(description="文件内有效数据行(SPU-SKU 对;无 SKU 列时为 SPU 行数)")
    spu_created: int = Field(description="新建 SPU")
    spu_updated: int = Field(description="更新已有 SPU")
    sku_created: int = Field(description="新挂 SKU 编码")
    sku_moved: int = Field(description="原挂在别的 SPU、本次改挂过来的 SKU 编码")
    sku_skipped: int = Field(description="已存在且归属不变、无需改动的 SKU 编码")
    spu_deleted: int = Field(default=0, description="覆盖导入时被删除的 SPU(连同其 SKU 对应)")
    sku_deleted: int = Field(default=0, description="覆盖导入时被删除的 SKU 对应")
    warnings: list[str] = Field(default_factory=list, description="导入过程中的可疑行提示(不阻断)")
    changes: list[str] = Field(default_factory=list, description="会改动已有数据的地方:品牌型号/配置被覆盖、编码改挂、删除;预览时先给人看")
    dry_run: bool = Field(default=False, description="true=只预览,什么都没写")
