#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
锚点中控 · 统筹缺口引擎 + 开店全流程教程状态机（企业支付宝15步 ↔ 闲鱼开店18步强关联双锁）
数据与交互口径严格融合：
1. 上传包内《协助客户开设网店 SOP》(7阶段11步) + 《闲鱼矩阵开店工作流 v1》(4阶段13步) + 《教程制作工作法》(元教程8步)
2. 《销售工作台 · 服务页 UI Design v1.0》与《泛亚工作台 UI 设计总纲领 v1.0》（首屏红黄绿问题箱、一步一屏、Lock原因组件、7字段防呆矩阵 G()、locked可只读预览、历史审核意见保留不覆盖、未录视频诚实标待录）
"""

from __future__ import annotations
import datetime as dt
import json
import sqlite3
import uuid


TUTORIAL_GAP_DDL = """
-- 1. 委托客户受托托管目标配额表（用于自动倒推客户证照/号卡/家宽/支付宝/各平台受托建店缺口）
CREATE TABLE IF NOT EXISTS matrix_quota_targets (
    id TEXT PRIMARY KEY,
    legal_person_id TEXT NOT NULL UNIQUE REFERENCES legal_persons(id) ON DELETE CASCADE,
    target_licenses INTEGER NOT NULL DEFAULT 4,
    target_tax_regs INTEGER NOT NULL DEFAULT 4,
    target_annual_reports INTEGER NOT NULL DEFAULT 4,
    target_alipays INTEGER NOT NULL DEFAULT 14,
    target_proxies INTEGER NOT NULL DEFAULT 16,
    target_work_phones INTEGER NOT NULL DEFAULT 14,
    target_sim_slots INTEGER NOT NULL DEFAULT 16,
    platform_targets_json TEXT NOT NULL DEFAULT '{}',
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 2. 开店教程模板表（主管编写/维护 -> 老板终审发布；覆盖 13 类平台 + 企业支付宝 + 元教程）
CREATE TABLE IF NOT EXISTS tutorial_templates (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('alipay', 'platform', 'meta_authoring')),
    platform TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT 'v1.0',
    summary TEXT NOT NULL DEFAULT '',
    author_staff TEXT NOT NULL DEFAULT '周安(主管)',
    status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'pending_boss', 'published', 'archived')),
    reward_points INTEGER NOT NULL DEFAULT 8,
    reward_yuan INTEGER NOT NULL DEFAULT 100,
    sla_days INTEGER NOT NULL DEFAULT 14,
    boss_review_note TEXT NOT NULL DEFAULT '',
    published_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 3. 教程阶段表
CREATE TABLE IF NOT EXISTS tutorial_stages (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES tutorial_templates(id) ON DELETE CASCADE,
    stage_code TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    duration_note TEXT NOT NULL DEFAULT '当天完成',
    sort_order INTEGER NOT NULL DEFAULT 1
);

-- 4. 教程原子步骤表（融合 ? 十要素 + 7字段防呆矩阵 guard_json + 跨轨强关联锁 cross_gate_rule）
CREATE TABLE IF NOT EXISTS tutorial_steps (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES tutorial_templates(id) ON DELETE CASCADE,
    stage_id TEXT NOT NULL REFERENCES tutorial_stages(id) ON DELETE CASCADE,
    step_code TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    title TEXT NOT NULL,
    owner_role TEXT NOT NULL DEFAULT '开店员工',
    when_to_use TEXT NOT NULL DEFAULT '',
    guide TEXT NOT NULL DEFAULT '',
    warn_text TEXT NOT NULL DEFAULT '',
    deliver_note TEXT NOT NULL DEFAULT '',
    stop_condition TEXT NOT NULL DEFAULT '',
    video_url TEXT NOT NULL DEFAULT '',
    wiki_url TEXT NOT NULL DEFAULT '',
    kpi_impact TEXT NOT NULL DEFAULT '计入开店首单一次通过率与14天建店SLA',
    terms_json TEXT NOT NULL DEFAULT '[]',
    guard_json TEXT NOT NULL DEFAULT '[]',
    require_confirm INTEGER NOT NULL DEFAULT 0 CHECK (require_confirm IN (0, 1)),
    require_review INTEGER NOT NULL DEFAULT 0 CHECK (require_review IN (0, 1)),
    cross_gate_rule TEXT NOT NULL DEFAULT '',
    unlock_vault_lockin INTEGER NOT NULL DEFAULT 0 CHECK (unlock_vault_lockin IN (0, 1)),
    UNIQUE (template_id, step_code)
);

-- 5. 步骤提交材料定义表
CREATE TABLE IF NOT EXISTS tutorial_step_materials (
    id TEXT PRIMARY KEY,
    step_id TEXT NOT NULL REFERENCES tutorial_steps(id) ON DELETE CASCADE,
    material_key TEXT NOT NULL,
    label TEXT NOT NULL,
    input_type TEXT NOT NULL DEFAULT 'text' CHECK (input_type IN ('text', 'textarea', 'number', 'select', 'date', 'image', 'video', 'file')),
    required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
    help_text TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 1
);

-- 6. 单店 / 单支付宝开店流程执行实例表（每家店、每个支付宝直接挂一条进度实例，并支持父子跨轨强关联）
CREATE TABLE IF NOT EXISTS onboarding_cases (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES tutorial_templates(id) ON DELETE RESTRICT,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('alipay', 'platform', 'meta_authoring')),
    target_id TEXT NOT NULL,
    legal_person_id TEXT REFERENCES legal_persons(id) ON DELETE SET NULL,
    business_entity_id TEXT REFERENCES business_entities(id) ON DELETE SET NULL,
    linked_alipay_case_id TEXT REFERENCES onboarding_cases(id) ON DELETE SET NULL,
    case_title TEXT NOT NULL,
    assigned_staff TEXT NOT NULL DEFAULT '陈晓雯',
    supervisor_staff TEXT NOT NULL DEFAULT '周安',
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'blocked', 'completed')),
    started_at TEXT NOT NULL DEFAULT '2026-11-10',
    due_at TEXT NOT NULL DEFAULT '2026-11-24',
    completed_at TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (target_kind, target_id)
);

