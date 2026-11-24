<template>
  <div class="page man">
    <header class="head"><div><p class="eyebrow">说明书</p><h1>业务全流程说明书</h1>
      <p class="sub">每个节点边上的「？」讲的都在这里：名词解释、步骤、防呆、制度（跳到公司 Wiki）、视频。制度怎么解读，以 Wiki 为准。</p></div>
      <label class="search"><Icon name="search" /><input v-model="q" placeholder="搜节点或名词，例如：图库、三路采集、库龄" /></label></header>

    <nav class="toc">
      <a v-for="s in SECTIONS" :key="s.k" @click="go('sec-' + s.k)">{{ s.t }}</a>
      <a @click="goTutorials" style="background: var(--acc-soft); color: var(--acc)">打开原生教程与视频台账 ›</a>
    </nav>

    <section id="sec-flow" class="card">
      <h2>一、业务全流程总览</h2>
      <div class="lines">
        <div v-for="l in LINES" :key="l.t" class="ln"><h3>{{ l.t }}</h3><ol><li v-for="x in l.steps" :key="x.t"><a @click="go('k-' + x.k)">{{ x.t }}</a></li></ol></div>
      </div>
    </section>

    <section id="sec-nodes">
      <h2>二、每个节点的说明（边上的「？」打开的就是这里）</h2>
      <article v-for="n in nodeList" :id="'k-' + n.k" :key="n.k" class="card node" :class="{ hot: hot === n.k }">
        <h3>{{ n.h.title }}</h3>
        <p class="when">{{ n.h.when }}　<span class="muted">谁来做：{{ n.h.who }}</span></p>
        <h4>按顺序做</h4><ol class="steps"><li v-for="(s, i) in n.h.steps" :key="i">{{ s }}</li></ol>
        <dl class="kv"><dt>成功标准</dt><dd>{{ n.h.success }}</dd><dt>停止 / 交谁</dt><dd>{{ n.h.stop }}</dd></dl>
        <div v-if="n.h.terms?.length"><h4>这里出现的名词</h4><div class="chips2"><Term v-for="t in n.h.terms" :key="t" :k="t" class="ch" /></div></div>
        <h4>防呆（做错的地方系统怎么拦）</h4>
        <div class="guards"><div v-for="(g, i) in n.h.guards" :key="i" class="g"><p><span class="tag amb">前置</span>{{ g.pre }}</p><p><span class="tag red">可能点错</span>{{ g.mistake }}</p><p><span class="tag grn">系统怎么拦</span>{{ g.block }}</p><p class="sm">给你的话：{{ g.tip }}　恢复：{{ g.recover }}　接手：{{ g.owner }}　证据：{{ g.evidence }}</p></div></div>
        <h4>视频与制度</h4>
        <p><span v-if="n.h.video" class="tag grn">有视频：{{ n.h.video.title }}</span><span v-else class="tag amb">视频还没录</span>
          <template v-for="w in (n.h.wiki?.length ? n.h.wiki : ['entry', 'rules'])" :key="w"><a v-if="WIKI[w].u" :href="WIKI[w].u" target="_blank" rel="noopener" class="btn sm">{{ WIKI[w].t }} ↗</a><span v-else class="tag">{{ WIKI[w].t }}：Wiki 节点待补</span></template></p>
      </article>
      <p v-if="!nodeList.length" class="muted">没有匹配的节点。</p>
    </section>

    <section id="sec-terms" class="card">
      <h2>三、名词解释（{{ termsShown.length }} 条）</h2>
      <div v-for="g in GROUPS" :key="g"><template v-if="termsShown.some((t) => t.g === g)"><h3>{{ g }}</h3>
        <div v-for="t in termsShown.filter((x) => x.g === g)" :id="'t-' + t.k" :key="t.k" class="tm" :class="{ hot: hotT === t.k }"><b>{{ t.k }}</b><span>{{ t.d }}</span></div></template></div>
    </section>

    <section id="sec-wiki" class="card">
      <h2>四、公司制度与 Wiki 索引</h2>
      <div v-for="(w, k) in WIKI" :key="k" class="wr"><b>{{ w.t }}</b><a v-if="w.u" :href="w.u" target="_blank" rel="noopener">打开 Wiki ↗</a><span v-else class="tag">Wiki 节点待补</span><span v-if="w.note" class="muted">{{ w.note }}</span></div>
    </section>

    <section id="sec-video" class="card">
      <h2>五、通用视频章节与节点覆盖清单</h2>
      <p class="muted">全工作台 20 个核心业务节点已在原生「教程与视频台账」登记同版钉钉 Wiki 通用视频与时间码，支持一条视频按不同章节时间码覆盖多个节点。<a @click="goTutorials">查看台账覆盖、Codex Skill 与人工兜底状态 ›</a></p>
      <div v-for="n in nodeList" :key="'v' + n.k" class="wr"><b>{{ n.h.title }}</b><span class="tag" :class="n.h.video ? 'grn' : 'amb'">{{ n.h.video ? '有：' + n.h.video.title : '分步小片见通用总片章节（单步精细版待录）' }}</span></div>
    </section>
  </div>
