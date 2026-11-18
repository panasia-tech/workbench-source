<template>
  <div class="page">
    <header class="head">
      <div><p class="eyebrow">{{ me.dept }} · {{ me.post }}</p><h1>学</h1><p class="sub">{{ me.practice_done ? '练习都做完了，真实任务已开放。随时可以回来重看。' : '第一次来：先做完 3 个练习，真实任务才会打开。全是假数据，不会发到平台。' }}</p></div>
      <div class="acts"><button class="btn" @click="openHelp('learn')"><Icon name="help" />怎么用</button></div>
    </header>

    <section class="prac">
      <div v-for="p in PR" :key="p.k" class="pc card">
        <div class="ph"><span class="tag acc">{{ p.tag }}</span><span v-if="(me.practice?.[p.k] || 0) >= 3" class="tag grn">做完了</span><span v-else class="tag" :class="me.practice?.[p.k] ? 'amb' : 'red'">{{ me.practice?.[p.k] ? '做了 ' + me.practice[p.k] + '/3' : '还没做' }}</span></div>
        <h3>{{ p.title }}<Q k="learn-practice" /></h3><p class="muted">{{ p.desc }}</p>
        <div class="bar" style="margin: 12px 0"><i :style="{ width: ((me.practice?.[p.k] || 0) / 3) * 100 + '%', background: 'var(--grn)' }"></i></div>
        <button class="btn pri" @click="ui.practice = p.k">{{ (me.practice?.[p.k] || 0) >= 3 ? '再练一遍' : me.practice?.[p.k] ? '接着做' : '开始练习' }}</button>
      </div>
    </section>

    <section v-for="s in SERIES" :key="s.k" class="series">
      <h2>{{ s.t }}<Q k="learn-video" /><span class="tag amb">{{ s.note }}</span></h2>
      <p class="muted">每一步一小段，加一个完整版。看完一段会记进进度。</p>
      <div class="clips">
        <button v-for="(v, i) in s.clips" :key="i" class="clip" :class="{ seen: seen(s.k, i) }" @click="play(v, s.k + '-' + i)"><Icon name="play" /><span><b>{{ i + 1 }}. {{ v.title.split('· ')[1].replace(/^\d\. /, '') }}</b><em>{{ seen(s.k, i) ? '看过' : '没看过' }}</em></span></button>
        <button class="clip full" @click="play(s.full, s.k + '-all')"><Icon name="play" /><span><b>完整版</b><em>{{ s.full.title }}</em></span></button>
      </div>
    </section>

    <section class="card wiki"><h3>钉钉 Wiki / 公司网盘</h3><p class="muted">每个功能页右上角的「怎么用」会带你到对应的说明和视频。<b>Wiki 说明节点：待补</b>（还没有已发布的持久链接，不编造）。视频现在是本机外接盘里的文件；业务传到网盘后，在这里配置链接即可。</p>
      <button class="btn" @click="again">一键从头再学（只重置学习进度）</button><p class="muted" style="margin-top: 6px">真实任务、库存、订单、审批、提成都不会动。</p></section>
  </div>
</template>
<script setup>
import Q from './Q.vue'
import { computed } from 'vue'
import Icon from './Icon.vue'
import { state, loadAll } from './store.js'
import { ui, openHelp, openVideo, toast } from './ui.js'
import { VIDEOS, FULL } from './help.js'
import { post } from './api.js'

const me = computed(() => state.me || { practice: {}, watched: [], practice_done: true, dept: '', post: '' })
const PR = [
  { k: 'phys', tag: '实物', title: '二手 iPhone：上架 → 发货出库', desc: '核对价和图，发布上架（60 秒内可撤回），扫码核对后出库。' },
  { k: 'virt', tag: '虚拟', title: '星巴克券：发货检查 → 发卡密', desc: '发货检查拦住一单，提醒买家确认，再发卡密。' },
  { k: 'svc', tag: '服务', title: '安卓刷机：接单 → 约时间 → 交付 → 确认', desc: '服务订单按顺序走，每一步都有防呆。' }
]
const SERIES = [
  { k: '21', t: '实物销售业务员', note: '11-09 旧口径版，待重录', clips: VIDEOS.phys, full: FULL.phys },
  { k: '31', t: '虚拟产品业务员', note: '11-09 旧口径版，待重录', clips: VIDEOS.virt, full: FULL.virt },
  { k: '61', t: '销售业务员 · 虚拟产品体系', note: '11-10 新版', clips: [], full: FULL.new }
]
const seen = (k, i) => (me.value.watched || []).includes(k + '-' + i) || (me.value.watched || []).includes(String(Number(k) / 10 - 2) + '-' + i)
const play = (v, key) => openVideo({ ...v, key })
async function again() { await post('/demo/learning/reset'); await loadAll(true); toast('学习进度已重置；真实业务没有动') }
</script>
<style scoped>
.page { padding: 34px 44px 80px; max-width: 1400px; } .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; flex-wrap: wrap; } .acts svg { width: 18px; height: 18px; }
.eyebrow { color: var(--acc); font-weight: 700; font-size: 14px; } h1 { font-size: 38px; font-weight: 800; letter-spacing: -.02em; } .sub { color: var(--mute); margin-top: 8px; max-width: 720px; }
.prac { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; margin: 28px 0; } @media (max-width: 1100px) { .prac { grid-template-columns: 1fr; } }
.ph { display: flex; justify-content: space-between; } .pc h3 { font-size: 19px; margin: 12px 0 6px; line-height: 1.35; }
.series { margin-top: 34px; } .series h2 { display: flex; gap: 12px; align-items: center; font-size: 22px; } .clips { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; margin-top: 14px; }
.clip { display: flex; align-items: center; gap: 12px; text-align: left; padding: 14px 16px; background: var(--panel); border-radius: 18px; box-shadow: var(--sh); transition: transform .12s; } .clip:hover { transform: translateY(-2px); } .clip svg { width: 28px; height: 28px; color: var(--acc); flex: none; }
.clip span { display: flex; flex-direction: column; } .clip b { font-size: 14.5px; } .clip em { font-style: normal; font-size: 12.5px; color: var(--mute); } .clip.seen { background: var(--grn-soft); } .clip.seen svg { color: var(--grn); } .clip.full { background: var(--acc-soft); }
.wiki { margin-top: 34px; }
</style>
