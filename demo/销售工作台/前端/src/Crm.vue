<template>
  <div class="page cr">
    <header class="head">
      <div><p class="eyebrow">客户资源（简单概述）</p><h1>群 / 渠道统筹<Q k="crm-main" /></h1>
        <p class="sub"><button class="btn sm" @click="goCycles">浙江餐饮 / 新品牌研究 ›</button> 哪个群、哪个渠道对应哪个产品，一眼看清：这个是星巴克，那个是肯德基，这个是三角洲服务。<b>这里只是概述</b>，完整的客户资源管理（买家、群聊、供货关系）以后用专门的 SaaS；现在先把「谁对应哪个产品、到了哪一步」统起来。</p></div>
      <button class="btn pri" @click="openAdd()">+ 登记一个群 / 渠道</button>
    </header>

    <section class="fun">
      <div v-for="s in d.states" :key="s" class="fn"><b>{{ cnt(s) }}</b><span>{{ s }}</span></div>
      <p class="muted">发现 → 已联系 → 已加入 → 已核验 → 已合作，<b>只能一步一步往后</b>：搜到群名不等于已联系，更不等于已合作；核验和合作要写依据（试单结果、报价、交付证据）。</p>
    </section>

    <div v-for="grp in tree" :key="grp.big" class="big">
      <h2>{{ grp.big }}</h2>
      <div class="cards">
        <article v-for="p in grp.items" :key="p.id" class="pc card">
          <div class="ph"><img :src="`/api/demo-img/V-${p.cover}.jpg`" alt="" /><div><b>{{ p.name }}</b><small>{{ p.path.slice(1).join(' › ') }}</small></div><button class="btn sm" @click="openAdd(p.id)">+ 登记</button></div>
          <div v-if="byP(p.id).length" class="gl"><div v-for="g in byP(p.id)" :key="g.id" class="gi">
            <div class="gt"><b>{{ g.name }}</b><span class="tag">{{ g.role }}</span><span class="tag" :class="STC[g.state]">{{ g.state }}</span><span v-if="extra(g).primary" class="tag" :class="extra(g).primary === '主供' ? 'grn' : 'amb'">{{ extra(g).primary }}</span></div>
            <p v-if="extra(g).quote || extra(g).leadTime || extra(g).quota" class="terms">报价 {{ extra(g).quote || '—' }} {{ extra(g).currency || '' }} · 有效期 {{ extra(g).valid || '—' }} · 交期 {{ extra(g).leadTime || '—' }} · 额度 {{ extra(g).quota || '—' }} · 资格 {{ extra(g).qualify || '—' }}<template v-if="extra(g).trial"> · 试单 {{ extra(g).trial }}</template></p>
            <small class="muted">{{ g.platform || '平台未填' }}<template v-if="g.size"> · {{ g.size }}</template><template v-if="g.owner"> · 群主 / 联系人：{{ g.owner }}</template></small>
            <div v-if="next(g)" class="nx"><input v-model="note[g.id]" :placeholder="needNote(g) ? '依据（≥6 字，必填）' : '备注（可不填）'" /><button class="btn sm" @click="step(g)">推进到「{{ next(g) }}」</button></div>
          </div></div>
          <p v-else class="muted none">还没登记群或渠道<span class="tag red">缺口</span></p>
        </article>
      </div>
    </div>

    <section v-if="leads.length" class="big"><h2>线索来源群（还没对应产品）</h2><div class="cards"><article v-for="g in leads" :key="g.id" class="pc card"><div class="gt"><b>{{ g.name }}</b><span class="tag">{{ g.role }}</span><span class="tag" :class="STC[g.state]">{{ g.state }}</span></div><small class="muted">{{ g.platform }} {{ g.size }}</small><p class="muted sm">群里的活动券线索进选品线索池（还没做）；确认对应哪个产品后再挂过去。</p></article></div></section>

    <div v-if="add" class="mask" @click.self="add = null"><div class="modal"><h3>登记一个群 / 渠道</h3>
      <label>对应哪个产品<select v-model="add.pid"><option value="">（线索来源群，还没对应产品）</option><option v-for="p in d.products" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
      <label>角色<select v-model="add.role"><option value="">选一个</option><option v-for="r in d.roles" :key="r">{{ r }}</option></select></label>
      <label>群名 / 渠道名<input v-model="add.name" placeholder="例如：星巴克中杯券 供货群" /></label>
      <div class="two"><label>平台<input v-model="add.platform" placeholder="微信 / 钉钉 / 闲鱼…" /></label><label>规模<input v-model="add.size" placeholder="例如 200 人" /></label></div>
      <label>群主 / 联系人 / 实际供货方<input v-model="add.owner" placeholder="介绍人不一定是供货方，分开写" /></label>
      <div class="two"><label>报价<input v-model="add.quote" placeholder="例如 ¥35 / 张" /></label><label>币种<input v-model="add.currency" placeholder="CNY / JPY" /></label></div>
      <div class="two"><label>报价有效期<input v-model="add.valid" placeholder="11-20" /></label><label>主供 / 备用<select v-model="add.primary"><option value="">未定</option><option>主供</option><option>备用</option></select></label></div>
      <div class="two"><label>交期<input v-model="add.leadTime" placeholder="当天 / 3 天" /></label><label>额度 / 数量<input v-model="add.quota" placeholder="每天 50 张" /></label></div>
      <div class="two"><label>资格 / 材料<input v-model="add.qualify" placeholder="需要什么资格" /></label><label>试单结果<input v-model="add.trial" placeholder="买过几次、成没成" /></label></div>
      <label>备注<input v-model="add.note" /></label>
      <p v-if="err" class="errbox">{{ err }}</p>
      <div class="mf"><button class="btn" @click="add = null">取消</button><button class="btn pri" @click="save">登记（状态：发现）</button></div></div></div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import Q from './Q.vue'
