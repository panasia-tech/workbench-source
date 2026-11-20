from decimal import Decimal

from pydantic import BaseModel, Field


class TemplateStep(BaseModel):
    key: str = Field(description="检查项标识，同一规范内不重复")
    title: str = Field(description="检查项名称")
    guide: str | None = Field(default=None, description="怎么验")
    need_photo: bool = Field(default=False, description="这一项是否必须拍照")
    video_url: str | None = Field(default=None, description="这一步的操作教程视频(OSS)")
    standard: str | None = Field(default=None, description="判定标准:合格/不合格示例、必须提交的材料")


class TemplateIn(BaseModel):
    name: str = Field(description="规范名称")
    category: str = Field(description="品类")
    brand: str | None = Field(default=None, description="品牌，空=整个品类")
    model: str | None = Field(default=None, description="型号，空=整个品牌")
    keywords: list[str] = Field(default_factory=list, description="商品名含这些词算这个品类")
    steps: list[TemplateStep] = Field(description="检查项")
    enabled: bool = Field(default=True, description="是否启用")


class CheckStart(BaseModel):
    template_id: str | None = Field(default=None, description="指定规范，空=自动匹配")


class CheckItemUpdate(BaseModel):
    defect_part: str | None = Field(default=None, max_length=64, description="不通过时:瑕疵部位")
    seller_claim: str | None = Field(default=None, max_length=255, description="不通过时:卖家原来怎么描述的")
    result: str = Field(description="PASS=通过 / FAIL=不通过 / UNTESTABLE=无法测试")
    note: str | None = Field(default=None, description="说明；无法测试时写原因")
    evidence: list[str] = Field(default_factory=list, description="这一项的照片或视频")
    disclosed: bool | None = Field(default=None, description="不通过时：卖家原来说过这个问题（不算新问题）")
    cause: str | None = Field(default=None, description="不通过时：seller 卖家没说清 / transport 运输造成 / unknown 待判")


class EvidenceIn(BaseModel):
    kind: str = Field(description="UNBOX_VIDEO=开箱视频 / PRODUCT_PHOTO=商品照 / DEFECT_PHOTO=瑕疵照")
    url: str = Field(description="OSS 地址")
    item_key: str | None = Field(default=None, description="关联的检查项")
    duration_seconds: int | None = Field(default=None, description="视频时长")
    size_bytes: int | None = Field(default=None, description="文件大小")
    device_label: str | None = Field(default=None, description="摄像头名称")
    started_at: str | None = Field(default=None, description="开始录的时间(ISO,浏览器本地时间带时区)")
    interrupted: bool = Field(default=False, description="录制中断(设备断开/出错/关页后补传)")
    gap_note: str | None = Field(default=None, max_length=255, description="中断原因")


class ExceptionIn(BaseModel):
    exception_type: str = Field(description="DAMAGED=坏货 / MISMATCH=货不对版 / OTHER=其他")
    description: str = Field(description="异常情况")


class PurchaserEvidenceIn(BaseModel):
    evidence: list[str] = Field(description="首轮凭证")
    note: str | None = Field(default=None, description="说明")


class ExceptionProgress(BaseModel):
    reject_status: str | None = Field(default=None, description="PENDING / REJECTED / RETURNING / RETURNED / NOT_NEEDED")
    return_tracking_no: str | None = Field(default=None, description="退回运单号")
    return_carrier: str | None = Field(default=None, description="退回承运方(快递公司)")
    return_station: str | None = Field(default=None, description="退回的目标发件网点")
    return_logistics: str | None = Field(default=None, description="退回运输 IN_TRANSIT 在途 / ABNORMAL 异常 / SIGNED 网点已签收")
    return_sign_evidence: list[str] | None = Field(default=None, description="网点签收凭证(追加)")
    refund_status: str | None = Field(default=None, description="PENDING / APPLIED / ACCEPTED / PARTIAL / RECEIVED / DENIED / NOT_NEEDED")
    refund_amount: Decimal | None = Field(default=None, description="实际退款金额")
    refund_fee: Decimal | None = Field(default=None, description="已发生的扣费(运费等)")
    refund_shortfall_reason: str | None = Field(default=None, description="不足额/费用争议的原因和复核结果")
    note: str | None = Field(default=None, description="处理说明")


class ExceptionClose(BaseModel):
    final_result: str = Field(description="最终结果")


class SettingsIn(BaseModel):
    full_check_required: bool = Field(description="有规范的商品必须逐项验完")
    outbound_review_required: bool = Field(description="寄出前必须出库复核")
    return_recheck_required: bool = Field(default=False, description="客户退回的货入库前必须复验")


class ReviewItemCheck(BaseModel):
    item_key: str = Field(description="入库检查项 key")
    status: str = Field(description="SAME=和入库时一样 / WORSE=更严重 / FIXED=已修好 / NEW=新出现的问题")


class ReviewIn(BaseModel):
    remark: str | None = Field(default=None, description="复核说明")
    result: str = Field(default="OK", description="OK=核对无误 / PROBLEM=发现新问题(拦住出库,处理后重新复核)")
    identity_code: str | None = Field(default=None, max_length=64, description="扫或输的货号/序列号,核对实物身份")
    media: list[str] = Field(default_factory=list, max_length=9, description="当前货况照片")
    # 入库瑕疵逐项比对（禅道 WH10-03）：不通过/无法测试的项都要勾；WORSE/NEW 必须走 PROBLEM
    item_checks: list[ReviewItemCheck] = Field(default_factory=list, description="入库瑕疵与当前货况比对")


class RecheckItemIn(BaseModel):
    result: str = Field(description="PASS / FAIL / UNTESTABLE")
    note: str | None = Field(default=None, max_length=500)
    evidence: list[str] = Field(default_factory=list, max_length=9)


class RecheckFinishIn(BaseModel):
    result: str = Field(description="OK 和入库时一致 / PROBLEM 发现问题")
    note: str | None = Field(default=None, max_length=500)
    media: list[str] = Field(default_factory=list, max_length=9, description="复验时的货况照片")
