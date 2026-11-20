"""大台账第四步：审计报告里另外 12 个模块，都记在 ledger_record 一张表里，按 kind 分（11-15 用户说「也做吧」）。

每种条目有哪些字段、哪些规矩、到期怎么提醒，都写在 KINDS 里；页面按这里给的字段画表单。
密码、PIN、密钥、完整卡号一律不进来（用户定的「密码不存」）：卡号只记后 4 位，密钥只记「放在哪」，
谁知道哪个东西的密码记 ledger_knows（只记谁知道），员工离职后逐条改掉、改完删掉。

规矩（拦下来的）：
  - 对公账户号只记后 4 位；一个主体只能有一个基本户；
  - 同一个对公账户的制单 U 盾和复核 U 盾不能在同一个人手里；同一主体的财务章和法人章要两个人分开管；
  - 印章借出去没还不能再借；红字发票要填冲哪张蓝票，要人点「批准」才算数；
  - 申报的提交人和复核人不能是同一个人；
  - 商户号的钱只能结算进同一主体的对公户 / 经营者卡；
  - 微信成交 1000 元以上要挂原闲鱼订单号、留了关闭截图；
  - 同行改成「已合作」前要有实名收款人；协议共管的会员号要写会员是谁的；
  - 远控单完工要先撤权（从坐席设备列表移除、提醒客户刷新验证码）才能关。

提醒（只提醒，雷达上看）：各种到期（证书、合约、订阅、租约、域名……）、预存款低于断供线、印章超期没还、
代账月结的单据 / 四张表 / 完税回执过了日子没到、开票额度快用完、代开店服务费逾期（15 天以上标红）、
远控完工没撤权、背调过了 90 天、法人没做过背调、离职员工还知道的密码、员工实名卡、换号后外部平台还没改完。
"""

from __future__ import annotations

import calendar
import re
import socket
import ssl
from datetime import date, datetime, timedelta
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.enums import StaffStatus
from app.models import (
    LedgerAlipay,
    LedgerDevice,
    LedgerEntity,
    LedgerKnows,
    LedgerLegalPerson,
    LedgerRecord,
    LedgerRecordEvent,
    LedgerShop,
    LedgerSim,
    Staff,
)
from app.services import ledger as lg

CURRENCIES = {c: c for c in ("CNY", "JPY", "HKD", "USD", "EUR", "KRW", "THB", "SGD")}
SECRETS = {"lock": "锁屏码", "login": "登录密码", "pay": "支付密码", "cloud": "云账号密码", "cookie": "登录态 / Cookie",
           "pin": "U 盾 PIN", "other": "别的密码"}
KNOW_TARGETS = {"device": "设备", "alipay": "支付宝", "shop": "店铺", "record": "台账条目"}
WARN_DAYS = 30
BGCHECK_DAYS = 90
FEE_OVERDUE_DAYS = 15
LARGE_DEAL = Decimal("1000")
CENT = Decimal("0.01")


def F(key: str, label: str, type: str = "text", **kw) -> dict:  # noqa: N802 — 字段定义写成一行一个，短一点
    return {"key": key, "label": label, "type": type, **kw}


def _sel(**options) -> dict:
    return options


GROUPS = {
    "bank": "银行·印章·开票·申报",
    "pay": "收款通道",
    "overseas": "海外与外币卡",
    "supply": "上游与同行",
    "member": "会员共管号",
    "saas": "软件订阅与直播",
    "remote": "远控服务",
    "client": "代开店客户与合同",
    "staff": "员工与离职",
    "bgcheck": "背调",
    "it": "服务器与硬件",
    "estate": "房产场地",
}

ACCT_TYPES = _sel(basic="基本户", general="一般户", tax="税务扣款户", owner_card="经营者一类卡")
UKEY_ROLES = _sel(maker="制单 U 盾", checker="复核 U 盾", readonly="只读查账号")
SEAL_TYPES = _sel(official="公章", finance="财务章", legal="法人章", contract="合同章", invoice="发票章")
CLOSE_ITEMS = (
    ("handover", "单据移交签字", "本月 30 日"),
    ("reports", "四张表（资产负债表、利润表、银行余额调节表、异常付款清单）", "次月 10 日"),
    ("tax_receipt", "完税回执", "次月 15 日"),
)