import { api, post } from './api.js'
import { finalDb } from './demoFinal.js'
import { toast } from './ui.js'

const d = ref({ roles: [], states: [], products: [], groups: [] }), add = ref(null), err = ref(''), note = reactive({})
const STC = { 发现: '', 已联系: 'amb', 已加入: 'acc', 已核验: 'grn', 已合作: 'grn' }
async function load() { try { d.value = await api('/demo/crm') } catch { /* 读不到就空着 */ } }
onMounted(load)
const byP = (id) => d.value.groups.filter((g) => g.pid === id)
const leads = computed(() => d.value.groups.filter((g) => !g.pid))
const cnt = (s) => d.value.groups.filter((g) => g.state === s).length
const tree = computed(() => { const m = new Map(); for (const p of d.value.products) { const k = p.path[0] || '其它'; if (!m.has(k)) m.set(k, []); m.get(k).push(p) } return [...m].map(([big, items]) => ({ big, items })) })
const next = (g) => d.value.states[d.value.states.indexOf(g.state) + 1] || ''
const needNote = (g) => ['已核验', '已合作'].includes(next(g))
const goCycles = () => { location.hash = '#/cycles' }
const extra = (g) => finalDb.crm[g.id] || {}
const openAdd = (pid = '') => { add.value = { pid, role: '', name: '', platform: '', size: '', owner: '', note: '', quote: '', currency: 'CNY', valid: '', primary: '', leadTime: '', quota: '', qualify: '', trial: '' }; err.value = '' }
async function save() { err.value = ''; try { const g = await post('/demo/crm/groups', add.value); if (g && g.id) finalDb.crm[g.id] = { quote: add.value.quote, currency: add.value.currency, valid: add.value.valid, primary: add.value.primary, leadTime: add.value.leadTime, quota: add.value.quota, qualify: add.value.qualify, trial: add.value.trial }; add.value = null; await load(); toast('已登记，供货条款一起存了（演示）') } catch (e) { err.value = e.message } }
async function step(g) { try { await post(`/demo/crm/groups/${g.id}/state`, { state: next(g), note: note[g.id] || '' }); note[g.id] = ''; await load() } catch (e) { toast(e.message) } }
</script>

<style scoped>
.cr { padding: 26px 40px 80px; max-width: 1560px; } .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; } .cr h1 { font-size: 34px; margin: 6px 0; letter-spacing: -.02em; } .eyebrow { margin: 0; font-size: 13px; font-weight: 700; color: var(--acc); } .sub { margin: 0; color: var(--mute); max-width: 880px; line-height: 1.7; }
.fun { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 16px 0 8px; } .fn { background: var(--panel); border-radius: 14px; padding: 8px 18px; display: grid; text-align: center; box-shadow: var(--sh); } .fn b { font-size: 26px; } .fn span { font-size: 12.5px; color: var(--mute); } .fun .muted { flex: 1; min-width: 320px; font-size: 13px; margin: 0; }
.big h2 { margin: 22px 0 10px; font-size: 20px; } .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 14px; } .pc { display: grid; gap: 8px; align-content: start; } .ph { display: flex; gap: 12px; align-items: center; } .ph img { width: 56px; height: 56px; border-radius: 12px; object-fit: cover; } .ph div { flex: 1; min-width: 0; display: grid; } .ph small { color: var(--mute); font-size: 12px; }
.gl { display: grid; gap: 8px; } .gi { padding: 9px 12px; border-radius: 12px; background: var(--soft); display: grid; gap: 4px; } .gt { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; } .nx { display: flex; gap: 6px; } .nx input { flex: 1; height: 32px; border: 1px solid var(--line); border-radius: 9px; padding: 0 9px; background: var(--panel); color: var(--ink); font: inherit; font-size: 13px; } .none { margin: 2px 0; display: flex; gap: 8px; align-items: center; } .sm { font-size: 12.5px; margin: 4px 0 0; } .terms { font-size: 11.5px; color: var(--mute); margin: 0; line-height: 1.5; }
.mask { position: fixed; inset: 0; z-index: 70; background: rgba(8, 12, 22, .5); display: flex; align-items: center; justify-content: center; padding: 20px; } .modal { width: min(560px, 100%); background: var(--panel); border-radius: 20px; padding: 24px; display: grid; gap: 10px; box-shadow: var(--sh-up); } .modal label { display: grid; gap: 5px; font-size: 13px; font-weight: 600; color: var(--mute); } .modal input, .modal select { height: 40px; border: 1px solid var(--line); border-radius: 10px; padding: 0 12px; background: var(--soft); color: var(--ink); font: inherit; font-weight: 400; } .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; } .mf { display: flex; justify-content: flex-end; gap: 8px; }
</style>
