"""管理运营公司受托大台账：签约委托客户 → 受托主体（个体户/公司）→ 支付宝 → 托管店铺。

11-09 技术对接会定的第三步，11-09 老板定口径：
  - 四层就是这四层，客户不单独一层；
  - 管理员看全部；业务员只能往里填，填完自己也看不到；
  - 管理员可以把某个委托客户受托档案临时开放给经办人，那人打开后看一小段时间，过了就再也看不到；
  - 每次看、改、开放都留记录（ledger_access_log）。

身份证号、银行卡号、支付密码、短信验证码不进这几张表（11-14 老板全量台账第一步再次确认：密码不存）。

11-14 第一步加的：主体的税务、年报；支付宝分主资金号 / 收款号 / 采购号；不走支付宝结算的店铺
（微信小店、抖店……）直接挂在主体下面；店铺的服务费率、保证金；账单流水分类。规矩见 services/ledger.py。

第二步加的：委托客户实名手机卡（一证五号、主副卡、外部合约卡、话费）；代理 IP；设备（AdsPower 环境、手机、电脑），
设备从群控同步过来（services/ledger_assets.py）。代理的账号密码同样不存。

第三步加的：店铺分销售店 / 采购号 / 引流号（买卖不混用）；支付宝的限额和财务科目；店铺冻结款、开票口径、
财务科目、单店月度损益；签约委托客户托管运营合同到期日、刷脸配合时效；受托主体经营范围。

第四步（审计报告里另外 12 个模块）：别的台账都记在 ledger_record 一张表里，按 kind 分（对公账户、U 盾、印章、
数电票、代账月结、商户号、外币卡、上游预存款、同行、远控单、代开店客户、背调、服务器、房产……），字段和规矩见
services/ledger_records.py；借出归还、充值、带看这类流水记 ledger_record_event；谁知道哪台设备 / 哪个账号的密码
记 ledger_knows（只记谁知道，不记密码），员工离职后要逐条改掉。员工自己名下的卡也能记成手机卡（category employee）。

第五步（11-17，V2 交付包；老板推翻了「密码不存」）：
  - 看缺口：每个法人一份目标数（ledger_target），差多少 = 目标 − 已就绪 − 开店中；
  - 开店教程（ledger_tutorial，阶段 → 步骤 → 材料整棵存在 body 里，发布后不再改，要改就出新版本）；
  - 每个开店中的支付宝 / 店铺一份进度（ledger_case），一步一交（ledger_case_step，打回重交多一个版本，旧的留着），
    跳步要老板批（ledger_case_skip）；规矩见 services/ledger_onboard.py；
  - 密码库（ledger_vault）：信封加密，主密钥只在环境变量里；只有密码库主人用手机验证器解锁后能一条条看明文，
    员工只能领自己名下账号的 6 位动态码、交新设的密码（交了自己也看不到）。见 services/ledger_vault.py。
"""

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import JSON, Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class _Entry:
    """四层共用：状态、备注、是不是业务员填的、管理员核对过没有。"""

    status: Mapped[str] = mapped_column(String(16), default="active", server_default="active", index=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 业务员填进来的要管理员核对一遍（可能和已有的重复、挂错上一层）
    needs_check: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0", nullable=False, index=True)
    created_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)


class LedgerLegalPerson(Base, TimestampMixin, _Entry):
    __tablename__ = "ledger_legal_person"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String(64), index=True)
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True)  # 委托客户法人本人主设备手机号
    email: Mapped[str | None] = mapped_column(String(128), nullable=True)  # 法人主邮箱
    # 名下原来就有的个人卡，每家运营商几张：{"中国联通": 2}。一证五号，公司再开的卡要扣掉这些
    personal_cards: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    face_sla: Mapped[str | None] = mapped_column(String(64), nullable=True)  # 平台要刷脸时他多久能响应，比如「2 小时内」
    agreement_end: Mapped[date | None] = mapped_column(Date, nullable=True)  # 托管运营合同到期日，到期前提醒续签