KINDS: dict[str, dict] = {
    # ---------------- 银行·印章·开票·申报
    "bank_account": {
        "label": "对公账户", "group": "bank", "name_label": "账户简称", "name_hint": "比如 联茂网络 工行基本户",
        "fields": [
            F("entity_id", "哪个主体", "entity", required=True),
            F("acct_type", "账户类型", "select", options=ACCT_TYPES, required=True, list=True),
            F("bank", "开户行", required=True, list=True),
            F("branch", "支行"),
            F("cnaps", "联行号"),
            F("last4", "账号后 4 位", required=True, list=True, hint="完整账号不记"),
            F("single_limit", "单笔限额", "money"),
            F("daily_limit", "单日限额", "money"),
            F("reserved_phone", "银行预留手机号", "phone", list=True, hint="要是公司手里的卡"),
            F("custodian", "谁管"),
        ],
    },
    "ukey": {
        "label": "U 盾 / 查账号", "group": "bank", "name_label": "叫什么", "name_hint": "比如 工行制单盾",
        "fields": [
            F("parent_id", "哪个对公账户", "parent", of="bank_account", required=True, list=True),
            F("role", "用途", "select", options=UKEY_ROLES, required=True, list=True),
            F("holder_staff", "谁拿着（员工）", "staff", list=True),
            F("holder", "谁拿着（外面的人）", hint="比如 桐新代账；只读查账号给代账机构，别让出纳导流水转交"),
            F("pin_where", "PIN 放在哪", hint="PIN 本身不记，比如 保险箱"),
        ],
    },
    "seal": {
        "label": "印章", "group": "bank", "name_label": "叫什么", "name_hint": "比如 联茂网络 公章",
        "fields": [
            F("entity_id", "哪个主体", "entity", required=True),
            F("seal_type", "章", "select", options=SEAL_TYPES, required=True, list=True),
            F("custodian_staff", "谁管（员工）", "staff", list=True),
            F("custodian", "谁管（外面的人）"),
            F("where", "放在哪"),
        ],
        "events": {
            "lend": {"label": "借出", "fields": [F("to", "借给谁", required=True), F("purpose", "去盖什么", required=True),
                                                F("due_back", "哪天还", "date")]},
            "return": {"label": "归还", "fields": [F("scan", "盖章文件扫描件在哪", hint="比如 网盘 /印章/2026-11")]},
        },
    },
    "invoice": {
        "label": "数电票", "group": "bank", "name_label": "发票号码",
        "fields": [
            F("entity_id", "开票主体", "entity", required=True),
            F("color", "蓝字 / 红字", "select", options=_sel(blue="蓝字", red="红字"), required=True, list=True),
            F("amount", "金额", "money", required=True, list=True),
            F("buyer", "购买方", list=True),
            F("issued_on", "开票日期", "date", list=True),
            F("orig_no", "冲哪张蓝票", hint="红字发票要填"),
        ],
        "events": {"approve": {"label": "批准冲红", "fields": [], "only": {"color": "red"}}},
    },
    "close_month": {
        "label": "代账月结", "group": "bank", "name_label": "代账机构", "name_hint": "比如 桐新",
        "fields": [F("month", "哪个月", "month", required=True, list=True)],
        "checklist": True,
    },
    "tax_filing": {
        "label": "申报回执", "group": "bank", "name_label": "叫什么", "name_hint": "比如 2026Q3 增值税",
        "fields": [
            F("entity_id", "哪个主体", "entity", required=True),
            F("tax", "税种", "select", options=_sel(vat="增值税（季度）", cit="所得税汇算清缴", iit="个税", other="其他"),
              required=True, list=True),
            F("period", "所属期", required=True, list=True, hint="季度写 2026Q3，年度写 2026"),
            F("submitted_by", "提交人", "staff", required=True, list=True),
            F("reviewed_by", "复核人", "staff", required=True, list=True),
            F("filed_on", "申报日期", "date"),
            F("receipt_no", "回执编号"),
            F("receipt_sha256", "回执文件 SHA-256", hint="回执 PDF 的指纹，防改"),
        ],
    },
    "elicense": {
        "label": "电子营业执照授权", "group": "bank", "name_label": "叫什么",
        "fields": [
            F("entity_id", "哪个主体", "entity", required=True),
            F("agent", "经办人", required=True, list=True),
            F("scope", "授权做什么"),
            F("expires_on", "授权到期", "date", required=True, list=True),
        ],
    },
    # ---------------- 收款通道
    "merchant": {
        "label": "平台商户号", "group": "pay", "name_label": "叫什么", "name_hint": "比如 联茂网络 微信支付",
        "fields": [
            F("entity_id", "哪个主体", "entity", required=True),
            F("provider", "通道", "select", options=_sel(wechat="微信支付", douyin="抖音支付 / 合众易宝", xhs="小红书",
                                                       jd="京东钱包", other="其他"), required=True, list=True),
            F("mch_no", "商户号", required=True, list=True),
            F("parent_id", "结算到哪个对公户", "parent", of="bank_account", list=True),
            F("settle_cycle", "结算周期", "select", options=_sel(t0="T+0", t1="T+1", t7="T+7", other="其他")),
            F("cert_expires_on", "证书到期", "date", list=True),
            F("key_where", "密钥 / 证书放在哪", hint="APIv3 密钥本身不记"),
        ],
    },
    "offline_deal": {
        "label": "微信成交 / 切单", "group": "pay", "name_label": "卖家 / 事项",
        "fields": [
            F("xianyu_order", "原闲鱼订单号", list=True),
            F("listed_amount", "闲鱼原价", "money"),
            F("deal_amount", "微信谈下的价", "money", required=True, list=True),
            F("refund_state", "闲鱼退款", "select", options=_sel(pending="退款还没到账", arrived="退款已到账",
                                                              none="不涉及退款"), required=True, list=True),
            F("paid_on", "财务转账日期", "date"),
            F("paid_by", "谁转的"),
            F("screenshot_ok", "原订单关闭截图留了", "bool"),
        ],
    },
    # ---------------- 海外与外币卡
    "fx_card": {
        "label": "外币卡 / 虚拟卡", "group": "overseas", "name_label": "卡简称", "name_hint": "比如 HSBC 买一送一卡",
        "fields": [
            F("holder", "持卡人", required=True, list=True),
            F("network", "卡组织", "select", options=_sel(visa="Visa", mastercard="Mastercard", jcb="JCB", amex="Amex",
                                                       unionpay="银联"), required=True, list=True),
            F("issuer", "发卡行"),
            F("last4", "卡号后 4 位", required=True, list=True, hint="完整卡号、CVV 不记"),
            F("currency", "币种", "select", options=CURRENCIES, required=True),
            F("credit_limit", "额度", "money"),
            F("available", "可用额度", "money", list=True),
            F("bill_day", "账单日", "int", min=1, max=31),
            F("due_day", "还款日", "int", min=1, max=31, list=True),
            F("expires", "有效期", "month"),
            F("otp_phone", "3DS 验证码手机号", "phone"),
            F("otp_email", "3DS 验证码邮箱"),
            F("perks", "权益", "textarea", hint="比如 每月 $10 餐饮额度"),
        ],
        "events": {"chargeback": {"label": "记一笔拒付", "fields": [F("amount", "金额", "money", required=True),
                                                                  F("merchant", "商户"), F("result", "结果")]}},
    },
    "overseas_sim": {
        "label": "海外卡 / eSIM", "group": "overseas", "name_label": "号码",
        "fields": [
            F("country", "国家 / 地区", list=True),
            F("provider", "运营商 / 平台"),
            F("used_for", "收哪些验证码", list=True),
            F("monthly_cost", "月费", "money"),
            F("expires_on", "到期", "date", list=True),
        ],
    },
    # ---------------- 上游与同行
    "supplier": {
        "label": "上游预存款", "group": "supply", "name_label": "上游", "name_hint": "比如 链动小铺、天远背调",
        "fields": [
            F("skind", "类型", "select", options=_sel(card_site="发卡网", topup_api="直充 API", brand="品牌团购",
                                                    bgcheck="背调 API", other="其他"), required=True, list=True),
            F("site", "网址"),
            F("balance", "余额", "money", list=True),
            F("balance_on", "哪天查的", "date"),
            F("warn_below", "低于多少提醒", "money", hint="背调 API 默认 150"),
            F("deposit", "保证金", "money"),
            F("ip_whitelist", "回调 / 出口 IP 白名单"),
            F("key_where", "AppKey 放在哪", hint="密钥本身不记"),
        ],
        "events": {
            "recharge": {"label": "充值", "fields": [F("amount", "充了多少", "money", required=True), F("memo", "备注")]},
            "balance": {"label": "记余额", "fields": [F("balance", "现在余额", "money", required=True), F("memo", "备注")]},
        },
    },
    "peer": {
        "label": "同行 / 群主", "group": "supply", "name_label": "叫什么",
        "fields": [
            F("role", "是什么人", "select", options=_sel(supplier="供货同行", group="群主", referrer="介绍人",
                                                       remote="远控接力同行"), required=True, list=True),
            F("state", "到哪一步", "select", options=_sel(found="发现", contacted="已联系", joined="已加入",
                                                        verified="已核验", partner="已合作"), required=True, list=True),
            F("contact", "联系方式"),
            F("payee", "实名收款人", list=True),
            F("can_invoice", "能开票", "bool", list=True),
            F("entry_fee", "进群费", "money"),
            F("deposit", "押金", "money"),
            F("terms", "失效卡密怎么追偿", "textarea"),
        ],
    },
    # ---------------- 会员共管号
    "member_pool": {
        "label": "会员共管 / 领券号", "group": "member", "name_label": "账号",
        "fields": [
            F("platform", "平台", required=True, list=True, hint="比如 京东 Plus"),
            F("mkind", "用途", "select", options=_sel(shared="协议共管（积分归公司）", coupon="自养领券号"), required=True,
              list=True),
            F("holder", "会员是谁的", list=True),
            F("agreement", "签了共管协议", "bool"),
            F("agreement_end", "协议到期", "date"),
            F("points", "积分", "int", min=0, list=True),
            F("points_on", "哪天查的", "date"),
            F("device", "挂在哪台设备"),
        ],
    },
    # ---------------- 软件订阅与直播
    "subscription": {
        "label": "软件订阅 / 席位", "group": "saas", "name_label": "软件和套餐", "name_hint": "比如 阿奇索自动发货",
        "fields": [
            F("category", "类别", "select", options=_sel(delivery="自动发货", browser="指纹浏览器", remote="远控坐席",
                                                       ai="AI / 接口额度", waybill="电子面单", cs="客服坐席",
                                                       live="直播工具", other="其他"), required=True, list=True),
            F("account", "登录账号", hint="密码不记"),
            F("seats", "几个席位", "int", min=0),
            F("monthly_cost", "月费", "money", list=True),
            F("expires_on", "到期", "date", list=True),
            F("reset_day", "额度每月几号清零", "int", min=1, max=31),
            F("min_version", "客户端最低版本", hint="比如 向日葵 Win 16.2.3"),
            F("shops", "授权给哪些店"),
        ],
    },
    "live_map": {
        "label": "抖店直播", "group": "saas", "name_label": "抖店",
        "fields": [
            F("shop_id", "台账里的店", "shop"),
            F("anchor", "开播抖音号", list=True),
            F("baiying", "百应 / 罗盘子账号"),
            F("talent", "合作达人", list=True),
            F("talent_end", "切片授权到期", "date", list=True),
            F("tools", "用的软件"),
        ],
    },
    # ---------------- 远控服务
    "remote_job": {
        "label": "远控单", "group": "remote", "name_label": "客户",
        "fields": [
            F("device_code", "客户识别码", list=True),
            F("seat", "用的哪个坐席"),
            F("started_on", "开始", "date"),
            F("finished_on", "完工", "date", list=True),
            F("revoked", "已从坐席设备列表移除", "bool", list=True),
            F("refreshed", "已提醒客户刷新验证码", "bool", list=True),
        ],
    },
    "lab_pc": {
        "label": "隔离机", "group": "remote", "name_label": "叫什么",
        "fields": [
            F("purpose", "用途", "select", options=_sel(learn="同行学习机", repro="干净复现机"), required=True, list=True),
            F("isolated", "网络物理隔离", "bool", list=True),
            F("stack", "装了什么采集", hint="比如 osquery + Fibratus + OBS"),
            F("last_reset_on", "上次还原快照", "date", list=True),
        ],
    },
    # ---------------- 代开店客户与合同
    "client_project": {
        "label": "代开店客户", "group": "client", "name_label": "客户",
        "fields": [
            F("stage", "到哪一步", "select", options=_sel(docs="收资料", license="办执照", sims="办卡（1 主 4 副）",
                                                        phones="改机", shops="开店（录人脸视频）", alipay="支付宝授权",
                                                        archived="档案入柜"), required=True, list=True),
            F("archive_no", "档案袋编号", "readonly", list=True),
            F("face_videos", "人脸视频几段", "int", min=0, max=5),
            F("fee", "服务费", "money", list=True),
            F("fee_due_on", "服务费哪天该收", "date"),
            F("fee_paid_on", "哪天收到", "date"),
            F("owner_staff", "谁负责", "staff", list=True),
        ],
    },
    "email_box": {
        "label": "企业邮箱", "group": "client", "name_label": "邮箱地址",
        "fields": [
            F("provider", "服务商"),
            F("holder", "谁在用", list=True),
            F("used_for", "绑了什么", list=True),
            F("expires_on", "到期", "date"),
        ],
    },
    "contract": {
        "label": "纸质合同", "group": "client", "name_label": "合同",
        "fields": [
            F("ctype", "类型", "select", options=_sel(nominee="代持", custody="托管", lease="租赁", service="服务",
                                                    labor="劳动", other="其他"), required=True, list=True),
            F("legal_person_id", "哪个法人", "lp"),
            F("party", "对方", list=True),
            F("signed_on", "签订", "date"),
            F("end_on", "到期", "date", list=True),
            F("cabinet", "原件放在哪", list=True),
        ],
    },
    "risk_ticket": {
        "label": "风控工单", "group": "client", "name_label": "事由",
        "fields": [
            F("tkind", "类型", "select", options=_sel(face="刷脸", sms="短信验证", appeal="申诉", other="其他"),
              required=True, list=True),
            F("shop_id", "哪家店", "shop", list=True),
            F("legal_person_id", "要谁配合", "lp"),
            F("opened_at", "什么时候来的", "datetime", required=True),
            F("sla_hours", "几小时内要办完", "int", min=1, max=720),
            F("resolved_at", "办完", "datetime", list=True),
            F("fee", "配合费", "money"),
        ],
    },
    # ---------------- 员工与离职
    "rebind_check": {
        "label": "换号核验单", "group": "staff", "name_label": "换号", "auto": True,
        "fields": [],
        "checklist": True,
    },
    # ---------------- 背调
    "bgcheck": {
        "label": "背调记录", "group": "bgcheck", "name_label": "查的谁",
        "fields": [
            F("subject", "是什么人", "select", options=_sel(nominee="代持法人", card_supplier="供卡人", finance="管钱岗",
                                                          other="其他"), required=True, list=True),
            F("legal_person_id", "台账里的法人", "lp"),
            F("checked_on", "查的日期", "date", required=True, list=True),
            F("result", "结果", "select", options=_sel(clean="没问题", watch="有记录，留意", high="高危（失信 / 限高 / 涉诉 / 涉诈）"),
              required=True, list=True),
            F("source", "怎么查的", hint="比如 天远"),
        ],
    },
    # ---------------- 服务器与硬件
    "server": {
        "label": "服务器", "group": "it", "name_label": "叫什么", "name_hint": "比如 京东云 117.72.221.15",
        "fields": [
            F("provider", "云厂商", list=True),
            F("ip", "IP", list=True),
            F("role", "跑什么"),
            F("disk_total_gb", "磁盘多大（G）", "int", min=0),
            F("disk_used_gb", "用了多少（G）", "int", min=0),
            F("disk_on", "哪天看的", "date"),
            F("expires_on", "续费到期", "date", list=True),
            F("admin_where", "root 密码放在哪", hint="密码本身不记"),
        ],
    },
    "domain": {
        "label": "域名 / 证书", "group": "it", "name_label": "域名", "name_hint": "比如 service.example.invalid",
        "fields": [
            F("registrar", "注册商"),
            F("expires_on", "域名到期", "date", list=True),
            F("cert_expires_on", "证书到期", "date", list=True, hint="点「查证书」自动填"),
            F("cert_auto", "证书自动续", "bool"),
        ],
        "actions": {"check_cert": "查证书"},
    },
    "hardware": {
        "label": "关键硬件", "group": "it", "name_label": "叫什么", "name_hint": "比如 RTX 5070 OCR 主机",
        "fields": [
            F("hkind", "类型", "select", options=_sel(compute="算力机", nas="NAS", pda="PDA", camera="高拍仪 / 监控",
                                                    pc="电脑", lock="门锁", other="其他"), required=True, list=True),
            F("location", "放在哪", list=True),
            F("custodian", "谁管"),
            F("single_point", "坏了没有备用", "bool", list=True),
            F("encrypted", "有加密盘", "bool"),
            F("key_where", "解密密钥放在哪", hint="密钥本身不记"),
            F("purchased_on", "买的日期", "date"),
            F("price", "价格", "money"),
            F("warranty_end", "保修到期", "date"),
        ],
    },
    "collect_account": {
        "label": "采集号", "group": "it", "name_label": "账号",
        "fields": [
            F("platform", "平台", required=True, list=True),
            F("purpose", "采什么", list=True),
            F("company_owned", "是公司的号", "bool", default=True, list=True),
            F("isolated", "和自营店隔离", "bool", default=True),
        ],
    },
    # ---------------- 房产场地
    "site": {
        "label": "租用场地", "group": "estate", "name_label": "叫什么", "name_hint": "比如 富阳总部",
        "fields": [
            F("address", "地址"),
            F("use", "用途", "select", options=_sel(office="办公", warehouse="仓库", prep="筹备中"), required=True, list=True),
            F("landlord", "房东"),
            F("rent", "月租", "money", list=True),
            F("deposit", "押金", "money"),
            F("lease_start", "起租", "date"),
            F("lease_end", "到期", "date", list=True),
            F("fire_ok", "消防验过", "bool"),
            F("utilities", "水电物业怎么分", "textarea"),
        ],
    },
    "property": {
        "label": "待盘活房产 / 车位", "group": "estate", "name_label": "叫什么", "name_hint": "比如 金汇之城 7-602",
        "fields": [
            F("address", "地址"),
            F("ptype", "类型", "select", options=_sel(home="住宅", shop="商铺 / 写字楼", parking="车位"), required=True,
              list=True),
            F("goal", "出租还是出售", "select", options=_sel(rent="出租", sell="出售"), required=True, list=True),
            F("price", "挂多少", "money", list=True),
            F("agent", "中介"),
            F("keys_with", "钥匙在谁那"),
            F("state", "进展", "select", options=_sel(idle="待挂", listed="在挂", showing="带看中", done="已租 / 已售"),
              required=True, list=True),
        ],
        "events": {
            "showing": {"label": "记一次带看", "fields": [F("on", "哪天", "date", required=True), F("who", "谁带的"),
                                                          F("result", "结果")]},
            "lead": {"label": "记一条员工线索", "fields": [F("staff", "谁发的", "staff", required=True),
                                                           F("commission", "特别佣金", "money", default="100"),
                                                           F("paid", "佣金已发", "bool")]},
        },
    },
}

