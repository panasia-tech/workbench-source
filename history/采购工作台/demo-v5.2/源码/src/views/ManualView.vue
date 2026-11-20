<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>采购工作台 · 白话说明书与钉钉/飞书手册</h1>
        <p class="page-sub">
          平时这些教程都收在页面右上角的小问号「?」里不挡视线；想系统翻看或打印贴工位时就在这里集中查阅。
        </p>
      </div>
      <div class="page-acts">
        <input
          v-model="kw"
          type="search"
          class="input"
          style="width: 240px"
          placeholder="搜 P3精确锚、柠檬市场、95338、对公…"
          aria-label="搜索说明书"
        />
        <a href="#/pricebook" class="btn">📊 查定损&选招参考表</a>
        <button type="button" class="btn" @click="printPage">打印贴工位</button>
      </div>
    </header>

    <div class="man-layout">
      <aside class="man-toc card">
        <b>目录直达</b>
        <a href="#man-sec-pg" @click.prevent="scrollToId('man-sec-pg')">🧠 心理学×♟️博弈学 12 大增量锚点</a>
        <a href="#man-sec-anchors" @click.prevent="scrollToId('man-sec-anchors')">⚡ 全链路 10 大流程与风控锚点</a>
        <a href="#man-sec-groups" @click.prevent="scrollToId('man-sec-groups')">一、买前 6 步 & 二次议价 9 步</a>
        <a href="#man-sec-terms" @click.prevent="scrollToId('man-sec-terms')">二、白话名词词典（{{ termList.length }} 个）</a>
        <a href="#man-sec-wiki" @click.prevent="scrollToId('man-sec-wiki')">三、公司钉钉 Wiki & 飞书 Wiki 原稿直达</a>
      </aside>

      <div class="man-main">
        <!-- 置顶核心增量：行为心理学 (P1-P6) × 动态博弈学 (G1-G6) 12 大实战武器矩阵 -->
        <section id="man-sec-pg" class="man-group">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
            <h2>🧠 增量行为心理学（6大锚点）× ♟️ 动态博弈学（6大锚点）实战武器矩阵</h2>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button type="button" class="btn sm" :class="{ pri: pgFilter === 'all' }" @click="pgFilter = 'all'">全部 12 大增量锚点</button>
              <button type="button" class="btn sm" :class="{ pri: pgFilter === 'psych' }" @click="pgFilter = 'psych'">🧠 行为心理学 6 项 (P1-P6)</button>
              <button type="button" class="btn sm" :class="{ pri: pgFilter === 'game' }" @click="pgFilter = 'game'">♟️ 动态博弈学 6 项 (G1-G6)</button>
            </div>
          </div>
          <div class="term-grid">
            <div v-for="m in filteredPgMatrix" :key="m.code" class="card term-card">
              <div class="man-art-hd">
                <h3>{{ m.kind === 'psych' ? '🧠' : '♟️' }} {{ m.code }} · {{ m.title }}</h3>
                <span class="tag" :class="m.kind === 'psych' ? 'acc' : 'grn'">{{ m.step }}</span>
              </div>
              <p class="muted" style="font-size: 12.5px"><b>底层学术模型：</b>{{ m.theory }}</p>
              <p style="font-size: 13.8px; line-height: 1.55">{{ m.combat }}</p>
              <p style="font-size: 12.8px; color: var(--acc); font-weight: 600">💬 实战金句：{{ m.quote }}</p>
            </div>
          </div>
        </section>

        <!-- 零、十大实战利润与风控锚点总览（公司制度 + 代码硬锁） -->
        <section id="man-sec-anchors" class="man-group">
          <h2>⚡ 公司二次议价全链路 · 10 大实战利润与风控锚点（已全部写入代码强控）</h2>
          <div class="term-grid">
            <div v-for="a in TEN_ANCHORS" :key="a.no" class="card term-card">
              <div class="man-art-hd">
                <h3>{{ a.no }}. {{ a.title }}</h3>
                <span class="tag" :class="a.kind">{{ a.badge }}</span>
              </div>
              <p style="font-size: 13.8px; line-height: 1.55">{{ a.rule }}</p>
              <p class="muted" style="font-size: 12.5px"><b>代码防呆强控：</b>{{ a.code }}</p>
            </div>
          </div>
        </section>

        <!-- 一、按章节输出全部白话指南 -->
        <div id="man-sec-groups" class="man-group">
          <section v-for="grp in groupedHelp" :key="grp.title" class="man-group">
            <h2>{{ grp.title }}</h2>
            <article
              v-for="e in grp.items"
              :id="`help-${e.k}`"
              :key="e.k"
              class="card man-art"
              :class="{ focus: focusHelp === e.k }"
            >
              <h3>{{ e.h.title }}</h3>
              <p class="muted" style="font-size: 13.5px">
                <b>什么时候用：</b>{{ e.h.when }} · <b>谁来做：</b>{{ e.h.who }}
              </p>
              <ol class="man-steps">
                <li v-for="(s, si) in e.h.steps" :key="si">{{ s }}</li>
              </ol>
              <div class="man-meta">
                <span class="ok"><b>做完标准：</b>{{ e.h.success }}</span>
                <span class="bad"><b>何时停手问主管：</b>{{ e.h.stop }}</span>
              </div>
            </article>
          </section>
        </div>

        <!-- 二、白话词典 -->
        <section id="man-sec-terms" class="man-group">
          <h2>二、白话名词解释（界面带虚线的词点开就是这些）</h2>
          <div class="term-grid">
            <div
              v-for="t in termList"
              :id="`term-${t.k}`"
              :key="t.k"
              class="card term-card"
              :class="{ focus: focusTerm === t.k }"
            >
              <div class="man-art-hd">
                <h3>{{ t.v.t }}</h3>
                <span class="tag">{{ groupTitle(t.v.g) }}</span>
              </div>
              <p style="font-size: 14px; line-height: 1.55">{{ t.v.plain }}</p>
              <p class="muted" style="font-size: 12.5px"><b>举个例子：</b>{{ t.v.example }}</p>
              <p style="font-size: 12.5px; color: var(--red-ink)"><b>千万别踩坑：</b>{{ t.v.mistake }}</p>
            </div>
          </div>
        </section>

        <!-- 三、钉钉 Wiki 与飞书 Wiki 真实链接 -->
        <section id="man-sec-wiki" class="man-group">
          <h2>三、公司钉钉 Wiki 与飞书 Wiki 采购制度原稿直达</h2>
          <div class="card">
            <div class="tblwrap">
              <table class="tbl">
                <thead>
                  <tr>
                    <th>手册 / 制度标题</th>
                    <th>来源知识库</th>
                    <th>点击打开</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(w, wk) in uniqueWiki" :key="wk">
                    <td><b>{{ w.t }}</b></td>
                    <td><span class="tag acc">{{ w.ver }}</span></td>
                    <td>
                      <a v-if="w.u" :href="w.u" target="_blank" rel="noopener noreferrer" class="btn sm">
                        打开知识库文档 ↗
                      </a>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { HELP, MANUAL_GROUPS } from '../onboarding/helpData.js';
