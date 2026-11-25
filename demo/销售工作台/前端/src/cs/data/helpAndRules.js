// 大白话十要素手边帮助（对齐《泛亚工作台 UI 设计总纲领 v1.0》第4节）+ 7字段防呆矩阵 G() + 快捷话术 + 3关练兵

export function G(pre, mistake, block, tip, recover, owner, evidence) {
  return { pre, mistake, block, tip, recover, owner, evidence };
}

export const QUICK_REPLIES = [
  {
    cat: '售前秒回',
    label: '在库可拍·一件一拍说明',
    text: '亲在的！咱们家二手数码全部是【自有仓一件一拍】，每台机器入库都由仓管用高拍仪录了通电实测视频和微距照片。您现在看中的这台在库可拍，我马上把本机实拍照片和验机视频发您过目！',
  },
  {
    cat: '砍价婉拒',
    label: '实价不刀·透明成色',
    text: '亲，咱们家是按爱回收客观全检定级实价标售的，页面已经是实实在在的一口底价啦，顺丰保价包邮给您发出～要是您预算想再省一点，我也可以在右边同款在库槽里帮您挑一台 9 新的发实拍给您对比看看！',
  },
  {
    cat: '防站外引流',
    label: '拒加微信·平台内发实拍',
    text: '亲，平台规定不能留个人联系方式哈～咱们本机的清晰实拍大图、原厂序列号和通电测试视频我直接在这个聊天窗里发给您，走平台担保交易双方都最有保障！',
  },
  {
    cat: '发货时效',
    label: '17点前顺丰·自动推仓',
    text: '今天 17:00 前确认无异议的订单当天顺丰发出（17:00 后次日发）！给您发完本机实拍照片和视频后，您核对没问题系统会自动推给仓库激光扫四码打包，放心拍～',
  },
  {
    cat: '售后安抚',
    label: '收货异常·先保包装拍图',
    text: '亲先别着急！麻烦您先保留好顺丰外箱和气泡柱，拍一张外包装面单照片和目前机器现象的照片/小视频发我，我立刻为您转专属技术售后专员在 60 秒内跟进处理，绝不推诿！',
  },
];

export const TERMS = {
  一件一拍: '二手商品每台划痕、成色、配件都不同，仓管入库时会给每一台贴唯一货号条码（如 513211540233-A），单独录制开箱/通电视频并拍微距照，绝不能拿网图或同款另一台的图混发。',
  售前四关: '仓管工作台的放行硬门槛：①爱回收客观全检完成、②完整可读通电实拍视频、③本机实拍照片、④绑定标准SPU与#BAG附件袋子母码。四关全绿客服才能发给买家锁单。',
  静默自动发货: '针对二手买家拍完就忙工作不回消息的痛点：系统把本机实拍照片+视频+瑕疵清单发给买家后启动倒计时（默认30分钟），期间买家没提疑问就全自动推入仓库打单发货；买家一旦发问立刻毫秒级暂停发货转人工！',
  '50秒自动兜底': '买家发消息50秒没人回时，群控自动发一句“正在确认稍后回复”先保住平台表面回复率。注意：考核外包坐席时【绝不算人工已回】，仍需外包补发实质回复！',
  排他接管锁: '同一条买家会话同一时刻只允许一个所有者（外包客服 或 内部销售）。内部销售点“我来接管”后，外包输入框自动锁死，防止两人同时回复买家自相矛盾。',
  '红屏急停': '已经推给仓库拣货的订单如果买家突然退单或改地址，客服点“紧急拦截”后，仓管打包台激光枪一扫机器就会弹出409红屏三连蜂鸣锁死电子面单，强制退回原货架。',
  鱼力值红线: '闲鱼店铺核心健康分。历史血泪教训：任何情况下严禁卖家主动关闭买家已付款订单，否则鱼力值暴跌至165导致全店限流！缺货只能推荐同款其他槽位或请买家自行申请未发货退款。',
};

