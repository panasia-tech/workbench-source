<template>
  <div v-if="ui.practice" class="mask" @click.self="close">
    <div class="sheet">
      <div class="top">
        <div><span class="tag acc">练习 · 演练数据</span><h2>{{ S.title }}</h2></div>
        <button class="x" @click="close"><Icon name="close" /></button>
      </div>
      <p class="iso">这是练习：数据全是假的，和真实业务完全隔离，点什么都不会发到平台。引导不会替你点真实的高影响动作。</p>

      <div v-if="!finished" class="body">
        <ol class="steps"><li v-for="(s, i) in S.steps" :key="i" :class="{ done: i < n, cur: i === n }"><i>{{ i < n ? '✓' : i + 1 }}</i><span>{{ s.title }}</span></li></ol>
        <div class="stage">
          <div class="learn"><b>这一步要做什么</b><p>{{ cur.learn }}</p><button class="btn sm" @click="clip(cur.clip)"><Icon name="play" />看这一步的小视频</button></div>

          <div class="mock">
            <div class="mh"><b>{{ S.item }}</b><span class="tag">{{ S.code }}</span></div>

            <template v-if="cur.kind === 'price'">
              <p class="muted">成本 ¥{{ S.cost }}　最低价 ¥{{ Math.round(S.cost * 1.3) }}（成本 × 1.3）　行情价 没有</p>
              <label class="f">给这个号定售价（整数元）<input v-model.number="price" type="number" placeholder="例如 3190" /></label>
              <p v-if="price" class="hint" :class="pv.lvl">{{ pv.text }}</p>
            </template>
            <template v-else-if="cur.kind === 'check'">
              <ul class="checks"><li><span class="tag grn">通过</span>这个买家退款 0 次（线是 2 次）</li><li><span class="tag grn">通过</span>不在黑名单</li>
                <li><span class="tag" :class="reminded ? 'amb' : 'red'">{{ reminded ? '等待中' : '没过' }}</span>这个买家有 1 单还没确认收货<em v-if="!reminded"> 先不发新卡，防止拍多单、发完再退。</em></li></ul>
            </template>
            <template v-else-if="cur.kind === 'ship'">
              <label class="f">快递运单号<input v-model="trk" placeholder="发货后粘贴运单号" /></label>
              <label class="f">扫码核对货号<span class="row"><input v-model="scan" placeholder="要和上面的货号一致" /><button class="btn sm" @click="scan = S.code">模拟扫码</button></span></label>
              <p v-if="scan && scan !== S.code" class="hint red">扫码的货号和订单货号不一致，已拦住。</p>
            </template>
            <template v-else-if="cur.kind === 'slot'">
              <label class="f">和买家约的时间<select v-model="slot"><option value="">请选择</option><option>周六 10:00</option><option>周日 14:00</option></select></label>
            </template>

            <div class="btns">
              <template v-for="(b, i) in cur.buttons" :key="i">
                <button class="btn" :class="b.ok ? 'pri' : ''" :disabled="b.ok && !ready" @click="click(b)">{{ b.t }}</button>
              </template>
            </div>
            <p v-if="warn" class="hint red big">{{ warn }}</p>
            <p v-if="cur.kind === 'check' && !reminded" class="muted sm">提示：命中检查就不能直接发。先提醒买家确认上一单，再继续。</p>
            <p v-if="cur.guard" class="guard"><b>这一步系统在防什么：</b>{{ cur.guard }}</p>
          </div>
        </div>
      </div>

      <div v-else class="done">
        <div class="ok">✓</div><h3>这个练习做完了</h3>
        <p class="muted">{{ allDone ? '3 个练习都做完了，真实任务已经开放。' : '还剩 ' + left + ' 个练习没做。' }}</p>
        <div class="fb"><button class="btn" @click="restart">再练一遍</button><button v-if="allDone" class="btn pri" @click="goToday">去「今天」</button><button v-else class="btn pri" @click="close">回到学</button></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { ui, openVideo, toast } from './ui.js'
import { VIDEOS } from './help.js'
import { post } from './api.js'
import { state, loadAll } from './store.js'

