<template>
  <div v-if="cards.length" class="cb" :class="{ 'cb--desk': isDesktop }">
    <div v-for="c in shown" :key="c.kind + c.id" class="cb-card" :class="'cb-card--' + c.tone">
      <div class="cb-card__top">
        <span class="cb-tag">{{ c.tagText }}</span>
        <span class="cb-title">{{ c.title }}</span>
      </div>
      <div v-if="c.detail" class="cb-detail">{{ c.detail }}</div>
      <div class="cb-line">{{ c.line }}</div>
      <div class="cb-ops">
        <template v-if="c.kind === 'waiting'">
          <button type="button" class="cb-btn cb-btn--pri" :disabled="locked || busy" :title="locked ? '先做完上手练习' : ''" @click="take(c)">{{ locked ? '🔒 ' : '' }}我来接</button>
        </template>
        <template v-else-if="c.kind === 'mine'">
          <button v-if="c.url" type="button" class="cb-btn" @click="go(c.url)">去看</button>
          <button type="button" class="cb-btn cb-btn--pri" :disabled="busy" @click="close(c, 'done')">做完了</button>
        </template>
        <template v-else-if="c.stage === 'open' || c.stage === 'peer' || c.stage === 'sup'">
          <button type="button" class="cb-btn" :disabled="busy" @click="close(c, 'cancel')">撤回</button>
        </template>
        <template v-else>
          <button type="button" class="cb-btn" @click="hide(c)">知道了</button>
        </template>
      </div>
    </div>
    <button v-if="cards.length > shown.length" type="button" class="cb-more" @click="all = true">还有 {{ cards.length - shown.length }} 条，点开看</button>
    <button v-else-if="all && cards.length > cap" type="button" class="cb-more" @click="all = false">收起</button>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { getApp } from '../runtime/app.js'
import { navigateTo } from '../runtime/router.js'
import { isDesktop } from '../runtime/viewport.js'
import { showToast } from '../runtime/ui.js'
import requestModule from '../overrides/services/request.js'
import { salesBadges } from './sales-badges.js'

// 协同请求（销售工作台交付包「今天」里的倒计时卡片）：每一页都浮在角上，谁先点「我来接」就是谁的。
// 60 秒没人接转所有在岗销售、再 60 秒转主管，阶段由后端按提出时间算；这里每 10 秒拉一次、每秒倒数。
// 页面没开的人靠钉钉 / 企微：提的时候叫负责人，转到主管时叫主管（后端发）
const { request } = requestModule
const ROLES = ['SALES', 'ADMIN']
const POLL_MS = 10000

const user = ref(null)
const readUser = () => { user.value = (getApp().globalData || {}).user || null }
const live = ref({ waiting: [], mine: [], sent: [] })
const tick = ref(0)
const busy = ref(false)
const hidden = ref(new Set())
const locked = computed(() => !!(salesBadges.value && salesBadges.value.practice))

// 手机上只露一张（别把页面盖住），电脑上最多三张；点「还有 N 条」全展开
const all = ref(false)
const cap = computed(() => (isDesktop.value ? 3 : 1))
const shown = computed(() => (all.value ? cards.value : cards.value.slice(0, cap.value)))

const NEXT = { open: '转给所有在岗同事', peer: '转主管' }
const cards = computed(() => {
  tick.value // 每秒重算倒计时
  const d = live.value
  const left = (c) => Math.max(0, c.left - Math.floor((Date.now() - d._at) / 1000))
  const out = []
  for (const c of d.waiting) {
    const s = left(c)
    const stage = s === 0 && c.stage !== 'sup' ? (c.stage === 'open' ? 'peer' : 'sup') : c.stage
    out.push({
      ...c, kind: 'waiting', tone: stage === 'open' ? 'amb' : 'red', tagText: '协同请求',
      line: stage === 'sup' ? `来自 ${c.from} · ${c.at} 提的，同事都没接，已转主管` : `来自 ${c.from} · ${s} 秒内没人接，${NEXT[stage]}`,
    })
  }
  for (const c of d.mine) out.push({ ...c, kind: 'mine', tone: 'acc', tagText: '你接了', line: `来自 ${c.from} · 做完点「做完了」` })
  for (const c of d.sent) {
    if (hidden.value.has(c.id)) continue
    const line = c.stage === 'taken' ? `${c.taken_by} 接了`
      : c.stage === 'replied' ? `${c.taken_by || '有人'}已经在会话里回了买家，自动关了`
      : c.stage === 'expired' ? '12 小时没人接，已关掉；还要帮忙就重新提'
      : c.stage === 'sup' ? '同事都没接，已转主管' : c.stage === 'peer' ? '已转给所有在岗同事，等人接' : `等${c.to || '同事'}接`
    out.push({ ...c, kind: 'sent', tone: 'soft', tagText: '你提的', line })
  }
  return out
})