class LedgerEntity(Base, TimestampMixin, _Entry):
    """主体：个体户或公司，一张营业执照一个。企业支付宝按主体开。"""

    __tablename__ = "ledger_entity"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    legal_person_id: Mapped[str] = mapped_column(String(36), ForeignKey("ledger_legal_person.id"), index=True)
    name: Mapped[str] = mapped_column(String(128), index=True)
    entity_type: Mapped[str] = mapped_column(String(16), default="individual")  # individual 个体户 / company 公司
    credit_code: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)  # 统一社会信用代码
    # 税务：small 小规模 / general 一般纳税人；audit 查账征收 / assessed 核定征收（公司只能查账）
    tax_payer: Mapped[str] = mapped_column(String(16), default="small", server_default="small")
    tax_levy: Mapped[str] = mapped_column(String(16), default="audit", server_default="audit")
    tax_office: Mapped[str | None] = mapped_column(String(128), nullable=True)  # 主管税务局
    tax_phone: Mapped[str | None] = mapped_column(String(32), nullable=True)  # 办税人手机号
    liaison_phone: Mapped[str | None] = mapped_column(String(32), nullable=True)  # 工商联络员手机号
    registered_on: Mapped[date | None] = mapped_column(Date, nullable=True)  # 成立日期，当年成立的不用报上一年的年报
    # 年报：每年 1 月 1 日到 6 月 30 日报上一年的。记最近报过哪一年、哪天报的
    report_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    report_filed_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    business_scope: Mapped[str | None] = mapped_column(Text, nullable=True)  # 经营范围
    invoice_quota: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), nullable=True)  # 数电票每月授信开票额度


class LedgerAlipay(Base, TimestampMixin, _Entry):
    __tablename__ = "ledger_alipay"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    entity_id: Mapped[str] = mapped_column(String(36), ForeignKey("ledger_entity.id"), index=True)
    account: Mapped[str] = mapped_column(String(128), index=True)  # 登录账号（邮箱/手机号）
    alias: Mapped[str | None] = mapped_column(String(64), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True)  # 绑定手机号（收验证码的那张卡）
    alipay_user_id: Mapped[str | None] = mapped_column(String(32), nullable=True)  # 2088 开头，对账授权后才有
    # master 主资金号（一个主体最多一个）/ sales 收款号（只有它能挂店铺）/ purchase 采购号（不收卖货的钱）
    role: Mapped[str] = mapped_column(String(16), default="sales", server_default="sales")
    # 采购号开了因公付：付款从同一主体的主资金号扣，不能跨主体
    corporate_pay: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0", nullable=False)
    # 财务内控：日累计限额、单笔限额、冻结 / 不能动的钱、对应的财务科目编码
    daily_limit: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), nullable=True)
    single_limit: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), nullable=True)
    frozen_reserve: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), nullable=True)
    book_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 无密转账（alipay.fund.trans.uni.transfer）：三张证书哪天到期、报备的转账场景
    cert_expires_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    transfer_scene: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # ---- 对账授权（第三方应用授权，见 services/ledger_bill.py）----
    # 令牌加密存（services/ledger_crypto.py），接口从不把它吐出去
    auth_status: Mapped[str] = mapped_column(String(16), default="none", server_default="none")  # none/authorized/expired/error
    app_auth_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    app_refresh_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    authorized_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    auth_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    auth_error: Mapped[str | None] = mapped_column(String(255), nullable=True)