export const WIKI_LINKS = {
  cs_onboard_page: {
    t: '《CS-ONBOARD-01｜外部新人客服3关情景通关与三栏极简上岗》（专属子页）',
    ver: 'V6.1-CS-20261124 · 待人工复核',
    u: 'https://alidocs.dingtalk.com/i/nodes/ZQYprEoWonANyZL4iXDa0lOZ81waOeDk?utm_scene=team_space',
  },
  cs_realshot_page: {
    t: '《CS-REALSHOT-01｜三栏极简接待、仓库四关全绿选机与一件一拍直发》（专属子页）',
    ver: 'V6.1-CS-20261124 · 待人工复核',
    u: 'https://alidocs.dingtalk.com/i/nodes/Exel2BLV5zkl16Oeu7mNpgjRJgk9rpMq',
  },
  cs_warranty_page: {
    t: '《CS-WARRANTY-02｜富阳法院保修激活卡自动触发与静默发问毫秒熔断》（专属子页）',
    ver: 'V6.1-CS-20261124 · 待人工复核',
    u: 'https://alidocs.dingtalk.com/i/nodes/1DKw2zgV2PMoYdjETdPl3BkG8B5r9YAn',
  },
  cs_refund_page: {
    t: '《CS-REFUND-409-03｜退款0秒手机UI三步引导图与仓库 409红屏急停截单》（专属子页）',
    ver: 'V6.1-CS-20261124 · 待人工复核',
    u: 'https://alidocs.dingtalk.com/i/nodes/NkDwLng8ZLDqxG6gcpxGnpvNVKMEvZBY',
  },
  cs_escalate_page: {
    t: '《CS-ESCALATE-05｜问题订单三类判别与60秒一键跨部门呼救》（专属子页）',
    ver: 'V6.1-CS-20261124 · 待人工复核',
    u: 'https://alidocs.dingtalk.com/i/nodes/vNG4YZ7JnPBj0zyKTo93QoLaW2LD0oRE',
  },
  cs_takeover_page: {
    t: '《CS-TAKEOVER-06｜排他接管锁、超限让利与退回防甩锅交接》（专属子页）',
    ver: 'V6.1-CS-20261124 · 待人工复核',
    u: 'https://alidocs.dingtalk.com/i/nodes/QBnd5ExVEvDlXZQrca2rGeNyJyeZqMmz',
  },
  cs_guard_kpi_page: {
    t: '《CS-GUARD-KPI-04｜外发合规守卫、防作弊与五防绩效考核口径》（专属子页）',
    ver: 'V6.1-CS-20261124 · 待人工复核',
    u: 'https://alidocs.dingtalk.com/i/nodes/yQod3RxJKGXlx0zahY4ABMXRJkb4Mw9r',
  },
  ui_charter: {
    t: '《泛亚工作台 UI 设计总纲领 v1.1（纯桌面端与 绩效考核五防）》',
    ver: '2026-11-24 v1.1',
    u: 'https://alidocs.dingtalk.com/i/nodes/1OQX0akWmxAM02eyfNoOlbyn8GlDd3mE',
  },
};

