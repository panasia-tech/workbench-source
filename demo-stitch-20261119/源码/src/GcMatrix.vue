<template>
  <div class="gc-page">
    <!-- 群控 4 大独立专页顶部切换导航 -->
    <nav class="gc-nav card">
      <div class="gn-tabs">
        <button class="gn-tab on"><i>1</i><span>群控环境与账号矩阵</span></button>
        <button class="gn-tab" @click="go('gc-queue')"><i>2</i><span>上下架与联动队列</span><em v-if="badges['gc-queue']" class="nb">{{ badges['gc-queue'] }}</em></button>
        <button class="gn-tab" @click="go('gc-reprice')"><i>3</i><span>在售智能调价复核</span><em v-if="badges['gc-reprice']" class="nb amb">{{ badges['gc-reprice'] }}</em></button>
        <button class="gn-tab" @click="go('gc-metrics')"><i>4</i><span>15:30 小铺数据看板</span><em v-if="badges['gc-metrics']" class="nb">{{ badges['gc-metrics'] }}</em></button>
      </div>
      <div class="gn-acts">
        <button class="btn sm" @click="load">↻ 刷新对账</button>
        <button class="btn sm pri" :disabled="busy" @click="polishAll">✨ 一键全矩阵曝光擦亮 &amp; 活跃留痕</button>
      </div>
    </nav>

    <header class="card hero-bar">
      <div>
        <p class="eyebrow">ADSPOWER BROWSER MATRIX · 全浏览器执行端（已全面弃用安卓手机真机）</p>
        <h1>AdsPower 环境 × 闲鱼店铺矩阵对账台</h1>
        <p class="sub">{{ data.architecture_note || 'Local API (127.0.0.1:50325) + Playwright CDP 接管 + 一窗一号一独享家宽 IP + 免明文密码/动态码托管' }}</p>
      </div>
      <div class="totp-pop" v-if="totpBox">
        <span class="tp-lbl">🔑 {{ totpBox.shop_nick }} (#{{ totpBox.env_id }}) 实时动态码</span>
        <div class="tp-code">
          <b>{{ totpBox.code }}</b>
          <button class="btn sm pri" @click="copyCode(totpBox.code)">复制</button>
          <button class="btn sm" @click="totpBox = null">关闭</button>
        </div>
        <small>剩余 {{ totpBox.valid_seconds }} 秒有效 · {{ totpBox.note }}</small>
      </div>
    </header>

    <!-- 宿主机状态条 + 汇总指标 -->
    <section class="host-kpi-row">
      <div v-for="ws in data.workstations" :key="ws.host" class="card ws-card">
        <div class="ws-top">
          <b>🖥 {{ ws.host }}</b>
          <span class="tag grn">{{ ws.running }}/{{ ws.envs }} 窗运行中</span>
        </div>
        <p><span>Local API：</span>{{ ws.local_api }}</p>
        <p><span>看门狗：</span>{{ ws.watchdog }}</p>
      </div>
      <div class="card kpi-strip">
        <div><span>纳管环境</span><b>{{ data.summary?.total_envs || 0 }}</b><small>一窗一号隔离</small></div>
        <div><span>CDP 在线</span><b class="grn">{{ data.summary?.online_cdp || 0 }}</b><small>Playwright 接管</small></div>
        <div><span>消息门铃</span><b class="acc">{{ data.summary?.doorbell_on || 0 }}</b><small>im_watch 秒级监听</small></div>
        <div><span>红灯阻断</span><b :class="data.summary?.red_count ? 'red' : ''">{{ data.summary?.red_count || 0 }}</b><small>串号 / 掉线</small></div>
        <div><span>排期均衡提醒</span><b :class="data.summary?.divert_count ? 'amb' : ''">{{ data.summary?.divert_count || 0 }}</b><small>引导派空闲店</small></div>
        <div><span>矩阵总在架</span><b>{{ data.summary?.total_listed || 0 }}</b><small>单号上限 300 件</small></div>
      </div>
    </section>

    <!-- 筛选栏 -->
    <div class="flt-bar">
      <div class="seg">
        <button :class="{ on: flt === 'all' }" @click="flt = 'all'">全部环境 ({{ items.length }})</button>
        <button :class="{ on: flt === 'red' }" @click="flt = 'red'"><i class="dot red"></i>红灯拦截 ({{ items.filter((x) => x.lvl === 'red').length }})</button>
        <button :class="{ on: flt === 'amb' }" @click="flt = 'amb'"><i class="dot amb"></i>待关注/排期密 ({{ items.filter((x) => x.lvl === 'amb').length }})</button>
        <button :class="{ on: flt === 'sales' }" @click="flt = 'sales'">销售店群</button>
        <button :class="{ on: flt === 'purchase' }" @click="flt = 'purchase'">采购谈价专窗</button>
      </div>
      <span class="muted sm">默认按「红（串号/掉线/暂停派新）→ 黄（滑块冷却/排期较密/超30分钟未活跃）→ 绿（正常接单）」排序</span>
    </div>

    <!-- 环境矩阵卡片网格 -->
    <div class="env-grid">
      <article v-for="e in shown" :key="e.env_id" class="card env-card" :class="e.lvl">
        <div class="ec-head">
          <div>
            <div class="ec-badges">
              <span class="env-id">{{ e.serial }} · #{{ e.env_id }}</span>
              <span class="tag" :class="e.group_name === 'gc-purchase' ? 'acc' : ''">{{ e.purpose }}</span>
              <span class="tag" :class="cdpBadge(e).cls">{{ cdpBadge(e).text }}</span>
              <span v-if="e.im_doorbell === 'listening'" class="tag grn">🔔 门铃监听中</span>
            </div>
            <h3>{{ e.shop_nick }} <small>负责人：{{ e.owner }}</small></h3>
            <p class="muted sm">{{ e.entity }}</p>
          </div>
          <button v-if="e.group_name !== 'gc-purchase'" class="btn sm" @click="drawerEnv = e">
            📦 单号主页 ({{ e.listings.length }}) ›
          </button>
        </div>

        <!-- 防发错号对账行 + 独享家宽 IP -->
        <div class="ec-kv">
          <div>
            <span>网页实登昵称（identity 帧）：</span>
            <b :class="{ bad: !e.nick_match || e.cdp_state === 'expired' }">{{ e.reported_nick || '未读取（Cookie过期）' }}</b>
            <em v-if="e.cdp_state === 'expired'" class="bad-mark">⏳ Cookie过期 · 待重登</em>
            <em v-else-if="e.nick_match" class="ok-mark">✓ 对账一致</em>
            <em v-else class="bad-mark">✕ 不一致 · 软闸锁死</em>
          </div>
          <div><span>宿主机 / 家宽代理：</span><code>{{ e.host }} · {{ e.proxy }}</code></div>
        </div>

        <!-- 红黄问题提示箱 -->
        <div v-if="e.issues.length" class="ec-issues">
          <div v-for="(iss, idx) in e.issues" :key="idx" class="iss-line" :class="iss.lvl">
            <span>{{ iss.lvl === 'red' ? '✕' : '⚠' }} {{ iss.text }}</span>
          </div>
        </div>
        <div v-else class="ec-ok">✓ 登录态、昵称对账、发品配额、活跃心跳全部正常</div>

        <!-- 销售号三维配额水位条 -->
        <div v-if="e.group_name !== 'gc-purchase'" class="quota-grid">
          <div class="q-box">
            <div class="qh"><span>在架容量</span><b>{{ e.listed_count }} / {{ e.listed_limit }}</b></div>
            <div class="qbar"><i :style="{ width: Math.min(100, (e.listed_count / e.listed_limit) * 100) + '%', background: e.listed_count >= 270 ? 'var(--amb)' : 'var(--acc)' }"></i></div>
          </div>
          <div class="q-box">
            <div class="qh"><span>今日已发（25m错峰）</span><b>{{ e.today_published }} / {{ e.daily_limit }} 票</b></div>
            <div class="qbar"><i :style="{ width: Math.min(100, (e.today_published / e.daily_limit) * 100) + '%', background: e.today_published >= 10 ? 'var(--amb)' : 'var(--grn)' }"></i></div>
            <small class="muted">下一窗口：{{ e.next_slot_at }}</small>
          </div>
          <div class="q-box">
            <div class="qh"><span>派单排期状态</span><b :class="{ amb: e.dispatch_state === 'prefer_idle', red: e.dispatch_state === 'schedule_full', grn: !e.dispatch_state || e.dispatch_state === 'available' }">{{ e.dispatch_badge || '正常接单' }}</b></div>
            <div class="qbar"><i :style="{ width: e.dispatch_state === 'schedule_full' ? '100%' : e.dispatch_state === 'prefer_idle' ? '78%' : '42%', background: e.dispatch_state === 'schedule_full' ? 'var(--red)' : e.dispatch_state === 'prefer_idle' ? 'var(--amb)' : 'var(--grn)' }"></i></div>
            <small class="muted">距上次活跃 {{ e.last_active_min }} 分钟 · {{ e.polished_today ? '今日已擦亮' : '今日待擦亮' }}</small>
          </div>
        </div>

        <!-- 底部操作栏 -->
        <div class="ec-actions">
          <button class="btn sm pri" :disabled="busy" @click="openBrowser(e)">
            🖥 唤起 AdsPower 专窗{{ e.cdp_state === 'expired' ? '并恢复登录' : '（免密填充）' }}
          </button>
          <button class="btn sm" :disabled="busy" @click="fetchTotp(e)">🔑 领 6 位动态码</button>
          <button v-if="!e.nick_match && e.cdp_state !== 'expired'" class="btn sm red-btn" :disabled="busy" @click="fixNick(e)">
            ⚡ 校对恢复正确昵称（解除软闸）
          </button>
          <button v-if="e.group_name !== 'gc-purchase' && (!e.polished_today || e.last_active_min > 30)" class="btn sm" :disabled="busy" @click="polishOne(e)">
            ✨ 活跃擦亮
          </button>
        </div>
      </article>
    </div>

    <!-- 禅道 #101：单号在售商品主页右侧抽屉 -->
    <div v-if="drawerEnv" class="mask" @click.self="drawerEnv = null">
      <aside class="drawer">
        <div class="dh">
          <div>
            <p class="eyebrow">账号主页全量商品明细（闭环禅道 #101） · AdsPower #{{ drawerEnv.env_id }}</p>
            <h2>{{ drawerEnv.shop_nick }} · 共纳管 {{ drawerEnv.listed_count }} 件（演示展示代表条目）</h2>
            <p class="muted sm">{{ drawerEnv.entity }} ｜ 改价策略：{{ drawerEnv.reprice_channel }}</p>
          </div>
          <button class="btn sm" @click="drawerEnv = null">关闭</button>
        </div>

        <div class="dl-list">
          <div v-for="ls in drawerEnv.listings" :key="ls.item_id" class="dl-row">
            <img :src="ls.img" alt="" />
            <div class="dl-info">
              <div class="dl-tags">
                <span class="tag" :class="ls.status === 'LIVE' ? 'grn' : 'amb'">{{ ls.status === 'LIVE' ? '在卖 LIVE' : '已下架仓库' }}</span>
                <span class="tag">item_id: {{ ls.item_id }}</span>
                <span v-if="ls.wuyoumai" class="tag acc">无忧卖（网页版禁直接下架）</span>
                <span v-if="ls.aged_days >= 15" class="tag amb">已挂 {{ ls.aged_days }} 天 · 可重发激活</span>
              </div>
              <h4>{{ ls.title }}</h4>
              <p class="muted sm">SKU: {{ ls.sku_code }} · 挂牌价 <b>¥{{ ls.price }}</b>（成本 ¥{{ ls.cost }}） · 浏览 {{ ls.views }} · 想要 {{ ls.wants }}</p>
            </div>
            <div class="dl-acts">
              <button class="btn sm" @click="jumpItem(ls)">站内详情 ›</button>
            </div>
          </div>
          <p v-if="!drawerEnv.listings.length" class="muted">该账号暂无销售在架商品。</p>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api, post } from './api.js'
