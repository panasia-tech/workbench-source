<template>
  <div v-if="store.practiceKey" class="mask" @click.self="close">
    <div class="sheet" role="dialog" aria-label="实操沙盒练习">
      <div class="top">
        <div>
          <span class="tag acc">练习 · 隔离演练假数据</span>
          <h2>{{ S.title }}</h2>
        </div>
        <button class="x" @click="close"><Icon name="close" /></button>
      </div>
      <p class="iso">这是练习：数据全是假的，和真实库存、工单完全隔离，点什么都不会改动真实台账。故意点错也能看到系统怎么拦你。</p>

      <div v-if="!finished" class="body">
        <ol class="steps">
          <li v-for="(s, i) in S.steps" :key="i" :class="{ done: i < n, cur: i === n }">
            <i>{{ i < n ? '✓' : i + 1 }}</i><span>{{ s.title }}</span>
          </li>
        </ol>
        <div class="stage">
          <div class="learn">
            <b>这一步要做什么</b>
            <p>{{ cur.learn }}</p>
            <p class="guard"><b>这一步系统在防什么：</b>{{ cur.guard }}</p>
          </div>

          <div class="mock">
            <div class="mh"><b>{{ S.item }}</b><span class="tag">{{ S.code }}</span></div>

            <template v-if="cur.kind === 'scan'">
              <label class="f">扫码核对机身货号
                <span class="row">
                  <input v-model="scanInput" placeholder="输入或模拟扫码" />
                  <button class="btn sm" @click="scanInput = 'PRACTICE-WRONG-02'">模拟扫错串件码</button>
                  <button class="btn sm pri" @click="scanInput = S.code">模拟扫正确码</button>
                </span>
              </label>
              <p v-if="scanInput && scanInput !== S.code" class="why-box red">扫码货号「{{ scanInput }}」与订单锁定单件「{{ S.code }}」不一致，系统已硬拦截出库！</p>
              <p v-else-if="scanInput === S.code" class="why-box grn">单件条码核验一致 ✓</p>
            </template>

            <div class="btns">
              <button
                v-for="(b, i) in cur.buttons"
                :key="i"
                class="btn"
                :class="b.ok ? 'pri' : ''"
                :disabled="b.ok && cur.kind === 'scan' && scanInput !== S.code"
                @click="choose(b)"
              >{{ b.t }}</button>
            </div>
            <p v-if="warn" class="why-box red">{{ warn }}</p>
          </div>
        </div>
      </div>

      <div v-else class="done">
        <div class="ok">✓</div>
        <h3>这个练习做完了（3 / 3 步）</h3>
        <p class="muted">{{ currentUser.practiceDone ? '3 个练习都做完了，真实任务与库存操作已经开放！' : '继续做完其余练习即可解锁全部真实工单。' }}</p>
        <div class="fb-btns">
          <button class="btn" @click="restart">再练一遍</button>
          <button v-if="currentUser.practiceDone" class="btn pri" @click="goToday">去「今天」开始工作</button>
          <button v-else class="btn pri" @click="close">回到「学」做下一个</button>
        </div>
      </div>
    </div>
  </div>