async function poll() {
  if (!user.value || !ROLES.includes(user.value.role) || document.hidden) return
  try {
    const r = await request({ url: '/api/sales-workbench/collab', _noAuthRedirect: true })
    live.value = { ...r, _at: Date.now() }
  } catch { /* 下次再拉 */ }
}

function go(url) {
  if (url) navigateTo(url)
}

async function take(c) {
  busy.value = true
  try {
    await request({ url: `/api/sales-workbench/collab/${c.id}/take`, method: 'POST' })
    showToast({ title: '接了，这条是你的', icon: 'none' })
    go(c.url)
  } catch (e) {
    showToast({ title: (e && e.detail) || '没接上', icon: 'none' })
  }
  busy.value = false
  poll()
}

async function close(c, action) {
  busy.value = true
  try {
    await request({ url: `/api/sales-workbench/collab/${c.id}/${action}`, method: 'POST' })
  } catch (e) {
    showToast({ title: (e && e.detail) || '没成功', icon: 'none' })
  }
  busy.value = false
  poll()
}

function hide(c) {
  hidden.value = new Set([...hidden.value, c.id])
}

let pollTimer = 0
let tickTimer = 0
const onSession = () => { readUser(); live.value = { waiting: [], mine: [], sent: [] }; poll() }
const onVisible = () => { if (!document.hidden) poll() }
onMounted(() => {
  readUser()
  poll()
  pollTimer = setInterval(poll, POLL_MS)
  tickTimer = setInterval(() => { tick.value++ }, 1000)
  window.addEventListener('mp:session', onSession)
  window.addEventListener('mp:collab', poll)
  document.addEventListener('visibilitychange', onVisible)
})
onBeforeUnmount(() => {
  clearInterval(pollTimer)
  clearInterval(tickTimer)
  window.removeEventListener('mp:session', onSession)
  window.removeEventListener('mp:collab', poll)
  document.removeEventListener('visibilitychange', onVisible)
})
</script>

<style scoped>
.cb { position: fixed; left: 12px; right: 12px; bottom: calc(64px + env(safe-area-inset-bottom)); z-index: 60; display: flex; flex-direction: column; gap: 8px; }
.cb--desk { left: auto; right: 20px; bottom: 20px; width: 380px; }
.cb-card { box-sizing: border-box; padding: 12px 14px; border-radius: 14px; background: #fff; border: 2px solid #e5e7eb; box-shadow: 0 8px 24px rgba(15, 23, 42, .14); font-size: 13px; color: #111827; }
.cb-card--amb { background: #fffbeb; border-color: #f6cf72; }
.cb-card--red { background: #fef2f2; border-color: #ef4444; }
.cb-card--acc { background: #eff6ff; border-color: #93c5fd; }
.cb-card--soft { border-width: 1px; }
.cb-card__top { display: flex; align-items: center; gap: 8px; }
.cb-tag { flex: none; padding: 1px 8px; border-radius: 999px; background: #111827; color: #fff; font-size: 11px; font-weight: 700; }
.cb-card--amb .cb-tag { background: #d97706; }
.cb-card--red .cb-tag { background: #dc2626; }
.cb-card--acc .cb-tag { background: #2563eb; }
.cb-card--soft .cb-tag { background: #6b7280; }
.cb-title { font-weight: 700; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cb-detail { margin-top: 4px; color: #374151; }
.cb-line { margin-top: 4px; color: #6b7280; }
.cb-card--red .cb-line { color: #b91c1c; font-weight: 600; }
.cb-ops { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
.cb-btn { height: 28px; padding: 0 12px; border-radius: 8px; border: 1px solid #d1d5db; background: #fff; color: #374151; font-size: 12px; cursor: pointer; }
.cb-btn--pri { border-color: #2563eb; background: #2563eb; color: #fff; }
.cb-btn:disabled { opacity: .5; cursor: not-allowed; }
.cb-more { align-self: flex-end; padding: 4px 10px; border: 0; border-radius: 999px; background: rgba(17, 24, 39, .75); color: #fff; font-size: 12px; cursor: pointer; }
</style>