class LedgerShop(Base, TimestampMixin, _Entry):
    __tablename__ = "ledger_shop"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    # 店铺都属于一个主体；走支付宝结算的再挂到这个主体的一个收款号上，别的结算方式 alipay_id 为空
    entity_id: Mapped[str] = mapped_column(String(36), ForeignKey("ledger_entity.id"), index=True)
    alipay_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ledger_alipay.id"), nullable=True, index=True)
    platform: Mapped[str] = mapped_column(String(16), default="xianyu")  # 见 services/ledger.PLATFORMS
    name: Mapped[str] = mapped_column(String(128), index=True)
    # 钱结算到哪：alipay 企业支付宝 / wechat 微信支付商户号 / douyin 抖音支付 / xhs 小红书钱包 / jd 京东钱包 / other
    channel: Mapped[str] = mapped_column(String(16), default="alipay", server_default="alipay")
    merchant_no: Mapped[str | None] = mapped_column(String(64), nullable=True)  # 不走支付宝的商户号
    fee_rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)  # 平台服务费，百分数
    deposit: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)  # 已交保证金
    deposit_from: Mapped[str | None] = mapped_column(String(128), nullable=True)  # 保证金从哪个账户交的，关店原路退
    # 对得上 ERP 店铺（闲鱼号）的挂上，好从店铺查回法人
    sale_shop_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("sale_shop.id"), nullable=True, index=True)
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True)  # 店铺绑定手机号
    # 跑在哪个 AdsPower 环境 / 哪台手机上；群控同步时按闲鱼号自动挂上
    device_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ledger_device.id"), nullable=True, index=True)
    # sales 销售店 / purchase 采购号（因公付从采购支付宝扣）/ marketing 引流号（不收不付，往 lead_shop 引流）
    role: Mapped[str] = mapped_column(String(16), default="sales", server_default="sales")
    lead_shop_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ledger_shop.id"), nullable=True)
    frozen: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)  # 平台冻结 / 在途的钱
    invoice_mode: Mapped[str | None] = mapped_column(String(16), nullable=True)  # 见 services/ledger.INVOICE_MODES
    book_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    currency: Mapped[str] = mapped_column(String(8), default="CNY", server_default="CNY")  # 海外店按原币记


class LedgerSim(Base, TimestampMixin, _Entry):
    """手机卡。挂在给哪个法人用的那个法人下面。

    master 客户主卡 / sub 客户副卡（挂在同一委托客户、同一运营商的主卡下）均实名在委托客户法人本人名下，和他原有的个人卡一起
    算一证五号；external 外部合约卡实名在别人名下，不占法人的名额，但合约到期要换绑；
    employee 员工实名卡：员工用自己身份证办的卡给公司用，离职交回卡也能去营业厅挂失补卡，一直标红，须尽快换绑为委托客户实名或合规授权卡。
    """

    __tablename__ = "ledger_sim"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    legal_person_id: Mapped[str] = mapped_column(String(36), ForeignKey("ledger_legal_person.id"), index=True)
    phone: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    carrier: Mapped[str] = mapped_column(String(16), default="中国移动")
    category: Mapped[str] = mapped_column(String(16), default="master")  # master / sub / external
    master_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ledger_sim.id"), nullable=True, index=True)
    # independent 自己扣话费 / shared 副卡共用主卡的话费
    billing: Mapped[str] = mapped_column(String(16), default="independent")
    plan: Mapped[str | None] = mapped_column(String(128), nullable=True)
    monthly_rent: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    # 余额是人查了记下来的，balance_on 是哪天查的；充值记一笔会自动加上
    balance: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    balance_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    iccid: Mapped[str | None] = mapped_column(String(32), nullable=True)
    holder: Mapped[str | None] = mapped_column(String(64), nullable=True)  # 外部卡实名在谁名下
    vendor: Mapped[str | None] = mapped_column(String(128), nullable=True)  # 外部卡从哪来的
    contract_end: Mapped[date | None] = mapped_column(Date, nullable=True)  # 外部卡合约到期，到期前要换绑
    custodian: Mapped[str | None] = mapped_column(String(64), nullable=True)  # 卡在谁手里
    staff_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)  # 员工实名卡在谁名下


