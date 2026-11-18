<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>参考中心 · 买前核价与二次议价定损·博弈速查表</h1>
        <p class="page-sub">
          买前查机型最高上限，到货二次议价查「五大品类客观定损标准（P3拆项精确锚）」与「卖家原话×12大心理博弈选招参考表」。
        </p>
      </div>
      <div class="page-acts">
        <a href="#/manual" class="btn sm">看完整图文手册</a>
        <Q k="pricebook" label="怎么查参考标准" />
      </div>
    </header>

    <!-- 顶部三大参考表分段切换器（一屏聚焦一张表，干净不堆砌） -->
    <div class="ref-tabs card" style="padding: 10px 14px; margin-bottom: 16px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center">
      <button type="button" class="btn sm" :class="{ pri: activeTab === 'buy' }" @click="activeTab = 'buy'">
        ① 买前三档谈价参考表（{{ items.length }} 款机型）
      </button>
      <button type="button" class="btn sm" :class="{ pri: activeTab === 'deduct' }" @click="activeTab = 'deduct'">
        ② 二次议价 · 五大品类瑕疵定损与 P3/P4 核价参考表
      </button>
      <button type="button" class="btn sm" :class="{ pri: activeTab === 'tactic' }" @click="activeTab = 'tactic'">
        ③ 卖家反应 × P1–P6 / G1–G6 心理博弈选招速查表
      </button>
    </div>

    <div v-if="lastImpact" class="banner grn" style="margin-bottom: 16px">
      ✓ 已正式发布 <b>{{ lastImpact.model_code }}</b> 新价格！正在聊的老单子继续按原价格稳妥推进，新开单自动按新价格执行。
    </div>

    <!-- 参考表 1：买前各主力型号三档谈价参考表 -->
    <template v-if="activeTab === 'buy'">
      <section class="card">
        <h3>
          各主力型号买前三档谈价参考表
          <small>有可比行情按行情七折定上限；写「几乎全新/图糊」切忌追问划痕，按上限内拿货并给赵仓管打标重点深检</small>
        </h3>

        <div class="tblwrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>商品型号规格</th>
                <th>对应成色标准</th>
                <th class="num-r">公司参考价</th>
                <th class="num-r">① 建议开口价</th>
                <th class="num-r">② 目标成交价</th>
                <th class="num-r">③ 最高出价上限</th>
                <th>当前状态</th>
                <th class="row-acts">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in items" :key="p.item_id" :class="{ wait: p.status === 'draft_pending_review' }">
                <td><b>{{ p.spec_label }}</b></td>
                <td><span class="tag">{{ p.condition_grade }}</span></td>
                <td class="num-r">{{ fmtYuan(p.ref_price_cents) }}</td>
                <td class="num-r">{{ fmtYuan(p.first_offer_cents) }}</td>
                <td class="num-r">{{ fmtYuan(p.target_cents) }}</td>
                <td class="num-r"><b>{{ fmtYuan(p.ceiling_cents) }}</b></td>
                <td>
                  <span class="tag" :class="p.status === 'draft_pending_review' ? 'amb' : 'grn'">
                    {{ p.status === 'published' ? '生效中' : p.status === 'draft_pending_review' ? '待王主管审核' : '历史版本' }}
                  </span>
                </td>
                <td class="row-acts">
                  <button type="button" class="btn sm" @click="startDraft(p)">提调价建议</button>
                  <button
                    v-if="p.status === 'draft_pending_review'"
                    type="button"
                    class="btn sm pri"
                    style="margin-left: 6px"
                    :disabled="role.role !== 'supervisor' || busy"
                    @click="publishItem(p.item_id)"
                  >
                    {{ role.role === 'supervisor' ? '审核通过并发布' : '🔒 待王主管审核' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p v-if="role.role !== 'supervisor'" class="muted" style="font-size: 13px; margin-top: 10px">
          💡 采购员整理完每日行情回测后可点「提调价建议」，再由第二人/王主管复核发布。想体验主管审核可
          <button type="button" style="color:var(--acc);font-weight:700" @click="switchToBoss">一键切到【王主管】</button>。
        </p>
      </section>

      <section v-if="draftTarget" class="card" style="margin-top: 16px">
        <h3>提交调价建议：{{ draftTarget.spec_label }}</h3>
        <div class="four-nums">
          <label class="field">
            <span>公司参考价（元）</span>
            <input v-model.number="df.ref_yuan" type="number" class="input num" />
          </label>
          <label class="field">
            <span>① 建议开口价（元）</span>
            <input v-model.number="df.first_yuan" type="number" class="input num" />
          </label>
          <label class="field">
            <span>② 目标成交价（元）</span>
            <input v-model.number="df.target_yuan" type="number" class="input num" />
          </label>
          <label class="field">
            <span>③ 最高出价上限（元）</span>
            <input v-model.number="df.ceil_yuan" type="number" class="input num" />
          </label>
        </div>
        <div v-if="err" class="errbox" style="margin-top: 10px">{{ err }}</div>
        <div style="display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap">
          <Lock :ok="draftGate.ok" :busy="busy" :reason="draftGate.reason" @go="submitDraft">
            保存送王主管审核 ›
          </Lock>
          <button type="button" class="btn" @click="draftTarget = null">取消</button>
        </div>
      </section>
    </template>

    <!-- 参考表 2：二次议价 · 五大品类瑕疵定损与 P3/P4 精确核价参考标准表 -->
    <section v-else-if="activeTab === 'deduct'" class="card">
      <h3>
        二次议价 · 五大品类客观定损扣减与 P3/P4 核价参考标准表
        <small>用于第 4 步「P3 三项有零头精确锚」与第 6 步「P5 红白脸脱敏定损单」——有客观依据才让卖家心服口服</small>
      </h3>
      <div class="banner amb" style="margin: 10px 0 14px">
        🧮 <b>P3 零整精确核价公式：</b>首刀总核减额 = <b>① 二销成色降档折损 + ② 原装配件/包装实补工料 + ③ 拆检质保风险金</b>（故意保留 `5` 元零头如 `¥685` / `¥465`，避免整百拍脑袋感；散客首刀仍可直接按原单 **50% 对半砍**！）。
      </div>
      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>商品品类</th>
              <th>仓管 10 分钟重点抓差靶点</th>
              <th class="num-r">① 二销成色降档扣减</th>
              <th>② 原装配件/包装工料参考</th>
              <th class="num-r">③ 拆检质保金</th>
              <th class="num-r">P4 顺丰往返保价费</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in DEDUCT_REFS" :key="r.cat">
              <td><b>{{ r.cat }}</b></td>
              <td>{{ r.defects }}</td>
              <td class="num-r"><b>{{ r.dep }}</b></td>
              <td>{{ r.parts }}</td>
              <td class="num-r">{{ r.labor }}</td>
              <td class="num-r"><span class="tag red">{{ r.freight }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 参考表 3：卖家 8 种典型原话 × P1–P6 / G1–G6 心理博弈选招速查参考表 -->
    <section v-else class="card">
      <h3>
        卖家现场反应 × 12 大心理博弈锚点（P1–P6 / G1–G6）选招速查参考表
        <small>微信/电话里卖家一开口，对照下表 3 秒钟选准降维打击武器</small>
      </h3>
      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>卖家现场典型原话 / 动作</th>
              <th>卖家真实底牌诊断</th>
              <th>必调心理/博弈锚点</th>
              <th>员工标准动作与核心金句参考</th>
              <th>绝对禁忌（踩坑必亏）</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in TACTIC_LOOKUP_REFS" :key="t.scene">
              <td><b>{{ t.scene }}</b></td>
              <td>{{ t.diag }}</td>
              <td><span class="tag acc">{{ t.codes }}</span></td>
              <td>{{ t.action }}</td>
              <td style="color: var(--red-ink)">{{ t.taboo }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue';
import { store, currentRole, callAction, isPracticeUnlocked, setActor, notify } from '../store.js';
import { fmtYuan } from '../api.js';
import Q from '../components/Q.vue';
import Lock from '../components/Lock.vue';

const role = computed(() => currentRole());
const items = computed(() => store.dashboard.pricebook || []);

const activeTab = ref('buy');
const draftTarget = ref(null);
const lastImpact = ref(null);
const busy = ref(false);
const err = ref('');
const df = reactive({ ref_yuan: 0, first_yuan: 0, target_yuan: 0, ceil_yuan: 0 });

const DEDUCT_REFS = [
  {
    cat: '显示器 / 27寸一体机',
    defects: '纯色屏亮斑暗斑、外屏划痕、缺原厂泡沫内衬、缺原装DP线/螺丝、机械盘冒充固态',
    dep: '¥225 ~ ¥665',
    parts: '原厂泡沫+纸箱 ¥85 · 原装电源/DP线 ¥95 · 补固态硬盘 ¥185',
    labor: '¥85',
    freight: '¥120 ~ ¥150',
  },
  {
    cat: '笔记本电脑 (Mac/Win)',
    defects: '底壳/C面深划痕、四角磕碰变形、第三方杂牌充电头、电池健康虚标、屏幕键盘压痕',
    dep: '¥265 ~ ¥785',
    parts: '原装 MagSafe/大功率电源 ¥135 ~ ¥185 · 原盒内衬 ¥55',
    labor: '¥85',
    freight: '¥85 ~ ¥110',
  },
  {
    cat: '手机 / iPad 平板',
    defects: '强光屏划痕、边框磕掉漆、气密性异常、爱思改绿/换过非原装屏或电池',
    dep: '¥185 ~ ¥625',
    parts: '原装快充头线 ¥65 ~ ¥95 · 防水胶重封 ¥55',
    labor: '¥65',
    freight: '¥55 ~ ¥75',
  },
  {
    cat: '微单相机 / 镜头',
    defects: 'CMOS进灰划痕、快门数超标、镜片霉丝、蒙皮起翘松脱、底板三脚架深磨痕',
    dep: '¥315 ~ ¥955',
    parts: '原装电池/座充/遮光罩 ¥135 ~ ¥215 · CMOS深度清洁 ¥95',
    labor: '¥95',
    freight: '¥75 ~ ¥105',
  },
  {
    cat: '游戏掌机 (SteamDeck/NS)',
    defects: '摇杆磨损漂移、背壳划痕磕碰、撕膜后内屏划痕、按键塌陷、缺原装收纳包与电源',
    dep: '¥165 ~ ¥465',
    parts: '原装收纳包+原装电源 ¥85 ~ ¥115 · 霍尔摇杆更换 ¥75',
    labor: '¥65',
    freight: '¥60 ~ ¥75',
  },
];

const TACTIC_LOOKUP_REFS = [
  {
    scene: '① 刚拒签加上卖家微信，准备开第一刀',
    diag: '卖家刚收到顺丰拒签推送，正处于心慌信息盲区',
    codes: '50%半价砍 + G1 + P1',
    action: '散客直接报 50% 半价（“700可以接受”）；老手切 P1 废单重估 + G1 谢林默认退件锁（不回自动原路退回），报完沉默 6 秒！',
    taboo: '严禁第一口只砍一两百替卖家省钱，严禁说“能不能退我一点好不好”求句！',
  },
  {
    scene: '② 卖家急问：「便宜几十 / 退200行不行，别退回来了！」',
    diag: '极怕亏运费和卡一周回款（鲁宾斯坦耐心极低 δ=0.58）',
    codes: 'G2 晾单 + 欲擒故纵 + P4',
    action: '先战略晾单 8–12 分钟！再冷淡发「不用啦，谢谢，直接让顺丰退回吧」，紧接 P4 往返保价费三笔亏账游说！',
    taboo: '严禁秒回顺杆讨价还价（如秒接“200太少退280吧”），瞬间暴露你想留货！',
  },
  {
    scene: '③ 卖家炸毛骂：「你这就是恶意到手刀！挑刺！」',
    diag: '情绪防御应激，一旦吵起来卖家为保面子绝不让步',
    codes: 'P2 沃斯指控审计 + P3 拆项锚',
    action: '先用 P2 抢先替他说完（“我知道哥第一反应肯定怀疑到手刀，换我也烦”），再甩一镜到底原片 + P3 三项带零头客观定损单！',
    taboo: '严禁跟卖家对骂攻击“你这破烂根本不值钱”（正面撞击禀赋效应必崩）！',
  },
  {
    scene: '④ 卖家嘴硬：「不卖你了，退回来我挂闲鱼卖别人一样卖！」',
    diag: '严重高估外部期权 BATNA，没算清柠檬市场后果',
    codes: 'G3 阿克洛夫柠檬市场推演',
    action: '帮他算两条死路：明标瑕疵重挂变柠檬机散客再砍三百没人问；隐瞒发给散客必闹小二法庭扯皮半个月！',
    taboo: '严禁苦苦挽留说“别退嘛我再加点”，要让他看清卖给我们一次买断最划算！',
  },
  {
    scene: '⑤ 卖家狡辩：「原装头在老家忘放了 / 这小暗病绝对用不坏」',
    diag: '试图用无成本口头借口逃避配件或风险折价',
    codes: 'G4 赫维茨三契约测谎仪',
    action: '抛三契约：①现金折让买断；②24h顺丰补寄原装件免扣配件费；③签30天坏了包退全款——撒谎卖家当场乖乖选①！',
    taboo: '严禁跟卖家争论“你发货前到底有没有”，只拿契约结果验证！',
  },
  {
    scene: '⑥ 卖家磨到接近目标价，但死缠烂打逼你再加 150 元',
    diag: '以为采购员手里还有无限加价权限，试探我方底线',
    codes: 'P5 红白脸权力隔离脱敏单',
    action: '发脱敏《ERP定损锁死上限单》演系统黑脸卡死，你唱白脸说“拿我个人本月机动权限私人帮你多顶50块凑整”收口！',
    taboo: '严禁无条件大跳水（如 700→400→200），每次让步必须越来越小且换当场拍板！',
  },
  {
    scene: '⑦ 卖家极强硬：「我打 95338 已经让顺丰退回了！」',
    diag: '真硬骨头试探，需立刻按《捡漏保底盈利探测器》分流',
    codes: '勉强收下保底 / G5 封车通牒',
    action: '若本单保底仍净赚几百块：发「算了吧太急了，虽然这么烂我也勉强收下」让他撤回95338锁利润；否则冷却后发 G5 封车前20分钟通牒！',
    taboo: '严禁赌气把保底净赚 500 块的捡漏肥单退走；严禁未撤回 95338 就点入库！',
  },
  {
    scene: '⑧ 大额砍价谈妥（如 2000→800），准备关闲鱼单收尾',
    diag: '最危险反水期！卖家若有屈辱感半夜必反悔或投诉',
    codes: 'P6 峰终面子补偿 + 整单退对公',
    action: '必发 P6 给足无辜台阶（“估计顺丰颠的绝非哥故意，排明早10点第一批打款”）+ 微信四要素文字定案 + 闲鱼整单退关单走次日10点对公支付！',
    taboo: '严禁走闲鱼部分退款（弹红标+被刷差评+二次申诉）！严禁私人微信转账！',
  },
];

function startDraft(p) {
  err.value = '';
  draftTarget.value = p;
  df.ref_yuan = Math.round(p.ref_price_cents / 100);
  df.first_yuan = Math.round(p.first_offer_cents / 100);
  df.target_yuan = Math.round(p.target_cents / 100);
  df.ceil_yuan = Math.round(p.ceiling_cents / 100);
}

const draftGate = computed(() => {
  if (!isPracticeUnlocked()) return { ok: false, reason: '请先完成新手防踩坑练习' };
  if (!(df.first_yuan > 0 && df.first_yuan <= df.target_yuan && df.target_yuan <= df.ceil_yuan)) {
    return { ok: false, reason: '价格必须满足：开口价 ≤ 目标价 ≤ 最高上限' };
  }
  if (df.ceil_yuan > df.ref_yuan) {
    return { ok: false, reason: '最高出价上限不能高于公司参考价' };
  }
  return { ok: true };
});

function switchToBoss() {
  setActor('wangzg');
  notify('已切换为【王主管】，可点击「审核通过并发布」');
}

async function submitDraft() {
  busy.value = true;
  err.value = '';
  try {
    await callAction(
      '/api/pricebook/draft',
      {
        model_code: draftTarget.value.model_code,
        spec_label: draftTarget.value.spec_label,
        condition_grade: draftTarget.value.condition_grade,
        ref_price_cents: Math.round(df.ref_yuan * 100),
        first_offer_cents: Math.round(df.first_yuan * 100),
        target_cents: Math.round(df.target_yuan * 100),
        ceiling_cents: Math.round(df.ceil_yuan * 100),
      },
      '调价草稿已提交，等待王主管复核发布'
    );
    draftTarget.value = null;
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function publishItem(itemId) {
  busy.value = true;
  try {
    const res = await callAction(`/api/pricebook/${itemId}/publish`, {}, '新价格已审核生效！');
    lastImpact.value = res.impact || { model_code: itemId, impacted_open_conversations: [] };
  } finally {
    busy.value = false;
  }
}
</script>