import { toast } from './ui.js'

const data = reactive({ architecture_note: '', workstations: [], summary: {}, items: [] })
const badges = reactive({})
const flt = ref('all')
const busy = ref(false)
const totpBox = ref(null)
const drawerEnv = ref(null)

const RANK = { red: 0, amb: 1, grn: 2 }
const items = computed(() => [...(data.items || [])].sort((a, b) => RANK[a.lvl] - RANK[b.lvl]))
const shown = computed(() =>
  items.value.filter((x) => {
    if (flt.value === 'red') return x.lvl === 'red'
    if (flt.value === 'amb') return x.lvl === 'amb'
    if (flt.value === 'sales') return x.group_name !== 'gc-purchase'
    if (flt.value === 'purchase') return x.group_name === 'gc-purchase'
    return true
  })
)

const cdpBadge = (e) => {
  if (e.cdp_state === 'running') return { text: 'CDP 运行中', cls: 'grn' }
  if (e.cdp_state === 'cooldown') return { text: `滑块冷却 ${e.cooldown_left_min || 14}m`, cls: 'amb' }
  if (e.cdp_state === 'expired') return { text: 'Cookie 过期掉线', cls: 'red' }
  return { text: '未启动', cls: '' }
}

const go = (k) => { location.hash = '#/' + k }