class LedgerProxy(Base, TimestampMixin, _Entry):
    """代理 IP（家宽 SOCKS5 之类）。同一平台的两个店不能共用一条，不同平台可以。账号密码不存。"""

    __tablename__ = "ledger_proxy"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)  # 内部编号，比如 IP-HZ-01
    provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    protocol: Mapped[str] = mapped_column(String(8), default="socks5")
    host: Mapped[str | None] = mapped_column(String(128), nullable=True)
    port: Mapped[int | None] = mapped_column(Integer, nullable=True)
    exit_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)  # 出口 IP
    region: Mapped[str | None] = mapped_column(String(64), nullable=True)
    monthly_cost: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    expires_on: Mapped[date | None] = mapped_column(Date, nullable=True)


class LedgerDevice(Base, TimestampMixin, _Entry):
    """一个 AdsPower 环境、一台手机或一台电脑。环境和手机大多由群控同步过来（gc_device_id），电脑手填。"""

    __tablename__ = "ledger_device"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    kind: Mapped[str] = mapped_column(String(8), default="env")  # env AdsPower 环境 / phone 手机 / pc 电脑
    name: Mapped[str] = mapped_column(String(128))
    # sales 销售 / purchase 采购 / marketing 引流：采购和引流的不挂店铺
    purpose: Mapped[str] = mapped_column(String(16), default="sales")
    gc_device_id: Mapped[str | None] = mapped_column(String(36), unique=True, nullable=True)
    ads_user_id: Mapped[str | None] = mapped_column(String(32), unique=True, nullable=True)  # AdsPower 环境编号
    gc_nick: Mapped[str | None] = mapped_column(String(64), nullable=True)  # 群控里现在登着的闲鱼号
    last_online_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    model: Mapped[str | None] = mapped_column(String(64), nullable=True)
    serial: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    imei1: Mapped[str | None] = mapped_column(String(32), nullable=True)
    imei2: Mapped[str | None] = mapped_column(String(32), nullable=True)
    host_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ledger_device.id"), nullable=True)  # 环境开在哪台电脑上
    proxy_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ledger_proxy.id"), nullable=True, index=True)
    sim1_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ledger_sim.id"), nullable=True)
    sim2_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ledger_sim.id"), nullable=True)
    custodian: Mapped[str | None] = mapped_column(String(64), nullable=True)
    location: Mapped[str | None] = mapped_column(String(64), nullable=True)  # 放在哪个工位


class LedgerCharge(Base):
    """花钱的流水：代理续期、话费充值。只增不改。"""

    __tablename__ = "ledger_charge"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    kind: Mapped[str] = mapped_column(String(16))  # proxy_renew / sim_recharge
    target_id: Mapped[str] = mapped_column(String(36), index=True)
    amount: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    months: Mapped[int | None] = mapped_column(Integer, nullable=True)
    before: Mapped[str | None] = mapped_column(String(32), nullable=True)  # 续期前到期日 / 充值前余额
    after: Mapped[str | None] = mapped_column(String(32), nullable=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    staff_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class LedgerRecord(Base, TimestampMixin, _Entry):
    """第四步的各种台账，一行一条。kind 决定 attrs 里有哪些字段、有哪些规矩和提醒（services/ledger_records.KINDS）。

    主体 / 法人 / 上一条（比如 U 盾挂在哪个对公账户下）用真外键，别的都在 attrs 里。密码、PIN、密钥不进来，
    只记「放在哪」「谁知道」。
    """

    __tablename__ = "ledger_record"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    kind: Mapped[str] = mapped_column(String(24), index=True)
    name: Mapped[str] = mapped_column(String(128))
    entity_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ledger_entity.id"), nullable=True, index=True)
    legal_person_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ledger_legal_person.id"), nullable=True,
                                                        index=True)
    parent_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ledger_record.id"), nullable=True, index=True)
    attrs: Mapped[dict] = mapped_column(JSON, default=dict)