const SCRIPT = {
  phys: { title: '实物练习：二手 iPhone 13 128G 黑色', item: '二手 iPhone 13 128G 黑色（演练）', code: 'PRACTICE-IP13', cost: 2200, steps: [
    { title: '核对闲鱼均价并选图', learn: '先看采购成本与闲鱼清洗均价，从大库「推荐可使用」里选几张不重复图，确认不低于成本的整数售价即可直接上架。', clip: VIDEOS.phys[4], kind: 'price', guard: '低于采购成本会被价格围栏拦住；缺图、缺成本也不让直接发布。',
      buttons: [{ t: '确认选图与价格，直接上架', ok: true }, { t: '跳过价格围栏，亏本强发', warn: '不行：低于成本价或没选不重复图片不能直接发。系统在真实任务里会把按钮锁住。' }] },
    { title: '核对在架配额', learn: '确认选图与价格后直接发布在架。提交后 60 秒内你自己可以撤回；单店每日最多 10 票。', clip: VIDEOS.phys[4], kind: 'choose', guard: '单账号今天满 10 票第 11 票不发；货已锁单不能再上架。',
      buttons: [{ t: '删除这件商品', warn: '这是高影响动作。练习里不会真的删除。' }, { t: '确认发布在架（练习）', ok: true }] },
    { title: '发货出库', learn: '买家付款后，扫码核对货号，填快递运单号，再确认出库。', clip: VIDEOS.phys[5], kind: 'ship', guard: '货号不一致不让出库；同一件货不能出两次；买家取消或改地址要先同步状态。',
      buttons: [{ t: '先不出库', warn: '实物当天 17:00 前要发，拖着会跳红。先把货号和运单号填好。' }, { t: '确认出库', ok: true }] }
  ] },
  virt: { title: '虚拟练习：星巴克中杯券', item: '星巴克 中杯饮品券（演练）', code: 'PRACTICE-SBX', cost: 27, steps: [
    { title: '发货检查', learn: '买家付款后系统先做发货检查：退款次数、黑名单、上一单有没有确认。命中就暂停自动发，交给你。', clip: VIDEOS.virt[5], kind: 'check', guard: '连拍多单、发完再退，是虚拟商品最常见的白嫖。',
      buttons: [{ t: '跳过检查，直接发卡密', warn: '不行：检查没过不能发。这是虚拟付款 1 分钟内要处理的单，先提醒买家确认上一单。' }, { t: '提醒买家先确认上一单', remind: true }, { t: '检查都通过了，继续', ok: true, needRemind: true }] },
    { title: '发卡密', learn: '检查通过后发卡密。有卡券的商品每单发不同的码，发出去不能撤回；买家说有问题请发起更正。', clip: VIDEOS.virt[5], kind: 'choose', guard: '卡密只发给买家，不会出现在公开的图或教程里。',
      buttons: [{ t: '把卡密发到买家微信', warn: '不行：只能通过订单发。私下发的卡密没有留痕，出问题没法查。' }, { t: '发卡密（练习）', ok: true }] },
    { title: '确认买家收到', learn: '买家确认收货后，这单才算完成，提成才会变成「已确认」。', clip: VIDEOS.virt[6], kind: 'choose', guard: '没确认之前，这位买家再拍新单会被发货检查拦住。',
      buttons: [{ t: '先放着', warn: '先别放着：确认前提成是「待确认」。点「买家已确认」才算完成。' }, { t: '买家已确认', ok: true }] }
  ] },
  svc: { title: '服务练习：安卓刷机', item: '安卓刷机服务（演练）', code: 'PRACTICE-FLASH', cost: 40, steps: [
    { title: '接单', learn: '新订单先接单。一小时时效从接单开始算；疑难急单可以转给同行。', clip: VIDEOS.virt[5], kind: 'choose', guard: '拒单要写原因，不能默默不理。',
      buttons: [{ t: '拒单', warn: '不要直接拒：先看能不能转给同行。练习里请接单。' }, { t: '接单', ok: true }] },
    { title: '约时间', learn: '和买家约一个具体的时间，写进订单。', clip: VIDEOS.virt[5], kind: 'slot', guard: '不约时间不能进入交付。',
      buttons: [{ t: '选定这个时间', ok: true }] },
    { title: '交付并确认完成', learn: '做完要验证最初的报错有没有解决，再让买家确认完成。', clip: VIDEOS.virt[5], kind: 'choose', guard: '没验证原始报错就确认，容易返工扣提成。',
      buttons: [{ t: '直接确认完成', warn: '先验证最初的报错已经没了，再确认。练习里请点「验证通过，确认完成」。' }, { t: '验证通过，确认完成', ok: true }] }
  ] }
}
const S = computed(() => SCRIPT[ui.practice] || SCRIPT.phys)
const n = ref(0)
const price = ref(null)
const trk = ref('')
const scan = ref('')
const slot = ref('')
const reminded = ref(false)
const warn = ref('')
const finished = computed(() => n.value >= 3)
const cur = computed(() => S.value.steps[Math.min(n.value, 2)])
const pv = computed(() => { const floor = Math.round(S.value.cost * 1.3); const p = Number(price.value); return p < floor ? { lvl: 'red', text: `低于最低价 ¥${floor}（成本 × 1.3）：这次不能发，已拦住。` } : p > S.value.cost * 5 ? { lvl: 'amb', text: '高于成本的 500%，可以发，请确认没有多打一个 0。' } : { lvl: 'grn', text: '价格在正常范围 ✓' } })
const ready = computed(() => { const k = cur.value.kind; if (k === 'price') return Number(price.value) >= Math.round(S.value.cost * 1.3); if (k === 'ship') return !!trk.value.trim() && scan.value === S.value.code; if (k === 'slot') return !!slot.value; if (k === 'check') return reminded.value; return true })
const left = computed(() => Object.values(state.me?.practice || {}).filter((v) => v < 3).length)
const allDone = computed(() => left.value === 0)
const clip = (v) => openVideo({ ...v })
function reset() { n.value = 0; price.value = null; trk.value = ''; scan.value = ''; slot.value = ''; reminded.value = false; warn.value = '' }
watch(() => ui.practice, (v) => { if (v) reset() })
const close = () => { ui.practice = null }
async function click(b) {
  warn.value = ''
  if (b.warn) { warn.value = b.warn; return }
  if (b.remind) { reminded.value = true; toast('已提醒买家（演练）'); return }
  if (!b.ok) return
  n.value++
  price.value = null; trk.value = ''; scan.value = ''; slot.value = ''
  try { await post('/demo/practice', { key: ui.practice, step: n.value }); await loadAll() } catch (e) { toast(e.message) }
}
const restart = () => reset()
const goToday = () => { close(); location.hash = '#/today' }
</script>