-- 7. 步骤提交与审核历史留痕表（严格遵守《服务页UI设计》要求：每次重提 version_no+1，旧驳回意见完整保留不覆盖！）
CREATE TABLE IF NOT EXISTS onboarding_step_submissions (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES onboarding_cases(id) ON DELETE CASCADE,
    step_id TEXT NOT NULL REFERENCES tutorial_steps(id) ON DELETE CASCADE,
    step_code TEXT NOT NULL,
    version_no INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK (status IN ('submitted', 'approved', 'rejected', 'skipped')),
    materials_json TEXT NOT NULL DEFAULT '{}',
    confirmed INTEGER NOT NULL DEFAULT 0,
    submitted_by TEXT NOT NULL DEFAULT '',
    submitted_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    reviewed_by TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT NOT NULL DEFAULT '',
    review_note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_onb_sub_case_step ON onboarding_step_submissions (case_id, step_code, version_no DESC);

-- 8. 双闸申请跳过记录表（员工填≥5字理由+虚报追责确认 -> 老板审批）
CREATE TABLE IF NOT EXISTS onboarding_skip_requests (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES onboarding_cases(id) ON DELETE CASCADE,
    step_id TEXT NOT NULL REFERENCES tutorial_steps(id) ON DELETE CASCADE,
    step_code TEXT NOT NULL,
    reason TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT NOT NULL DEFAULT '',
    reviewer_note TEXT NOT NULL DEFAULT ''
);
"""


def _G(pre: str, mistake: str, block: str, tip: str, recover: str, owner: str, evidence: str) -> dict:
    """7字段标准防呆矩阵（对齐《服务页UI设计》help_svc.js G() 规范）"""
    return {
        "pre": pre,
        "mistake": mistake,
        "block": block,
        "tip": tip,
        "recover": recover,
        "owner": owner,
        "evidence": evidence,
    }


# ==================== 1. 企业支付宝开户轨（4阶段 · 15原子步） ====================
ALIPAY_STAGES = [
    {
        "code": "ALI-P0",
        "title": "阶段 1 · 前置号卡·主邮箱与执照核验（最前置防卡死）",
        "desc": "联通卡、沃邮箱/腾讯主邮箱是全流程最前置依赖；先建路线台账再动手，严禁混号。",
        "duration": "第 1 天完成",
        "steps": [
            {
                "code": "A01",
                "title": "锁定托管服务槽位与登记客户主体法人主设备/腾讯主邮箱",
                "who": "开店员工 + 主管",
                "when": "新建任一企业支付宝前第一步执行",
                "guide": "1. 在受托台账确认本账号归属哪位签约客户及对应营业执照（每家客户主体独立建档、独立核算）；\n2. 明确本账户在主体内的唯一角色：3选1主资金池(master_fund) / 因公采购子号(purchase_only) / 纯销售收款号(sales_only)；\n3. 核对并登记客户法人本人的主设备手机号与腾讯主邮箱（@qq.com 或 @foxmail.com），用于承载工商与支付宝最高安全实名。",
                "warn": "第三方授权合约卡到期存在回收风险，运营商邮箱随停机失效！关键实名根锚点必须绑定委托客户客户法人本人主设备与腾讯主邮箱（@qq.com/@foxmail.com）。",
                "deliver": "路线槽位、资金角色与法人腾讯主邮箱核对登记完成",
                "stop": "托管运营合同未签或主邮箱非腾讯系时暂停，联系主管补齐",
                "guards": [_G("多条执照路线并行推进时", "没定槽位先注册导致14个号串线", "必填槽位编码与角色枚举校验", "先定槽位再动卡，绝不口头记账", "回到路线台账重新核配槽位", "主管", "槽位确认记录")],
                "materials": [
                    ("slot_confirm", "归属执照路线与资金角色确认", "text", 1, "例：ENT-WYQ-01 · 第2销售收款号 (sales_only)"),
                    ("legal_qq_mail", "委托客户法人主邮箱(@qq.com/@foxmail.com)", "text", 1, "严禁填139/189/163等易回收或绑卡邮箱"),
                ],
            },
            {
                "code": "A02",
                "title": "领取并激活受托店铺专用手机卡（联通99元200G·1主4副/第三方授权卡）",
                "who": "开店员工（委托客户法人配合实名）",
                "when": "办理执照预留与注册企业支付宝之前",
                "guide": "1. 按一主4副动态配额（5 - 原有个人存量卡）办理联通99元200G大流量主副卡，名额不足缺口从已签通信授权协议的第三方授权卡池领用；\n2. 当天办卡当天激活，当场拨打电话与打开网页测试通话、短信、流量均正常；\n3. 从台账锁定该号码，严禁随手拿桌面未登记卡。",
                "warn": "宁可人等号，不可号等人！没有已激活手机号，执照预留与企业支付宝收码会全线卡死。",
                "deliver": "手机卡实名激活且通话短信正常，已绑入台账",
                "stop": "一证通查名额超限无法激活时，转第三方授权合约卡渠道补齐",
                "guards": [_G("委托客户原有1~2张存量移动/联通卡时", "强开第5张客户实名卡被营业厅拒办", "台账自动核算 5-存量卡 上限拦截", "超上限直接领用带到期预警的第三方授权合约卡", "改走第三方通信授权协议领卡", "号卡管理员", "营业厅受理单照片")],
                "materials": [
                    ("sim_phone", "领用激活的11位手机号", "text", 1, "从台账号码池选取，禁止跨路线混用"),
                    ("sim_receipt_img", "办卡受理凭证照片/截图", "text", 1, "填写上传凭证说明或图片文件名（四角完整）"),
                ],
            },
            {
                "code": "A03",
                "title": "开通企业预留邮箱（沃邮箱/阿里企业子邮）并收发自测",
                "who": "开店员工",
                "when": "手机卡激活当天同步开通",
                "guide": "1. 使用对应路线信息开通专属企业登录子邮箱（如 @qingchuan-ops.cn 子邮或联通沃邮箱）；\n2. 向该邮箱发送一封测试验证邮件并回复，确认收发零延迟；\n3. 严禁不同路线共用同一个登录邮箱。",
                "warn": "企业支付宝注册必须绑定独立邮箱作为登录账号，未自测收件会导致激活链接收不到。",
                "deliver": "专属登录邮箱开通并通过收发自测",
                "stop": "域名MX解析异常或收不到验证码时联系IT管理员",
                "guards": [_G("批量开12~14个企业支付宝时", "邮箱序号填重导致绑定冲突", "数据库 login_email UNIQUE 唯一键拦截", "严格按 e1_sales01@ 格式一一对应", "更换新子邮箱前缀重试", "开店员工", "邮箱测试回执")],
                "materials": [
                    ("login_email", "企业支付宝拟绑登录邮箱", "text", 1, "例：4fc2142b92@example.invalid"),
                ],
            },
            {
                "code": "A04",
                "title": "核验下证营业执照并完成 OCR 三要素比对与公示网查验",
                "who": "开店员工提交 · 主管审核",
                "when": "财会代办下证后立即执行（外地园区照需先核验代办方自身营业执照资质）",
                "guide": "1. 拍摄/扫描营业执照正本（四角完整、无反光、字迹清晰）；\n2. 用 OCR 或人工逐字核对三项核心信息：公司名称、法定代表人身份证号、统一社会信用代码；\n3. 打开国家企业信用信息公示系统 (gsxt.gov.cn) 查验状态为「存续/在营」，无经营异常。",
                "warn": "全国代办财会公司拍胸脯话术不可轻信！外地执照分散选湖北/吉林/贵州/内蒙园区（¥300左右），且下证后必须亲自上公示网核实存续状态。",
                "deliver": "营业执照正本归档且三要素与 gsxt.gov.cn 完全一致",
                "stop": "公示系统查无此照或列异时立即退回代办方重办",
                "require_review": 1,
                "guards": [_G("外地园区批量代办下证时", "信用代码字母 O 与数字 0 看混", "主管审核闸口逐字复核", "直接复制公示网原文比对，不手敲", "驳回修正台账 USCC 后重提", "主管", "营业执照照片 + 公示网截图")],
                "materials": [
                    ("license_photo", "营业执照正本清晰照片凭证", "text", 1, "填写执照存档编号或图片URL"),
                    ("uscc_verified", "核对无误的18位统一社会信用代码", "text", 1, "须与原件及公示系统100%一致"),
                ],
            },
        ],
    },
    {
        "code": "ALI-P1",
        "title": "阶段 2 · 反向扫码创单与实名核验（与个人流程截然相反）",
        "desc": "电脑端 b.alipay.com 必须用个人支付宝扫码授权创建申请单，并完成执照上传、OCR核填与密码单向锁库。",
        "duration": "第 1~2 天",
        "steps": [
            {
                "code": "B05",
                "title": "电脑打开 b.alipay.com 用个人支付宝扫码创单（反向授权登录）",
                "who": "开店员工（委托客户法人/管理员扫码）",
                "when": "在绑定好家宽代理的 AdsPower 专窗内操作",
                "guide": "1. 在对应 AdsPower 浏览器专窗打开支付宝商家平台 https://b.alipay.com ，点击「注册企业支付宝」；\n2. 使用个人支付宝扫码创建申请单（该个人支付宝将成为本企业号的超级管理员），即「支付宝授权登录」；\n3. 全程录屏留存授权创建过程。",
                "warn": "【核心反直觉红线】企业支付宝必须用个人支付宝扫码授权登录（与个人淘宝号严禁支付宝快捷登录截然相反）！此步 100% 会弹出「不当注册」类安全提示，属预期正常流程，按引导继续即可！",
                "deliver": "成功用个人支付宝扫码创建企业支付宝开户申请单",
                "stop": "若未在对应家宽 AdsPower 专窗内打开网页，立即停止切换专窗",
                "require_confirm": 1,
                "guards": [_G("刚做完个人闲鱼号防不当注册的员工", "按个人号习惯不敢扫码或点错注册入口", "勾选确认框强制阅读反向流程提示", "记住口诀：个人号禁绑支，企业号必扫码", "重新进入 b.alipay.com 扫码建单", "开店员工", "扫码创单录屏")],
                "materials": [
                    ("auth_scan_video", "个人支付宝扫码创单过程录像/凭证", "text", 1, "填写录像归档文件名或凭证说明"),
                ],
            },
            {
                "code": "B06",
                "title": "使用私人手机将营业执照原图传至该企业支付宝并上传",
                "who": "开店员工",
                "when": "申请单进入证照上传环节时",
                "guide": "1. 用干净的私人手机将本主体营业执照原图发送至当前办理端并上传；\n2. 严禁把 4 条不同路线的执照图片混放在同一部业务工作机相册里，装错一次整条路线作废。",
                "warn": "四条路线的证照材料必须物理分文件夹存放！跨路线传错执照会直接污染支付宝主体实名历史。",
                "deliver": "本路线营业执照原图准确上传通过初检",
                "stop": "图片模糊反光被拒时联系委托客户/代账会计重拍原件",
                "guards": [_G("同时办理4本执照共12个企支时", "传成隔壁路线的营业执照图片", "上传前核对执照尾号与路线编码", "传图前念一遍执照商号全称", "撤回申请单换正确执照重传", "开店员工", "上传界面截图")],
                "materials": [
                    ("license_send_proof", "营业执照发送与上传界面截图", "text", 1, "确认商号与当前路线一致"),
                ],
            },
            {
                "code": "B07",
                "title": "OCR 填写公司名称、法人身份证号、统一社会信用代码",
                "who": "开店员工",
                "when": "证照识别回填页面",
                "guide": "1. 使用支付宝页面 OCR 自动识别并逐字复核公司名称（含个体户括号全角半角）、法人身份证号、统一社会信用代码；\n2. 填写法人身份证有效期与经营地址，确保与营业执照一字不差。",
                "warn": "个体工商户括号「（个体工商户）」全半角不一致会导致后续打款核验失败！",
                "deliver": "企业实名三要素零差错提交",
                "stop": "OCR识别乱码无法修正时转人工客服核验通道",
                "guards": [_G("个体户名称带括号后缀时", "手动输入用了英文半角括号", "与 A04 已审信用代码比对", "一律复制公示系统标准全称粘贴", "返回上一步修正全角括号", "开店员工", "OCR核填完成截图")],
                "materials": [
                    ("ocr_fill_img", "OCR 企业信息核填完成截图", "text", 1, "三要素清晰可见"),
                ],
            },
            {
                "code": "B08",
                "title": "完成客户法人扫脸核验 / 开户确认函与对公或客户客户法人本人一类卡验证",
                "who": "客户法人配合刷脸 + 员工跟进 · 主管审核",
                "when": "实名核身与银行账户验证环节",
                "guide": "1. 提前预约委托客户法人在 10~15 分钟 SLA 窗口内现场或官方端完成人脸核验；\n2. 有限公司主体填写对公基本户完成小额打款验证；个体户主体绑定客户法人本人一类结算银行卡；\n3. 录制/截图实名通过状态提交主管审核。",
                "warn": "扫脸与打款金额只在支付宝官方页面由法人/财务完成，严禁把人脸照片或银行卡取款密码发在聊天群！",
                "deliver": "企业支付宝实名核身与结算银行卡验证通过",
                "stop": "法人连续2次刷脸不过立即停止，排查光线或证件有效期，勿硬刷锁号",
                "require_confirm": 1,
                "require_review": 1,
                "guards": [_G("异地客户法人配合刷脸时", "截图发超时二维码反复催刷触发风控", "要求先约好法人在线再点生成核身码", "人到齐再出码，一次刷过", "冷却24小时后改开户确认函认证", "主管", "实名通过截图")],
                "materials": [
                    ("face_bank_proof", "客户法人核身及银行卡验证通过截图", "text", 1, "脱敏展示尾号与通过状态"),
                ],
            },
            {
                "code": "B09",
                "title": "绑定邮箱并单向锁入登录密码/支付盾密（同步 AdsPower 免明文托管）",
                "who": "开店员工（单向录入锁库）",
                "when": "开户成功设置登录密码与6位支付密码时",
                "guide": "1. 绑定 A03 自测通过的登录邮箱，设置高强度登录密码与 6 位支付/盾密码；\n2. 使用下方【🔑 新设密码单向锁入保险箱】组件直接录入账密与 2FA 种子(fakey)；\n3. 系统立即以 ENCv1 加密写入总库并同步至绑定的 AdsPower 专窗自动填充，员工界面保存后即不可反查明文！",
                "warn": "严禁把新设的登录密码或 6 位支付密码写在飞书/微信/本地 TXT 记事本里！必须当场单向锁入本系统保险箱。",
                "deliver": "登录密与6位支付密已单向加密入库并关联 AdsPower 环境",
                "stop": "密码保险箱返回未锁入成功前不得关闭开户页",
                "unlock_vault_lockin": 1,
                "guards": [_G("员工开完户顺手记在桌面记事本", "明文密码散落员工电脑引发资金风险", "内嵌单向写密组件，提交即加密且员工不可反查", "设完密码立刻填进下方单向锁入框", "由老板在密码总库轮换重置密码", "老板/主管", "密码库审计流水")],
                "materials": [
                    ("alipay_uid_recorded", "生成的企业支付宝 2088 开头 UID", "text", 1, "例：2088702611000509"),
                ],
            },
        ],
    },
    {
        "code": "ALI-P2",
        "title": "阶段 3 · 第1天企业管家授权与因公支付架构（解锁闲鱼认证硬闸口 ①）",
        "desc": "趁委托客户法人在场必须当天完成企业管家一键授权，并按税法红线配置同主体3选1主户与因公支付。",
        "duration": "开户第 1 天必做",
        "steps": [
            {
                "code": "C10",
                "title": "【第1天铁律】趁委托客户法人在场搜「企业管家」一键授权管理员 ★解锁闲鱼认证★",
                "who": "开店员工 + 法人现场扫脸 · 主管审核",
                "when": "企业支付宝开户成功的第 1 天委托客户法人在场时立即执行",
                "guide": "1. 打开支付宝搜索「企业管家」，趁委托客户法人在场按引导完成「一键授权管理员」；\n2. 授权过程通常要求客户法人扫脸，务必当场一次办妥，绝不拖到事后补；\n3. 在企业管家里截图确认全部企业支付宝账号凭证可见，提交主管审核。",
                "warn": "【生死时点】这一步必须在第 1 天法人环节做完！拖到改天法人不在场无法扫脸，整条路线的企业支付宝与下挂闲鱼企业店都会被卡死！（★本步审核通过后，自动解锁关联闲鱼店 S09 企业入驻认证！）",
                "deliver": "企业管家管理员一键授权生效，解锁下挂闲鱼企业店认证",
                "stop": "委托客户法人暂离场时挂起等待，严禁未经授权强绑",
                "require_confirm": 1,
                "require_review": 1,
                "guards": [_G("第1天开完户以为万事大吉客户法人未授权便离场", "次日配权限弹客户法人扫脸无人配合导致停摆", "跨轨硬闸口：C10未审过直接锁死闲鱼企业店S09认证", "法人在场先搜企业管家拿完授权再收工", "重新预约法人现场补扫脸授权", "主管", "企业管家授权生效截图")],
                "materials": [
                    ("ent_steward_img", "支付宝「企业管家」管理员授权成功截图", "text", 1, "需清晰显示管理员已生效"),
                ],
            },
            {
                "code": "C11",
                "title": "配置同营业执照「3选1主资金池」或签约「因公支付」代扣",
                "who": "主管 / 财务配置",
                "when": "企业管家授权完成后",
                "guide": "1. 若本号定位于主体唯一主资金户（3选1），在台账核验 is_entity_master_fund=1，不挂任何网店；\n2. 若定位于采购买券子号（purchase_only），签约开启「因公支付」直扣同一营业执照下的主资金号，自身留 0 余额；\n3. 若定位于销售收款号（sales_only），锁定仅收销售店铺回款，严禁任何采购支出。",
                "warn": "违反税法死线：因公支付严禁跨营业执照主体代扣串户！且严禁同一支付宝既买又卖！",
                "deliver": "主体内资金池/因公代扣/纯销售隔离配置完毕",
                "stop": "主体归属核对不一致时由系统触发器直接阻断",
                "guards": [_G("多委托客户/多主体采购子号配置因公代扣时", "误绑到另一张营业执照的主资金号上", "数据库触发器 + API 双重硬阻断跨主体串户", "只绑本营业执照名下的唯一主户", "重选同主体 master_fund 账号", "主管/老板", "因公签约或收款隔离记录")],
                "materials": [
                    ("fund_role_check", "账户资金隔离与因公签约确认说明", "text", 1, "写明：主资金户 / 因公扣XX主户 / 纯销售收款"),
                ],
            },
        ],
    },
    {
        "code": "ALI-P3",
        "title": "阶段 4 · 支付产品开通与 T+1 账单 API 核实（解锁闲鱼在售硬闸口 ②）",
        "desc": "A4纸拍照开通支付产品，每号做互不相同的 0.xx 元账单测试，次日 T+1 与程序员核实账单 API 一一映射。",
        "duration": "T+1 次日闭环",
        "steps": [
            {
                "code": "D12",
                "title": "打印本主体公司全称 A4 纸并实景拍照备审",
                "who": "开店员工",
                "when": "申请开通支付宝商家支付产品前",
                "guide": "1. 用 A4 白纸清晰打印本营业执照上的完整公司/个体工商户名称；\n2. 置于办公经营实景下拍照，确保字体端正清晰、无PS痕迹，用于支付产品资质上传。",
                "warn": "每本执照必须单独打印对应商号 A4 纸实拍，严禁拿修图软件改字上传（必被支付宝风控秒拒）！",
                "deliver": "公司全称 A4 纸实景照片就绪",
                "stop": "商号打印错漏1个字即重打重拍",
                "guards": [_G("批量给4本执照开通产品时", "偷懒用电脑屏幕显示代替A4纸打印拍照", "人工检查实拍纸张边缘与环境", "老老实实A4纸打印实拍，3分钟搞定", "重新打印实拍上传", "开店员工", "A4纸实拍原图")],
                "materials": [
                    ("a4_company_photo", "打印公司全称的 A4 纸实拍照片凭证", "text", 1, "填写照片存档名或链接"),
                ],
            },
            {
                "code": "D13",
                "title": "登录 b.alipay.com「产品大全」申请开通当面付/网站支付产品",
                "who": "开店员工提交 · 主管审核",
                "when": "A4 纸资质照备妥后",
                "guide": "1. 管理员登录 https://b.alipay.com 进入「产品大全」；\n2. 选择所需收款/支付产品（当面付、电脑网站支付等），上传 D12 实拍 A4 纸资质与证照提交审核；\n3. 审核通过后配置公钥证书三件套预留。",
                "warn": "确认产品状态变为「已生效/已开通」截图后再进下一步，提交申请中不算开通完成！",
                "deliver": "企业支付宝支付产品正式开通生效",
                "stop": "平台提示需补充门头/经营佐证时转主管按合规材料包补件",
                "require_review": 1,
                "guards": [_G("刚点提交审核就往下走", "把“审核中”当成“已开通”导致0.xx测试失败", "主管审核必须见“已开通”绿色状态章", "等状态变已开通再做0.xx测试", "补传补充材料等通过", "主管", "支付产品已开通截图")],
                "materials": [
                    ("pay_product_proof", "支付产品「已开通」状态页截图", "text", 1, "包含产品名称与生效时间"),
                ],
            },
            {
                "code": "D14",
                "title": "执行每号唯一 0.xx 元差异化小额验证交易（建立账号-金额对照）",
                "who": "开店员工",
                "when": "支付产品生效当天（T日）",
                "guide": "1. 为本企业支付宝做一笔 0.xx 元的小额测试交易；\n2. 【关键】每个企业支付宝的测试金额必须互不相同（如1号 0.01 元、2号 0.02 元、3号 0.03 元……12号 0.12 元）；\n3. 将本账号精确测试金额填入下方材料，等待次日 T+1 账单生成。",
                "warn": "测试金额严禁重复！若两个号都测 0.01 元，次日程序员拉 T+1 账单 API 时根本分不清哪个接口对应哪个支付宝！",
                "deliver": "完成唯一 0.xx 元测试交易并登记对照金额",
                "stop": "交易报错限额或拦截时先回查 B08/D13 状态",
                "guards": [_G("同批测试12个企业支付宝时", "全部随手输0.01元测试", "表单必填精确差异化测试金额备查", "按台账序号输金额：01号输0.01，02号输0.02", "补做一笔唯一尾数金额并备注", "开店员工", "0.xx交易单号与金额")],
                "materials": [
                    ("unique_test_yuan", "本账号唯一测试金额(元，如 0.07)", "text", 1, "同批各支付宝绝对不能相同"),
                    ("test_tx_no", "支付宝测试交易流水号", "text", 1, "2026开头的28位流水号"),
                ],
            },
            {
                "code": "D15",
                "title": "T+1 与程序员(微信 z15859900434)核实账单 API 对应无误 ★解锁闲鱼开售★",
                "who": "开店员工对接程序员 · 主管终核",
                "when": "0.xx 测试次日（T+1 出日账单后）",
                "guide": "1. 次日 T+1 日账单生成后，联系公司程序员（外部微信：z15859900434）；\n2. 与程序员逐笔核对：统筹软件 API 拉到的测试金额与本账号在 D14 登记的 0.xx 元 100% 一致；\n3. 核对无误后由主管审核通过，台账自动标记「账单已连通」并解锁下挂闲鱼店最后一步 S18 正式上架！",
                "warn": "【财务生死线】账单 API 与企业支付宝对应错乱会直接污染受托客户财税对账与纳税申报核验！本步未核实通过前，关联闲鱼店 S18 硬锁死严禁开售！",
                "deliver": "程序员确认账单 API 映射 100% 准确，解锁下挂闲鱼店正式开售",
                "stop": "API 拉取金额对不上时立即停用映射，协同程序员重配密钥对",
                "require_confirm": 1,
                "require_review": 1,
                "guards": [_G("急着上架卖货跳过次日API对账", "卖了几百单后发现流水记到别的执照名下引发税务事故", "跨轨硬闸口 Gate-2：D15未过硬锁死闲鱼S18在售状态", "宁等T+1核清0.xx，绝不带病开卖", "找程序员重校UID与证书映射", "主管 + 程序员", "API核对一致确认记录")],
                "materials": [
                    ("api_match_confirm", "程序员 T+1 账单 API 核对结论与核对日期", "textarea", 1, "写明：API实拉金额=0.xx元，与本UID完全一致，核对人及日期"),
                ],
            },
        ],
    },
]


# ==================== 2. 闲鱼矩阵开店轨（5阶段 · 18原子步 · 双闸口联锁支付宝） ====================
XIANYU_STAGES = [
    {
        "code": "XY-P1",
        "title": "阶段 1 · 槽位领用·空机指纹 ADB 灌录与 ¥10 家宽独占绑定",
        "desc": "一机一路线、同平台独占1条¥10家宽代理IP，自研指纹软件找程序员 ADB 灌录后严禁恢复出厂。",
        "duration": "第 1 天",
        "steps": [
            {
                "code": "S01",
                "title": "从路线台账领取本闲鱼店专属槽位（执照+企支+手机号+专机）",
                "who": "开店员工",
                "when": "启动新闲鱼店建档第一步",
                "guide": "1. 在台账核对本店归属路线（4本执照×3~4企业店，或独立个人号线/采购专号线）；\n2. 确认绑定的手机号、同营业执照销售支付宝（sales_only）及专用手机编号全部就位，严禁跨路线借用。",
                "warn": "没有在台账先定好槽位严禁私自拿手机注册！买卖角色严格互斥（销售店禁绑采购支付宝）。",
                "deliver": "店铺槽位四要素（执照/企支/号码/设备）锁定无冲突",
                "stop": "缺号码或同主体无可用销售支付宝时先走缺口派单补齐",
                "guards": [_G("多店并行开店时", "两家店拿了同一条路线的备用卡或混绑采购支付宝", "台账唯一槽位与买卖互斥触发器硬拦截", "一切从台账领号，绝不混拿", "回台账重绑合规销售支付宝", "主管", "槽位绑定单")],
                "materials": [
                    ("xy_slot_code", "确认领用的台账店铺编号与路线", "text", 1, "例：WYQ-XY02 · 绑定 ALI-WYQ-S2 + 00081107181"),
                ],
            },
            {
                "code": "S02",
                "title": "全新空设备出厂净化与物理插卡核检（禁插私人卡）",
                "who": "开店员工",
                "when": "灌录设备指纹之前",
                "guide": "1. 取全新或已彻底恢复出厂设置的专用工作机（销售机与采购买券机严格物理分机）；\n2. 检查双 SIM 卡槽确保无任何员工私人 SIM 卡残留，插入台账指定手机卡并关闭自动同步旧云相册。",
                "warn": "必须在灌录指纹【之前】完成恢复出厂设置！一旦下一步生成指纹后，绝不可再恢复出厂！",
                "deliver": "空设备净化完毕并插入正确路线 SIM 卡",
                "stop": "设备曾登录过被封禁闲鱼号且未重刷指纹前严禁使用",
                "guards": [_G("复用旧工作手机开新店时", "残留上家店相册缓存或旧WiFi列表导致同机关联", "先恢复出厂再灌新指纹标准顺序", "先清机、再插卡、后灌指纹", "重新清机后联系程序员重灌指纹", "开店员工", "设备关于本机双IMEI核对")],
                "materials": [
                    ("device_sn_imei", "核对设备编号与序列号/IMEI", "text", 1, "例：DEV-PH-15 · 双IMEI不重复"),
                ],
            },
            {
                "code": "S03",
                "title": "联系程序员(微信 z15859900434)完成自研设备指纹软件 ADB 灌录",
                "who": "开店员工对接程序员",
                "when": "空机净化完成后、安装注册淘宝闲鱼前",
                "guide": "1. 联系公司程序员（外部微信：z15859900434）获取公司自研灌录指纹软件安装包；\n2. 按程序员指导开启 USB 调试完成手机端 ADB 安装与授权，生成独立硬件指纹（一机一指纹）；\n3. 启动验证正常后截图归档。",
                "warn": "指纹软件为公司自研核心防关联组件，严禁自行上网乱找改机插件！指纹生成后【严禁恢复出厂设置】，否则指纹立即失效！",
                "deliver": "手机完成独立设备指纹 ADB 灌录且风控自检通过",
                "stop": "ADB 报错或型号不兼容时立即停手交程序员排查",
                "require_confirm": 1,
                "guards": [_G("手机卡顿想重置系统时", "指纹灌好后手滑点恢复出厂设置导致裸奔", "确认框强提醒指纹不可重置铁律", "灌完指纹贴物理标签：禁恢复出厂", "立即断网找程序员重灌新指纹", "程序员 + 员工", "指纹软件安装成功界面截图")],
                "materials": [
                    ("adb_fp_proof", "设备指纹软件安装成功与风控评估结论", "text", 1, "填写指纹ID摘要及网络/设备评估合格结论"),
                ],
            },
            {
                "code": "S04",
                "title": "绑定 ¥10/月独享住宅家宽代理 IP（校验闲鱼平台 100% 独占）",
                "who": "开店员工",
                "when": "连接网络前",
                "guide": "1. 从台账家宽代理池选取一条闲鱼平台尚未占用的 ¥10/月 SOCKS5 住宅家宽代理（其他非闲鱼平台如点评/微信小店可合法复用该IP，但闲鱼绝不可2店共IP）；\n2. 检查代理剩余有效期 >7 天，测速并核对出口 IP 与台账一致。",
                "warn": "2 家闲鱼店共用同一条家宽 IP 会被阿里风控秒判同 IP 店群关联连坐！严禁使用办公室公共 WiFi 裸连登录闲鱼！",
                "deliver": "独占家宽代理连通且出口 IP 核验一致",
                "stop": "家宽池无空闲闲鱼槽位或代理临期 ≤3 天时先新购/续期再连",
                "guards": [_G("新开第15家闲鱼店但只有14条家宽时", "图省事蹭已有闲鱼店的家宽IP", "数据库 UNIQUE(proxy_ip_id, platform) 唯一索引硬阻断撞IP", "同平台必独占，跨平台才复用", "新购1条¥10/月家宽录入台账后再绑", "开店员工", "出口IP核验记录")],
                "materials": [
                    ("proxy_exit_check", "绑定的家宽编号与实测出口IP", "text", 1, "例：IP-NB-15 (183.134.60.27)"),
                ],
            },
            {
                "code": "S05",
                "title": "创建 AdsPower 专属浏览器窗口并挂载家宽代理",
                "who": "开店员工",
                "when": "电脑端千牛/网页后台准备阶段",
                "guide": "1. 在销售组宿主机（DEV-PC-01）新建 AdsPower 环境窗口，分组选对应主体路线；\n2. 填入 S04 同一条家宽 SOCKS5 代理并锁定浏览器硬件指纹，校验窗口角色隔离为 sales_only。",
                "warn": "该家宽代理一旦绑上 AdsPower 窗口，严禁在台账直接删除代理记录（防 AdsPower 回落本机直连团灭）！",
                "deliver": "AdsPower 专属窗口就绪并与手机同路线绑定",
                "stop": "AdsPower 代理检测显示红色连接失败时严禁强开窗口",
                "guards": [_G("家宽到期换IP时", "直接删旧代理导致窗口回退本机真实公网IP", "后端删除保护硬拦截在用代理删除", "先换绑新代理测试通过，再退役旧代理", "锁止窗口更换新SOCKS5主机端口", "主管", "AdsPower窗口序号")],
                "materials": [
                    ("ads_window_no", "创建的 AdsPower 窗口编号与序号", "text", 1, "例：ADS-020 (#402)"),
                ],
            },
        ],
    },
    {
        "code": "XY-P2",
        "title": "阶段 2 · 淘宝底层注册·防不当注册登录与跨轨企业认证",
        "desc": "手机快捷登录防不当注册、客户法人扫脸录像留存，并在关联企业支付宝通过 C10 企业管家授权后完成企业店认证。",
        "duration": "第 2~3 天",
        "steps": [
            {
                "code": "S06",
                "title": "打开 reg.taobao.com 用新手机号注册淘宝号并单向锁入密码/2FA",
                "who": "开店员工（单向锁密）",
                "when": "在专属 AdsPower 窗口/工作机内执行",
                "guide": "1. 打开淘宝用户注册页 https://reg.taobao.com/member/reg/fill_mobile.htm ，用本槽位新手机号获取短信码完成注册；\n2. 设置登录密码，并在下方【🔑 新设密码单向锁入保险箱】录入密码与可选 TOTP 种子(fakey)，一键加密同步至本机 AdsPower 自动填充（保存后员工端不显明文）。",
                "warn": "记录生成的 tb_ 开头会员名，密码当场锁入系统保险箱，禁止写在外部表格！",
                "deliver": "淘宝底层账号注册完成且凭据已加密托管至 AdsPower",
                "stop": "手机号提示已被前号主注册旧淘宝时，立即停手换纯净号卡",
                "unlock_vault_lockin": 1,
                "guards": [_G("使用运营商二次放号卡注册时", "登进前号主残留账号继续开店", "核对是否为全新 tb_ 会员号", "遇二次放号残留立即换卡，绝不接着用", "申请退换新号卡重注", "开店员工", "tb_会员名登记")],
                "materials": [
                    ("tb_login_id", "新注册的 tb_ 开头淘宝会员名", "text", 1, "例：tb_wyq9002"),
                ],
            },
            {
                "code": "S07",
                "title": "【防不当注册铁律】用手机号快捷登录淘宝（严禁支付宝快捷登录！）",
                "who": "开店员工",
                "when": "注册后首次登录淘宝/千牛时",
                "guide": "1. 使用刚才注册的「手机号 + 短信/密码」直接快捷登录淘宝；\n2. 此时绝对不要点「支付宝快捷登录」，也绝对不要主动点进账户设置里的「支付宝绑定页面」去手工绑支付宝！",
                "warn": "【最高频废号大坑】个人/新店底层号在首次上架商品前，一旦点「支付宝快捷登录」或直接进支付宝绑定页硬绑，100% 触发阿里「不当注册」风控秒封！必须留到阶段3用五位数上架商品自然触发弹窗绑定！",
                "deliver": "手机号安全登录成功，未误触支付宝直绑入口",
                "stop": "万一误触弹出不当注册拦截，立即暂停一切操作报主管（严禁重复猛点重试！）",
                "require_confirm": 1,
                "guards": [_G("刚注册完淘宝习惯性去设置里先把支付宝绑好", "直接点进支付宝绑定页触发不当注册锁号", "强确认框拦截提醒延后至S12五位数上架触发", "千牛没发五位数商品前，当支付宝按钮不存在！", "触发不当注册后转账号异常工单冷却申诉", "主管", "安全登录确认")],
                "materials": [
                    ("safe_login_ack", "确认已用手机号直接登录且未点支付宝绑定", "text", 1, "输入：已按手机号登录，未触碰支付宝页"),
                ],
            },
            {
                "code": "S08",
                "title": "完成开店实名扫脸认证并全程录像留档",
                "who": "开店员工 + 法人配合扫脸 · 主管审核",
                "when": "进入免费开店实名认证环节（个人店2次/企业店3次扫脸均须录像）",
                "guide": "1. 在淘宝「免费开店」按店铺类型（个人号或企业店）发起法人实名扫脸认证；\n2. 扫脸全过程直至跳出「认证成功回执页」必须完整录像留存，上传供主管审核。",
                "warn": "录像必须拍到最终「实名成功回执界面」，半截断录会被主管打回重审！",
                "deliver": "开店实名扫脸一次通过且完整录像归档",
                "stop": "扫脸提示同一身份证开店数达上限时核查路线槽位是否超配",
                "require_confirm": 1,
                "require_review": 1,
                "guards": [_G("法人配合连续扫多个号时", "扫完脸没等跳成功页就关相机导致缺回执", "主管审核强验完整回执帧", "看到绿色通过勾再停录", "补拍实名认证已通过详情页并重交", "主管", "扫脸过程完整录像")],
                "materials": [
                    ("face_verify_video", "开店实名扫脸全程录像文件/凭证", "text", 1, "须包含最终认证成功回执画面"),
                ],
            },
            {
                "code": "S09",
                "title": "【跨轨强关联闸口 ①】使用营业执照开通企业店铺认证（需关联企支过 C10）",
                "who": "开店员工提交 · 主管审核",
                "when": "企业店铺上传执照完成主体认证时（个人闲鱼号可申请跳过本步）",
                "guide": "1. 选择「企业店铺 / 切换企业账号认证」，上传本路线营业执照完成主体核验；\n2. 系统自动联锁检查：本店绑定的企业支付宝必须已完成【C10 第1天法人企业管家一键授权】，否则本步自动锁止，请先点击锁提示一键跳去推进企业支付宝开户轨！",
                "warn": "一台设备只跑一条路线的企业号！关联的企业支付宝未完成 C10 企业管家授权前，系统硬锁死本步防止半拉子建店卡死在绑户环节！",
                "deliver": "闲鱼/淘宝企业店铺营业执照主体认证通过",
                "stop": "关联企支未过 C10 时先完成企支 C10；平台驳回补件时原样登记驳回原因",
                "require_review": 1,
                "cross_gate_rule": "require_alipay_step:C10",
                "guards": [_G("企业支付宝还没做第1天企业管家授权就急着开企业店", "店开到一半绑不了对应企业支付宝导致法人二次折腾", "跨轨 Gate-1 服务端硬校验关联企支 C10=approved", "先过企支C10企业管家授权，再解锁本步企业店认证", "点击锁卡上的快捷入口先去完成企支C10", "开店员工 + 主管", "企业店铺认证通过截图")],
                "materials": [
                    ("ent_store_cert_img", "企业店铺营业执照认证通过截图", "text", 1, "需显示认证企业名称与本路线执照一致"),
                ],
            },
        ],
    },
    {
        "code": "XY-P3",
        "title": "阶段 3 · 千牛三权限排查与「五位数标价首架自然触发绑支」",
        "desc": "开启 GPS/相册/输入法三权限，发五位数价格指纹静物图自然弹出支付宝绑定窗，彻底规避不当注册。",
        "duration": "第 3~4 天",
        "steps": [
            {
                "code": "S10",
                "title": "登录千牛卖家中心排查三大系统权限（GPS定位 / 相册 / 输入法）",
                "who": "开店员工",
                "when": "首次发布商品之前",
                "guide": "1. 登录千牛卖家中心 (myseller.taobao.com 或手机千牛)；\n2. 逐一检查并开启三项环境权限：① GPS 地理位置定位正常（与执照/家宽城市匹配）；② 照片相册读取开启；③ 系统原生安全输入法正常。",
                "warn": "权限缺失（尤其是定位空白或异常输入法）会在首次发品时抬高设备异常风控分！",
                "deliver": "GPS定位、相册、输入法三项权限自检全部合格",
                "stop": "GPS定位漂移到境外或外省异常基站时立即停用排查代理与定位设置",
                "guards": [_G("新刷机的空工作手机首次开千牛", "默认拒绝了定位权限直接发品触发异地核身", "发品前强制登记三权限自检结果", "进千牛先看定位、相册、输入法三绿灯", "在系统设置补开权限重启千牛", "开店员工", "三权限检查记录")],
                "materials": [
                    ("perm_check_note", "GPS / 照片相册 / 输入法三项权限检查结论", "textarea", 1, "逐项写明：GPS=正常(杭州)、相册=已开启、输入法=系统默认"),
                ],
            },
            {
                "code": "S11",
                "title": "准备公司独立指纹处理的实拍静物商品图",
                "who": "开店员工",
                "when": "首次发品素材准备",
                "guide": "1. 取用公司图库经独立指纹/EXIF 去重生成的实拍日常静物照片（每店独立一套，不与他店撞MD5）；\n2. 严禁从淘宝/拼多多/百度随手右键保存网图首架。",
                "warn": "首架商品用全网烂大街网图会触发盗图/劣质铺货模型！",
                "deliver": "本铺专属去重实拍静物图就绪",
                "stop": "图片MD5与其它13家店重复时重新拍摄生成",
                "guards": [_G("连开4家店图省事用同一张水杯照片", "图片哈希完全一致被判定同团伙矩阵号", "每店独立实拍静物图要求", "一店一图，绝不复用同张原图", "重拍桌面不同静物后再传", "开店员工", "首架静物图文件名")],
                "materials": [
                    ("first_item_img_ref", "首架独立静物图片编号/说明", "text", 1, "例：STATIC-SHOT-WYQ02.jpg"),
                ],
            },
            {
                "code": "S12",
                "title": "【核心防呆技法】首次发布宝贝并将价格标为「五位数」（触发绑支提醒）",
                "who": "开店员工",
                "when": "宝贝管理 → 发布首件宝贝时",
                "guide": "1. 进入「宝贝管理 → 发布宝贝」，上传 S11 静物照片填写正常闲置/百货标题；\n2. 将商品售价故意标为【五位数】（例如 ¥12,800 ~ ¥39,999），既能 100% 触发系统弹出「请绑定收款支付宝」官方引导提醒，又能防止未就绪前被路人真实拍下付款！",
                "warn": "不要标 1 元或几十元（容易被秒拍产生未就绪订单纠纷），必须标五位数触发官方绑支弹窗！",
                "deliver": "五位数首件宝贝提交并成功弹出官方绑定支付宝提醒窗",
                "stop": "若发品直接报违规拦截，截图保留原文报主管，切勿反复连发",
                "require_confirm": 1,
                "guards": [_G("首次上架随便标了9.9元", "还没测通账单就被买家拍下引发超时发货处罚", "强制五位数标价确认", "首架标五位数：防误拍 + 自然弹绑支窗", "立即改价为五位数或下架重发", "开店员工", "五位数上架与弹窗截图")],
                "materials": [
                    ("five_digit_price_img", "五位数标价商品及弹出绑定支付宝提醒截图", "text", 1, "需清晰看到五位数标价与系统绑支提示"),
                ],
            },
            {
                "code": "S13",
                "title": "顺着上架提醒弹窗自然完成同主体销售支付宝绑定（零不当注册）",
                "who": "开店员工提交 · 主管审核",
                "when": "S12 系统弹出绑定支付宝提醒后顺势点击",
                "guide": "1. 直接点击 S12 弹出的官方提醒入口，绑定台账分配给本店的同营业执照「纯销售收款企业支付宝 (sales_only)」；\n2. 核对绑定成功且全程无「不当注册」风控黄条报错，截图提交主管审核。",
                "warn": "严禁绑错成同主体的「采购因公付子号」或「3选1主资金池」，更严禁跨营业执照绑支付宝！",
                "deliver": "同主体销售支付宝丝滑绑定成功，零不当注册异常",
                "stop": "若提示主体不一致或风控拦截，核查 S09 执照与 C10 企支是否同源",
                "require_confirm": 1,
                "require_review": 1,
                "guards": [_G("同一执照下有主户、采购户、销售户3~4个支付宝", "选错绑成了采购支付宝导致买卖混同", "台账触发器硬阻断 sales_only 店绑非 sales_only 企支", "看清台账尾缀 -S1/-S2 销售专用号再绑", "解绑重绑正确的 sales_only 支付宝", "主管", "支付宝绑定成功无异常截图")],
                "materials": [
                    ("alipay_bind_ok_img", "支付宝绑定成功且无不当注册报错截图", "text", 1, "核对绑定的支付宝邮箱与台账一致"),
                ],
            },
        ],
    },
    {
        "code": "XY-P4",
        "title": "阶段 4 · 闲鱼端基建·保证金锚定与 0.1 元富阳门牌号真实核验",
        "desc": "完善闲鱼头像与保证金原路退保登记，在闲鱼APP完成0.1元教资PDF购买+富阳门牌号地址真实性校验。",
        "duration": "第 4 天",
        "steps": [
            {
                "code": "S14",
                "title": "闲鱼 APP 设置头像/简介并登记保证金及原路退保账户",
                "who": "开店员工",
                "when": "支付宝绑定通过后登录工作机闲鱼 APP",
                "guide": "1. 在专属工作手机打开闲鱼 APP，设置符合类目定位的清晰头像与店铺简介（亮照公示）；\n2. 按类目缴纳保证金（如标准店 ¥1,000 / 鱼小铺 ¥2,000），并在台账财务预留槽写清「保证金原出资及退保回款账户」。",
                "warn": "缴纳保证金必须记录原出资户，防止日后关店退保时找不到钱退回了哪张卡！",
                "deliver": "闲鱼头像、亮照与保证金财务槽位登记完成",
                "stop": "闲鱼提示需补亮照授权时回企业管家确认亮照开关",
                "guards": [_G("缴纳千元保证金未记出资来源", "一年后调整店铺退保对不上其他应收款", "关联单账号财务预留槽 deposit_source_ref", "交一笔保、记一笔源", "查支付宝出账流水补登原路户", "开店员工 + 财务", "闲鱼头像与保证金页截图")],
                "materials": [
                    ("xy_avatar_dep_img", "闲鱼头像设置及保证金状态截图", "text", 1, "注明保证金金额（免保填0并说明）"),
                ],
            },
            {
                "code": "S15",
                "title": "【交付验证】闲鱼 APP 购买 0.1 元教资 PDF 材料（地址填富阳精确到门牌号）",
                "who": "开店员工提交 · 主管审核",
                "when": "开售前真实交易环境与收货地址激活验证",
                "guide": "1. 在工作机闲鱼 APP 搜索并真实下单购买一份「教资 PDF 学习材料（0.1 元）」；\n2. 填写收货地址时，统一设为【杭州富阳区任意真实街道地点，且必须精确到具体门牌号】（闲鱼交易风控以手机 APP 端真实收货行为准）；\n3. 若同步配套小红书引流号，一并确认小红书号已注册就绪。",
                "warn": "收货地址严禁只写到区/街道模糊字样，必须精确到门牌号！只做这一笔 0.1 元开店环境验证，开售运营后该销售号严禁再日常采购囤券（买卖隔离）！",
                "deliver": "0.1元验证单完成且富阳门牌号地址入库",
                "stop": "下单弹支付限制时排查工作机网络是否跳出家宽热点",
                "require_review": 1,
                "guards": [_G("填写验证收货地址敷衍了事", "只填“富阳区某路”缺门牌号被主管审核打回", "主管必核截图内富阳具体门牌号", "写到XX路XX号XX室，一次过审", "修改地址精确到门牌号重拍提交", "主管", "0.1元购买记录与富阳门牌号截图")],
                "materials": [
                    ("fuyang_addr_img", "0.1元购买记录及富阳精确门牌号地址截图", "text", 1, "地址须精确到门牌号"),
                ],
            },
            {
                "code": "S16",
                "title": "核验店铺商品公域搜索可见性（确认零隐形限流）",
                "who": "开店员工",
                "when": "0.1 元验证完成后",
                "guide": "1. 用非同WiFi的外部测试端在闲鱼搜索本铺五位数测试商品全称关键词；\n2. 确认能正常搜出且店铺主页可正常访问、私信收发秒达。",
                "warn": "若新店刚开就搜不到全标题，说明环境或词根触发静默屏蔽，切勿盲目批量上品！",
                "deliver": "公域搜索曝光与私信会话实测正常",
                "stop": "搜不到全标题时留置养号48小时并报主管复检",
                "guards": [_G("不测搜索直接批量铺几十个虚拟卡券商品", "在静默限流态猛发品导致直接封店", "开售前必测全标题搜索可见", "先搜得到测试品，再换正式品", "下架敏感词测试品养号观察", "开店员工", "外部搜索可见截图")],
                "materials": [
                    ("search_visible_proof", "公域搜索可见性核验截图/结论", "text", 1, "确认全标题可正常检索展示"),
                ],
            },
        ],
    },
    {
        "code": "XY-P5",
        "title": "阶段 5 · 14槽位归档入柜与跨轨财务终检开售（硬闸口 ②）",
        "desc": "证照档案袋打 DA 标签入柜，且必须等关联企业支付宝完成 D15 T+1 账单 API 核实后，方可正式切换在售。",
        "duration": "T+1 收口上线",
        "steps": [
            {
                "code": "S17",
                "title": "核对路线槽位零交叉并打印档案袋标签（DA-YYYY-XXXX）归档入柜",
                "who": "开店员工提交 · 主管审核",
                "when": "正式开售前档案收口",
                "guide": "1. 在台账复核本店「执照-企支-手机号-沃邮箱/子邮-设备-家宽IP-Ads窗口」无任何跨路线交叉重复；\n2. 将托管运营合同、执照副本、身份证复印件与通信授权协议装入客户档案袋，粘贴系统标签号（格式 DA-2026-XXXX）入柜拍照。",
                "warn": "映射表错一格后面财务全是糊涂账；纸质档案袋标签号必须与电子台账完全一致！",
                "deliver": "电子槽位核验零交叉，实体档案袋贴标入柜",
                "stop": "发现同一手机号或邮箱误挂两条路线时立即整改解绑",
                "require_review": 1,
                "guards": [_G("开完店材料随手塞抽屉不贴标", "半年后工商抽查或换卡找不到原协议与执照正本", "必填 DA-2026-XXXX 标准档案袋号审核", "一主体一袋，标签对号入柜", "补打标签归柜重拍", "主管", "归档入柜照片 + DA标签号")],
                "materials": [
                    ("archive_bag_no", "系统档案袋标签号（DA-YYYY-XXXX）", "text", 1, "例：DA-2026-0102"),
                    ("archive_photo", "实体材料装袋入柜照片凭证", "text", 1, "标签清晰可见"),
                ],
            },
            {
                "code": "S18",
                "title": "【跨轨强关联闸口 ②】核验企支 D15 账单 API 已连通，改正常价正式开售！",
                "who": "开店员工申请 · 主管终审放行",
                "when": "关联企业支付宝已完成 D15（T+1 账单 API 核实通过）后执行",
                "guide": "1. 系统自动执行跨轨终检：本店绑定的企业支付宝必须已完成【D15 T+1 与程序员核实 0.xx 账单 API 一一对应】；\n2. 终检通过后，下架五位数占位静物图，按《虚拟产品定价底线规范》（售价≥进价×130% 或核定码券线）上架正式商品；\n3. 主管点击审核通过后，台账自动将本店铺状态转为「正式在售 (active)」并计发建店奖励（+8分 / ¥100）！",
                "warn": "【铁闸封顶】只要关联企业支付宝还没过 D15 账单 API 核实，本按钮永久硬锁止！绝不允许任何一家账单未打通的闲鱼店提前接客收钱！",
                "deliver": "店铺正式切换为 active 在售状态，纳入日常经营与提成核算",
                "stop": "关联支付宝 D15 待核实时锁止等待，严禁私自改价偷卖",
                "require_confirm": 1,
                "require_review": 1,
                "cross_gate_rule": "require_alipay_step:D15",
                "guards": [_G("店铺全备好了但支付宝T+1账单还没找程序员核对", "抢先上架出单导致首日几十笔回款进错财务科目", "跨轨 Gate-2 服务端硬校验关联企支 D15=approved", "企支D15绿灯亮，闲鱼S18才开门", "先催办并审过关联支付宝D15步骤", "主管 + 财务", "正式商品上架与台账转active记录")],
                "materials": [
                    ("launch_ready_note", "正式上架类目与定价合规自检确认", "textarea", 1, "确认五位数测试品已替换，正式商品符合毛利底线"),
                ],
            },
        ],
    },
]


# ==================== 3. 主管专用元教程：《教程制作工作法》（3阶段 · 8步） ====================
META_AUTHORING_STAGES = [
    {
        "code": "META-1",
        "title": "阶段 1 · 亲手实操与录屏取证（严禁凭空编教程）",
        "desc": "主管接到新平台（如微信小店/小红书小店/抖店）教程缺口任务后，必须先亲手走通一遍真实开店并录屏。",
        "duration": "当天完成",
        "steps": [
            {"code": "M01", "title": "认领平台教程缺口并明确验收边界", "guide": "在主管端【教程缺口矩阵】认领尚未覆盖的平台（如微信小店、小红书小店、抖店等），明确开店目标、所需证照与收款通道。", "warn": "", "deliver": "缺口任务已认领", "materials": [("target_platform", "认领编写的平台名称", "text", 1, "如：微信小店")]},
            {"code": "M02", "title": "用隔离环境从头到尾亲手实操一遍开店全流程", "guide": "边做边记每一步实际点了哪里、填了什么、遇到什么弹窗或反直觉坑点。这一遍是教程唯一事实源。", "warn": "严禁跳过实操凭想象或抄网上过期文章写教程，与真实页面不符会被老板打回！", "deliver": "实操原始流水笔记完备", "materials": [("raw_notes", "实操点击路径与坑点记录", "textarea", 1, "每行一步真实记录")]},
            {"code": "M03", "title": "关闭无关窗口完整录制实操视频与关键截图", "guide": "重走或分段录制清晰 MP4 操作视频，截取关键报错/成功回执界面。", "warn": "录屏前务必关闭含他人隐私或明文密码的窗口！密码/验证码绝不进教程视频！", "deliver": "MP4录屏与关键截图备妥", "materials": [("video_ref", "实操录屏MP4归档路径", "text", 1, "未录完前在模板中必须诚实留空标待录")]},
            {"code": "M04", "title": "归档实操凭证至工作台媒体库", "guide": "上传录屏与截图获取长期有效内部访问地址，禁止外链失效网盘。", "warn": "", "deliver": "凭证地址可正常预览", "materials": [("upload_ok", "上传核验确认", "text", 1, "确认图片视频可打开")]},
        ],
    },
    {
        "code": "META-2",
        "title": "阶段 2 · 搭建三层防呆骨架与跨轨依赖锁",
        "desc": "在主管端教程工坊按「阶段 → 步骤 → 提交材料」录入，补齐红色 warnText、7字段防呆矩阵与跨平台前置锁。",
        "duration": "当天完成",
        "steps": [
            {"code": "M05", "title": "在【教程编排工坊】建立阶段与细颗粒原子步骤", "guide": "把复杂开店拆成一步一动作（每步只做1个决定），配置谁来做、何时用与操作说明。", "warn": "", "deliver": "阶段与步骤树建成", "materials": [("outline_summary", "阶段数与总步数摘要", "text", 1, "例：4阶段16步")]},
            {"code": "M06", "title": "逐项补全易错红线(warnText)、提交材料与闸口开关", "guide": "凡不看会废号的地方写入 warnText（前端红色平铺展示）；关键节点打开 require_review（主管审核闸口）或跨轨依赖锁（如依赖支付宝/微信商户号前置步骤）。", "warn": "防呆优先于培训：能在步骤闸口拦住的，绝不靠口头叮嘱员工记忆！", "deliver": "防呆红线与必填材料配齐", "materials": [("guard_check", "审核闸口与防呆配置确认", "text", 1, "写明哪几步开了审核闸口")]},
            {"code": "M07", "title": "挂载真实视频链接并找1名员工做盲测复现", "guide": "挂载真实 MP4 地址（暂未录制的步骤保持空值诚实显示“待录”）；让员工不问主管仅照教程走通一遍。", "warn": "智能体与主管均严禁编造假视频链接或假 Wiki 链接！", "deliver": "视频挂载诚实准确且盲测可走通", "materials": [("repro_staff", "参与盲测复现的员工与结果", "text", 1, "不问原作者也能一次做对")]},
        ],
    },
    {
        "code": "META-3",
        "title": "阶段 3 · 提交老板终审并发布上线",
        "desc": "提交至老板端终审，批准后立即点亮该平台教程覆盖绿灯，全体开店员工可按步执行。",
        "duration": "当天收口",
        "steps": [
            {"code": "M08", "title": "提交老板终审上线（消除平台教程缺口）", "guide": "在教程编排工坊将模板状态提交为「待老板终审 (pending_boss)」，老板一键批准后正式上线。", "warn": "", "deliver": "教程上线发布", "require_confirm": 1, "require_review": 1, "materials": [("final_brief", "提审结构摘要（几阶段几步几闸口）", "textarea", 1, "供老板30秒终审决策")]},
        ],
    },
]


def _insert_template_tree(cur: sqlite3.Cursor, tpl_row: tuple, stages_spec: list[dict]) -> dict[str, str]:
    """幂等写入一套完整教程树，返回 {step_code: step_id}"""
    cur.execute(
        """INSERT INTO tutorial_templates
           (id, code, target_kind, platform, title, version, summary, author_staff, status, reward_points, reward_yuan, sla_days, boss_review_note, published_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        tpl_row,
    )
    tpl_id = tpl_row[0]
    step_id_by_code: dict[str, str] = {}
    global_order = 0

    for s_idx, stg in enumerate(stages_spec, start=1):
        stg_id = f"stg-{tpl_id}-{s_idx:02d}"
        cur.execute(
            """INSERT INTO tutorial_stages (id, template_id, stage_code, title, description, duration_note, sort_order)
               VALUES (?,?,?,?,?,?,?)""",
            (stg_id, tpl_id, stg["code"], stg["title"], stg.get("desc", ""), stg.get("duration", "当天完成"), s_idx),
        )
        for stp in stg["steps"]:
            global_order += 1
            stp_id = f"stp-{tpl_id}-{stp['code']}"
            step_id_by_code[stp["code"]] = stp_id
            cur.execute(
                """INSERT INTO tutorial_steps
                   (id, template_id, stage_id, step_code, sort_order, title, owner_role, when_to_use,
                    guide, warn_text, deliver_note, stop_condition, video_url, wiki_url, kpi_impact,
                    terms_json, guard_json, require_confirm, require_review, cross_gate_rule, unlock_vault_lockin)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    stp_id,
                    tpl_id,
                    stg_id,
                    stp["code"],
                    global_order,
                    stp["title"],
                    stp.get("who", "开店员工"),
                    stp.get("when", "按阶段顺序推进至本节点时执行"),
                    stp.get("guide", ""),
                    stp.get("warn", ""),
                    stp.get("deliver", ""),
                    stp.get("stop", "遇异常报错立即停手截图报主管，禁止盲目重试"),
                    stp.get("video_url", ""),  # 诚实留空表示待录，绝不编假链接
                    stp.get("wiki_url", ""),
                    stp.get("kpi", "影响建店一次通过率、14天开店SLA与+8分教程绩效"),
                    json.dumps(stp.get("terms", ["路线台账", "不当注册", "因公支付", "T+1账单核实"]), ensure_ascii=False),
                    json.dumps(stp.get("guards", []), ensure_ascii=False),
                    int(stp.get("require_confirm", 0)),
                    int(stp.get("require_review", 0)),
                    stp.get("cross_gate_rule", ""),
                    int(stp.get("unlock_vault_lockin", 0)),
                ),
            )
            for m_idx, mat in enumerate(stp.get("materials", []), start=1):
                m_key, m_lbl, m_type, m_req, m_help = mat
                cur.execute(
                    """INSERT INTO tutorial_step_materials
                       (id, step_id, material_key, label, input_type, required, help_text, sort_order)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (f"mat-{stp_id}-{m_idx}", stp_id, m_key, m_lbl, m_type, m_req, m_help, m_idx),
                )
    return step_id_by_code


def ensure_tutorials_and_gaps_seeded(conn: sqlite3.Connection) -> None:
    conn.executescript(TUTORIAL_GAP_DDL)
    cur = conn.cursor()

    if cur.execute("SELECT COUNT(*) FROM tutorial_templates").fetchone()[0] > 0:
        conn.commit()
        return

    # 1) 写入委托客户受托目标配额（1号主力委托客户林建国 vs 2号新签约客户王雅琴——直观呈现全维受托缺口对比！）
    lp1_plat_targets = {
        "xianyu": 15,            # 14销售店 + 1独立采购号（已满15，其中1店待T+1核验开售、1店代理过期受限）
        "wechat_shop": 3,        # 现有2，缺1家（主体2待开微信小店）
        "xiaohongshu_shop": 3,   # 现有2，缺1家
        "xiaohongshu_mkt": 4,    # 现有2，缺2个种草号
        "wechat": 3,             # 现有2，缺1个私域号
        "doudian": 2,            # 现有1，缺1家抖店
        "taobao_store": 2,       # 现有1，缺1家淘宝企业店
        "jd_store": 1,           # 现有1，已达标
        "dianping": 4,           # 现有3，缺1个买券号
        "douyin": 2,             # 现有2，已达标
        "doushengsheng": 2,      # 现有2，已达标
        "taobao_buyer": 1,       # 现有1
        "jd_buyer": 1,           # 现有1
    }
    lp2_plat_targets = {
        "xianyu": 14,            # 二号签约委托客户王雅琴托管目标：4本执照 -> 14家闲鱼店（当前仅1家在售+2家开店中，净缺口11家！）
        "wechat_shop": 2,
        "xiaohongshu_shop": 2,
        "dianping": 2,
        "douyin": 2,
    }
    cur.executemany(
        """INSERT INTO matrix_quota_targets
           (id, legal_person_id, target_licenses, target_tax_regs, target_annual_reports,
            target_alipays, target_proxies, target_work_phones, target_sim_slots, platform_targets_json, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        [
            ("mqt-ljg", "lp-ljg", 4, 4, 4, 14, 16, 14, 16, json.dumps(lp1_plat_targets, ensure_ascii=False), "林建国主力成熟矩阵：闲鱼14店已齐，新平台小店与买券号少量扩充缺口"),
            ("mqt-wyq", "lp-wyq", 4, 4, 4, 12, 14, 14, 14, json.dumps(lp2_plat_targets, ensure_ascii=False), "二号委托客户王雅琴托管矩阵：4受托执照→12企支→14受托闲鱼店建店中，缺口集中待派单！"),
        ],
    )

    # 2) 写入三大核心教程模板 + 1个待老板终审的新编微信小店教程草稿（展示主管做教程->老板终审闭环！）
    ali_steps_map = _insert_template_tree(
        cur,
        (
            "tpl-alipay-ent", "TPL-ALIPAY-ENT", "alipay", "alipay",
            "企业支付宝标准开户与 T+1 账单 API 连通教程（15步防呆版）", "v2.0",
            "涵盖前置联通卡/主邮箱、b.alipay.com反向扫码创单、第1天法人企业管家一键授权、主体3选1因公配置及0.xx差异金额T+1账单API核实。",
            "周安(主管)", "published", 8, 100, 7, "已核准为全公司企业支付宝唯一开户标准", "2026-11-10"
        ),
        ALIPAY_STAGES,
    )
    xy_steps_map = _insert_template_tree(
        cur,
        (
            "tpl-xianyu-store", "TPL-XIANYU-STORE", "platform", "xianyu",
            "闲鱼矩阵开店全流程手把手教程（18步 · 双锁联动企业支付宝）", "v2.0",
            "涵盖路线槽位领用、自研指纹ADB灌录、¥10家宽同平台独占、防不当注册手机号登录、五位数首架触发绑支、0.1元富阳门牌号验证及T+1财务终检上架。",
            "周安(主管)", "published", 8, 100, 14, "已核准上线，强制联动企业支付宝 C10 与 D15 双闸口", "2026-11-10"
        ),
        XIANYU_STAGES,
    )
    _insert_template_tree(
        cur,
        (
            "tpl-meta-authoring", "TPL-AUTHORING-META", "meta_authoring", "",
            "主管专用 · 教程制作工作法（实操录屏→三层骨架→防呆上线）", "v1.0",
            "指导主管将微信小店、小红书小店、抖店等空白平台沉淀为可执行步入式教程。",
            "总经办", "published", 10, 150, 7, "主管制课标准SOP", "2026-11-05"
        ),
        META_AUTHORING_STAGES,
    )

    # 主管刚编好、正在等老板终审上线的《微信小店开店与财付通 mch 结算绑定教程》（pending_boss 状态演示！）
    _insert_template_tree(
        cur,
        (
            "tpl-wechat-shop-v1", "TPL-WECHAT-SHOP", "platform", "wechat_shop",
            "微信小店入驻、亮照与财付通商户号(mch_id) T+1 结算教程", "v1.0-rc1",
            "主管周安实操录屏编写完毕，含个体/有限公司营业执照入驻、¥5000保证金原路账户登记、超级管理员扫码与 mch_id 对账映射，待老板终审发布。",
            "周安(主管)", "pending_boss", 8, 100, 10, "", ""
        ),
        [
            {
                "code": "WXS-P1",
                "title": "阶段 1 · 执照核验与微信小店开店入驻",
                "desc": "复用闲鱼已验证过的同主体营业执照与异平台合法复用家宽 IP 入驻微信小店。",
                "duration": "第 1~2 天",
                "steps": [
                    {"code": "W01", "title": "选定营业执照与异平台复用家宽代理 IP", "guide": "1. 选择已签署托管合同且税务工商状态正常的对应委托客户营业执照；2. 在 AdsPower 绑定一条尚未挂微信小店的家宽 IP（可与闲鱼合法跨平台复用）。", "warn": "同一条家宽 IP 严禁挂 2 家微信小店！", "deliver": "主体与家宽锁定", "materials": [("wxs_px", "复用的家宽编号", "text", 1, "如 IP-JX-05")]},
                    {"code": "W02", "title": "打开 shop.weixin.qq.com 扫码入驻并上传执照法人实名", "guide": "上传清晰营业执照与法人身份证，法人微信扫码完成实名核验。", "warn": "超级管理员微信号绑定的手机号必须已纳入台账监控！", "deliver": "主体审核通过", "require_review": 1, "materials": [("wxs_cert", "微信小店主体认证通过截图", "text", 1, "含小店原始ID")]},
                ],
            },
            {
                "code": "WXS-P2",
                "title": "阶段 2 · 财付通商户号(mch_id)签约、缴保与 T+1 提现卡核验",
                "desc": "完成微信支付商户号签约、缴纳类目保证金并登记原路退保账户。",
                "duration": "第 3 天",
                "steps": [
                    {"code": "W03", "title": "完成微信支付商户号(mch_id)开户并绑该委托客户同主体结算银行卡", "guide": "个体户绑客户客户法人本人一类卡、有限公司绑对公基本户，将 mch_id 填入本账号财务预留槽。", "warn": "严禁绑定非本执照对应客户主体法人的私人卡！", "deliver": "mch_id 签约生效", "require_review": 1, "materials": [("mch_id_val", "生成的财付通商户号 mch_id", "text", 1, "如 mch_168830205")]},
                    {"code": "W04", "title": "缴纳类目店铺保证金并登记原路退保出资户", "guide": "按虚拟/生活卡券类目缴纳保证金（如¥5000），在台账登记原出资卡防退保迷失。", "warn": "关店退保必须原路退回原出资户！", "deliver": "保证金缴清可上架", "require_confirm": 1, "require_review": 1, "materials": [("dep_voucher", "微信小店保证金缴纳回执", "text", 1, "注明出资卡尾号")]},
                ],
            },
        ],
    )

    # 3) 为二号委托客户王雅琴新增 1 个正在开户中的销售支付宝 + 2 家正在开店中的闲鱼店，以便真实直观呈现「跨轨双锁拦截 + 材料打回重交」！
    cur.execute(
        """INSERT OR IGNORE INTO alipay_accounts
           (id, legal_person_id, business_entity_id, account_code, account_name, login_email, alipay_uid,
            entity_fund_slot, trade_direction, is_entity_master_fund, corporate_pay_enabled, master_alipay_id,
            daily_limit_fen, single_tx_limit_fen, bound_sim_id, settlement_bank, settlement_card_no,
            balance_fen, frozen_reserve_fen, month_inflow_fen, month_outflow_fen, cert_sign_mode,
            finance_book_code, bill_sync_status, account_status, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            "ali-18", "lp-wyq", "ent-wyq-01", "ALI-WYQ-S2", "山屿优选·企支销售2号[开户中]",
            "4fc2142b92@example.invalid", "2088702611000509", "主体扩展销售户[在建]", "sales_only",
            0, 0, None, 0, 5000000, "sim-17", "宁波银行鄞州支行", "0070841965032354",
            0, 0, 0, 0, "待完成C10企业管家授权与D15对账", "1012.ALI-WYQ-S2-在建",
            "待开通授权", "active", "【开户进度 9/15】正停在第10步 C10 企业管家一键授权，因此锁住了下挂闲鱼2店的企业认证！"
        ),
    )

    cur.execute(
        """INSERT OR IGNORE INTO proxy_ips
           (id, proxy_code, provider, plan_name, isp_region, protocol, host, port, proxy_user, proxy_pass,
            exit_ip, monthly_cost_fen, purchased_at, expires_at, connectivity_status, oa_renewal_ref, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            "px-17", "IP-NB-17", "蛟龙家宽代理", "套餐⑤独享家宽-25M", "浙江宁波·联通家宽", "SOCKS5",
            "nb17.jl-resi.net", 21017, "anch_nb17", "Jk9#mP2x17", "124.160.88.62", 1000,
            "2026-11-14", "2026-12-14", "online", "待接入OA/钉钉续费", "二号委托客户山屿闲鱼2店独占家宽IP"
        ),
    )

    cur.executemany(
        """INSERT OR IGNORE INTO platform_accounts
           (id, legal_person_id, business_entity_id, platform, account_code, display_name, platform_login_id,
            account_role, virtual_biz_usage, bound_sim_id, alipay_account_id, adspower_profile_id, proxy_ip_id,
            physical_device_id, lead_target_account_id, settlement_channel, merchant_account_no, settlement_bank_ref,
            settlement_cycle, commission_rate_bps, deposit_fen, deposit_source_ref, frozen_balance_fen,
            month_gmv_fen, month_cost_fen, month_refund_fen, tax_invoice_mode, finance_book_code,
            daily_quota_note, operator_staff, account_status, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        [
            (
                "pa-wyq-xy02", "lp-wyq", "ent-wyq-01", "xianyu", "WYQ-XY02", "山屿优选卡券2店[建店中]",
                "tb_wyq9002", "sales_only", "售卖茶饮电子券与AI权益", "sim-17", "ali-18", None, "px-17",
                "dev-ph-15", None, "alipay_direct", "待企支C10/D15解锁", "宁波银行鄞州支行 *6618",
                "确认收货实时", 60, 0, "待S14缴保登记", 0, 0, 0, 0, "个体普票按季30万阈值合规监测",
                "ERP-SHOP-WYQ-XY02", "建店第8/18步·等企支C10解锁S09", "赵宇", "warming",
                "【跨轨锁演示①】前8步已完成，第9步S09企业认证因关联支付宝ALI-WYQ-S2尚未完成C10企业管家授权而自动锁止！"
            ),
            (
                "pa-wyq-xy03", "lp-wyq", "ent-wyq-01", "xianyu", "WYQ-XY03", "山屿数码服务3店[材料被打回]",
                "tb_wyq9003", "sales_only", "售卖远程装机与数码服务", "sim-18", "ali-16", None, None,
                "dev-ph-15", None, "alipay_direct", "待绑定家宽与完成扫脸", "宁波银行鄞州支行 *6618",
                "确认收货实时", 60, 0, "待S14缴保登记", 0, 0, 0, 0, "个体普票按季30万阈值合规监测",
                "ERP-SHOP-WYQ-XY03", "建店第7/18步·S08扫脸被打回", "陈晓雯", "warming",
                "【打回重交演示】第8步S08客户法人扫脸录像缺少认证成功尾帧被主管周安打回，员工端红标置顶待重交；且尚未分配家宽IP！"
            ),
        ],
    )

    # 将 pa-xy-14（林婷负责的溪谷全品类14店）与 ali-13（溪谷企支销售号，原手工导账单尚未完成D15 API连通！）设为 Gate-2 临门一脚锁止演示！
    cur.execute(
        "UPDATE platform_accounts SET account_status = 'warming', notes = '【跨轨锁演示②】前17步全部完成，停在最后第18步S18正式开售：因绑定企支ALI-E4-S1的D15(T+1账单API核实)正在等主管审核而硬锁止！' WHERE id = 'pa-xy-14'"
    )

    # 4) 为全部企业支付宝与全部闲鱼账号生成真实的 onboarding_cases 与步骤历史记录！
    ali_ordered_codes = [s["code"] for stg in ALIPAY_STAGES for s in stg["steps"]]
    xy_ordered_codes = [s["code"] for stg in XIANYU_STAGES for s in stg["steps"]]

    def _fast_approve_steps(case_id: str, codes: list[str], step_map: dict[str, str], staff: str, day_str: str = "2026-11-08") -> None:
        for idx, c_code in enumerate(codes, start=1):
            cur.execute(
                """INSERT INTO onboarding_step_submissions
                   (id, case_id, step_id, step_code, version_no, status, materials_json, confirmed,
                    submitted_by, submitted_at, reviewed_by, reviewed_at, review_note)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    f"sub-{case_id}-{c_code}-v1",
                    case_id,
                    step_map[c_code],
                    c_code,
                    1,
                    "approved",
                    json.dumps({"auto_seed": f"{c_code} 历史建店核验已归档"}, ensure_ascii=False),
                    1,
                    staff,
                    f"{day_str} 10:{idx:02d}:00",
                    "周安(主管)",
                    f"{day_str} 14:{idx:02d}:00",
                    "核验合规通过",
                ),
            )

    # 4A. 为全部 18 个企业支付宝创建开户教程实例
    ali_case_by_ali_id: dict[str, str] = {}
    for row in cur.execute("SELECT id, legal_person_id, business_entity_id, account_code, account_name FROM alipay_accounts").fetchall():
        aid, lp_id, be_id, acode, aname = row
        cid = f"case-ali-{aid}"
        ali_case_by_ali_id[aid] = cid
        if aid == "ali-18":
            # 完成 A01~B09 (9步)，当前 active 停在 C10（第1天企业管家授权）！
            cur.execute(
                """INSERT INTO onboarding_cases
                   (id, template_id, target_kind, target_id, legal_person_id, business_entity_id,
                    case_title, assigned_staff, supervisor_staff, status, started_at, due_at, notes)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (cid, "tpl-alipay-ent", "alipay", aid, lp_id, be_id, f"{acode} · {aname}", "赵宇", "周安", "in_progress", "2026-11-14", "2026-11-21", "待趁委托客户法人在场完成 C10 企业管家授权"),
            )
            _fast_approve_steps(cid, ali_ordered_codes[:9], ali_steps_map, "赵宇", "2026-11-14")
        elif aid in ("ali-12", "ali-13", "ali-14"):
            # 主体4手工导账单的3个支付宝：A01~D14 已完成，D15（T+1账单API核实）已由林婷提交待主管周安审核（submitted）！
            cur.execute(
                """INSERT INTO onboarding_cases
                   (id, template_id, target_kind, target_id, legal_person_id, business_entity_id,
                    case_title, assigned_staff, supervisor_staff, status, started_at, due_at, notes)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (cid, "tpl-alipay-ent", "alipay", aid, lp_id, be_id, f"{acode} · {aname}", "林婷", "周安", "in_progress", "2026-11-11", "2026-11-18", "D15 T+1账单API核实材料已交，等主管周安点通过即可解锁溪谷14店上架！"),
            )
            _fast_approve_steps(cid, ali_ordered_codes[:14], ali_steps_map, "林婷", "2026-11-12")
            cur.execute(
                """INSERT INTO onboarding_step_submissions
                   (id, case_id, step_id, step_code, version_no, status, materials_json, confirmed,
                    submitted_by, submitted_at, reviewed_by, reviewed_at, review_note)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    f"sub-{cid}-D15-v1", cid, ali_steps_map["D15"], "D15", 1, "submitted",
                    json.dumps({"api_match_confirm": f"{acode} 次日T+1账单实拉测试金额 0.13 元，已与程序员(微信z15859900434)核对UID映射一致，请主管终核放行！"}, ensure_ascii=False),
                    1, "林婷", "2026-11-16 10:20:00", "", "", ""
                ),
            )
        else:
            # 其余成熟支付宝：15步全量完成！
            cur.execute(
                """INSERT INTO onboarding_cases
                   (id, template_id, target_kind, target_id, legal_person_id, business_entity_id,
                    case_title, assigned_staff, supervisor_staff, status, started_at, due_at, completed_at, notes)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (cid, "tpl-alipay-ent", "alipay", aid, lp_id, be_id, f"{acode} · {aname}", "陈晓雯", "周安", "completed", "2026-10-01", "2026-10-08", "2026-10-06", "15步开户与T+1账单API连通全部验收闭环"),
            )
            _fast_approve_steps(cid, ali_ordered_codes, ali_steps_map, "陈晓雯", "2026-10-05")

    # 4B. 为全部闲鱼店铺/账号创建 18 步开店教程实例，并外键强关联对应的 linked_alipay_case_id！
    for row in cur.execute(
        "SELECT id, legal_person_id, business_entity_id, account_code, display_name, alipay_account_id, operator_staff FROM platform_accounts WHERE platform = 'xianyu'"
    ).fetchall():
        pid, lp_id, be_id, pcode, dname, ali_id, staff = row
        staff = staff or "陈晓雯"
        cid = f"case-plat-{pid}"
        linked_ali_case = ali_case_by_ali_id.get(ali_id or "")

        if pid == "pa-wyq-xy02":
            # 已完成 S01~S08 (8步)，第9步 S09 因关联 ali-18 尚未通过 C10 而处于跨轨 Lock 锁止态！
            cur.execute(
                """INSERT INTO onboarding_cases
                   (id, template_id, target_kind, target_id, legal_person_id, business_entity_id, linked_alipay_case_id,
                    case_title, assigned_staff, supervisor_staff, status, started_at, due_at, notes)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (cid, "tpl-xianyu-store", "platform", pid, lp_id, be_id, linked_ali_case, f"{pcode} · {dname}", "赵宇", "周安", "blocked", "2026-11-14", "2026-11-28", "卡在 S09：等待关联支付宝 ALI-WYQ-S2 完成 C10 企业管家授权"),
            )
            _fast_approve_steps(cid, xy_ordered_codes[:8], xy_steps_map, "赵宇", "2026-11-15")
        elif pid == "pa-wyq-xy03":
            # 已完成 S01~S07 (7步)，S08 扫脸录像 v1 被打回 rejected（保留历史意见演示！）
            cur.execute(
                """INSERT INTO onboarding_cases
                   (id, template_id, target_kind, target_id, legal_person_id, business_entity_id, linked_alipay_case_id,
                    case_title, assigned_staff, supervisor_staff, status, started_at, due_at, notes)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (cid, "tpl-xianyu-store", "platform", pid, lp_id, be_id, linked_ali_case, f"{pcode} · {dname}", "陈晓雯", "周安", "blocked", "2026-11-13", "2026-11-27", "S08 实名扫脸材料被主管打回，待员工补录重提"),
            )
            _fast_approve_steps(cid, xy_ordered_codes[:7], xy_steps_map, "陈晓雯", "2026-11-14")
            cur.execute(
                """INSERT INTO onboarding_step_submissions
                   (id, case_id, step_id, step_code, version_no, status, materials_json, confirmed,
                    submitted_by, submitted_at, reviewed_by, reviewed_at, review_note)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    f"sub-{cid}-S08-v1", cid, xy_steps_map["S08"], "S08", 1, "rejected",
                    json.dumps({"face_verify_video": "wyq_xy03_face_clip1.mp4（仅录到眨眼动作，未录到回执页）"}, ensure_ascii=False),
                    1, "陈晓雯", "2026-11-15 16:10:00", "周安(主管)", "2026-11-15 17:05:00",
                    "驳回原因：扫脸录像提前中断，未拍到最终绿色『实名认证成功回执页』，请补截/重录认证通过详情页后重新提交（v1历史意见永久保留）。"
                ),
            )
        elif pid == "pa-xy-14":
            # 已完成 S01~S17 (17步)，最后一步 S18 因关联 ali-13 的 D15 尚在 submitted 未审核通过而跨轨 Lock 锁止！
            cur.execute(
                """INSERT INTO onboarding_cases
                   (id, template_id, target_kind, target_id, legal_person_id, business_entity_id, linked_alipay_case_id,
                    case_title, assigned_staff, supervisor_staff, status, started_at, due_at, notes)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (cid, "tpl-xianyu-store", "platform", pid, lp_id, be_id, linked_ali_case, f"{pcode} · {dname}", "林婷", "周安", "in_progress", "2026-11-09", "2026-11-23", "17/18步已完，等关联企支 ALI-E4-S1 审过 D15 即可解锁 S18 开售"),
            )
            _fast_approve_steps(cid, xy_ordered_codes[:17], xy_steps_map, "林婷", "2026-11-13")
        else:
            # 其余成熟在售闲鱼店（含 pa-xy-01~13, pa-xy-buy1, pa-wyq-xy01）：18步全绿完成！
            cur.execute(
                """INSERT INTO onboarding_cases
                   (id, template_id, target_kind, target_id, legal_person_id, business_entity_id, linked_alipay_case_id,
                    case_title, assigned_staff, supervisor_staff, status, started_at, due_at, completed_at, notes)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (cid, "tpl-xianyu-store", "platform", pid, lp_id, be_id, linked_ali_case, f"{pcode} · {dname}", staff, "周安", "completed", "2026-10-02", "2026-10-16", "2026-10-12", "18步标准建店与财务连通全部通过"),
            )
            _fast_approve_steps(cid, xy_ordered_codes, xy_steps_map, staff, "2026-10-10")

    # 4C. 插入一条真实的双闸跳步申请示例（待老板特批演示：独立闲鱼收货买号申请跳过企业店执照认证步或演示待审记录）
    cur.execute(
        """INSERT INTO onboarding_skip_requests
           (id, case_id, step_id, step_code, reason, requested_by, requested_at, status)
           VALUES (?,?,?,?,?,?,?,?)""",
        (
            "skip-req-demo-01",
            "case-plat-pa-wyq-xy02",
            xy_steps_map["S09"],
            "S09",
            "申请说明：询问是否可先按个人闲鱼店上线测品，不等企业管家授权？（供老板端演示驳回违规跳步申请）",
            "赵宇",
            "2026-11-16 11:15:00",
            "pending",
        ),
    )

    conn.commit()


