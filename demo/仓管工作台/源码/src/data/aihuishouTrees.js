// 爱回收回收估价问卷 → 泛亚仓管结构化逐项分级验货标准库（去报价化 · 保留分步折叠、判别图例、多选瑕疵自动汇总、未拆封独立分支）

function svgUri(svg) {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg.trim())
}

// 高清判别标准与查询方法图例（1:1 复刻爱回收录屏 E06 / E09 / E18 / E20 / E25 / E28 / E32 / E33）
export const AIHUISHOU_GUIDES = {
  apple_channel: {
    title: '购买渠道与官换/展示机查询方法（复刻爱回收标准）',
    rule: '路径：设置 → 通用 → 关于本机 → 型号号码。首字母“M...CH/A”为大陆国行零售机；“N...CH/A”为国行官换机；“...ZP/A”为港澳行货；“3”或数字开头为商场展示机。',
    img: svgUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 250">
        <rect width="460" height="250" rx="12" fill="#f8fafc"/>
        <rect x="24" y="20" width="185" height="210" rx="18" fill="#ffffff" stroke="#cbd5e1" stroke-width="2"/>
        <text x="116" y="48" text-anchor="middle" fill="#0f172a" font-family="sans-serif" font-size="13" font-weight="700">设置 › 通用 › 关于本机</text>
        <line x1="40" y1="60" x2="194" y2="60" stroke="#e2e8f0"/>
        <text x="42" y="86" fill="#64748b" font-size="11.5">名称</text><text x="190" y="86" text-anchor="end" fill="#0f172a" font-size="11.5">iPhone</text>
        <rect x="34" y="100" width="165" height="32" rx="6" fill="#eff6ff" stroke="#2563eb" stroke-width="1.5"/>
        <text x="42" y="120" fill="#1d4ed8" font-size="12" font-weight="700">型号号码</text>
        <text x="190" y="120" text-anchor="end" fill="#1d4ed8" font-family="monospace" font-size="12" font-weight="700">MTQ83CH/A</text>
        <text x="42" y="156" fill="#64748b" font-size="11.5">序列号</text><text x="190" y="156" text-anchor="end" fill="#0f172a" font-family="monospace" font-size="11">G6TZ90105X</text>
        <rect x="230" y="28" width="206" height="194" rx="10" fill="#0f172a"/>
        <text x="246" y="56" fill="#93c5fd" font-size="12.5" font-weight="700">型号首尾字母核验口诀：</text>
        <text x="246" y="84" fill="#f8fafc" font-size="12">• M 开头 + CH/A ＝ 大陆国行正机</text>
        <text x="246" y="110" fill="#fcd34d" font-size="12">• N 开头 + CH/A ＝ 官方售后官换机</text>
        <text x="246" y="136" fill="#f8fafc" font-size="12">• ZP/A 结尾 ＝ 港澳行货版本</text>
        <text x="246" y="162" fill="#fca5a5" font-size="12">• 3 / 数字开头 ＝ 柜台展示机</text>
        <text x="246" y="196" fill="#94a3b8" font-size="11">若卖家报零售机实为官换/展示机，须记异常</text>
      </svg>
    `)
  },
  phone_frame_dent: {
    title: '外壳磕碰掉漆 vs 轻微划痕判别标尺',
    rule: '判别红线：屏幕上存在密集 >2cm 长划痕，或机身边框存在直径 >0.5cm 的磕碰掉漆凹坑，即归入「明显磕碰/掉漆」并必拍微距特写。',
    img: svgUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 250">
        <rect width="460" height="250" rx="12" fill="#18181b"/>
        <path d="M50 160 Q50 75 140 75 L390 75 L390 190 L50 190 Z" fill="#cbd5e1" stroke="#94a3b8" stroke-width="3"/>
        <rect x="68" y="82" width="310" height="32" rx="8" fill="#0f172a"/>
        <ellipse cx="165" cy="148" rx="22" ry="11" fill="#475569"/>
        <circle cx="165" cy="148" r="48" fill="none" stroke="#ffffff" stroke-width="3"/>
        <rect x="34" y="132" width="96" height="34" rx="8" fill="#09090b" opacity="0.82"/>
        <text x="82" y="154" text-anchor="middle" fill="#ffffff" font-size="15" font-weight="700">磕碰掉漆 •</text>
        <line x1="143" y1="210" x2="187" y2="210" stroke="#ef4444" stroke-width="2.5"/>
        <text x="165" y="230" text-anchor="middle" fill="#fca5a5" font-size="12" font-weight="700">直径 &gt; 0.5cm 凹坑掉漆（必拍微距）</text>
      </svg>
    `)
  },
  sealed_check: {
    title: '全新未拆封防“后封机”核验规范',
    rule: '不能把卖家口头“未拆封”直接等同于完好二手机！未拆封分支必须核验：原厂上下撕拉封条纤维防伪、包装盒三码与官网未激活状态、精准电子秤克重比对。一旦已开封则必须切回二手机全检分支！',
    img: svgUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 250">
        <rect width="460" height="250" rx="12" fill="#f1f5f9"/>
        <rect x="52" y="34" width="160" height="182" rx="10" fill="#ffffff" stroke="#64748b" stroke-width="2"/>
        <rect x="66" y="54" width="132" height="18" rx="4" fill="#dcfce7" stroke="#16a34a" stroke-width="1.5"/>
        <text x="132" y="67" text-anchor="middle" fill="#166534" font-size="10.5" font-weight="700">✓ 原厂拉链封条完好平整</text>
        <rect x="66" y="168" width="132" height="18" rx="4" fill="#dcfce7" stroke="#16a34a" stroke-width="1.5"/>
        <text x="132" y="181" text-anchor="middle" fill="#166534" font-size="10.5" font-weight="700">✓ 底部封签无二次胶痕</text>
        <rect x="242" y="34" width="184" height="182" rx="10" fill="#ffffff" stroke="#cbd5e1"/>
        <text x="258" y="64" fill="#0f172a" font-size="13" font-weight="700">未拆封三必查（不拆膜）：</text>
        <text x="258" y="94" fill="#334155" font-size="12">1. 官网查 SN：未激活状态</text>
        <text x="258" y="122" fill="#334155" font-size="12">2. 电子秤复重：误差 ≤ ±2g</text>
        <text x="258" y="150" fill="#334155" font-size="12">3. 紫外灯照封签：无热吹风翘边</text>
        <text x="258" y="186" fill="#b91c1c" font-size="11.5" font-weight="700">⚠ 凡封条已断一律按二手机全检</text>
      </svg>
    `)
  },
  monitor_back_scratch: {
    title: '显示器边框背板划痕判别标准（复刻 HKC 录屏 E28）',
    rule: '迎光 45° 检视背壳与四周边框：存在长度 >1cm 肉眼清晰可见擦痕或支架安装刮痕即选「外壳划痕」；卡扣断裂或壳体开裂选「外壳破损」。',
    img: svgUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 250">
        <rect width="460" height="250" rx="12" fill="#e2e8f0"/>
        <rect x="78" y="24" width="304" height="166" rx="6" fill="#1e293b"/>
        <rect x="208" y="72" width="44" height="142" fill="#cbd5e1"/>
        <rect x="164" y="210" width="132" height="10" rx="3" fill="#94a3b8"/>
        <circle cx="152" cy="108" r="54" fill="#334155" stroke="#ffffff" stroke-width="3"/>
        <path d="M118 88 Q148 104 176 132" stroke="#020617" stroke-width="2.5" fill="none"/>
        <rect x="192" y="92" width="88" height="36" rx="10" fill="#09090b" opacity="0.85"/>
        <text x="236" y="115" text-anchor="middle" fill="#ffffff" font-size="16" font-weight="700">• 划痕 &gt;1cm</text>
      </svg>
    `)
  },
  monitor_screen_fault: {
    title: '显示器屏幕通电显示分级标准（复刻录屏 E32 / E33）',
    rule: '纯白/纯黑/红绿蓝五色全屏切换检视：0坏点无白斑为「显示完好」；1~2颗暗点或轻微漏光为「轻微背光/暗点」；彩色竖线、漏液黑块、花屏闪屏归入严重显示故障并必拍特写。',
    img: svgUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 250">
        <rect width="460" height="250" rx="12" fill="#f8fafc"/>
        <rect x="30" y="34" width="184" height="114" rx="5" fill="#0f172a"/>
        <rect x="36" y="40" width="172" height="100" fill="#38bdf8"/>
        <circle cx="84" cy="86" r="14" fill="#0284c7" stroke="#fff" stroke-width="1.5"/>
        <text x="122" y="172" text-anchor="middle" fill="#b45309" font-size="12" font-weight="700">轻微背光 / 暗点漏光</text>
        <rect x="246" y="34" width="184" height="114" rx="5" fill="#0f172a"/>
        <rect x="252" y="40" width="172" height="100" fill="#1d4ed8"/>
        <line x1="296" y1="40" x2="296" y2="140" stroke="#ef4444" stroke-width="3"/>
        <line x1="348" y1="40" x2="348" y2="140" stroke="#22c55e" stroke-width="3"/>
        <circle cx="390" cy="70" r="22" fill="#020617"/>
        <text x="338" y="172" text-anchor="middle" fill="#dc2626" font-size="12" font-weight="700">漏液黑斑 / 竖线 / 花屏</text>
        <text x="230" y="216" text-anchor="middle" fill="#475569" font-size="11.5">注意：验屏幕坏点必须切纯色背景拍微距，严禁用风景壁纸冒充完美屏</text>
      </svg>
    `)
  }
}

// 四大品类爱回收式分步验货问卷定义（支持未拆封分支 + 分级单选 + 多选异常汇总 + 无法检测兜底）
export const AIHUISHOU_TREES = {
  'STD-PHONE': {
    stdId: 'STD-PHONE',
    category: '智能手机',
    version: 'v3.0-AHS',
    baselineStats: {
      crawledModels: 1042,
      baselineModel: 'iPhone 16 Pro Max / 小米 15 Ultra（二手已使用最长超集 8 大步 + 未拆封独立 4 步分支）',
      mergedUniqueItems: '已并入潜望长焦防抖、相机控制电容键、ESIM/双卡信号、气密性拆修核验等跨机型独有项'
    },
    entryStep: {
      key: 'usage_mode',
      title: '1. 使用情况与拆封状态（决定后续适用检查分支）',
      guideKey: 'sealed_check',
      options: [
        { val: 'USED_OK', label: '正常开机进入桌面（二手已使用机）', desc: '开机顺畅无激活锁，展开完整二手机逐项分级全检', isDefect: false },
        { val: 'SEALED_NEW', label: '全新包装未拆封（原厂封条完好）', desc: '严禁直接默认内部完好！切换至「未拆封防后封 4 步核验分支」', isDefect: false },
        { val: 'BOOT_FAIL', label: '无法开机 / 离开充电断电 / 激活锁未退', desc: '记核心阻断瑕疵，同时仍须完成外观/镜头玻璃/卡托等安全项全检', isDefect: true, gradeCap: '故障/隔离件' }
      ]
    },
    sealedSteps: [
      {
        key: 'seal_strip',
        title: '2. 原厂上下封条与塑封防后封核验',
        guideKey: 'sealed_check',
        options: [
          { val: 'SEAL_ORIG', label: '原厂拉链封签平整无二次胶痕（UV灯核验通过）', isDefect: false },
          { val: 'SEAL_DOUBT', label: '封签有翘边/二次热缩膜嫌疑（疑似后封机）', isDefect: true },
          { val: 'UNABLE', label: '! 当前无法判定（需主管紫外灯复核）', isUnable: true }
        ]
      },
      {
        key: 'seal_sn',
        title: '3. 包装盒序列号与官网激活状态核查',
        guideKey: 'apple_channel',
        options: [
          { val: 'SN_UNACTIVATED', label: '盒标型号/容量与采购单一致，官网查为「未激活」', isDefect: false },
          { val: 'SN_ACTIVATED', label: '官网查询已激活或容量/版本与申报不符（货不对版）', isDefect: true }
        ]
      },
      {
        key: 'seal_weight',
        title: '4. 精密电子秤整盒克重与摇晃异响核验',
        options: [
          { val: 'WEIGHT_OK', label: '整盒克重符合官方标称（±2g内），轻晃无异物松动', isDefect: false },
          { val: 'WEIGHT_ABNORMAL', label: '克重明显偏差或盒内异响（高度疑似调包空盒）', isDefect: true }
        ]
      },
      {
        key: 'seal_box',
        title: '5. 原厂彩盒八角品相分级',
        options: [
          { val: 'BOX_PERFECT', label: '八角尖尖无压痕污渍（准充新礼品级）', isDefect: false },
          { val: 'BOX_DENT', label: '外盒边角有快递挤压折痕（封条未断）', isDefect: true }
        ]
      }
    ],
    usedSteps: [
      {
        key: 'channel_ver',
        title: '2. 购买渠道与型号版本（核对关于本机）',
        guideKey: 'apple_channel',
        options: [
          { val: 'CN_RETAIL', label: '大陆国行零售机（M...CH/A 或国行入网标）', isDefect: false },
          { val: 'CN_REPLACE', label: '国行官换机 / 官方翻新机（N/F...CH/A）', isDefect: true },
          { val: 'HK_OVERSEA', label: '港澳版 / 海外有锁或无锁版（ZP/LL 等）', isDefect: true },
          { val: 'DEMO_UNIT', label: '数字开头柜台展示机 / 监管锁机', isDefect: true }
        ]
      },
      {
        key: 'storage_match',
        title: '3. 存储容量、运行内存与机身颜色核对',
        options: [
          { val: 'SPEC_MATCH', label: '容量/内存/官方配色与原采购单申报 100% 一致', isDefect: false },
          { val: 'SPEC_MISMATCH', label: '实机容量或配色与卖家申报不符（货不对版！）', isDefect: true },
          { val: 'UNABLE', label: '! 不开机暂无法读容量（待通电补核）', isUnable: true }
        ]
      },
      {
        key: 'battery_health',
        title: '4. 电池健康度与充电循环实测',
        options: [
          { val: 'BAT_95_100', label: '电池原装且健康度 95%～100%', isDefect: false },
          { val: 'BAT_85_94', label: '电池原装且健康度 85%～94%（正常二手损耗）', isDefect: false },
          { val: 'BAT_80_84', label: '电池健康度 80%～84%（偏低需销售披露）', isDefect: true },
          { val: 'BAT_LOW_REPAIR', label: '低于 80% / 提示维修 / 第三方非原装更换电池', isDefect: true },
          { val: 'UNABLE', label: '! 当前无法读取电池健康度', isUnable: true }
        ]
      },
      {
        key: 'body_grade',
        title: '5. 外观成色分级（外壳 + 外屏玻璃迎光检视）',
        guideKey: 'phone_frame_dent',
        options: [
          { val: 'BODY_PERFECT', label: '机器屏幕和外壳完好（充新无任何痕迹）', isDefect: false, suggestGrade: '99新·充新' },
          { val: 'BODY_FINE', label: '外壳完好，屏幕仅迎光细微使用痕迹', isDefect: false, suggestGrade: '98新·准新' },
          { val: 'BODY_LIGHT', label: '外壳或屏幕有轻微划痕 / 小擦碰（≤2mm）', isDefect: true, suggestGrade: '95新·微瑕' },
          { val: 'BODY_HEAVY', label: '外壳明显磕碰/掉漆（>0.5cm），或屏幕明显长划痕（>2cm）', isDefect: true, suggestGrade: '9成新·明显磕划' },
          { val: 'BODY_CRACK', label: '外屏碎裂/缺角、背板玻璃碎裂或机身弯曲变形【有其一】', isDefect: true, suggestGrade: '碎屏/结构受损隔离' }
        ]
      },
      {
        key: 'screen_display',
        title: '6. 屏幕通电显示与全屏触控（纯白/纯黑最高亮度）',
        options: [
          { val: 'DISP_PERFECT', label: '显示完美无瑕疵，原彩与全屏边缘触控顺畅', isDefect: false },
          { val: 'DISP_SLIGHT', label: '轻微色差 / 边缘轻微发黄 / 极小亮斑', isDefect: true },
          { val: 'DISP_BURNIN', label: '轻微烧屏透图图标残影 / 1～2颗小黑点', isDefect: true },
          { val: 'DISP_BROKEN', label: '严重烧屏 / 漏液黑块 / 绿线竖线 / 花屏断触', isDefect: true },
          { val: 'UNABLE', label: '! 因不开机当前无法测内屏显示', isUnable: true }
        ]
      },
      {
        key: 'camera_repair',
        title: '7. 摄像头模组与拆修/进水情况',
        options: [
          { val: 'CAM_ORIG', label: '全原无拆修，前后摄 1x/3x/5x 对焦防抖清晰无斑', isDefect: false },
          { val: 'CAM_OFFICIAL', label: '有官方售后维修记录，当前拍照录像全正常', isDefect: true },
          { val: 'CAM_DEFECT', label: '第三方拆修痕迹 / 镜头进灰黑斑抖动 / 防尘防水标变红', isDefect: true },
          { val: 'UNABLE', label: '! 当前无法测试相机模组', isUnable: true }
        ]
      }
    ],
    multiFaultsTitle: '8. 细分功能情况（存在异常请多选；若全部正常必须点「确认实测全正常」）',
    multiFaults: [
      { code: 'F_WIFI_BT', label: 'WIFI / 蓝牙连接异常或信号弱' },
      { code: 'F_SIM_CALL', label: '插卡无信号 / 无法通话 / ESIM占用' },
      { code: 'F_AUDIO', label: '无声或破音杂音（听筒 / 外放扬声器 / 录音麦克风）' },
      { code: 'F_CHARGE', label: '有线快充 / 无线充电无反应或尾插接触不良' },
      { code: 'F_BIO', label: '面容 FaceID / 指纹解锁失灵无法录入' },
      { code: 'F_SENSOR_BTN', label: '静音键 / 相机控制键 / 指南针陀螺仪失灵' }
    ]
  },

  'STD-MON': {
    stdId: 'STD-MON',
    category: '显示器',
    version: 'v3.0-AHS',
    baselineStats: {
      crawledModels: 386,
      baselineModel: 'HKC G25H4 / 飞利浦 27M2N5510P（爱回收显示器问卷 + 泛亚纯色测屏&附件袋超集 8 步）',
      mergedUniqueItems: '融合爱回收「多选明显瑕疵自动汇总」+ 泛亚「高刷实测、编号附件袋 #BAG 与独立原盒 #BOX 绑定」'
    },
    entryStep: {
      key: 'usage_mode',
      title: '1. 通电状态与拆封情况',
      options: [
        { val: 'USED_OK', label: '正常通电点亮进入 OSD 菜单（二手已使用显示器）', desc: '展开边框、支架、息屏表面、五色纯屏、接口配件完整 8 步全检', isDefect: false },
        { val: 'SEALED_NEW', label: '原厂彩盒封条未拆封（全新未开箱）', desc: '核验原厂封条、铭牌型号尾缀与外箱破损情况', isDefect: false },
        { val: 'BOOT_FAIL', label: '通电黑屏不亮 / 反复重启 / 电源板烧毁', desc: '记核心故障，仍须继续检查外屏玻璃是否压碎及配件是否齐全', isDefect: true }
      ]
    },
    sealedSteps: [
      {
        key: 'mon_seal_strip',
        title: '2. 原厂封箱胶带与外箱铭牌尾缀核验',
        options: [
          { val: 'SEAL_OK', label: '原厂封箱条完好无重贴，外箱铭牌型号/刷新率与采购单一致', isDefect: false },
          { val: 'SEAL_DIFF', label: '封条破损重贴或外箱型号尾缀不符（如 5500 错发）', isDefect: true }
        ]
      },
      {
        key: 'mon_seal_box',
        title: '3. 外箱六面抗压完整性（防暗碎屏）',
        options: [
          { val: 'CARTON_OK', label: '外箱六面平整无穿孔踩踏痕', isDefect: false },
          { val: 'CARTON_HIT', label: '外箱正面有撞击凹坑（须申请录制开箱验屏防内碎）', isDefect: true }
        ]
      }
    ],
    usedSteps: [
      {
        key: 'frame_back',
        title: '2. 边框与背板成色（含铭牌型号尺寸核实）',
        guideKey: 'monitor_back_scratch',
        options: [
          { val: 'SHELL_OK', label: '外壳完好无明显擦痕，背部铭牌型号尺寸与申报一致', isDefect: false, suggestGrade: '99新·充新' },
          { val: 'SHELL_SCRATCH', label: '外壳划痕（背板或边框划痕长度 >1cm）', isDefect: true, suggestGrade: '95新·微瑕' },
          { val: 'SHELL_DENT', label: '外壳磕碰 / 掉漆 / 边角磨白', isDefect: true, suggestGrade: '9成新·磕划' },
          { val: 'SHELL_WRONG_MODEL', label: '实机尺寸/型号与卖家申报不符（如报27寸实发24寸·货不对版！）', isDefect: true, suggestGrade: '货不对版隔离' }
        ]
      },
      {
        key: 'stand_base',
        title: '3. 底座与升降旋转支架',
        options: [
          { val: 'STAND_OK', label: '底座支架正常（升降/俯仰阻尼稳固、卡扣螺丝齐）', isDefect: false },
          { val: 'STAND_WEAR', label: '底座轻微划痕或升降阻尼偏松', isDefect: true },
          { val: 'STAND_MISSING', label: '缺原装底座支架（仅裸屏需配悬臂）', isDefect: true }
        ]
      },
      {
        key: 'panel_surface',
        title: '4. 屏幕外表面（息屏侧光 45° 检查外膜涂层）',
        options: [
          { val: 'SURF_OK', label: '屏幕外表面完好，无硬划痕无脱膜', isDefect: false },
          { val: 'SURF_HAIRLINE', label: '极细微擦痕（通电亮屏状态下完全不可见）', isDefect: false },
          { val: 'SURF_SCRATCH', label: '屏幕明显划痕或防眩光涂层脱落（亮屏可见白痕）', isDefect: true },
          { val: 'SURF_CRACK', label: '屏幕外玻璃压伤 / 碎裂', isDefect: true }
        ]
      },
      {
        key: 'panel_display',
        title: '5. 屏幕通电显示（纯白/纯黑/RGB 五色轮播检视）',
        guideKey: 'monitor_screen_fault',
        options: [
          { val: 'MON_DISP_OK', label: '显示完好（0亮暗坏点、无明显漏光、标称高刷稳定）', isDefect: false },
          { val: 'MON_DISP_MINOR', label: '轻微背光不均、1～2颗暗点或暗室边缘轻微漏光', isDefect: true },
          { val: 'MON_DISP_HEAVY_BL', label: '严重背光暗带 / 大面积白斑亮斑 / 阴阳屏', isDefect: true },
          { val: 'MON_DISP_BROKEN', label: '漏液黑块、花屏、彩色竖线/断线（有其一）', isDefect: true },
          { val: 'UNABLE', label: '! 缺对应高压电源暂无法点亮测屏', isUnable: true }
        ]
      },
      {
        key: 'accessories_kit',
        title: '6. 随箱配件清点（装入编号附件袋打印 #BAG 副码）',
        options: [
          { val: 'ACC_FULL', label: '配件齐全（原装匹配功率电源适配器 + DP/HDMI信号线）', isDefect: false },
          { val: 'ACC_PARTIAL', label: '配件不全（缺高清信号线，或配非原装兼容电源）', isDefect: true },
          { val: 'ACC_NONE', label: '无电源无线材裸机', isDefect: true }
        ]
      },
      {
        key: 'orig_box',
        title: '7. 原装包装情况（完好原盒独立打 #BOX 副码建账）',
        options: [
          { val: 'PACK_ORIG', label: '有完好原包装彩盒 + 原厂保丽龙泡沫内衬', isDefect: false },
          { val: 'PACK_NONE', label: '无原包装或普通黄纸箱/破损外箱', isDefect: false }
        ]
      }
    ],
    multiFaultsTitle: '8. 功能与接口情况（存在异常请多选；若全部正常必须点「确认实测全正常」）',
    multiFaults: [
      { code: 'M_BTN_PORT', label: 'OSD摇杆按键失灵 / HDMI或DP接口接触不良 / 指示灯异常' },
      { code: 'M_HIGH_HZ', label: '开启标称最高刷新率（180Hz/240Hz）黑屏闪屏跳帧' },
      { code: 'M_SPEAKER', label: '内置音箱破音或 3.5mm 音频口无声' },
      { code: 'M_TYPEC_USB', label: 'Type-C 反向供电或 USB Hub 下行口失灵' }
    ]
  },

  'STD-AUDIO': {
    stdId: 'STD-AUDIO',
    category: '蓝牙/智能音响',
    version: 'v2.5-AHS',
    baselineStats: {
      crawledModels: 168,
      baselineModel: 'Marshall Stanmore III / B&O Beolit 20（声学+防伪超集 6 步）',
      mergedUniqueItems: '包含马歇尔 App 正品连机防伪识别、20Hz-200Hz 低频扫频破音检测'
    },
    entryStep: {
      key: 'usage_mode',
      title: '1. 通电状态与防伪识别',
      options: [
        { val: 'USED_OK', label: '正常通电开机，官方 App / 序列号防伪核验正品', desc: '继续外观蒙皮网罩与声学全检', isDefect: false },
        { val: 'FAKE_OR_DEAD', label: '无法通电 或 疑似高仿假货无法连官方 App', desc: '记重大异常，仍拍齐外观铭牌留证', isDefect: true }
      ]
    },
    sealedSteps: [],
    usedSteps: [
      {
        key: 'audio_body',
        title: '2. 金属网罩、荔枝纹蒙皮与铜质旋钮外观',
        options: [
          { val: 'AU_BODY_OK', label: '网罩平整无凹、蒙皮完好无破皮、铜件无氧化', isDefect: false, suggestGrade: '98新·准新' },
          { val: 'AU_BODY_MINOR', label: '底部脚垫轻微磨损或旋钮细微氧化', isDefect: true, suggestGrade: '95新·微瑕' },
          { val: 'AU_BODY_DENT', label: '正面金属网罩凹陷掉漆 或 蒙皮磕破开胶', isDefect: true, suggestGrade: '瑕疵待议价' }
        ]
      },
      {
        key: 'audio_sound',
        title: '3. 高低音扫频与最大音量声学测试',
        options: [
          { val: 'AU_SND_OK', label: '高低音清晰饱满，80%以上大音量无破音无箱体共振', isDefect: false },
          { val: 'AU_SND_BUZZ', label: '低频共振杂音 / 喇叭破音偏音', isDefect: true }
        ]
      },
      {
        key: 'audio_acc',
        title: '4. 原装八字电源线与包装彩盒',
        options: [
          { val: 'AU_ACC_OK', label: '原装电源线 + 防伪原盒内衬齐全', isDefect: false },
          { val: 'AU_ACC_LACK', label: '缺原装线材或无原装外盒', isDefect: true }
        ]
      }
    ],
    multiFaultsTitle: '5. 连接与旋钮功能（多选异常；无异常请点确认全正常）',
    multiFaults: [
      { code: 'A_BT_DROP', label: '蓝牙 5 米内断连卡顿' },
      { code: 'A_AUX_RCA', label: 'AUX / RCA 有线音频口接触不良杂音' },
      { code: 'A_KNOB_LED', label: '高音/低音实体调节旋钮失灵或红格刻度灯不亮' }
    ]
  },

  'STD-CAM': {
    stdId: 'STD-CAM',
    category: '微单相机/镜头',
    version: 'v2.2-AHS',
    baselineStats: {
      crawledModels: 215,
      baselineModel: 'Sony A7M4 / 佳能 R6 II（影像机身最长超集 6 步）',
      mergedUniqueItems: '支持缺卡口测试镜头时显式挂起「当前无法检测」并指定补测责任人'
    },
    entryStep: {
      key: 'usage_mode',
      title: '1. 开机与快门数读取状态',
      options: [
        { val: 'USED_OK', label: '正常开机，底壳 SN 一致且成功读取机械快门次数', desc: '继续 CMOS、卡口防抖与卡槽全检', isDefect: false },
        { val: 'BOOT_FAIL', label: '不开机 / 快门帘卡死报错', desc: '记核心故障并拍齐证据', isDefect: true }
      ]
    },
    sealedSteps: [],
    usedSteps: [
      {
        key: 'cam_body',
        title: '2. 镁合金机身、蒙皮与热靴卡口成色',
        options: [
          { val: 'CM_BODY_OK', label: '机身无掉漆磕碰，蒙皮紧致无发白鼓包', isDefect: false, suggestGrade: '98新·准新' },
          { val: 'CM_BODY_WEAR', label: '底角三角环处轻微露白磨损（正常使用痕）', isDefect: true, suggestGrade: '95新·微瑕' },
          { val: 'CM_BODY_DENT', label: '机身磕碰变形或翻转屏转轴松旷', isDefect: true, suggestGrade: '9成新·磕碰' }
        ]
      },
      {
        key: 'cam_cmos',
        title: '3. CMOS 传感器表面与 EVF 取景器',
        options: [
          { val: 'CM_CMOS_OK', label: 'CMOS 洁净无划痕无霉斑无激光烧点，EVF/屏幕正常', isDefect: false },
          { val: 'CM_CMOS_BAD', label: 'CMOS 有划痕/霉丝/彩点（F16白墙可见死点）', isDefect: true }
        ]
      },
      {
        key: 'cam_mount',
        title: '4. 装镜头实测自动对焦、机身五轴防抖与光圈触点',
        options: [
          { val: 'CM_AF_OK', label: '装测试镜实测 AF 追焦迅速、五轴防抖无异响', isDefect: false },
          { val: 'CM_AF_BAD', label: '不识别镜头触点或防抖组件异响抖动', isDefect: true },
          { val: 'UNABLE', label: '! 现场缺对应卡口测试镜头，当前无法测试（必填补测人）', isUnable: true }
        ]
      }
    ],
    multiFaultsTitle: '5. 卡槽接口与按键功能（多选异常；无异常请点确认全正常）',
    multiFaults: [
      { code: 'C_SLOT', label: 'SD / CFexpress 卡槽不读卡或卡扣弹不出' },
      { code: 'C_PORT', label: 'HDMI / Type-C / 监听耳机口接触不良' },
      { code: 'C_DIAL', label: '前后波轮跳格失灵或热靴不引闪' }
    ]
  }
}
