from enum import StrEnum


class StaffRole(StrEnum):
    PURCHASER = "PURCHASER"
    WAREHOUSE = "WAREHOUSE"
    NEGOTIATOR = "NEGOTIATOR"
    BUSINESS = "BUSINESS"  # 业务员：验货异常的拒签、退回发件网点
    SALES = "SALES"
    FINANCE = "FINANCE"
    ADMIN = "ADMIN"
    RFID_DEVICE = "RFID_DEVICE"  # RFID 手持终端设备账号（绑定/盘点）
    CRAWLER = "CRAWLER"  # 闲鱼行情爬虫 APP 设备账号（读取近7日成交均价）
    # 行情工作台（桌面端 seller-pilot）的设备账号。= CRAWLER 的全部读权限
    # + 一条**窄写**：回写商品名/品牌/型号（PATCH /inventory/skus/{code}/market-info）。
    #
    # 为什么单开一个角色：此前桌面端自己登录的是 CRAWLER，可回写又只放行 ADMIN/仓管，
    # 于是让操作员把**管理员密码填进桌面端**去换令牌——那把钥匙能开的是仓管全量编辑接口
    # （改货号、改 69 码、改一切），而它实际只想改一个商品名。一个身份干一件事，
    # 权限就按那一件事给。
    MARKET_BOT = "MARKET_BOT"


# 真人员工的角色。RFID_DEVICE / CRAWLER / MARKET_BOT 是设备账号，不是人。
# 统一登录只认这些：只有它们能用 ERP 账号登录统一登录（routers/oidc.py）、会被同步进 Authentik
# （services/authentik_sync.py）。新加的角色默认不算人；tests/test_oidc_provider.py 要求每个角色都归个类。
HUMAN_ROLES: tuple[str, ...] = (
    StaffRole.ADMIN,
    StaffRole.PURCHASER,
    StaffRole.WAREHOUSE,
    StaffRole.NEGOTIATOR,
    StaffRole.BUSINESS,
    StaffRole.SALES,
    StaffRole.FINANCE,
)


class StaffStatus(StrEnum):
    PENDING = "PENDING"
    ACTIVE = "ACTIVE"
    DISABLED = "DISABLED"


class OrderStatus(StrEnum):
    PENDING_INSPECT = "PENDING_INSPECT"
    IN_STOCK = "IN_STOCK"
    SHIPPED = "SHIPPED"
    LOSS = "LOSS"
    CANCELLED = "CANCELLED"


class InspectionStatus(StrEnum):
    PENDING = "PENDING"
    DONE = "DONE"


class InspectionActionType(StrEnum):
    INBOUND = "INBOUND"
    REJECT = "REJECT"
    MISSING = "MISSING"  # 一单多件里没到货的那件：关掉这件、跟退款，不算验货计件


class InspectionResult(StrEnum):
    PASSED = "PASSED"
    MISMATCH = "MISMATCH"


class SkuStatus(StrEnum):
    IN_STOCK = "IN_STOCK"
    RESERVED = "RESERVED"
    SHIPPED = "SHIPPED"
    LOSS = "LOSS"
    SPLIT = "SPLIT"  # 历史库存拆分后退役的原始 SKU（不再在库，仅留痕）


class ReserveSource(StrEnum):
    SWITCH = "SWITCH"
    PLATFORM_SOLD = "PLATFORM_SOLD"


class AutoListingStage(StrEnum):
    """入库后自动上架流水线的阶段。

    行情与图片在议价期间就并行预取，议价一完成即可发布——人不用等机器。
    任何一步判断不了就停到 NEEDS_HUMAN，绝不猜：挂错款/亏本挂比漏掉危险得多。
    """

    RESOLVING = "RESOLVING"                  # 解析 SKU 属于哪个仓库 SPU
    COLLECTING = "COLLECTING"                # 等行情价 + 采图片（不依赖议价）
    READY = "READY"                          # 上架信息已写好，等议价放行
    WAIT_NEGOTIATION = "WAIT_NEGOTIATION"    # 门闩：negotiated_at 为空就停这
    PUBLISHING = "PUBLISHING"                # 已建群控发布作业，等回写
    DONE = "DONE"
    NEEDS_HUMAN = "NEEDS_HUMAN"              # 解析不出 / 行情倒挂 / 等价超期
    FAILED = "FAILED"


class WarehousePhase(StrEnum):
    PENDING_NEGOTIATION = "pending_negotiation"
    PENDING_INBOUND = "pending_inbound"
    PENDING_CREATE = "pending_create"
    LISTING = "listing"
    ON_SALE = "on_sale"
    LOCKED = "locked"
    SHIPPED = "shipped"


class ListingInfoStatus(StrEnum):
    DRAFT = "DRAFT"
    READY = "READY"
    CREATED = "CREATED"
    PUBLISHING = "PUBLISHING"
    PUBLISHED = "PUBLISHED"
    FAILED = "FAILED"


class ShopListingStatus(StrEnum):
    PENDING = "PENDING"
    LISTING = "LISTING"
    LISTED = "LISTED"
    SOLD = "SOLD"
    DELISTED = "DELISTED"
    FAILED = "FAILED"