class LedgerRecordEvent(Base):
    """台账条目上的流水：印章借出 / 归还、预存款充值、带看、拒付、清单打勾……只增不改。"""

    __tablename__ = "ledger_record_event"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    record_id: Mapped[str] = mapped_column(String(36), ForeignKey("ledger_record.id"), index=True)
    kind: Mapped[str] = mapped_column(String(24))
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    staff_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class LedgerKnows(Base):
    """谁知道哪个东西的密码 / 锁屏码 / 支付密码（不记密码本身）。员工离职后这些都要改，改完删掉这一行。"""

    __tablename__ = "ledger_knows"
    __table_args__ = (UniqueConstraint("target_type", "target_id", "what", "staff_id", name="uq_ledger_knows"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    target_type: Mapped[str] = mapped_column(String(16))  # device / alipay / shop / record
    target_id: Mapped[str] = mapped_column(String(36), index=True)
    what: Mapped[str] = mapped_column(String(16))  # 见 services/ledger_records.SECRETS
    staff_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    created_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class LedgerGrant(Base, TimestampMixin):
    """管理员把一个法人（连同下面的主体、支付宝、店铺）临时开放给一个人看。

    开放后要在 expires_at 前打开；第一次打开起算 READ_MINUTES 分钟（read_until），过了就再也打不开。
    """

    __tablename__ = "ledger_grant"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    staff_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    legal_person_id: Mapped[str] = mapped_column(String(36), ForeignKey("ledger_legal_person.id"), index=True)
    reason: Mapped[str | None] = mapped_column(String(255), nullable=True)  # 开放给他干什么，他打开前看得到
    granted_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    opened_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    read_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class LedgerAccessLog(Base):
    """谁什么时候看了、改了、开放了哪条。只增不改。"""

    __tablename__ = "ledger_access_log"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    staff_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    action: Mapped[str] = mapped_column(String(16), index=True)  # view/create/update/delete/submit/grant/revoke/open
    target_type: Mapped[str] = mapped_column(String(16))  # legal_person/entity/alipay/shop/sim/proxy/device/grant
    target_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class LedgerAuthState(Base):
    """发出去的授权链接：state 对回是哪个支付宝。一次性，30 天内有效。"""

    __tablename__ = "ledger_auth_state"

    state: Mapped[str] = mapped_column(String(64), primary_key=True)
    alipay_id: Mapped[str] = mapped_column(String(36), ForeignKey("ledger_alipay.id"), index=True)
    created_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class LedgerBillFetch(Base, TimestampMixin):
    """某个支付宝某一天的账单拉过没有、结果如何。一个支付宝一天一行。"""

    __tablename__ = "ledger_bill_fetch"
    __table_args__ = (UniqueConstraint("alipay_id", "bill_date", name="uq_ledger_bill_fetch"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    alipay_id: Mapped[str] = mapped_column(String(36), ForeignKey("ledger_alipay.id"), index=True)
    bill_date: Mapped[date] = mapped_column(Date, index=True)
    status: Mapped[str] = mapped_column(String(16))  # ok / empty（那天没流水）/ error
    rows: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)


class LedgerBillRow(Base):
    """账务明细一行（支付宝 signcustomer 账单）。按账务流水号去重，重拉不会多出来。"""

    __tablename__ = "ledger_bill_row"
    __table_args__ = (UniqueConstraint("alipay_id", "flow_no", name="uq_ledger_bill_row_flow"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    alipay_id: Mapped[str] = mapped_column(String(36), ForeignKey("ledger_alipay.id"), index=True)
    bill_date: Mapped[date] = mapped_column(Date, index=True)
    flow_no: Mapped[str] = mapped_column(String(64))  # 账务流水号
    biz_no: Mapped[str | None] = mapped_column(String(64), nullable=True)  # 业务流水号
    merchant_order_no: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)  # 商户订单号
    item_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    occurred_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    counterparty: Mapped[str | None] = mapped_column(String(128), nullable=True)
    income: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=0)
    expense: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=0)
    balance: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), nullable=True)
    channel: Mapped[str | None] = mapped_column(String(64), nullable=True)
    biz_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    remark: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # 对上的 ERP 销售单；how = order_no（订单号对上）/ amount（金额+日期对上）/ approx（差 2% 内）
    sale_order_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("sale_order.id"), nullable=True, index=True)
    # 或者对上的出库单（闲鱼卖出大多不开销售单）；how 多一种 noshop（认不出店铺、金额全库唯一）
    sale_outbound_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    match_how: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # 这笔钱是什么：见 services/ledger_bill.FLOWS；自动分，人改过（flow_manual）就不再自动覆盖
    flow: Mapped[str | None] = mapped_column(String(24), nullable=True, index=True)
    flow_manual: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ---------------------------------------------------------------- 第五步：看缺口、开店教程与进度、密码库