import { GROUPS, GLOSSARY } from '../onboarding/glossary.js';
import { WIKI } from '../onboarding/wiki.js';

const props = defineProps({
  focusHelp: { type: String, default: '' },
  focusTerm: { type: String, default: '' },
});

const kw = ref('');
const pgFilter = ref('all');

const PG_INCREMENTAL_MATRIX = [
  {
    code: 'P1',
    kind: 'psych',
    step: '第 4 步首刀重估',
    title: '塞勒心理账户重置（废单重估剥离法）',
    theory: 'Thaler Mental Accounting × 伪禀赋效应剥离',
    combat: '卖家发货后心理账户已把原单钱当成自己存款，你说“退我 700”他痛感高达 2.25 倍！必须先借“已拒签”把原交易心理清零，重构为“废单重估收瑕疵旧货”。',
    quote: '「原单已因实物差异拒签作废，咱们不谈退钱——按现状重新估价 ¥715 我向仓库申请接下。」',
  },
  {
    code: 'P2',
    kind: 'psych',
    step: '第 5 步防炸毛拆雷',
    title: '沃斯预防性指控审计（抢先替卖家骂完）',
    theory: 'FBI Chris Voss Accusation Audit × 承诺一致性免疫',
    combat: '一旦让卖家自己亲口骂出“你就是到手刀”，他为了面子就再也不肯松口！抢在他发火前，我们主动把他的怀疑替他说出来，火药桶当场哑火。',
    quote: '「哥我知道你第一反应肯定觉得我挑刺甚至怀疑到手刀，换我遇到拒签也烦；但你看一镜到底原片…」',
  },
  {
    code: 'P3',
    kind: 'psych',
    step: '第 4 步精确核价单',
    title: '零整非对称精确锚定（三项有零头核价）',
    theory: 'Janiszewski Precise Anchor × 工程成本归因幻觉',
    combat: '报整百“砍 700”一眼像拍脑袋乱砍！拆成“二销成色降档 + 配件工料 + 拆检质保金”三项有零头精确数（如核减 ¥685，实收 ¥715），锚定留存率提升 35%+！',
    quote: '「定损表刚算出来：成色降档 ¥465 + 补配件 ¥135 + 拆检质保 ¥85 = 实收 ¥715 可入账。」',
  },
  {
    code: 'P4',
    kind: 'psych',
    step: '第 5 步痛感放大',
    title: '具象三倍痛感叠加框架（运费+战损+降权）',
    theory: 'Kahneman 前景理论损失厌恶 × 具象可得性启发',
    combat: '抽象说“退货很麻烦”卖家无感，必须具象成三笔肉疼损失：①往返顺丰保价费净亏 ¥95~¥135；②已拆泡沫回程二次磕碰贬值；③闲鱼留拒签记录同链接限流！',
    quote: '「退回去来回保价费百来块打水漂 + 路上二次颠簸更说不清 + 闲鱼留拒签记录重挂限流！」',
  },
  {
    code: 'P5',
    kind: 'psych',
    step: '第 6 步红白脸收口',
    title: '红白脸双人权力隔离（ERP黑脸 + 采购白脸）',
    theory: 'Higher-Authority Constraint × 同盟归因转移',
    combat: '采购员不当恶人！发一张脱敏《ERP 质检定损锁死上限单》立黑脸规矩，你演帮卖家说话的自己人，拿“私人机动权限”贴补 ¥50 收口，封死死缠烂打！',
    quote: '「系统锁死最高只批 ¥6850（高一分点不了提交），我拿自己权限私人帮你顶 50 凑到 ¥6900！」',
  },
  {
    code: 'P6',
    kind: 'psych',
    step: '第 8 步防半夜反水',
    title: '卡尼曼峰终定律·无辜台阶面子补偿',
    theory: 'Kahneman Peak-End Rule × 自我服务归因保护',
    combat: '砍成大差价（如 2000→800）若让卖家觉得被当傻子宰，半夜必打 95338 反水！定案结尾必递“快递颠簸/光线暗非故意”无辜台阶并夸他敞亮排第一批打款，0反水！',
    quote: '「这划痕估计也是顺丰颠的绝非你故意，看哥这么敞亮，给你排明早 10 点第一批优先对公打款！」',
  },
  {
    code: 'G1',
    kind: 'game',
    step: '第 2–4 步反转球权',
    title: '谢林可信承诺·破釜沉舟默认退件锁',
    theory: 'Schelling Credible Commitment × 默认终局反转',
    combat: '口头说“不降就退”是廉价空谈（Cheap Talk）；面单物理录入「已拒签」后，默认自然结果已反转成“卖家不妥协就 100% 自动亏运费收退货”，球完全在卖家脚下！',
    quote: '「顺丰已录拒签进自动退件池，觉得不合适完全不用回我；想拦下变现按这数吱一声我去撤单。」',
  },
  {
    code: 'G2',
    kind: 'game',
    step: '第 3 & 5 步晾单仪',
    title: '鲁宾斯坦贴现因子压制（δ 耐心差晾单术）',
    theory: 'Rubinstein Alternating-Offers Time Discounting (δ_B > δ_S)',
    combat: '轮流出价博弈中越等不起钱的人分到越少！我方日收几十台 δ=0.96，卖家急问“200行不行”δ=0.58——严禁秒回！战略晾单 8–12 分钟直接压垮心理防线！',
    quote: '「系统诊断卖家 δ=0.58 急于回血：先晾 10 分钟不回，等他追问再冷淡发『不用啦，谢谢』！」',
  },
  {
    code: 'G3',
    kind: 'game',
    step: '第 5 步摧毁退路',
    title: '阿克洛夫柠檬市场推演（证伪重卖幻想）',
    theory: 'Akerlof Market for Lemons × 外部期权 (BATNA) 击穿',
    combat: '精准戳破卖家“退回去原价卖别人”的幻觉：① 明标瑕疵重挂变明牌柠檬机，散客砍得比我们还狠且半月无人问；② 隐瞒发给散客必闹小二法庭扯皮半个月！',
    quote: '「重挂写明瑕疵散客再砍三百没人要，不写发给散客必闹小二法庭，卖给我们一次买断最省心！」',
  },
  {
    code: 'G4',
    kind: 'game',
    step: '第 6 步三契约测谎',
    title: '赫维茨信息甄别菜单（分离均衡测谎仪）',
    theory: 'Hurwicz-Myerson Mechanism Design Screening',
    combat: '专治“原装头忘放了”或“暗病用不坏”谎言！同时抛三契约：①现金折让买断；②24h顺丰补寄原装件免扣配件费；③签30天坏了包退全款——撒谎卖家当场乖乖选①！',
    quote: '「原装件真在手头你今天顺丰补寄我一分不扣配件费；寄不出咱们就按买断价痛快结清！」',
  },
  {
    code: 'G5',
    kind: 'game',
    step: '第 7 步封车通牒',
    title: '子博弈完美最后通牒·顺丰封车截单锚',
    theory: 'Subgame-Perfect Ultimatum × 外部不可逆物理时钟',
    combat: '无截止期的谈判必无限拉锯！绑定“顺丰驻仓小哥 20 分钟后扫退件码封车发走”客观物理死线，把无限博弈压缩成最后一轮通牒，犹豫卖家 90% 临门成交！',
    quote: '「顺丰小哥 20 分钟后扫退件码封车拉走就拦不回了，最后窗口能定回个话我让仓管抱出来！」',
  },
  {
    code: 'G6',
    kind: 'game',
    step: '第 6 步同行收编',
    title: '重复博弈无名氏定理·多机卖家长期收编',
    theory: 'Repeated Game Folk Theorem × 未来收益折现 (Shadow of Future)',
    combat: '发现卖家主页出多台设备（发烧友/小同行）时，引入“长期免挂闲鱼到仓秒结白名单”未来收益，让卖家主动用本单让步换取长期稳定大买主门票！',
    quote: '「看老板常出器材，这台按同行价痛快抹平，加进我们直收白名单以后不用挂闲鱼直接秒结！」',
  },
];