class SwitchOrderStatus(StrEnum):
    ACTIVE = "ACTIVE"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class SwitchCutoffStatus(StrEnum):
    NONE = "NONE"
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class SaleOrderStatus(StrEnum):
    PENDING = "PENDING"
    SHIPPED = "SHIPPED"
    COMPLETED = "COMPLETED"


class OutboundType(StrEnum):
    ORDER_SHIP = "ORDER_SHIP"
    PICKUP = "PICKUP"
    SWITCH = "SWITCH"
    MANUAL = "MANUAL"


class AdjustType(StrEnum):
    LOSS = "LOSS"
    OVERFLOW = "OVERFLOW"


class StockEventType(StrEnum):
    PURCHASE = "PURCHASE"
    INSPECT = "INSPECT"
    INBOUND = "INBOUND"
    NEGOTIATE = "NEGOTIATE"
    OUTBOUND = "OUTBOUND"
    RETURN = "RETURN"
    LOSS = "LOSS"
    OVERFLOW = "OVERFLOW"
    REJECT = "REJECT"
    RFID_BIND = "RFID_BIND"  # 绑定 RFID 标签
    RFID_UNBIND = "RFID_UNBIND"  # 解绑 RFID 标签
    RECODE = "RECODE"  # 货号/条形码迁移改码
    BARCODE_SET = "BARCODE_SET"  # 69码（商品条码）录入/更换
    SPLIT = "SPLIT"  # 历史库存拆分（原 SKU 退役、拆出 N 个新 SKU）
    EXPRESS_RECALL = "EXPRESS_RECALL"  # 议价后召回快递：业务员补传顺丰改派/再次派件凭证


class ReturnOrderStatus(StrEnum):
    RETURNING = "RETURNING"
    PENDING_INBOUND = "PENDING_INBOUND"
    ABNORMAL = "ABNORMAL"  # 退回异常（序列号不符/损坏/缺配件），挂起等管理员裁决
    DONE = "DONE"
    CANCELLED = "CANCELLED"


class ReturnReasonCode(StrEnum):
    """退回原因（建单必选）"""

    CUSTOMER_CANCEL = "CUSTOMER_CANCEL"  # 客户取消
    CUSTOMER_REJECT = "CUSTOMER_REJECT"  # 客户拒收
    CUSTOMER_RETURN = "CUSTOMER_RETURN"  # 客户退货
    WRONG_ITEM = "WRONG_ITEM"  # 发错商品
    LOGISTICS_RETURN = "LOGISTICS_RETURN"  # 物流退回
    INTERNAL_ERROR = "INTERNAL_ERROR"  # 内部出库错误
    OTHER = "OTHER"


class ReturnCondition(StrEnum):
    """收货核对时的商品状态"""

    NORMAL = "NORMAL"
    OPENED = "OPENED"  # 已拆封
    USED = "USED"  # 轻微使用
    ABNORMAL = "ABNORMAL"  # 异常（损坏/缺配件等）


class ReturnResolution(StrEnum):
    """异常件裁决结果"""

    RESTOCK = "RESTOCK"  # 恢复在库
    LOSS = "LOSS"  # 报损
    REJECT = "REJECT"  # 驳回重新核对


class StocktakeStatus(StrEnum):
    IN_PROGRESS = "IN_PROGRESS"
    PAUSED = "PAUSED"
    COMPLETED = "COMPLETED"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class StocktakeDiffType(StrEnum):
    MISSING = "MISSING"
    SURPLUS = "SURPLUS"


class StocktakeProposalStatus(StrEnum):
    PROPOSED = "PROPOSED"
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    APPLIED = "APPLIED"
    SKIPPED = "SKIPPED"


class ArchiveBatchStatus(StrEnum):
    PENDING = "PENDING"
    PACKING = "PACKING"
    READY = "READY"
    FAILED = "FAILED"
    OSS_DELETED = "OSS_DELETED"


class LawsuitStatus(StrEnum):
    """起诉单状态。由已上传的材料反推，优先级：已判决 > 待开庭 > 已提交律师回复 > 已提交证据 > 草稿。"""

    DRAFT = "DRAFT"  # 未提交任何材料（待提交证据）
    EVIDENCE_SUBMITTED = "EVIDENCE_SUBMITTED"  # 已提交证据（待员工整理/律师回复）
    SUBMITTED_LAWYER = "SUBMITTED_LAWYER"  # 已提交律师回复
    PENDING_HEARING = "PENDING_HEARING"  # 待开庭（有法院材料）
    JUDGED = "JUDGED"  # 已判决（有判决结果）


class PurchaseWebhookStatus(StrEnum):
    """采购入站 webhook 事件的处理状态（inbox 模式）。"""

    PENDING = "PENDING"  # 已验签落库，待解析
    PROCESSING = "PROCESSING"  # 解析中
    DONE = "DONE"  # 已解析入采购业务表
    FAILED = "FAILED"  # 解析失败，可重试
    IGNORED = "IGNORED"  # 无需处理（未知事件类型等），人工标记