const CS_NODE_MEDIA = {
  'CS-ONBOARD-01': {
    nodeId: 'CS-ONBOARD-01',
    timecode: '00:00',
    revision: 'V6.2-CS-HANDDRAWN-20261125',
    reviewStatus: '待人工复核',
    wikiUrl: 'https://alidocs.dingtalk.com/i/nodes/ZQYprEoWonANyZL4iXDa0lOZ81waOeDk?utm_scene=team_space',
    videoUrl: 'https://alidocs.dingtalk.com/i/nodes/P0MALyR8kl5DyXpYsMKdDrKrW3bzYmDO',
    sourceUrl: 'https://alidocs.dingtalk.com/i/nodes/14dA3GK8gjnK0MP7SvKLAbZZJ9ekBD76',
    localVideoUrl: '/cs-tutorials/CS-ONBOARD-01.mp4',
  },
  'CS-REALSHOT-01': {
    nodeId: 'CS-REALSHOT-01',
    timecode: '00:00',
    revision: 'V6.2-CS-HANDDRAWN-20261125',
    reviewStatus: '待人工复核',
    wikiUrl: 'https://alidocs.dingtalk.com/i/nodes/Exel2BLV5zkl16Oeu7mNpgjRJgk9rpMq',
    videoUrl: 'https://alidocs.dingtalk.com/i/nodes/l6Pm2Db8D49lkzyNiy9M7drB8xLq0Ee4',
    sourceUrl: 'https://alidocs.dingtalk.com/i/nodes/1DKw2zgV2PMoYdjETdP90Qoy8B5r9YAn',
    localVideoUrl: '/cs-tutorials/CS-REALSHOT-01.mp4',
  },
  'CS-WARRANTY-02': {
    nodeId: 'CS-WARRANTY-02',
    timecode: '00:00',
    revision: 'V6.2-CS-HANDDRAWN-20261125',
    reviewStatus: '待人工复核',
    wikiUrl: 'https://alidocs.dingtalk.com/i/nodes/1DKw2zgV2PMoYdjETdPl3BkG8B5r9YAn',
    videoUrl: 'https://alidocs.dingtalk.com/i/nodes/14dA3GK8gjnK0MP7SvKLjrodJ9ekBD76',
    sourceUrl: 'https://alidocs.dingtalk.com/i/nodes/Amq4vjg890zlavOESYPZQDl9J3kdP0wQ',
    localVideoUrl: '/cs-tutorials/CS-WARRANTY-02.mp4',
  },
  'CS-REFUND-409-03': {
    nodeId: 'CS-REFUND-409-03',
    timecode: '00:00',
    revision: 'V6.2-CS-HANDDRAWN-20261125',
    reviewStatus: '待人工复核',
    wikiUrl: 'https://alidocs.dingtalk.com/i/nodes/NkDwLng8ZLDqxG6gcpxGnpvNVKMEvZBY',
    videoUrl: 'https://alidocs.dingtalk.com/i/nodes/QPGYqjpJYr9qxAyDc9Zb0mwN8akx1Z5N',
    sourceUrl: 'https://alidocs.dingtalk.com/i/nodes/np9zOoBVBY41jp2MUlLx0ALwW1DK0g6l',
    localVideoUrl: '/cs-tutorials/CS-REFUND-409-03.mp4',
  },
  'CS-ESCALATE-05': {
    nodeId: 'CS-ESCALATE-05',
    timecode: '00:00',
    revision: 'V6.2-CS-HANDDRAWN-20261125',
    reviewStatus: '待人工复核',
    wikiUrl: 'https://alidocs.dingtalk.com/i/nodes/vNG4YZ7JnPBj0zyKTo93QoLaW2LD0oRE',
    videoUrl: 'https://alidocs.dingtalk.com/i/nodes/y20BglGWO2ZB6yQRiD0ApLMk8A7depqY',
    sourceUrl: 'https://alidocs.dingtalk.com/i/nodes/b9Y4gmKWrP5pynLDTrjExlpEJGXn6lpz',
    localVideoUrl: '/cs-tutorials/CS-ESCALATE-05.mp4',
  },
  'CS-TAKEOVER-06': {
    nodeId: 'CS-TAKEOVER-06',
    timecode: '00:00',
    revision: 'V6.2-CS-HANDDRAWN-20261125',
    reviewStatus: '待人工复核',
    wikiUrl: 'https://alidocs.dingtalk.com/i/nodes/QBnd5ExVEvDlXZQrca2rGeNyJyeZqMmz',
    videoUrl: 'https://alidocs.dingtalk.com/i/nodes/R4GpnMqJzGrR6xP2hbaQp2G78Ke0xjE3',
    sourceUrl: 'https://alidocs.dingtalk.com/i/nodes/X6GRezwJlA5gBpx3ujr7rEav8dqbropQ',
    localVideoUrl: '/cs-tutorials/CS-TAKEOVER-06.mp4',
  },
  'CS-GUARD-KPI-04': {
    nodeId: 'CS-GUARD-KPI-04',
    timecode: '00:00',
    revision: 'V6.2-CS-HANDDRAWN-20261125',
    reviewStatus: '待人工复核',
    wikiUrl: 'https://alidocs.dingtalk.com/i/nodes/yQod3RxJKGXlx0zahY4ABMXRJkb4Mw9r',
    videoUrl: 'https://alidocs.dingtalk.com/i/nodes/1zknDm0WRanqQP0YUdxq113q8BQEx5rG',
    sourceUrl: 'https://alidocs.dingtalk.com/i/nodes/1R7q3QmWeeaQBDjmTKZM69GNWxkXOEP2',
    localVideoUrl: '/cs-tutorials/CS-GUARD-KPI-04.mp4',
  },
};