const filteredPgMatrix = computed(() => {
  const q = kw.value.trim().toLowerCase();
  return PG_INCREMENTAL_MATRIX.filter((m) => {
    if (pgFilter.value !== 'all' && m.kind !== pgFilter.value) return false;
    if (!q) return true;
    return JSON.stringify(m).toLowerCase().includes(q);
  });
});

const TEN_ANCHORS = [
  {
    no: '锚点①',
    title: '买前写「几乎全新」或图糊：绝不追问 + 给仓管打重点验机标',
    badge: '买前预埋利润',
    kind: 'acc',
    rule: '卖家写「几乎全新/99新」或拍图模糊未披露全瑕疵时，闭嘴别追问划痕（问清变已告知丧失议价权），直接按链接标准买并给赵仓管打「🎯质疑成色」靶心！',
    code: '买前第 2 步一键勾选推送赵仓管开箱置顶红靶标，聊天框自动防多嘴。',
  },
  {
    no: '锚点②',
    title: '派送触发仓管 10 分钟极速返回结果（速战速决第 1 棒）',
    badge: '10m 仓管时效',
    kind: 'amb',
    rule: '只要顺丰显示「派送中」，赵仓管必须在 10 分钟内完成一镜到底核验并返回结果（缺原厂泡沫/缺配件/未披露划痕当场拒签留面单凭证）。',
    code: '买前第 5 步实时监控派送 10 分钟倒计时，异常一键秒转 9 步二次议价队列。',
  },
  {
    no: '锚点③',
    title: '拒签黄金 10 分钟：确认面单已拒签 + 第一时间电联加微信',
    badge: '10m 采购响应',
    kind: 'red',
    rule: '东西拒签后业务员必须在 10 分钟内响应：① 确认顺丰面单/物流已显示「已拒签」；② 拨打面单电话口头加卖家微信把战场转入微信（严禁闲鱼打字发微信号封号）。',
    code: '第 2 步未勾选「确认面单已显示拒签」服务端返回 400 硬锁拦截，强制录入卖家微信号。',
  },
  {
    no: '锚点④',
    title: '首刀半价大砍 & 两段各 10% 提成独立核算（绝不重复计提）',
    badge: '10%+10% 零重算',
    kind: 'acc',
    rule: '买前省钱提成 =（冻结参考价 M − 首轮成交 P）× 10%；到货提成 = 实际退回/折让差价 R × 10%（严禁把 R 代回 M−(P−R) 重复计提；全退未留成自动冲零；预计/已确认/已发放独立展示）！',
    code: '后端与个人收益页锁定两段各 10% 独立科目，默认每日预计目标 ¥1,000 实时对比进度。',
  },
  {
    no: '锚点⑤',
    title: '着急卖家问便宜几块别退 → 假装毫不在意说「不用了，谢谢」',
    badge: '欲擒故纵游说',
    kind: 'grn',
    rule: '卖家急着问“便宜几十/退200行不行别退回来了”，绝不顺杆讨价还价！先冷淡回「不用了，谢谢」，再挂半价锚点并用“来回保价运费+卡一周钱+下个买家照样拒签”游说。',
    code: '第 5–6 步内置《laze 实战录像同款 · 欲擒故纵三连击》一键复制胶囊与 MESO 三选一。',
  },
  {
    no: '锚点⑥',
    title: '强硬卖家打 95338 喊退 →「算了吧太急了，虽然这么烂我也勉强收下」',
    badge: '保底吃肉台阶',
    kind: 'amb',
    rule: '若卖家态度极强硬（如已打顺丰 95338 退回），而买前拿价本就捡漏或客户急等（0退差留货仍净赚），严禁赌气退走肥肉！用高姿态嫌弃台阶话术勉强收下锁死保底利润。',
    code: '第 1 & 7 步内置《捡漏保底盈利探测器》，有保底利润自动点亮「嫌弃式勉强收下」双杀路由。',
  },
  {
    no: '锚点⑦',
    title: '整单全退关闭脱离平台管辖 + 支付宝对公支付（T+1 次日10点审批）',
    badge: '防红标防差评',
    kind: 'grn',
    rule: '大额折让（如 2,000 谈成 800）绝不在闲鱼点部分退款（防平台一刀切红标、防卖家刷差评、防二次申诉）！整单全退关单脱离管辖，做好订单登记走支付宝对公直转，次日 10:00 审批！',
    code: '第 8–9 步生成《支付宝对公支付订单登记单》，绑定陈会计 T+1 次日 10:00 审批与仓管入库双锁。',
  },
  {
    no: '锚点⑧',
    title: '【发散风控】顺丰 95338 双向物流抢夺状态机（防谈成后货被拉走）',
    badge: '发散补充·防穿孔',
    kind: 'red',
    rule: '实战中强硬卖家常打 95338 让顺丰退回！谈妥留货或勉强收下后，必须让卖家重打 95338 撤回退回指令并由赵仓管物理截回包裹，否则严禁入库打款！',
    code: '卖家打 95338 自动触发在途拦截红锁（409），赵仓管未填截回回执前硬锁禁止入库。',
  },
  {
    no: '锚点⑨',
    title: '【发散风控】微信《四要素文字定案卡》+ 同名实名支付宝防诈核验',
    badge: '发散补充·防反水',
    kind: 'acc',
    rule: '微信语音谈妥（如萧山老楼 1分33秒语音）后，必发文字确认「闲鱼整单退 + 最终对公实付卖家 XXX 元（防混淆退差与成交价）」，且收款支付宝实名须与卖家一致防代收诈骗！',
    code: '第 8 步未勾选《四要素文字定案 & 同名实名核验》与《完整披露》双勾项禁止提交登记。',
  },
  {
    no: '锚点⑩',
    title: '【发散风控】闲鱼引流/到手刀封号词双通道防火墙',
    badge: '发散补充·保账号',
    kind: 'red',
    rule: '严禁在闲鱼聊天打字发「加微信、微信号、退差价、到手刀、底价」（触发平台封号与扣光当月提成）！闲鱼只发客观退货申请，谈价一律走面单电话与微信！',
    code: '工作台聊天框与 AdsPower 侧边栏同步实时拦截封号词与内部核价词（422 硬拦截）。',
  },
  {
    no: '锚点⑪',
    title: '【双轨定案】顺丰派送拒签闪电战 vs 已签收先锁退货等开口/Plan B',
    badge: '双轨并行定案',
    kind: 'grn',
    rule: '轨道① 顺丰到仓件：派送 10m 当场拒签 → 10m 确认面单拒签并电联加微直砍；轨道② 同城货拉拉/签收后测出暗病（如机械盘）：先提平台退货锁 48h 时效 → 优先等卖家主动提留货补差，不开口再走 Plan B！',
    code: '工单第 1 步内置双轨切换器，自动联动 9 步进度条文案与对应话术包。',
  },
  {
    no: '锚点⑫',
    title: '【专窗定案】1前台监督 + 3后台执行（窗#3 顺丰派送盯梢秒推仓管10m验货）',
    badge: '1+3 专窗队列',
    kind: 'acc',
    rule: '前台主窗人工监督与核改价付款；后台窗#1抓多图快照与首报；后台窗#2持续回复与慢压巡检；后台窗#3专盯已拍订单顺丰物流，一进「派送中」秒推赵仓管 10 分钟验货倒计时！',
    code: '寻源专窗页内置 /api/leads/ingest 幂等去重与 /api/executor/jobs 实时回执队列。',
  },
  {
    no: '锚点⑬',
    title: '【账单防漏】财务次日早上 10:00 前昨日对账单自动同步 · 核对采购订单 100% 抓全',
    badge: '次日10点防漏单',
    kind: 'amb',
    rule: '次日早上 10:00 前昨日财务对账单由接口自动同步到位，采购逐笔核查订单有没有抓完全：账单已扣款但未抓到的「漏抓采购单」当场一键补抓建单并推赵仓管深检，实付差额一键核平，未清零禁签字！',
    code: '采购订单与对账页双挂载 StatementReconcilePanel（纯接口自动同步无手工导表负担），未清零签字返回 409 UNRESOLVED_STATEMENT_DIFFS 硬拦截。',
  },
  {
    no: '锚点⑭',
    title: '【保号铁律】账号退款率 & 纠纷率严控 ≤ 5% 防红标 · 非必要绝不扯皮或介入',
    badge: '≤5% 防红标死线',
    kind: 'red',
    rule: '单号近30天退款率与纠纷率均不得超过 5.0%，否则平台必弹红标！非不必要，绝不跟卖家扯皮、绝不点「申请小二介入/小法庭」：逼近 5% 的号买前切安全号拍单，到货有利润走零退款率留货，无利润痛快和平退回！',
    code: '聊天框实时拦截扯皮/小二介入词（422），员工擅点介入返回 409 硬锁（仅限假货诈骗由王主管特批并受 5% 熔断监控）。',
  },
];

