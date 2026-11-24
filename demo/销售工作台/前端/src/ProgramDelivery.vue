<template>
  <div class="page pg">
    <header class="head">
      <div><p class="eyebrow">D05 · 服务程序化交付</p><h1>服务包装成卡券 / 预约码<Q k="pg-main" /></h1>
        <p class="sub">把能标准化的服务做成「程序自助」：买家拿到预约码，自己进预约页选时段；后台看排期、占位、核销；取消释放名额，回执回到原订单。不能标准化的服务仍走人工排期。</p></div>
      <button class="btn" @click="goProduct">打开服务产品卡 ›</button>
    </header>

    <div class="sel">
      <button v-for="p in db.programs" :key="p.id" class="pc" :class="{ on: cur?.id === p.id }" @click="cur = p">
        <b>{{ p.name }}</b><span>{{ p.mode }} · 本周 {{ p.booked }}/{{ p.capacity }}</span>
      </button>
    </div>

    <template v-if="cur">
      <section class="grid">
        <div class="card">
          <h3>{{ cur.name }} <span class="tag" :class="cur.mode === '预约码' ? 'grn' : 'amb'">{{ cur.mode }}</span></h3>
          <div class="cap"><div class="bar"><i :style="{ width: Math.min(100, (cur.booked / cur.capacity) * 100) + '%', background: cur.booked >= cur.capacity ? 'var(--red)' : 'var(--acc)' }"></i></div><p class="muted">本周已占 <b>{{ cur.booked }}</b> / {{ cur.capacity }}；剩余 {{ Math.max(0, cur.capacity - cur.booked) }}。并发占位：同一个时段最多 1 单，取消立即释放。</p></div>
          <h4>可选时段</h4>
          <div class="slots"><button v-for="s in cur.slots" :key="s" :class="{ on: slot === s, full: isFull(s) }" :disabled="isFull(s)" @click="slot = s">{{ s }}<small>{{ isFull(s) ? '已占' : '可约' }}</small></button></div>
          <div class="book"><input v-model="buyer" placeholder="买家（演示）" /><button class="btn pri" :disabled="!slot || !buyer" @click="book">预约并生成回执</button><button class="btn" @click="gen">生成一个预约码</button></div>
          <p class="muted sm">预约成功会：占住时段 → 发预约码 → 回执回原订单 → 后台排期可见。取消时释放时段和码。</p>
        </div>

        <div class="card">
          <h3>预约页预览 <small class="muted">买家看到的样子</small></h3>
          <div class="phone">
            <div class="ph-h"><b>{{ cur.name }}</b><span class="tag grn">可预约</span></div>
            <p class="muted">{{ cur.mode === '预约码' ? '输入预约码，选一个时段' : '留下联系方式，人工排期' }}</p>
            <label>预约码<input :value="cur.codes.find((c) => c.state === '未用')?.code || '（先生成一个）'" readonly /></label>
            <label>时段<select v-model="slot"><option value="">选时段</option><option v-for="s in cur.slots" :key="s" :disabled="isFull(s)">{{ s }}</option></select></label>
            <label>称呼<input v-model="buyer" placeholder="怎么称呼" /></label>
            <button class="btn pri" :disabled="!slot || !buyer" @click="book">确认预约</button>
            <p class="muted sm">正式版预约页由程序员接；这里只演示字段和状态。</p>
          </div>
        </div>
      </section>

      <section class="card" style="margin-top: 14px">
        <h3>预约码台账 <small class="muted">未用 / 已预约 / 已核销 / 已取消</small></h3>
        <div class="tblwrap"><table class="tbl"><thead><tr><th>码</th><th>状态</th><th>买家</th><th>时段</th><th>回执</th><th></th></tr></thead><tbody>
          <tr v-for="c in cur.codes" :key="c.code"><td><code>{{ c.code }}</code></td><td><span class="tag" :class="CS[c.state]">{{ c.state }}</span></td><td>{{ c.buyer || '—' }}</td><td>{{ c.at || '—' }}</td><td class="muted">{{ c.receipt || '—' }}</td>
            <td class="ac"><button v-if="c.state === '已预约'" class="btn sm pri" @click="redeem(c)">核销</button><button v-if="c.state === '已预约'" class="btn sm" @click="cancel(c)">取消 / 释放</button></td></tr>
          <tr v-if="!cur.codes.length"><td colspan="6" class="muted">还没有预约码。</td></tr>
        </tbody></table></div>
      </section>
    </template>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import Q from './Q.vue'
