from pydantic import BaseModel, Field


class MiaodaOverview(BaseModel):
    """员工工作台工作页用的 ERP 计数：全公司口径、只有数量、不含金额。"""

    generated_at: str = Field(description="统计时刻（北京时间 ISO 8601）")
    today_purchase: int = Field(description="今日采购单数（不含资产录入）")
    pending_inspect: int = Field(description="待验货（验货任务 PENDING，与验货列表一致）")
    today_inspected: int = Field(description="今日验货完成数（不含资产录入）")
    today_inbound: int = Field(description="今日入库件数")
    today_outbound: int = Field(description="今日出库单数")
    in_stock: int = Field(description="在库件数")
    reserved: int = Field(description="锁单件数")


class MiaodaEmployeeTokenIn(BaseModel):
    staff_id: str = Field(description="ERP 员工 ID（工作台用户 ID 就是它）")


class MiaodaEmployeeTokenOut(BaseModel):
    """换出来的员工登录令牌：工作台服务端持有并缓存，绝不给浏览器。"""

    token: str = Field(description="员工 JWT（和其他登录门签的一样）")
    role: str = Field(description="员工角色（工作台按它摆入口）")
    name: str = Field(description="员工姓名")
    expires_in: int = Field(description="有效期（秒）")