const groupedHelp = computed(() => {
  const q = kw.value.trim().toLowerCase();
  return MANUAL_GROUPS.map((g) => {
    const items = g.keys
      .filter((k) => HELP[k])
      .map((k) => ({ k, h: HELP[k] }))
      .filter((x) => {
        if (!q) return true;
        return JSON.stringify(x.h).toLowerCase().includes(q);
      });
    return { title: g.title, items };
  }).filter((g) => g.items.length > 0);
});

const primaryTermKeys = [
  't1_stmt_reconcile', 'rate_5pct_guard',
  'game_lemon_screening', 'p1_mental_reset', 'p3_precise_anchor', 'p5_good_bad_cop',
  'p6_peak_end', 'g3_lemon_market', 'g4_screening_menu',
  'dont_overask', 'four_evidence', 'price_ladder', 'leak_guard', 'pause_ack',
  'price_check', 'frozen_snapshot', 'return_first', 'plan_b', 'silence_rule',
  'wechat_850', 'intercept_lock', 'dual_closure', 'comm_10_20', 'window_lease',
  'quota_pool', 'duty_sep', 'honest_unknown',
];

const termList = computed(() => {
  const q = kw.value.trim().toLowerCase();
  return primaryTermKeys
    .filter((k) => GLOSSARY[k])
    .map((k) => ({ k, v: GLOSSARY[k] }))
    .filter((x) => !q || JSON.stringify(x.v).toLowerCase().includes(q));
});

