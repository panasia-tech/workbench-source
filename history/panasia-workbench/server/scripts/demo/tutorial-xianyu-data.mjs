// server/scripts/demo/tutorial-xianyu-data.mjs — 《闲鱼矩阵开店》教程内容
// 口径来源：用户 2026-10-02 三轮口述（P0 联通卡最前置 / 4 路线台账防呆 / 代办资质核验 / 4×3+2=14 槽位 / T+1 账单核实）

export const PROJECT = {
  name: '闲鱼矩阵开店',
  code: 'xianyu-matrix',
  description:
    '自营闲鱼矩阵开店全流程：联通卡与沃邮箱前置 → 4 本营业执照并行办理 → 14 槽位账号配置（4 本执照 × 3 闲鱼 + 3 企业支付宝 + 2 个人号）→ 支付产品验证与账单 API 核实。以路线台账为唯一事实源，全程防呆管控。',
  status: 'published',
  sort: 2,
};

export const STAGES = [
  {
    title: 'P0 环境准备（联通卡最前置）',
    description:
      '联通卡与沃邮箱是全流程最前置依赖，未办妥会卡住执照预留与企业支付宝注册；同步完成设备指纹环境与个人号注册。',
    duration_note: '当天完成',
    steps: [
      {
        title: '办理联通卡（99 元 200G，1 主 4 副）',
        guide:
          '1. 按 14 个账号槽位规划用号需求，办理联通大流量卡，标准套餐：99 元 / 月 / 200G，1 主 4 副；\n2. 每条执照路线的号码独立登记：主卡号码、副卡号码、办理营业厅、办理日期；\n3. 当天办卡当天激活，逐张拨打电话验证通话与流量正常；\n4. 号码清单同步登记到「路线台账」，后续所有账号注册均从台账取号，禁止随手拿卡。',
        warn_text:
          '联通卡是整个流程的最前置：没有预留电话，企业营业执照预留、企业支付宝注册都会被卡住。宁可人等号，不可号等人。',
        deliver_note: '联通卡全部办妥并激活，号码清单已入台账',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'accept_receipt',
            label: '营业厅办理凭证',
            input_type: 'image',
            required: true,
            help_text: '凭证拍照四角完整、字迹清晰',
          },
          {
            material_key: 'card_list',
            label: '号码清单',
            input_type: 'textarea',
            required: true,
            help_text: '每行一条：路线-主/副卡-号码-办理日期',
          },
        ],
      },
      {
        title: '开通沃邮箱（企业预留邮箱）',
        guide:
          '1. 用刚激活的联通号逐个开通沃邮箱，作为企业预留邮箱；\n2. 邮箱账号密码逐条登记到「路线台账」，与手机号一一绑定；\n3. 检查邮箱可正常收发验证邮件（给自己发一封测试邮件并确认收到）。',
        warn_text:
          '预留邮箱与预留电话同样前置：企业支付宝注册、执照办理登记都要求预留邮箱，缺少会被流程卡住。',
        deliver_note: '沃邮箱全部开通并测试收发正常，账号已入台账',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'email_list',
            label: '邮箱账号清单',
            input_type: 'textarea',
            required: true,
            help_text: '每行一条：路线-邮箱账号-绑定手机号',
          },
        ],
      },
      {
        title: '设备指纹软件 ADB 安装',
        guide:
          '1. 联系公司程序员（外部微信：z15859900434）获取灌录指纹软件安装包；\n2. 按程序员指导完成手机端 ADB 安装与授权；\n3. 每台开店手机灌录独立设备指纹，确保多账号之间不关联；\n4. 安装完成后逐台验证软件可正常启动，指纹信息与设备编号对应登记。',
        warn_text:
          '指纹软件由公司自研，安装与配置问题一律直接对接程序员，不要自行在网上找教程乱装。',
        deliver_note: '全部开店手机完成指纹灌录并验证',
        require_confirm: true,
        require_review: false,
        materials: [
          {
            material_key: 'install_proof',
            label: '安装成功截图',
            input_type: 'image',
            required: true,
            help_text: '指纹软件安装成功界面截图',
          },
        ],
      },
      {
        title: '注册 2 个个人闲鱼号',
        guide:
          '1. 用 2 个新手机号当天注册 2 个个人闲鱼账号，手机号从台账取；\n2. 个人号不挂营业执照，与 4 条执照路线分开，单独管理；\n3. 注册后完成基础资料与实名，记录账号与对应手机号到台账「个人号线」分区。',
        warn_text: null,
        deliver_note: '2 个个人闲鱼号注册完成，已入台账个人号分区',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'personal_accounts',
            label: '个人号登记',
            input_type: 'textarea',
            required: true,
            help_text: '每行一条：闲鱼号-手机号-注册日期',
          },
        ],
      },
    ],
  },
  {
    title: 'P1 营业执照办理（4 条路线并行）',
    description:
      '首批 4 本执照一起发起：1 本本地淘宝网店执照 + 3 本外地执照（园区任选）；台账先于办理建立，代办资质先于合作核实。',
    duration_note: '外地执照 3-5 天或约 1 周',
    steps: [
      {
        title: '建立 4 条路线台账（防呆前置）',
        guide:
          '1. 新建「路线台账」，预置 4 条路线：路线 1 = 本地淘宝网店执照；路线 2/3/4 = 外地执照（园区待选）；\n2. 每条路线登记栏位：执照主体、办理园区、代办方、经办人、手机号、沃邮箱、企业支付宝 ×3、闲鱼号 ×3；\n3. 后续每完成一项就回填台账，任何账号信息以台账为唯一事实源；\n4. 四条路线分开记录、分开执行，禁止混用电话、邮箱与设备。',
        warn_text: '前置台账必须先建好：没有台账就开工，后面 14 个账号一定会混淆不清。',
        deliver_note: '台账已建立并预置 4 条路线栏位',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'ledger_draft',
            label: '台账初稿',
            input_type: 'textarea',
            required: true,
            help_text: '粘贴台账结构或在线表格链接',
          },
        ],
      },
      {
        title: '核实代办资质并选定 3 个园区',
        guide:
          '1. 从园区池选定 3 个园区：湖北 300 元（约 1 周）、吉林 300 元（3-5 天）、贵州 300 元（3-5 天）、内蒙 300 元（约 1 周），3 本外地执照任选 3 个园区，鸡蛋不放在一个篮子里；\n2. 拓展园区渠道：① 公司提供的历史合作商微信（仅参考，不保证效果）；② 闲鱼搜「营业执照代办」比价；③ 抖音搜「闲鱼开店」看评论区广告，价格公道；\n3. 联系代办前，务必让对方出示其营业执照（企业服务资质证明），核验对方是正规企业服务公司，资质不符直接淘汰；\n4. 长期目标：园区池拓展到 10 个，分散园区稽查与倒查风险。',
        warn_text:
          '全国财务公司话术都一样——拍胸脯让你安心。不能听信对方的保证，要以史为鉴，只认资质和合同。',
        deliver_note: '3 个园区已选定，代办方资质已核验',
        require_confirm: false,
        require_review: true,
        materials: [
          {
            material_key: 'agent_license',
            label: '代办方营业执照',
            input_type: 'image',
            required: true,
            help_text: '务必清晰可辨，一张不合格再补一张',
          },
          {
            material_key: 'park_choice',
            label: '园区选择记录',
            input_type: 'textarea',
            required: true,
            help_text: '每行一条：路线-园区-报价-承诺时效-代办方名称',
          },
        ],
      },
      {
        title: '并行发起 4 本执照办理',
        guide:
          '1. 一次性并行发起 4 本执照：路线 1 本地淘宝网店执照 + 路线 2/3/4 外地执照，分开对接、分批执行；\n2. 每条路线的申请材料、预留电话（联通卡）、预留邮箱（沃邮箱）从台账取用，逐项核对后再提交；\n3. 提交后每 24 小时逐条跟进一次下证进度，进度更新到台账；\n4. 下证后立即拍照归档，执照信息（名称、统一社会信用代码、法定代表人）逐字核对无误后登记台账。',
        warn_text:
          '四条路线的材料分开存放、分开提交：装错一次就要重办。预留电话与邮箱务必用台账里该路线自己的，禁止跨路线借用。',
        deliver_note: '4 本执照全部下证并登记台账',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'license_receipts',
            label: '受理凭证 / 下证照片',
            input_type: 'image',
            required: true,
            help_text: '4 本执照的受理凭证或下证照片',
          },
        ],
      },
    ],
  },
  {
    title: 'P2 账号槽位配置（4×3+2=14）',
    description:
      '以营业执照为单位配置账号槽位：每本执照对应 3 个企业支付宝与 3 家闲鱼企业店，加 2 个个人号合计 14 个账号。',
    duration_note: '企业管家授权必须第 1 天法人环节完成',
    steps: [
      {
        title: '第 1 天法人环节：企业管家一键授权',
        guide:
          '1. 企业支付宝注册的第 1 天，趁法人在场：打开支付宝搜索「企业管家」，按引导完成一键授权管理员；\n2. 授权过程可能要求法人扫脸，务必现场完成，不要拖到事后补；\n3. 授权完成后确认管理员权限生效，截图归档并登记台账。',
        warn_text:
          '这一步必须在第 1 天法人环节做好：授权可能要扫脸，法人不在场就办不了，整条路线会被卡住。',
        deliver_note: '企业管家管理员授权完成',
        require_confirm: true,
        require_review: false,
        materials: [
          {
            material_key: 'authorize_proof',
            label: '授权成功截图',
            input_type: 'image',
            required: true,
            help_text: '企业管家授权成功页面截图',
          },
        ],
      },
      {
        title: '注册企业支付宝（每本执照 3 个）',
        guide:
          '1. 每本营业执照注册 3 个企业支付宝，4 本执照共 12 个企业支付宝账号；\n2. 每个企业支付宝的登录手机号、沃邮箱从台账对应路线取用，注册信息与执照信息严格一致；\n3. 注册完成后的凭证就是这些企业支付宝账号，在支付宝的「企业管家」里也能查看核对；\n4. 全部账号密码与绑定关系逐条登记台账。',
        warn_text:
          '账号凭证 = 企业支付宝账号，企业管家里可查。记账时按路线分组，禁止跨路线混记。',
        deliver_note: '12 个企业支付宝注册完成并入台账',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'alipay_accounts',
            label: '企业支付宝账号清单',
            input_type: 'textarea',
            required: true,
            help_text: '每行一条：路线-支付宝账号-绑定手机号',
          },
        ],
      },
      {
        title: '开设闲鱼企业店（每本执照 3 家）',
        guide:
          '1. 每个企业支付宝对应开设 1 家闲鱼企业店，每本执照 3 家共 12 家；加上 2 个个人号，闲鱼矩阵合计 14 个账号；\n2. 开店手机使用已灌录指纹的对应设备，账号与设备、号码、邮箱一一绑定，全部从台账取用；\n3. 完成店铺基础设置：头像、简介、保证金（如有）；\n4. 店铺 ID 与对应支付宝、执照逐条登记台账。',
        warn_text:
          '一台设备只跑一条路线的账号；设备、号码、邮箱、执照交叉混用会被平台风控判定关联，后果是整条路线连坐。',
        deliver_note: '12 家闲鱼企业店全部开设完成',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'store_list',
            label: '店铺清单',
            input_type: 'textarea',
            required: true,
            help_text: '每行一条：闲鱼店铺-支付宝账号-执照-设备编号',
          },
        ],
      },
      {
        title: '14 槽位映射表核对',
        guide:
          '1. 台账中形成 14 槽位映射总表：4 本执照 ×（3 企业支付宝 + 3 闲鱼店）+ 2 个人号，逐格填齐；\n2. 自查每一列无重复、无交叉：同一手机号 / 邮箱只允许出现在一条路线；\n3. 提交映射表给审核，确认通过后进入支付验证阶段。',
        warn_text: '映射表是后续所有运营与财务对账的唯一依据，错一格后面全是糊涂账。',
        deliver_note: '14 槽位映射表填写完整并通过审核',
        require_confirm: false,
        require_review: true,
        materials: [
          {
            material_key: 'slot_map',
            label: '槽位映射表',
            input_type: 'textarea',
            required: true,
            help_text: '粘贴 14 槽位映射表或在线表格链接',
          },
        ],
      },
    ],
  },
  {
    title: 'P3 支付验证与财务连通',
    description:
      '开通支付产品后做小额账单验证，并与程序员核实账单 API 与企业支付宝账号的一一对应关系——这对财务至关重要。',
    duration_note: '账单 T+1，次日完成核实',
    steps: [
      {
        title: '开通支付产品并做 0.xx 账单测试',
        guide:
          '1. 为每个企业支付宝开通支付产品（按平台引导逐个开通）；\n2. 每个账号在账单里输入 0.xx 元的小额金额做验证交易；\n3. 账单是 T+1 的：当天记账，次日出账单；\n4. 把每个账号的测试金额记录到台账，形成「账号-金额」对照。',
        warn_text:
          '测试金额必须每账号不同（0.01 / 0.02 / 0.03 …），否则次日账单无法区分是哪个账号。',
        deliver_note: '全部账号完成 0.xx 测试并记录金额对照',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'test_amounts',
            label: '测试金额对照',
            input_type: 'textarea',
            required: true,
            help_text: '每行一条：支付宝账号-测试金额',
          },
        ],
      },
      {
        title: '与程序员核实账单 API 对应关系',
        guide:
          '1. 联系公司程序员（外部微信：z15859900434），交代清楚账单 API 的账号映射需求：账单 API 必须与 12 个企业支付宝账号一一对应；\n2. 统筹软件会读取各账号账单做财务核算，对应关系错乱会直接污染财务数据；\n3. T+1 账单出来后，与程序员一起核对：API 侧拿到的每笔测试金额与台账「账号-金额」对照完全一致；\n4. 核对通过的账号在台账标记「账单已连通」。',
        warn_text:
          '账单 API 与企业支付宝账号对应错乱对财务是致命的：对不上账就要逐个账号人肉排查，损失的是财务和运营的时间。这一步没核实通过前，账单数据一律不得用于核算。',
        deliver_note: '程序员确认账单 API 与全部支付宝账号对应无误',
        require_confirm: true,
        require_review: true,
        materials: [
          {
            material_key: 'api_confirm',
            label: '核实结论',
            input_type: 'textarea',
            required: true,
            help_text: '已连通账号清单、核对人、核对日期',
          },
        ],
      },
    ],
  },
];

export const CASE = {
  client_name: '泛亚自营',
  owner_user_id: '1871790158440555',
};