export const HELP = {
  chat: {
    ...CS_NODE_MEDIA['CS-REALSHOT-01'],
    title: '三栏接待工作台 · 仓库 四关全绿选机与一件一拍直发',
    when: '每天上岗打开的第一个页面，95% 的接待、挑货、发实拍视频照片、自动发货处理都在这里一屏完成。',
    who: '外包客服坐席（主力接待）/ 内部兜底销售（被呼叫时接管或写锦囊）',
    steps: [
      '看左栏置顶红灯会话：优先点开倒计时快满 3 分钟、或买家在自动发货期刚发问的红色会话。',
      '看右栏最上方【🧭 当前步骤小卡片】：不用背公司流程，卡片亮什么颜色、主按钮写什么就点什么。',
      '若买家问货况或已拍下：在右栏 仓库 同款分槽挑 1 台绿灯机器（避开🔒灰色阻塞槽位），点【一键发实拍照片+视频】。',
      '若链接对不上货、缺通电视频、买家砍破底价或已签收售后：直接点右栏对应的【60秒一键转内部】按钮，严禁瞎编乱答。',
    ],
    success: '买家 30 秒内获人工首响，已付款订单 100% 发出对应单品的仓管实拍照片与视频，无异议自动推仓出库。',
    stop: '链接标红认不出货、机器缺实拍视频、买家索要微信号、买家砍破授权价、或收货后报故障 → 立即停手点右侧升级按钮交内部专员。',
    terms: ['一件一拍', '售前四关', '静默自动发货', '排他接管锁', '鱼力值红线'],
    guards: [
      G('买家诱导加微信或客服误敲手机号', '在聊天框发出微信号/手机号触发平台站外引流封店', '发送按钮由外发守卫实时拦截并红字说明违规词', '使用【防站外引流】快捷话术在平台内直接发实拍视频和照片', '删掉输入框里的微信号/手机号即可恢复发送', '外包客服', '外发守卫拦截审计日志'),
      G('同款多台在库但某台缺通电视频', '把还没录好通电视频或隔离区的坏货锁给买家', '仓库 四关未全绿的单品在右侧直接 Lock 灰置禁选', '只挑标有「四关全绿 ✓」的在库单品，或点一键催仓管补拍', '已误选的可点「换挑同款另一台」重绑', '外包客服 + 仓管员', '订单锁库与实拍发送回执'),
    ],
    kpi: {
      metric: '30秒首响率 + 3分钟人工回复率(≥96%) + 发货前置实拍执行率(100%)',
      formula: '仅统计人工实质回复（自动剔除50秒机器人兜底与单字“1”刷尾响）；因设备30s节流排队按点击发送时刻计，不让客服背锅。',
      sample: '实时滚动计入个人顶部战绩条与月底外包结算单',
      viewer: '客服本人看个人达标进度；主管看全团排行与反作弊明细',
    },
    video: CS_NODE_MEDIA['CS-REALSHOT-01'].videoUrl,
    wiki: ['cs_realshot_page', 'ui_charter'],
  },
  copilot_card: {
    ...CS_NODE_MEDIA['CS-REALSHOT-01'],
    title: '右侧「当前步骤小卡片」与发实拍推保修卡规则',
    when: '不确定这笔咨询或已付款订单现在卡在哪一步、发货前要做哪些前置动作时。',
    who: '外包客服（按提示点按钮）/ 系统自动发货引擎（静默倒计时推仓）',
    steps: [
      '第 1 步【核链接与货况】：系统自动校验买家商品链接是否对上 仓库 单品、仓管四关是否全绿。异常直接点红卡按钮呼救。',
      '第 2 步【仓库挑货锁单】：通卖链接多台在库时，从下方挑 1 台绿灯机器锁入本单（一机一链由系统自动锁）。',
      '第 3 步【发一件一拍实拍】：点蓝色主按钮一键发本机实拍照片 + 通电实测视频，系统同步跟发《保修激活确认卡》。',
      '第 4 步【静默自动发货 / 有疑问人工介入】：实拍发出后等待回复「同意」或 30 分钟静默推仓；买家提问立即毫秒暂停让你先处理。',
    ],
    success: '无需苦等睡觉买家回“确认”，既 100% 留存发实拍与保修管辖铁证防扯皮，又跑通当天 17:00 顺丰发货闭环。',
    stop: '倒计时期间买家提出换机、质疑划痕或改地址时，自动暂停推仓，未处理完严禁强行点恢复发货。',
    terms: ['一件一拍', '静默自动发货', '红屏急停'],
    guards: [
      G('已付款订单还没挑货或还没发实拍', '外包跳过发实拍直接让仓库发货，买家收到嫌划痕退货', '未完成挑货+发实拍前，推仓按钮硬锁死不可点', '先点选 仓库 单品并发出实拍视频与照片', '补发实拍后自动解锁观察窗', '外包客服', '聊天窗实拍卡片回执'),
    ],
    kpi: {
      metric: '发货前置实拍执行率 100% + 疑问熔断跟进时效 ≤2分钟',
      formula: '已推仓订单中含实拍发送记录单数 ÷ 总推仓单数；若未发实拍或乱承诺无划痕导致售后退货，倒扣当单绩效',
      sample: '每笔订单全量校验',
      viewer: '客服本人 + 仓管复核台 + 发包主管',
    },
    video: CS_NODE_MEDIA['CS-REALSHOT-01'].videoUrl,
    wiki: ['cs_realshot_page', 'cs_warranty_page'],
  },
  auto_rules: {
    ...CS_NODE_MEDIA['CS-WARRANTY-02'],
    title: '场景自动发图（保修富阳法院管辖卡 + 退款3步UI图）',
    when: '发完实拍想核对或调整「发货前自动推保修激活卡」「顺丰派件开箱卡」或「手动发场景图」规则与话术时。',
    who: '外包客服（查触发规则与手动测试补发）/ 销售主管（调口径）',
    steps: [
      '规则 1（发货前）：发完实拍自动推《店铺质保服务激活确认卡》，内含「杭州市富阳区人民法院」诉讼管辖约定；买家回复「同意」立刻生效并推仓。',
      '规则 2（退款 0 秒触发）：买家点击申请退款的瞬间，0 秒自动推《手机 UI 3 步选“不想要了/协商一致”引导图》。',
      '聊天框右下「🖼 手动发场景图 ▾」或本弹窗右下「手动发到当前会话测试」可随时补发验证。',
    ],
    success: '100% 发货订单留存富阳法院管辖激活凭证，全程免客服手工存图贴图。',
    stop: '买家明确反对富阳法院管辖约定或索改法务条款时，立刻停手转内部销售或主管判定。',
    terms: ['一件一拍', '静默自动发货'],
    guards: [
      G('买家不回同意也不提问，停在静默观察窗', '重复催促引起反感或误点取消发货', '系统开启 30 分钟静默观察窗自动推入顺丰波次', '无需手动再推；若中途买家提问，系统毫秒级熔断暂停再由你解答', '解答消疑后点【恢复推仓】继续发货', '系统引擎 + 外包客服', '自动发图日志'),
    ],
    kpi: null,
    video: CS_NODE_MEDIA['CS-WARRANTY-02'].videoUrl,
    wiki: ['cs_warranty_page', 'cs_refund_page'],
  },
  autoship: {
    ...CS_NODE_MEDIA['CS-WARRANTY-02'],
    title: '富阳管辖保修激活与自动发货异常熔断监控池',
    when: '集中巡检所有已付款订单卡在哪个前置环节，或点开查看「回同意生效」「静默倒计时」与「买家提问瞬间熔断」泳道时。',
    who: '外包组长 / 客服坐席 / 内部主管',
    steps: [
      '从左到右四列清晰对应：待挑货发实拍 → 等回“同意”·静默倒计时 → 疑问熔断·待人工介入 → 已推入仓管波次 / 红屏急停。',
      '若买家刚看完实拍又发来疑问，订单毫秒级暂停自动发货并掉进第 3 列红色「疑问熔断·待人工介入」。',
      '人工答疑清楚让买家打消顾虑后再点绿色【恢复推仓】；若已进第 4 列波次但买家突改地址/退单，点红色【409拦截】。',
    ],
    success: '当日 17:00 前已付款订单零积压漏发、有异议订单零带病误发。',
    stop: '买家提问未解释清楚前严禁强点恢复推仓；发现买家拒绝保修条款立刻停发交内部销售。',
    terms: ['静默自动发货', '售前四关', '红屏急停'],
    guards: [
      G('买家已在自动发货观察期发来问号', '系统没停住继续把有争议的货发走', '收到任何买家 in 方向消息毫秒级把状态切为 AUTO_PAUSED_BY_BUYER', '先回买家解答或换挑另一台，确认无异议后再恢复推仓', '即使已进波次仍可发 打包台红屏急停', '系统自动引擎 + 外包客服', '熔断事件流水'),
    ],
    kpi: {
      metric: '自动推仓顺畅率 + 17:00 截单履约率',
      formula: '静默无异议自动推仓单数 ÷ 已付款总单数',
      sample: '当日全部已付款实物单',
      viewer: '客服主管与仓管主管共享',
    },
    video: CS_NODE_MEDIA['CS-WARRANTY-02'].videoUrl,
    wiki: ['cs_warranty_page'],
  },
  auto_refund: {
    ...CS_NODE_MEDIA['CS-REFUND-409-03'],
    title: '退款 0 秒手机三步引导与打包台红屏急停',
    when: '买家申请退款（或拍错选成“其他/质量问题”），或者货已入仓库 WAVE 波次正在拣货打包需要紧急拦停时。',
    who: '外包客服 / 仓管打包工位 / 内部销售',
    steps: [
      '先看对话抬头标签：未入波次（如王女士）→ 确认系统 0 秒自动发出《手机 UI 3 步选不想要了图》，用快捷短语引导买家改原因秒到账。',
      '已入仓库波次拣货中（如张同学 · PICKING_仓库）→ 绝不口头答应“退掉了”，立刻点右栏红色【🛑 立即下发 打包台红屏急停拦截仓库面单】！',
      '等仓库确认实物已截留归回货架后，再引导买家按 3 步图改选「不想要了/协商一致」完成退款；永久严禁点击「卖家关闭订单」。',
    ],
    success: '未拣货错因退款 0 秒自动化解，已拣货包裹 100% 拦停不出大门，零违规关单扣鱼力值。',
    stop: '若仓库反馈快递已扫揽收出库（错过 红屏急停点），立即停手绝不直接同意仅退款；买家索赔运费/赔付转内部接管。',
    terms: ['红屏急停', '鱼力值红线'],
    guards: [
      G('订单已入 WAVE 波次拣货中买家口头要退', '口头答应已退但仓库把货发出去了，货款两空', '拣货中订单右栏直接弹出 打包台红屏急停按钮与锁单保护', '先按下【立即下发 打包台红屏急停拦截仓库面单】拿仓库截留回执，再处理退款', '若已扫揽收立刻通知快递拦截并引导拒签', '外包客服 + 仓管', '409 红屏截单审计流水'),
    ],
    kpi: null,
    video: CS_NODE_MEDIA['CS-REFUND-409-03'].videoUrl,
    wiki: ['cs_refund_page'],
  },
  collab_escalate: {
    ...CS_NODE_MEDIA['CS-ESCALATE-05'],
    title: '问题订单判别与 60 秒一键跨部门呼救（催仓/呼销售）',
    when: '遇到左栏「问题订单」红标单：仓管漏传通电实拍视频、商品链接未绑 仓库货号、附带危险外部网盘链接或超限砍价时。',
    who: '外包客服（发起 60s 呼救）/ 仓管与内部销售（红灯承接）',
    steps: [
      'C7 缺通电视频：绝不嘴上保证“屏幕完美无暗点”，点击【⚡ 一键催仓管 60 秒补拍通电视频】，60 秒直达仓库高拍仪大屏。',
      'C8 链接未绑 仓库货号：观察系统自动红框阻断买家网盘外链（严禁点击网盘），点【🔗 一键呼叫内部销售 60s 绑定 仓库货号】。',
      '常规咨询右栏已有答案的严禁滥点呼救甩锅，免记考核扣分；真异常呼救后坐等 60s 回流或内部接管。',
    ],
    success: '缺视频与缺货号 100% 精准派到责任工位并在 60 秒内启动补录，风险外链 0 点击。',
    stop: '未收到仓管新视频或未绑完 仓库货号前，严禁答复“有货可拍”；任何时候严禁点开外部网盘链接。',
    terms: ['一件一拍', '售前四关'],
    guards: [
      G('买家发送百度网盘等外部校色/清单链接', '外包误点外部木马钓鱼链或承诺网盘里的未知需求', '聊天窗自动亮红警阻断「外部风险链接，请勿点击」', '保持不点击，一律使用平台内实拍或点呼救交由内部专员处置', '已误点立即断开并报告管理员', '外包客服 + 内部销售', '外链阻断审计记录'),
    ],
    kpi: null,
    video: CS_NODE_MEDIA['CS-ESCALATE-05'].videoUrl,
    wiki: ['cs_escalate_page'],
  },
  takeover_handoff: {
    ...CS_NODE_MEDIA['CS-TAKEOVER-06'],
    title: '销售工作台内排他接管锁、超限让利与退回防甩锅交接',
    when: '内部销售「陈小满」在销售工作台左栏「工作 → 外部客服」承接外包呼救升级的砍价、未绑货号或疑难售后单时。',
    who: '内部兜底销售（陈小满）/ 外部外包客服（只读旁观跟进）',
    steps: [
      '内部销售切至陈小满视角，在跨部门协同区点【🔒 我来排他接管（锁外包输入）】，系统立即锁定外包端输入框防双人撞话。',
      '在授权内完成补绑 仓库货号、或代发超 ¥20 的优惠券/成交改价（严守最低底价线）。',
      '问题处理完点【退回外包继续盯单】，把发实拍与发货后续交回原坐席；若属于外包有答案乱转锅，点「退回外包并记无效甩锅」。',
    ],
    success: '同一客户同一时刻只有 1 人主办发声，大额单成交不丢单，常规问询不滥甩锅。',
    stop: '排他锁生效期外包严禁绕开平台抢答；若买家砍价击穿销售底价保护线，内部销售同样须停手升级主管批示。',
    terms: ['排他接管锁'],
    guards: [
      G('外包把右栏明明有现成答案的普通询问甩给内部', '耗尽内部专员精力且责任扯皮', '内部销售点击退回外包并记入反作弊审计「无效甩锅退回」', '先自查右栏仓管图文描述，确认超 ¥20 或缺货号再呼叫升级', '退回后按卡片答案正常答复买家', '内部销售 ↔ 外包客服', '绩效甩锅回退审计条'),
    ],
    kpi: null,
    video: CS_NODE_MEDIA['CS-TAKEOVER-06'].videoUrl,
    wiki: ['cs_takeover_page', 'cs_escalate_page'],
  },
  kpi: {
    ...CS_NODE_MEDIA['CS-GUARD-KPI-04'],
    title: '外发合规守卫、防作弊雷达与五防全维考核大盘',
    when: '外包客服随时看自己今日首响、3 分人工回复率与预估日奖；主管月底核对反作弊预警与导出结算表格时。',
    who: '外包客服（看个人激励与合规红线）/ 主管与财务（看全团对比与反作弊明细）',
    steps: [
      '发消息前由外发守卫实时扫描：只要打字带手机号、微信号或单字「1」刷尾响，上方秒亮红警并锁定「发送」防封店。',
      '点顶栏「全维考核 ▾」查看个人 5 项实绩与预估日奖；重点关注「人工真回 vs 50s 机器人兜底漏回剔除」。',
      '对账或申诉时点大盘右上角【导出结算表格】，所有奖惩与反作弊拦截均有会话级事实凭证。',
    ],
    success: '首响 ≤30s、3 分钟人工回复率 ≥96%、实拍 100%、站外微信手机号 0 放行。',
    stop: '严禁用谐音字/拆字变相发送微信号或靠挂机 50s 机器人骗响应；结算数据疑议保存表格提交主管复核。',
    terms: ['50秒自动兜底', '一件一拍', '鱼力值红线'],
    guards: [
      G('外包坐席输入纯数字“1”或微信号企图刷分或引流', '平台站外引流封店或欺骗尾响闭环率', '外发守卫实时红框锁灰发送钮，并在反作弊雷达累计记录', '删掉违禁内容，改用标准快捷短语在站内解答并提供实拍', '保持站内合规发图发视频即可拿满高日奖', '系统考核引擎 + 外包客服', '反作弊拦截与 结算表格'),
    ],
    kpi: {
      metric: '14项全维指标（时效4项 + 工作量3项 + 一件一拍质量3项 + 转化与风控倒扣4项）',
      formula: '遵循总纲领 绩效考核五防：系统自动取数、配对指标约束（促单奖励配对乱承诺售后倒扣）',
      sample: '按自然日/自然月聚合（自动扣除 23:00–09:00 静默期）',
      viewer: '老板、发包主管、外包团队负责人',
    },
    video: CS_NODE_MEDIA['CS-GUARD-KPI-04'].videoUrl,
    wiki: ['cs_guard_kpi_page', 'ui_charter'],
  },
  learn: {
    ...CS_NODE_MEDIA['CS-ONBOARD-01'],
    title: '新人首日 3 关防踩坑沙盒（过关即解锁工作台）',
    when: '新入职外包客服（如周小萌）首日进入工作台被锁定发送权限时，花 60 秒答完 3 道真实情景模拟题即解锁。',
    who: '新入职外包客服（切换右上角「周小萌」体验锁定→过 3 关→全解锁流程）',
    steps: [
      '第 1 关：遇到链接对不上货或仓管缺实拍视频怎么点？（答：点右栏一键催仓 60s 补拍，绝不找网图）。',
      '第 2 关：买家拍下后，怎么挑 仓库 绿灯机器发实拍并利用富阳管辖保修卡开启推仓？',
      '第 3 关：买家砍价超限、要加微信转账、或缺货时能不能点“关闭订单”？（答：零私发微信、零关单、超限转内部）。',
    ],
    success: '3 关全绿通过，前后端同步解锁真实接待操作（练兵沙盒绝不污染真实订单数据）。',
    stop: '连续答错勿猜选项，点击顶部/卡片「？」查看十要素与 CS-ONBOARD-01 独立视频后再作答。',
    terms: ['一件一拍', '静默自动发货', '鱼力值红线'],
    guards: [],
    kpi: null,
    video: CS_NODE_MEDIA['CS-ONBOARD-01'].videoUrl,
    wiki: ['cs_onboard_page', 'ui_charter'],
  },
};

