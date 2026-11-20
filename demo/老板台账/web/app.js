/* 锚点中控 · 老板全量台账（桌面版 v2：思维导图目录 + ?气泡解释系统 + 全局折叠降噪） */
(function () {
  "use strict";

  // ==================== 1. 全站名词解释 & 衍生业务逻辑词典 ====================
  const TIP_DICT = {
    mindmap_arch: {
      cat: "全局拓扑逻辑",
      title: "全景思维导图（目录式层层穿透）",
      def: "将「签约委托客户 → 受托营业执照主体 → 税局/年报/企业支付宝/各托管账号」及底层「家宽IP/手机卡/托管设备集群」按树状分支组织，默认折叠非紧急分支。",
      logic: [
        "顶层按【签约委托客户】隔离建档（管理运营公司代管运维，客户独立主体独立核算），每本【营业执照主体】承载约 3~4 家受托店铺；",
        "每个营业执照衍生出独立的税务局登记、工商年报，以及严禁跨执照混用的企业支付宝闭环；",
        "点击任意节点的「+数字」即可逐层展开子目录，点击节点名称直接呼出右侧详情抽屉。"
      ],
      guard: "全局搜索框输入关键词时，所有匹配的折叠分支将自动展开。"
    },
    entity_4shop: {
      cat: "受托主体隔离逻辑",
      title: "受托主体与店铺独立隔离（每 3~4 店 1 执照）",
      def: "每位签约委托客户名下的营业执照均由客户依法设立，委托泛亚托管运营；单本执照承载约 3~4 家受托网店，严禁跨客户/跨主体资金与账务混同。",
      logic: [
        "平台风控物理隔离：单一委托主体受限不影响其余受托客户的店铺运营；",
        "财税独立核算：每本受托执照单独建档电子税务局与增值税申报水位，严禁任何跨主体开票或拆单行为；",
        "衍生运维义务：本运营公司须同步跟踪受托主体的电子税局申报与工商年报提醒，防止遗漏导致客户账户受限。"
      ],
      guard: "系统强制将营业执照与税务登记、工商年报 1:1 独立建档。"
    },
    tax_30w: {
      cat: "财税衍生逻辑",
      title: "受托主体季度 30 万法定申报阈值预警",
      def: "小规模纳税人按季 30 万元销售额为现行增值税关键法定申报节点，超线须按规定计税或评估转登记。",
      logic: [
        "本管理运营公司仅提供受托财税水位监测预警，不做任何跨主体拆单开票或避税操作；",
        "当台账监测到某委托主体季度销售额达法定阈值的 80%（24万元）时自动亮黄灯，提前提醒该委托客户及其代账会计做好纳税申报、税金预留或一般纳税人评估。"
      ],
      guard: "办税手机号同步纳入号码关联索引，换卡前强制预警防收不到税局验证码。"
    },
    annual_report: {
      cat: "工商合规逻辑",
      title: "市场监管局年度报告公示",
      def: "每年 1 月 1 日至 6 月 30 日，每本营业执照均须在国家企业信用信息公示系统完成上一年度年报。",
      logic: [
        "衍生连锁风险：只要有 1 本执照逾期未年报被列入「经营异常名录」，企业支付宝与闲鱼/抖店/微信小店后台会自动巡检冻结收款与提现功能。"
      ],
      guard: "台账独立追踪 4 本执照各自的联络员备案手机与公示回执。"
    },
    master_3in1: {
      cat: "资金池核心规则",
      title: "主体资金账号「3 选 1」设主资金号",
      def: "在每个营业执照主体的 3 个核心企业支付宝资金号中，唯一选定 1 个作为该主体的「主资金蓄水池」。",
      logic: [
        "资金集中管理：无需给每个采购买券子号分散充值留存大量余额；",
        "同主体下的采购支付宝子号余额可保持 0 元，付款时通过「因公支付」实时扣减本主体主资金号。"
      ],
      guard: "数据库唯一部分索引锁死：每个营业执照最多只能勾选 1 个主资金账号。"
    },
    corporate_pay: {
      cat: "税法红线逻辑",
      title: "企业支付宝「因公支付」与严禁跨主体串户",
      def: "采购子账号在外部平台买卡券付款时，由同营业执照下的「主资金账号」实时全额代扣出资。",
      logic: [
        "为什么严禁跨营业执照扣款：若用 A 营业执照的主资金号去给 B 营业执照的采购号代扣付款，会导致两本执照的银行/支付宝资金流与进销业务主体严重错位（公私/跨主体混同），直接违反税法与发票管理办法！"
      ],
      guard: "后端 API + 触发器双重硬阻断：采购子号与被扣款主号必须属于同一张营业执照！"
    },
    buy_sell_split: {
      cat: "风控与账务隔离",
      title: "采购号 vs 销售号严格互斥（严禁既买又卖）",
      def: "所有企业支付宝与 13 类平台账号均强制打标「仅销售」「仅采购」「主资金池」或「社媒引流」，绝不允许同一账号既买货又卖货。",
      logic: [
        "账务清晰：进项采购支出与销项卖货回款分户核算，月底对账一目了然；",
        "防平台风控：同一支付宝或淘宝/闲鱼号若高频大额买券又同时开店收款，极易触发电商平台异常交易或套现风控模型。"
      ],
      guard: "销售店铺绑定采购支付宝、或买券号绑定销售支付宝均会被系统当场拦截。"
    },
    alipay_bill_ledger: {
      cat: "对账衍生逻辑",
      title: "多账户支付宝账单与因公代扣流水",
      def: "统一归集 14+ 个企业支付宝的销售结算入账与因公支付代扣支出明细。",
      logic: [
        "因公支付会产生两条关联视角：采购子号的「交易订单记录」与主资金号的「因公代扣资金流水」，台账将其合并穿透，避免重复记支出。"
      ],
      guard: "支持同一天导入/登记任意多个支付宝账户流水，无单文件覆盖冲突。"
    },
    virtual_matrix: {
      cat: "全平台业务架构",
      title: "13 类虚拟产品账号与小店分工",
      def: "围绕虚拟卡券/权益产品构建「采购端 + 社媒引流端 + 多平台小店销售端」完整闭环。",
      logic: [
        "采购端（买卡券囤券）：大众点评、抖音、抖省省、闲鱼采购号、淘宝采购号、京东采购号；",
        "销售端（开店变现）：闲鱼(14店)、淘宝网店、京东网店、微信小店、小红书小店、抖店；",
        "社媒引流端：小红书营销号、微信个人/企微号（种草并导流至对应小店成交）。"
      ],
      guard: "每个业务账号均强制关联到具体手机号、家宽代理 IP 与收付链路。"
    },
    social_lead: {
      cat: "社媒导流逻辑",
      title: "社媒营销号 → 私域/小店导流闭环",
      def: "小红书种草号与微信号本身不直接挂收款支付宝卖货，而是将公域流量导入关联的小红书小店或微信小店。",
      logic: [
        "实现「内容种草号」与「交易履约小店」解耦：即使前端种草笔记限流，也不会影响后端持牌小店的商品与资金安全。"
      ],
      guard: "台账专门记录社媒号的导流目标小店，断链一目了然。"
    },
    proxy_reuse: {
      cat: "网络防关联核心",
      title: "¥10/月家宽代理「同平台独占 · 不同平台可复用」",
      def: "全面停用昂贵实体宽带，统一采用 ¥10/月静态住宅家宽代理 IP（SOCKS5），按平台维度控制独占与复用。",
      logic: [
        "同平台必须独占：2 家闲鱼店绝不能共用同 1 条家宽 IP，否则闲鱼后台立即判定同 IP 店群关联；",
        "不同平台可以复用：闲鱼、小红书、大众点评、微信属于不同公司的风控体系，互不共享登录 IP 库，因此 1 条 ¥10 家宽可同时给「1家闲鱼 + 1个小红书 + 1个点评买券号」复用，月成本降低 70% 以上；",
        "必须严管到期时间：代理一旦过期断网，运营人员切忌裸连登录。"
      ],
      guard: "数据库唯一索引 UNIQUE(proxy_ip_id, platform) 自动放行跨平台复用、硬阻断同平台撞 IP。"
    },
    proxy_anti_direct: {
      cat: "高危防团灭保护",
      title: "在用家宽代理防误删 / 防直连保护",
      def: "当某条家宽代理仍绑定任意 AdsPower 浏览器窗口或在用平台账号时，禁止直接删除。",
      logic: [
        "衍生灾难场景：若误删代理配置导致指纹浏览器回退使用办公室本机真实公网 IP，同一台电脑上的十几个店铺会瞬间暴露在同一 IP 下引发批量封店。"
      ],
      guard: "必须先将关联窗口换绑至新家宽 IP 后，旧代理才允许退役删除。"
    },
    adspower_bind: {
      cat: "浏览器环境隔离",
      title: "AdsPower 指纹窗口 ↔ 宿主机 ↔ 家宽代理",
      def: "每个桌面端网页店铺/后台固定运行在独立的 AdsPower 浏览器环境窗口中，锁定专属硬件指纹与家宽代理。",
      logic: [
        "电脑宿主机集中承载多个隔离窗口，每个窗口按「销售窗 / 采购窗 / 社媒窗」严格隔离 Cookie 与缓存，杜绝网页端串号。"
      ],
      guard: "平台账号绑定 AdsPower 窗口时，自动校验并同步继承该窗口的家宽代理 IP。"
    },
    sim_1m4s: {
      cat: "号卡配额衍生逻辑",
      title: "运营商「一主 4 副」扣除个人存量卡限制",
      def: "工信部与三大运营商规定：同一身份证在单一运营商名下最多实名 5 张卡（通常为 1 张主卡 + 4 张副卡）。",
      logic: [
        "为什么实际办不出 5 张：委托客户法人名下平时自己已在用 1~2 张个人移动/联通卡（存量占坑）；",
        "例如客户演示客户甲原有 1 张移动卡，则其名下配合受托店铺运营最多可新办 4 张移动卡（1主3副）；超出配额需签妥第三方通信授权合约卡。"
      ],
      guard: "系统按 (客户实名人, 运营商) 自动计算「5 - 客户原自用卡 = 受托可办上限」，超额录入直接拦截。"
    },
    external_sim: {
      cat: "换绑防失联逻辑",
      title: "第三方授权合约卡 & 到期一键批量换绑",
      def: "委托客户实名卡槽满额后，通过正规通信授权协议接入的第三方合约卡，通常带有 6~12 个月合约期，到期需配合客户退卡或换绑。",
      logic: [
        "衍生高危痛点：1 张手机号往往同时绑着税务局、企业支付宝、微信、小红书、闲鱼等五六个核心账号；",
        "若合约到期直接停机弃卡而漏改某几个平台的绑定手机，后续触发二次短信验证时账号将彻底死锁无法找回！"
      ],
      guard: "提前 30 天亮橙色倒计时预警，并在号码详情抽屉提供 N:N 全量关联清单与「一键换绑迁移」。"
    },
    sim_fee_oa: {
      cat: "话费与OA预留",
      title: "话费余额台账（主副共享池 vs 独立计费）与 OA 预留",
      def: "全量纳管每张手机卡的月租、出账日、计费模式及实时话费余额，防止欠费停机收不到验证码。",
      logic: [
        "客户实名「一主4副」中，副卡不设独立余额，共享扣减主卡话费池；第三方授权合约卡与主卡则独立核算余额；",
        "当有效余额低于「1.2 倍月租」或低于 ¥25 时自动飘红预警；目前已预留审批单号字段，后续无缝直连钉钉/OA自动充值流程。"
      ],
      guard: "支持在手机卡抽屉内随时登记充值与月租核减流水。"
    },
    device_isolation: {
      cat: "真机硬件隔离",
      title: "实体设备物理隔离（销售机 vs 采购专机）",
      def: "App 端强风控平台（闲鱼、大众点评、抖音、微信、小红书）运行在独立实体手机上，严格区分销售工作机与采购买券专机。",
      logic: [
        "App 会读取手机底层 IMEI、OAID、蓝牙/Wi-Fi 列表及插卡信息；",
        "将 12 台销售手机与 2 台采购手机物理分开，可彻底避免「买低价卡券号」与「高客单卖货店」在同一部手机上产生硬件级关联。"
      ],
      guard: "台账精确到每部手机的双卡槽（卡槽1/卡槽2）实插号码与保管工位。"
    },
    vault_2fa: {
      cat: "零信任密码安全",
      title: "iPhone 扫码 (Passkey) & Authenticator 动态口令解锁",
      def: "全量密码保险箱采用银行级二次验证（Step-Up 2FA）：进入台账默认上锁，仅当老板本人用 iPhone 扫码刷 Face ID 或输入 6 位 30 秒动态码后，才在服务端内存签发 15 分钟短期解锁令牌。",
      logic: [
        "方式一（Authenticator / iPhone自带密码App）：基于 RFC 6238 标准 otpauth 二维码，支持用 iPhone 原生相机扫码存入系统「密码」App 或 Google / Microsoft Authenticator，离线每 30 秒生成 6 位动态验证码；",
        "方式二（iPhone 扫码刷 Face ID / Mac 指纹 Passkey）：基于 W3C WebAuthn 通行密钥标准，点击后唤起苹果官方跨设备验证二维码，iPhone 相机扫码并刷脸确认即可解锁（Mac 本机亦可直接按 Touch ID 秒开）；",
        "满 15 分钟自动过期或点击顶栏「立即上锁」后，内存令牌与页面已解密缓存瞬间清零。"
      ],
      guard: "连续输错 8 次触发 5 分钟防暴力破解锁定；每次解锁、显密与复制均实时写入不可篡改审计日志。"
    },
    vault_envelope: {
      cat: "静态落盘加密",
      title: "认证加密落库（ENCv1）与单条按需解密",
      def: "所有电子税务局、工商年报、企业支付宝、13类平台店铺、AdsPower主控、家宽代理节点、真机锁屏与SIM服务密码均以独立随机盐认证加密密文存储，绝不明文落盘。",
      logic: [
        "防拖库与防抓包：即使数据库文件被拷贝，缺少独立主密钥（KEK）也无法还原任何密码；首屏 /api/bootstrap 永远只下发脱敏元数据，绝不批量返回明文；",
        "单条按需解密：仅在解锁期内点击某一条目的「显密」或「复制」时，才携带令牌请求 /api/vault/reveal 单条解密；",
        "内置子号 2FA 托管：针对抖店、微信小店、小红书小店及 AdsPower 总控号自带的 TOTP 种子，解锁后可直接在台账内代算当前 6 位验证码。"
      ],
      guard: "生产环境升级至 PostgreSQL 时直接平滑对接 AES-256-GCM 信封加密与 KMS 主密钥托管（详见交接规范文档）。"
    },
    account_finance_slot: {
      cat: "单账号财务预留逻辑",
      title: "每个账号独立财务结算、佣金与损益预留槽",
      def: "全量 33+ 个商业账号并非全部直连企业支付宝，系统为每一个账号独立预留了多通道清算路由、商户号、银行卡、费率、保证金原路退回与月度净毛利核算槽位。",
      logic: [
        "多清算通道路由：闲鱼/淘宝店走【企业支付宝直连(普通0.6%/鱼小铺1.6%)】；微信小店走【财付通商户号 mch_id → T+1银行卡】；抖店走【抖音/合众商户号】；小红书小店走【千帆钱包】；京东POP走【京东企业钱包】；采购专号走【因公支付直扣同主体主户】；海外采购预留【外币卡结算槽】；",
        "单店净毛利与提成基数：自动按「月销GMV - 售后退款 - 采购成本 - 平台佣金(bps)」预留净毛利计算口径，无缝衔接我方托管运营净毛利服务费/提成核算与受托主体按季 30 万申报水位监测；",
        "保证金防丢锚点：单独记录每家小店的保证金金额、原出资账户与账期冻结款，关店退保时严防退错卡或遗漏。"
      ],
      guard: "纯社媒引流号强制锁定为「纯引流零收付 (no_settlement)」，严禁配置收付款通道；所有账号均预留金蝶/ERP/钉钉OA科目映射码。"
    },
    refund_deposit_flow: {
      cat: "全周期对账预留",
      title: "因公退券原路冲回 & 店铺保证金进出流水",
      def: "资金账单流水除常规「销售入账」与「因公代扣」外，完整预留了采购退券冲回、销售售后退款、保证金缴纳与退保回款等 8 类资金流向。",
      logic: [
        "采购退券原路冲回（inflow_purchase_refund）：大众点评/抖音团购券若超时未核销自动退款，资金会穿透采购子号原路回充至同主体主资金号，必须冲减当月采购成本而非误计为销售收入；",
        "保证金往来隔离（outflow_deposit / inflow_deposit_return）：开店缴保与关店退保计入其他应收款，不混入经营损益，并支持直接挂载关联平台账号与 OA/ERP 凭证号。"
      ],
      guard: "底层 SQLite 与线上 PostgreSQL 迁移脚本均已同步预留全部 8 类流向枚举与单店关联外键。"
    },
    gap_radar: {
      cat: "统筹看缺口引擎",
      title: "签约委托客户托管目标 vs 实时建店缺口倒推",
      def: "告别静态备忘录：按每位签约委托客户合同约定的托管目标（客户执照/税/年报/企支/¥10家宽/终端/号卡 + 13平台受托目标店数）实时扣减已就绪与在建数量，自动算出净缺口。",
      logic: [
        "首屏红→黄→绿问题箱按紧急度排序：红=现在要动手（过期家宽、被打回开店步骤、跨轨锁死店铺、硬缺口）；黄=待审或临期；绿=正常闭环；",
        "支持直接从缺口项一键派发标准开店任务单给对应员工；若某平台尚无已发布教程，系统自动启动 Lock 防呆拦截并引导主管先做教程。"
      ],
      guard: "无标准教程不派单、有跨轨风险不放行，彻底消除漏办与口头派活混乱。"
    },
    dual_track_gate: {
      cat: "企支↔闲鱼强关联",
      title: "企业支付宝(15步) ↔ 闲鱼开店(18步) 分段双轨硬锁死",
      def: "企业支付宝与闲鱼店并非孤立流程，系统拆分为 15 步企支轨与 18 步闲鱼轨并通过两道跨轨门禁（Gate-1 / Gate-2）实时互锁。",
      logic: [
        "Gate-1（锁死 S09 企业店认证）：关联企业支付宝未完成第10步 C10（第1天趁委托客户法人在场搜『企业管家』一键授权管理员）前，硬锁死闲鱼店 S09 营业执照认证；",
        "Gate-2（锁死 S18 正式上架开售）：关联企业支付宝未完成第15步 D15（打印公司名A4纸开支付产品 + 互不相同0.xx元测试 + 次日T+1与程序员核实账单API映射）前，硬锁死闲鱼店 S18 开售，严防卖货后财务对不上账！",
        "个人号与企业号反向红线：个人淘宝/闲鱼号严禁主动绑支付宝（必发五位数静物顺系统弹窗绑）；企业支付宝必须用个人支付宝扫码创单。"
      ],
      guard: "前后端双重状态机硬拦截；未解锁后续步骤支持点击只读预览提前备料。"
    },
    adspower_blind_custody: {
      cat: "免明文密码联动",
      title: "密码库 ↔ AdsPower Authenticator 桥接 & 员工免明文托管",
      def: "全量密码与 RFC 6238 二次验证种子（fakey）由老板密码总库一键同步注入 AdsPower 指纹浏览器自动填充与内置 Authenticator，员工端全程零明文接触。",
      logic: [
        "服务端硬权限隔离：非老板角色调用 /api/vault/reveal 明文解密接口一律硬返回 HTTP 403 并记录越权审计；",
        "员工受限能力边界：员工仅能①一键拉起本人名下授权的 AdsPower 隔离专窗、②实时获取并复制 6 位 30 秒 Authenticator 动态码、③在开店新设密码时单向加密锁入总库（录入后员工自己也无法反查明文）。"
      ],
      guard: "员工离职或调岗只需在台账收回窗口/账号归属，无需全盘改密即可瞬间切断访问权。"
    },
    role_3portals: {
      cat: "三端业务流切分",
      title: "老板端 · 主管端 · 员工端 差异化职责协同",
      def: "同一套底层数据库按角色切分为三套完全不同的工作台界面与权限视图。",
      logic: [
        "👑 老板端：看全盘缺口统筹雷达、全量台账与单账号财务损益预留、iPhone扫码解锁最高密码库、审批主管新教程上线与员工例外跳步申请；",
        "🧭 主管端（演示开店主管）：实操跑通样板店并编写/维护各平台开店教程（消除空白平台教程缺口）、按缺口给员工派单、日常审核员工提交的关键步骤材料；",
        "🛠 员工端（演示员工甲/演示员工乙/演示员工丙/演示员工丁）：只看分配给自己的手把手一步一屏开店任务卡，以及本人名下受限 AdsPower 专窗与 6 位动态码领用台。"
      ],
      guard: "顶栏支持一键切换四端视角现场核验权限边界与协同流转。"
    },
    gov_isolation: {
      cat: "同库分专区架构",
      title: "为什么把各工作台 Wiki / 培训视频 / KPI·OKR 放同一系统但做 UI 分区隔离？",
      def: "全公司共用一个底层数据库（无需多维护第二套工作台），但在界面上将「委托客户/执照/支付宝/号卡受托资产线」与「六大工作台组织制度基建线」严格物理分栏隔离。",
      logic: [
        "零界面混同：受托资产线按『委托客户→执照→企支→店铺』组织，制度线按『销售/客服/采购/仓管/开店/总经办』组织，分处左侧独立专区，绝不揉进同一张表；",
        "轻索引不造轮子：长篇正文仍在钉钉/飞书 Wiki 编写，视频大文件存钉钉盘/OSS，台账只管『缺口清单、结构化KPI公式、回填链接与版本审批』；",
        "一处终审全司点亮：总经办初审、老板拍板终审通过后，对应子工作台页面右上角 ? 里的『待录视频/待补Wiki/KPI口径』自动实时点亮！"
      ],
      guard: "总经办与非开店业务主管在后端硬性屏蔽企业支付宝余额、税表、家宽代理、号卡与密码库数据。"
    },
    macpro_50_health: {
      cat: "算力与槽位防关联逻辑",
      title: "10 台 64GB Mac Pro · 单机硬限 50 账号（总容量 500 槽位）与健康巡检",
      def: "公司部署 10 台 Apple Mac Pro（M2 Ultra · 64GB 统一内存），按『1 台 Mac Pro 放 50 个账号』的标准建立 500 账号总容量池，并实时监控单机内存、Swap、Local API 与真机电池/ADB指纹健康度。",
      logic: [
        "静态挂载硬红线（50 账号/台）：单台 Mac Pro 硬限挂载 ≤ 50 个业务账号（或指纹窗口槽位），一方面将单机 SSD 故障/IP 污染的爆炸半径控制在 10% 以内，另一方面防止 Chromium Profile 缓存把 1TB SSD 撑爆；",
        "动态并发红线（64GB 内存防 Swap 抖动）：64GB 内存下每个打开的 Chromium 窗口约占 1.3~1.8GB，同时打开 ≤ 32 窗为安全区；若僵尸窗口不关导致内存冲破 85% 并触发 macOS Swap 交换内存，会导致 SOCKS5 家宽隧道超时断连甚至页面崩溃；",
        "一键无损降载与真机双巡检：支持一键清理 Chromium 冗余图片/视频缓存并回收闲置窗口内存（100% 保留登录态 Cookie 与环境指纹），同时纳管 15 部实体手机的 7×24h 插电防鼓包告警与程序员 ADB 指纹锁死状态。"
      ],
      guard: "后端在新增 AdsPower 窗口或挂载新平台账号时自动核算目标 Mac Pro 已占槽位数，满 50 个槽位当场硬拦截并引导迁入空闲托管预备机柜！"
    },
    loc_corp_net_policy: {
      cat: "受控设备在岗与网络红线",
      title: "「物理定位 × 公司受控网 × 坐班/居家」实时交叉合规判定",
      def: "全员已签署《公司设备使用协议》，知情所有业务电脑与业务手机受公司统一 MDM/守护端管控：上班时间必须使用公司受控设备，且通过『实时定位 + 当前连接网络』交叉校验在司办公与居家办公合规性。",
      logic: [
        "🟢 在司办公必连公司网：若设备定位在公司围栏内（演示办公区），则必须连接公司千兆有线内网或公司业务受控 Wi-Fi（Demo-Office-WiFi / Demo-Procure-VLAN，底层由软路由自动路由至对应独享静态家宽 IP）；若人在公司却切回个人 4G/5G 流量或连外部野生热点，系统当场亮红灯告警！",
        "🔵 居家办公必持审批 + 连公司 VPN：定位离开公司围栏时，系统自动核对当日是否有 OA 居家办公审批单；已批居家且拨通公司加密 VPN 隧道判为蓝色合规，否则直接判定为『🚨 未报备私带业务设备离司 / 假坐班真居家』最高级红灯！",
        "⚡ 管控处置闭环：发现违规可一键下发『强制切回公司受控 Wi-Fi』『补录居家审批并连 VPN』『登记召回在司』或『远程锁屏停派业务任务』。"
      ],
      guard: "定位围栏与网络连接状态在首屏行动箱、07健康专页、08固定资产表与01全景思维导图四处实时同步亮灯。"
    },
    asset_retire_guard: {
      cat: "固定资产全生命周期红线",
      title: "固定资产三账合一 & 带卡/带号严禁报废或转二手变卖",
      def: "将行政固定资产表（资产编号 AST-*、采购原值、盘点记录、核减审批）与业务防关联表（插卡、店铺、窗口、锁屏/云ID密码）及实时体征（负载、温度、定位）三账合一。",
      logic: [
        "算清硬件家底：10 台 64GB Mac Pro 与 15 部业务手机统一建档资产码、采购单号、原值残值与《受控设备协议》签署人，支持一键扫码盘点确认；",
        "防带号带卡外流事故：淘汰手机或电脑若申请报废核减或转入二手商品库变卖（asset_intake），只要卡槽仍插着公司 SIM 卡、或仍绑着在用店铺/AdsPower 窗口，系统当场硬拦截！"
      ],
      guard: "后端 /api/assets/retire-request 硬校验 0 插卡 + 0 窗口 + 0 在用账号后才允许核减退役。"
    }
  };

  // ==================== 2. 全局状态（默认精简折叠态 + 四端视角状态） ====================
  const state = {
    boot: null,
    viewerRole: "boss",    // "boss" | "gm_office" | "supervisor" | "employee"
    viewerStaff: "老板",
    supStaffChoice: "演示开店主管",
    empStaffChoice: "演示员工乙",

    view: "overview",
    lpFilter: "lp-demo-a",
    search: "",
    masked: false,

    // 开店教程向导弹窗与员工动态码缓存
    activeWizardCaseId: null,
    activeWizardDetail: null,
    activeWizardStepCode: null,
    empTotpCache: {},
    authorDraft: null,

    // 密码保险箱内存态（刷新或上锁即清空，绝不存 localStorage）
    vaultToken: null,
    vaultTimerSec: 0,
    vaultAuthMethod: "",
    vaultAuthTab: "totp", // "totp" | "passkey"
    revealedSecrets: {},  // { [credId]: decryptedSecretObj }

    // 主页思维导图状态
    homeMode: "mindmap", // "mindmap" | "outline"
    mmExpanded: new Set(["root", "ent:ent-demo-a-01"]), // 默认仅展开第一个营业执照到二级目录，极度清爽！

    // 各分页折叠面板开启集合（默认仅展开核心首项或紧急告警项）
    openFolds: new Set([
      "boss:gap_matrix",
      "ent:licenses",
      "ali_ent:ent-demo-a-01",
      "fin_ent:ent-demo-a-01",
      "plat_grp:xianyu",
      "px:alerts",
      "ads_host:dev-pc-01",
      "dev:hosts",
      "dev:buy_phones",
      "health:mobile_devices",
      "sim:alerts",
      "vault:platform",
      "sup:tpl_list",
      "gov_wb:sales",
      "gov_wb:cs",
      "gov_wb:account_ops"
    ]),

    alipaySubTab: "accounts",
    alipayRole: "ALL",
    platGroupBy: "category", // "category" | "entity"
    platRole: "ALL",
    netSubTab: "proxies",
    drillLogs: [],
  };

  const BOSS_NAV_ITEMS = [
    { key: "overview", title: "01 统筹缺口与导图" },
    { key: "onboarding_hub", title: "02 开店流程·终审" },
    { key: "entities", title: "03 委托客户·执照·税·年报" },
    { key: "alipay", title: "04 企支·财务槽·流水" },
    { key: "platforms", title: "05 全平台账号矩阵" },
    { key: "network_ads", title: "06 家宽·Ads联动" },
    { key: "ads_device_health", title: "07 Ads·健康·定位网" },
    { key: "devices", title: "08 固定资产·设备·卡" },
    { key: "sims", title: "09 手机卡·配额·话费" },
    { key: "guardrails", title: "10 税法风控实测台" },
    { key: "vault", title: "11 密码总库 & Ads" },
    { key: "gov_hub", title: "12 工作台基建·终审", sectionHeader: "二、全工作台制度与视频缺口" },
  ];

  const GM_NAV_ITEMS = [
    { key: "gov_hub", title: "01 全司缺口总览·初审" },
    { key: "gov_kpi_okr", title: "02 各台KPI与OKR口径" },
    { key: "gov_wiki_video", title: "03 Wiki与培训视频槽" },
  ];

  const SUP_NAV_ITEMS = [
    { key: "sup_reviews", title: "01 步骤材料审核台" },
    { key: "sup_authoring", title: "02 教程编排工坊" },
    { key: "sup_dispatch", title: "03 缺口统筹与派单" },
    { key: "platforms", title: "04 平台店铺进度表" },
    { key: "alipay", title: "05 企业支付宝进度" },
    { key: "ads_device_health", title: "06 Ads·设备健康度" },
    { key: "gov_sup_my", title: "07 本台Wiki·视频·KPI", sectionHeader: "二、本台制度与视频补缺" },
  ];

  const OTHER_SUP_NAV_ITEMS = [
    { key: "gov_sup_my", title: "01 本台待补缺口提报" },
    { key: "gov_sup_published", title: "02 本台已生效标准库" },
  ];

  const EMP_NAV_ITEMS = [
    { key: "emp_tasks", title: "01 今日手把手开店" },
    { key: "emp_adspower", title: "02 专窗与动态码领用" },
  ];

  // ==================== 3. 基础工具函数 ====================
  function esc(v) {
    if (v === null || v === undefined) return "";
    return String(v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function qTip(key) {
    if (!key || !TIP_DICT[key]) return "";
    return `<button type="button" class="q-tip" data-tip="${esc(key)}" title="查看名词解释与衍生逻辑">?</button>`;
  }

  function fenToYuan(fen) {
    const n = Number(fen || 0) / 100;
    return "¥" + n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fenToShortYuan(fen) {
    const n = Number(fen || 0) / 100;
    if (Math.abs(n) >= 10000) return "¥" + (n / 10000).toFixed(2) + "万";
    return "¥" + n.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  function maskStr(s, kind) {
    if (!s) return "-";
    const v = String(s);
    if (!state.masked) return esc(v);
    if (kind === "phone" && v.length >= 7) return esc(v.slice(0, 3) + "****" + v.slice(-4));
    if (kind === "idcard" && v.length >= 10) return esc(v.slice(0, 6) + "********" + v.slice(-4));
    if (kind === "bank" && v.length >= 8) return esc("**** " + v.slice(-4));
    if (kind === "secret") return "••••••";
    return esc(v);
  }

  function matchLP(itemLpId, extraLpIds) {
    if (state.lpFilter === "ALL") return true;
    if (itemLpId && itemLpId === state.lpFilter) return true;
    if (Array.isArray(extraLpIds) && extraLpIds.includes(state.lpFilter)) return true;
    return false;
  }

  function matchSearch(obj) {
    const q = state.search.trim().toLowerCase();
    if (!q) return true;
    return JSON.stringify(obj).toLowerCase().includes(q);
  }

  function isFoldOpen(foldId) {
    if (state.search.trim() !== "") return true; // 搜索时自动展开所有匹配分组
    return state.openFolds.has(foldId);
  }

  function renderFoldCard({ id, title, tipKey = "", pillsHtml = "", variant = "", actionHtml = "", bodyHtml = "", padded = false }) {
    const open = isFoldOpen(id);
    const vCls = variant === "danger" ? "fold-danger" : variant === "warn" ? "fold-warn" : "";
    return `
      <section class="fold-card ${vCls} ${open ? "open" : ""}" data-fold-section="${esc(id)}">
        <div class="fold-head" data-fold-toggle="${esc(id)}">
          <div class="fold-head-left">
            <span class="fold-arrow">▸</span>
            <span class="fold-title">${esc(title)} ${tipKey ? qTip(tipKey) : ""}</span>
            ${pillsHtml ? `<div class="fold-summary-pills">${pillsHtml}</div>` : ""}
          </div>
          <div class="fold-head-right">
            ${actionHtml}
            <span class="fold-state-hint">${open ? "点击收起" : "点击展开"}</span>
          </div>
        </div>
        ${open ? `<div class="fold-body ${padded ? "padded" : ""}">${bodyHtml}</div>` : ""}
      </section>
    `;
  }

  function toast(msg, type = "info") {
    const wrap = document.getElementById("toast-container");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), type === "error" ? 6000 : 3200);
  }

  async function apiCall(url, method = "GET", body = null) {
    const opts = {
      method,
      headers: {
        "X-Ledger-Role": state.viewerRole || "boss",
        "X-Ledger-Staff": encodeURIComponent(state.viewerStaff || "老板"),
      },
    };
    if (state.vaultToken) {
      opts.headers["X-Vault-Token"] = state.vaultToken;
    }
    if (body !== null) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const resp = await fetch(url, opts);
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      if (data.vault_locked) {
        state.vaultToken = null;
        state.vaultTimerSec = 0;
        state.revealedSecrets = {};
        renderVaultTopbarBtn();
      }
      const err = new Error(data.error || `请求失败 (${resp.status})`);
      err.ruleBlocked = Boolean(data.rule_blocked);
      err.vaultLocked = Boolean(data.vault_locked);
      throw err;
    }
    return data;
  }

  function formatMMSS(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  function isVaultUnlocked() {
    return Boolean(state.vaultToken && state.vaultTimerSec > 0);
  }

  function renderVaultTopbarBtn() {
    const btn = document.getElementById("btn-vault-status");
    if (!btn) return;
    const total = state.boot && state.boot.vault ? state.boot.vault.total_count : 0;
    if (isVaultUnlocked()) {
      btn.className = "btn btn-vault-unlocked";
      btn.textContent = `🔓 已解锁 ${formatMMSS(state.vaultTimerSec)} · 点此上锁`;
      btn.title = "当前可按需解密查看密码，点击立即销毁内存令牌并重新上锁";
    } else {
      btn.className = "btn btn-vault-locked";
      btn.textContent = total ? `🔒 密码库已锁 (${total})` : `🔒 密码库已锁`;
      btn.title = "点击通过 iPhone 扫码或 Authenticator 6位动态码解锁密码库";
    }
  }

  function syncVaultStateFromBoot() {
    const v = state.boot && state.boot.vault;
    if (!v) return;
    if (v.unlocked && state.vaultToken) {
      state.vaultTimerSec = v.remaining_seconds || 0;
      state.vaultAuthMethod = v.auth_method || "";
    } else {
      state.vaultToken = null;
      state.vaultTimerSec = 0;
      state.vaultAuthMethod = "";
      state.revealedSecrets = {};
    }
    renderVaultTopbarBtn();
  }

  async function copyTextSafe(txt, label = "内容") {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(txt);
      } else {
        const ta = document.createElement("textarea");
        ta.value = txt;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      toast(`已复制${label}到剪贴板`, "success");
    } catch (e) {
      toast(`复制失败: ${e.message}`, "error");
    }
  }

  async function reloadData() {
    try {
      const res = await apiCall("/api/bootstrap");
      state.boot = res.data;
      syncVaultStateFromBoot();
      renderLpSelector();
      renderSidebar();
      renderCurrentView();
    } catch (e) {
      toast("加载台账失败: " + e.message, "error");
    }
  }

  // 精简纯净版徽章（不再塞冗长括号说明，逻辑归入 ? 气泡）
  function roleBadge(role) {
    if (role === "master_fund") return `<span class="badge badge-purple">🟣 主资金池</span>`;
    if (role === "purchase_only") return `<span class="badge badge-amber">🟠 采购专用</span>`;
    if (role === "sales_only") return `<span class="badge badge-green">🟢 销售专用</span>`;
    if (role === "marketing_only") return `<span class="badge badge-cyan">🟣 社媒引流</span>`;
    if (role === "host_cluster") return `<span class="badge badge-blue">🖥 集群宿主机</span>`;
    return `<span class="badge badge-gray">${esc(role)}</span>`;
  }

  function proxyCountdownBadge(daysLeft, expiresAt) {
    if (daysLeft === null || daysLeft === undefined) return `<span class="badge badge-gray">-</span>`;
    if (daysLeft < 0) return `<span class="badge badge-red">🚨 过期 ${Math.abs(daysLeft)} 天</span>`;
    if (daysLeft <= 7) return `<span class="badge badge-amber">⚠️ 剩 ${daysLeft} 天</span>`;
    return `<span class="badge badge-green">剩 ${daysLeft} 天</span>`;
  }

  function simCategoryBadge(cat) {
    const map = {
      company_master: `<span class="badge badge-blue">客户实名主卡</span>`,
      company_sub: `<span class="badge badge-cyan">客户实名副卡</span>`,
      personal_existing: `<span class="badge badge-gray">客户自用存量卡</span>`,
      external_contract: `<span class="badge badge-amber">第三方授权卡</span>`,
    };
    return map[cat] || `<span class="badge badge-gray">${esc(cat)}</span>`;
  }

  function settlementBadge(p) {
    const ch = p.settlement_channel || "alipay_direct";
    const rateTxt = p.commission_rate_bps ? `·${(p.commission_rate_bps / 100).toFixed(1)}%` : "";
    if (ch === "no_settlement") return `<span class="badge badge-gray">纯引流零收付</span>`;
    if (ch === "corporate_pay_deduct") return `<span class="badge badge-amber">⚡因公扣主户</span>`;
    if (ch === "wechat_pay_mch") return `<span class="badge badge-green">微信mch${rateTxt}</span>`;
    if (ch === "douyin_pay_mch") return `<span class="badge badge-blue">抖音商户${rateTxt}</span>`;
    if (ch === "xhs_merchant") return `<span class="badge badge-purple">千帆钱包${rateTxt}</span>`;
    if (ch === "jd_wallet_mch") return `<span class="badge badge-blue">京东钱包${rateTxt}</span>`;
    if (ch === "overseas_card_fx") return `<span class="badge badge-cyan">外币卡预留${rateTxt}</span>`;
    return `<span class="badge badge-green">企支直连${rateTxt}</span>`;
  }

  function billDirectionBadge(dir, label) {
    if (dir === "inflow_sales") return `<span class="badge badge-green">🟢 ${esc(label || "销售入账")}</span>`;
    if (dir === "outflow_corporate_pay") return `<span class="badge badge-amber">⚡ ${esc(label || "因公代扣")}</span>`;
    if (dir === "inflow_purchase_refund") return `<span class="badge badge-cyan">↩️ ${esc(label || "退券冲回主户")}</span>`;
    if (dir === "outflow_sales_refund") return `<span class="badge badge-red">💸 ${esc(label || "售后退款")}</span>`;
    if (dir === "outflow_deposit") return `<span class="badge badge-purple">🔒 ${esc(label || "缴纳保证金")}</span>`;
    if (dir === "inflow_deposit_return") return `<span class="badge badge-blue">🔓 ${esc(label || "退回保证金")}</span>`;
    if (dir === "inflow_topup") return `<span class="badge badge-green">➕ ${esc(label || "主户注资")}</span>`;
    return `<span class="badge badge-gray">${esc(label || dir)}</span>`;
  }

  function renderLpSelector() {
    const sel = document.getElementById("lp-filter");
    const lps = state.boot.legal_persons || [];
    const current = state.lpFilter;
    let html = `<option value="ALL" ${current === "ALL" ? "selected" : ""}>全平台受托汇总（${lps.length}位委托客户 · ${state.boot.business_entities.length}个受托主体）</option>`;
    for (const lp of lps) {
      const entCnt = state.boot.business_entities.filter((e) => e.legal_person_id === lp.id).length;
      const aliCnt = state.boot.alipay_accounts.filter((a) => a.legal_person_id === lp.id).length;
      html += `<option value="${esc(lp.id)}" ${current === lp.id ? "selected" : ""}>${esc(lp.name)}（${entCnt}主体 · ${aliCnt}企支）</option>`;
    }
    sel.innerHTML = html;
  }

  function getFilteredCollections() {
    const b = state.boot;
    const entities = b.business_entities.filter((e) => matchLP(e.legal_person_id) && matchSearch(e));
    const taxRegs = b.tax_registrations.filter((t) => matchLP(t.legal_person_id) && matchSearch(t));
    const annuals = b.annual_reports.filter((a) => matchLP(a.legal_person_id) && matchSearch(a));
    const alipays = b.alipay_accounts.filter((a) => matchLP(a.legal_person_id) && matchSearch(a));
    const bills = b.alipay_bills.filter((x) => matchLP(x.legal_person_id) && matchSearch(x));
    const platforms = b.platform_accounts.filter((p) => matchLP(p.legal_person_id) && matchSearch(p));
    const proxies = b.proxy_ips.filter((px) => (state.lpFilter === "ALL" || px.legal_person_ids.length === 0 || matchLP(null, px.legal_person_ids)) && matchSearch(px));
    const ads = b.adspower_profiles.filter((w) => (state.lpFilter === "ALL" || w.legal_person_ids.length === 0 || matchLP(null, w.legal_person_ids)) && matchSearch(w));
    const devices = b.physical_devices.filter((d) => (!d.legal_person_id || matchLP(d.legal_person_id)) && matchSearch(d));
    const sims = b.sim_cards.filter((s) => (!s.legal_person_id || matchLP(s.legal_person_id)) && matchSearch(s));
    const quotas = b.carrier_quotas.filter((q) => (!q.legal_person_id || matchLP(q.legal_person_id)) && matchSearch(q));
    const simFees = b.sim_fee_records.filter((f) => (!f.legal_person_id || matchLP(f.legal_person_id)) && matchSearch(f));
    const vaultItems = ((b.vault && b.vault.items) || []).filter((v) => (!v.legal_person_id || matchLP(v.legal_person_id)) && matchSearch(v));
    return { entities, taxRegs, annuals, alipays, bills, platforms, proxies, ads, devices, sims, quotas, simFees, vaultItems };
  }

  function renderSidebar() {
    const nav = document.getElementById("sidebar-nav");
    const c = getFilteredCollections();
    const proxyWarn = c.proxies.filter((p) => p.days_left !== null && p.days_left <= 7).length;
    const simWarn = c.sims.filter((s) => s.is_low_balance || s.is_contract_expiring).length;
    const guardFail = (state.boot.guardrails || []).filter((g) => !g.passed).length;
    const allCases = state.boot.onboarding_cases || [];
    const activeCasesCnt = allCases.filter((x) => x.status !== "completed").length;
    const pendingRevCnt = allCases.filter((x) => x.has_pending_review).length;
    const pendingTplCnt = (state.boot.tutorial_templates || []).filter((t) => t.status === "pending_boss").length;
    const pendingSkipCnt = (state.boot.pending_skip_requests || []).length;
    const missTplCnt = ((state.boot.gap_overview && state.boot.gap_overview.tutorial_coverage) || []).filter((x) => !x.has_published).length;
    const myEmpCases = allCases.filter((x) => x.assigned_staff === state.viewerStaff && x.status !== "completed");

    const gov = state.boot.governance || {};
    const govPendingBoss = gov.pending_boss_count || 0;
    const govPendingGm = gov.pending_gm_count || 0;
    const govTotalGaps = (gov.totals && gov.totals.missing_or_rejected) || 0;
    const govMyOpen = (gov.items || []).filter((x) => x.status !== "published").length;
    const govMyPub = (gov.items || []).filter((x) => x.status === "published").length;

    const chSum = (state.boot.cluster_health && state.boot.cluster_health.summary) || {};
    const locNetViolCnt = chSum.loc_net_violation_count || 0;
    const healthAlertCnt = (chSum.critical_host_count || 0) + (chSum.warning_host_count || 0) + (chSum.mobile_alert_count || 0) + locNetViolCnt;

    let items = BOSS_NAV_ITEMS;
    if (state.viewerRole === "gm_office") items = GM_NAV_ITEMS;
    else if (state.viewerRole === "supervisor") {
      items = state.viewerStaff === "演示开店主管" ? SUP_NAV_ITEMS : OTHER_SUP_NAV_ITEMS;
    } else if (state.viewerRole === "employee") items = EMP_NAV_ITEMS;

    const counts = {
      overview: { val: proxyWarn + simWarn + activeCasesCnt || "统筹", warn: proxyWarn + simWarn > 0 },
      onboarding_hub: { val: activeCasesCnt + pendingTplCnt + pendingSkipCnt, warn: pendingTplCnt + pendingSkipCnt > 0 },
      entities: { val: c.entities.length, warn: false },
      alipay: { val: c.alipays.length, warn: false },
      platforms: { val: c.platforms.length, warn: false },
      network_ads: { val: proxyWarn || c.proxies.length, warn: proxyWarn > 0 },
      ads_device_health: { val: healthAlertCnt ? `警${healthAlertCnt}` : `${chSum.mac_host_count || 10}机`, warn: healthAlertCnt > 0 },
      devices: { val: locNetViolCnt ? `违${locNetViolCnt}` : c.devices.length, warn: locNetViolCnt > 0 },
      sims: { val: simWarn || c.sims.length, warn: simWarn > 0 },
      guardrails: { val: guardFail === 0 ? "OK" : guardFail, warn: guardFail > 0 },
      vault: { val: isVaultUnlocked() ? "🔓" : `🔒${c.vaultItems.length}`, warn: false },
      gov_hub: {
        val: state.viewerRole === "boss" ? (govPendingBoss ? `审${govPendingBoss}` : govTotalGaps) : (govPendingGm ? `审${govPendingGm}` : govTotalGaps),
        warn: (state.viewerRole === "boss" ? govPendingBoss : govPendingGm) + govTotalGaps > 0,
      },
      gov_kpi_okr: { val: (gov.items || []).filter((x) => ["kpi", "okr"].includes(x.item_type)).length, warn: false },
      gov_wiki_video: { val: (gov.items || []).filter((x) => ["wiki", "video"].includes(x.item_type)).length, warn: false },
      gov_sup_my: { val: govMyOpen, warn: govMyOpen > 0 },
      gov_sup_published: { val: govMyPub, warn: false },
      sup_reviews: { val: pendingRevCnt || "0", warn: pendingRevCnt > 0 },
      sup_authoring: { val: `缺${missTplCnt}`, warn: missTplCnt > 0 },
      sup_dispatch: { val: activeCasesCnt, warn: false },
      emp_tasks: { val: myEmpCases.length, warn: myEmpCases.some((x) => x.has_rejected) },
      emp_adspower: { val: `${((state.boot.vault && state.boot.vault.items) || []).length}`, warn: false },
    };

    nav.innerHTML = items.map((item) => {
      const badge = counts[item.key] || { val: "-", warn: false };
      return `
        ${item.sectionHeader ? `<div class="nav-section-divider">${esc(item.sectionHeader)}</div>` : ""}
        <button class="nav-item ${state.view === item.key ? "active" : ""}" data-nav="${item.key}">
          <span class="nav-item-title">${esc(item.title)}</span>
          <span class="nav-badge ${badge.warn ? "warn" : ""}">${esc(badge.val)}</span>
        </button>
      `;
    }).join("");
  }

  // ==================== 4. 思维导图 & 目录树数据构建器 ====================
  function buildMindMapData(c) {
    const activeLp = state.boot.legal_persons.find((x) => x.id === state.lpFilter);
    const ch = state.boot.cluster_health || {};
    const chSum = ch.summary || {};
    const rootTitle = activeLp ? `👤 委托客户：${activeLp.name}` : `🏢 受托运营总览（${state.boot.legal_persons.length}位签约委托客户）`;
    const rootSub = `${c.entities.length} 执照 · ${c.alipays.length} 企支 · ${c.platforms.length} 业务号 · ${chSum.mac_host_count || 10}台64G Mac Pro`;

    const entityBranches = c.entities.map((ent) => {
      const tax = ent.tax_registration;
      const ar = ent.latest_annual_report;
      const entAlis = c.alipays.filter((a) => a.business_entity_id === ent.id);
      const entPlats = c.platforms.filter((p) => p.business_entity_id === ent.id);
      const masterAli = entAlis.find((a) => a.is_entity_master_fund === 1);
      const taxWarn = tax && tax.quota_usage_pct >= 80;

      // 按平台聚合店铺/账号，避免展开时瞬间爆出太多散乱行
      const byPlat = {};
      for (const p of entPlats) {
        if (!byPlat[p.platform]) byPlat[p.platform] = { label: p.platform_label, items: [] };
        byPlat[p.platform].items.push(p);
      }

      const platGroupNodes = Object.entries(byPlat).map(([pk, grp]) => ({
        id: `ent:${ent.id}:plat:${pk}`,
        kind: "cat",
        title: `${grp.label} (${grp.items.length})`,
        sub: grp.items.map((x) => x.account_role === "sales_only" ? "店" : x.account_role === "purchase_only" ? "采" : "社").slice(0, 3).join("/"),
        children: grp.items.map((p) => {
          const hostTag = p.ads_host_code
            ? `🖥${p.ads_host_code}${p.ads_host_health_grade === "critical" ? "🔴" : p.ads_host_health_grade === "warning" ? "🟡" : "🟢"} · `
            : "";
          return {
            id: `plat:${p.id}`,
            kind: "leaf",
            title: `${p.account_role === "sales_only" ? "🟢" : p.account_role === "purchase_only" ? "🟠" : "🟣"} ${p.display_name}`,
            sub: `${hostTag}${p.proxy_code || "真机流量"} · ${p.alipay_code || "无直收付"}`,
            clickAttr: `data-detail-plat="${esc(p.id)}"`,
            hasWarn: (p.proxy_days_left !== null && p.proxy_days_left <= 7) || p.ads_host_health_grade === "critical"
          };
        })
      }));

      return {
        id: `ent:${ent.id}`,
        kind: "entity",
        title: `🏛 ${ent.entity_name.replace(/^杭州市?/, "").replace(/（个体工商户）$/, "")}`,
        sub: `${ent.entity_code} · ${entAlis.length}企支 · ${entPlats.length}号${taxWarn ? " · ⚠️税额" + tax.quota_usage_pct + "%" : ""}`,
        tip: "entity_4shop",
        clickAttr: `data-detail-entity="${esc(ent.id)}"`,
        hasWarn: Boolean(taxWarn),
        children: [
          {
            id: `ent:${ent.id}:gov`,
            kind: "cat",
            title: `⚖️ 税务 & 工商年报`,
            sub: `${tax ? `季开 ${tax.quota_usage_pct}%` : "未登记"} · ${ar && ar.report_status === "publicized" ? "年报已公示" : "待年报"}`,
            tip: "tax_30w",
            hasWarn: Boolean(taxWarn),
            children: [
              tax ? {
                id: `tax:${tax.id}`,
                kind: "leaf",
                title: `🧾 ${tax.tax_bureau_name.replace("国家税务总局杭州市", "")}`,
                sub: `${fenToShortYuan(tax.quarter_sales_fen)} / 30万 (${tax.quota_usage_pct}%)`,
                clickAttr: `data-edit-table="tax_registrations" data-edit-id="${esc(tax.id)}"`,
                hasWarn: taxWarn
              } : null,
              ar ? {
                id: `ar:${ar.id}`,
                kind: "leaf",
                title: `📋 ${ar.report_year}工商年报 · ${ar.report_status === "publicized" ? "已公示" : "待填报"}`,
                sub: `联络手机 ${ar.liaison_phone || "-"}`,
                clickAttr: `data-edit-table="annual_reports" data-edit-id="${esc(ar.id)}"`
              } : null
            ].filter(Boolean)
          },
          {
            id: `ent:${ent.id}:ali`,
            kind: "cat",
            title: `💳 企业支付宝 (${entAlis.length})`,
            sub: masterAli ? `主池 ${masterAli.account_code} (${fenToShortYuan(masterAli.balance_fen)})` : "未设主户",
            tip: "corporate_pay",
            children: entAlis.map((a) => ({
              id: `ali:${a.id}`,
              kind: "leaf",
              title: `${a.is_entity_master_fund ? "🟣 主池" : a.corporate_pay_enabled ? "⚡ 因公采购" : "🟢 销售"} · ${a.account_code}`,
              sub: `${a.corporate_pay_enabled ? `扣 ${a.master_account_code}` : fenToShortYuan(a.balance_fen)}`,
              clickAttr: `data-detail-alipay="${esc(a.id)}"`
            }))
          },
          {
            id: `ent:${ent.id}:plats`,
            kind: "cat",
            title: `🛍 店铺与业务号 (${entPlats.length})`,
            sub: `${ent.sales_store_count} 销售店 · ${entPlats.length - ent.sales_store_count} 采购/社媒`,
            tip: "virtual_matrix",
            children: platGroupNodes
          }
        ]
      };
    });

    // 底层共享资源池分支 1：家宽代理与 AdsPower
    const alertProxies = c.proxies.filter((p) => p.days_left !== null && p.days_left <= 7);
    const okProxies = c.proxies.filter((p) => p.days_left === null || p.days_left > 7);
    const netPoolBranch = {
      id: "pool:network",
      kind: alertProxies.length ? "pool-warn" : "pool",
      title: `🌐 ¥10家宽代理 & AdsPower`,
      sub: `${c.proxies.length}条IP · ${c.ads.length}窗${alertProxies.length ? ` · 🔴 ${alertProxies.length}条临期/过期` : ""}`,
      tip: "proxy_reuse",
      hasWarn: alertProxies.length > 0,
      children: [
        {
          id: "pool:px_alert",
          kind: "cat",
          title: `🚨 临期/已过期家宽 (${alertProxies.length})`,
          sub: alertProxies.length ? "需续费防断网" : "全部正常",
          hasWarn: alertProxies.length > 0,
          children: alertProxies.map((px) => ({
            id: `px:${px.id}`,
            kind: "leaf",
            title: `${px.days_left < 0 ? "🚨" : "⚠️"} ${px.proxy_code} (${px.exit_ip})`,
            sub: `${px.days_left < 0 ? `过期${Math.abs(px.days_left)}天` : `剩${px.days_left}天`} · 复用${px.reused_platform_count}号`,
            clickAttr: `data-detail-proxy="${esc(px.id)}"`,
            hasWarn: true
          }))
        },
        {
          id: "pool:px_ok",
          kind: "cat",
          title: `✅ 健康在用家宽 (${okProxies.length})`,
          sub: "跨平台安全复用中",
          children: okProxies.map((px) => ({
            id: `px:${px.id}`,
            kind: "leaf",
            title: `🌐 ${px.proxy_code} (${px.exit_ip})`,
            sub: `剩${px.days_left}天 · 绑${px.reused_platform_count}平台`,
            clickAttr: `data-detail-proxy="${esc(px.id)}"`
          }))
        },
        {
          id: "pool:ads",
          kind: "cat",
          title: `🪟 AdsPower 窗口 (${c.ads.length})`,
          sub: "按 64GB Mac Pro 宿主机隔离",
          tip: "adspower_bind",
          children: c.devices.filter((d) => d.device_kind === "adspower_pc_host").map((host) => {
            const hAds = c.ads.filter((w) => w.host_device_id === host.id);
            const mh = ((ch.mac_hosts || []).find((m) => m.device_id === host.id)) || {};
            return {
              id: `pool:ads:${host.id}`,
              kind: "leaf",
              title: `🖥 ${host.device_code} (${mh.occupied_slots ?? hAds.length}/${mh.max_account_quota || 50}槽)`,
              sub: `承载 ${hAds.length} 窗 · 内存 ${mh.ram_used_gb || 0}G/64G`,
              clickAttr: `data-detail-machost="${esc(host.id)}"`,
              hasWarn: mh.effective_health_grade && mh.effective_health_grade !== "healthy"
            };
          })
        }
      ]
    };

    // 底层共享资源池分支 1B：10 台 64GB Mac Pro (50账号/台) 集群与真机健康度全景分支
    const macHosts = (ch.mac_hosts || []).filter((m) => {
      if (state.lpFilter !== "ALL" && m.legal_person_ids && m.legal_person_ids.length > 0 && !matchLP(null, m.legal_person_ids)) {
        return false;
      }
      return matchSearch(m);
    });
    const mobHealthList = (ch.mobile_devices || []).filter((ph) => (!ph.legal_person_id || matchLP(ph.legal_person_id)) && matchSearch(ph));
    const hostWarnCnt = macHosts.filter((m) => m.effective_health_grade !== "healthy").length;
    const mobWarnCnt = mobHealthList.filter((ph) => ph.health_grade !== "healthy" || ph.loc_net_compliance_level === "red" || ph.loc_net_compliance_level === "amber").length;
    const macClusterHealthBranch = {
      id: "pool:mac_health",
      kind: hostWarnCnt + mobWarnCnt > 0 ? "pool-warn" : "pool",
      title: `🖥 10台Mac Pro集群(50号/台) · 资产定位与公司网`,
      sub: `${chSum.total_mounted_accounts || 0}/${chSum.total_account_quota || 500}槽 · 资产${fenToShortYuan(chSum.total_asset_cost_fen || 0)}${hostWarnCnt + mobWarnCnt ? ` · 🔴 ${hostWarnCnt + mobWarnCnt}项负载/定位网告警` : " · 全绿合规"}`,
      tip: "loc_corp_net_policy",
      clickAttr: `data-jump-view="ads_device_health"`,
      hasWarn: hostWarnCnt + mobWarnCnt > 0,
      children: [
        ...macHosts.map((m) => ({
          id: `mac:${m.device_id}`,
          kind: "cat",
          title: `${m.effective_health_grade === "critical" ? "🔴" : m.effective_health_grade === "warning" ? "🟡" : "🟢"} ${m.host_code} (${m.asset_no || m.rack_slot}) · ${m.occupied_slots}/${m.max_account_quota}槽`,
          sub: `CPU ${m.cpu_load_pct}% · 🌡${m.soc_temp_c}℃ · 内存 ${m.ram_used_gb}G/64G · 📍在司千兆内网`,
          clickAttr: `data-detail-machost="${esc(m.device_id)}"`,
          hasWarn: m.effective_health_grade !== "healthy",
          children: (m.windows || []).length > 0
            ? m.windows.map((w) => ({
                id: `mac:${m.device_id}:win:${w.id}`,
                kind: (w.bound_accounts || []).length > 0 ? "cat" : "leaf",
                title: `🪟 ${w.profile_code} (#${w.ads_serial_no}) · ${w.window_name}`,
                sub: `${w.exit_ip_check === "blocked_expired" ? "🚨代理过期熔断" : `IP ${w.exit_ip} (${w.proxy_ping_ms}ms)`} · 挂 ${(w.bound_accounts || []).length} 号`,
                clickAttr: `data-detail-machost="${esc(m.device_id)}"`,
                hasWarn: w.win_health_grade !== "healthy",
                children: (w.bound_accounts || []).map((acc) => ({
                  id: `macwin_plat:${acc.id}`,
                  kind: "leaf",
                  title: `${acc.account_role === "sales_only" ? "🟢" : acc.account_role === "purchase_only" ? "🟠" : "🟣"} ${acc.display_name}`,
                  sub: `${acc.platform_label} · ${acc.account_code}`,
                  clickAttr: `data-detail-plat="${esc(acc.id)}"`
                }))
              }))
            : [
                {
                  id: `mac:${m.device_id}:standby`,
                  kind: "leaf",
                  title: `📦 满血空闲托管预备槽位 (余 ${m.remaining_slots}/${m.max_account_quota} 号)`,
                  sub: `${m.lan_ip} · 可随时挂载新开店铺窗口`,
                  clickAttr: `data-detail-machost="${esc(m.device_id)}"`
                }
              ]
        })),
        {
          id: "pool:mac_health:mobiles",
          kind: "cat",
          title: `📱 15部业务手机：定位(在司/居家)×公司网 & 温控 (${mobHealthList.length}台)`,
          sub: mobWarnCnt ? `🔴 ${mobWarnCnt}台定位/公司网/电池告警` : "15台在岗连公司网且温控正常",
          tip: "loc_corp_net_policy",
          hasWarn: mobWarnCnt > 0,
          children: mobHealthList.map((ph) => {
            const hasLocRed = ph.loc_net_compliance_level === "red";
            const dot = (hasLocRed || ph.health_grade === "critical") ? "🔴" : (ph.health_grade === "warning" || ph.loc_net_compliance_level === "amber") ? "🟡" : ph.loc_net_compliance_level === "blue" ? "🔵" : "🟢";
            return {
              id: `mob_h:${ph.device_id}`,
              kind: "leaf",
              title: `${dot} ${ph.device_code} (${ph.asset_no || "-"}) · ${ph.custodian_staff}`,
              sub: `${ph.loc_net_compliance_label} · 🌡${ph.battery_temp_c}℃(🔋${ph.battery_health_pct}%)`,
              clickAttr: `data-detail-device="${esc(ph.device_id)}"`,
              hasWarn: hasLocRed || ph.health_grade !== "healthy" || ph.loc_net_compliance_level === "amber"
            };
          })
        }
      ]
    };

    // 底层共享资源池分支 2：手机卡、配额、话费与真机
    const alertSims = c.sims.filter((s) => s.is_low_balance || s.is_contract_expiring);
    const okSims = c.sims.filter((s) => !s.is_low_balance && !s.is_contract_expiring);
    const simPoolBranch = {
      id: "pool:sim_dev",
      kind: alertSims.length ? "pool-warn" : "pool",
      title: `📶 手机卡 · 话费 · 实体手机`,
      sub: `${c.sims.length}张卡 · ${c.devices.length}台设备${alertSims.length ? ` · 🔴 ${alertSims.length}项预警` : ""}`,
      tip: "sim_1m4s",
      hasWarn: alertSims.length > 0,
      children: [
        {
          id: "pool:sim_alert",
          kind: "cat",
          title: `🚨 低余额 & 临期合约卡 (${alertSims.length})`,
          sub: "点击卡片充值或一键换绑",
          tip: "external_sim",
          hasWarn: alertSims.length > 0,
          children: alertSims.map((s) => ({
            id: `sim:${s.id}`,
            kind: "leaf",
            title: `📱 ${maskStr(s.phone_number, "phone")} (${s.carrier})`,
            sub: `${s.is_low_balance ? `余${fenToYuan(s.balance_fen)} ` : ""}${s.is_contract_expiring ? `合约剩${s.contract_days_left}天 ` : ""}· 绑${s.bound_count}项`,
            clickAttr: `data-detail-sim="${esc(s.id)}"`,
            hasWarn: true
          }))
        },
        {
          id: "pool:sim_quota",
          kind: "cat",
          title: `🔢 一主4副占坑配额 (${c.quotas.length})`,
          sub: "5张上限扣减个人存量卡",
          tip: "sim_1m4s",
          children: c.quotas.map((q) => ({
            id: `qt:${q.id}`,
            kind: "leaf",
            title: `${q.holder_name} · ${q.carrier}`,
            sub: `存量${q.existing_personal_cards} + 已开${q.opened_company_cards}/${q.max_company_openable}张`,
            clickAttr: `data-edit-table="carrier_quotas" data-edit-id="${esc(q.id)}"`
          }))
        },
        {
          id: "pool:sim_ok",
          kind: "cat",
          title: `📶 正常在用手机卡 (${okSims.length})`,
          sub: "主副共享池 & 外部卡",
          children: okSims.map((s) => ({
            id: `sim:${s.id}`,
            kind: "leaf",
            title: `📱 ${maskStr(s.phone_number, "phone")}`,
            sub: `${s.carrier} · 绑${s.bound_count}项`,
            clickAttr: `data-detail-sim="${esc(s.id)}"`
          }))
        },
        {
          id: "pool:devices",
          kind: "cat",
          title: `📱 实体手机与宿主机 (${c.devices.length})`,
          sub: `销售机 ${c.devices.filter((d) => d.device_kind === "work_phone").length} · 采购机 ${c.devices.filter((d) => d.device_kind === "procurement_phone").length}`,
          tip: "device_isolation",
          children: [
            {
              id: "pool:dev_jump",
              kind: "leaf",
              title: "打开实体设备与双卡槽明细 →",
              sub: `共 ${c.devices.length} 台设备在册`,
              clickAttr: `data-jump-view="devices"`
            }
          ]
        }
      ]
    };

    // 无执照归属的独立采购/个人号（如演示客户甲独立闲鱼买货号等）
    const unattachedPlats = c.platforms.filter((p) => !p.business_entity_id);
    const extraBranches = [];
    if (unattachedPlats.length > 0) {
      extraBranches.push({
        id: "ent:unattached",
        kind: "pool",
        title: `🛒 独立非店铺采购/个人号`,
        sub: `不挂营业执照 · 共 ${unattachedPlats.length} 个`,
        tip: "buy_sell_split",
        children: unattachedPlats.map((p) => ({
          id: `plat:${p.id}`,
          kind: "leaf",
          title: `🟠 ${p.platform_label} · ${p.display_name}`,
          sub: `${p.ads_host_code ? `🖥${p.ads_host_code} · ` : ""}${p.proxy_code || "真机"} · 禁卖货`,
          clickAttr: `data-detail-plat="${esc(p.id)}"`
        }))
      });
    }

    // 底层共享资源池分支 3：全量加密密码保险箱 & iPhone 扫码 2FA
    const vItems = c.vaultItems || [];
    const vaultPoolBranch = {
      id: "pool:vault",
      kind: "pool",
      title: `🔐 全量加密密码保险箱 (${vItems.length})`,
      sub: `${isVaultUnlocked() ? `🔓 已解锁 (${formatMMSS(state.vaultTimerSec)})` : "🔒 默认锁定 · iPhone扫码/动态码解锁"}`,
      tip: "vault_2fa",
      clickAttr: `data-jump-view="vault"`,
      children: [
        {
          id: "pool:vault:gov",
          kind: "leaf",
          title: `🏛 电子税务局 & 工商年报密码 (${vItems.filter((x) => x.category === "gov_tax").length})`,
          sub: "登录密码 · 个税申报码 · 联络员口令",
          clickAttr: `data-jump-vault-cat="gov_tax"`
        },
        {
          id: "pool:vault:ali",
          kind: "leaf",
          title: `💳 企业支付宝登录 & 支付盾密 (${vItems.filter((x) => x.category === "alipay").length})`,
          sub: "登录密码 · 6位支付盾密 · 子邮箱密码",
          clickAttr: `data-jump-vault-cat="alipay"`
        },
        {
          id: "pool:vault:plat",
          kind: "leaf",
          title: `🛍 13类平台店铺与买券密码 (${vItems.filter((x) => x.category === "platform").length})`,
          sub: "登录密码 · 提现口令 · 托管子号2FA码",
          clickAttr: `data-jump-vault-cat="platform"`
        },
        {
          id: "pool:vault:net",
          kind: "leaf",
          title: `🌐 AdsPower总控 & 家宽节点密码 (${vItems.filter((x) => x.category === "network_ads").length})`,
          sub: "超管总控 · 蛟龙代理后台 · SOCKS5密钥",
          clickAttr: `data-jump-vault-cat="network_ads"`
        },
        {
          id: "pool:vault:dev",
          kind: "leaf",
          title: `📱 真机锁屏/云ID & SIM服务密码 (${vItems.filter((x) => x.category === "device_sim").length})`,
          sub: "锁屏码 · Apple/小米ID · 运营商6位服务密",
          clickAttr: `data-jump-vault-cat="device_sim"`
        }
      ]
    };

    return {
      id: "root",
      kind: "root",
      title: rootTitle,
      sub: rootSub,
      tip: "mindmap_arch",
      children: [...entityBranches, ...extraBranches, macClusterHealthBranch, netPoolBranch, simPoolBranch, vaultPoolBranch]
    };
  }

  function isMmOpen(nodeId) {
    if (nodeId === "root") return true;
    if (state.search.trim() !== "") return true;
    return state.mmExpanded.has(nodeId);
  }

  function renderMindMapNodeHtml(node) {
    const kids = node.children || [];
    const hasKids = kids.length > 0;
    const expanded = hasKids && isMmOpen(node.id);
    const kindCls =
      node.kind === "root" ? "mm-root" :
      node.kind === "entity" ? "mm-entity" :
      node.kind === "pool-warn" ? "mm-pool-warn" :
      node.kind === "pool" ? "mm-pool" :
      node.kind === "cat" ? "mm-cat" : "mm-leaf";

    const clickCls = node.clickAttr ? "mm-leaf-click" : "";

    return `
      <div class="mm-branch">
        <div class="mm-node ${kindCls} ${clickCls}">
          <div class="mm-main" ${node.clickAttr || ""}>
            <div class="mm-title">
              <span>${node.title}</span>
              ${node.tip ? qTip(node.tip) : ""}
            </div>
            ${node.sub ? `<div class="mm-sub">${esc(node.sub)}</div>` : ""}
          </div>
          ${
            hasKids && node.id !== "root"
              ? `<button type="button" class="mm-toggle ${expanded ? "expanded" : ""}" data-mm-toggle="${esc(node.id)}">${expanded ? "− 收起" : `+ ${kids.length}`}</button>`
              : ""
          }
        </div>
        ${
          expanded
            ? `<div class="mm-children">${kids.map((k) => renderMindMapNodeHtml(k)).join("")}</div>`
            : ""
        }
      </div>
    `;
  }

  function renderDirectoryOutlineHtml(node, isRoot = false) {
    const kids = node.children || [];
    const hasKids = kids.length > 0;
    const expanded = hasKids && isMmOpen(node.id);
    return `
      <li class="dir-item">
        <div class="dir-row">
          ${
            hasKids && !isRoot
              ? `<button type="button" class="mm-toggle ${expanded ? "expanded" : ""}" data-mm-toggle="${esc(node.id)}">${expanded ? "▾" : `▸ +${kids.length}`}</button>`
              : `<span style="width:16px;display:inline-block;text-align:center;color:#94a3b8;">•</span>`
          }
          <strong ${node.clickAttr || ""} style="${node.clickAttr ? "cursor:pointer;color:var(--blue-dark);" : ""}">${node.title}</strong>
          ${node.tip ? qTip(node.tip) : ""}
          ${node.sub ? `<span class="badge badge-gray">${esc(node.sub)}</span>` : ""}
        </div>
        ${
          expanded
            ? `<ul class="dir-list">${kids.map((k) => renderDirectoryOutlineHtml(k, false)).join("")}</ul>`
            : ""
        }
      </li>
    `;
  }

  function collectAllMmIds(node, maxDepth, curDepth = 0, out = []) {
    if (curDepth < maxDepth && node.children && node.children.length > 0) {
      out.push(node.id);
      for (const ch of node.children) collectAllMmIds(ch, maxDepth, curDepth + 1, out);
    }
    return out;
  }

  function collectWarnMmIds(node, ancestors = [], out = new Set(["root"])) {
    const curPath = [...ancestors, node.id];
    if (node.hasWarn) {
      for (const id of curPath) out.add(id);
    }
    for (const ch of node.children || []) {
      collectWarnMmIds(ch, curPath, out);
    }
    return out;
  }

  // ==================== 5. 视图 01：思维导图总目录 + 折叠预警与简表 ====================
  function renderOverview(c) {
    const tree = buildMindMapData(c);
    const proxyAlerts = c.proxies.filter((p) => p.days_left !== null && p.days_left <= 7).sort((a, b) => a.days_left - b.days_left);
    const simAlerts = c.sims.filter((s) => s.is_low_balance || s.is_contract_expiring);
    const totalAlerts = proxyAlerts.length + simAlerts.length;
    const monthlyProxyCost = c.proxies.reduce((acc, p) => acc + p.monthly_cost_fen, 0);
    const monthlySimRent = c.sims.filter((s) => s.sim_status !== "retired").reduce((acc, s) => acc + s.monthly_rent_fen, 0);
    const guardPassCnt = (state.boot.guardrails || []).filter((g) => g.passed).length;

    const alertsFoldHtml = renderFoldCard({
      id: "home:alerts",
      title: `🔔 待办到期与余额预警 (${totalAlerts})`,
      tipKey: "external_sim",
      variant: totalAlerts > 0 ? "danger" : "",
      pillsHtml: `
        <span class="badge ${proxyAlerts.length ? "badge-red" : "badge-green"}">家宽临期/过期 ${proxyAlerts.length}</span>
        <span class="badge ${simAlerts.length ? "badge-amber" : "badge-green"}">话费/合约预警 ${simAlerts.length}</span>
      `,
      padded: true,
      bodyHtml: `
        <div class="alert-grid-2">
          <div class="alert-list">
            ${
              proxyAlerts.length === 0
                ? `<div class="badge badge-green">暂无 7 天内到期家宽</div>`
                : proxyAlerts.map((px) => `
                  <div class="alert-row ${px.days_left < 0 ? "danger" : "warn"}">
                    <div>
                      <strong class="mono">${esc(px.proxy_code)} · ${esc(px.exit_ip)}</strong>
                      <span class="cell-sub">${proxyCountdownBadge(px.days_left, px.expires_at)} · 复用 ${px.reused_platform_count} 个账号</span>
                    </div>
                    <div class="op-btns">
                      <button class="btn btn-success btn-xs" data-renew-proxy="${esc(px.id)}">+续1月(¥10)</button>
                      <button class="btn btn-outline btn-xs" data-detail-proxy="${esc(px.id)}">详情</button>
                    </div>
                  </div>
                `).join("")
            }
          </div>
          <div class="alert-list">
            ${
              simAlerts.length === 0
                ? `<div class="badge badge-green">所有手机卡余额与合约正常</div>`
                : simAlerts.map((s) => `
                  <div class="alert-row ${s.is_low_balance ? "danger" : "warn"}">
                    <div>
                      <strong class="mono">${maskStr(s.phone_number, "phone")}</strong> <span class="badge badge-gray">${esc(s.carrier)}</span>
                      <span class="cell-sub">
                        ${s.is_low_balance ? `余额 ${fenToYuan(s.balance_fen)} ` : ""}
                        ${s.is_contract_expiring ? `合约剩 ${s.contract_days_left} 天 ` : ""}
                        · 绑 ${s.bound_count} 个对象
                      </span>
                    </div>
                    <div class="op-btns">
                      <button class="btn btn-primary btn-xs" data-detail-sim="${esc(s.id)}">充值 / 换绑</button>
                    </div>
                  </div>
                `).join("")
            }
          </div>
        </div>
      `
    });

    const totalGuardCnt = (state.boot.guardrails || []).length || 6;
    const chSum = (state.boot.cluster_health && state.boot.cluster_health.summary) || {};
    const macAlerts = (chSum.critical_host_count || 0) + (chSum.warning_host_count || 0) + (chSum.mobile_alert_count || 0) + (chSum.loc_net_violation_count || 0);

    const entitySummaryFoldHtml = renderFoldCard({
      id: "home:entity_table",
      title: `📊 营业执照主体速览表 (${c.entities.length})`,
      tipKey: "entity_4shop",
      pillsHtml: `<span class="badge badge-green">✓ ${guardPassCnt}/${totalGuardCnt} 红线全绿</span>`,
      bodyHtml: `
        <div class="table-wrap">
          <table class="ledger-table">
            <thead>
              <tr>
                <th>主体编号</th>
                <th>营业执照名称</th>
                <th>按季申报阈值水位 ${qTip("tax_30w")}</th>
                <th>工商年报 ${qTip("annual_report")}</th>
                <th>3选1主资金池 ${qTip("master_3in1")}</th>
                <th>挂载企支 / 店铺</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${c.entities.map((e) => {
                const tax = e.tax_registration;
                const ar = e.latest_annual_report;
                const master = e.master_alipay;
                const pct = tax ? tax.quota_usage_pct : 0;
                return `
                  <tr>
                    <td class="mono"><strong>${esc(e.entity_code)}</strong></td>
                    <td><strong>${esc(e.entity_name)}</strong></td>
                    <td>
                      ${tax ? `<span class="mono">${pct}% (${fenToShortYuan(tax.quarter_sales_fen)})</span><div class="progress-bar"><div class="progress-fill ${pct >= 80 ? "warn" : ""}" style="width:${Math.min(100, pct)}%"></div></div>` : `-`}
                    </td>
                    <td>${ar ? `<span class="badge ${ar.report_status === "publicized" ? "badge-green" : "badge-amber"}">${ar.report_year} ${ar.report_status === "publicized" ? "已公示" : "待报"}</span>` : `-`}</td>
                    <td>${master ? `<span class="link-chip mono" data-detail-alipay="${esc(master.id)}">🟣 ${esc(master.account_code)} (${fenToShortYuan(master.balance_fen)})</span>` : `-`}</td>
                    <td><span class="badge badge-blue">${e.alipay_count} 企支</span> <span class="badge badge-green">${e.sales_store_count} 店</span></td>
                    <td><button class="btn btn-outline btn-xs" data-detail-entity="${esc(e.id)}">穿透</button></td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `
    });

    return `
      <div class="page-header">
        <div class="page-title-row">
          <h2>全维缺口统筹雷达 & 全景思维导图总目录 ${qTip("gap_radar")} ${qTip("mindmap_arch")} ${qTip("role_3portals")}</h2>
        </div>
        <div class="op-btns">
          <span class="badge badge-gray mono">基准日 ${esc(state.boot.meta.today)}</span>
        </div>
      </div>

      ${window.LedgerPortals ? window.LedgerPortals.renderBossGapTopSection() : ""}

      <!-- 极简 6 格核心数字条（说明全部收进右上角 ?） -->
      <div class="stat-strip">
        <div class="stat-pill-card" data-jump-view="entities">
          <div class="stat-pill-top"><span>执照 / 税 / 年报</span>${qTip("entity_4shop")}</div>
          <div class="stat-pill-val"><strong class="num">${c.entities.length}</strong><span class="badge badge-blue">${c.taxRegs.length}税 · ${c.annuals.length}年报</span></div>
        </div>
        <div class="stat-pill-card" data-jump-view="alipay">
          <div class="stat-pill-top"><span>企业支付宝</span>${qTip("corporate_pay")}</div>
          <div class="stat-pill-val"><strong class="num">${c.alipays.length}</strong><span class="badge badge-purple">${c.alipays.filter((x) => x.is_entity_master_fund === 1).length}主户 · 因公付</span></div>
        </div>
        <div class="stat-pill-card" data-jump-view="platforms">
          <div class="stat-pill-top"><span>全平台业务号</span>${qTip("virtual_matrix")}</div>
          <div class="stat-pill-val"><strong class="num">${c.platforms.length}</strong><span class="badge badge-green">${c.platforms.filter((p) => p.account_role === "sales_only").length}店 · ${c.platforms.filter((p) => p.account_role !== "sales_only").length}采/社</span></div>
        </div>
        <div class="stat-pill-card" data-jump-view="network_ads">
          <div class="stat-pill-top"><span>¥10家宽代理池</span>${qTip("proxy_reuse")}</div>
          <div class="stat-pill-val"><strong class="num">${c.proxies.length}</strong><span class="badge ${proxyAlerts.length ? "badge-red" : "badge-green"}">${proxyAlerts.length ? `${proxyAlerts.length}临期` : `${fenToShortYuan(monthlyProxyCost)}/月`}</span></div>
        </div>
        <div class="stat-pill-card" data-jump-view="sims">
          <div class="stat-pill-top"><span>手机卡与话费</span>${qTip("sim_1m4s")}</div>
          <div class="stat-pill-val"><strong class="num">${c.sims.length}</strong><span class="badge ${simAlerts.length ? "badge-red" : "badge-amber"}">${simAlerts.length ? `${simAlerts.length}预警` : `${fenToShortYuan(monthlySimRent)}/月`}</span></div>
        </div>
        <div class="stat-pill-card" data-jump-view="ads_device_health">
          <div class="stat-pill-top"><span>10台64G Mac·健康</span>${qTip("macpro_50_health")}</div>
          <div class="stat-pill-val"><strong class="num">${chSum.mac_host_count || 10}×64G</strong><span class="badge ${macAlerts ? "badge-red" : "badge-green"}">${macAlerts ? `${macAlerts}项告警` : `${chSum.total_mounted_accounts || 0}/${chSum.total_account_quota || 500}槽`}</span></div>
        </div>
      </div>

      <!-- 主视觉：交互式思维导图 / 目录大纲画布 -->
      <div class="mindmap-shell">
        <div class="mindmap-toolbar">
          <div class="op-btns">
            <div class="subtabs">
              <button class="subtab-btn ${state.homeMode === "mindmap" ? "active" : ""}" data-home-mode="mindmap">🗺 横向思维导图</button>
              <button class="subtab-btn ${state.homeMode === "outline" ? "active" : ""}" data-home-mode="outline">📂 树状目录大纲</button>
            </div>
            <span class="mindmap-hint">点节点右侧 <b>+数字</b> 逐级展开，点名称查看详情，点 <b>?</b> 看衍生逻辑</span>
          </div>
          <div class="op-btns">
            <button class="btn btn-outline btn-xs" data-mm-preset="trunk">折叠至主干</button>
            <button class="btn btn-outline btn-xs" data-mm-preset="level2">展开模块层</button>
            <button class="btn btn-amber btn-xs" data-mm-preset="warn">🚨 仅展开预警分支</button>
            <button class="btn btn-outline btn-xs" data-mm-preset="all">全部展开</button>
          </div>
        </div>

        ${
          state.homeMode === "mindmap"
            ? `<div class="mindmap-canvas"><div class="mm-tree">${renderMindMapNodeHtml(tree)}</div></div>`
            : `<div class="dir-outline-wrap"><ul class="dir-list dir-root-list">${renderDirectoryOutlineHtml(tree, true)}</ul></div>`
        }
      </div>

      <!-- 底部次要区块默认全部折叠，按需点开 -->
      ${alertsFoldHtml}
      ${entitySummaryFoldHtml}
    `;
  }

  // ==================== 6. 视图 02：法人·执照·4税务·4年报（折叠手风琴） ====================
  function renderEntitiesView(c) {
    const lps = state.boot.legal_persons.filter((lp) => matchLP(lp.id) && matchSearch(lp));
    const warnTaxCnt = c.taxRegs.filter((t) => t.quota_usage_pct >= 80).length;

    const foldIds = ["ent:licenses", "ent:tax", "ent:annual", "ent:lps"];

    return `
      <div class="page-header">
        <h2>签约委托客户 · 受托营业执照 · 税务登记 · 工商年报 ${qTip("entity_4shop")}</h2>
        <div class="op-btns">
          <button class="btn btn-outline btn-sm" data-batch-fold="${foldIds.join(",")}" data-batch-dir="open">展开全部</button>
          <button class="btn btn-outline btn-sm" data-batch-fold="${foldIds.join(",")}" data-batch-dir="close">全部折叠</button>
          <button class="btn btn-primary btn-sm" data-open-create="business_entities">+ 新增营业执照</button>
        </div>
      </div>

      ${renderFoldCard({
        id: "ent:licenses",
        title: `🏛 受托客户营业执照主体 (${c.entities.length})`,
        tipKey: "entity_4shop",
        pillsHtml: `<span class="badge badge-blue">每约 4 店 1 照</span>`,
        bodyHtml: `
          <div class="table-wrap">
            <table class="ledger-table">
              <thead>
                <tr>
                  <th>编号</th>
                  <th>营业执照全称</th>
                  <th>统一社会信用代码</th>
                  <th>主体性质 / 委托客户法人</th>
                  <th>登记机关</th>
                  <th>下挂企支 / 店铺</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${c.entities.map((e) => `
                  <tr>
                    <td class="mono"><strong>${esc(e.entity_code)}</strong></td>
                    <td><strong>${esc(e.entity_name)}</strong></td>
                    <td class="mono">${esc(e.uscc)}</td>
                    <td>${e.entity_type === "company" ? "有限公司" : "个体工商户"} · ${esc(e.legal_person_name)}</td>
                    <td>${esc(e.registration_authority)}</td>
                    <td><span class="badge badge-purple">${e.alipay_count} 企支</span> <span class="badge badge-green">${e.sales_store_count} 店</span></td>
                    <td><span class="badge badge-green">${esc(e.license_status)}</span></td>
                    <td>
                      <div class="op-btns">
                        <button class="btn btn-outline btn-xs" data-detail-entity="${esc(e.id)}">穿透</button>
                        <button class="btn btn-outline btn-xs" data-edit-table="business_entities" data-edit-id="${esc(e.id)}">编辑</button>
                      </div>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `
      })}

      ${renderFoldCard({
        id: "ent:tax",
        title: `🧾 电子税务局登记 (${c.taxRegs.length})`,
        tipKey: "tax_30w",
        variant: warnTaxCnt > 0 ? "warn" : "",
        pillsHtml: warnTaxCnt > 0
          ? `<span class="badge badge-amber">⚠️ ${warnTaxCnt} 个主体季开票 ≥ 80%</span>`
          : `<span class="badge badge-green">额度健康</span>`,
        actionHtml: `<button class="btn btn-outline btn-xs" data-open-create="tax_registrations">+ 新增税务</button>`,
        bodyHtml: `
          <div class="table-wrap">
            <table class="ledger-table">
              <thead>
                <tr>
                  <th>所属执照</th>
                  <th>主管税务局</th>
                  <th>纳税资质</th>
                  <th>办税员 & 绑定手机</th>
                  <th>季度销售额 / 30万法定阈值 ${qTip("tax_30w")}</th>
                  <th>申报状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${c.taxRegs.map((t) => `
                  <tr class="${t.quota_usage_pct >= 80 ? "row-warn" : ""}">
                    <td class="mono"><strong>${esc(t.entity_code)}</strong></td>
                    <td>${esc(t.tax_bureau_name)}</td>
                    <td>${esc(t.taxpayer_type)} · ${esc(t.filing_cycle)}</td>
                    <td>
                      ${esc(t.tax_officer_name)}
                      ${t.bound_sim_id ? `<span class="link-chip mono" data-detail-sim="${esc(t.bound_sim_id)}">📱 ${maskStr(t.bound_phone, "phone")}</span>` : ""}
                    </td>
                    <td>
                      <span class="mono"><strong>${fenToShortYuan(t.quarter_sales_fen)}</strong> / 30万 (${t.quota_usage_pct}%)</span>
                      <div class="progress-bar"><div class="progress-fill ${t.quota_usage_pct >= 80 ? "warn" : ""}" style="width:${Math.min(100, t.quota_usage_pct)}%"></div></div>
                    </td>
                    <td><span class="badge badge-green">${esc(t.current_period)} · 已报</span></td>
                    <td><button class="btn btn-outline btn-xs" data-edit-table="tax_registrations" data-edit-id="${esc(t.id)}">编辑</button></td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `
      })}

      ${renderFoldCard({
        id: "ent:annual",
        title: `📋 工商管理局年报公示 (${c.annuals.length})`,
        tipKey: "annual_report",
        pillsHtml: `<span class="badge badge-green">全部已公示</span>`,
        actionHtml: `<button class="btn btn-outline btn-xs" data-open-create="annual_reports">+ 新增年报</button>`,
        bodyHtml: `
          <div class="table-wrap">
            <table class="ledger-table">
              <thead>
                <tr>
                  <th>所属执照</th>
                  <th>报告年度</th>
                  <th>管辖市场监管局</th>
                  <th>联络员 & 备案手机</th>
                  <th>公示状态</th>
                  <th>提交日期</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${c.annuals.map((ar) => `
                  <tr>
                    <td class="mono"><strong>${esc(ar.entity_code)}</strong></td>
                    <td class="mono">${ar.report_year} 年度</td>
                    <td>${esc(ar.aic_bureau_name)}</td>
                    <td>
                      ${esc(ar.liaison_name)}
                      ${ar.liaison_sim_id ? `<span class="link-chip mono" data-detail-sim="${esc(ar.liaison_sim_id)}">📱 ${maskStr(ar.liaison_phone, "phone")}</span>` : ""}
                    </td>
                    <td><span class="badge ${ar.report_status === "publicized" ? "badge-green" : "badge-amber"}">${ar.report_status === "publicized" ? "✓ 已公示" : "待填报"}</span></td>
                    <td class="mono">${esc(ar.submitted_date || "-")}</td>
                    <td><button class="btn btn-outline btn-xs" data-edit-table="annual_reports" data-edit-id="${esc(ar.id)}">编辑</button></td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `
      })}

      ${renderFoldCard({
        id: "ent:lps",
        title: `👤 签约委托客户档案与托管运营合同 (${lps.length})`,
        pillsHtml: `<span class="badge badge-gray">身份证 · 刷脸配合SLA</span>`,
        actionHtml: `<button class="btn btn-outline btn-xs" data-open-create="legal_persons">+ 新增委托客户</button>`,
        bodyHtml: `
          <div class="table-wrap">
            <table class="ledger-table">
              <thead>
                <tr>
                  <th>委托客户 / 法人姓名</th>
                  <th>身份证号</th>
                  <th>本人主手机</th>
                  <th>刷脸响应SLA</th>
                  <th>托管运营合同号 & 到期</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${lps.map((lp) => `
                  <tr>
                    <td><strong>${esc(lp.name)}</strong></td>
                    <td class="mono">${maskStr(lp.id_card_no, "idcard")}</td>
                    <td class="mono">${maskStr(lp.primary_phone, "phone")}</td>
                    <td><span class="badge badge-green">${esc(lp.face_verify_sla)}</span></td>
                    <td class="mono">${esc(lp.agency_contract_no)} (至 ${esc(lp.contract_expires_at)})</td>
                    <td><button class="btn btn-outline btn-xs" data-edit-table="legal_persons" data-edit-id="${esc(lp.id)}">编辑</button></td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `
      })}
    `;
  }

  // ==================== 7. 视图 03：企业支付宝（按营业执照分组折叠） ====================
  function renderAlipayView(c) {
    const filteredAlis = c.alipays.filter((a) => state.alipayRole === "ALL" || a.trade_direction === state.alipayRole);
    const entFoldIds = c.entities.map((e) => `ali_ent:${e.id}`);

    const groupedByEntHtml = c.entities.map((ent) => {
      const rows = filteredAlis.filter((a) => a.business_entity_id === ent.id);
      if (rows.length === 0) return "";
      const master = rows.find((a) => a.is_entity_master_fund === 1) || ent.master_alipay;
      const buyCnt = rows.filter((a) => a.trade_direction === "purchase_only").length;
      const sellCnt = rows.filter((a) => a.trade_direction === "sales_only").length;

      return renderFoldCard({
        id: `ali_ent:${ent.id}`,
        title: `🏛 ${ent.entity_code} · ${ent.entity_name}`,
        pillsHtml: `
          ${master ? `<span class="badge badge-purple">🟣 主池 ${esc(master.account_code)} (${fenToShortYuan(master.balance_fen)})</span>` : ""}
          <span class="badge badge-amber">⚡ ${buyCnt} 因公采购</span>
          <span class="badge badge-green">🟢 ${sellCnt} 销售</span>
        `,
        bodyHtml: `
          <div class="table-wrap">
            <table class="ledger-table">
              <thead>
                <tr>
                  <th>编号</th>
                  <th>账户名称 & 登录邮箱</th>
                  <th>角色定位 ${qTip("buy_sell_split")}</th>
                  <th>因公支付关系 ${qTip("corporate_pay")}</th>
                  <th>15步开户教程进度 ${qTip("dual_track_gate")}</th>
                  <th>安全手机</th>
                  <th>当前余额</th>
                  <th>挂载店铺/买券号</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map((a) => {
                  const aliCase = window.LedgerPortals ? window.LedgerPortals.getCaseForTarget("alipay", a.id) : null;
                  return `
                  <tr>
                    <td class="mono"><strong>${esc(a.account_code)}</strong></td>
                    <td><strong>${esc(a.account_name)}</strong><span class="cell-sub mono">${esc(a.login_email)}</span></td>
                    <td>${roleBadge(a.trade_direction)}</td>
                    <td>
                      ${
                        a.is_entity_master_fund
                          ? `<span class="badge badge-purple">★ 3选1唯一主资金池</span>`
                          : a.corporate_pay_enabled
                          ? `<span class="badge badge-amber">⚡ 因公扣 ${esc(a.master_account_code)}</span>`
                          : `<span class="cell-sub">独立收款结算</span>`
                      }
                    </td>
                    <td>${window.LedgerPortals ? window.LedgerPortals.caseSummaryBadge(aliCase) : "-"}</td>
                    <td>${a.bound_sim_id ? `<span class="link-chip mono" data-detail-sim="${esc(a.bound_sim_id)}">📱 ${maskStr(a.bound_phone, "phone")}</span>` : "-"}</td>
                    <td class="mono"><strong>${fenToYuan(a.balance_fen)}</strong></td>
                    <td>
                      ${
                        a.bound_platform_accounts.length === 0
                          ? `<span class="cell-sub">资金池蓄水</span>`
                          : `<span class="badge badge-gray">${a.bound_platform_accounts.length} 个账号</span> <span class="cell-sub">${a.bound_platform_accounts.slice(0, 2).map((p) => p.display_name).join("、")}${a.bound_platform_accounts.length > 2 ? "…" : ""}</span>`
                      }
                    </td>
                    <td>
                      <div class="op-btns">
                        ${aliCase ? `<button class="btn btn-primary btn-xs" data-open-wizard="${esc(aliCase.id)}">教程</button>` : ""}
                        <button class="btn btn-outline btn-xs" data-detail-alipay="${esc(a.id)}">详情</button>
                        ${state.viewerRole === "boss" ? `<button class="btn btn-outline btn-xs" data-edit-table="alipay_accounts" data-edit-id="${esc(a.id)}">编辑</button>` : ""}
                      </div>
                    </td>
                  </tr>
                `;}).join("")}
              </tbody>
            </table>
          </div>
        `
      });
    }).join("");

    const finFoldIds = c.entities.map((e) => `fin_ent:${e.id}`);
    const accountFinanceByEntHtml = c.entities.map((ent) => {
      const pas = c.platforms.filter((p) => p.business_entity_id === ent.id);
      if (pas.length === 0) return "";
      const totalGmv = pas.reduce((s, x) => s + (x.month_gmv_fen || 0), 0);
      const totalNetMargin = pas.reduce((s, x) => s + (x.net_margin_fen || 0), 0);
      const totalDep = pas.reduce((s, x) => s + (x.deposit_fen || 0), 0);
      return renderFoldCard({
        id: `fin_ent:${ent.id}`,
        title: `💰 ${ent.entity_code} · ${ent.entity_name}（单号财务与损益槽）`,
        tipKey: "account_finance_slot",
        pillsHtml: `
          <span class="badge badge-blue">${pas.length} 个商业号</span>
          <span class="badge badge-green">月GMV ${fenToShortYuan(totalGmv)}</span>
          <span class="badge badge-purple">预估净毛利 ${fenToShortYuan(totalNetMargin)}</span>
          <span class="badge badge-gray">在押保证金 ${fenToShortYuan(totalDep)}</span>
        `,
        bodyHtml: `
          <div class="table-wrap">
            <table class="ledger-table">
              <thead>
                <tr>
                  <th>账号 / 平台</th>
                  <th>清算/扣款通道 ${qTip("account_finance_slot")}</th>
                  <th>商户号 & 落账卡/主户</th>
                  <th>平台费率</th>
                  <th>保证金 / 冻结</th>
                  <th>当月GMV / 成本 / 退单</th>
                  <th>净毛利 / ERP财务槽</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${pas.map((p) => `
                  <tr>
                    <td>
                      <strong>${esc(p.display_name)}</strong>
                      <span class="cell-sub mono">${esc(p.account_code)} · ${esc(p.platform_label)}</span>
                    </td>
                    <td>
                      ${settlementBadge(p)}
                      <span class="cell-sub">${esc(p.settlement_cycle || "-")}</span>
                    </td>
                    <td>
                      <span class="mono">${esc(p.merchant_account_no || "-")}</span>
                      <span class="cell-sub">${esc(p.settlement_bank_ref || "-")}</span>
                    </td>
                    <td class="mono">${p.commission_rate_bps ? `${(p.commission_rate_bps / 100).toFixed(2)}%` : "-"}</td>
                    <td class="mono">
                      ${p.deposit_fen ? fenToYuan(p.deposit_fen) : "-"}
                      ${p.frozen_balance_fen ? `<span class="cell-sub">冻 ${fenToYuan(p.frozen_balance_fen)}</span>` : ""}
                    </td>
                    <td class="mono">
                      ${
                        p.account_role === "sales_only"
                          ? `销 ${fenToShortYuan(p.month_gmv_fen)}<span class="cell-sub">本 ${fenToShortYuan(p.month_cost_fen)} · 退 ${fenToShortYuan(p.month_refund_fen)}</span>`
                          : p.account_role === "purchase_only"
                          ? `采 ${fenToShortYuan(p.month_cost_fen)}<span class="cell-sub">退券冲回 ${fenToShortYuan(p.month_refund_fen)}</span>`
                          : `<span class="cell-sub">纯引流不碰钱</span>`
                      }
                    </td>
                    <td>
                      ${
                        p.account_role === "sales_only"
                          ? `<strong class="mono" style="color:var(--green)">${fenToYuan(p.net_margin_fen)}</strong>`
                          : p.account_role === "purchase_only"
                          ? `<span class="mono">净采 ${fenToYuan(p.net_purchase_fen)}</span>`
                          : `<span class="cell-sub">-</span>`
                      }
                      <span class="cell-sub mono">${esc(p.finance_book_code || "待映射")}</span>
                    </td>
                    <td>
                      <button class="btn btn-outline btn-xs" data-detail-plat="${esc(p.id)}">财务详情</button>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `
      });
    }).join("");

    return `
      <div class="page-header">
        <h2>资金账户 · 全账号财务预留 · 账单流水 ${qTip("master_3in1")} ${qTip("account_finance_slot")}</h2>
        <div class="subtabs">
          <button class="subtab-btn ${state.alipaySubTab === "accounts" ? "active" : ""}" data-ali-sub="accounts">企业支付宝分组 (${c.alipays.length})</button>
          <button class="subtab-btn ${state.alipaySubTab === "finance" ? "active" : ""}" data-ali-sub="finance">全账号财务预留总表 (${c.platforms.length})</button>
          <button class="subtab-btn ${state.alipaySubTab === "bills" ? "active" : ""}" data-ali-sub="bills">收支·退券·保证金流水 (${c.bills.length})</button>
        </div>
      </div>

      ${state.alipaySubTab === "accounts" ? `
      <div class="filter-bar">
        <div class="pill-group">
          <button class="pill ${state.alipayRole === "ALL" ? "active" : ""}" data-ali-role="ALL">全部 (${c.alipays.length})</button>
          <button class="pill ${state.alipayRole === "master_fund" ? "active" : ""}" data-ali-role="master_fund">🟣 3选1主户 (${c.alipays.filter((x) => x.trade_direction === "master_fund").length})</button>
          <button class="pill ${state.alipayRole === "purchase_only" ? "active" : ""}" data-ali-role="purchase_only">🟠 因公采购号 (${c.alipays.filter((x) => x.trade_direction === "purchase_only").length})</button>
          <button class="pill ${state.alipayRole === "sales_only" ? "active" : ""}" data-ali-role="sales_only">🟢 纯销售号 (${c.alipays.filter((x) => x.trade_direction === "sales_only").length})</button>
        </div>
        <div class="op-btns">
          <button class="btn btn-outline btn-sm" data-batch-fold="${entFoldIds.join(",")}" data-batch-dir="open">展开全部主体</button>
          <button class="btn btn-outline btn-sm" data-batch-fold="${entFoldIds.join(",")}" data-batch-dir="close">全部折叠</button>
          <button class="btn btn-primary btn-sm" data-open-create="alipay_accounts">+ 新增企业支付宝</button>
        </div>
      </div>
      ${groupedByEntHtml}
      ` : state.alipaySubTab === "finance" ? `
      <div class="filter-bar">
        <div class="pill-group">
          <span class="cell-sub">已按主体折叠收纳每个商业账号的清算通道（企支/微信mch/抖音/千帆/京东钱包/因公代扣）、平台佣金费率、保证金原路退回与 ERP/OA 核算槽位</span>
        </div>
        <div class="op-btns">
          <button class="btn btn-outline btn-sm" data-batch-fold="${finFoldIds.join(",")}" data-batch-dir="open">展开全部主体</button>
          <button class="btn btn-outline btn-sm" data-batch-fold="${finFoldIds.join(",")}" data-batch-dir="close">全部折叠</button>
          <a class="btn btn-outline btn-sm" href="/api/export/account_finance.csv" target="_blank">⬇ 导出全账号财务CSV</a>
        </div>
      </div>
      ${accountFinanceByEntHtml}
      ` : `
      <div class="panel-card">
        <div class="panel-head">
          <h3>📑 收支结算 · 因公代扣 · 采购退券冲回 · 保证金流水 ${qTip("alipay_bill_ledger")} ${qTip("refund_deposit_flow")}</h3>
          <button class="btn btn-primary btn-sm" data-open-create="alipay_bills">+ 登记资金流水</button>
        </div>
        <div class="table-wrap">
          <table class="ledger-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>所属主体</th>
                <th>发起账户 & 关联账号</th>
                <th>因公实扣/冲回主户</th>
                <th>资金流向 ${qTip("refund_deposit_flow")}</th>
                <th>业务场景 & 外部凭证槽</th>
                <th>金额 / 手续费</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              ${c.bills.map((b) => `
                <tr>
                  <td class="mono">${esc(b.bill_date)}</td>
                  <td class="mono">${esc(b.entity_code)}</td>
                  <td>
                    <strong>${esc(b.alipay_code)}</strong>
                    ${b.related_platform_account_id ? `<span class="cell-sub"><span class="link-chip mono" data-detail-plat="${esc(b.related_platform_account_id)}">${esc(b.related_account_code)}</span> ${esc(b.related_account_name)}</span>` : ""}
                  </td>
                  <td>${b.master_alipay_name ? `<span class="badge badge-purple">${b.flow_direction === "inflow_purchase_refund" ? "冲回" : "扣"} ${esc(b.master_alipay_code || b.master_alipay_name)}</span>` : `-`}</td>
                  <td>${billDirectionBadge(b.flow_direction, b.flow_direction_label)}</td>
                  <td>
                    ${esc(b.biz_scene)}
                    <span class="cell-sub mono">${esc(b.platform_order_ref || "-")} · ${esc(b.oa_finance_voucher_no || "待接凭证")}</span>
                  </td>
                  <td class="mono">
                    <strong>${fenToYuan(b.amount_fen)}</strong>
                    ${b.fee_fen ? `<span class="cell-sub">扣佣 ${fenToYuan(b.fee_fen)}</span>` : ""}
                  </td>
                  <td><span class="badge ${b.reconcile_status === "matched" ? "badge-green" : "badge-amber"}">${b.reconcile_status === "matched" ? "已核销" : "待核销"}</span></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>`}
    `;
  }

  // ==================== 8. 视图 04：全平台账号矩阵（按平台大类或主体折叠） ====================
  function renderPlatTableRows(rows) {
    return `
      <div class="table-wrap">
        <table class="ledger-table">
          <thead>
            <tr>
              <th>编号 / 账号名称</th>
              <th>平台</th>
              <th>角色 ${qTip("buy_sell_split")}</th>
              <th>开店流程与教程 ${qTip("dual_track_gate")}</th>
              <th>归属执照</th>
              <th>清算通道 & 财务槽 ${qTip("account_finance_slot")}</th>
              <th>绑定手机</th>
              <th>家宽代理 IP ${qTip("proxy_reuse")}</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((p) => {
              const platCase = window.LedgerPortals ? window.LedgerPortals.getCaseForTarget("platform", p.id) : null;
              return `
              <tr class="${(p.proxy_days_left !== null && p.proxy_days_left < 0) || (platCase && platCase.has_rejected) ? "row-danger" : (platCase && platCase.cross_blocked_msg) ? "row-warn" : ""}">
                <td>
                  <strong>${esc(p.display_name)}</strong>
                  <span class="cell-sub mono">${esc(p.account_code)} · 员工:${esc(p.operator_staff || "-")}</span>
                </td>
                <td><span class="badge badge-blue">${esc(p.platform_label)}</span></td>
                <td>${roleBadge(p.account_role)}</td>
                <td>${window.LedgerPortals ? window.LedgerPortals.caseSummaryBadge(platCase) : "-"}</td>
                <td>${p.business_entity_id ? `<span class="link-chip mono" data-detail-entity="${esc(p.business_entity_id)}">${esc(p.entity_code)}</span>` : `<span class="cell-sub">非执照号</span>`}</td>
                <td>
                  ${settlementBadge(p)}
                  <span class="cell-sub">
                    ${p.alipay_account_id ? `<span class="link-chip mono" data-detail-alipay="${esc(p.alipay_account_id)}">${esc(p.alipay_code)}</span>${p.alipay_corporate_pay ? `→${esc(p.alipay_master_code)}` : ""}` : esc(p.merchant_account_no || "零收付")}
                    ${p.deposit_fen ? ` · 保${fenToShortYuan(p.deposit_fen)}` : ""}
                  </span>
                </td>
                <td>${p.bound_sim_id ? `<span class="link-chip mono" data-detail-sim="${esc(p.bound_sim_id)}">📱 ${maskStr(p.bound_phone, "phone")}</span>` : "-"}</td>
                <td>
                  ${p.proxy_ip_id ? `<span class="link-chip mono" data-detail-proxy="${esc(p.proxy_ip_id)}">🌐 ${esc(p.proxy_code)}</span>${p.proxy_days_left <= 7 ? ` <span class="badge badge-red">剩${p.proxy_days_left}天</span>` : ""}` : `<span class="cell-sub">待绑家宽/真机</span>`}
                </td>
                <td>
                  <div class="op-btns">
                    ${platCase ? `<button class="btn btn-primary btn-xs" data-open-wizard="${esc(platCase.id)}">教程</button>` : `<button class="btn btn-outline btn-xs" data-start-author-plat="${esc(p.platform)}">补教程</button>`}
                    <button class="btn btn-outline btn-xs" data-detail-plat="${esc(p.id)}">详情</button>
                    ${state.viewerRole === "boss" ? `<button class="btn btn-outline btn-xs" data-edit-table="platform_accounts" data-edit-id="${esc(p.id)}">编辑</button>` : ""}
                  </div>
                </td>
              </tr>
            `;}).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderPlatformsView(c) {
    const filtered = c.platforms.filter((p) => state.platRole === "ALL" || p.account_role === state.platRole);

    const BUCKETS = [
      { key: "xhs", title: "📕 小红书社媒 & 小红书小店", tip: "social_lead", plats: ["xiaohongshu_mkt", "xiaohongshu_shop"] },
      { key: "wx", title: "💬 微信私域 & 微信小店", tip: "social_lead", plats: ["wechat", "wechat_shop"] },
      { key: "voucher", title: "🎫 虚拟卡券采购专号（大众点评 / 抖音 / 抖省省）", tip: "buy_sell_split", plats: ["dianping", "douyin", "doushengsheng"] },
      { key: "shops", title: "🛍 综合电商网店 & 采购号（抖店 / 淘宝 / 京东）", tip: "virtual_matrix", plats: ["doudian", "taobao_store", "taobao_buyer", "jd_store", "jd_buyer"] },
      { key: "xianyu", title: "🐟 闲鱼店铺矩阵 & 独立买货号", tip: "entity_4shop", plats: ["xianyu"] },
    ];

    let groupsHtml = "";
    let foldIds = [];

    if (state.platGroupBy === "category") {
      foldIds = BUCKETS.map((b) => `plat_grp:${b.key}`);
      groupsHtml = BUCKETS.map((b) => {
        const rows = filtered.filter((p) => b.plats.includes(p.platform));
        if (rows.length === 0) return "";
        const sellN = rows.filter((x) => x.account_role === "sales_only").length;
        const buyN = rows.filter((x) => x.account_role === "purchase_only").length;
        const mktN = rows.filter((x) => x.account_role === "marketing_only").length;
        return renderFoldCard({
          id: `plat_grp:${b.key}`,
          title: `${b.title} (${rows.length})`,
          tipKey: b.tip,
          pillsHtml: `
            ${sellN ? `<span class="badge badge-green">${sellN} 销售店</span>` : ""}
            ${buyN ? `<span class="badge badge-amber">${buyN} 采购买券</span>` : ""}
            ${mktN ? `<span class="badge badge-cyan">${mktN} 社媒引流</span>` : ""}
          `,
          bodyHtml: renderPlatTableRows(rows)
        });
      }).join("");
    } else {
      const ents = [...c.entities.map((e) => ({ id: e.id, title: `🏛 ${e.entity_code} · ${e.entity_name}` })), { id: "", title: "🛒 独立非执照采购号" }];
      foldIds = ents.map((e) => `plat_ent:${e.id || "none"}`);
      groupsHtml = ents.map((e) => {
        const rows = filtered.filter((p) => (p.business_entity_id || "") === e.id);
        if (rows.length === 0) return "";
        return renderFoldCard({
          id: `plat_ent:${e.id || "none"}`,
          title: `${e.title} (${rows.length})`,
          pillsHtml: `<span class="badge badge-blue">共 ${rows.length} 个账号</span>`,
          bodyHtml: renderPlatTableRows(rows)
        });
      }).join("");
    }

    return `
      <div class="page-header">
        <h2>全平台商业账号与小店矩阵 ${qTip("virtual_matrix")}</h2>
        <div class="subtabs">
          <button class="subtab-btn ${state.platGroupBy === "category" ? "active" : ""}" data-plat-grp="category">按平台分组折叠</button>
          <button class="subtab-btn ${state.platGroupBy === "entity" ? "active" : ""}" data-plat-grp="entity">按营业执照折叠</button>
        </div>
      </div>

      <div class="filter-bar">
        <div class="pill-group">
          <button class="pill ${state.platRole === "ALL" ? "active" : ""}" data-plat-role="ALL">全部 (${c.platforms.length})</button>
          <button class="pill ${state.platRole === "sales_only" ? "active" : ""}" data-plat-role="sales_only">🟢 销售店铺</button>
          <button class="pill ${state.platRole === "purchase_only" ? "active" : ""}" data-plat-role="purchase_only">🟠 采购买卡券号</button>
          <button class="pill ${state.platRole === "marketing_only" ? "active" : ""}" data-plat-role="marketing_only">🟣 社媒引流号</button>
        </div>
        <div class="op-btns">
          <button class="btn btn-outline btn-sm" data-batch-fold="${foldIds.join(",")}" data-batch-dir="open">展开全部</button>
          <button class="btn btn-outline btn-sm" data-batch-fold="${foldIds.join(",")}" data-batch-dir="close">全部折叠</button>
          <button class="btn btn-primary btn-sm" data-open-create="platform_accounts">+ 新增平台账号</button>
        </div>
      </div>

      ${groupsHtml}
    `;
  }

  // ==================== 9. 视图 05：家宽代理 IP 与 AdsPower（临期置顶 + 正常池默认折叠） ====================
  function renderProxyTable(rows) {
    return `
      <div class="table-wrap">
        <table class="ledger-table">
          <thead>
            <tr>
              <th>编号</th>
              <th>地区线路</th>
              <th>出口家宽 IP</th>
              <th>到期倒计时</th>
              <th>月费</th>
              <th>跨平台复用情况 ${qTip("proxy_reuse")}</th>
              <th>绑定Ads窗</th>
              <th>操作 ${qTip("proxy_anti_direct")}</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((px) => `
              <tr class="${px.days_left < 0 ? "row-danger" : px.days_left <= 7 ? "row-warn" : ""}">
                <td class="mono"><strong>${esc(px.proxy_code)}</strong></td>
                <td>${esc(px.isp_region)}</td>
                <td class="mono"><strong>${esc(px.exit_ip)}</strong></td>
                <td>${proxyCountdownBadge(px.days_left, px.expires_at)} <span class="cell-sub mono">${esc(px.expires_at)}</span></td>
                <td class="mono">${fenToYuan(px.monthly_cost_fen)}</td>
                <td>
                  <div class="matrix-tags">
                    ${
                      px.reused_accounts.length === 0
                        ? `<span class="badge badge-gray">空闲备用</span>`
                        : px.reused_accounts.slice(0, 2).map((r) => `<span class="badge badge-blue">${esc(r.platform_label)}:${esc(r.display_name)}</span>`).join("") +
                          (px.reused_accounts.length > 2 ? `<span class="badge badge-gray">+${px.reused_accounts.length - 2}个异平台号</span>` : "")
                    }
                  </div>
                </td>
                <td class="mono">${px.bound_window_count} 窗</td>
                <td>
                  <div class="op-btns">
                    <button class="btn btn-success btn-xs" data-renew-proxy="${esc(px.id)}">+续1月</button>
                    <button class="btn btn-outline btn-xs" data-detail-proxy="${esc(px.id)}">穿透</button>
                    <button class="btn btn-outline btn-xs" data-edit-table="proxy_ips" data-edit-id="${esc(px.id)}">编辑</button>
                    <button class="btn btn-danger btn-xs" data-del-table="proxy_ips" data-del-id="${esc(px.id)}">删</button>
                  </div>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderNetworkAdsView(c) {
    const alertPx = c.proxies.filter((p) => p.days_left !== null && p.days_left <= 7).sort((a, b) => a.days_left - b.days_left);
    const okPx = c.proxies.filter((p) => p.days_left === null || p.days_left > 7);
    const hosts = c.devices.filter((d) => d.device_kind === "adspower_pc_host");
    const hostFoldIds = hosts.map((h) => `ads_host:${h.id}`);

    return `
      <div class="page-header">
        <h2>¥10/月家宽代理 IP & AdsPower 指纹窗口 ${qTip("proxy_reuse")} ${qTip("adspower_bind")}</h2>
        <div class="subtabs">
          <button class="subtab-btn ${state.netSubTab === "proxies" ? "active" : ""}" data-net-sub="proxies">🌐 家宽代理 IP (${c.proxies.length})</button>
          <button class="subtab-btn ${state.netSubTab === "adspower" ? "active" : ""}" data-net-sub="adspower">🪟 AdsPower 窗口 (${c.ads.length})</button>
        </div>
      </div>

      ${state.netSubTab === "proxies" ? `
      <div class="filter-bar">
        <div class="op-btns">
          <span class="badge badge-blue">月度总成本 ${fenToYuan(c.proxies.reduce((s, x) => s + x.monthly_cost_fen, 0))}/月</span>
        </div>
        <div class="op-btns">
          <button class="btn btn-outline btn-sm" data-batch-fold="px:alerts,px:healthy" data-batch-dir="open">展开全部</button>
          <button class="btn btn-outline btn-sm" data-batch-fold="px:alerts,px:healthy" data-batch-dir="close">全部折叠</button>
          <button class="btn btn-primary btn-sm" data-open-create="proxy_ips">+ 新增家宽代理</button>
        </div>
      </div>

      ${renderFoldCard({
        id: "px:alerts",
        title: `🚨 7天内临期 / 已过期家宽代理 (${alertPx.length})`,
        variant: alertPx.length ? "danger" : "",
        pillsHtml: alertPx.length ? `<span class="badge badge-red">请优先续费</span>` : `<span class="badge badge-green">无临期</span>`,
        bodyHtml: alertPx.length ? renderProxyTable(alertPx) : `<div class="panel-body">当前无临期或过期家宽代理。</div>`
      })}

      ${renderFoldCard({
        id: "px:healthy",
        title: `✅ 健康在用家宽代理池 (${okPx.length})`,
        tipKey: "proxy_reuse",
        pillsHtml: `<span class="badge badge-green">同平台独占 · 跨平台安全复用</span>`,
        bodyHtml: renderProxyTable(okPx)
      })}
      ` : `
      <div class="filter-bar">
        <span class="badge badge-blue">按电脑宿主机分组折叠</span>
        <div class="op-btns">
          <button class="btn btn-outline btn-sm" data-batch-fold="${hostFoldIds.join(",")}" data-batch-dir="open">展开全部宿主机</button>
          <button class="btn btn-outline btn-sm" data-batch-fold="${hostFoldIds.join(",")}" data-batch-dir="close">全部折叠</button>
          <button class="btn btn-primary btn-sm" data-open-create="adspower_profiles">+ 新增 AdsPower 窗口</button>
        </div>
      </div>

      ${hosts.map((h) => {
        const hWins = c.ads.filter((w) => w.host_device_id === h.id);
        const mh = ((state.boot.cluster_health && state.boot.cluster_health.mac_hosts) || []).find((m) => m.device_id === h.id) || {};
        return renderFoldCard({
          id: `ads_host:${h.id}`,
          title: `🖥 ${h.device_code} · ${h.brand_model} (${hWins.length} 窗 · 槽位 ${mh.occupied_slots ?? hWins.length}/${mh.max_account_quota || 50})`,
          tipKey: "macpro_50_health",
          variant: mh.effective_health_grade === "critical" ? "danger" : mh.effective_health_grade === "warning" ? "warn" : "",
          pillsHtml: `<span class="badge badge-gray">工位：${esc(h.workstation_loc)}</span> <span class="link-chip mono" data-detail-machost="${esc(h.id)}">🩺 64G内存 ${mh.ram_used_gb || 0}G/64G</span>`,
          bodyHtml: `
            <div class="table-wrap">
              <table class="ledger-table">
                <thead>
                  <tr>
                    <th>窗口码 / 序号</th>
                    <th>窗口名称</th>
                    <th>环境隔离</th>
                    <th>绑定家宽代理 IP</th>
                    <th>窗口内登录账号 & Authenticator 衔接 ${qTip("adspower_blind_custody")}</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  ${hWins.map((w) => `
                    <tr>
                      <td class="mono"><strong>${esc(w.profile_code)}</strong> (#${esc(w.ads_serial_no)})</td>
                      <td><strong>${esc(w.window_name)}</strong><span class="cell-sub mono">user_id: ${esc(w.ads_user_id)}</span></td>
                      <td>${roleBadge(w.role_isolation)}</td>
                      <td><span class="link-chip mono" data-detail-proxy="${esc(w.proxy_ip_id)}">🌐 ${esc(w.proxy_code)} (${esc(w.proxy_exit_ip)})</span></td>
                      <td>
                        <div>${w.bound_accounts.map((a) => `<span class="badge badge-blue">${esc(a.platform_label)}:${esc(a.display_name)}</span>`).join(" ") || "-"}</div>
                        <span class="cell-sub" style="color:var(--green);">✓ 已开启免明文密码填充 + AdsPower Authenticator (fakey)</span>
                      </td>
                      <td>
                        <div class="op-btns">
                          <button type="button" class="btn btn-primary btn-xs" data-open-adspower-win="${esc(w.id)}">🚀 启动专窗</button>
                          <button class="btn btn-outline btn-xs" data-edit-table="adspower_profiles" data-edit-id="${esc(w.id)}">编辑</button>
                        </div>
                      </td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          `
        });
      }).join("")}
      `}
    `;
  }

  // ==================== 10. 视图 08：固定资产·设备·负载温度·定位与公司网·插卡 ====================
  function renderDeviceGroupTable(rows) {
    return `
      <div class="table-wrap">
        <table class="ledger-table">
          <thead>
            <tr>
              <th>固定资产码 / 设备</th>
              <th>型号 & 采购原值 ${qTip("asset_retire_guard")}</th>
              <th>负载 & 温度</th>
              <th>📍定位(在司/居家) × 公司网 ${qTip("loc_corp_net_policy")}</th>
              <th>卡槽1 / 卡槽2</th>
              <th>承载账号 / 窗口</th>
              <th>责任人 & 受控协议</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((d) => {
              const lvl = d.loc_net_compliance_level || "green";
              const bCls = lvl === "red" ? "badge-red" : lvl === "blue" ? "badge-blue" : lvl === "amber" ? "badge-amber" : "badge-green";
              const trCls = lvl === "red" || (d.temp_c >= 75) || (d.device_kind !== "adspower_pc_host" && d.temp_c >= 40) ? "row-danger" : "";
              return `
                <tr class="${trCls}">
                  <td class="mono">
                    <strong>${esc(d.asset_no || "-")}</strong>
                    <span class="cell-sub mono">${esc(d.device_code)} · ${d.asset_lifecycle_status === "retired_disposed" ? "已核减退役" : d.asset_lifecycle_status === "standby" ? "在库待派" : "在用中"}</span>
                  </td>
                  <td>
                    <strong>${esc(d.brand_model)}</strong>
                    <span class="cell-sub mono">原值 ${fenToYuan(d.purchase_cost_fen || 0)} · SN:${esc(d.serial_number)}</span>
                  </td>
                  <td class="mono">
                    CPU <strong>${d.cpu_load_pct ?? 15}%</strong> · <strong style="color:${(d.device_kind === "adspower_pc_host" ? d.temp_c >= 75 : d.temp_c >= 40) ? "var(--red-ink)" : "var(--green)"}">🌡${d.temp_c ?? 34}℃</strong>
                    <span class="cell-sub mono">${esc(d.ram_summary_text || "-")}</span>
                  </td>
                  <td>
                    <span class="badge ${bCls}">${esc(d.loc_net_compliance_label || "🟢 在司·已连公司网")}</span>
                    <span class="cell-sub mono">📍${esc(d.geo_location_label || d.workstation_loc)} · ${esc(d.connected_ssid_or_nic || "")}</span>
                  </td>
                  <td>
                    ${d.sim_slot_1_id ? `<span class="link-chip mono" data-detail-sim="${esc(d.sim_slot_1_id)}">📶 ${maskStr(d.slot_1_phone, "phone")}</span>` : `<span class="cell-sub">卡1空</span>`}
                    ${d.sim_slot_2_id ? ` <span class="link-chip mono" data-detail-sim="${esc(d.sim_slot_2_id)}">📶 ${maskStr(d.slot_2_phone, "phone")}</span>` : ""}
                  </td>
                  <td>
                    ${d.hosted_ads_count > 0 ? `<span class="badge badge-blue">${d.hosted_ads_count} 个 AdsPower 窗口</span>` : ""}
                    ${d.app_accounts.slice(0, 2).map((a) => `<span class="badge badge-gray">${esc(a.platform_label)}:${esc(a.display_name)}</span>`).join(" ")}
                    ${d.app_accounts.length > 2 ? `<span class="badge badge-gray">+${d.app_accounts.length - 2}</span>` : ""}
                    ${d.hosted_ads_count === 0 && d.app_accounts.length === 0 ? `<span class="cell-sub">空闲未绑号</span>` : ""}
                  </td>
                  <td>
                    <strong>${esc(d.custodian_staff)}</strong>
                    <span class="cell-sub mono">✓ ${esc(d.control_agreement_no || "已签受控协议")}</span>
                  </td>
                  <td>
                    <div class="op-btns">
                      <button class="btn btn-primary btn-xs" data-detail-device="${esc(d.id)}">资产/定位/核减</button>
                      <button class="btn btn-outline btn-xs" data-edit-table="physical_devices" data-edit-id="${esc(d.id)}">编辑</button>
                    </div>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderDevicesView(c) {
    const hosts = c.devices.filter((d) => d.device_kind === "adspower_pc_host");
    const buyPhones = c.devices.filter((d) => d.device_kind === "procurement_phone");
    const sellPhones = c.devices.filter((d) => d.device_kind !== "adspower_pc_host" && d.device_kind !== "procurement_phone");
    const violDevices = c.devices.filter((d) => d.loc_net_compliance_level === "red" || d.loc_net_compliance_level === "amber");
    const chSum = (state.boot.cluster_health && state.boot.cluster_health.summary) || {};
    const foldIds = ["dev:violations", "dev:hosts", "dev:buy_phones", "dev:sell_phones"];
    if (violDevices.length > 0) state.openFolds.add("dev:violations");

    return `
      <div class="page-header">
        <div>
          <h2>固定资产总账 · 受控设备定位与公司网 · 手机插卡台账 ${qTip("asset_retire_guard")} ${qTip("loc_corp_net_policy")}</h2>
          <span class="cell-sub">固定资产账 + 账号/SIM卡防关联账 + 实时负载/温度/定位(在司vs居家)/公司受控网三账合一；带号带卡严禁报废核减或转二手变卖</span>
        </div>
        <div class="op-btns">
          <button class="btn btn-outline btn-sm" data-jump-view="ads_device_health">🖥 10台Mac Pro机柜视图</button>
          <button class="btn btn-outline btn-sm" data-batch-fold="${foldIds.join(",")}" data-batch-dir="open">展开全部</button>
          <button class="btn btn-outline btn-sm" data-batch-fold="${foldIds.join(",")}" data-batch-dir="close">全部折叠</button>
          <button class="btn btn-primary btn-sm" data-open-create="physical_devices">+ 新增资产设备</button>
        </div>
      </div>

      <div class="stat-strip" style="grid-template-columns: repeat(4, minmax(0, 1fr));">
        <div class="stat-pill-card">
          <div class="stat-pill-top"><span>受控固定资产总数</span>${qTip("asset_retire_guard")}</div>
          <div class="stat-pill-val">
            <strong class="num" style="font-size:18px;">${chSum.total_asset_devices || c.devices.length} 台</strong>
            <span class="badge badge-blue">10台Mac Pro + 15部真机</span>
          </div>
        </div>
        <div class="stat-pill-card">
          <div class="stat-pill-top"><span>硬件采购总原值</span></div>
          <div class="stat-pill-val">
            <strong class="num" style="font-size:18px;">${fenToShortYuan(chSum.total_asset_cost_fen || 0)}</strong>
            <span class="badge badge-gray">残值 ${fenToShortYuan(chSum.total_salvage_value_fen || 0)}</span>
          </div>
        </div>
        <div class="stat-pill-card">
          <div class="stat-pill-top"><span>受控知情协议 & 盘点</span></div>
          <div class="stat-pill-val">
            <strong class="num" style="font-size:18px;">${chSum.agreement_signed_count || c.devices.length}/${chSum.total_asset_devices || c.devices.length} 已签</strong>
            <span class="badge badge-green">账实相符 ${chSum.inventory_verified_count || c.devices.length}台</span>
          </div>
        </div>
        <div class="stat-pill-card">
          <div class="stat-pill-top"><span>📍在岗定位 × 公司网合规</span>${qTip("loc_corp_net_policy")}</div>
          <div class="stat-pill-val">
            <strong class="num" style="font-size:18px;">${chSum.in_office_compliant_count || 0}司 · ${chSum.wfh_compliant_count || 0}家</strong>
            <span class="badge ${(chSum.loc_net_violation_count || 0) ? "badge-red" : "badge-green"}">${(chSum.loc_net_violation_count || 0) ? `🚨 ${chSum.loc_net_violation_count}台违规` : "100%合规"}</span>
          </div>
        </div>
      </div>

      ${violDevices.length > 0 ? renderFoldCard({
        id: "dev:violations",
        title: `🚨 上班时间「定位 × 公司受控网」违规告警设备 (${violDevices.length} 台 · 需立即处置)`,
        tipKey: "loc_corp_net_policy",
        variant: "danger",
        pillsHtml: `<span class="badge badge-red">在公司未连公司网 / 未报备离司</span>`,
        bodyHtml: renderDeviceGroupTable(violDevices)
      }) : ""}

      ${renderFoldCard({
        id: "dev:hosts",
        title: `🖥 10 台 64GB Mac Pro 算力机柜资产 (${hosts.length} 台 · 单价 ¥32,999)`,
        tipKey: "macpro_50_health",
        pillsHtml: `<span class="badge badge-blue">中控机房千兆有线受控内网</span>`,
        bodyHtml: renderDeviceGroupTable(hosts)
      })}

      ${renderFoldCard({
        id: "dev:buy_phones",
        title: `🛒 采购买卡券专用真机资产 (${buyPhones.length} 台)`,
        tipKey: "device_isolation",
        pillsHtml: `<span class="badge badge-amber">连公司采购隔离网 / 报备居家VPN · 禁混登销售店</span>`,
        bodyHtml: renderDeviceGroupTable(buyPhones)
      })}

      ${renderFoldCard({
        id: "dev:sell_phones",
        title: `📱 销售工作手机集群资产 (${sellPhones.length} 台)`,
        pillsHtml: `<span class="badge badge-green">在司强制连 Demo-Office-WiFi 公司网</span>`,
        bodyHtml: renderDeviceGroupTable(sellPhones)
      })}
    `;
  }

  // ==================== 11. 视图 07：手机卡·配额·合约·话费（5段式渐进折叠） ====================
  function renderSimRowsTable(rows) {
    return `
      <div class="table-wrap">
        <table class="ledger-table">
          <thead>
            <tr>
              <th>手机号码</th>
              <th>运营商 / 性质 ${qTip("sim_1m4s")}</th>
              <th>实名人</th>
              <th>插入设备卡槽</th>
              <th>月租 / 话费余额 ${qTip("sim_fee_oa")}</th>
              <th>外部合约倒计时 ${qTip("external_sim")}</th>
              <th>关联对象</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((s) => `
              <tr class="${s.is_low_balance ? "row-danger" : s.is_contract_expiring ? "row-warn" : ""}">
                <td class="mono"><strong>${maskStr(s.phone_number, "phone")}</strong></td>
                <td>${esc(s.carrier)} · ${simCategoryBadge(s.card_category)}</td>
                <td>${esc(s.real_name_holder)}</td>
                <td class="mono">${esc(s.device_slot_label)}</td>
                <td class="mono">
                  ${fenToYuan(s.monthly_rent_fen)}/月 ·
                  <strong style="color:${s.is_low_balance ? "var(--red)" : "var(--green)"}">${s.billing_mode === "shared_master" ? `共享池 ${fenToYuan(s.effective_balance_fen)}` : fenToYuan(s.balance_fen)}</strong>
                </td>
                <td>
                  ${s.is_external ? `<span class="badge ${s.is_contract_expiring ? "badge-amber" : "badge-gray"}">剩 ${s.contract_days_left} 天 (${esc(s.contract_end_date)})</span>` : `<span class="cell-sub">长期自有</span>`}
                </td>
                <td><span class="link-chip" data-detail-sim="${esc(s.id)}">🔗 ${s.bound_count} 个对象</span></td>
                <td>
                  <div class="op-btns">
                    <button class="btn btn-primary btn-xs" data-detail-sim="${esc(s.id)}">详情/充话费/换绑</button>
                    <button class="btn btn-outline btn-xs" data-edit-table="sim_cards" data-edit-id="${esc(s.id)}">编辑</button>
                  </div>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderSimsView(c) {
    const alertSims = c.sims.filter((s) => s.is_low_balance || s.is_contract_expiring);
    const normalSims = c.sims.filter((s) => !s.is_low_balance && !s.is_contract_expiring);
    const allBindings = (state.boot.phone_bindings || []).filter((b) => matchSearch(b));
    const foldIds = ["sim:alerts", "sim:quotas", "sim:normal", "sim:fees", "sim:bindings"];

    return `
      <div class="page-header">
        <h2>手机卡 · 一主4副配额 · 外部合约 · 话费总账 ${qTip("sim_1m4s")} ${qTip("sim_fee_oa")}</h2>
        <div class="op-btns">
          <button class="btn btn-outline btn-sm" data-batch-fold="${foldIds.join(",")}" data-batch-dir="open">展开全部</button>
          <button class="btn btn-outline btn-sm" data-batch-fold="${foldIds.join(",")}" data-batch-dir="close">全部折叠</button>
          <button class="btn btn-primary btn-sm" data-open-create="sim_cards">+ 新增手机卡</button>
        </div>
      </div>

      ${renderFoldCard({
        id: "sim:alerts",
        title: `🚨 话费低余额 & 外部合约临期预警卡 (${alertSims.length})`,
        tipKey: "external_sim",
        variant: alertSims.length ? "danger" : "",
        pillsHtml: alertSims.length ? `<span class="badge badge-red">需充值或提前换绑</span>` : `<span class="badge badge-green">全部正常</span>`,
        bodyHtml: alertSims.length ? renderSimRowsTable(alertSims) : `<div class="panel-body">当前无话费告警或临期外部卡。</div>`
      })}

      ${renderFoldCard({
        id: "sim:quotas",
        title: `🔢 运营商「一主4副」动态占坑配额表 (${c.quotas.length})`,
        tipKey: "sim_1m4s",
        pillsHtml: `<span class="badge badge-blue">5张上限 - 个人原有卡 = 可开上限</span>`,
        actionHtml: `<button class="btn btn-outline btn-xs" data-open-create="carrier_quotas">+ 登记配额</button>`,
        bodyHtml: `
          <div class="table-wrap">
            <table class="ledger-table">
              <thead>
                <tr>
                  <th>实名人</th>
                  <th>运营商</th>
                  <th>法定上限</th>
                  <th>原有个人卡</th>
                  <th>公司最多可开</th>
                  <th>当前已开</th>
                  <th>剩余槽位</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${c.quotas.map((q) => `
                  <tr>
                    <td><strong>${esc(q.holder_name)}</strong></td>
                    <td><span class="badge badge-blue">${esc(q.carrier)}</span></td>
                    <td class="mono">${q.statutory_limit} 张</td>
                    <td class="mono"><strong style="color:var(--amber-ink)">${q.existing_personal_cards} 张</strong></td>
                    <td class="mono"><strong>${q.max_company_openable} 张</strong></td>
                    <td class="mono">${q.opened_company_cards} 张</td>
                    <td>${q.remaining_slots <= 0 ? `<span class="badge badge-amber">已满 · 走外部卡</span>` : `<span class="badge badge-green">余 ${q.remaining_slots} 张</span>`}</td>
                    <td><button class="btn btn-outline btn-xs" data-edit-table="carrier_quotas" data-edit-id="${esc(q.id)}">编辑</button></td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `
      })}

      ${renderFoldCard({
        id: "sim:normal",
        title: `📶 其余正常在用手机卡 (${normalSims.length})`,
        pillsHtml: `<span class="badge badge-green">主副卡池 & 长期外部卡</span>`,
        bodyHtml: renderSimRowsTable(normalSims)
      })}

      ${renderFoldCard({
        id: "sim:fees",
        title: `💰 话费充值与月租扣费流水 (${c.simFees.length})`,
        tipKey: "sim_fee_oa",
        pillsHtml: `<span class="badge badge-gray">OA/钉钉充值单号列已预留</span>`,
        bodyHtml: `
          <div class="table-wrap">
            <table class="ledger-table">
              <thead>
                <tr><th>日期</th><th>手机号</th><th>变动类型</th><th>金额</th><th>变动后余额</th><th>OA预留单号</th><th>备注</th></tr>
              </thead>
              <tbody>
                ${c.simFees.map((f) => `
                  <tr>
                    <td class="mono">${esc(f.occurred_date)}</td>
                    <td class="mono">${maskStr(f.phone_number, "phone")} (${esc(f.carrier)})</td>
                    <td><span class="badge ${f.amount_fen >= 0 ? "badge-green" : "badge-amber"}">${f.change_type === "recharge" ? "话费充值" : "月租扣减"}</span></td>
                    <td class="mono"><strong>${f.amount_fen >= 0 ? "+" : ""}${fenToYuan(f.amount_fen)}</strong></td>
                    <td class="mono">${fenToYuan(f.balance_after_fen)}</td>
                    <td><span class="badge badge-gray">${esc(f.oa_approval_ref)}</span></td>
                    <td>${esc(f.notes)}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `
      })}

      ${renderFoldCard({
        id: "sim:bindings",
        title: `🔗 号码关联对象 N:N 总索引 (${allBindings.length})`,
        tipKey: "external_sim",
        pillsHtml: `<span class="badge badge-gray">税局 · 年报 · 企支 · 全平台账号</span>`,
        bodyHtml: `
          <div class="table-wrap">
            <table class="ledger-table">
              <thead>
                <tr><th>手机号</th><th>平台 / 机构</th><th>关联对象</th><th>承担角色</th><th>换绑紧急度</th></tr>
              </thead>
              <tbody>
                ${allBindings.map((b) => {
                  const sim = state.boot.sim_cards.find((s) => s.id === b.sim_card_id) || {};
                  return `
                    <tr>
                      <td><span class="link-chip mono" data-detail-sim="${esc(b.sim_card_id)}">📱 ${maskStr(sim.phone_number || "", "phone")}</span></td>
                      <td><strong>${esc(b.platform_or_org)}</strong></td>
                      <td>${esc(b.target_name_snapshot)}</td>
                      <td>${esc(b.binding_role)}</td>
                      <td><span class="badge ${b.rebind_priority === "critical" ? "badge-red" : "badge-amber"}">${esc(b.rebind_priority)}</span></td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        `
      })}
    `;
  }

  // ==================== 12. 视图 08：税法与风控规则实测台（清爽条目 + ? 气泡） ====================
  function renderGuardrailsView() {
    const ruleTipMap = {
      RULE_TAX_ENTITY_ISOLATION: "corporate_pay",
      RULE_BUY_SELL_SEGREGATION: "buy_sell_split",
      RULE_PROXY_ONE_PER_PLATFORM: "proxy_reuse",
      RULE_SIM_QUOTA_AND_REBIND: "sim_1m4s",
      RULE_FOUR_TAX_FOUR_ANNUAL: "entity_4shop",
      RULE_MACPRO_50_QUOTA: "macpro_50_health",
      RULE_ASSET_RETIRE_UNBIND: "asset_retire_guard",
    };

    return `
      <div class="page-header">
        <h2>税法与风控硬约束巡检 & 阻断实测台</h2>
      </div>

      <div class="panel-card">
        <div class="panel-head">
          <h3>✅ 7 大核心红线实时巡检状态（点击 ? 查看衍生逻辑）</h3>
        </div>
        <div class="panel-body">
          <div class="alert-list">
            ${(state.boot.guardrails || []).map((g) => `
              <div class="alert-row">
                <div style="display:flex;align-items:center;gap:8px;">
                  <span class="badge ${g.passed ? "badge-green" : "badge-red"}">${g.passed ? "✓ 合规通过" : "✕ 异常"}</span>
                  <strong>${esc(g.title)}</strong>
                  ${qTip(ruleTipMap[g.code] || "mindmap_arch")}
                </div>
                <span class="cell-sub">${esc(g.summary)}</span>
              </div>
            `).join("")}
          </div>
        </div>
      </div>

      <div class="panel-card">
        <div class="panel-head">
          <h3>🧪 模拟违规写入实时阻断演练</h3>
        </div>
        <div class="panel-body" style="display:flex;flex-direction:column;gap:12px;">
          <div class="op-btns" style="flex-wrap:wrap;gap:8px;">
            <button class="btn btn-amber" data-drill="cross_entity_tax">演练1：跨营业执照因公支付串户阻断</button>
            <button class="btn btn-amber" data-drill="buy_sell_mix">演练2：销售支付宝绑买卡券号阻断</button>
            <button class="btn btn-amber" data-drill="same_platform_proxy">演练3：同平台共用家宽IP阻断</button>
            <button class="btn btn-amber" data-drill="delete_active_proxy">演练4：误删在用家宽防直连阻断</button>
            <button class="btn btn-amber" data-drill="carrier_quota_exceed">演练5：超一主4副实名上限阻断</button>
          </div>
          <div id="drill-console" style="background:#0f172a;color:#e2e8f0;padding:13px 16px;border-radius:9px;min-height:110px;font-family:monospace;font-size:12.5px;line-height:1.6;">
            ${
              state.drillLogs.length === 0
                ? `<span style="color:#94a3b8;">点击上方任一演练按钮，向真实后端发起模拟违规请求，验证拦截返回...</span>`
                : state.drillLogs.map((l) => `<div>${esc(l)}</div>`).join("")
            }
          </div>
        </div>
      </div>
    `;
  }

  // ==================== 12B. 视图 09：全量加密密码保险箱 & iPhone 扫码 2FA ====================
  const VAULT_CAT_META = [
    { key: "gov_tax", title: "🏛 电子税务局 & 工商年报公示密码", badge: "税务 / 工商联络员" },
    { key: "alipay", title: "💳 企业支付宝登录密码 & 6位支付盾密 & 子邮箱", badge: "资金核心密钥" },
    { key: "platform", title: "🛍 13类全平台店铺 / 买卡券号 / 社媒密码 & 子号2FA", badge: "经营与提现口令" },
    { key: "network_ads", title: "🌐 AdsPower 超管总控 & 家宽代理总后台 / SOCKS5密钥", badge: "环境与网络底层" },
    { key: "device_sim", title: "📱 实体手机锁屏/Apple&小米云ID & 手机卡6位服务密码", badge: "硬件与运营商PIN" },
  ];

  function renderVaultSecretRowActions(v) {
    const unlocked = isVaultUnlocked();
    const sec = state.revealedSecrets[v.id];
    const syncBtn = v.adspower_profile_id
      ? `<button type="button" class="btn btn-outline btn-xs" data-sync-adspower-cred="${esc(v.id)}" data-ads-profile-id="${esc(v.adspower_profile_id)}" title="将密文解密后直接推送至 AdsPower 自动填充与 Authenticator fakey（员工免明文）">🔄 同步Ads</button>`
      : "";
    if (!unlocked) {
      return `
        <div class="op-btns">
          <button type="button" class="btn btn-amber btn-xs" data-vault-reveal="${esc(v.id)}">🔓 扫码解锁查看</button>
          ${syncBtn}
        </div>
      `;
    }
    return `
      <div class="op-btns">
        ${
          sec
            ? `<button type="button" class="btn btn-outline btn-xs" data-vault-hide="${esc(v.id)}">🙈 隐藏</button>`
            : `<button type="button" class="btn btn-primary btn-xs" data-vault-reveal="${esc(v.id)}">👁 显密</button>`
        }
        ${v.has_login_pwd ? `<button type="button" class="btn btn-outline btn-xs" data-vault-copy="${esc(v.id)}" data-copy-field="login_password">📋 登录密</button>` : ""}
        ${v.has_secondary_pwd ? `<button type="button" class="btn btn-outline btn-xs" data-vault-copy="${esc(v.id)}" data-copy-field="secondary_password">📋 二级密</button>` : ""}
        ${syncBtn}
        <button type="button" class="btn btn-outline btn-xs" data-vault-edit="${esc(v.id)}">编辑</button>
      </div>
    `;
  }

  function renderVaultRowsTable(rows) {
    const unlocked = isVaultUnlocked();
    return `
      <div class="table-wrap">
        <table class="ledger-table">
          <thead>
            <tr>
              <th>业务对象 / 员工受限领用</th>
              <th>登录账号 / ID</th>
              <th>登录密码 ${qTip("vault_envelope")}</th>
              <th>二级密码 / 支付盾密</th>
              <th>AdsPower & Authenticator ${qTip("adspower_blind_custody")}</th>
              <th>最近轮换</th>
              <th>操作 ${qTip("vault_2fa")}</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((v) => {
              const sec = unlocked ? state.revealedSecrets[v.id] : null;
              return `
                <tr>
                  <td>
                    <strong>${esc(v.title)}</strong>
                    <span class="cell-sub">
                      ${v.assigned_staff ? `<span class="badge badge-green">员工免明文授权：${esc(v.assigned_staff)}</span>` : `<span class="badge badge-gray">仅老板可见</span>`}
                    </span>
                    ${sec && sec.recovery_note ? `<span class="cell-sub" style="color:var(--blue-dark);">📝 ${esc(sec.recovery_note)}</span>` : ""}
                  </td>
                  <td class="mono">
                    <strong>${esc(v.login_account)}</strong>
                    <button type="button" class="btn btn-ghost btn-xs" data-copy-raw="${esc(v.login_account)}" title="复制账号">复制</button>
                  </td>
                  <td class="mono">
                    ${
                      sec
                        ? `<span class="secret-pill"><code>${esc(sec.login_password || "-")}</code></span>`
                        : `<span class="cell-sub mono">••••••••••</span>`
                    }
                  </td>
                  <td class="mono">
                    <span class="cell-sub">${esc(v.secondary_label)}：</span>
                    ${
                      !v.has_secondary_pwd
                        ? `<span class="cell-sub">-</span>`
                        : sec
                        ? `<span class="secret-pill"><code>${esc(sec.secondary_password)}</code></span>`
                        : `<span class="cell-sub mono">••••••</span>`
                    }
                  </td>
                  <td class="mono">
                    ${
                      v.adspower_sync_status === "synced"
                        ? `<span class="badge badge-blue">✓ Ads自动填充+fakey</span> `
                        : ""
                    }
                    ${
                      !(v.has_sub_totp || v.has_totp)
                        ? `<span class="cell-sub">-</span>`
                        : sec && sec.sub_totp_code
                        ? `<span class="badge badge-purple mono" title="剩余 ${sec.sub_totp_seconds_left} 秒刷新">🔢 ${esc(sec.sub_totp_code)}</span>`
                        : `<span class="badge badge-purple">托管Authenticator</span>`
                    }
                  </td>
                  <td class="mono">${esc(v.password_rotated_at)}</td>
                  <td>${renderVaultSecretRowActions(v)}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderVaultView(c) {
    const vMeta = state.boot.vault || { total_count: 0, audit_logs: [] };
    const items = c.vaultItems || [];
    const unlocked = isVaultUnlocked();
    const foldIds = [...VAULT_CAT_META.map((m) => `vault:${m.key}`), "vault:audit"];

    const catFoldsHtml = VAULT_CAT_META.map((m) => {
      const rows = items.filter((x) => x.category === m.key);
      if (rows.length === 0) return "";
      const subTotpCnt = rows.filter((x) => x.has_sub_totp).length;
      return renderFoldCard({
        id: `vault:${m.key}`,
        title: `${m.title} (${rows.length})`,
        pillsHtml: `
          <span class="badge badge-blue">${esc(m.badge)}</span>
          ${subTotpCnt ? `<span class="badge badge-purple">含 ${subTotpCnt} 个子号2FA动态码</span>` : ""}
        `,
        bodyHtml: renderVaultRowsTable(rows)
      });
    }).join("");

    const logs = vMeta.audit_logs || [];
    const auditFoldHtml = renderFoldCard({
      id: "vault:audit",
      title: `📜 密码解锁与单条解密安全审计日志 (最近 ${logs.length} 条)`,
      tipKey: "vault_envelope",
      pillsHtml: `<span class="badge badge-gray">防内鬼 · 留痕审计</span>`,
      bodyHtml: `
        <div class="table-wrap">
          <table class="ledger-table">
            <thead>
              <tr><th>时间</th><th>安全动作</th><th>验证方式</th><th>访问目标</th><th>终端IP</th><th>审计摘要</th></tr>
            </thead>
            <tbody>
              ${logs.map((lg) => `
                <tr>
                  <td class="mono">${esc(lg.occurred_at)}</td>
                  <td><span class="badge ${lg.action.includes("FAIL") ? "badge-red" : lg.action === "REVEAL_SECRET" ? "badge-amber" : "badge-blue"}">${esc(lg.action)}</span></td>
                  <td>${esc(lg.auth_method)}</td>
                  <td><strong>${esc(lg.target_title)}</strong></td>
                  <td class="mono">${esc(lg.client_ip)}</td>
                  <td>${esc(lg.detail)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `
    });

    return `
      <div class="page-header">
        <h2>全量加密密码保险箱 & iPhone 扫码验证 ${qTip("vault_2fa")} ${qTip("vault_envelope")}</h2>
        <div class="op-btns">
          ${
            unlocked
              ? `<button type="button" class="btn btn-amber btn-sm" id="btn-vault-lock-page">🔒 立即销毁令牌上锁 (${formatMMSS(state.vaultTimerSec)})</button>`
              : `<button type="button" class="btn btn-primary btn-sm" data-open-vault-modal="1">📱 iPhone 扫码 / 动态码解锁</button>`
          }
          <button type="button" class="btn btn-outline btn-sm" data-open-vault-modal="setup">⚙ 绑定 iPhone / 二维码设置</button>
          <button type="button" class="btn btn-outline btn-sm" data-batch-fold="${foldIds.join(",")}" data-batch-dir="open">展开全部</button>
          <button type="button" class="btn btn-outline btn-sm" data-batch-fold="${foldIds.join(",")}" data-batch-dir="close">全部折叠</button>
          <button type="button" class="btn btn-primary btn-sm" data-vault-create="1">+ 新增加密密码</button>
        </div>
      </div>

      <div class="stat-strip" style="grid-template-columns: repeat(4, minmax(0, 1fr));">
        <div class="stat-pill-card">
          <div class="stat-pill-top"><span>加密托管总条目</span>${qTip("vault_envelope")}</div>
          <div class="stat-pill-val"><strong class="num">${items.length}</strong><span class="badge badge-blue">ENCv1 认证密文</span></div>
        </div>
        <div class="stat-pill-card" data-open-vault-modal="1">
          <div class="stat-pill-top"><span>当前保险箱状态</span>${qTip("vault_2fa")}</div>
          <div class="stat-pill-val">
            <strong class="num" style="font-size:17px;color:${unlocked ? "var(--green)" : "var(--amber-ink)"};">${unlocked ? `🔓 已解锁 ${formatMMSS(state.vaultTimerSec)}` : "🔒 安全锁定中"}</strong>
            <span class="badge ${unlocked ? "badge-green" : "badge-amber"}">${unlocked ? esc(state.vaultAuthMethod || "二次验证通过") : "点此扫码解锁"}</span>
          </div>
        </div>
        <div class="stat-pill-card" data-open-vault-modal="setup">
          <div class="stat-pill-top"><span>iPhone 密码App / Authenticator</span></div>
          <div class="stat-pill-val">
            <strong class="num" style="font-size:16px;">RFC 6238</strong>
            <span class="badge ${vMeta.is_demo_mode ? "badge-amber" : "badge-green"}">${vMeta.is_demo_mode ? "待首次扫码锁定" : "✓ 已绑生产设备"}</span>
          </div>
        </div>
        <div class="stat-pill-card" data-open-vault-modal="passkey">
          <div class="stat-pill-top"><span>iPhone 扫码刷脸 / Passkey</span></div>
          <div class="stat-pill-val">
            <strong class="num" style="font-size:16px;">WebAuthn</strong>
            <span class="badge ${vMeta.webauthn_bound ? "badge-green" : "badge-purple"}">${vMeta.webauthn_bound ? "✓ 已绑通行密钥" : "支持扫码注册"}</span>
          </div>
        </div>
      </div>

      ${catFoldsHtml}
      ${auditFoldHtml}
    `;
  }

  function renderCurrentView() {
    if (!state.boot) return;
    const container = document.getElementById("view-container");
    const c = getFilteredCollections();
    const P = window.LedgerPortals;
    const G = window.LedgerGovernance;
    const H = window.LedgerHealth;
    if (state.view === "overview") container.innerHTML = renderOverview(c);
    else if (state.view === "ads_device_health" && H) container.innerHTML = H.renderAdsDeviceHealthView();
    else if (state.view === "gov_hub" && G) container.innerHTML = G.renderBossAndGmGovHub();
    else if (state.view === "gov_kpi_okr" && G) container.innerHTML = G.renderGovKpiOkrView();
    else if (state.view === "gov_wiki_video" && G) container.innerHTML = G.renderGovWikiVideoView();
    else if (state.view === "gov_sup_my" && G) container.innerHTML = G.renderSupervisorMyGovView(false);
    else if (state.view === "gov_sup_published" && G) container.innerHTML = G.renderSupervisorMyGovView(true);
    else if (state.view === "onboarding_hub" && P) container.innerHTML = P.renderBossOnboardingHub();
    else if (state.view === "sup_reviews" && P) container.innerHTML = P.renderSupervisorReviewsView();
    else if (state.view === "sup_authoring" && P) container.innerHTML = P.renderSupervisorAuthoringView();
    else if (state.view === "sup_dispatch" && P) container.innerHTML = P.renderSupervisorDispatchView();
    else if (state.view === "emp_tasks" && P) container.innerHTML = P.renderEmployeeTasksView();
    else if (state.view === "emp_adspower" && P) container.innerHTML = P.renderEmployeeAdsPowerView();
    else if (state.view === "entities") container.innerHTML = renderEntitiesView(c);
    else if (state.view === "alipay") container.innerHTML = renderAlipayView(c);
    else if (state.view === "platforms") container.innerHTML = renderPlatformsView(c);
    else if (state.view === "network_ads") container.innerHTML = renderNetworkAdsView(c);
    else if (state.view === "devices") container.innerHTML = renderDevicesView(c);
    else if (state.view === "sims") container.innerHTML = renderSimsView(c);
    else if (state.view === "guardrails") container.innerHTML = renderGuardrailsView();
    else if (state.view === "vault") container.innerHTML = renderVaultView(c);
  }

  // ==================== 13. 「?」悬浮气泡定位与交互引擎 + 全站词典抽屉 ====================
  let pinnedTipBtn = null;
  let hoverHideTimer = null;

  function showQTipPopover(btnEl, pin = false) {
    const key = btnEl.dataset.tip;
    const item = TIP_DICT[key];
    if (!item) return;

    clearTimeout(hoverHideTimer);
    if (pinnedTipBtn && pinnedTipBtn !== btnEl) {
      pinnedTipBtn.classList.remove("active");
    }
    if (pin) {
      pinnedTipBtn = btnEl;
      btnEl.classList.add("active");
    }

    const pop = document.getElementById("qtip-popover");
    pop.innerHTML = `
      <div class="qtip-head">
        <span class="badge badge-blue">💡 ${esc(item.cat)}</span>
        <button type="button" class="qtip-close" id="qtip-close-btn" title="关闭">✕</button>
      </div>
      <h4 class="qtip-title">${esc(item.title)}</h4>
      <div class="qtip-sec-label">📌 名词定义</div>
      <p class="qtip-def">${esc(item.def)}</p>
      <div class="qtip-sec-label">🔗 衍生业务逻辑（为什么这么管）</div>
      <ul class="qtip-list">
        ${item.logic.map((li) => `<li>${esc(li)}</li>`).join("")}
      </ul>
      <div class="qtip-guard">🛡 台账防呆约束：${esc(item.guard)}</div>
    `;
    pop.classList.remove("hidden");

    // 自适应窗口边缘防溢出定位
    const rect = btnEl.getBoundingClientRect();
    const popW = 390;
    const popH = pop.offsetHeight || 280;
    let left = rect.left + 22;
    let top = rect.bottom + 8;

    if (left + popW > window.innerWidth - 16) {
      left = Math.max(16, rect.right - popW);
    }
    if (top + popH > window.innerHeight - 16) {
      top = Math.max(16, rect.top - popH - 8);
    }
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;

    const closeBtn = document.getElementById("qtip-close-btn");
    if (closeBtn) closeBtn.onclick = hideQTipPopover;
  }

  function hideQTipPopover() {
    clearTimeout(hoverHideTimer);
    if (pinnedTipBtn) {
      pinnedTipBtn.classList.remove("active");
      pinnedTipBtn = null;
    }
    document.getElementById("qtip-popover").classList.add("hidden");
  }

  function openGlossaryDrawer() {
    const entries = Object.entries(TIP_DICT);
    const html = `
      <p style="margin:0;color:var(--ink-muted);font-size:12.5px;">点击任意词条即可展开查看定义、衍生业务链条与系统硬约束（页面各处的小问号 <b>?</b> 均可随时悬停或点击查阅）：</p>
      ${entries.map(([k, item], idx) => `
        <details class="panel-card" ${idx < 2 ? "open" : ""} style="padding:0;">
          <summary style="padding:11px 15px;cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:space-between;list-style:none;">
            <span><span class="badge badge-blue" style="margin-right:6px;">${esc(item.cat)}</span> ${esc(item.title)}</span>
            <span style="color:var(--ink-muted);font-size:11.5px;">展开 ▾</span>
          </summary>
          <div style="padding:12px 16px;border-top:1px solid var(--border-light);background:#fafcff;">
            <p class="qtip-def"><strong>定义：</strong>${esc(item.def)}</p>
            <ul class="qtip-list" style="margin-top:8px;">
              ${item.logic.map((li) => `<li>${esc(li)}</li>`).join("")}
            </ul>
            <div class="qtip-guard">${esc(item.guard)}</div>
          </div>
        </details>
      `).join("")}
    `;
    openDrawer("名词与衍生逻辑词典", `全站业务名词与防关联/税法逻辑说明 (${entries.length} 项)`, html);
  }

  // ==================== 14. 右侧穿透详情抽屉 & 全表 CRUD 表单 ====================
  let currentDrawerRerender = null;

  function openDrawer(tagText, titleText, bodyHtml, footerHtml = "", onRerender = null) {
    currentDrawerRerender = onRerender;
    document.getElementById("drawer-tag").textContent = tagText;
    document.getElementById("drawer-title").textContent = titleText;
    document.getElementById("drawer-body").innerHTML = bodyHtml;
    const f = document.getElementById("drawer-footer");
    if (footerHtml) {
      f.innerHTML = footerHtml;
      f.classList.remove("hidden");
    } else {
      f.innerHTML = "";
      f.classList.add("hidden");
    }
    document.getElementById("drawer-backdrop").classList.remove("hidden");
    document.getElementById("drawer-panel").classList.remove("hidden");
  }

  function closeDrawer() {
    currentDrawerRerender = null;
    document.getElementById("drawer-backdrop").classList.add("hidden");
    document.getElementById("drawer-panel").classList.add("hidden");
  }

  function renderRelatedVaultCard(targetPairs, presetNew = null) {
    const allVault = (state.boot.vault && state.boot.vault.items) || [];
    const matched = allVault.filter((v) =>
      targetPairs.some(([tbl, id]) => id && v.target_table === tbl && v.target_id === id)
    );
    const unlocked = isVaultUnlocked();

    return `
      <div class="panel-card">
        <div class="panel-head">
          <h3>🔐 关联加密账号与密码 (${matched.length}) ${qTip("vault_2fa")}</h3>
          <div class="op-btns">
            ${
              presetNew
                ? `<button type="button" class="btn btn-outline btn-xs" data-vault-create-preset='${esc(JSON.stringify(presetNew))}'>+ 补录加密密码</button>`
                : ""
            }
          </div>
        </div>
        ${
          matched.length === 0
            ? `<div class="panel-body"><span class="cell-sub">当前对象暂未录入独立密码条目，可点击右上角「+ 补录加密密码」。</span></div>`
            : `
              <div class="table-wrap">
                <table class="ledger-table">
                  <thead>
                    <tr><th>条目</th><th>登录账号</th><th>登录密 / 二级密</th><th>操作</th></tr>
                  </thead>
                  <tbody>
                    ${matched.map((v) => {
                      const sec = unlocked ? state.revealedSecrets[v.id] : null;
                      return `
                        <tr>
                          <td>
                            <strong>${esc(v.title)}</strong>
                            ${sec && sec.recovery_note ? `<span class="cell-sub" style="color:var(--blue-dark);">📝 ${esc(sec.recovery_note)}</span>` : ""}
                          </td>
                          <td class="mono">${esc(v.login_account)}</td>
                          <td class="mono">
                            ${
                              sec
                                ? `<span class="secret-pill"><code>${esc(sec.login_password || "-")}</code></span>` +
                                  (sec.secondary_password ? ` <span class="badge badge-gray">${esc(v.secondary_label)}: ${esc(sec.secondary_password)}</span>` : "") +
                                  (sec.sub_totp_code ? ` <span class="badge badge-purple">2FA: ${esc(sec.sub_totp_code)}</span>` : "")
                                : `<span class="cell-sub mono">•••••••• (加密保护)</span>`
                            }
                          </td>
                          <td>${renderVaultSecretRowActions(v)}</td>
                        </tr>
                      `;
                    }).join("")}
                  </tbody>
                </table>
              </div>
            `
        }
      </div>
    `;
  }

  function openPlatDetailDrawer(platId) {
    const p = state.boot.platform_accounts.find((x) => x.id === platId);
    if (!p) return;
    const chLabels = (state.boot.meta && state.boot.meta.settlement_channel_labels) || {};
    const relBills = (state.boot.alipay_bills || []).filter((b) => b.related_platform_account_id === p.id);
    const platCase = window.LedgerPortals ? window.LedgerPortals.getCaseForTarget("platform", p.id) : null;
    const html = `
      <div class="panel-card" style="border-color:var(--blue-border);background:#f8fbff;">
        <div class="panel-head">
          <h3>📖 本店开店流程节点与手把手教程 ${qTip("dual_track_gate")}</h3>
          ${window.LedgerPortals ? window.LedgerPortals.caseSummaryBadge(platCase) : ""}
        </div>
        <div class="panel-body" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
          ${platCase ? `
            <div>
              <strong>当前进行至：${esc(platCase.current_step_code || "全部完成")} ${esc(platCase.current_step_title || "")}</strong>
              <span class="cell-sub">${esc(platCase.cross_blocked_msg || platCase.notes || "点击右侧打开完整 18 步建店轨道、防呆红线与历史材料")}</span>
            </div>
            <button type="button" class="btn btn-primary btn-sm" data-open-wizard="${esc(platCase.id)}">👉 打开本店全流程步进教程 (${platCase.done_steps}/${platCase.total_steps})</button>
          ` : `
            <div>
              <strong>⚠️ 当前平台（${esc(p.platform_label)}）尚未绑定已上线的开店教程实例</strong>
              <span class="cell-sub">可切换至主管端编写/发布本平台标准教程后再派单跟进</span>
            </div>
            <button type="button" class="btn btn-amber btn-sm" data-start-author-plat="${esc(p.platform)}">🧭 去主管端补齐 ${esc(p.platform_label)} 教程</button>
          `}
        </div>
      </div>

      <div class="kv-grid">
        <div class="kv-item"><label>编号 / 所属平台</label><div>${esc(p.account_code)} · <span class="badge badge-blue">${esc(p.platform_label)}</span></div></div>
        <div class="kv-item"><label>买卖角色隔离</label><div>${roleBadge(p.account_role)}</div></div>
        <div class="kv-item"><label>店铺/账号名 & 登录ID</label><div>${esc(p.display_name)} (${esc(p.platform_login_id)})</div></div>
        <div class="kv-item"><label>归属营业执照</label><div>${p.entity_code ? `${esc(p.entity_code)} · ${esc(p.entity_name)}` : "独立个人/采购号"}</div></div>
        <div class="kv-item"><label>关联企业支付宝</label><div>${p.alipay_code ? `${esc(p.alipay_code)} (${p.alipay_corporate_pay ? `因公扣主户 ${p.alipay_master_code}` : "销售结算"})` : "不直连支付宝"}</div></div>
        <div class="kv-item"><label>绑定手机号</label><div class="mono">${p.bound_phone ? maskStr(p.bound_phone, "phone") : "-"}</div></div>
        <div class="kv-item"><label>家宽代理 IP</label><div class="mono">${p.proxy_code ? `${esc(p.proxy_code)} (${esc(p.proxy_exit_ip)} · 剩${p.proxy_days_left}天)` : "纯真机流量"}</div></div>
        <div class="kv-item"><label>AdsPower窗口 / 64G宿主机 / 真机</label><div>${p.ads_profile_code ? `${esc(p.ads_profile_code)}(#${esc(p.ads_serial_no)})` : "无窗口"} ${p.ads_host_id ? `· <span class="link-chip mono" data-detail-machost="${esc(p.ads_host_id)}">🖥 ${esc(p.ads_host_code)}</span>` : ""} / ${esc(p.device_code || "-")}</div></div>
        <div class="kv-item"><label>虚拟产品业务用途</label><div>${esc(p.virtual_biz_usage || "-")}</div></div>
        <div class="kv-item"><label>社媒导流目标小店</label><div>${esc(p.lead_target_name || "无")}</div></div>
        <div class="kv-item"><label>运营频控 / 负责员工</label><div>${esc(p.daily_quota_note || "-")} · ${esc(p.operator_staff || "-")}</div></div>
        <div class="kv-item"><label>当前状态</label><div><span class="badge ${p.account_status === "active" ? "badge-green" : "badge-amber"}">${esc(p.account_status)}</span></div></div>
      </div>

      <div class="panel-card">
        <div class="panel-head">
          <h3>💰 账号专属财务结算与损益预留槽 ${qTip("account_finance_slot")}</h3>
          ${settlementBadge(p)}
        </div>
        <div class="panel-body">
          <div class="kv-grid">
            <div class="kv-item"><label>底层清算/扣款通道</label><div><strong>${esc(p.settlement_channel_label || p.settlement_channel)}</strong></div></div>
            <div class="kv-item"><label>商户号 / 聚合钱包槽</label><div class="mono">${esc(p.merchant_account_no || "预留待绑定")}</div></div>
            <div class="kv-item"><label>提现落账银行卡/资金池</label><div>${esc(p.settlement_bank_ref || "预留待绑定")}</div></div>
            <div class="kv-item"><label>结算账期规则</label><div>${esc(p.settlement_cycle || "-")}</div></div>
            <div class="kv-item"><label>平台技术服务费/佣金率</label><div class="mono">${p.commission_rate_bps ? `${(p.commission_rate_bps / 100).toFixed(2)}% (${p.commission_rate_bps} bps)` : "0% (无平台扣佣)"}</div></div>
            <div class="kv-item"><label>税票与进销项口径</label><div>${esc(p.tax_invoice_mode || "-")}</div></div>
            <div class="kv-item"><label>店铺保证金 & 原路退保户</label><div class="mono">${fenToYuan(p.deposit_fen)} · <span class="cell-sub" style="display:inline">${esc(p.deposit_source_ref || "-")}</span></div></div>
            <div class="kv-item"><label>平台在途/纠纷冻结余额</label><div class="mono">${fenToYuan(p.frozen_balance_fen || 0)}</div></div>
            <div class="kv-item"><label>当月销项GMV / 采购成本</label><div class="mono">${fenToYuan(p.month_gmv_fen || 0)} / ${fenToYuan(p.month_cost_fen || 0)}</div></div>
            <div class="kv-item"><label>当月退单冲回 / 预估扣佣</label><div class="mono">${fenToYuan(p.month_refund_fen || 0)} / ${fenToYuan(p.estimated_fee_fen || 0)}</div></div>
            <div class="kv-item"><label>${p.account_role === "purchase_only" ? "当月净采购支出" : "当月预估净毛利(10%提成基数)"}</label><div class="mono"><strong style="color:var(--green)">${fenToYuan(p.account_role === "purchase_only" ? (p.net_purchase_fen || 0) : (p.net_margin_fen || 0))}</strong></div></div>
            <div class="kv-item"><label>ERP/金蝶科目 & OA映射槽</label><div class="mono">${esc(p.finance_book_code || "待映射")}</div></div>
          </div>

          <details style="margin-top:12px;border-top:1px dashed var(--border);padding-top:10px;">
            <summary style="cursor:pointer;font-weight:600;color:var(--blue);">⚙️ 展开快捷维护本账号财务结算与 ERP 预留参数</summary>
            <div class="form-grid" style="margin-top:10px;">
              <div class="form-field">
                <label>清算/扣款通道</label>
                <select id="qfin-channel" class="select-control">
                  ${Object.entries(chLabels).map(([k, v]) => `<option value="${esc(k)}" ${p.settlement_channel === k ? "selected" : ""}>${esc(v)}</option>`).join("")}
                </select>
              </div>
              <div class="form-field">
                <label>商户号 / mch_id 槽位</label>
                <input id="qfin-mch" class="input-control mono" value="${esc(p.merchant_account_no || "")}" />
              </div>
              <div class="form-field">
                <label>提现落账银行卡 / 主资金池</label>
                <input id="qfin-bank" class="input-control" value="${esc(p.settlement_bank_ref || "")}" />
              </div>
              <div class="form-field">
                <label>结算账期规则</label>
                <input id="qfin-cycle" class="input-control" value="${esc(p.settlement_cycle || "")}" />
              </div>
              <div class="form-field">
                <label>佣金率万分比 (60=0.6%, 160=1.6%)</label>
                <input id="qfin-bps" type="number" class="input-control mono" value="${p.commission_rate_bps || 0}" />
              </div>
              <div class="form-field">
                <label>保证金(分) & 原路退保账户</label>
                <div class="op-btns">
                  <input id="qfin-dep" type="number" class="input-control mono" style="width:110px" value="${p.deposit_fen || 0}" />
                  <input id="qfin-depsrc" class="input-control" style="flex:1" value="${esc(p.deposit_source_ref || "")}" placeholder="原路出资/退保户" />
                </div>
              </div>
              <div class="form-field">
                <label>税票与计税口径</label>
                <input id="qfin-tax" class="input-control" value="${esc(p.tax_invoice_mode || "")}" />
              </div>
              <div class="form-field">
                <label>ERP/金蝶科目 & OA映射编码</label>
                <input id="qfin-book" class="input-control mono" value="${esc(p.finance_book_code || "")}" />
              </div>
              <div class="form-field span-2" style="text-align:right;">
                <button type="button" class="btn btn-primary btn-sm" id="btn-save-qfin">💾 保存本账号财务预留配置</button>
              </div>
            </div>
          </details>
        </div>
      </div>

      ${relBills.length > 0 ? `
      <details class="panel-card">
        <summary style="padding:11px 16px;cursor:pointer;font-weight:700;">📑 本账号关联资金/退券/保证金流水 (${relBills.length})</summary>
        <div class="table-wrap">
          <table class="ledger-table">
            <thead><tr><th>日期</th><th>流向</th><th>场景</th><th>金额</th></tr></thead>
            <tbody>
              ${relBills.map((b) => `
                <tr>
                  <td class="mono">${esc(b.bill_date)}</td>
                  <td>${billDirectionBadge(b.flow_direction, b.flow_direction_label)}</td>
                  <td>${esc(b.biz_scene)}</td>
                  <td class="mono">${fenToYuan(b.amount_fen)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </details>` : ""}

      ${renderRelatedVaultCard([["platform_accounts", p.id]], {
        category: "platform",
        legal_person_id: p.legal_person_id,
        target_table: "platform_accounts",
        target_id: p.id,
        title: `${p.account_code} · ${p.display_name}`,
        login_account: p.platform_login_id
      })}
    `;
    const footer = `
      <button class="btn btn-danger" id="btn-plat-del">删除账号</button>
      <button class="btn btn-primary" id="btn-plat-edit">全字段编辑</button>
    `;
    openDrawer("平台账号与专属财务槽", `${p.platform_label} · ${p.display_name}`, html, footer, () => openPlatDetailDrawer(platId));
    document.getElementById("btn-plat-edit").onclick = () => openRecordFormDrawer("platform_accounts", p);
    const btnQfin = document.getElementById("btn-save-qfin");
    if (btnQfin) {
      btnQfin.onclick = async () => {
        try {
          await apiCall(`/api/records/platform_accounts/${p.id}`, "PUT", {
            settlement_channel: document.getElementById("qfin-channel").value,
            merchant_account_no: document.getElementById("qfin-mch").value,
            settlement_bank_ref: document.getElementById("qfin-bank").value,
            settlement_cycle: document.getElementById("qfin-cycle").value,
            commission_rate_bps: Number(document.getElementById("qfin-bps").value || 0),
            deposit_fen: Number(document.getElementById("qfin-dep").value || 0),
            deposit_source_ref: document.getElementById("qfin-depsrc").value,
            tax_invoice_mode: document.getElementById("qfin-tax").value,
            finance_book_code: document.getElementById("qfin-book").value,
          });
          toast("已更新该账号的财务结算预留配置", "success");
          await reloadData();
          openPlatDetailDrawer(p.id);
        } catch (err) {
          toast("⛔ " + err.message, "error");
        }
      };
    }
    document.getElementById("btn-plat-del").onclick = async () => {
      if (!window.confirm("确认删除该平台账号吗？")) return;
      try {
        await apiCall(`/api/records/platform_accounts/${p.id}`, "DELETE");
        toast("已删除平台账号", "success");
        closeDrawer();
        await reloadData();
      } catch (err) {
        toast(err.message, "error");
      }
    };
  }

  function openDeviceDetailDrawer(devId) {
    const d = state.boot.physical_devices.find((x) => x.id === devId);
    if (!d) return;
    const lvl = d.loc_net_compliance_level || "green";
    const bCls = lvl === "red" ? "badge-red" : lvl === "blue" ? "badge-blue" : lvl === "amber" ? "badge-amber" : "badge-green";
    const html = `
      <div class="kv-grid">
        <div class="kv-item"><label>固定资产编号 / 设备码</label><div class="mono"><strong>${esc(d.asset_no || "-")}</strong> · ${esc(d.device_code)}</div></div>
        <div class="kv-item"><label>品牌型号 & SN序列号</label><div><strong>${esc(d.brand_model)}</strong> <span class="cell-sub mono" style="display:inline">(${esc(d.serial_number)})</span></div></div>
        <div class="kv-item"><label>采购原值 / 采购单号</label><div class="mono">${fenToYuan(d.purchase_cost_fen || 0)} · ${esc(d.purchase_order_no || "-")} (${esc(d.purchase_date || "-")})</div></div>
        <div class="kv-item"><label>受控设备协议 & 盘点状态</label><div>✓ ${esc(d.control_agreement_no || "已签")} (${esc(d.agreement_signed_by || d.custodian_staff)}) · 盘点:${esc(d.last_inventory_date || "-")}</div></div>
        <div class="kv-item"><label>实时负载 & 机身/芯片温度</label><div class="mono">CPU <strong>${d.cpu_load_pct ?? 15}%</strong> (${esc(d.ram_summary_text || "-")}) · 🌡<strong>${d.temp_c ?? 34}℃</strong></div></div>
        <div class="kv-item"><label>卡槽1 / 卡槽2 手机号</label><div class="mono">${d.slot_1_phone ? maskStr(d.slot_1_phone, "phone") : "空"} / ${d.slot_2_phone ? maskStr(d.slot_2_phone, "phone") : "空"}</div></div>
      </div>

      <div class="panel-card" style="padding:12px 14px;border-color:${lvl === "red" ? "var(--red-border)" : "var(--blue-border)"};background:${lvl === "red" ? "#fff5f6" : "#f8fbff"};">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">
          <strong>📍 实时定位（在司 vs 居家）× 公司受控网合规管控 ${qTip("loc_corp_net_policy")}</strong>
          <span class="badge ${bCls}">${esc(d.loc_net_compliance_label)}</span>
        </div>
        <div style="font-size:12.5px;line-height:1.6;margin-bottom:10px;">
          <div><strong>物理定位：</strong>${esc(d.geo_location_label)} <span class="mono" style="color:var(--ink-muted);">(${esc(d.geo_coords || "")} · 距公司 ${d.distance_from_office_km || 0}km)</span></div>
          <div><strong>连接网络：</strong><span class="mono">${esc(d.connected_ssid_or_nic)}</span>（${esc(d.gateway_egress_note || "")}）</div>
          <div><strong>诊断说明：</strong>${esc(d.compliance_note || "-")} ${d.remote_locked ? `<span class="badge badge-red">🔒 已远程锁屏</span>` : ""}</div>
        </div>
        <div class="op-btns" style="flex-wrap:wrap;">
          <button type="button" class="btn btn-primary btn-xs" id="btn-dev-force-wifi">📡 强制切回公司受控网</button>
          <button type="button" class="btn btn-outline btn-xs" id="btn-dev-wfh-vpn">🏠 登记居家办公并拨通VPN</button>
          <button type="button" class="btn btn-outline btn-xs" id="btn-dev-return-hq">📍 确认召回在司连网</button>
          <button type="button" class="btn btn-amber btn-xs" id="btn-dev-remote-lock">🔒 远程锁屏停派任务</button>
          <button type="button" class="btn btn-outline btn-xs" id="btn-dev-inv-ok">📋 扫码盘点确认</button>
        </div>
      </div>

      ${renderRelatedVaultCard([["physical_devices", d.id]], {
        category: "device_sim",
        legal_person_id: d.legal_person_id || "lp-demo-a",
        target_table: "physical_devices",
        target_id: d.id,
        title: `${d.device_code} · ${d.brand_model}`,
        login_account: d.device_code
      })}

      <details class="panel-card" style="padding:0;">
        <summary style="padding:11px 14px;cursor:pointer;font-weight:700;color:var(--red-ink);">⚠️ 固定资产报废核减 / 转二手商品入库售卖（自动校验拔卡与解绑账号）</summary>
        <div style="padding:12px 14px;border-top:1px solid var(--border-light);display:flex;flex-direction:column;gap:8px;">
          <span class="cell-sub">防泄密硬红线：若该设备仍插有公司 SIM 卡、承载 AdsPower 窗口或绑定在用店铺账号，提交核减将被当场硬阻断！</span>
          <div class="op-btns">
            <select id="retire-target-act" class="select-control">
              <option value="transfer_to_resale_sku">淘汰转入二手商品库变卖 (asset_intake)</option>
              <option value="scrap_retire">硬件损坏报废核减</option>
            </select>
            <input id="retire-reason" class="input-control" style="flex:1;" value="设备换代淘汰申请核减" />
            <button type="button" class="btn btn-danger btn-sm" id="btn-submit-asset-retire">提交核减校验</button>
          </div>
        </div>
      </details>
    `;
    const footer = `<button class="btn btn-primary" id="btn-dev-edit">编辑设备档案</button>`;
    openDrawer("固定资产·定位网络与锁屏密码", `${d.asset_no || d.device_code} · ${d.brand_model}`, html, footer, () => openDeviceDetailDrawer(devId));
    document.getElementById("btn-dev-edit").onclick = () => openRecordFormDrawer("physical_devices", d);

    const runComp = async (act) => {
      try {
        const r = await apiCall("/api/assets/compliance-action", "POST", { device_id: d.id, action: act });
        toast(r.message, "success");
        await reloadData();
        openDeviceDetailDrawer(d.id);
      } catch (e) {
        toast("⛔ " + e.message, "error");
      }
    };
    document.getElementById("btn-dev-force-wifi").onclick = () => runComp("enforce_corp_wifi");
    document.getElementById("btn-dev-wfh-vpn").onclick = () => runComp("approve_wfh_vpn");
    document.getElementById("btn-dev-return-hq").onclick = () => runComp("enforce_return_office");
    document.getElementById("btn-dev-remote-lock").onclick = () => runComp("remote_lock_device");
    document.getElementById("btn-dev-inv-ok").onclick = () => runComp("mark_inventory_checked");
    document.getElementById("btn-submit-asset-retire").onclick = async () => {
      try {
        const r = await apiCall("/api/assets/retire-request", "POST", {
          device_id: d.id,
          target_action: document.getElementById("retire-target-act").value,
          reason: document.getElementById("retire-reason").value,
        });
        toast(`✅ 已通过防泄密净身校验并完成资产核减（单号 ${r.request_no}）`, "success");
        await reloadData();
        openDeviceDetailDrawer(d.id);
      } catch (e) {
        toast("⛔ " + e.message, "error");
      }
    };
  }

  function openSimDetailDrawer(simId) {
    const s = state.boot.sim_cards.find((x) => x.id === simId);
    if (!s) return;
    const fees = state.boot.sim_fee_records.filter((f) => f.sim_card_id === s.id);
    const otherSims = state.boot.sim_cards.filter((x) => x.id !== s.id && x.sim_status !== "retired");

    const html = `
      <div class="kv-grid">
        <div class="kv-item"><label>手机号码 / 运营商</label><div class="mono">${maskStr(s.phone_number, "phone")} (${esc(s.carrier)})</div></div>
        <div class="kv-item"><label>性质与主副关系</label><div>${simCategoryBadge(s.card_category)} ${s.master_phone_number ? `→ 主卡 ${esc(s.master_phone_number)}` : ""}</div></div>
        <div class="kv-item"><label>实名人 / 外部渠道</label><div>${esc(s.real_name_holder)} ${s.external_vendor ? `(${esc(s.external_vendor)})` : ""}</div></div>
        <div class="kv-item"><label>所插实体设备</label><div class="mono">${esc(s.device_slot_label)} · ${esc(s.custodian_staff)}</div></div>
        <div class="kv-item"><label>套餐月租 & 出账日</label><div class="mono">${fenToYuan(s.monthly_rent_fen)}/月 · 每月${s.billing_day}日</div></div>
        <div class="kv-item"><label>有效话费余额</label><div class="mono" style="color:${s.is_low_balance ? "var(--red)" : "var(--green)"}">${s.billing_mode === "shared_master" ? `共享主卡池 ${fenToYuan(s.effective_balance_fen)}` : fenToYuan(s.balance_fen)}</div></div>
        <div class="kv-item"><label>外部合约起止期</label><div class="mono">${s.is_external ? `${esc(s.contract_start_date)} ~ ${esc(s.contract_end_date)} (剩 ${s.contract_days_left} 天)` : "长期自有实名卡"}</div></div>
        <div class="kv-item"><label>ICCID</label><div class="mono">${esc(s.iccid || "-")}</div></div>
      </div>

      ${renderRelatedVaultCard([["sim_cards", s.id]], {
        category: "device_sim",
        legal_person_id: s.legal_person_id || "lp-demo-a",
        target_table: "sim_cards",
        target_id: s.id,
        title: `SIM服务密码 · ${s.phone_number}`,
        login_account: s.phone_number
      })}

      ${s.billing_mode === "independent" ? `
      <div class="panel-card">
        <div class="panel-head"><h3>💰 快捷话费充值 / 月租扣减</h3></div>
        <div class="panel-body">
          <div class="op-btns" style="flex-wrap:wrap;gap:8px;">
            <select id="sim-fee-type" class="select-control">
              <option value="recharge">+ 话费充值</option>
              <option value="monthly_rent">- 扣减月租</option>
            </select>
            <input id="sim-fee-amt" type="number" step="0.01" value="100" class="input-control mono" style="width:105px;" />
            <input id="sim-fee-note" type="text" class="input-control" style="flex:1;" placeholder="备注（预留后续接钉钉OA）" />
            <button class="btn btn-primary" id="btn-submit-sim-fee">确认记账</button>
          </div>
        </div>
      </div>` : ""}

      <div class="panel-card">
        <div class="panel-head"><h3>🔗 该号码关联的全部对象 (${s.bound_count})</h3></div>
        <div class="table-wrap">
          <table class="ledger-table">
            <thead><tr><th>平台 / 机构</th><th>绑定对象</th><th>角色</th><th>优先级</th></tr></thead>
            <tbody>
              ${s.bound_objects.length === 0 ? `<tr><td colspan="4">暂无绑定对象</td></tr>` : s.bound_objects.map((b) => `
                <tr>
                  <td><strong>${esc(b.platform_or_org)}</strong></td>
                  <td>${esc(b.target_name_snapshot)}</td>
                  <td>${esc(b.binding_role)}</td>
                  <td><span class="badge ${b.rebind_priority === "critical" ? "badge-red" : "badge-amber"}">${esc(b.rebind_priority)}</span></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
        ${s.bound_count > 0 ? `
        <div class="panel-body" style="border-top:1px solid var(--border-light);background:var(--amber-bg);">
          <strong style="color:var(--amber-ink);display:block;margin-bottom:6px;">🔄 外部卡到期一键批量换绑迁移：</strong>
          <div class="op-btns">
            <select id="sim-rebind-target" class="select-control" style="flex:1;">
              <option value="">选择接替的新手机卡...</option>
              ${otherSims.map((os) => `<option value="${esc(os.id)}">${esc(os.phone_number)} (${esc(os.carrier)} · ${esc(os.real_name_holder)} · 已绑${os.bound_count}项)</option>`).join("")}
            </select>
            <button class="btn btn-amber" id="btn-exec-rebind">一键迁移并退网原卡</button>
          </div>
        </div>` : ""}
      </div>

      <details class="panel-card">
        <summary style="padding:11px 16px;cursor:pointer;font-weight:700;">📜 展开查看该卡历史话费流水 (${fees.length})</summary>
        <div class="table-wrap">
          <table class="ledger-table">
            <thead><tr><th>日期</th><th>类型</th><th>金额</th><th>结余</th><th>备注</th></tr></thead>
            <tbody>
              ${fees.length === 0 ? `<tr><td colspan="5">暂无流水</td></tr>` : fees.map((f) => `
                <tr>
                  <td class="mono">${esc(f.occurred_date)}</td>
                  <td>${f.change_type === "recharge" ? "充值" : "扣月租"}</td>
                  <td class="mono">${f.amount_fen >= 0 ? "+" : ""}${fenToYuan(f.amount_fen)}</td>
                  <td class="mono">${fenToYuan(f.balance_after_fen)}</td>
                  <td>${esc(f.notes)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </details>
    `;

    openDrawer("手机卡与话费穿透", `手机号 ${s.phone_number}（绑 ${s.bound_count} 个对象）`, html, "", () => openSimDetailDrawer(simId));

    const btnFee = document.getElementById("btn-submit-sim-fee");
    if (btnFee) {
      btnFee.onclick = async () => {
        try {
          await apiCall("/api/actions/sim-fee", "POST", {
            sim_card_id: s.id,
            change_type: document.getElementById("sim-fee-type").value,
            amount_yuan: Number(document.getElementById("sim-fee-amt").value || 0),
            notes: document.getElementById("sim-fee-note").value,
          });
          toast("话费台账已更新", "success");
          await reloadData();
          openSimDetailDrawer(s.id);
        } catch (e) {
          toast(e.message, "error");
        }
      };
    }

    const btnRebind = document.getElementById("btn-exec-rebind");
    if (btnRebind) {
      btnRebind.onclick = async () => {
        const newId = document.getElementById("sim-rebind-target").value;
        if (!newId) {
          toast("请先选择接替的新手机卡", "error");
          return;
        }
        try {
          await apiCall("/api/actions/sim-rebind", "POST", { old_sim_id: s.id, new_sim_id: newId });
          toast("已完成全平台绑定与卡槽迁移！", "success");
          await reloadData();
          openSimDetailDrawer(newId);
        } catch (e) {
          toast(e.message, "error");
        }
      };
    }
  }

  function openProxyDetailDrawer(proxyId) {
    const px = state.boot.proxy_ips.find((x) => x.id === proxyId);
    if (!px) return;
    const renewals = state.boot.proxy_renewals.filter((r) => r.proxy_ip_id === px.id);
    const html = `
      <div class="kv-grid">
        <div class="kv-item"><label>编号 / 供应商</label><div>${esc(px.proxy_code)} · ${esc(px.provider)}</div></div>
        <div class="kv-item"><label>地区运营商</label><div>${esc(px.isp_region)}</div></div>
        <div class="kv-item"><label>SOCKS5 地址</label><div class="mono">${esc(px.protocol)}://${esc(px.host)}:${px.port}</div></div>
        <div class="kv-item"><label>代理账号</label><div class="mono">${esc(px.proxy_user)}（SOCKS5密钥见下方保险箱）</div></div>
        <div class="kv-item"><label>出口家宽 IP</label><div class="mono">${esc(px.exit_ip)}</div></div>
        <div class="kv-item"><label>到期状态 & 月费</label><div>${proxyCountdownBadge(px.days_left, px.expires_at)} (${esc(px.expires_at)}) · ${fenToYuan(px.monthly_cost_fen)}/月</div></div>
      </div>

      ${renderRelatedVaultCard([["proxy_ips", px.id]], {
        category: "network_ads",
        legal_person_id: "lp-demo-a",
        target_table: "proxy_ips",
        target_id: px.id,
        title: `${px.proxy_code} · 家宽节点 (${px.exit_ip})`,
        login_account: `${px.proxy_user}@${px.host}:${px.port}`
      })}

      <div class="panel-card">
        <div class="panel-head"><h3>⚡ 家宽代理快捷续期</h3></div>
        <div class="panel-body">
          <div class="op-btns">
            <select id="px-renew-months" class="select-control">
              <option value="1">续费 1 个月 (+30天 · ¥10.00)</option>
              <option value="3">续费 3 个月 (+90天 · ¥30.00)</option>
              <option value="6">续费 6 个月 (+180天 · ¥60.00)</option>
            </select>
            <button class="btn btn-success" id="btn-submit-px-renew">确认续期</button>
          </div>
        </div>
      </div>

      <div class="panel-card">
        <div class="panel-head"><h3>🧩 当前跨平台复用列表 (${px.reused_accounts.length})</h3></div>
        <div class="table-wrap">
          <table class="ledger-table">
            <thead><tr><th>业务平台</th><th>店铺 / 账号</th><th>角色</th></tr></thead>
            <tbody>
              ${px.reused_accounts.length === 0 ? `<tr><td colspan="3">空闲未挂载</td></tr>` : px.reused_accounts.map((a) => `
                <tr>
                  <td><span class="badge badge-blue">${esc(a.platform_label)}</span></td>
                  <td><strong>${esc(a.display_name)}</strong></td>
                  <td>${roleBadge(a.account_role)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel-card">
        <div class="panel-head"><h3>🪟 关联 AdsPower 窗口 (${px.bound_windows.length}) & 续费记录 (${renewals.length})</h3></div>
        <div class="panel-body">
          <div>${px.bound_windows.map((w) => `<span class="badge badge-gray mono" style="margin-right:6px;">${esc(w.profile_code)} (#${esc(w.ads_serial_no)}) ${esc(w.window_name)}</span>`).join("") || "无窗口"}</div>
        </div>
      </div>
    `;
    openDrawer("家宽代理IP详情", `${px.proxy_code} · ${px.exit_ip}`, html, "", () => openProxyDetailDrawer(proxyId));
    document.getElementById("btn-submit-px-renew").onclick = async () => {
      try {
        const m = Number(document.getElementById("px-renew-months").value || 1);
        const r = await apiCall("/api/actions/proxy-renew", "POST", { proxy_ip_id: px.id, months: m });
        toast(`续期成功，新到期日：${r.new_expires_at}`, "success");
        await reloadData();
        openProxyDetailDrawer(px.id);
      } catch (e) {
        toast(e.message, "error");
      }
    };
  }

  function openEntityDetailDrawer(entId) {
    const e = state.boot.business_entities.find((x) => x.id === entId);
    if (!e) return;
    const alis = state.boot.alipay_accounts.filter((a) => a.business_entity_id === e.id);
    const pas = state.boot.platform_accounts.filter((p) => p.business_entity_id === e.id);
    const tax = e.tax_registration;
    const ar = e.latest_annual_report;

    const html = `
      <div class="kv-grid">
        <div class="kv-item"><label>主体编号 / 委托客户</label><div>${esc(e.entity_code)} · ${esc(e.legal_person_name)}</div></div>
        <div class="kv-item"><label>统一社会信用代码</label><div class="mono">${esc(e.uscc)}</div></div>
        <div class="kv-item"><label>注册地址</label><div>${esc(e.registered_address)}</div></div>
        <div class="kv-item"><label>税务与年报</label><div>${tax ? `季开 ${tax.quota_usage_pct}%` : "未登记"} · ${ar && ar.report_status === "publicized" ? `${ar.report_year}已公示` : "待年报"}</div></div>
      </div>

      ${renderRelatedVaultCard(
        [
          ["tax_registrations", tax ? tax.id : ""],
          ["annual_reports", ar ? ar.id : ""],
          ["business_entities", e.id]
        ],
        {
          category: "gov_tax",
          legal_person_id: e.legal_person_id,
          target_table: "business_entities",
          target_id: e.id,
          title: `${e.entity_code} · 政务服务密码`,
          login_account: e.uscc
        }
      )}

      <div class="panel-card">
        <div class="panel-head"><h3>💳 本主体企业支付宝 (${alis.length})</h3></div>
        <div class="table-wrap">
          <table class="ledger-table">
            <thead><tr><th>编号</th><th>名称</th><th>属性</th><th>因公支付关系</th><th>余额</th></tr></thead>
            <tbody>
              ${alis.map((a) => `
                <tr>
                  <td class="mono">${esc(a.account_code)}</td>
                  <td>${esc(a.account_name)}</td>
                  <td>${roleBadge(a.trade_direction)}</td>
                  <td>${a.is_entity_master_fund ? "★ 本主体唯一主池" : a.corporate_pay_enabled ? `⚡ 扣 ${esc(a.master_account_code)}` : "独立收款"}</td>
                  <td class="mono">${fenToYuan(a.balance_fen)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <details class="panel-card" open>
        <summary style="padding:11px 16px;cursor:pointer;font-weight:700;">🛍 本主体挂载的店铺与业务号 (${pas.length})</summary>
        <div class="table-wrap">
          <table class="ledger-table">
            <thead><tr><th>平台</th><th>名称</th><th>角色</th><th>支付宝</th><th>家宽代理</th></tr></thead>
            <tbody>
              ${pas.map((p) => `
                <tr>
                  <td>${esc(p.platform_label)}</td>
                  <td><strong>${esc(p.display_name)}</strong></td>
                  <td>${roleBadge(p.account_role)}</td>
                  <td class="mono">${esc(p.alipay_code || "-")}</td>
                  <td class="mono">${esc(p.proxy_code || "-")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </details>
    `;
    openDrawer("营业执照主体全景穿透", `${e.entity_code} · ${e.entity_name}`, html, "", () => openEntityDetailDrawer(entId));
  }

  function openAlipayDetailDrawer(aliId) {
    const a = state.boot.alipay_accounts.find((x) => x.id === aliId);
    if (!a) return;
    const bills = state.boot.alipay_bills.filter((b) => b.alipay_account_id === a.id || b.deducted_master_alipay_id === a.id);
    const aliCase = window.LedgerPortals ? window.LedgerPortals.getCaseForTarget("alipay", a.id) : null;
    const html = `
      ${aliCase ? `
      <div class="panel-card" style="border-color:var(--purple-border);background:var(--purple-bg);">
        <div class="panel-head">
          <h3>💳 本企业支付宝 15 步开户与账单 API 连通教程 ${qTip("dual_track_gate")}</h3>
          ${window.LedgerPortals ? window.LedgerPortals.caseSummaryBadge(aliCase) : ""}
        </div>
        <div class="panel-body" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
          <div>
            <strong>当前节点：${esc(aliCase.current_step_code || "15步全绿")} ${esc(aliCase.current_step_title || "")}</strong>
            <span class="cell-sub">含个人号扫码创单、第1天 C10 企业管家授权（解锁闲鱼 S09）、D15 唯一0.xx元测试与T+1账单API核实（解锁闲鱼 S18）</span>
          </div>
          <button type="button" class="btn btn-primary btn-sm" data-open-wizard="${esc(aliCase.id)}">👉 打开 15 步开户教程 (${aliCase.done_steps}/${aliCase.total_steps})</button>
        </div>
      </div>` : ""}

      <div class="kv-grid">
        <div class="kv-item"><label>编号 / 槽位</label><div>${esc(a.account_code)} (${esc(a.entity_fund_slot)})</div></div>
        <div class="kv-item"><label>所属营业执照</label><div>${esc(a.entity_code)} · ${esc(a.entity_name)}</div></div>
        <div class="kv-item"><label>登录邮箱 / UID</label><div class="mono">${esc(a.login_email)} / ${maskStr(a.alipay_uid, "bank")}</div></div>
        <div class="kv-item"><label>买卖角色</label><div>${roleBadge(a.trade_direction)}</div></div>
        <div class="kv-item"><label>因公支付链路</label><div>${a.is_entity_master_fund ? `唯一主户（下挂 ${a.corporate_pay_sub_accounts.length} 个采购子号）` : a.corporate_pay_enabled ? `因公支付扣 ${esc(a.master_account_code)}` : "独立收款结算"}</div></div>
        <div class="kv-item"><label>提现卡 & 可用余额</label><div class="mono">${esc(a.settlement_bank || "无绑卡")} · ${fenToYuan(a.balance_fen)}</div></div>
        <div class="kv-item"><label>单笔限额 / 冻结备付金</label><div class="mono">${fenToYuan(a.single_tx_limit_fen || 0)} / ${fenToYuan(a.frozen_reserve_fen || 0)}</div></div>
        <div class="kv-item"><label>接口证书 / 财务科目槽</label><div class="mono">${esc(a.cert_sign_mode || "-")} · ${esc(a.finance_book_code || "待映射")}</div></div>
      </div>

      ${renderRelatedVaultCard([["alipay_accounts", a.id]], {
        category: "alipay",
        legal_person_id: a.legal_person_id,
        target_table: "alipay_accounts",
        target_id: a.id,
        title: `${a.account_code} · ${a.account_name}`,
        login_account: a.login_email
      })}

      <div class="panel-card">
        <div class="panel-head"><h3>📑 关联流水 (${bills.length})</h3></div>
        <div class="table-wrap">
          <table class="ledger-table">
            <thead><tr><th>日期</th><th>场景</th><th>发起号 → 扣款主户</th><th>金额</th></tr></thead>
            <tbody>
              ${bills.length === 0 ? `<tr><td colspan="4">暂无流水</td></tr>` : bills.map((b) => `
                <tr>
                  <td class="mono">${esc(b.bill_date)}</td>
                  <td>${esc(b.biz_scene)}</td>
                  <td class="mono">${esc(b.alipay_code)} ${b.master_alipay_name ? `→ ${esc(b.master_alipay_name)}` : ""}</td>
                  <td class="mono">${fenToYuan(b.amount_fen)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
    openDrawer("企业支付宝详情", `${a.account_code} · ${a.account_name}`, html, "", () => openAlipayDetailDrawer(aliId));
  }

  function getFormFields(table) {
    const b = state.boot;
    const lpOpts = b.legal_persons.map((x) => ({ v: x.id, l: `${x.name}` }));
    const entOpts = b.business_entities.map((x) => ({ v: x.id, l: `${x.entity_code} · ${x.entity_name}` }));
    const simOpts = [{ v: "", l: "-- 不绑定 --" }, ...b.sim_cards.map((x) => ({ v: x.id, l: `${x.phone_number} (${x.carrier}·${x.real_name_holder})` }))];
    const aliOpts = [{ v: "", l: "-- 无 --" }, ...b.alipay_accounts.map((x) => ({ v: x.id, l: `${x.account_code} [${x.trade_direction}] ${x.account_name} (${x.entity_code})` }))];
    const masterAliOpts = [{ v: "", l: "-- 非因公代扣子号无需选 --" }, ...b.alipay_accounts.filter((x) => x.is_entity_master_fund === 1).map((x) => ({ v: x.id, l: `${x.account_code} (${x.entity_code} 主户) ${x.account_name}` }))];
    const pxOpts = [{ v: "", l: "-- 无 --" }, ...b.proxy_ips.map((x) => ({ v: x.id, l: `${x.proxy_code} (${x.exit_ip} · 已绑${x.reused_platform_count}平台)` }))];
    const adsOpts = [{ v: "", l: "-- 纯真机App不绑Ads窗 --" }, ...b.adspower_profiles.map((x) => ({ v: x.id, l: `${x.profile_code} (#${x.ads_serial_no} · 绑${x.proxy_code})` }))];
    const devOpts = [{ v: "", l: "-- 无 --" }, ...b.physical_devices.map((x) => ({ v: x.id, l: `${x.device_code} · ${x.brand_model}` }))];
    const hostDevOpts = b.physical_devices.filter((x) => x.device_kind === "adspower_pc_host").map((x) => {
      const mh = ((b.cluster_health && b.cluster_health.mac_hosts) || []).find((m) => m.device_id === x.id);
      const slotTxt = mh ? ` [槽位 ${mh.occupied_slots}/${mh.max_account_quota}]` : "";
      return { v: x.id, l: `${x.device_code}${slotTxt} · ${x.brand_model}` };
    });
    const shopTargetOpts = [{ v: "", l: "-- 无导流目标 --" }, ...b.platform_accounts.filter((x) => x.account_role === "sales_only").map((x) => ({ v: x.id, l: `${x.platform_label} · ${x.display_name}` }))];
    const platOpts = Object.entries(b.meta.platform_labels).map(([v, l]) => ({ v, l }));

    const schemas = {
      legal_persons: [
        { k: "name", label: "委托客户/法人姓名", req: true },
        { k: "id_card_no", label: "身份证号码", req: true },
        { k: "primary_phone", label: "本人主联系手机", req: true },
        { k: "residence_city", label: "常驻城市", def: "演示城市" },
        { k: "face_verify_sla", label: "刷脸响应SLA", def: "15分钟内响应" },
        { k: "agency_contract_no", label: "托管运营合同号", def: "AGR-CUSTODY-2026-NEW" },
        { k: "contract_expires_at", label: "托管合同到期日", type: "date", def: "2028-12-31" },
        { k: "notes", label: "备注", span: 2 },
      ],
      business_entities: [
        { k: "legal_person_id", label: "所属委托客户", opts: lpOpts },
        { k: "entity_code", label: "主体编码", def: "ENT-NEW-05", req: true },
        { k: "entity_name", label: "营业执照全称", span: 2, req: true },
        { k: "uscc", label: "统一社会信用代码", req: true },
        { k: "entity_type", label: "主体性质", opts: [{ v: "individual_business", l: "个体工商户" }, { v: "company", l: "有限责任公司" }, { v: "sole_proprietorship", l: "个人独资企业" }] },
        { k: "registration_authority", label: "登记机关", def: "演示登记机关", req: true },
        { k: "established_date", label: "成立日期", type: "date", def: "2026-11-14" },
        { k: "registered_address", label: "注册地址", span: 2, req: true },
        { k: "target_store_slots", label: "规划店铺数", type: "number", def: 4 },
        { k: "license_status", label: "状态", opts: [{ v: "active", l: "正常存续" }, { v: "abnormal", l: "异常风险" }] },
        { k: "notes", label: "备注", span: 2 },
      ],
      tax_registrations: [
        { k: "business_entity_id", label: "对应营业执照", opts: entOpts },
        { k: "tax_bureau_name", label: "主管税务局", def: "演示税务机关", req: true },
        { k: "taxpayer_type", label: "纳税人类型", opts: [{ v: "小规模纳税人", l: "小规模纳税人" }, { v: "一般纳税人", l: "一般纳税人" }] },
        { k: "collection_mode", label: "征收方式", opts: [{ v: "查账征收", l: "查账征收" }, { v: "核定征收", l: "核定征收" }] },
        { k: "filing_cycle", label: "申报周期", opts: [{ v: "按季申报", l: "按季申报" }, { v: "按月申报", l: "按月申报" }] },
        { k: "tax_officer_name", label: "办税员/代账", def: "桐新代账" },
        { k: "bound_sim_id", label: "绑定办税手机", opts: simOpts },
        { k: "current_period", label: "当前税期", def: "2026-Q4" },
        { k: "quarter_sales_fen", label: "本季销售额(分)", type: "number", def: 0 },
        { k: "quarter_exempt_limit_fen", label: "法定按季阈值(分)", type: "number", def: 30000000 },
        { k: "filing_status", label: "申报状态", opts: [{ v: "filed", l: "已申报完税" }, { v: "pending", l: "待申报" }] },
        { k: "next_due_date", label: "下次截止日", type: "date", def: "2027-01-15" },
        { k: "notes", label: "备注", span: 2 },
      ],
      annual_reports: [
        { k: "business_entity_id", label: "对应营业执照", opts: entOpts },
        { k: "report_year", label: "年报年度", type: "number", def: 2026 },
        { k: "aic_bureau_name", label: "管辖市场监管局", def: "演示登记机关", req: true },
        { k: "window_period", label: "填报窗口期", def: "2027-01-01 ~ 2027-06-30" },
        { k: "liaison_name", label: "工商联络员", def: "演示客户甲" },
        { k: "liaison_sim_id", label: "联络员手机", opts: simOpts },
        { k: "report_status", label: "公示状态", opts: [{ v: "publicized", l: "已填报公示" }, { v: "pending", l: "待填报" }] },
        { k: "submitted_date", label: "提交日期", type: "date" },
        { k: "notes", label: "备注", span: 2 },
      ],
      alipay_accounts: [
        { k: "legal_person_id", label: "所属委托客户", opts: lpOpts },
        { k: "business_entity_id", label: "归属营业执照", opts: entOpts },
        { k: "account_code", label: "台账编号", def: "ALI-NEW-01", req: true },
        { k: "account_name", label: "企业支付宝名称", req: true },
        { k: "login_email", label: "登录邮箱", def: "demo-new@example.invalid", req: true },
        { k: "alipay_uid", label: "支付宝 UID", def: "DEMO-UID-NEW" },
        { k: "entity_fund_slot", label: "主体槽位", def: "扩展子号" },
        { k: "trade_direction", label: "买卖定位", opts: [{ v: "sales_only", l: "🟢 纯销售收款号" }, { v: "purchase_only", l: "🟠 纯采购专用号" }, { v: "master_fund", l: "🟣 3选1主资金池" }] },
        { k: "is_entity_master_fund", label: "设为主体唯一主号(3选1)", opts: [{ v: 0, l: "0 - 否" }, { v: 1, l: "1 - 是" }] },
        { k: "corporate_pay_enabled", label: "开启因公支付扣主户", opts: [{ v: 0, l: "0 - 否" }, { v: 1, l: "1 - 开启" }] },
        { k: "master_alipay_id", label: "因公被扣款主号(须同执照)", opts: masterAliOpts },
        { k: "daily_limit_fen", label: "日限额(分)", type: "number", def: 1500000 },
        { k: "single_tx_limit_fen", label: "单笔限额(分，默认10万)", type: "number", def: 10000000 },
        { k: "bound_sim_id", label: "绑定手机", opts: simOpts },
        { k: "balance_fen", label: "余额(分)", type: "number", def: 0 },
        { k: "frozen_reserve_fen", label: "风险备付冻结金(分)", type: "number", def: 0 },
        { k: "cert_sign_mode", label: "开放平台证书状态", def: "公钥证书三件套已备" },
        { k: "finance_book_code", label: "ERP/金蝶财务科目编码", def: "1012.ALI-NEW" },
        { k: "notes", label: "备注", span: 2 },
      ],
      alipay_bills: [
        { k: "bill_date", label: "账单日期", type: "date", def: "2026-11-14" },
        { k: "business_entity_id", label: "所属营业执照", opts: entOpts },
        { k: "alipay_account_id", label: "发起支付宝", opts: aliOpts.slice(1) },
        { k: "deducted_master_alipay_id", label: "因公实扣/冲回主户", opts: masterAliOpts },
        { k: "related_platform_account_id", label: "关联具体店铺/买券号", opts: [{ v: "", l: "-- 不指定单店 --" }, ...b.platform_accounts.map((x) => ({ v: x.id, l: `${x.account_code} · ${x.display_name}` }))] },
        { k: "flow_direction", label: "资金流向", opts: Object.entries(b.meta.flow_direction_labels || {}).map(([v, l]) => ({ v, l })) },
        { k: "biz_scene", label: "业务场景", def: "大众点评买卡券因公支付", req: true },
        { k: "counterparty", label: "交易对手", req: true },
        { k: "platform_order_ref", label: "平台单号", def: "" },
        { k: "amount_fen", label: "金额(分)", type: "number", def: 10000 },
        { k: "fee_fen", label: "平台扣佣手续费(分)", type: "number", def: 0 },
        { k: "oa_finance_voucher_no", label: "OA/ERP财务凭证号槽", def: "待关联OA/ERP" },
      ],
      platform_accounts: [
        { k: "legal_person_id", label: "所属委托客户", opts: lpOpts },
        { k: "business_entity_id", label: "归属营业执照", opts: [{ v: "", l: "-- 非执照号 --" }, ...entOpts] },
        { k: "platform", label: "业务平台", opts: platOpts },
        { k: "account_role", label: "买卖定位", opts: [{ v: "sales_only", l: "🟢 销售店铺" }, { v: "purchase_only", l: "🟠 采购买卡券号" }, { v: "marketing_only", l: "🟣 社媒引流号" }] },
        { k: "account_code", label: "编号", def: "PA-NEW-01", req: true },
        { k: "display_name", label: "名称/昵称", req: true },
        { k: "platform_login_id", label: "平台登录ID", req: true },
        { k: "virtual_biz_usage", label: "业务用途", def: "虚拟卡券业务" },
        { k: "settlement_channel", label: "清算/扣款通道", opts: [{ v: "", l: "-- 按平台角色自动匹配 --" }, ...Object.entries(b.meta.settlement_channel_labels || {}).map(([v, l]) => ({ v, l }))] },
        { k: "merchant_account_no", label: "商户号 / mch_id 预留槽", def: "DEMO-MERCHANT" },
        { k: "settlement_bank_ref", label: "提现落账银行卡/资金池", def: "" },
        { k: "settlement_cycle", label: "结算账期规则", def: "确认收货实时" },
        { k: "commission_rate_bps", label: "平台佣金万分比(60=0.6%)", type: "number", def: 60 },
        { k: "deposit_fen", label: "店铺保证金(分)", type: "number", def: 0 },
        { k: "deposit_source_ref", label: "保证金原路缴退账户", def: "" },
        { k: "frozen_balance_fen", label: "在途/纠纷冻结款(分)", type: "number", def: 0 },
        { k: "month_gmv_fen", label: "当月销项GMV(分)", type: "number", def: 0 },
        { k: "month_cost_fen", label: "当月采购成本(分)", type: "number", def: 0 },
        { k: "month_refund_fen", label: "当月退单冲回(分)", type: "number", def: 0 },
        { k: "tax_invoice_mode", label: "税票与计税口径", def: "个体普票按季30万阈值合规监测" },
        { k: "finance_book_code", label: "ERP/金蝶科目 & OA映射槽", def: "ERP-SHOP-NEW" },
        { k: "alipay_account_id", label: "收付款支付宝", opts: aliOpts },
        { k: "bound_sim_id", label: "绑定手机卡", opts: simOpts },
        { k: "adspower_profile_id", label: "AdsPower窗口", opts: adsOpts },
        { k: "proxy_ip_id", label: "家宽代理IP", opts: pxOpts },
        { k: "physical_device_id", label: "实体设备", opts: devOpts },
        { k: "lead_target_account_id", label: "导流目标小店", opts: shopTargetOpts },
        { k: "operator_staff", label: "负责人", def: "演示员工甲" },
        { k: "notes", label: "备注", span: 2 },
      ],
      proxy_ips: [
        { k: "proxy_code", label: "家宽编号", def: "IP-HZ-17", req: true },
        { k: "provider", label: "供应商", def: "演示代理服务" },
        { k: "isp_region", label: "运营商与地区", def: "演示网络区" },
        { k: "protocol", label: "协议", opts: [{ v: "SOCKS5", l: "SOCKS5" }, { v: "HTTP", l: "HTTP" }] },
        { k: "host", label: "连接主机 Host", def: "proxy-new.example.invalid", req: true },
        { k: "port", label: "端口 Port", type: "number", def: 21017 },
        { k: "proxy_user", label: "代理账号", def: "" },
        { k: "proxy_pass", label: "代理密码", def: "" },
        { k: "exit_ip", label: "实测出口家宽IP", def: "192.0.2.50", req: true },
        { k: "monthly_cost_fen", label: "月费(分，¥10=1000)", type: "number", def: 1000 },
        { k: "purchased_at", label: "开通日期", type: "date", def: "2026-11-14" },
        { k: "expires_at", label: "到期日期", type: "date", def: "2026-12-14", req: true },
      ],
      adspower_profiles: [
        { k: "profile_code", label: "窗口编号", def: "ADS-020", req: true },
        { k: "ads_serial_no", label: "Ads序号", def: "DEMO-SERIAL-NEW", req: true },
        { k: "ads_user_id", label: "Ads user_id", def: "demo-window-new", req: true },
        { k: "window_name", label: "窗口名称", req: true },
        { k: "host_device_id", label: "运行宿主机", opts: hostDevOpts },
        { k: "proxy_ip_id", label: "绑定家宽代理IP", opts: pxOpts.slice(1) },
        { k: "role_isolation", label: "隔离属性", opts: [{ v: "sales_only", l: "销售窗" }, { v: "purchase_only", l: "采购窗" }, { v: "marketing_only", l: "社媒窗" }] },
      ],
      physical_devices: [
        { k: "legal_person_id", label: "托管客户(公用留空)", opts: [{ v: "", l: "-- 运营公司公共集群 --" }, ...lpOpts] },
        { k: "device_code", label: "设备编号", def: "DEV-PH-16", req: true },
        { k: "device_kind", label: "设备类型", opts: [{ v: "work_phone", l: "销售工作手机" }, { v: "procurement_phone", l: "采购买卡券专机" }, { v: "adspower_pc_host", l: "AdsPower电脑宿主机" }] },
        { k: "brand_model", label: "品牌型号", def: "Redmi Note 13 Pro", req: true },
        { k: "serial_number", label: "序列号 SN", req: true },
        { k: "role_isolation", label: "隔离职能", opts: [{ v: "sales_only", l: "纯销售终端" }, { v: "purchase_only", l: "纯采购终端" }, { v: "host_cluster", l: "桌面集群宿主" }] },
        { k: "sim_slot_1_id", label: "卡槽1手机号", opts: simOpts },
        { k: "sim_slot_2_id", label: "卡槽2手机号", opts: simOpts },
        { k: "workstation_loc", label: "存放工位", def: "销售一组-05" },
        { k: "custodian_staff", label: "保管人", def: "演示员工甲" },
      ],
      sim_cards: [
        { k: "legal_person_id", label: "所属委托客户", opts: lpOpts },
        { k: "phone_number", label: "11位手机号", req: true },
        { k: "carrier", label: "运营商", opts: [{ v: "中国移动", l: "中国移动" }, { v: "中国联通", l: "中国联通" }, { v: "中国电信", l: "中国电信" }] },
        { k: "card_category", label: "号卡性质", opts: [{ v: "external_contract", l: "第三方授权合约卡" }, { v: "company_master", l: "客户实名新开主卡" }, { v: "company_sub", l: "客户实名新开副卡" }] },
        { k: "master_sim_id", label: "所属主卡(副卡选)", opts: simOpts },
        { k: "real_name_holder", label: "实名人姓名", def: "演示客户甲", req: true },
        { k: "billing_mode", label: "计费方式", opts: [{ v: "independent", l: "独立余额扣费" }, { v: "shared_master", l: "共享主卡话费池" }] },
        { k: "monthly_rent_fen", label: "月租(分)", type: "number", def: 1900 },
        { k: "balance_fen", label: "当前余额(分)", type: "number", def: 5000 },
        { k: "contract_end_date", label: "外部卡合约到期日", type: "date" },
      ],
      carrier_quotas: [
        { k: "legal_person_id", label: "关联委托客户", opts: lpOpts },
        { k: "holder_name", label: "实名人姓名", req: true },
        { k: "holder_id_card", label: "身份证号", req: true },
        { k: "carrier", label: "运营商", opts: [{ v: "中国移动", l: "中国移动" }, { v: "中国联通", l: "中国联通" }, { v: "中国电信", l: "中国电信" }] },
        { k: "statutory_limit", label: "法定上限(默认5)", type: "number", def: 5 },
        { k: "existing_personal_cards", label: "原有个人卡数", type: "number", def: 1 },
      ],
    };
    return schemas[table] || [];
  }

  const TABLE_TITLES = {
    legal_persons: "签约委托客户",
    business_entities: "营业执照主体",
    tax_registrations: "税务局登记",
    annual_reports: "工商年报",
    alipay_accounts: "企业支付宝",
    alipay_bills: "支付宝账单流水",
    platform_accounts: "平台商业账号",
    proxy_ips: "家宽代理IP",
    adspower_profiles: "AdsPower窗口",
    physical_devices: "实体设备",
    sim_cards: "手机卡档案",
    carrier_quotas: "运营商占坑配额",
  };

  function openRecordFormDrawer(table, existingRecord = null) {
    const fields = getFormFields(table);
    const isEdit = Boolean(existingRecord);
    const bodyHtml = `
      <div id="form-err" class="form-error-box hidden"></div>
      <form id="record-form" class="form-grid">
        ${fields.map((f) => {
          const curVal = isEdit ? (existingRecord[f.k] ?? "") : (f.def ?? "");
          if (f.opts) {
            return `
              <div class="form-field ${f.span === 2 ? "span-2" : ""}">
                <label>${esc(f.label)}</label>
                <select name="${esc(f.k)}" class="select-control">
                  ${f.opts.map((o) => `<option value="${esc(o.v)}" ${String(curVal) === String(o.v) ? "selected" : ""}>${esc(o.l)}</option>`).join("")}
                </select>
              </div>
            `;
          }
          return `
            <div class="form-field ${f.span === 2 ? "span-2" : ""}">
              <label>${esc(f.label)}${f.req ? " *" : ""}</label>
              <input name="${esc(f.k)}" type="${f.type || "text"}" value="${esc(curVal)}" class="input-control" ${f.req ? "required" : ""} />
            </div>
          `;
        }).join("")}
      </form>
    `;
    const footerHtml = `
      <button class="btn btn-outline" id="btn-cancel-form">取消</button>
      <button class="btn btn-primary" id="btn-save-form">${isEdit ? "保存修改" : "确认录入"}</button>
    `;
    openDrawer(isEdit ? "编辑台账" : "新增录入", `${isEdit ? "编辑" : "新增"} · ${TABLE_TITLES[table] || table}`, bodyHtml, footerHtml);

    document.getElementById("btn-cancel-form").onclick = closeDrawer;
    document.getElementById("btn-save-form").onclick = async () => {
      const formEl = document.getElementById("record-form");
      const errBox = document.getElementById("form-err");
      errBox.classList.add("hidden");
      const fd = new FormData(formEl);
      const payload = {};
      for (const [k, v] of fd.entries()) payload[k] = v;
      try {
        if (isEdit) {
          await apiCall(`/api/records/${table}/${existingRecord.id}`, "PUT", payload);
          toast("保存成功", "success");
        } else {
          await apiCall(`/api/records/${table}`, "POST", payload);
          toast("录入成功", "success");
        }
        closeDrawer();
        await reloadData();
      } catch (e) {
        errBox.textContent = "⛔ " + e.message;
        errBox.classList.remove("hidden");
      }
    };
  }

  // ==================== 15. 5大违规阻断实测演练 ====================
  async function runGuardrailDrill(kind) {
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    let label = "";
    let fn = null;

    if (kind === "cross_entity_tax") {
      label = "跨营业执照因公支付串户";
      fn = () => apiCall("/api/records/alipay_accounts", "POST", {
        legal_person_id: "lp-demo-a",
        business_entity_id: "ent-demo-a-02",
        account_code: "ALI-ILLEGAL-TAX",
        account_name: "测试跨主体采购号",
        login_email: "illegal_tax@example.invalid",
        trade_direction: "purchase_only",
        is_entity_master_fund: 0,
        corporate_pay_enabled: 1,
        master_alipay_id: "ali-01",
      });
    } else if (kind === "buy_sell_mix") {
      label = "销售支付宝绑给买卡券号";
      fn = () => apiCall("/api/records/platform_accounts", "POST", {
        legal_person_id: "lp-demo-a",
        business_entity_id: "ent-demo-a-01",
        platform: "dianping",
        account_code: "DP-ILLEGAL-MIX",
        display_name: "违规混用测试号",
        platform_login_id: "dp_bad_01",
        account_role: "purchase_only",
        alipay_account_id: "ali-02",
        proxy_ip_id: "px-16",
      });
    } else if (kind === "same_platform_proxy") {
      label = "两家闲鱼店共用同一家宽IP";
      fn = () => apiCall("/api/records/platform_accounts", "POST", {
        legal_person_id: "lp-demo-a",
        business_entity_id: "ent-demo-a-01",
        platform: "xianyu",
        account_code: "XY-ILLEGAL-IP",
        display_name: "撞IP测试闲鱼店",
        platform_login_id: "tb_bad_ip",
        account_role: "sales_only",
        alipay_account_id: "ali-02",
        proxy_ip_id: "px-01",
      });
    } else if (kind === "delete_active_proxy") {
      label = "直接删除使用中的家宽代理";
      fn = () => apiCall("/api/records/proxy_ips/px-12", "DELETE");
    } else if (kind === "carrier_quota_exceed") {
      label = "超出一主4副实名卡上限";
      fn = () => apiCall("/api/records/sim_cards", "POST", {
        legal_person_id: "lp-demo-a",
        phone_number: "DEMO-ID-001",
        carrier: "中国移动",
        card_category: "company_sub",
        real_name_holder: "演示客户甲",
        billing_mode: "shared_master",
        master_sim_id: "sim-01",
      });
    }

    try {
      await fn();
      state.drillLogs.unshift(`[${ts}] ❌ 异常：${label} 未被拦截`);
    } catch (e) {
      state.drillLogs.unshift(`[${ts}] ✅ 成功拦截【${label}】 → ${e.message}`);
      toast("演练拦截生效：" + e.message, "success");
    }
    renderCurrentView();
  }

  // ==================== 15B. 密码保险箱：iPhone扫码 / Authenticator 解锁弹窗与单条解密 ====================
  let pendingAfterUnlock = null;

  function b64uToUint8(b64u) {
    const pad = "=".repeat((4 - (b64u.length % 4)) % 4);
    const b64 = (b64u + pad).replace(/-/g, "+").replace(/_/g, "/");
    const raw = window.atob(b64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  function bufToB64u(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return window.btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function closeVaultModal() {
    document.getElementById("vault-modal-backdrop").classList.add("hidden");
    document.getElementById("vault-modal").classList.add("hidden");
  }

  async function lockVaultManual() {
    try {
      if (state.vaultToken) {
        await apiCall("/api/vault/lock", "POST", { token: state.vaultToken });
      }
    } catch (_) {
      // ignore network error on lock
    }
    state.vaultToken = null;
    state.vaultTimerSec = 0;
    state.vaultAuthMethod = "";
    state.revealedSecrets = {};
    renderVaultTopbarBtn();
    renderSidebar();
    renderCurrentView();
    if (currentDrawerRerender && !document.getElementById("drawer-panel").classList.contains("hidden")) {
      currentDrawerRerender();
    }
    toast("🔒 密码保险箱已立即上锁，内存令牌与页面明文已清空", "info");
  }

  async function revealVaultSecret(credId) {
    if (!isVaultUnlocked()) {
      openVaultUnlockModal(async () => {
        await revealVaultSecret(credId);
      });
      return null;
    }
    try {
      const res = await apiCall("/api/vault/reveal", "POST", { id: credId });
      state.revealedSecrets[credId] = res.secret;
      renderCurrentView();
      if (currentDrawerRerender && !document.getElementById("drawer-panel").classList.contains("hidden")) {
        currentDrawerRerender();
      }
      return res.secret;
    } catch (e) {
      toast("⛔ " + e.message, "error");
      if (e.vaultLocked) {
        openVaultUnlockModal(async () => {
          await revealVaultSecret(credId);
        });
      }
      return null;
    }
  }

  async function copyVaultSecretField(credId, fieldName) {
    let sec = state.revealedSecrets[credId];
    if (!sec) {
      sec = await revealVaultSecret(credId);
    }
    if (!sec) return;
    const val = sec[fieldName] || "";
    if (!val) {
      toast("该条目未配置此项密码", "info");
      return;
    }
    await copyTextSafe(val, fieldName === "login_password" ? "登录密码" : "二级/支付密码");
  }

  async function openVaultUnlockModal(afterUnlockFn = null, forceMode = null) {
    pendingAfterUnlock = afterUnlockFn;
    if (forceMode === "passkey") state.vaultAuthTab = "passkey";
    else if (forceMode === "totp" || forceMode === "setup") state.vaultAuthTab = "totp";

    const modal = document.getElementById("vault-modal");
    const backdrop = document.getElementById("vault-modal-backdrop");
    const bodyEl = document.getElementById("vault-modal-body");
    backdrop.classList.remove("hidden");
    modal.classList.remove("hidden");

    const vMeta = (state.boot && state.boot.vault) || {};
    let setupQr = null;
    let setupErr = "";
    if (state.vaultAuthTab === "totp") {
      try {
        const r = await apiCall("/api/vault/setup-qr");
        setupQr = r.data;
      } catch (e) {
        setupErr = e.message;
      }
    }

    const isIpHost = /^\d+\.\d+\.\d+\.\d+$/.test(window.location.hostname);
    const webauthnAvailable = Boolean(window.PublicKeyCredential && navigator.credentials) && !isIpHost;
    const localhostUrl = window.location.href.replace(window.location.hostname, "localhost");

    bodyEl.innerHTML = `
      <div class="subtabs" style="align-self:flex-start;">
        <button type="button" class="subtab-btn ${state.vaultAuthTab === "totp" ? "active" : ""}" id="vtab-totp">📱 iPhone「密码」/ Authenticator 动态码</button>
        <button type="button" class="subtab-btn ${state.vaultAuthTab === "passkey" ? "active" : ""}" id="vtab-passkey">🪪 iPhone 扫码刷 Face ID / 指纹 Passkey</button>
      </div>

      <div id="vault-modal-err" class="form-error-box hidden"></div>

      ${
        state.vaultAuthTab === "totp"
          ? `
            <div style="background:var(--bg-subtle);border:1px solid var(--border-light);border-radius:12px;padding:16px;display:flex;flex-direction:column;align-items:center;gap:12px;">
              <div style="font-size:13px;font-weight:700;color:var(--ink-primary);">输入 iPhone「密码」App 或 Authenticator 上的 6 位动态口令</div>
              <div class="op-btns" style="gap:10px;">
                <input id="vault-otp-input" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000" class="otp-input mono" />
                <button type="button" class="btn btn-primary" id="btn-vault-verify-otp" style="height:44px;padding:0 18px;font-size:13.5px;">🔓 验证解锁 (15分钟)</button>
              </div>
              ${
                setupQr && setupQr.is_demo_mode
                  ? `
                    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center;padding-top:4px;">
                      <button type="button" class="btn btn-outline btn-xs" id="btn-fill-demo-otp" data-demo-code="${esc(setupQr.demo_current_code)}">
                        ⚡ 填入当前30秒演示码 (${esc(setupQr.demo_current_code)} · 剩${setupQr.demo_seconds_left}s)
                      </button>
                      <label style="font-size:11.5px;color:var(--ink-secondary);display:inline-flex;align-items:center;gap:4px;cursor:pointer;">
                        <input type="checkbox" id="chk-lock-prod-bind" />
                        我已用本人 iPhone 扫码保存，解锁后关闭演示辅助
                      </label>
                    </div>
                  `
                  : `<span class="cell-sub">✓ 当前已处于生产绑定保护态，请查看您已绑定的 iPhone 获取实时 6 位数字</span>`
              }
            </div>

            <details class="panel-card" ${(forceMode === "setup" || (setupQr && setupQr.is_demo_mode)) ? "open" : ""}>
              <summary style="padding:11px 15px;cursor:pointer;font-weight:700;display:flex;justify-content:space-between;align-items:center;">
                <span>📷 首次绑定 / 换绑：用 iPhone 相机或 Authenticator 扫描二维码</span>
                <span class="badge badge-blue">RFC 6238 标准</span>
              </summary>
              <div class="panel-body">
                ${
                  setupQr
                    ? `
                      <div class="qr-setup-card">
                        <div class="qr-svg-box" title="使用 iPhone 原生相机或 Google/Microsoft Authenticator 扫码">${setupQr.qr_svg}</div>
                        <div style="display:flex;flex-direction:column;gap:7px;font-size:12.5px;color:var(--ink-secondary);">
                          <div><strong>方法 A（苹果原生推荐）：</strong>直接打开 <b>iPhone 相机</b> 对准左侧二维码 → 点击屏幕上方弹出的黄色胶囊<b>「在“密码”中添加验证码」</b>，自动同步至 iCloud 钥匙串并支持 Face ID 保护。</div>
                          <div><strong>方法 B（通用验证器）：</strong>打开 <b>Google / Microsoft Authenticator</b> 点「+ 扫描二维码」即可添加。</div>
                          <div style="margin-top:2px;">
                            手动密钥：<span class="secret-pill"><code class="mono">${esc(setupQr.secret_b32)}</code></span>
                            <button type="button" class="btn btn-ghost btn-xs" data-copy-raw="${esc(setupQr.secret_b32)}">复制密钥</button>
                            <button type="button" class="btn btn-outline btn-xs" id="btn-rotate-totp">🔄 换新二维码</button>
                          </div>
                        </div>
                      </div>
                    `
                    : `<div class="form-error-box">${esc(setupErr || "生产锁定态下需先验证解锁后才可查看或更换绑定二维码")}</div>`
                }
              </div>
            </details>
          `
          : `
            <div style="background:var(--bg-subtle);border:1px solid var(--border-light);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px;">
              <div style="font-size:13px;font-weight:700;color:var(--ink-primary);">Apple 原生跨设备扫码刷 Face ID / Mac 指纹通行密钥 (WebAuthn Passkey)</div>
              <p style="margin:0;font-size:12.5px;color:var(--ink-secondary);line-height:1.6;">
                点击下方按钮后，系统将弹出通行密钥窗口：可选择 <b>「iPhone、iPad 或 Android 设备」</b> 生成苹果加密蓝牙/扫码二维码，拿 iPhone 相机一扫并刷 <b>Face ID</b> 即可无密码秒开；若在 Mac 本机操作也可直接按 <b>Touch ID 指纹</b>。
              </p>
              ${
                isIpHost
                  ? `
                    <div class="form-error-box" style="background:var(--amber-bg);border-color:var(--amber-border);color:var(--amber-ink);">
                      💡 浏览器安全标准规定：WebAuthn Passkey 仅在 <code>localhost</code> 或正式 <code>https://</code> 域名下启用（当前地址栏为纯 IP <code>${esc(window.location.hostname)}</code>）。
                      <div style="margin-top:8px;">
                        <a class="btn btn-primary btn-sm" href="${esc(localhostUrl)}">🌐 一键切换至 localhost:5370 启用 iPhone Passkey 扫码</a>
                      </div>
                    </div>
                  `
                  : !webauthnAvailable
                  ? `<div class="form-error-box">当前浏览器环境未开启 WebAuthn，请使用上方第一个标签页「iPhone 密码App / Authenticator 动态码」扫码解锁。</div>`
                  : `
                    <div class="op-btns" style="gap:10px;padding-top:4px;">
                      ${
                        vMeta.webauthn_bound
                          ? `<button type="button" class="btn btn-primary" id="btn-passkey-auth">🔓 唤起 iPhone 扫码刷脸 / 指纹立即解锁</button>`
                          : ""
                      }
                      <button type="button" class="btn ${vMeta.webauthn_bound ? "btn-outline" : "btn-primary"}" id="btn-passkey-reg">
                        🪪 ${vMeta.webauthn_bound ? "重新绑定新 iPhone / 指纹" : "首次注册绑定 iPhone 扫码 / Mac 指纹"}
                      </button>
                    </div>
                    ${vMeta.webauthn_bound ? `<span class="cell-sub">✓ 已绑定凭证：${esc(vMeta.webauthn_label || "老板 Passkey")}</span>` : ""}
                  `
              }
            </div>
          `
      }
    `;

    document.getElementById("vtab-totp").onclick = () => openVaultUnlockModal(pendingAfterUnlock, "totp");
    document.getElementById("vtab-passkey").onclick = () => openVaultUnlockModal(pendingAfterUnlock, "passkey");

    const showModalErr = (msg) => {
      const box = document.getElementById("vault-modal-err");
      if (box) {
        box.textContent = "⛔ " + msg;
        box.classList.remove("hidden");
      }
    };

    const finishUnlock = async (res) => {
      state.vaultToken = res.token;
      state.vaultTimerSec = res.expires_in || 900;
      state.vaultAuthMethod = res.auth_method || "";
      closeVaultModal();
      toast(`🔓 验证通过！密码保险箱已解锁 ${Math.round(state.vaultTimerSec / 60)} 分钟`, "success");
      await reloadData();
      if (typeof pendingAfterUnlock === "function") {
        const cb = pendingAfterUnlock;
        pendingAfterUnlock = null;
        await cb();
      } else if (currentDrawerRerender && !document.getElementById("drawer-panel").classList.contains("hidden")) {
        currentDrawerRerender();
      }
    };

    const otpInput = document.getElementById("vault-otp-input");
    if (otpInput) {
      otpInput.focus();
      const submitOtp = async () => {
        const code = otpInput.value.trim();
        const lockProd = Boolean(document.getElementById("chk-lock-prod-bind") && document.getElementById("chk-lock-prod-bind").checked);
        try {
          const res = await apiCall("/api/vault/unlock-totp", "POST", { code, lock_production_bind: lockProd });
          await finishUnlock(res);
        } catch (e) {
          showModalErr(e.message);
        }
      };
      document.getElementById("btn-vault-verify-otp").onclick = submitOtp;
      otpInput.onkeydown = (ev) => {
        if (ev.key === "Enter") submitOtp();
      };

      const fillBtn = document.getElementById("btn-fill-demo-otp");
      if (fillBtn) {
        fillBtn.onclick = () => {
          otpInput.value = fillBtn.dataset.demoCode || "";
          otpInput.focus();
        };
      }
    }

    const rotateBtn = document.getElementById("btn-rotate-totp");
    if (rotateBtn) {
      rotateBtn.onclick = async () => {
        if (!window.confirm("重新生成将使旧二维码密钥失效，需用 iPhone 重新扫描新二维码。是否继续？")) return;
        try {
          await apiCall("/api/vault/rotate-totp", "POST", {});
          toast("已生成全新 160-bit TOTP 密钥二维码", "success");
          await reloadData();
          await openVaultUnlockModal(pendingAfterUnlock, "setup");
        } catch (e) {
          showModalErr(e.message);
        }
      };
    }

    const regBtn = document.getElementById("btn-passkey-reg");
    if (regBtn) {
      regBtn.onclick = async () => {
        try {
          const chRes = await apiCall("/api/vault/webauthn/challenge", "POST", { purpose: "register" });
          const ch = chRes.data;
          const cred = await navigator.credentials.create({
            publicKey: {
              challenge: b64uToUint8(ch.challenge),
              rp: { name: "AnchorLedger 老板全量台账", id: window.location.hostname },
              user: {
                id: new TextEncoder().encode("boss_primary_vault"),
                name: "boss@example.invalid",
                displayName: "老板主控密码保险箱"
              },
              pubKeyCredParams: [
                { type: "public-key", alg: -7 },
                { type: "public-key", alg: -257 }
              ],
              authenticatorSelection: {
                userVerification: "preferred",
                residentKey: "preferred"
              },
              timeout: 90000
            }
          });
          const verRes = await apiCall("/api/vault/webauthn/verify", "POST", {
            purpose: "register",
            challenge_id: ch.challenge_id,
            cred_id: bufToB64u(cred.rawId),
            client_data_json: bufToB64u(cred.response.clientDataJSON),
            label: "老板 iPhone FaceID / Mac 通行密钥"
          });
          await finishUnlock(verRes);
        } catch (e) {
          showModalErr(e.message || "已取消扫码或通行密钥注册未完成");
        }
      };
    }

    const authBtn = document.getElementById("btn-passkey-auth");
    if (authBtn) {
      authBtn.onclick = async () => {
        try {
          const chRes = await apiCall("/api/vault/webauthn/challenge", "POST", { purpose: "authenticate" });
          const ch = chRes.data;
          const assertion = await navigator.credentials.get({
            publicKey: {
              challenge: b64uToUint8(ch.challenge),
              rpId: window.location.hostname,
              allowCredentials: ch.cred_id ? [{ type: "public-key", id: b64uToUint8(ch.cred_id) }] : [],
              userVerification: "preferred",
              timeout: 90000
            }
          });
          const verRes = await apiCall("/api/vault/webauthn/verify", "POST", {
            purpose: "authenticate",
            challenge_id: ch.challenge_id,
            cred_id: bufToB64u(assertion.rawId),
            client_data_json: bufToB64u(assertion.response.clientDataJSON)
          });
          await finishUnlock(verRes);
        } catch (e) {
          showModalErr(e.message || "已取消扫码或通行密钥验证未完成");
        }
      };
    }
  }

  async function openVaultFormDrawer(existingItem = null, preset = null) {
    if (!isVaultUnlocked()) {
      openVaultUnlockModal(() => openVaultFormDrawer(existingItem, preset));
      return;
    }

    let decrypted = null;
    if (existingItem) {
      decrypted = state.revealedSecrets[existingItem.id] || (await revealVaultSecret(existingItem.id));
    }
    const init = existingItem || preset || {};
    const lpOpts = (state.boot.legal_persons || []).map((x) => ({ v: x.id, l: x.name }));

    const bodyHtml = `
      <div id="vault-form-err" class="form-error-box hidden"></div>
      <form id="vault-record-form" class="form-grid">
        <div class="form-field">
          <label>密码分类 *</label>
          <select name="category" class="select-control">
            ${VAULT_CAT_META.map((m) => `<option value="${esc(m.key)}" ${(init.category || "platform") === m.key ? "selected" : ""}>${esc(m.title)}</option>`).join("")}
          </select>
        </div>
        <div class="form-field">
          <label>委托客户视角</label>
          <select name="legal_person_id" class="select-control">
            <option value="">-- 公共底层基础设施 --</option>
            ${lpOpts.map((o) => `<option value="${esc(o.v)}" ${(init.legal_person_id || "lp-demo-a") === o.v ? "selected" : ""}>${esc(o.l)}</option>`).join("")}
          </select>
        </div>
        <div class="form-field span-2">
          <label>业务条目标题 *</label>
          <input name="title" class="input-control" value="${esc(init.title || "")}" placeholder="如：ENT-LJG-01 · 电子税务局 / XHS-S-01 · 小红书小店" required />
        </div>
        <div class="form-field">
          <label>登录账号 / 税号 / 手机号 *</label>
          <input name="login_account" class="input-control mono" value="${esc(init.login_account || "")}" required />
        </div>
        <div class="form-field">
          <label>登录密码（落库自动加密为 ENCv1 密文）*</label>
          <input name="login_password" class="input-control mono" value="${esc(decrypted ? decrypted.login_password : "")}" placeholder="输入明文，后端立即独立随机盐加密" />
        </div>
        <div class="form-field">
          <label>二级密码名称</label>
          <input name="secondary_label" class="input-control" value="${esc(init.secondary_label || "支付/交易密码")}" />
        </div>
        <div class="form-field">
          <label>二级密码 / 6位支付盾密 / PIN</label>
          <input name="secondary_password" class="input-control mono" value="${esc(decrypted ? decrypted.secondary_password : "")}" placeholder="选填，独立加密存储" />
        </div>
        <div class="form-field span-2">
          <label>子账号自带 2FA TOTP Base32 种子（选填，填入后可直接在台账代算6位动态码）</label>
          <input name="account_totp_secret" class="input-control mono" value="${esc(decrypted ? decrypted.account_totp_secret : "")}" placeholder="如 在本地验证器生成后填写（选填）" />
        </div>
        <div class="form-field span-2">
          <label>加密安全备注（子邮箱密码 / 找回问题 / 盾口令说明）</label>
          <input name="recovery_note" class="input-control" value="${esc(decrypted ? decrypted.recovery_note : "")}" placeholder="此备注同样全密文加密存储" />
        </div>
        <input type="hidden" name="target_table" value="${esc(init.target_table || "")}" />
        <input type="hidden" name="target_id" value="${esc(init.target_id || "")}" />
      </form>
    `;

    const footerHtml = `
      ${existingItem ? `<button type="button" class="btn btn-danger" id="btn-del-vault-item">删除此条密码</button>` : ""}
      <button type="button" class="btn btn-outline" id="btn-cancel-vault-form">取消</button>
      <button type="button" class="btn btn-primary" id="btn-save-vault-form">${existingItem ? "加密保存修改" : "确认加密入库"}</button>
    `;

    openDrawer(existingItem ? "编辑加密密钥" : "新增加密密钥", `${existingItem ? "编辑" : "新增"} · 密码保险箱条目`, bodyHtml, footerHtml);

    document.getElementById("btn-cancel-vault-form").onclick = closeDrawer;
    document.getElementById("btn-save-vault-form").onclick = async () => {
      const fd = new FormData(document.getElementById("vault-record-form"));
      const payload = {};
      for (const [k, v] of fd.entries()) payload[k] = v;
      if (existingItem) payload.id = existingItem.id;
      try {
        const res = await apiCall("/api/vault/save", "POST", payload);
        delete state.revealedSecrets[res.id];
        toast("已使用 ENCv1 认证加密写入密码库", "success");
        closeDrawer();
        await reloadData();
      } catch (e) {
        const errEl = document.getElementById("vault-form-err");
        errEl.textContent = "⛔ " + e.message;
        errEl.classList.remove("hidden");
      }
    };

    const delBtn = document.getElementById("btn-del-vault-item");
    if (delBtn && existingItem) {
      delBtn.onclick = async () => {
        if (!window.confirm("确认永久删除该条加密密码吗？")) return;
        try {
          await apiCall("/api/vault/delete", "POST", { id: existingItem.id });
          delete state.revealedSecrets[existingItem.id];
          toast("已删除该密码条目", "success");
          closeDrawer();
          await reloadData();
        } catch (e) {
          toast("⛔ " + e.message, "error");
        }
      };
    }
  }

  // 每秒刷新解锁倒计时，超时自动清空内存明文并上锁
  setInterval(() => {
    if (state.vaultToken && state.vaultTimerSec > 0) {
      state.vaultTimerSec -= 1;
      if (state.vaultTimerSec <= 0) {
        state.vaultToken = null;
        state.vaultTimerSec = 0;
        state.vaultAuthMethod = "";
        state.revealedSecrets = {};
        renderVaultTopbarBtn();
        renderSidebar();
        renderCurrentView();
        toast("🔒 密码库 15 分钟临时解锁已到期，已自动重新上锁", "info");
      } else {
        renderVaultTopbarBtn();
      }
    }
  }, 1000);

  // ==================== 16. 全局事件绑定 ====================
  function bindEvents() {
    document.getElementById("lp-filter").addEventListener("change", (e) => {
      state.lpFilter = e.target.value;
      renderSidebar();
      renderCurrentView();
    });

    document.getElementById("global-search").addEventListener("input", (e) => {
      state.search = e.target.value;
      renderSidebar();
      renderCurrentView();
    });

    document.getElementById("btn-vault-status").addEventListener("click", () => {
      if (isVaultUnlocked()) {
        lockVaultManual();
      } else {
        openVaultUnlockModal();
      }
    });

    document.getElementById("vault-modal-close").addEventListener("click", closeVaultModal);
    document.getElementById("vault-modal-backdrop").addEventListener("click", closeVaultModal);

    document.getElementById("btn-open-glossary").addEventListener("click", openGlossaryDrawer);

    document.getElementById("btn-toggle-mask").addEventListener("click", (e) => {
      state.masked = !state.masked;
      e.currentTarget.textContent = state.masked ? "🙈 脱敏模式" : "👁 明文模式";
      renderCurrentView();
    });

    document.getElementById("btn-quick-create").addEventListener("click", (e) => {
      e.stopPropagation();
      document.getElementById("quick-create-menu").classList.toggle("hidden");
      document.getElementById("export-menu").classList.add("hidden");
    });

    document.getElementById("btn-export-menu").addEventListener("click", (e) => {
      e.stopPropagation();
      document.getElementById("export-menu").classList.toggle("hidden");
      document.getElementById("quick-create-menu").classList.add("hidden");
    });

    document.getElementById("quick-create-menu").addEventListener("click", (e) => {
      const vBtn = e.target.closest("[data-create-vault]");
      if (vBtn) {
        openVaultFormDrawer(null, null);
        return;
      }
      const btn = e.target.closest("[data-create]");
      if (btn) openRecordFormDrawer(btn.dataset.create, null);
    });

    document.getElementById("btn-reset-demo").addEventListener("click", async () => {
      if (!window.confirm("确定重置回初始基准台账数据吗？")) return;
      await apiCall("/api/actions/reset-baseline", "POST", {});
      state.vaultToken = null;
      state.vaultTimerSec = 0;
      state.revealedSecrets = {};
      toast("已恢复初始基准数据", "success");
      await reloadData();
    });

    document.getElementById("drawer-close").addEventListener("click", closeDrawer);
    document.getElementById("drawer-backdrop").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        hideQTipPopover();
        closeVaultModal();
        closeDrawer();
      }
    });

    // 小问号 ? 悬停即看 + 点击固定
    document.body.addEventListener("mouseover", (e) => {
      const tipBtn = e.target.closest("[data-tip]");
      if (tipBtn && !pinnedTipBtn) {
        showQTipPopover(tipBtn, false);
      } else if (e.target.closest("#qtip-popover")) {
        clearTimeout(hoverHideTimer);
      }
    });

    document.body.addEventListener("mouseout", (e) => {
      const leavingTip = e.target.closest("[data-tip]") || e.target.closest("#qtip-popover");
      if (leavingTip && !pinnedTipBtn) {
        hoverHideTimer = setTimeout(hideQTipPopover, 180);
      }
    });

    document.addEventListener("click", (e) => {
      document.getElementById("quick-create-menu").classList.add("hidden");
      document.getElementById("export-menu").classList.add("hidden");
      if (!e.target.closest("[data-tip]") && !e.target.closest("#qtip-popover")) {
        hideQTipPopover();
      }
    });

    document.body.addEventListener("click", async (e) => {
      // 1. 优先拦截小问号点击（不冒泡触发卡片跳转或折叠）
      const tipBtn = e.target.closest("[data-tip]");
      if (tipBtn) {
        e.stopPropagation();
        if (pinnedTipBtn === tipBtn) hideQTipPopover();
        else showQTipPopover(tipBtn, true);
        return;
      }

      if (e.target.closest("#qtip-popover")) return;

      // 1B. 密码保险箱按钮动作
      const copyRawBtn = e.target.closest("[data-copy-raw]");
      if (copyRawBtn) {
        e.stopPropagation();
        await copyTextSafe(copyRawBtn.dataset.copyRaw, "账号/密钥");
        return;
      }

      const openVaultBtn = e.target.closest("[data-open-vault-modal]");
      if (openVaultBtn) {
        e.stopPropagation();
        const mode = openVaultBtn.dataset.openVaultModal;
        openVaultUnlockModal(null, mode === "1" ? null : mode);
        return;
      }

      const lockPageBtn = e.target.closest("#btn-vault-lock-page");
      if (lockPageBtn) {
        e.stopPropagation();
        await lockVaultManual();
        return;
      }

      const revealBtn = e.target.closest("[data-vault-reveal]");
      if (revealBtn) {
        e.stopPropagation();
        await revealVaultSecret(revealBtn.dataset.vaultReveal);
        return;
      }

      const hideBtn = e.target.closest("[data-vault-hide]");
      if (hideBtn) {
        e.stopPropagation();
        delete state.revealedSecrets[hideBtn.dataset.vaultHide];
        renderCurrentView();
        if (currentDrawerRerender && !document.getElementById("drawer-panel").classList.contains("hidden")) {
          currentDrawerRerender();
        }
        return;
      }

      const vCopyBtn = e.target.closest("[data-vault-copy]");
      if (vCopyBtn) {
        e.stopPropagation();
        await copyVaultSecretField(vCopyBtn.dataset.vaultCopy, vCopyBtn.dataset.copyField);
        return;
      }

      const vEditBtn = e.target.closest("[data-vault-edit]");
      if (vEditBtn) {
        e.stopPropagation();
        const item = ((state.boot.vault && state.boot.vault.items) || []).find((x) => x.id === vEditBtn.dataset.vaultEdit);
        if (item) openVaultFormDrawer(item, null);
        return;
      }

      const vCreateBtn = e.target.closest("[data-vault-create]");
      if (vCreateBtn) {
        e.stopPropagation();
        openVaultFormDrawer(null, null);
        return;
      }

      const vCreatePreset = e.target.closest("[data-vault-create-preset]");
      if (vCreatePreset) {
        e.stopPropagation();
        try {
          const preset = JSON.parse(vCreatePreset.dataset.vaultCreatePreset);
          openVaultFormDrawer(null, preset);
        } catch (_) {
          openVaultFormDrawer(null, null);
        }
        return;
      }

      const jumpVaultCat = e.target.closest("[data-jump-vault-cat]");
      if (jumpVaultCat) {
        e.stopPropagation();
        const cat = jumpVaultCat.dataset.jumpVaultCat;
        state.openFolds.add(`vault:${cat}`);
        state.view = "vault";
        renderSidebar();
        renderCurrentView();
        return;
      }

      // 2. 思维导图节点展开/折叠
      const mmToggle = e.target.closest("[data-mm-toggle]");
      if (mmToggle) {
        e.stopPropagation();
        const id = mmToggle.dataset.mmToggle;
        if (state.mmExpanded.has(id)) state.mmExpanded.delete(id);
        else state.mmExpanded.add(id);
        renderCurrentView();
        return;
      }

      const mmPreset = e.target.closest("[data-mm-preset]");
      if (mmPreset) {
        const p = mmPreset.dataset.mmPreset;
        const tree = buildMindMapData(getFilteredCollections());
        if (p === "trunk") {
          state.mmExpanded = new Set(["root"]);
        } else if (p === "level2") {
          state.mmExpanded = new Set(collectAllMmIds(tree, 2));
        } else if (p === "all") {
          state.mmExpanded = new Set(collectAllMmIds(tree, 6));
        } else if (p === "warn") {
          state.mmExpanded = collectWarnMmIds(tree);
        }
        renderCurrentView();
        return;
      }

      const homeModeBtn = e.target.closest("[data-home-mode]");
      if (homeModeBtn) {
        state.homeMode = homeModeBtn.dataset.homeMode;
        renderCurrentView();
        return;
      }

      // 3. 详情穿透与动作按钮（放在 fold-toggle 之前，避免折叠头内按钮触发收起）
      const openCreate = e.target.closest("[data-open-create]");
      if (openCreate) { e.stopPropagation(); openRecordFormDrawer(openCreate.dataset.openCreate, null); return; }

      const editBtn = e.target.closest("[data-edit-table]");
      if (editBtn) {
        e.stopPropagation();
        const tbl = editBtn.dataset.editTable;
        const rec = (state.boot[tbl] || []).find((r) => r.id === editBtn.dataset.editId);
        if (rec) openRecordFormDrawer(tbl, rec);
        return;
      }

      const delBtn = e.target.closest("[data-del-table]");
      if (delBtn) {
        e.stopPropagation();
        if (!window.confirm("确认删除该条记录吗？（若触发防关联保护将被自动拦截）")) return;
        try {
          await apiCall(`/api/records/${delBtn.dataset.delTable}/${delBtn.dataset.delId}`, "DELETE");
          toast("已删除", "success");
          await reloadData();
        } catch (err) {
          toast("⛔ " + err.message, "error");
        }
        return;
      }

      const detailPlat = e.target.closest("[data-detail-plat]");
      if (detailPlat) { openPlatDetailDrawer(detailPlat.dataset.detailPlat); return; }

      const detailDev = e.target.closest("[data-detail-device]");
      if (detailDev) { openDeviceDetailDrawer(detailDev.dataset.detailDevice); return; }

      const detailSim = e.target.closest("[data-detail-sim]");
      if (detailSim) { openSimDetailDrawer(detailSim.dataset.detailSim); return; }

      const detailPx = e.target.closest("[data-detail-proxy]");
      if (detailPx) { openProxyDetailDrawer(detailPx.dataset.detailProxy); return; }

      const renewPx = e.target.closest("[data-renew-proxy]");
      if (renewPx) {
        try {
          const r = await apiCall("/api/actions/proxy-renew", "POST", { proxy_ip_id: renewPx.dataset.renewProxy, months: 1 });
          toast(`已续期 1 个月，新到期日：${r.new_expires_at}`, "success");
          await reloadData();
        } catch (err) {
          toast(err.message, "error");
        }
        return;
      }

      const detailEnt = e.target.closest("[data-detail-entity]");
      if (detailEnt) { openEntityDetailDrawer(detailEnt.dataset.detailEntity); return; }

      const detailAli = e.target.closest("[data-detail-alipay]");
      if (detailAli) { openAlipayDetailDrawer(detailAli.dataset.detailAlipay); return; }

      // 4. 折叠面板开关 & 批量展开/收起
      const batchFold = e.target.closest("[data-batch-fold]");
      if (batchFold) {
        const ids = batchFold.dataset.batchFold.split(",").filter(Boolean);
        const open = batchFold.dataset.batchDir === "open";
        for (const id of ids) {
          if (open) state.openFolds.add(id);
          else state.openFolds.delete(id);
        }
        renderCurrentView();
        return;
      }

      const foldHead = e.target.closest("[data-fold-toggle]");
      if (foldHead) {
        const id = foldHead.dataset.foldToggle;
        if (state.openFolds.has(id)) state.openFolds.delete(id);
        else state.openFolds.add(id);
        renderCurrentView();
        return;
      }

      // 5. 导航与筛选切换
      const navBtn = e.target.closest("[data-nav]");
      if (navBtn) { state.view = navBtn.dataset.nav; renderSidebar(); renderCurrentView(); return; }

      const jumpCard = e.target.closest("[data-jump-view]");
      if (jumpCard) { state.view = jumpCard.dataset.jumpView; renderSidebar(); renderCurrentView(); return; }

      const aliSub = e.target.closest("[data-ali-sub]");
      if (aliSub) { state.alipaySubTab = aliSub.dataset.aliSub; renderCurrentView(); return; }

      const aliRole = e.target.closest("[data-ali-role]");
      if (aliRole) { state.alipayRole = aliRole.dataset.aliRole; renderCurrentView(); return; }

      const platGrp = e.target.closest("[data-plat-grp]");
      if (platGrp) { state.platGroupBy = platGrp.dataset.platGrp; renderCurrentView(); return; }

      const platR = e.target.closest("[data-plat-role]");
      if (platR) { state.platRole = platR.dataset.platRole; renderCurrentView(); return; }

      const netSub = e.target.closest("[data-net-sub]");
      if (netSub) { state.netSubTab = netSub.dataset.netSub; renderCurrentView(); return; }

      const drillBtn = e.target.closest("[data-drill]");
      if (drillBtn) { runGuardrailDrill(drillBtn.dataset.drill); return; }
    });
  }

  window.LedgerBridge = {
    state,
    esc,
    qTip,
    fenToYuan,
    fenToShortYuan,
    maskStr,
    matchLP,
    matchSearch,
    renderFoldCard,
    toast,
    apiCall,
    copyTextSafe,
    reloadData,
    renderCurrentView,
    renderSidebar,
    openDrawer,
    closeDrawer,
    isVaultUnlocked,
    openVaultUnlockModal,
  };

  bindEvents();
  if (window.LedgerPortals) {
    window.LedgerPortals.bindPortalEvents();
    window.LedgerPortals.updateTopbarPortalUI();
  }
  if (window.LedgerGovernance) {
    window.LedgerGovernance.bindGovernanceEvents();
  }
  if (window.LedgerHealth) {
    window.LedgerHealth.bindHealthEvents();
  }
  reloadData();
})();