# ==================== 核心引擎 1：单案例 6 态 + 跨轨双锁实时状态机 ====================
def evaluate_case_detail(conn: sqlite3.Connection, case_id: str) -> dict | None:
    cur = conn.cursor()
    kase = cur.execute("SELECT * FROM onboarding_cases WHERE id = ?", (case_id,)).fetchone()
    if not kase:
        return None
    k = dict(kase)
    tpl = dict(cur.execute("SELECT * FROM tutorial_templates WHERE id = ?", (k["template_id"],)).fetchone())
    stages = [dict(r) for r in cur.execute("SELECT * FROM tutorial_stages WHERE template_id = ? ORDER BY sort_order", (k["template_id"],)).fetchall()]
    steps = [dict(r) for r in cur.execute("SELECT * FROM tutorial_steps WHERE template_id = ? ORDER BY sort_order", (k["template_id"],)).fetchall()]
    mats = [dict(r) for r in cur.execute(
        "SELECT m.* FROM tutorial_step_materials m JOIN tutorial_steps s ON s.id = m.step_id WHERE s.template_id = ? ORDER BY m.sort_order",
        (k["template_id"],),
    ).fetchall()]
    mats_by_step: dict[str, list[dict]] = {}
    for m in mats:
        m["field_key"] = m["material_key"]
        m["placeholder"] = m.get("help_text") or ""
        mats_by_step.setdefault(m["step_id"], []).append(m)

    subs = [dict(r) for r in cur.execute(
        "SELECT * FROM onboarding_step_submissions WHERE case_id = ? ORDER BY step_code, version_no DESC",
        (case_id,),
    ).fetchall()]
    history_by_code: dict[str, list[dict]] = {}
    latest_by_code: dict[str, dict] = {}
    for sb in subs:
        sb["materials"] = json.loads(sb["materials_json"] or "{}")
        history_by_code.setdefault(sb["step_code"], []).append(sb)
        if sb["step_code"] not in latest_by_code:
            latest_by_code[sb["step_code"]] = sb

    skips = [dict(r) for r in cur.execute(
        "SELECT * FROM onboarding_skip_requests WHERE case_id = ? ORDER BY requested_at DESC",
        (case_id,),
    ).fetchall()]
    skip_by_code: dict[str, dict] = {}
    for sk in skips:
        if sk["step_code"] not in skip_by_code:
            skip_by_code[sk["step_code"]] = sk

    # 若关联了上游企业支付宝开户轨，查询上游支付宝已完成步骤集合！
    linked_ali_info = None
    linked_ali_approved_codes: set[str] = set()
    if k.get("linked_alipay_case_id"):
        ali_case = cur.execute("SELECT * FROM onboarding_cases WHERE id = ?", (k["linked_alipay_case_id"],)).fetchone()
        if ali_case:
            linked_ali_info = dict(ali_case)
            ali_ok_rows = cur.execute(
                "SELECT DISTINCT step_code FROM onboarding_step_submissions WHERE case_id = ? AND status IN ('approved', 'skipped')",
                (k["linked_alipay_case_id"],),
            ).fetchall()
            linked_ali_approved_codes = {r[0] for r in ali_ok_rows}
            linked_ali_info["approved_codes"] = sorted(linked_ali_approved_codes)

    all_prev_handled = True
    done_cnt = 0
    approved_review_cnt = 0
    total_review_cnt = 0
    current_step_obj = None
    has_rejected = False
    has_pending_review = False
    cross_blocked_msg = ""

    steps_by_stage: dict[str, list[dict]] = {}
    for stp in steps:
        code = stp["step_code"]
        latest = latest_by_code.get(code)
        hist = history_by_code.get(code, [])
        sk = skip_by_code.get(code)
        if stp["require_review"]:
            total_review_cnt += 1

        # 检查跨轨强关联锁（如 require_alipay_step:C10 / require_alipay_step:D15）
        cross_lock = None
        rule = (stp.get("cross_gate_rule") or "").strip()
        if rule.startswith("require_alipay_step:"):
            req_ali_code = rule.split(":", 1)[1].strip()
            if not linked_ali_info:
                cross_lock = {
                    "required_step": req_ali_code,
                    "reason": f"本店尚未绑定关联的企业支付宝开户实例，无法核验前置节点【{req_ali_code}】",
                    "consequence": "未绑定合规同主体企业支付宝会导致收款串户或触发不当注册",
                    "action_hint": "请先在台账为本店铺绑定同营业执照下的销售专用企业支付宝",
                    "linked_case_id": "",
                }
            elif req_ali_code not in linked_ali_approved_codes:
                ali_step_title_row = cur.execute(
                    "SELECT title FROM tutorial_steps WHERE template_id = ? AND step_code = ?",
                    (linked_ali_info["template_id"], req_ali_code),
                ).fetchone()
                ali_step_title = ali_step_title_row[0] if ali_step_title_row else req_ali_code
                cross_lock = {
                    "required_step": req_ali_code,
                    "reason": f"强关联锁止：绑定的企业支付宝「{linked_ali_info['case_title']}」尚未完成前置节点【{req_ali_code} · {ali_step_title}】",
                    "consequence": "提前强行推进会导致企业店卡死在绑户环节，或卖货回款与财务账单API错乱污染税表",
                    "action_hint": f"点击下方按钮一键跳转至「{linked_ali_info['case_title']}」先完成 {req_ali_code}",
                    "linked_case_id": linked_ali_info["id"],
                    "linked_target_id": linked_ali_info["target_id"],
                }

        if latest and latest["status"] == "approved":
            state = "approved"
            done_cnt += 1
            if stp["require_review"]:
                approved_review_cnt += 1
        elif latest and latest["status"] == "skipped":
            state = "skipped"
            done_cnt += 1
        elif not all_prev_handled:
            state = "locked"
        elif latest and latest["status"] == "submitted":
            state = "submitted"
            has_pending_review = True
            all_prev_handled = False
        elif latest and latest["status"] == "rejected":
            state = "rejected"
            has_rejected = True
            all_prev_handled = False
        else:
            state = "active"
            all_prev_handled = False
            if cross_lock and not cross_blocked_msg:
                cross_blocked_msg = cross_lock["reason"]

        stp_out = {
            **stp,
            "terms": json.loads(stp["terms_json"] or "[]"),
            "guards": json.loads(stp["guard_json"] or "[]"),
            "materials": mats_by_step.get(stp["id"], []),
            "state": state,
            "step_state": state,
            "cross_lock": cross_lock,
            "cross_gate": {
                "locked": bool(cross_lock),
                "reason": cross_lock["reason"] if cross_lock else "",
                "consequence": cross_lock["consequence"] if cross_lock else "",
                "upstream_case_id": cross_lock["linked_case_id"] if cross_lock else "",
                "required_step_code": cross_lock["required_step"] if cross_lock else "",
            },
            "latest_submission": latest,
            "submission_history": hist,  # 完整保留 v1, v2... 所有历史审核意见！
            "history": hist,
            "skip_request": sk,
        }
        if current_step_obj is None and state in ("active", "rejected", "submitted"):
            current_step_obj = stp_out
        steps_by_stage.setdefault(stp["stage_id"], []).append(stp_out)

    total_cnt = len(steps)
    progress_pct = int(round(done_cnt * 100.0 / total_cnt)) if total_cnt else 0
    if current_step_obj is None and steps:
        current_step_obj = steps_by_stage[stages[-1]["id"]][-1]

    stage_list = [{**stg, "steps": steps_by_stage.get(stg["id"], [])} for stg in stages]

    return {
        **k,
        "template": tpl,
        "template_code": tpl["code"],
        "template_title": tpl["title"],
        "template_version": tpl["version"],
        "reward_points": tpl["reward_points"],
        "reward_yuan": tpl["reward_yuan"],
        "total_steps": total_cnt,
        "done_steps": done_cnt,
        "progress_pct": progress_pct,
        "approved_review_cnt": approved_review_cnt,
        "total_review_cnt": total_review_cnt,
        "current_step_code": current_step_obj["step_code"] if current_step_obj else "",
        "current_step_title": current_step_obj["title"] if current_step_obj else "全部完成",
        "current_step_state": current_step_obj["state"] if current_step_obj else "approved",
        "has_rejected": has_rejected,
        "has_pending_review": has_pending_review,
        "cross_blocked_msg": cross_blocked_msg,
        "linked_alipay_case": linked_ali_info,
        "stages": stage_list,
    }