export const PRACTICES = [
  {
    key: 'link_media',
    stepNo: 1,
    title: '第 1 关：买家问货但「链接对不上」或「缺仓管实拍视频」怎么办？',
    scenario: '抖店买家问：“这台华硕 ROG 显示器现在能拍吗？发个亮屏视频看看”，但你看到右侧卡片亮红灯提示【仓管通电实拍视频未就绪】。此时你应该怎么做？',
    options: [
      {
        id: 'a',
        label: '先口头答应买家“绝对完美没坏点您先拍”，随便去网上找张同型号网图发过去促单',
        correct: false,
        feedback: '❌ 踩大坑！二手商品每台成色不同，拿网图或别台图顶替属于货不对板欺诈，收货必退且倒扣当月绩效！',
      },
      {
        id: 'b',
        label: '直接点右侧红卡主按钮【⚡ 一键催仓管补拍视频（60s响应）】，礼貌告知买家正在让仓库现场核实实拍',
        correct: true,
        feedback: '✅ 完全正确！缺实拍或链接对不上时，右侧小卡片已经帮你把呼救按钮准备好了，60秒直达仓管首页，诚实稳妥零风险！',
      },
      {
        id: 'c',
        label: '假装没看见这条消息，等 50 秒机器人自动兜底顶过去就算回过了',
        correct: false,
        feedback: '❌ 踩坑！考核系统已剔除 50 秒机器人自动兜底，挂机不真回会被反作弊雷达直接标红扣分！',
      },
    ],
  },
  {
    key: 'pick_autoship',
    stepNo: 2,
    title: '第 2 关：买家已付款后，发货前置动作与「自动发货」怎么配合？',
    scenario: '拼多多买家拍下戴森吹风机已付款。右侧卡片显示同款在库有 A（95新·四关全绿）、C（缺视频·灰置锁定）。正确流程是什么？',
    options: [
      {
        id: 'a',
        label: '选绿灯在库的 A 机 → 点【锁入本单并发实拍照片+视频】→ 开启静默自动发货倒计时；若期间买家发问，系统自动暂停发货再由我介入解答',
        correct: true,
        feedback: '✅ 满分通关！既把仓管一件一拍照片和视频发给买家留足凭证，又不用干等买家回话就能自动推仓发货；客人有疑问系统会自动熔断叫你！',
      },
      {
        id: 'b',
        label: '不用挑也不用发实拍视频，直接催仓库随便抓一台打包寄走，省得买家看图挑刺',
        correct: false,
        feedback: '❌ 严重违规！未挑定唯一货号且未发本机实拍视频留证前，系统物理锁死推仓，强发会导致极高退货纠纷！',
      },
      {
        id: 'c',
        label: '发完实拍后要是买家去睡觉没回“确认”，就一直卡着三天不给仓库发货',
        correct: false,
        feedback: '❌ 老黄历啦！现在有「静默观察窗自动发货」，发完实拍倒计时内买家没提异议就会全自动推入仓库波次，绝不耽误 17:00 顺丰截单！',
      },
    ],
  },
  {
    key: 'redline_guard',
    stepNo: 3,
    title: '第 3 关：买家猛砍价、要加微信转账、或遇到缺货能点「关闭订单」吗？',
    scenario: '闲鱼买家说：“便宜 300 块！加我微信 138xxxx 转你钱省手续费”，或者某台机器刚被别店抢先拍走。以下哪项操作是对的？',
    options: [
      {
        id: 'a',
        label: '把自己的微信号发给他私下收款，或者缺货时直接在后台点“卖家关闭订单”',
        correct: false,
        feedback: '❌ 触碰三级高压红线！发微信号会被平台判站外引流封店；卖家主动关闭买家订单会导致闲鱼鱼力值暴跌至165全店瘫痪！',
      },
      {
        id: 'b',
        label: '绝不留微信、绝不主动关买家订单！用标准话术婉拒站外交易；超权限砍价点【转内部销售】；缺货引导挑同款其他成色槽位或请买家自退',
        correct: true,
        feedback: '✅ 恭喜 3 关全部通关！你已经完全掌握泛亚外包客服的极窄安全边界，现在全部真实接待按钮已为你解锁！',
      },
    ],
  },
];