class LedgerTarget(Base, TimestampMixin):
    """一个法人的目标数：执照、税务、年报、支付宝、代理、工作手机、手机卡，和各平台店数（targets 里，键见
    services/ledger_onboard.TARGET_KEYS；平台的键是 platform:xianyu 这样）。没填的项不算缺口。"""

    __tablename__ = "ledger_target"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    legal_person_id: Mapped[str] = mapped_column(String(36), ForeignKey("ledger_legal_person.id"), unique=True)
    targets: Mapped[dict] = mapped_column(JSON, default=dict)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)


class LedgerTutorial(Base, TimestampMixin):
    """开店教程。审核人写、老板发布；发布了就不再改，要改另存一个新版本（同 code、version + 1），
    新版本发布时旧版本归档。已经开始的进度一直按它开始时的那一版走。"""

    __tablename__ = "ledger_tutorial"
    __table_args__ = (UniqueConstraint("code", "version", name="uq_ledger_tutorial_version"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    code: Mapped[str] = mapped_column(String(32), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    kind: Mapped[str] = mapped_column(String(16))  # alipay 企业支付宝 / shop 店铺 / meta 写教程的教程
    platform: Mapped[str | None] = mapped_column(String(16), nullable=True)  # kind=shop 时是哪个平台
    title: Mapped[str] = mapped_column(String(128))
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    # [{code,title,desc,duration,steps:[{code,title,who,when,guide,warn,deliver,stop,video_url,require_review,
    #   require_confirm,gate,vault_lockin,guards:[{pre,mistake,block,tip,recover,owner,evidence}],
    #   materials:[{key,label,kind,required,placeholder}]}]}]
    body: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(16), default="draft", index=True)  # draft/pending/published/archived
    author_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    reviewed_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class LedgerCase(Base, TimestampMixin):
    """一个支付宝 / 一家店的开店进度（或一份写教程的任务，target_type=tutorial）。

    闲鱼店挂着同主体那个支付宝的进度（link_case_id）：支付宝没过 C10 做不了 S09，没过 D15 做不了 S18。
    同一个支付宝 / 店铺同时只能有一份没结束的进度。
    """

    __tablename__ = "ledger_case"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    tutorial_id: Mapped[str] = mapped_column(String(36), ForeignKey("ledger_tutorial.id"), index=True)
    target_type: Mapped[str] = mapped_column(String(16))  # alipay / shop / tutorial
    target_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    # 不用外键：法人删了，走完的进度留着当记录
    legal_person_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    link_case_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ledger_case.id"), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(128))
    assignee_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)  # open / done / cancelled
    due_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    done_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))


class LedgerCaseStep(Base):
    """一步交的材料和审核结果。只增：打回后重交是新的一行（version_no + 1），旧的打回意见一直留着。"""

    __tablename__ = "ledger_case_step"
    __table_args__ = (UniqueConstraint("case_id", "step_code", "version_no", name="uq_ledger_case_step"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    case_id: Mapped[str] = mapped_column(String(36), ForeignKey("ledger_case.id"), index=True)
    step_code: Mapped[str] = mapped_column(String(16))
    version_no: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(16))  # submitted / approved / rejected / skipped
    materials: Mapped[dict] = mapped_column(JSON, default=dict)
    confirmed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0", nullable=False)
    submitted_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))
    submitted_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    reviewed_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)