async function load() {
  try {
    const [m, b] = await Promise.all([api('/gc-hub/matrix'), api('/gc-hub/badges')])
    Object.assign(data, m)
    Object.assign(badges, b)
    if (drawerEnv.value) {
      drawerEnv.value = m.items.find((x) => x.env_id === drawerEnv.value.env_id) || null
    }
  } catch (e) {
    toast('读取群控矩阵失败：' + e.message)
  }
}

async function openBrowser(e) {
  busy.value = true
  try {
    const r = await post(`/gc-hub/matrix/${e.env_id}/open-browser`, {})
    toast(r.msg)
    await load()
  } catch (err) {
    toast(err.message)
  } finally {
    busy.value = false
  }
}

async function fetchTotp(e) {
  try {
    totpBox.value = await post(`/gc-hub/matrix/${e.env_id}/totp`, {})
  } catch (err) {
    toast(err.message)
  }
}

function copyCode(code) {
  navigator.clipboard?.writeText(code).catch(() => {})
  toast('已复制 6 位动态验证码：' + code)
}

async function fixNick(e) {
  busy.value = true
  try {
    const r = await post(`/gc-hub/matrix/${e.env_id}/fix-nick`, {})
    toast(r.msg)
    await load()
  } catch (err) {
    toast(err.message)
  } finally {
    busy.value = false
  }
}