# 每种条目的默认值（新建时填上）
_DEFAULTS = {"supplier": {"warn_below": "150"}, "fx_card": {"currency": "CNY"}, "peer": {"state": "found"},
             "property": {"state": "idle"}, "client_project": {"stage": "docs"}}


def catalog() -> dict:
    return {
        "groups": [{"key": g, "label": label, "kinds": [k for k, v in KINDS.items() if v["group"] == g]}
                   for g, label in GROUPS.items()],
        "kinds": {k: {key: v.get(key) for key in ("label", "group", "name_label", "name_hint", "fields", "events",
                                                   "checklist", "actions", "auto")}
                  for k, v in KINDS.items()},
        "secrets": SECRETS, "know_targets": KNOW_TARGETS, "currencies": CURRENCIES, "close_items": CLOSE_ITEMS,
    }


# ---------------------------------------------------------------- 字段校验

def _today() -> date:
    return lg._today()


def _now_cn() -> datetime:
    return datetime.utcnow() + timedelta(hours=8)


def _fields(kind: str) -> dict[str, dict]:
    return {f["key"]: f for f in KINDS[kind]["fields"]}


def _value(db: Session, f: dict, v):
    """一个字段的值：按类型校验、规整成存进 attrs 的样子（日期、钱都存字符串）。"""
    t, label = f["type"], f["label"]
    if isinstance(v, str):
        v = v.strip()
    if v in ("", None):
        return False if t == "bool" else None
    if t == "bool":
        return bool(v)
    if t in ("text", "textarea"):
        top = 2000 if t == "textarea" else 255
        if len(str(v)) > top:
            raise HTTPException(status_code=400, detail=f"{label}太长了")
        return str(v)
    if t == "phone":
        return lg.norm_phone(str(v))
    if t == "date":
        return lg._day(v, label).isoformat()
    if t == "month":
        if not re.fullmatch(r"\d{4}-\d{2}", str(v)) or not 1 <= int(str(v)[5:]) <= 12:
            raise HTTPException(status_code=400, detail=f"{label}要写成 2026-11 这样")
        return str(v)
    if t == "datetime":
        try:
            return datetime.fromisoformat(str(v).replace("T", " ")[:16]).strftime("%Y-%m-%d %H:%M")
        except ValueError:
            raise HTTPException(status_code=400, detail=f"{label}要写成 2026-11-15 14:30 这样") from None
    if t == "money":
        return lg._d(lg._money(v, label).quantize(CENT))
    if t == "int":
        try:
            n = int(v)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"{label}要填整数") from None
        if ("min" in f and n < f["min"]) or ("max" in f and n > f["max"]):
            raise HTTPException(status_code=400, detail=f"{label}不对")
        return n
    if t == "select":
        if v not in f["options"]:
            raise HTTPException(status_code=400, detail=f"{label}不对")
        return v
    if t == "staff":
        s = db.get(Staff, v)
        if s is None:
            raise HTTPException(status_code=400, detail=f"{label}：没有这个员工")
        return v
    if t == "shop":
        if db.get(LedgerShop, v) is None:
            raise HTTPException(status_code=400, detail=f"{label}：台账里没有这家店")
        return v
    raise HTTPException(status_code=400, detail=f"{label}不对")