class LedgerCaseSkip(Base):
    """申请跳过某一步，老板批。批了就在 ledger_case_step 记一行 skipped。"""

    __tablename__ = "ledger_case_skip"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    case_id: Mapped[str] = mapped_column(String(36), ForeignKey("ledger_case.id"), index=True)
    step_code: Mapped[str] = mapped_column(String(16))
    reason: Mapped[str] = mapped_column(Text)
    requested_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)  # pending / approved / rejected
    decided_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    decide_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class LedgerVault(Base, TimestampMixin):
    """密码库一条：一个账号的登录密码、二级 / 支付密码、二次验证种子。

    secret 是信封加密后的一整块（services/ledger_vault.py）：每条一把随机数据密钥，数据密钥再用环境变量里的主密钥加密，
    整库被拖走也解不开。列表接口从不带 secret；has_* 只说有没有。
    """

    __tablename__ = "ledger_vault"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    category: Mapped[str] = mapped_column(String(16), index=True)  # 见 services/ledger_vault.CATEGORIES
    title: Mapped[str] = mapped_column(String(128))
    # 对应台账里哪一行（alipay / shop / entity / device / proxy / sim / record），可不挂
    target_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    target_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    login_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    secret: Mapped[str | None] = mapped_column(Text, nullable=True)
    has_password: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0", nullable=False)
    has_secondary: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0", nullable=False)
    has_totp: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0", nullable=False)
    # 给谁用：他能领这条的 6 位动态码（employee_totp 开着时）、能让 AdsPower 环境自动填，看不到明文
    assignee_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True, index=True)
    employee_totp: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0", nullable=False)
    # 填进哪个 AdsPower 环境（ledger_device kind=env）；ads_status: none / pending / synced / error
    device_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ledger_device.id"), nullable=True)
    ads_status: Mapped[str] = mapped_column(String(16), default="none", server_default="none")
    ads_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    ads_error: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # 填进 AdsPower 时的网站（AdsPower 的 platform，比如 goofish.com）；空着按台账条目的平台猜
    ads_domain: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # 同步：ads_status=pending 时等工位来领；领了记哪台、领到什么时候（过了没回执就能被别的工位再领）；
    # 回执 ack 只放在加密的包里，库里只存它的哈希
    ads_job_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    ads_station_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    ads_claim_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    ads_ack_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    rotated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # 密码最近一次改的时间
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)


class LedgerVaultFactor(Base, TimestampMixin):
    """密码库主人绑的手机验证器（TOTP 种子，用主密钥加密存）。last_step 防同一个码用两次；连错 5 次锁 15 分钟。"""

    __tablename__ = "ledger_vault_factor"

    staff_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), primary_key=True)
    totp_enc: Mapped[str | None] = mapped_column(Text, nullable=True)  # 扫码后、第一次输对码之前放 pending_enc
    pending_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_step: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    fails: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    locked_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class LedgerVaultSession(Base):
    """解锁后的 15 分钟。只存令牌的哈希；点上锁或过期就作废。两个 worker 共用，所以放库里不放内存。"""

    __tablename__ = "ledger_vault_session"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    staff_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class LedgerVaultStation(Base, TimestampMixin):
    """能把密码填进 AdsPower 的工位（装了巡航台的电脑，id = workbench_device.id）。

    巡航台在本机生成一对 X25519 密钥：私钥用系统加密（Windows DPAPI）存在本机，公钥交上来。密码库主人对着指纹
    批准后，这台电脑才领得到要填的密码——用它的公钥加密，只有它解得开。换了公钥要重新批准。
    """

    __tablename__ = "ledger_vault_station"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    public_key: Mapped[str] = mapped_column(String(64))  # 32 字节原始公钥的 base64
    fingerprint: Mapped[str] = mapped_column(String(32))  # 公钥 SHA-256 前 8 字节，四位一组，两边对着看
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)  # pending / trusted / revoked
    registered_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    approved_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