async function polishAll() {
  busy.value = true
  try {
    const r = await post('/gc-hub/matrix/polish-active', {})
    toast(r.msg)
    await load()
  } catch (err) {
    toast(err.message)
  } finally {
    busy.value = false
  }
}

async function polishOne(e) {
  busy.value = true
  try {
    const r = await post('/gc-hub/matrix/polish-active', { env_ids: [e.env_id] })
    toast(r.msg)
    await load()
  } catch (err) {
    toast(err.message)
  } finally {
    busy.value = false
  }
}

function jumpItem(ls) {
  drawerEnv.value = null
  if (String(ls.sku_code).startsWith('VC-')) {
    location.hash = '#/item/virt/v-mcd'
  } else {
    location.hash = `#/item/phys/${encodeURIComponent(ls.sku_code.replace(/-B$/, ''))}`
  }
}

onMounted(load)
</script>

<style scoped>
.gc-page { padding: 24px 36px 80px; max-width: 1720px; display: grid; gap: 18px; }
.gc-nav { display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 12px 18px; flex-wrap: wrap; }
.gn-tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.gn-tab { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 999px; background: var(--soft); color: var(--ink2); font-weight: 700; font-size: 14px; }
.gn-tab i { width: 22px; height: 22px; border-radius: 50%; background: var(--panel); display: inline-flex; align-items: center; justify-content: center; font-style: normal; font-size: 12px; font-weight: 800; }
.gn-tab.on { background: var(--acc); color: #fff; box-shadow: 0 4px 14px rgba(37,99,235,.25); }
.gn-tab.on i { background: rgba(255,255,255,.22); color: #fff; }
.gn-acts { display: flex; gap: 8px; flex-wrap: wrap; }
.nb { font-style: normal; padding: 1px 7px; border-radius: 999px; background: var(--red); color: #fff; font-size: 11.5px; font-weight: 800; }
.nb.amb { background: var(--amb); color: #2c1d00; }

.hero-bar { padding: 22px 26px; display: flex; justify-content: space-between; align-items: center; gap: 20px; flex-wrap: wrap; }
.eyebrow { margin: 0; font-size: 12px; font-weight: 800; letter-spacing: .05em; color: var(--acc); }
.hero-bar h1 { margin: 4px 0 6px; font-size: 28px; }
.hero-bar .sub { margin: 0; color: var(--mute); font-size: 13.5px; max-width: 900px; }

.totp-pop { padding: 12px 18px; border-radius: 16px; background: #0f172a; color: #fff; display: grid; gap: 4px; min-width: 280px; }
.tp-lbl { font-size: 12px; color: #93c5fd; font-weight: 700; }
.tp-code { display: flex; align-items: center; gap: 12px; }
.tp-code b { font-size: 30px; letter-spacing: .14em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #34d399; }
.totp-pop small { font-size: 11.5px; color: #94a3b8; }

.host-kpi-row { display: grid; grid-template-columns: 310px 310px 1fr; gap: 14px; }
@media (max-width: 1260px) { .host-kpi-row { grid-template-columns: 1fr; } }
.ws-card { padding: 16px 18px; display: grid; gap: 6px; font-size: 13px; }
.ws-top { display: flex; justify-content: space-between; align-items: center; }
.ws-card p { margin: 0; color: var(--ink2); }
.ws-card p span { color: var(--mute); }
.kpi-strip { padding: 16px 22px; display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; align-items: center; }
@media (max-width: 900px) { .kpi-strip { grid-template-columns: repeat(3, 1fr); } }
.kpi-strip span { display: block; font-size: 12px; color: var(--mute); }
.kpi-strip b { font-size: 26px; font-weight: 800; letter-spacing: -.02em; }
.kpi-strip b.grn { color: var(--grn); }
.kpi-strip b.red { color: var(--red); }
.kpi-strip b.amb { color: var(--amb-ink); }
.kpi-strip b.acc { color: var(--acc); }
.kpi-strip small { display: block; font-size: 11.5px; color: var(--mute); }

.flt-bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.seg { display: inline-flex; gap: 4px; padding: 4px; background: var(--panel); border-radius: 14px; box-shadow: var(--sh); flex-wrap: wrap; }
.seg button { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: 10px; font-weight: 700; font-size: 13.5px; color: var(--ink2); }
.seg button.on { background: var(--ink); color: var(--bg); }

.env-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(500px, 1fr)); gap: 18px; }
@media (max-width: 600px) { .env-grid { grid-template-columns: 1fr; } }
.env-card { padding: 20px 22px; display: grid; gap: 13px; }
.env-card.red { box-shadow: 0 0 0 2.5px var(--red), var(--sh); }
.env-card.amb { box-shadow: 0 0 0 2px #f6cf72, var(--sh); }
.ec-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.ec-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; align-items: center; }
.env-id { padding: 2px 9px; border-radius: 8px; background: #0f172a; color: #fff; font-family: ui-monospace, monospace; font-size: 12px; font-weight: 700; }
.ec-head h3 { margin: 0 0 3px; font-size: 20px; }
.ec-head h3 small { font-size: 13px; color: var(--mute); font-weight: 500; margin-left: 8px; }
.ec-kv { padding: 10px 13px; border-radius: 12px; background: var(--soft); font-size: 13px; display: grid; gap: 5px; }
.ec-kv span { color: var(--mute); }
.ec-kv b.bad { color: var(--red-ink); }
.ok-mark { font-style: normal; margin-left: 8px; color: var(--grn-ink); font-weight: 700; font-size: 12px; }
.bad-mark { font-style: normal; margin-left: 8px; color: var(--red-ink); font-weight: 800; font-size: 12px; }
.ec-kv code { font-size: 12px; color: var(--ink2); }

.ec-issues { display: grid; gap: 6px; }
.iss-line { padding: 8px 12px; border-radius: 10px; font-size: 13px; font-weight: 600; }
.iss-line.red { background: var(--red-soft); color: var(--red-ink); }
.iss-line.amb { background: var(--amb-soft); color: var(--amb-ink); }
.ec-ok { padding: 8px 12px; border-radius: 10px; background: var(--grn-soft); color: var(--grn-ink); font-size: 13px; font-weight: 600; }

.quota-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
@media (max-width: 640px) { .quota-grid { grid-template-columns: 1fr; } }
.q-box { padding: 10px 12px; border-radius: 12px; background: var(--soft); display: grid; gap: 5px; }
.qh { display: flex; justify-content: space-between; font-size: 12px; }
.qh span { color: var(--mute); }
.qh b.amb { color: var(--amb-ink); }
.qh b.red { color: var(--red-ink); }
.qbar { height: 7px; border-radius: 999px; background: var(--line); overflow: hidden; }
.qbar i { display: block; height: 100%; border-radius: 999px; }

.ec-actions { display: flex; gap: 8px; flex-wrap: wrap; padding-top: 2px; }
.red-btn { background: var(--red) !important; color: #fff !important; }

.mask { position: fixed; inset: 0; z-index: 80; background: rgba(8,12,22,.52); display: flex; justify-content: flex-end; }
.drawer { width: min(680px, 100%); height: 100%; overflow-y: auto; background: var(--panel); padding: 26px 28px 60px; box-shadow: var(--sh-up); display: grid; align-content: start; gap: 18px; }
.dh { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.dh h2 { margin: 4px 0 6px; font-size: 22px; }
.dl-list { display: grid; gap: 12px; }
.dl-row { display: flex; gap: 14px; align-items: center; padding: 12px 14px; border-radius: 14px; background: var(--soft); }
.dl-row img { width: 76px; height: 76px; border-radius: 10px; object-fit: cover; flex-shrink: 0; }
.dl-info { flex: 1; min-width: 0; }
.dl-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
.dl-info h4 { margin: 0 0 4px; font-size: 15px; }
</style>