def _apply(db: Session, rec: LedgerRecord, data: dict) -> None:
    kind = KINDS[rec.kind]
    if "name" in data:
        rec.name = lg._clean(data.get("name"))
    if not rec.name and rec.kind != "close_month":
        raise HTTPException(status_code=400, detail=f"{kind['name_label']}不能为空")
    if rec.name and len(rec.name) > 128:
        raise HTTPException(status_code=400, detail=f"{kind['name_label']}太长了")
    attrs = dict(rec.attrs or {})
    for key, f in _fields(rec.kind).items():
        if key not in data or f["type"] == "readonly":
            continue
        v = data[key]
        if f["type"] in ("entity", "lp", "parent"):
            v = lg._clean(v)
            if f["type"] == "entity":
                if v:
                    lg._get(db, "entity", v)
                rec.entity_id = v
            elif f["type"] == "lp":
                if v:
                    lg._get(db, "legal_person", v)
                rec.legal_person_id = v
            else:
                if v:
                    p = db.get(LedgerRecord, v)
                    if p is None or p.kind != f["of"] or p.id == rec.id:
                        raise HTTPException(status_code=400, detail=f"{f['label']}不存在或已删除")
                rec.parent_id = v
            continue
        attrs[key] = _value(db, f, v)
    for key, f in _fields(rec.kind).items():
        if not f.get("required"):
            continue
        have = {"entity": rec.entity_id, "lp": rec.legal_person_id, "parent": rec.parent_id}.get(f["type"], attrs.get(key))
        if have in (None, ""):
            raise HTTPException(status_code=400, detail=f"{f['label']}要填")
    for k in ("status", "note"):
        if k in data:
            v = lg._clean(data[k])
            if k == "status" and v not in lg.STATUSES:
                raise HTTPException(status_code=400, detail="状态不对")
            setattr(rec, k, v)
    rec.attrs = attrs


def _last4(v: str | None, what: str) -> None:
    if v is not None and not re.fullmatch(r"\d{4}", v):
        raise HTTPException(status_code=400, detail=f"{what}只记后 4 位数字，完整号码不进台账")


def _same(db: Session, kind: str, rec: LedgerRecord, **where):
    q = db.query(LedgerRecord).filter(LedgerRecord.kind == kind, LedgerRecord.id != (rec.id or ""),
                                      LedgerRecord.status != "closed")
    for k, v in where.items():
        q = q.filter(getattr(LedgerRecord, k) == v)
    return q.all()


def _who(db: Session, staff_id: str | None, text: str | None) -> str | None:
    """「谁拿着」：员工按 id，外面的人按名字。"""
    if staff_id:
        return f"staff:{staff_id}"
    return f"text:{text}" if text else None


def _check(db: Session, rec: LedgerRecord, before: dict) -> None:
    a = rec.attrs
    k = rec.kind
    if k == "bank_account":
        _last4(a.get("last4"), "账号")
        if a.get("acct_type") == "basic" and rec.status != "closed":
            for o in _same(db, k, rec, entity_id=rec.entity_id):
                if (o.attrs or {}).get("acct_type") == "basic":
                    raise HTTPException(status_code=400, detail=f"一个主体只能有一个基本户，已经有「{o.name}」了")
    elif k == "fx_card":
        _last4(a.get("last4"), "卡号")
    elif k == "ukey":
        if a.get("role") == "readonly":
            if not a.get("holder") and not a.get("holder_staff"):
                raise HTTPException(status_code=400, detail="只读查账号要写给了谁（比如 桐新代账）")
        elif not a.get("holder") and not a.get("holder_staff"):
            raise HTTPException(status_code=400, detail="U 盾要写在谁手里")
        me = _who(db, a.get("holder_staff"), a.get("holder"))
        other_role = {"maker": "checker", "checker": "maker"}.get(a.get("role"))
        if other_role and rec.status != "closed":
            for o in _same(db, k, rec, parent_id=rec.parent_id):
                oa = o.attrs or {}
                if oa.get("role") == other_role and _who(db, oa.get("holder_staff"), oa.get("holder")) == me:
                    raise HTTPException(status_code=400, detail=f"制单和复核不能在同一个人手里（「{o.name}」也在他手里）")
    elif k == "seal":
        if not a.get("custodian_staff") and not a.get("custodian"):
            raise HTTPException(status_code=400, detail="印章要写谁管")
        other = {"finance": "legal", "legal": "finance"}.get(a.get("seal_type"))
        me = _who(db, a.get("custodian_staff"), a.get("custodian"))
        if other and rec.status != "closed":
            for o in _same(db, k, rec, entity_id=rec.entity_id):
                oa = o.attrs or {}
                if oa.get("seal_type") == other and _who(db, oa.get("custodian_staff"), oa.get("custodian")) == me:
                    raise HTTPException(status_code=400, detail="财务章和法人章要两个人分开管")
    elif k == "invoice":
        if a.get("color") == "red" and not a.get("orig_no"):
            raise HTTPException(status_code=400, detail="红字发票要填冲的是哪张蓝票")
        if a.get("color") != "red":
            a.pop("approved_by", None)
    elif k == "close_month":
        if not rec.name:
            rec.name = "桐新"
        if any((o.attrs or {}).get("month") == a.get("month") for o in _same(db, k, rec, name=rec.name)):
            raise HTTPException(status_code=400, detail=f"{rec.name} {a.get('month')} 已经有了")
    elif k == "tax_filing":
        if a.get("submitted_by") == a.get("reviewed_by"):
            raise HTTPException(status_code=400, detail="提交人和复核人不能是同一个人")
        if a.get("tax") == "vat" and not re.fullmatch(r"\d{4}Q[1-4]", a.get("period") or ""):
            raise HTTPException(status_code=400, detail="增值税按季度报，所属期写成 2026Q3 这样")
    elif k == "merchant":
        for o in _same(db, k, rec):
            oa = o.attrs or {}
            if oa.get("provider") == a.get("provider") and oa.get("mch_no") == a.get("mch_no"):
                raise HTTPException(status_code=400, detail=f"商户号 {a.get('mch_no')} 已经记过了（「{o.name}」）")
        if rec.parent_id:
            bank = db.get(LedgerRecord, rec.parent_id)
            if bank.entity_id != rec.entity_id:
                raise HTTPException(status_code=400, detail="商户号的钱只能结算进同一个主体的对公户 / 经营者卡")
    elif k == "offline_deal":
        if Decimal(a.get("deal_amount") or 0) >= LARGE_DEAL and (not a.get("xianyu_order") or not a.get("screenshot_ok")):
            raise HTTPException(status_code=400, detail="1000 元以上的微信成交要挂原闲鱼订单号，并留好原订单关闭的截图")
    elif k == "peer":
        if a.get("state") == "partner" and not a.get("payee"):
            raise HTTPException(status_code=400, detail="改成「已合作」前要有实名收款人")
    elif k == "member_pool":
        if a.get("mkind") == "shared" and not a.get("holder"):
            raise HTTPException(status_code=400, detail="协议共管的号要写会员是谁的")
    elif k == "remote_job":
        if rec.status == "closed" and not (a.get("revoked") and a.get("refreshed")):
            raise HTTPException(status_code=400, detail="完工要先撤权：从坐席设备列表移除、提醒客户刷新验证码，两样都勾上才能关")
    elif k == "risk_ticket":
        if a.get("resolved_at") and a["resolved_at"] < (a.get("opened_at") or ""):
            raise HTTPException(status_code=400, detail="办完的时间不能比来的时间早")


def _archive_no(db: Session) -> str:
    """代开店档案袋编号 DA-年份-四位流水。"""
    year = _today().year
    prefix = f"DA-{year}-"
    n = 0
    for (a,) in db.query(LedgerRecord.attrs).filter(LedgerRecord.kind == "client_project").all():
        no = (a or {}).get("archive_no") or ""
        if no.startswith(prefix) and no[len(prefix):].isdigit():
            n = max(n, int(no[len(prefix):]))
    return f"{prefix}{n + 1:04d}"


def _get(db: Session, rid: str) -> LedgerRecord:
    rec = db.get(LedgerRecord, rid)
    if rec is None:
        raise HTTPException(status_code=404, detail="这条不存在或已删除")
    return rec


def create(db: Session, staff: Staff, kind: str, data: dict) -> LedgerRecord:
    if kind not in KINDS or KINDS[kind].get("auto"):
        raise HTTPException(status_code=400, detail="没有这种台账")
    rec = LedgerRecord(kind=kind, name="", attrs={}, status="active", created_by_id=staff.id, needs_check=False)
    defaults = {f["key"]: f["default"] for f in KINDS[kind]["fields"] if "default" in f}
    _apply(db, rec, {**defaults, **_DEFAULTS.get(kind, {}), **data})
    if kind == "client_project":
        rec.attrs = {**rec.attrs, "archive_no": _archive_no(db)}
    _check(db, rec, {})
    db.add(rec)
    db.flush()
    lg.log(db, staff, "create", "record", rec.id, f"{KINDS[kind]['label']} {rec.name}")
    return rec


def update(db: Session, staff: Staff, rid: str, data: dict) -> LedgerRecord:
    rec = _get(db, rid)
    before = {"attrs": dict(rec.attrs or {}), "status": rec.status}
    _apply(db, rec, data)
    _check(db, rec, before)
    lg.log(db, staff, "update", "record", rec.id, ",".join(sorted(data)))
    return rec