export const TOUR_STEPS = [
  {
    sel: '[data-tour="left-inbox"]',
    title: '① 左栏：红黄绿智能排队收件箱',
    body: '闲鱼、拼多多、千牛、抖店、京东消息全部聚在这里。不用你自己找谁急——买家刚提疑问熔断自动发货的、快满 3 分钟超时的永远自动排在最上面！',
  },
  {
    sel: '[data-tour="center-chat"]',
    title: '② 中栏：清爽聊天窗 + 外发防封号守卫',
    body: '和微信/千牛一样顺手。买家发的链接会自动体检；底部有一键标准话术胶囊；万一误输入手机号/微信号，守卫会自动帮你拦住不闯祸。',
  },
  {
    sel: '[data-tour="right-stepper"]',
    title: '③ 右栏上半区：傻瓜式「当前到哪一步」小卡片',
    body: '你不需要背公司复杂的后台流程！这笔单现在该核链接、该从 仓库挑货、该发实拍视频、还是正在自动发货倒计时，小卡片直接给你唯一主按钮。',
  },
  {
    sel: '[data-tour="right-wms"]',
    title: '④ 右栏下半区：仓库 一件一拍挑货舱与 60 秒呼救',
    body: '同款几台在库、每台的仓管高拍仪视频和微距瑕疵照都在手边（进价和库位照已自动脱敏隐藏）。搞不定的事点最下面按钮 60 秒呼叫内部销售或仓管！',
  },
  {
    sel: '[data-tour="top-kpi"]',
    title: '⑤ 顶栏：实时个人战绩与角色体验切换',
    body: '随时看到自己今天接待多少人、首响几秒、3 分钟回复率达没达标。右上角还能一键切换「外包客服 / 首日新人 / 内部销售 / 考核主管」四个视角验收闭环！',
  },
];