</template>
<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import Term from './Term.vue'
import { HELP } from './help.js'
import { GLOSSARY, GROUPS } from './glossary.js'
import { WIKI } from './wiki.js'
const q = ref('')
const hot = ref(''), hotT = ref('')
const SECTIONS = [{ k: 'flow', t: '业务全流程' }, { k: 'nodes', t: '节点说明' }, { k: 'terms', t: '名词解释' }, { k: 'wiki', t: '制度与 Wiki' }, { k: 'video', t: '视频清单' }]
const LINES = [
  { t: '实物（WMS 库存）', steps: [{ t: '看库存商品（红黄绿）', k: 'gallery' }, { t: '看一件货的详情：三种图、库龄、价格', k: 'detail' }, { t: '补齐信息', k: 'flow-1' }, { t: '图库 · 系统自动配图 · 核对价格', k: 'flow-2' }, { t: '审批', k: 'flow-3' }, { t: '发布上架', k: 'flow-4' }, { t: '发货出库', k: 'flow-5' }] },
  { t: '虚拟商品（码券 / 数字权益）', steps: [{ t: '产品卡 8 步', k: 'stages' }, { t: '卡券库存与发货检查', k: 'virtstock' }, { t: '服务 Skill 台账（按服务类型分类）', k: 'skills' }] },
  { t: '技术服务（同行实操学习 → 三成品 → 对客交付）', steps: Array.from({ length: 14 }, (_, i) => ({ t: `第 ${i + 1} 步 · ${HELP['svc-' + (i + 1)].title.replace(/^第 \d+ 步 · /, '')}`, k: 'svc-' + (i + 1) })) },
  { t: '每天和平时', steps: [{ t: '「今天」怎么用', k: 'today' }, { t: '订单：四种缺口', k: 'orders' }, { t: '「学」怎么用', k: 'learn' }] }
]
const ORDER = ['gallery', 'today', 'detail', 'flow-1', 'flow-2', 'flow-3', 'flow-4', 'flow-5', 'orders', 'stages', 'virtstock', 'skills', 'service', ...Array.from({ length: 14 }, (_, i) => 'svc-' + (i + 1)), 'learn']
const nodeList = computed(() => {
  const kw = q.value.trim()
  const ks = [...new Set(ORDER.filter((k) => HELP[k]))]
  return ks.map((k) => ({ k, h: HELP[k] })).filter((n) => !kw || JSON.stringify(n.h).includes(kw))
})
const termsShown = computed(() => { const kw = q.value.trim(); return Object.entries(GLOSSARY).map(([k, v]) => ({ k, ...v })).filter((t) => !kw || t.k.includes(kw) || t.d.includes(kw)) })
const go = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
const goTutorials = () => { location.hash = '#/tutorials' }
onMounted(async () => {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '')
  await nextTick()
  if (qs.get('k')) { hot.value = qs.get('k'); setTimeout(() => go('k-' + hot.value), 80) }
  if (qs.get('t')) { hotT.value = qs.get('t'); setTimeout(() => go('t-' + hotT.value), 80) }
})
</script>
<style scoped>
.man { padding: 26px 44px 90px; max-width: 1560px; } .man h2 { font-size: 22px; margin: 26px 0 12px; } .man section.card { margin-top: 16px; }
.head { display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap; } .head > div { flex: 1; min-width: 280px; } .search { display: flex; align-items: center; gap: 8px; background: var(--soft); border-radius: 14px; padding: 0 14px; height: 44px; min-width: 300px; } .search input { flex: 1; background: none; border: 0; color: var(--ink); font-size: 15px; outline: none; } .search svg { width: 18px; height: 18px; color: var(--mute); }
.toc { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0; position: sticky; top: 0; z-index: 4; padding: 8px 0; background: linear-gradient(var(--bg) 80%, transparent); } .toc a { height: 36px; padding: 0 16px; display: inline-flex; align-items: center; border-radius: 999px; background: var(--panel); box-shadow: var(--sh); font-weight: 700; font-size: 14px; color: var(--ink2); }
.lines { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; } .ln h3 { margin: 0 0 8px; font-size: 16px; } .ln ol { margin: 0; padding-left: 20px; display: grid; gap: 5px; font-size: 14.5px; }
.node { margin-top: 14px; scroll-margin-top: 70px; } .node.hot { box-shadow: 0 0 0 3px var(--acc); } .node h3 { margin: 0; font-size: 20px; } .when { margin: 6px 0 0; color: var(--ink2); } .node h4 { margin: 16px 0 8px; font-size: 15px; }
.steps { margin: 0; padding-left: 22px; display: grid; gap: 6px; font-size: 14.5px; line-height: 1.6; } .chips2 { display: flex; gap: 12px; flex-wrap: wrap; } .ch { font-weight: 600; font-size: 14px; }
.guards { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 10px; } .g { background: var(--soft); border-radius: 14px; padding: 12px 14px; } .g p { margin: 4px 0; font-size: 13.5px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; } .g .sm { font-size: 12.5px; color: var(--mute); }
.tm { display: grid; grid-template-columns: 130px 1fr; gap: 12px; padding: 9px 0; border-top: 1px solid var(--line); font-size: 14px; scroll-margin-top: 70px; } .tm b { color: var(--acc); } .tm span { color: var(--ink2); line-height: 1.65; } .tm.hot { background: var(--acc-soft); border-radius: 10px; padding-left: 10px; }
.wr { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding: 8px 0; border-top: 1px solid var(--line); font-size: 14px; } .wr b { min-width: 260px; }
</style>
