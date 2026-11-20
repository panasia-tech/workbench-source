from pydantic import BaseModel, Field


class ConfigOption(BaseModel):
    value: int = Field(description="选项值")
    label: str = Field(description="选项显示名")


class ListingFormDefaults(BaseModel):
    stuff_status: int = Field(description="默认成色状态码")
    express_fee: int = Field(default=0, description="默认运费")


class ListingFormConfigOut(BaseModel):
    version: str = Field(description="配置版本号")
    defaults: ListingFormDefaults = Field(description="表单默认值")
    stuff_status_options: list[ConfigOption] = Field(description="成色可选项")
    condition_grade_map: dict[str, int] = Field(description="成色等级到成色码的映射")


class ListingFormConfigVersionOut(BaseModel):
    version: str = Field(description="配置版本号")