def build_all_cases_summary(conn: sqlite3.Connection) -> tuple[list[dict], dict[str, dict]]:
    """构建全量开店实例轻量摘要列表 + {(target_kind, target_id): summary} 索引"""
    cur = conn.cursor()
    case_ids = [r[0] for r in cur.execute("SELECT id FROM onboarding_cases ORDER BY status DESC, id").fetchall()]
    summaries: list[dict] = []
    by_target: dict[str, dict] = {}
    for cid in case_ids:
        detail = evaluate_case_detail(conn, cid)
        if not detail:
            continue
        # 轻量摘要不重复塞入庞大的 stages 全量文本（单点打开时可按需或保留轻量stages）
        by_target[f"{detail['target_kind']}:{detail['target_id']}"] = detail
        summaries.append(detail)
    return summaries, by_target


# ==================== 核心引擎 2：全维统筹「看缺口」与红黄绿问题箱 ====================
def build_gap_and_issues_overview(
    conn: sqlite3.Connection,
    platform_labels: dict[str, str],
    cases_summary: list[dict],
    today: dt.date,
) -> dict:
    cur = conn.cursor()
    lps = [dict(r) for r in cur.execute("SELECT * FROM legal_persons ORDER BY id").fetchall()]
    targets = {r["legal_person_id"]: dict(r) for r in cur.execute("SELECT * FROM matrix_quota_targets").fetchall()}
    templates = [dict(r) for r in cur.execute("SELECT * FROM tutorial_templates ORDER BY id").fetchall()]

    # 1) 13类业务平台 + 企业支付宝 教程覆盖度缺口矩阵
    published_plats = {t["platform"] for t in templates if t["status"] == "published" and t["platform"]}
    pending_plats = {t["platform"]: t for t in templates if t["status"] in ("pending_boss", "draft") and t["platform"]}

    tutorial_coverage = []
    # 先放企业支付宝核心基座
    ali_tpl = next((t for t in templates if t["target_kind"] == "alipay" and t["status"] == "published"), None)
    ali_step_cnt = cur.execute("SELECT COUNT(*) FROM tutorial_steps WHERE template_id = ?", (ali_tpl["id"],)).fetchone()[0] if ali_tpl else 0
    tutorial_coverage.append({
        "platform": "alipay",
        "label": "企业支付宝(基座轨)",
        "coverage_state": "published" if ali_tpl else "missing",
        "template_id": ali_tpl["id"] if ali_tpl else "",
        "template_title": ali_tpl["title"] if ali_tpl else "缺失",
        "step_count": ali_step_cnt,
        "account_count": cur.execute("SELECT COUNT(*) FROM alipay_accounts").fetchone()[0],
    })
    for p_key, p_lbl in platform_labels.items():
        acc_cnt = cur.execute("SELECT COUNT(*) FROM platform_accounts WHERE platform = ? AND account_status <> 'retired'", (p_key,)).fetchone()[0]
        if p_key in published_plats:
            tp = next(t for t in templates if t["platform"] == p_key and t["status"] == "published")
            sc = cur.execute("SELECT COUNT(*) FROM tutorial_steps WHERE template_id = ?", (tp["id"],)).fetchone()[0]
            tutorial_coverage.append({
                "platform": p_key,
                "label": p_lbl,
                "coverage_state": "published",
                "template_id": tp["id"],
                "template_title": tp["title"],
                "step_count": sc,
                "account_count": acc_cnt,
            })
        elif p_key in pending_plats:
            tp = pending_plats[p_key]
            sc = cur.execute("SELECT COUNT(*) FROM tutorial_steps WHERE template_id = ?", (tp["id"],)).fetchone()[0]
            tutorial_coverage.append({
                "platform": p_key,
                "label": p_lbl,
                "coverage_state": tp["status"],  # pending_boss or draft
                "template_id": tp["id"],
                "template_title": tp["title"],
                "step_count": sc,
                "account_count": acc_cnt,
            })
        else:
            tutorial_coverage.append({
                "platform": p_key,
                "label": p_lbl,
                "coverage_state": "missing",
                "template_id": "",
                "template_title": f"待主管实操录屏编写《{p_lbl}开店/买券SOP》",
                "step_count": 0,
                "account_count": acc_cnt,
            })

    missing_tutorial_count = sum(1 for x in tutorial_coverage if x["coverage_state"] == "missing")
    pending_tutorial_count = sum(1 for x in tutorial_coverage if x["coverage_state"] == "pending_boss")

    # 2) 按法人核算「标准矩阵目标 vs 现状已就绪 vs 建店推进中 vs 净缺口」
    lp_gap_cards = []
    for lp in lps:
        lid = lp["id"]
        t = targets.get(lid)
        if not t:
            continue
        p_targets: dict[str, int] = json.loads(t["platform_targets_json"] or "{}")

        lic_now = cur.execute("SELECT COUNT(*) FROM business_entities WHERE legal_person_id = ? AND license_status = 'active'", (lid,)).fetchone()[0]
        tax_now = cur.execute(
            "SELECT COUNT(*) FROM tax_registrations tr JOIN business_entities be ON be.id = tr.business_entity_id WHERE be.legal_person_id = ?",
            (lid,),
        ).fetchone()[0]
        ar_now = cur.execute(
            "SELECT COUNT(*) FROM annual_reports ar JOIN business_entities be ON be.id = ar.business_entity_id WHERE be.legal_person_id = ?",
            (lid,),
        ).fetchone()[0]
        ali_ready = cur.execute(
            """SELECT COUNT(*) FROM alipay_accounts a
               LEFT JOIN onboarding_cases c ON c.target_kind='alipay' AND c.target_id=a.id
               WHERE a.legal_person_id = ? AND (c.status = 'completed' OR c.id IS NULL)""",
            (lid,),
        ).fetchone()[0]
        ali_building = cur.execute(
            """SELECT COUNT(*) FROM alipay_accounts a
               JOIN onboarding_cases c ON c.target_kind='alipay' AND c.target_id=a.id
               WHERE a.legal_person_id = ? AND c.status <> 'completed'""",
            (lid,),
        ).fetchone()[0]
        sim_now = cur.execute("SELECT COUNT(*) FROM sim_cards WHERE legal_person_id = ? AND sim_status <> 'retired'", (lid,)).fetchone()[0]
        phone_now = cur.execute("SELECT COUNT(*) FROM physical_devices WHERE legal_person_id = ? AND device_kind IN ('work_phone', 'procurement_phone')", (lid,)).fetchone()[0]

        # 计算该委托客户实名可办剩余卡槽 vs 第三方授权卡需求
        quotas = cur.execute("SELECT statutory_limit, existing_personal_cards, carrier, holder_name FROM carrier_quotas WHERE legal_person_id = ?", (lid,)).fetchall()
        company_remaining_openable = 0
        for q in quotas:
            opened_n = cur.execute(
                "SELECT COUNT(*) FROM sim_cards WHERE real_name_holder = ? AND carrier = ? AND card_category IN ('company_master', 'company_sub') AND sim_status <> 'retired'",
                (q[3], q[2]),
            ).fetchone()[0]
            company_remaining_openable += max(0, q[0] - q[1] - opened_n)

        sim_gap = max(0, t["target_sim_slots"] - sim_now)
        external_sim_need = max(0, sim_gap - company_remaining_openable)

        plat_breakdown = []
        total_plat_target = 0
        total_plat_ready = 0
        total_plat_building = 0
        for pk, target_n in p_targets.items():
            total_plat_target += target_n
            ready_n = cur.execute(
                "SELECT COUNT(*) FROM platform_accounts WHERE legal_person_id = ? AND platform = ? AND account_status = 'active'",
                (lid, pk),
            ).fetchone()[0]
            build_n = cur.execute(
                "SELECT COUNT(*) FROM platform_accounts WHERE legal_person_id = ? AND platform = ? AND account_status IN ('warming', 'restricted')",
                (lid, pk),
            ).fetchone()[0]
            total_plat_ready += ready_n
            total_plat_building += build_n
            gap_n = max(0, target_n - ready_n - build_n)
            plat_breakdown.append({
                "platform": pk,
                "label": platform_labels.get(pk, pk),
                "target": target_n,
                "ready": ready_n,
                "building": build_n,
                "gap": gap_n,
                "has_published_tutorial": pk in published_plats,
            })

        lp_gap_cards.append({
            "legal_person_id": lid,
            "legal_person_name": lp["name"],
            "notes": t["notes"],
            "metrics": [
                {"key": "licenses", "label": "营业执照主体", "target": t["target_licenses"], "ready": lic_now, "building": 0, "gap": max(0, t["target_licenses"] - lic_now)},
                {"key": "tax", "label": "电子税务局登记", "target": t["target_tax_regs"], "ready": tax_now, "building": 0, "gap": max(0, t["target_tax_regs"] - tax_now)},
                {"key": "annual", "label": "工商年报建档", "target": t["target_annual_reports"], "ready": ar_now, "building": 0, "gap": max(0, t["target_annual_reports"] - ar_now)},
                {"key": "alipay", "label": "企业支付宝(已通API)", "target": t["target_alipays"], "ready": ali_ready, "building": ali_building, "gap": max(0, t["target_alipays"] - ali_ready - ali_building)},
                {"key": "sims", "label": "实名手机卡槽", "target": t["target_sim_slots"], "ready": sim_now, "building": 0, "gap": sim_gap, "sub_note": f"客户名额余量{company_remaining_openable}张 · 需第三方授权卡{external_sim_need}张" if sim_gap > 0 else "配额充足"},
                {"key": "phones", "label": "ADB指纹专用手机", "target": t["target_work_phones"], "ready": phone_now, "building": 0, "gap": max(0, t["target_work_phones"] - phone_now)},
                {"key": "stores", "label": "全平台账号总槽位", "target": total_plat_target, "ready": total_plat_ready, "building": total_plat_building, "gap": max(0, total_plat_target - total_plat_ready - total_plat_building)},
            ],
            "platform_breakdown": plat_breakdown,
        })

    # 3) 首屏红→黄→绿「问题与缺口行动箱」（严格遵循《服务页UI设计》1.4 节：红=现在要动手，黄=提醒或等别人，绿=正常）
    action_issues: list[dict] = []

    # 红灯 1：被打回的步骤（员工需立即重交）
    for c in cases_summary:
        if c["has_rejected"]:
            action_issues.append({
                "level": "red",
                "category": "开店步骤被打回",
                "legal_person_id": c["legal_person_id"] or "",
                "assigned_staff": c["assigned_staff"],
                "title": f"【材料被打回】{c['case_title']} 卡在 {c['current_step_code']}「{c['current_step_title']}」",
                "detail": f"负责员工：{c['assigned_staff']} · 请按主管驳回意见补齐凭证重新提交",
                "action_type": "open_case",
                "action_target": c["id"],
                "action_label": "去重交材料 ›",
            })

    # 红灯 2：跨轨强关联锁止（闲鱼店被未就绪的支付宝卡住！）
    for c in cases_summary:
        if c["cross_blocked_msg"]:
            action_issues.append({
                "level": "red",
                "category": "支付宝↔闲鱼跨轨锁死",
                "legal_person_id": c["legal_person_id"] or "",
                "assigned_staff": c["assigned_staff"],
                "title": f"【跨轨锁死】{c['case_title']} 停在 {c['current_step_code']}（等待关联支付宝解锁）",
                "detail": c["cross_blocked_msg"],
                "action_type": "open_case",
                "action_target": c["linked_alipay_case_id"] or c["id"],
                "action_label": "去解锁关联支付宝 ›",
            })

    # 红灯 3：家宽代理已过期 & 手机卡低余额
    for px in cur.execute("SELECT id, proxy_code, exit_ip, expires_at FROM proxy_ips").fetchall():
        try:
            d_left = (dt.date.fromisoformat(px[3][:10]) - today).days
        except Exception:
            d_left = 99
        if d_left < 0:
            action_issues.append({
                "level": "red",
                "category": "家宽断网停摆",
                "legal_person_id": "lp-ljg",
                "assigned_staff": "林婷",
                "title": f"【家宽已过期】{px[1]} ({px[2]}) 已过期 {abs(d_left)} 天，关联窗口已锁止防直连！",
                "detail": "严禁删除代理记录，请立即一键续期恢复店铺网络",
                "action_type": "open_proxy",
                "action_target": px[0],
                "action_label": "立即续期 ›",
            })

    # 红灯 4：委托客户受托配额缺口 & 11个平台缺标准教程
    for gc in lp_gap_cards:
        store_gap = next(m["gap"] for m in gc["metrics"] if m["key"] == "stores")
        lic_gap = next(m["gap"] for m in gc["metrics"] if m["key"] == "licenses")
        if store_gap > 0 or lic_gap > 0:
            action_issues.append({
                "level": "red" if lic_gap > 0 else "yellow",
                "category": "受托客户配额缺口",
                "legal_person_id": gc["legal_person_id"],
                "assigned_staff": "周安",
                "title": f"【受托缺口】委托客户「{gc['legal_person_name']}」托管清单尚差 {lic_gap} 本客户执照、{store_gap} 个受托店铺槽位待建",
                "detail": gc["notes"],
                "action_type": "jump_gap",
                "action_target": gc["legal_person_id"],
                "action_label": "查看缺口并派单 ›",
            })

    if missing_tutorial_count > 0:
        action_issues.append({
            "level": "yellow",
            "category": "平台教程缺口",
            "legal_person_id": "",
            "assigned_staff": "周安",
            "title": f"【教程待补齐】闲鱼与企业支付宝(33步)已完备，其余 {missing_tutorial_count} 类平台尚缺标准开店SOP",
            "detail": f"另有 {pending_tutorial_count} 套新编教程（微信小店）已提交待老板终审上线",
            "action_type": "jump_supervisor_studio",
            "action_target": "studio",
            "action_label": "去教程工坊 ›",
        })

    # 黄灯：待主管审核的步骤材料 & 待老板终审的跳步申请
    pending_subs = cur.execute(
        """SELECT s.id, s.case_id, s.step_code, s.submitted_by, s.submitted_at, c.case_title, c.legal_person_id, st.title AS step_title
           FROM onboarding_step_submissions s
           JOIN onboarding_cases c ON c.id = s.case_id
           JOIN tutorial_steps st ON st.id = s.step_id
           WHERE s.status = 'submitted'
           ORDER BY s.submitted_at ASC"""
    ).fetchall()
    for ps in pending_subs:
        action_issues.append({
            "level": "yellow",
            "category": "待主管审核闸口",
            "legal_person_id": ps[6] or "",
            "assigned_staff": "周安",
            "title": f"【待审核】{ps[3]} 已提交「{ps[5]}」节点 {ps[2]}（{ps[7]}）",
            "detail": f"提交时间：{ps[4]} · 审核通过后自动解锁下游及跨轨关联步骤",
            "action_type": "open_case",
            "action_target": ps[1],
            "action_label": "去审核放行 ›",
        })

    pending_skips = [dict(r) for r in cur.execute(
        """SELECT r.*, c.case_title, c.legal_person_id, st.title AS step_title
           FROM onboarding_skip_requests r
           JOIN onboarding_cases c ON c.id = r.case_id
           JOIN tutorial_steps st ON st.id = r.step_id
           WHERE r.status = 'pending'"""
    ).fetchall()]
    for sk in pending_skips:
        action_issues.append({
            "level": "yellow",
            "category": "待老板特批跳步",
            "legal_person_id": sk["legal_person_id"] or "",
            "assigned_staff": "老板",
            "title": f"【跳步申请】{sk['requested_by']} 申请跳过「{sk['case_title']}」步骤 {sk['step_code']}（{sk['step_title']}）",
            "detail": f"理由：{sk['reason']}",
            "action_type": "jump_boss_approvals",
            "action_target": sk["id"],
            "action_label": "老板审批 ›",
        })

    # 按红 -> 黄排序
    action_issues.sort(key=lambda x: 0 if x["level"] == "red" else 1)

    # 4) 员工负载统计（主管派单参考）
    staff_names = ["陈晓雯", "赵宇", "林婷", "李航"]
    staff_workload = []
    for sn in staff_names:
        active_cases = [c for c in cases_summary if c["assigned_staff"] == sn and c["status"] != "completed"]
        done_cases = [c for c in cases_summary if c["assigned_staff"] == sn and c["status"] == "completed"]
        rejected_n = sum(1 for c in active_cases if c["has_rejected"])
        managed_stores = cur.execute("SELECT COUNT(*) FROM platform_accounts WHERE operator_staff = ? AND account_status <> 'retired'", (sn,)).fetchone()[0]
        staff_workload.append({
            "staff_name": sn,
            "active_onboarding_count": len(active_cases),
            "completed_onboarding_count": len(done_cases),
            "rejected_count": rejected_n,
            "managed_accounts_count": managed_stores,
            "load_level": "heavy" if len(active_cases) >= 4 else ("normal" if len(active_cases) >= 1 else "idle"),
        })

    for tc in tutorial_coverage:
        tc["has_published"] = tc["coverage_state"] == "published"
        tc["pending_status"] = "" if tc["coverage_state"] == "published" else (tc["coverage_state"] if tc["coverage_state"] != "missing" else "")
        tp_match = next((t for t in templates if t["id"] == tc["template_id"]), None)
        tc["version"] = tp_match["version"] if tp_match else "v1.0"

    for gc in lp_gap_cards:
        gc["total_gap_count"] = sum(m["gap"] for m in gc["metrics"])
        gc["dimensions"] = {m["key"]: m for m in gc["metrics"]}
        gc["platform_gaps"] = [
            {**pb, "platform_label": pb["label"], "has_tutorial": pb["has_published_tutorial"]}
            for pb in gc["platform_breakdown"]
        ]

    for ai in action_issues:
        ai["case_id"] = ai["action_target"] if ai["action_type"] == "open_case" else ""
        if ai["action_type"] == "open_proxy":
            ai["jump_view"] = "network_ads"
        elif ai["action_type"] == "jump_supervisor_studio":
            ai["jump_view"] = "sup_authoring"
        elif ai["action_type"] == "jump_boss_approvals":
            ai["jump_view"] = "onboarding_hub"
        else:
            ai["jump_view"] = "overview"

    for sw in staff_workload:
        sw["staff"] = sw["staff_name"]
        sw["in_progress"] = sw["active_onboarding_count"]
        sw["completed"] = sw["completed_onboarding_count"]
        sw["rejected"] = sw["rejected_count"]

    for tp in templates:
        tp["stage_count"] = cur.execute("SELECT COUNT(*) FROM tutorial_stages WHERE template_id = ?", (tp["id"],)).fetchone()[0]
        tp["step_count"] = cur.execute("SELECT COUNT(*) FROM tutorial_steps WHERE template_id = ?", (tp["id"],)).fetchone()[0]

    return {
        "lp_gap_cards": lp_gap_cards,
        "lp_gap_rows": lp_gap_cards,
        "tutorial_coverage": tutorial_coverage,
        "missing_tutorial_count": missing_tutorial_count,
        "pending_tutorial_count": pending_tutorial_count,
        "action_issues": action_issues,
        "issues": action_issues,
        "red_count": sum(1 for x in action_issues if x["level"] == "red"),
        "yellow_count": sum(1 for x in action_issues if x["level"] == "yellow"),
        "pending_submissions": [dict(r) for r in pending_subs],
        "pending_skips": pending_skips,
        "staff_workload": staff_workload,
        "templates": templates,
    }