import { finalDb as db, uid } from './demoFinal.js'
import { toast } from './ui.js'

const CS = { 未用: 'acc', 已预约: 'amb', 已核销: 'grn', 已取消: 'red' }
const cur = ref(db.programs[0] || null)
const slot = ref(''), buyer = ref('')
const isFull = (s) => cur.value.codes.some((c) => c.state === '已预约' && c.at === s)
function gen() { const code = 'YY-' + Math.random().toString(36).slice(2, 6).toUpperCase(); cur.value.codes.push({ code, state: '未用' }); toast('已生成预约码 ' + code) }
function book() {
  if (!cur.value || !slot.value || !buyer.value) return
  if (isFull(slot.value)) return toast('这个时段已被占，换一个')
  let c = cur.value.codes.find((x) => x.state === '未用')
  if (!c) { gen(); c = cur.value.codes.at(-1) }
  c.state = '已预约'; c.buyer = buyer.value; c.at = slot.value; c.receipt = '回执已回原订单（演示）'
  cur.value.booked = Math.min(cur.value.capacity, cur.value.booked + 1)
  toast(`已预约 ${slot.value}，预约码 ${c.code}，回执回原订单`)
  buyer.value = ''
}
function redeem(c) { c.state = '已核销'; c.receipt = '核销回执已回原订单（演示）'; toast('已核销，回执回原订单') }
function cancel(c) { c.state = '已取消'; cur.value.booked = Math.max(0, cur.value.booked - 1); toast('已取消，时段和名额已释放') }
function goProduct() { if (!cur.value) return; const p = cur.value.pid; location.hash = `#/item/svc/${encodeURIComponent(p)}` }
</script>

<style scoped>
.pg { padding: 30px 40px 80px; max-width: 1560px; } .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; } .eyebrow { margin: 0; font-size: 13px; font-weight: 700; color: var(--acc); } .pg h1 { font-size: 34px; margin: 6px 0; letter-spacing: -.02em; } .sub { margin: 0; color: var(--mute); max-width: 920px; line-height: 1.7; }
.sel { display: flex; gap: 10px; flex-wrap: wrap; margin: 18px 0 14px; } .pc { background: var(--panel); border-radius: 14px; padding: 10px 14px; box-shadow: var(--sh); display: grid; text-align: left; min-width: 200px; } .pc b { font-size: 14.5px; } .pc span { font-size: 12.5px; color: var(--mute); } .pc.on { outline: 3px solid var(--acc); }
.grid { display: grid; grid-template-columns: 1.15fr .85fr; gap: 16px; align-items: start; }
.card h3 { margin: 0 0 10px; font-size: 17px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; } .card h4 { margin: 18px 0 8px; font-size: 15px; }
.cap { margin: 8px 0; } .cap .bar { height: 14px; margin-bottom: 6px; }
.slots { display: flex; gap: 8px; flex-wrap: wrap; } .slots button { border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px; background: var(--soft); font-weight: 700; font-size: 13.5px; display: grid; gap: 2px; text-align: left; } .slots button small { font-weight: 400; color: var(--mute); font-size: 11.5px; } .slots button.on { background: var(--acc); color: #fff; } .slots button.on small { color: #fff; opacity: .8; } .slots button.full { opacity: .45; }
.book { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; } .book input { flex: 1; min-width: 160px; height: 38px; border: 1px solid var(--line); border-radius: 10px; padding: 0 10px; background: var(--soft); color: var(--ink); }
.phone { background: var(--soft); border-radius: 20px; padding: 16px; display: grid; gap: 10px; border: 6px solid var(--line); } .ph-h { display: flex; justify-content: space-between; align-items: center; } .phone label { display: grid; gap: 4px; font-size: 12.5px; color: var(--mute); } .phone input, .phone select { height: 36px; border: 1px solid var(--line); border-radius: 9px; padding: 0 10px; background: var(--panel); color: var(--ink); }
.ac { white-space: nowrap; } .sm { font-size: 12.5px; } code { font-size: 12.5px; }
</style>