def delete(db: Session, staff: Staff, rid: str) -> None:
    rec = _get(db, rid)
    if db.query(LedgerRecord.id).filter(LedgerRecord.parent_id == rec.id).first() is not None:
        raise HTTPException(status_code=400, detail="下面还挂着东西（U 盾、商户号），先删掉或挪走")
    db.query(LedgerRecordEvent).filter(LedgerRecordEvent.record_id == rec.id).delete(synchronize_session=False)
    forget_target(db, "record", rec.id)
    lg.log(db, staff, "delete", "record", rec.id, f"{KINDS.get(rec.kind, {}).get('label', rec.kind)} {rec.name}")
    db.delete(rec)


# ---------------------------------------------------------------- 流水、清单、动作

def add_event(db: Session, staff: Staff, rid: str, ev: str, data: dict) -> LedgerRecord:
    rec = _get(db, rid)
    spec = (KINDS[rec.kind].get("events") or {}).get(ev)
    if spec is None:
        raise HTTPException(status_code=400, detail="这条不能这样记")
    a = dict(rec.attrs or {})
    for k, v in (spec.get("only") or {}).items():
        if a.get(k) != v:
            raise HTTPException(status_code=400, detail="只有红字发票要批准")
    out = {}
    for f in spec["fields"]:
        v = _value(db, f, data.get(f["key"], f.get("default")))
        if f.get("required") and v in (None, ""):
            raise HTTPException(status_code=400, detail=f"{f['label']}要填")
        out[f["key"]] = v
    today = _today().isoformat()
    if rec.kind == "seal" and ev == "lend":
        if a.get("lent"):
            raise HTTPException(status_code=400, detail=f"已经借给 {a['lent'].get('to')} 了，还回来才能再借")
        a["lent"] = {**out, "on": today}
    elif rec.kind == "seal" and ev == "return":
        if not a.get("lent"):
            raise HTTPException(status_code=400, detail="这枚章没借出去")
        out["lent"] = a.pop("lent")
    elif rec.kind == "invoice" and ev == "approve":
        if a.get("approved_by"):
            raise HTTPException(status_code=400, detail="已经批过了")
        a["approved_by"], a["approved_on"] = staff.id, today
    elif rec.kind == "supplier" and ev == "recharge":
        a["balance"] = lg._d((Decimal(a.get("balance") or 0) + Decimal(out["amount"])).quantize(CENT))
        a["balance_on"] = today
    elif rec.kind == "supplier" and ev == "balance":
        a["balance"], a["balance_on"] = out["balance"], today
    elif rec.kind == "property" and ev == "showing":
        a["last_showing"] = max(a.get("last_showing") or "", out["on"])
        if a.get("state") in ("idle", "listed"):
            a["state"] = "showing"
    rec.attrs = a
    db.add(LedgerRecordEvent(record_id=rec.id, kind=ev, data=out, staff_id=staff.id))
    lg.log(db, staff, "update", "record", rec.id, f"{spec['label']}")
    return rec


def events(db: Session, rid: str) -> list[dict]:
    rec = _get(db, rid)
    specs = {**(KINDS[rec.kind].get("events") or {}), "tick": {"label": "打勾"}, "untick": {"label": "取消打勾"}}
    names = _staff_names(db)
    return [
        {"id": e.id, "kind": e.kind, "label": specs.get(e.kind, {}).get("label", e.kind), "data": e.data or {},
         "text": _event_text(rec, e, names), "staff": names.get(e.staff_id), "created_at": _cn(e.created_at)}
        for e in db.query(LedgerRecordEvent).filter(LedgerRecordEvent.record_id == rec.id)
        .order_by(LedgerRecordEvent.created_at.desc()).limit(100)
    ]


def _event_text(rec: LedgerRecord, e: LedgerRecordEvent, names: dict) -> str:
    spec = (KINDS[rec.kind].get("events") or {}).get(e.kind)
    d = e.data or {}
    if e.kind in ("tick", "untick"):
        return d.get("label") or d.get("item") or ""
    if spec is None:
        return ""
    parts = []
    for f in spec["fields"]:
        v = d.get(f["key"])
        if v in (None, "", False):
            continue
        if f["type"] == "staff":
            v = names.get(v, "已删的员工")
        elif f["type"] == "bool":
            v = "是"
        elif f["type"] == "money":
            v = f"¥{v}"
        parts.append(f"{f['label']} {v}")
    return "，".join(parts)


def _close_items(rec: LedgerRecord) -> list[tuple[str, str, date]]:
    """代账月结的三件事和各自哪天该到。"""
    y, m = (int(x) for x in (rec.attrs or {})["month"].split("-"))
    last = calendar.monthrange(y, m)[1]
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
    due = {"handover": date(y, m, min(30, last)), "reports": date(ny, nm, 10), "tax_receipt": date(ny, nm, 15)}
    return [(key, label, due[key]) for key, label, _ in CLOSE_ITEMS]


def checklist(rec: LedgerRecord) -> list[dict]:
    a = rec.attrs or {}
    done = a.get("done") or {}
    if rec.kind == "close_month":
        items = [{"key": k, "label": label, "due": d.isoformat()} for k, label, d in _close_items(rec)]
    else:
        items = [{"key": i["key"], "label": i["label"], "due": None} for i in a.get("items") or []]
    return [{**i, "done": i["key"] in done, "done_on": (done.get(i["key"]) or {}).get("on")} for i in items]


def tick(db: Session, staff: Staff, rid: str, item: str, on: bool) -> LedgerRecord:
    rec = _get(db, rid)
    if not KINDS[rec.kind].get("checklist"):
        raise HTTPException(status_code=400, detail="这条没有清单")
    items = {i["key"]: i for i in checklist(rec)}
    if item not in items:
        raise HTTPException(status_code=400, detail="清单里没有这一项")
    a = dict(rec.attrs or {})
    done = dict(a.get("done") or {})
    if on:
        done[item] = {"by": staff.id, "on": _today().isoformat()}
    else:
        done.pop(item, None)
    a["done"] = done
    rec.attrs = a
    db.add(LedgerRecordEvent(record_id=rec.id, kind="tick" if on else "untick",
                             data={"item": item, "label": items[item]["label"]}, staff_id=staff.id))
    lg.log(db, staff, "update", "record", rec.id, f"{'打勾' if on else '取消打勾'} {items[item]['label']}")
    return rec


def cert_expiry(host: str, timeout: float = 5.0) -> date:
    """连一下 443，读证书到期日。"""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with socket.create_connection((host, 443), timeout=timeout) as sock, ctx.wrap_socket(sock, server_hostname=host) as s:
        der = s.getpeercert(binary_form=True)
    from cryptography import x509

    cert = x509.load_der_x509_certificate(der)
    end = getattr(cert, "not_valid_after_utc", None) or cert.not_valid_after
    return (end + timedelta(hours=8)).date()


def check_cert(db: Session, staff: Staff, rid: str) -> LedgerRecord:
    rec = _get(db, rid)
    if rec.kind != "domain":
        raise HTTPException(status_code=400, detail="只有域名能查证书")
    host = (rec.name or "").strip().lower().removeprefix("https://").split("/")[0]
    if not re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", host):
        raise HTTPException(status_code=400, detail="域名写得不对，比如 service.example.invalid")
    try:
        end = cert_expiry(host)
    except Exception as e:  # noqa: BLE001 — 连不上、没证书都只回一句话
        raise HTTPException(status_code=502, detail=f"连不上 {host}:443，没查到证书（{type(e).__name__}）") from None
    rec.attrs = {**(rec.attrs or {}), "cert_expires_on": end.isoformat(), "cert_checked_on": _today().isoformat()}
    lg.log(db, staff, "update", "record", rec.id, f"查证书：{end.isoformat()} 到期")
    return rec


# ---------------------------------------------------------------- 换号核验单（换号时自动建）

def rebind_checklist(db: Session, staff: Staff, old_phone: str, new_phone: str, uses: list[dict]) -> LedgerRecord:
    """台账里的号码已经换了，平台那边要人一处处去改：每处一项，改完打勾。"""
    items, seen = [], set()
    for u in uses:
        if u["what"] == "插在":
            continue
        label = f"{u['what']}：{u['name']}"
        if label not in seen:
            seen.add(label)
            items.append({"key": f"i{len(items) + 1}", "label": f"去平台把{label}改成新号"})
    for fixed in ("电子税务局、工商登记里的联系手机", "邮箱、云账号、银行预留手机里有没有用旧号"):
        items.append({"key": f"i{len(items) + 1}", "label": f"查一遍{fixed}"})
    rec = LedgerRecord(kind="rebind_check", name=f"{old_phone} → {new_phone}", attrs={"items": items, "done": {}},
                       status="active", created_by_id=staff.id, needs_check=False)
    db.add(rec)
    db.flush()
    lg.log(db, staff, "create", "record", rec.id, f"换号核验单 {rec.name}")
    return rec


# ---------------------------------------------------------------- 谁知道密码

def departed(db: Session) -> set[str]:
    """离职（停用或删了）的员工。"""
    return {i for (i,) in db.query(Staff.id).filter(
        (Staff.deleted_at.isnot(None)) | (Staff.status == StaffStatus.DISABLED)).all()}