</template>
<script setup>
import { computed, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { store, currentUser, advancePracticeStep, go } from '../store/warehouseStore.js'

const SCRIPTS = {
  case1: {
    title: '练习 1：到货拆封录像与碎屏手机「坏货全检」',
    item: '二手 iPhone 15 Pro 256G（演练假数据）',
    code: 'PRACTICE-IP15P',
    steps: [
      {
        title: '拆封前开启顶拍录制',
        learn: '包裹到工位先核对面单，检查高拍仪对焦清晰，点「开始拆封前录制」拍清六面封口后再动刀拆箱。',
        guard: '防止拆完发现碎屏或空包时没有第一现场连续录像，卖家扯皮拒赔。',
        buttons: [
          { t: '先用美工刀拆开看看成色，有问题再补录', warn: '不行：拆封后再补录丧失第一现场证据效力！真实工作台在开启录制前会把检验项与拍照按钮全部锁死。' },
          { t: '核对面单并开启拆封前连续录制', ok: true }
        ]
      },
      {
        title: '检出碎屏后继续测完剩余安全项',
        learn: '拆封发现右上角外屏碎裂（卖家只报细痕），此时还要不要测主板、面容、前后摄像头和 ID 锁？',
        guard: '防止只报碎屏退差 ¥300 留货，结果事后发现主板暗病再亏 ¥2,000（坏货全检硬规则）。',
        buttons: [
          { t: '反正屏幕碎了，直接停手提交退货', warn: '不行：系统会硬拦截未测完的 P07–P10 项目！就算退货或议价，也必须把所有安全可测项一次测透留证。' },
          { t: '拍碎屏微距照，并继续把面容/相机/账号锁全部测完', ok: true }
        ]
      },
      {
        title: '回放确认可读并分流入隔离区',
        learn: '全部项目实测完毕，结束录像并回放 3 秒确认不是黑屏坏片，把这台异常机分流入库。',
        guard: '严禁未回放确认可读伪报上传成功；严禁把异常机错放进「已复核可售」库区。',
        buttons: [
          { t: '直接放进「已复核可售」库区等采购慢慢谈', warn: '放行矩阵硬拦截：存在异常项的商品绝对不能进可售池，否则会被销售误上架卖出！' },
          { t: '回放确认录像可读，分流入「异常隔离（不可售）」', ok: true }
        ]
      }
    ]
  },
  case2: {
    title: '练习 2：10分钟货不对版三路首报与货钱双轨结案',
    item: '创维 27寸显示器实收 24寸（演练假数据）',
    code: 'PRACTICE-MON24',
    steps: [
      {
        title: '10分钟内并行发起三路首报',
        learn: '13:53 首次发现卖家把 27 寸错发成 24 寸，唯一 10 分钟倒计时立刻起算。',
        guard: '防止拖到快递小哥走远或签收超时；重复催办绝不重置首次发现时钟。',
        buttons: [
          { t: '等下班汇总成表格再统一发给采购', warn: '不行：超过 10 分钟未完成拒签与通知采购会直接标红超时升级主管！' },
          { t: '立即联系快递原单拒签 + 推差异证据给原采购员', ok: true }
        ]
      },
      {
        title: '全检完成后再把实物交给快递退回',
        learn: '顺丰小哥在催取件，但这台显示器的接口和面板坏点还差最后 1 项没测完。',
        guard: 'WH08-02 硬防呆：全量验货完成前，禁止把异常实物提前交回快递退走，避免退回途中卖家反咬屏幕是我们弄坏的。',
        buttons: [
          { t: '赶紧先塞给顺丰小哥拿走，省得再跑一趟', warn: '系统硬拦截：全检未完成留底前禁止交回快递！万一退回路上出纠纷没有全套实测留证就说不清了。' },
          { t: '花 2 分钟测完最后 1 项留足影像，再交顺丰退回原网点', ok: true }
        ]
      },
      {
        title: '核清网点签收与运费差额后再结案',
        learn: '退件到达原发件网点已签收，原采购款 ¥680 卖家只退了 ¥645（扣了 ¥35 运费）。',
        guard: '已寄出不等于已签收，已退部分款不等于钱清，差额未核清严禁结案。',
        buttons: [
          { t: '退件都签收了，差 ¥35 小钱直接点结案', warn: '结案锁硬拦截：存在 ¥35 回款差额未核销，必须由采购追回或主管批损益后才能双清结案！' },
          { t: '保持挂起追索，待 ¥35 运费差额核清后再点双清结案', ok: true }
        ]
      }
    ]
  },
  case3: {
    title: '练习 3：17:00 发货齐套核验、扫码防串件与改址拦截',
    item: '飞利浦 27M2N5510P 锁单待发（演练假数据）',
    code: 'PRACTICE-PH27',
    steps: [
      {
        title: '主机 + 编号附件袋 + 原彩盒三件齐套',
        learn: '拣货时除了去 A-02 抱主机，还必须核对什么？',
        guard: '防止漏发专用编号附件袋里的原装电源适配器或买家约定的原装彩盒。',
        buttons: [
          { t: '抱起显示器主机直接去打包台贴单', warn: '齐套锁拦截：还没核对勾选「专用编号附件袋 BAG-A02-01」与「约定原彩盒」，漏发电源线会导致整单退货！' },
          { t: '同取主机 + 编号附件袋 + 约定原彩盒逐一打钩', ok: true }
        ]
      },
      {
        title: '扫码核对单件唯一货号（防串件）',
        learn: '货架上有两台同型号飞利浦显示器，请点击上方「模拟扫正确码」核对单件货号（也可先点扫错码看拦截）。',
        guard: '二手一机一况一价，扫错隔壁同款串件出库属于严重事故。',
        kind: 'scan',
        buttons: [
          { t: '条码核对一致，进入封箱录像', ok: true }
        ]
      },
      {
        title: '打包前买家突然改地址或发现新划痕',
        learn: '刚要封箱时，系统提示买家在闲鱼后台申请修改收货地址（或复检发现边框多了道新划痕）。',
        guard: 'G03-03 / G09：出库前出现新问题或改址，原出库资格立即作废，严禁按旧地址硬发。',
        buttons: [
          { t: '趁快递员在旁边，先按原面单发走再说', warn: '红线拦截：平台状态不同步或存在新瑕疵时确认出库按钮已锁死，强发会导致追件损失！' },
          { t: '立即点「暂停出库并退回销售重核」，等新确认后再发', ok: true }
        ]
      }
    ]
  }
}

const S = computed(() => SCRIPTS[store.practiceKey] || SCRIPTS.case1)
const n = ref(0)
const warn = ref('')
const scanInput = ref('')
const finished = computed(() => n.value >= 3)
const cur = computed(() => S.value.steps[Math.min(n.value, 2)])

watch(() => store.practiceKey, (k) => {
  if (!k) return
  const saved = currentUser.value.steps?.[k] || 0
  n.value = saved >= 3 ? 0 : saved
  warn.value = ''
  scanInput.value = ''
})

function choose(b) {
  if (b.warn) {
    warn.value = b.warn
    return
  }
  warn.value = ''
  n.value += 1
  advancePracticeStep(store.practiceKey, n.value)
}

function restart() {
  n.value = 0
  warn.value = ''
  scanInput.value = ''
}

function close() {
  store.practiceKey = ''
}

function goToday() {
  store.practiceKey = ''
  go('today')
}
</script>
<style scoped>
.sheet {
  width: min(760px, 100%);
  max-height: 90dvh;
  overflow-y: auto;
  background: var(--panel);
  border-radius: var(--r);
  box-shadow: var(--sh-up);
  border: 1px solid var(--line);
  padding: 24px 26px;
}
.top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.top h2 { font-size: 21px; margin-top: 6px; }
.x { width: 34px; height: 34px; border-radius: 50%; background: var(--soft); display: grid; place-items: center; }
.iso {
  margin: 12px 0 16px;
  padding: 9px 12px;
  background: var(--acc-soft);
  color: var(--ink2);
  border: 1px solid #cad8ff;
  border-radius: 8px;
  font-size: 13px;
}
.steps {
  list-style: none;
  margin: 0 0 16px;
  padding: 8px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 9px;
}
.steps li { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--mute); padding: 6px 8px; border-radius: 6px; }
.steps li i {
  font-style: normal;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid var(--line);
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 700;
  flex: none;
}
.steps li.done i { background: var(--grn-soft); color: var(--grn-ink); border-color: #bfead3; }
.steps li.cur { background: var(--panel); color: var(--acc); font-weight: 700; box-shadow: var(--sh); }
.steps li.cur i { background: var(--acc); color: #fff; border-color: transparent; }

.stage { display: grid; grid-template-columns: 1fr 1.25fr; gap: 16px; align-items: start; }
.learn { background: var(--soft); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; display: grid; gap: 8px; font-size: 13.5px; }
.guard { font-size: 12.5px; color: var(--amb-ink); background: var(--amb-soft); padding: 8px 10px; border-radius: 7px; }
.mock { border: 1px solid var(--line); border-radius: 10px; padding: 16px; display: grid; gap: 12px; }
.mh { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
.f { display: grid; gap: 6px; font-size: 13px; color: var(--ink2); font-weight: 600; }
.row { display: flex; gap: 6px; flex-wrap: wrap; }
.row input { flex: 1; min-width: 140px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 6px; }
.btns { display: grid; gap: 8px; }
.btns .btn { justify-content: flex-start; text-align: left; white-space: normal; height: auto; padding: 9px 14px; line-height: 1.4; }
.done { text-align: center; padding: 28px 16px; display: grid; gap: 10px; justify-items: center; }
.done .ok { width: 52px; height: 52px; border-radius: 50%; background: var(--grn-soft); color: var(--grn); font-size: 26px; font-weight: 800; display: grid; place-items: center; }
.fb-btns { display: flex; gap: 10px; margin-top: 8px; }
</style>