<style scoped>
.mask { position: fixed; inset: 0; background: rgba(8, 12, 22, .6); z-index: 75; display: flex; align-items: center; justify-content: center; padding: 24px; backdrop-filter: blur(4px); }
.sheet { background: var(--panel); border-radius: 28px; width: min(1040px, 100%); max-height: 92vh; overflow-y: auto; padding: 26px 30px 30px; box-shadow: var(--sh-up); }
.top { display: flex; justify-content: space-between; align-items: flex-start; } .top h2 { font-size: 26px; margin-top: 8px; } .x { width: 38px; height: 38px; border-radius: 50%; background: var(--soft); display: flex; align-items: center; justify-content: center; } .x svg { width: 18px; height: 18px; }
.iso { margin: 14px 0 20px; background: var(--amb-soft); color: var(--amb-ink); border-radius: 14px; padding: 10px 16px; font-size: 14px; }
.steps { list-style: none; display: flex; gap: 10px; padding: 0; margin: 0 0 20px; } .steps li { flex: 1; display: flex; align-items: center; gap: 10px; background: var(--soft); padding: 10px 14px; border-radius: 14px; font-weight: 700; font-size: 14px; color: var(--mute); } .steps i { width: 26px; height: 26px; border-radius: 50%; background: var(--line); display: flex; align-items: center; justify-content: center; font-style: normal; font-size: 13px; }
.steps li.cur { background: var(--acc-soft); color: var(--acc); } .steps li.cur i { background: var(--acc); color: #fff; } .steps li.done { background: var(--grn-soft); color: var(--grn-ink); } .steps li.done i { background: var(--grn); color: #fff; }
.stage { display: grid; grid-template-columns: 300px 1fr; gap: 22px; } @media (max-width: 900px) { .stage { grid-template-columns: 1fr; } }
.learn { background: var(--acc-soft); border-radius: 20px; padding: 18px 20px; font-size: 14.5px; } .learn p { margin: 8px 0 14px; line-height: 1.6; } .learn .btn svg { width: 16px; height: 16px; }
.mock { border: 2px solid var(--line); border-radius: 22px; padding: 20px 22px; } .mh { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; } .mh b { font-size: 18px; }
.f { display: grid; gap: 6px; margin: 12px 0; font-size: 13.5px; font-weight: 600; color: var(--mute); } .f input, .f select { height: 42px; border: 1px solid var(--line); border-radius: 12px; padding: 0 14px; background: var(--panel); color: var(--ink); font-weight: 400; } .row { display: flex; gap: 8px; } .row input { flex: 1; }
.hint { padding: 9px 13px; border-radius: 12px; font-size: 14px; font-weight: 600; } .hint.red { background: var(--red-soft); color: var(--red-ink); } .hint.amb { background: var(--amb-soft); color: var(--amb-ink); } .hint.grn { background: var(--grn-soft); color: var(--grn-ink); } .hint.big { margin-top: 12px; }
.checks { list-style: none; margin: 8px 0; padding: 0; display: grid; gap: 8px; } .checks li { display: flex; gap: 10px; align-items: baseline; background: var(--soft); padding: 10px 14px; border-radius: 12px; } .checks em { color: var(--mute); font-style: normal; font-size: 13px; }
.btns { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; } .sm { font-size: 13px; margin-top: 8px; } .guard { margin-top: 16px; font-size: 13.5px; color: var(--mute); border-top: 1px dashed var(--line); padding-top: 12px; }
.done { text-align: center; padding: 40px 0 20px; } .ok { width: 76px; height: 76px; border-radius: 50%; background: var(--grn); color: #fff; font-size: 40px; display: flex; align-items: center; justify-content: center; margin: 0 auto 14px; } .fb { display: flex; justify-content: center; gap: 10px; margin-top: 20px; }
</style>