def _staff_names(db: Session) -> dict[str, str]:
    return {i: n or u for i, n, u in db.query(Staff.id, Staff.name, Staff.username).all()}


def _target_label(db: Session, ttype: str, tid: str) -> str | None:
    if ttype == "device":
        d = db.get(LedgerDevice, tid)
        return d and f"设备 {d.name}"
    if ttype == "alipay":
        a = db.get(LedgerAlipay, tid)
        return a and f"支付宝 {a.account}"
    if ttype == "shop":
        s = db.get(LedgerShop, tid)
        return s and f"{lg.PLATFORMS.get(s.platform, s.platform)}店 {s.name}"
    if ttype == "record":
        r = db.get(LedgerRecord, tid)
        return r and f"{KINDS.get(r.kind, {}).get('label', r.kind)} {r.name}"
    return None


def targets(db: Session, q: str | None) -> list[dict]:
    """「谁知道密码」里选是哪个东西：设备、支付宝、店铺、台账条目，按名字搜。"""
    like = f"%{(q or '').strip()}%"
    out = []
    for d in db.query(LedgerDevice).filter(LedgerDevice.name.like(like)).limit(20):
        out.append({"type": "device", "id": d.id, "label": f"设备 {d.name}"})
    for a in db.query(LedgerAlipay).filter(LedgerAlipay.account.like(like)).limit(20):
        out.append({"type": "alipay", "id": a.id, "label": f"支付宝 {a.account}"})
    for s in db.query(LedgerShop).filter(LedgerShop.name.like(like)).limit(20):
        out.append({"type": "shop", "id": s.id, "label": f"{lg.PLATFORMS.get(s.platform, s.platform)}店 {s.name}"})
    for r in db.query(LedgerRecord).filter(LedgerRecord.name.like(like), LedgerRecord.kind != "rebind_check").limit(20):
        out.append({"type": "record", "id": r.id, "label": f"{KINDS.get(r.kind, {}).get('label', r.kind)} {r.name}"})
    return out


def knows_list(db: Session) -> list[dict]:
    names, gone = _staff_names(db), departed(db)
    rows = db.query(LedgerKnows).order_by(LedgerKnows.created_at.desc()).all()
    return [
        {"id": k.id, "target_type": k.target_type, "target_id": k.target_id,
         "target": _target_label(db, k.target_type, k.target_id) or "已删的东西", "what": k.what,
         "what_label": SECRETS.get(k.what, k.what), "staff_id": k.staff_id, "staff": names.get(k.staff_id, "已删的员工"),
         "departed": k.staff_id in gone, "created_at": _cn(k.created_at)}
        for k in rows
    ]


def add_knows(db: Session, staff: Staff, *, target_type: str, target_id: str, what: str, staff_ids: list[str]) -> int:
    if target_type not in KNOW_TARGETS:
        raise HTTPException(status_code=400, detail="选是哪个东西")
    if _target_label(db, target_type, target_id) is None:
        raise HTTPException(status_code=400, detail="这个东西不存在或已删除")
    if what not in SECRETS:
        raise HTTPException(status_code=400, detail="选是什么密码")
    if not staff_ids:
        raise HTTPException(status_code=400, detail="选谁知道")
    n = 0
    for sid in dict.fromkeys(staff_ids):
        if db.get(Staff, sid) is None:
            raise HTTPException(status_code=400, detail="没有这个员工")
        hit = db.query(LedgerKnows.id).filter(LedgerKnows.target_type == target_type, LedgerKnows.target_id == target_id,
                                              LedgerKnows.what == what, LedgerKnows.staff_id == sid).first()
        if hit is None:
            db.add(LedgerKnows(target_type=target_type, target_id=target_id, what=what, staff_id=sid, created_by_id=staff.id))
            n += 1
    lg.log(db, staff, "update", target_type, target_id, f"记 {n} 人知道{SECRETS[what]}")
    return n


def rotated(db: Session, staff: Staff, kid: str) -> None:
    """密码改好了：这个人不再知道，删掉这一行。"""
    k = db.get(LedgerKnows, kid)
    if k is None:
        raise HTTPException(status_code=404, detail="这条不存在或已经改过了")
    label = _target_label(db, k.target_type, k.target_id) or "已删的东西"
    lg.log(db, staff, "update", k.target_type, k.target_id,
           f"{SECRETS.get(k.what, k.what)}改好了，{_staff_names(db).get(k.staff_id, '')} 不再知道（{label}）")
    db.delete(k)


def forget_target(db: Session, ttype: str, tid: str) -> None:
    """东西删了，谁知道它的密码也不用记了。"""
    db.query(LedgerKnows).filter(LedgerKnows.target_type == ttype, LedgerKnows.target_id == tid).delete(
        synchronize_session=False)


def employee_sims(db: Session) -> list[dict]:
    names, gone = _staff_names(db), departed(db)
    today = _today()
    phones = {c.id: c.phone for c in db.query(LedgerSim).all()}
    slots = lg._sim_slots(db, list(phones))
    lps = dict(db.query(LedgerLegalPerson.id, LedgerLegalPerson.name).all())
    return [
        {**lg.sim_out(c, today, phones=phones, slots=slots, gone=gone, staff_names=names),
         "legal_person": lps.get(c.legal_person_id)}
        for c in db.query(LedgerSim).filter(LedgerSim.category == "employee").order_by(LedgerSim.created_at).all()
    ]


# ---------------------------------------------------------------- 提醒