const uniqueWiki = computed(() => {
  const seen = new Set();
  const out = {};
  for (const [k, v] of Object.entries(WIKI)) {
    if (!v.u || seen.has(v.u)) continue;
    seen.add(v.u);
    out[k] = v;
  }
  return out;
});

function groupTitle(gk) {
  return GROUPS.find((g) => g.k === gk)?.t || '常用概念';
}

function scrollToId(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function printPage() {
  window.print();
}

function jumpFocus() {
  nextTick(() => {
    if (props.focusHelp) scrollToId(`help-${props.focusHelp}`);
    else if (props.focusTerm) scrollToId(`term-${props.focusTerm}`);
  });
}

watch(() => [props.focusHelp, props.focusTerm], jumpFocus);
onMounted(jumpFocus);
</script>

<style scoped>
.man-layout {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.man-toc {
  position: sticky;
  top: 72px;
  display: grid;
  gap: 8px;
  font-size: 13.5px;
}
.man-toc a {
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--soft);
  color: var(--ink);
  font-weight: 600;
}
.man-toc a:hover {
  background: var(--acc-soft);
  color: var(--acc);
  text-decoration: none;
}
.man-main, .man-group {
  display: grid;
  gap: 16px;
}
.man-group > h2 {
  font-size: 20px;
  font-weight: 800;
  margin-top: 6px;
}
.man-art {
  display: grid;
  gap: 10px;
}
.man-art.focus, .term-card.focus {
  border: 2px solid var(--acc);
}
.man-steps {
  margin: 0;
  padding-left: 20px;
  display: grid;
  gap: 6px;
  font-size: 14px;
  line-height: 1.6;
}
.man-meta {
  display: grid;
  gap: 6px;
  font-size: 13.5px;
  padding: 10px 14px;
  border-radius: 12px;
  background: var(--soft);
}
.man-meta .ok { color: var(--grn-ink); }
.man-meta .bad { color: var(--red-ink); }
.term-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.term-card {
  display: grid;
  gap: 8px;
}
.man-art-hd {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
@media (max-width: 960px) {
  .man-layout, .term-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .man-toc { position: static; }
}
</style>
