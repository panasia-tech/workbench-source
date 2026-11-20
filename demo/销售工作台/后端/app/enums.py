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


class StaffStatus(StrEnum):
    PENDING = "PENDING"
    ACTIVE = "ACTIVE"
    DISABLED = "DISABLED"


class SkuStatus(StrEnum):
    IN_STOCK = "IN_STOCK"
    RESERVED = "RESERVED"
    SHIPPED = "SHIPPED"
    LOSS = "LOSS"
    SPLIT = "SPLIT"


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


class ShopListingStatus(StrEnum):
    PENDING = "PENDING"
    LISTING = "LISTING"
    LISTED = "LISTED"
    SOLD = "SOLD"
    DELISTED = "DELISTED"
    FAILED = "FAILED"