def _cn(dt: datetime | None) -> str | None:
    return (dt + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M") if dt else None


def _ddate(v) -> date | None:
    try:
        return date.fromisoformat(v) if v else None
    except ValueError:
        return None


def _due(what: str, d: date | None, today: date, days: int = WARN_DAYS, *, past: str = "到期了") -> list[dict]:
    if not d:
        return []
    left = (d - today).days
    if left < 0:
        return [{"level": "danger", "text": f"{what} {lg._days(d)}{past}"}]
    if left <= days:
        return [{"level": "warn", "text": f"{what}还有 {left} 天到期（{lg._days(d)}）"}]
    return []


def _next_day_of_month(day: int, today: date) -> date:
    """下一个「每月 day 号」（月份短的取月底）。"""
    y, m = today.year, today.month
    for _ in range(2):
        d = date(y, m, min(day, calendar.monthrange(y, m)[1]))
        if d >= today:
            return d
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return d


def alerts(rec: LedgerRecord, ctx: dict) -> list[dict]:
    if rec.status == "closed":
        return []
    a, k, today = rec.attrs or {}, rec.kind, ctx["today"]
    out: list[dict] = []
    if k == "bank_account":
        ph = a.get("reserved_phone")
        sim = ctx["sims"].get(ph or "")
        if not ph:
            out.append({"level": "warn", "text": "没记银行预留手机号"})
        elif sim is None:
            out.append({"level": "danger", "text": f"预留手机号 {ph} 不是台账里的卡，要掌握在公司手里"})
        elif sim.category == "employee":
            out.append({"level": "danger", "text": f"预留手机号 {ph} 是员工名下的卡"})
        roles = {(c.attrs or {}).get("role") for c in ctx["children"].get(rec.id, []) if c.status != "closed"}
        if "maker" in roles and "checker" not in roles:
            out.append({"level": "warn", "text": "只有制单 U 盾，没有复核 U 盾"})
    elif k == "seal":
        lent = a.get("lent")
        if lent:
            back = _ddate(lent.get("due_back"))
            if back and back < today:
                out.append({"level": "danger", "text": f"借给 {lent.get('to')}（{lent.get('purpose')}），{lg._days(back)}该还，还没还"})
            else:
                out.append({"level": "warn", "text": f"借给 {lent.get('to')} 了（{lent.get('purpose')}），还没还"})
    elif k == "invoice":
        if a.get("color") == "red" and not a.get("approved_by"):
            out.append({"level": "warn", "text": "红字发票等老板批"})
    elif k in ("close_month", "rebind_check"):
        done = a.get("done") or {}
        if k == "close_month":
            for key, label, d in _close_items(rec):
                if key in done:
                    continue
                short = label.split("（")[0]
                if d < today:
                    out.append({"level": "danger", "text": f"{a['month']} 的{short}：{lg._days(d)}该到，还没到"})
                elif (d - today).days <= 3:
                    out.append({"level": "warn", "text": f"{a['month']} 的{short}：{lg._days(d)}要到"})
        else:
            left = [i for i in a.get("items") or [] if i["key"] not in done]
            if left:
                out.append({"level": "warn", "text": f"换号后还有 {len(left)} 处要去外面改"})
    elif k == "elicense":
        out += _due("经办人授权", _ddate(a.get("expires_on")), today)
    elif k == "merchant":
        out += _due("证书", _ddate(a.get("cert_expires_on")), today)
        if not rec.parent_id:
            out.append({"level": "warn", "text": "没记结算到哪个对公户"})
    elif k == "offline_deal":
        if a.get("refund_state") == "pending":
            old = (today - (rec.created_at + timedelta(hours=8)).date()).days if rec.created_at else 0
            out.append({"level": "danger" if old > 7 else "warn",
                        "text": f"闲鱼退款还没到账{f'（{old} 天了）' if old else ''}，到账前别冲减采购成本"})
    elif k == "fx_card":
        if a.get("due_day"):
            d = _next_day_of_month(a["due_day"], today)
            if (d - today).days <= 3:
                out.append({"level": "warn", "text": f"{lg._days(d)}是还款日"})
        if a.get("expires"):
            y, m = (int(x) for x in a["expires"].split("-"))
            out += _due("卡", date(y, m, calendar.monthrange(y, m)[1]), today, 60)
        if a.get("otp_phone") and a["otp_phone"] not in ctx["sims"]:
            out.append({"level": "warn", "text": f"收 3DS 验证码的 {a['otp_phone']} 不是台账里的卡"})
    elif k in ("overseas_sim", "email_box"):
        out += _due("", _ddate(a.get("expires_on")), today)
    elif k == "supplier":
        bal, floor = a.get("balance"), a.get("warn_below")
        if bal is not None and floor is not None and Decimal(bal) < Decimal(floor):
            out.append({"level": "danger", "text": f"余额只剩 ¥{Decimal(bal):,.2f}，低于 ¥{Decimal(floor):,.0f} 要充了，不然断供"})
    elif k == "peer":
        if a.get("state") == "partner" and not a.get("can_invoice"):
            out.append({"level": "warn", "text": "开不了票，打给他的钱月底会进异常付款清单"})
    elif k == "member_pool":
        if a.get("mkind") == "shared":
            if not a.get("agreement"):
                out.append({"level": "danger", "text": "协议共管的号还没签协议"})
            out += _due("共管协议", _ddate(a.get("agreement_end")), today)
    elif k == "subscription":
        out += _due("", _ddate(a.get("expires_on")), today, 7)
        if out and a.get("category") == "delivery":
            out = [{"level": "danger", "text": x["text"] + "，自动发货一断就超时赔付"} for x in out]
        if a.get("reset_day"):
            d = _next_day_of_month(a["reset_day"], today)
            if (d - today).days <= 3:
                out.append({"level": "warn", "text": f"{lg._days(d)}额度清零，没用完的先用掉"})
    elif k == "live_map":
        out += _due("达人切片授权", _ddate(a.get("talent_end")), today)
    elif k == "remote_job":
        if a.get("finished_on") and not (a.get("revoked") and a.get("refreshed")):
            miss = "、".join(x for x, ok in (("从设备列表移除", a.get("revoked")), ("提醒客户刷新验证码", a.get("refreshed")))
                             if not ok)
            out.append({"level": "danger", "text": f"完工了还没撤权：{miss}"})
    elif k == "lab_pc":
        if not a.get("isolated"):
            out.append({"level": "danger", "text": "没有物理隔离"})
        last = _ddate(a.get("last_reset_on"))
        if a.get("purpose") == "repro" and last and (today - last).days > 30:
            out.append({"level": "warn", "text": f"{(today - last).days} 天没还原快照了"})
    elif k == "client_project":
        due, paid = _ddate(a.get("fee_due_on")), a.get("fee_paid_on")
        if due and not paid and due < today:
            late = (today - due).days
            out.append({"level": "danger" if late > FEE_OVERDUE_DAYS else "warn", "text": f"服务费逾期 {late} 天没收"})
        stages = list(_fields("client_project")["stage"]["options"])
        if a.get("stage") in stages[stages.index("alipay"):] and (a.get("face_videos") or 0) < 5:
            out.append({"level": "warn", "text": f"人脸视频只有 {a.get('face_videos') or 0} 段（要 5 段）"})
    elif k == "contract":
        out += _due("", _ddate(a.get("end_on")), today)
        if a.get("ctype") == "nominee" and not a.get("cabinet"):
            out.append({"level": "warn", "text": "代持协议纸质原件放在哪没记"})
    elif k == "risk_ticket":
        if not a.get("resolved_at") and a.get("opened_at"):
            opened = datetime.strptime(a["opened_at"], "%Y-%m-%d %H:%M")
            if a.get("sla_hours"):
                over = (ctx["now"] - opened - timedelta(hours=a["sla_hours"])).total_seconds() / 3600
                if over > 0:
                    out.append({"level": "danger", "text": f"超时 {over:.0f} 小时还没办完"})
                else:
                    out.append({"level": "warn", "text": f"还剩 {-over:.0f} 小时"})
            else:
                out.append({"level": "warn", "text": "还没办完"})
    elif k == "bgcheck":
        if rec.id in ctx["latest_bg"]:
            d = _ddate(a.get("checked_on"))
            if a.get("result") == "high":
                out.append({"level": "danger", "text": "高危：失信 / 限高 / 涉诉 / 涉诈，名下的钱可能被冻结"})
            if d and (today - d).days > BGCHECK_DAYS:
                out.append({"level": "warn", "text": f"上次背调 {(today - d).days} 天前了，90 天要复查"})
    elif k == "server":
        total, used = a.get("disk_total_gb"), a.get("disk_used_gb")
        if total and used is not None:
            pct, free = used / total, total - used
            if pct >= 0.75 or free < 30:
                out.append({"level": "danger" if pct >= 0.9 or free < 10 else "warn",
                            "text": f"磁盘用了 {pct:.0%}，只剩 {free}G"})
        out += _due("续费", _ddate(a.get("expires_on")), today)
    elif k == "domain":
        out += _due("域名", _ddate(a.get("expires_on")), today)
        out += _due("证书", _ddate(a.get("cert_expires_on")), today, 14)
    elif k == "hardware":
        if a.get("encrypted") and not a.get("key_where"):
            out.append({"level": "danger", "text": "加密盘的解密密钥放在哪没记，断电重启会锁死"})
        out += _due("保修", _ddate(a.get("warranty_end")), today)
    elif k == "collect_account":
        if not a.get("company_owned"):
            out.append({"level": "danger", "text": "个人号不能当采集号"})
        if not a.get("isolated"):
            out.append({"level": "warn", "text": "没和自营店隔离"})
    elif k == "site":
        out += _due("租约", _ddate(a.get("lease_end")), today, 60)
    elif k == "property":
        if a.get("state") in ("listed", "showing"):
            last = _ddate(a.get("last_showing"))
            since = (today - last).days if last else None
            if since is None or since > 30:
                out.append({"level": "warn", "text": "一直没人带看" if since is None else f"{since} 天没人带看了"})
    return [x for x in out if x["text"].strip()]


def _ctx(db: Session, recs: list[LedgerRecord]) -> dict:
    children: dict[str, list] = {}
    for r in recs:
        if r.parent_id:
            children.setdefault(r.parent_id, []).append(r)
    latest: dict[str, LedgerRecord] = {}
    for r in recs:
        if r.kind == "bgcheck" and r.status != "closed":
            key = r.legal_person_id or f"name:{r.name}"
            if key not in latest or (r.attrs or {}).get("checked_on", "") > (latest[key].attrs or {}).get("checked_on", ""):
                latest[key] = r
    return {"today": _today(), "now": _now_cn(), "children": children,
            "sims": {c.phone: c for c in db.query(LedgerSim).filter(LedgerSim.status != "closed").all()},
            "latest_bg": {r.id for r in latest.values()}}


def _views(db: Session, recs: list[LedgerRecord]) -> dict[str, dict]:
    """列表上要给人看的名字：主体、法人、上一条、员工、店铺。"""
    names = _staff_names(db)
    ents = dict(db.query(LedgerEntity.id, LedgerEntity.name).all())
    lps = dict(db.query(LedgerLegalPerson.id, LedgerLegalPerson.name).all())
    parents = {r.id: r.name for r in db.query(LedgerRecord).filter(
        LedgerRecord.id.in_({r.parent_id for r in recs if r.parent_id})).all()} if recs else {}
    shop_ids = {v for r in recs for f in KINDS[r.kind]["fields"] if f["type"] == "shop" for v in [(r.attrs or {}).get(f["key"])] if v}
    shops = dict(db.query(LedgerShop.id, LedgerShop.name).filter(LedgerShop.id.in_(shop_ids)).all()) if shop_ids else {}
    out = {}
    for r in recs:
        a = r.attrs or {}
        v = {}
        for f in KINDS[r.kind]["fields"]:
            t, key = f["type"], f["key"]
            if t == "entity":
                v[key] = ents.get(r.entity_id)
            elif t == "lp":
                v[key] = lps.get(r.legal_person_id)
            elif t == "parent":
                v[key] = parents.get(r.parent_id)
            elif t == "staff":
                v[key] = names.get(a.get(key)) if a.get(key) else None
            elif t == "shop":
                v[key] = shops.get(a.get(key), "已删的店") if a.get(key) else None
            elif t == "select":
                v[key] = f["options"].get(a.get(key)) if a.get(key) else None
            elif t == "bool":
                v[key] = "是" if a.get(key) else "否"
            else:
                v[key] = a.get(key)
        out[r.id] = v
    return out


def _out(rec: LedgerRecord, view: dict, ctx: dict) -> dict:
    a = rec.attrs or {}
    row = {"id": rec.id, "kind": rec.kind, "name": rec.name, "entity_id": rec.entity_id,
           "legal_person_id": rec.legal_person_id, "parent_id": rec.parent_id, "attrs": a, "view": view,
           "status": rec.status, "note": rec.note, "alerts": alerts(rec, ctx), "updated_at": _cn(rec.updated_at)}
    if KINDS[rec.kind].get("checklist"):
        row["checklist"] = checklist(rec)
    if rec.kind == "seal":
        row["lent"] = a.get("lent")
    return row


def ensure_months(db: Session, staff: Staff | None = None) -> int:
    """代账月结每个月一条：记过的代账机构，这个月还没有就自动建上。"""
    month = _today().strftime("%Y-%m")
    have: dict[str, set] = {}
    for name, a in db.query(LedgerRecord.name, LedgerRecord.attrs).filter(LedgerRecord.kind == "close_month",
                                                                          LedgerRecord.status != "closed").all():
        have.setdefault(name, set()).add((a or {}).get("month"))
    n = 0
    for name, months in have.items():
        if month not in months:
            db.add(LedgerRecord(kind="close_month", name=name, attrs={"month": month, "done": {}}, status="active",
                                created_by_id=staff.id if staff else None, needs_check=False))
            n += 1
    if n:
        db.flush()
    return n


def list_records(db: Session, kind: str, q: str | None = None) -> list[dict]:
    if kind not in KINDS:
        raise HTTPException(status_code=400, detail="没有这种台账")
    query = db.query(LedgerRecord).filter(LedgerRecord.kind == kind)
    if (q or "").strip():
        query = query.filter(LedgerRecord.name.like(f"%{q.strip()}%"))
    recs = query.order_by(LedgerRecord.created_at.desc()).all()
    ctx = _ctx(db, recs if kind != "bank_account" else recs + db.query(LedgerRecord).filter(LedgerRecord.kind == "ukey").all())
    if kind == "bgcheck":
        ctx = _ctx(db, db.query(LedgerRecord).filter(LedgerRecord.kind == "bgcheck").all())
    views = _views(db, recs)
    rows = [_out(r, views[r.id], ctx) for r in recs]
    if kind == "merchant":
        by_no: dict[str, list] = {}
        for s in db.query(LedgerShop).filter(LedgerShop.merchant_no.isnot(None)).all():
            by_no.setdefault(s.merchant_no, []).append(s.name)
        for row in rows:
            row["shops"] = by_no.get(row["attrs"].get("mch_no") or "", [])
    return rows


def ref_options(db: Session) -> dict:
    """表单下拉：主体、法人、店铺、能当「上一条」的条目（对公户）。"""
    lps = dict(db.query(LedgerLegalPerson.id, LedgerLegalPerson.name).all())
    return {
        "entities": [{"id": e.id, "label": f"{e.name}（{lps.get(e.legal_person_id, '')}）"}
                     for e in db.query(LedgerEntity).filter(LedgerEntity.status != "closed").order_by(LedgerEntity.name)],
        "legal_persons": [{"id": i, "label": n} for i, n in sorted(lps.items(), key=lambda x: x[1])],
        "shops": [{"id": s.id, "label": f"{lg.PLATFORMS.get(s.platform, s.platform)} · {s.name}"}
                  for s in db.query(LedgerShop).filter(LedgerShop.status != "closed").order_by(LedgerShop.name)],
        "parents": {k: [{"id": r.id, "label": r.name, "entity_id": r.entity_id}
                        for r in db.query(LedgerRecord).filter(LedgerRecord.kind == k, LedgerRecord.status != "closed")
                        .order_by(LedgerRecord.name)]
                    for k in {f["of"] for v in KINDS.values() for f in v["fields"] if f["type"] == "parent"}},
    }


def counts(db: Session) -> dict[str, int]:
    return dict(db.query(LedgerRecord.kind, func.count(LedgerRecord.id)).group_by(LedgerRecord.kind).all())


def radar(db: Session) -> list[dict]:
    """雷达：所有要人去办的事，红的在前。"""
    recs = db.query(LedgerRecord).all()
    ctx = _ctx(db, recs)
    today = ctx["today"]
    out = []
    for r in recs:
        for x in alerts(r, ctx):
            out.append({**x, "group": KINDS[r.kind]["group"], "kind": r.kind, "record_id": r.id,
                        "title": f"{KINDS[r.kind]['label']} · {r.name}"})
    # 开票额度：本月蓝字发票加起来到了主体额度的 80%
    month = today.strftime("%Y-%m")
    used: dict[str, Decimal] = {}
    for r in recs:
        a = r.attrs or {}
        if r.kind == "invoice" and r.status != "closed" and a.get("color") == "blue" and (a.get("issued_on") or "")[:7] == month:
            used[r.entity_id] = used.get(r.entity_id, Decimal("0")) + Decimal(a.get("amount") or 0)
    for e in db.query(LedgerEntity).filter(LedgerEntity.id.in_(list(used)), LedgerEntity.invoice_quota.isnot(None)).all():
        if e.invoice_quota and used[e.id] >= e.invoice_quota * Decimal("0.8"):
            out.append({"level": "danger" if used[e.id] >= e.invoice_quota else "warn", "group": "bank", "kind": "invoice",
                        "title": f"开票额度 · {e.name}",
                        "text": f"本月蓝字开了 ¥{used[e.id]:,.0f}，额度 ¥{e.invoice_quota:,.0f}（{used[e.id] / e.invoice_quota:.0%}）"})
    # 增值税申报：记过申报的主体，上一季度的没记就提醒（次月 15 日截止）
    q_start = lg.quarter_start(today)
    prev_end = q_start - timedelta(days=1)
    period = f"{prev_end.year}Q{(prev_end.month - 1) // 3 + 1}"
    deadline = date(q_start.year, q_start.month, 15)
    filed: dict[str, set] = {}
    for r in recs:
        if r.kind == "tax_filing" and (r.attrs or {}).get("tax") == "vat":
            filed.setdefault(r.entity_id, set()).add((r.attrs or {}).get("period"))
    for e in db.query(LedgerEntity).filter(LedgerEntity.id.in_(list(filed)), LedgerEntity.status == "active").all():
        if period not in filed[e.id] and not (e.registered_on and e.registered_on > prev_end):
            late = today > deadline
            out.append({"level": "danger" if late else "warn", "group": "bank", "kind": "tax_filing",
                        "title": f"申报 · {e.name}",
                        "text": f"{period} 增值税申报没记，{lg._days(deadline)}截止" + ("，已经过了" if late else "")})
    # 背调：在用的法人一次都没查过
    checked = {r.legal_person_id for r in recs if r.kind == "bgcheck" and r.legal_person_id}
    for lp in db.query(LedgerLegalPerson).filter(LedgerLegalPerson.status == "active").all():
        if lp.id not in checked:
            out.append({"level": "warn", "group": "bgcheck", "kind": "bgcheck", "title": f"法人 · {lp.name}",
                        "text": "还没做过背调（失信 / 限高 / 涉诉 / 反诈），代持期间每 90 天查一次"})
    # 离职员工还知道的密码
    names, gone = _staff_names(db), departed(db)
    left: dict[str, list] = {}
    for k in db.query(LedgerKnows).filter(LedgerKnows.staff_id.in_(gone)).all() if gone else []:
        left.setdefault(k.staff_id, []).append(f"{_target_label(db, k.target_type, k.target_id) or '已删的东西'}的{SECRETS.get(k.what, k.what)}")
    for sid, items in left.items():
        out.append({"level": "danger", "group": "staff", "kind": "knows", "title": f"离职 · {names.get(sid, '已删的员工')}",
                    "text": f"他离职了，还有 {len(items)} 处密码要改：{'、'.join(items[:5])}{' 等' if len(items) > 5 else ''}"})
    # 员工实名卡
    for c in db.query(LedgerSim).filter(LedgerSim.category == "employee", LedgerSim.status != "closed").all():
        for x in lg.sim_alerts(c, today, gone=gone, staff_names=names):
            out.append({**x, "group": "staff", "kind": "employee_sim", "title": f"员工实名卡 · {c.phone}"})
    # 支付宝无密转账证书
    for a in db.query(LedgerAlipay).filter(LedgerAlipay.cert_expires_on.isnot(None), LedgerAlipay.status != "closed").all():
        for x in _due("转账证书", a.cert_expires_on, today):
            out.append({**x, "group": "pay", "kind": "alipay", "title": f"支付宝 · {a.account}"})
    # 商户号台账记过以后：走微信 / 抖音 / 小红书 / 京东结算的店，商户号要对得上
    nos = {(r.attrs or {}).get("mch_no") for r in recs if r.kind == "merchant"}
    if nos:
        for s in db.query(LedgerShop).filter(LedgerShop.channel.in_(("wechat", "douyin", "xhs", "jd")),
                                             LedgerShop.status != "closed").all():
            if s.merchant_no not in nos:
                out.append({"level": "warn", "group": "pay", "kind": "merchant", "title": f"店铺 · {s.name}",
                            "text": f"走{lg.CHANNELS.get(s.channel)}结算，商户号{s.merchant_no or '没填'}不在商户号台账里"})
    out.sort(key=lambda x: (x["level"] != "danger", list(GROUPS).index(x["group"])))
    return out
