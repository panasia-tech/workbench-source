<template>
  <div v-if="h" class="mask" @click.self="close">
    <aside class="drawer">
      <div class="top"><h2>{{ h.title }}</h2><button class="x" @click="close"><Icon name="close" /></button></div>
      <p class="lead">{{ h.when }}</p>
      <dl class="kv"><dt>谁来做</dt><dd>{{ h.who }}</dd><dt>成功标准</dt><dd>{{ h.success }}</dd><dt>停止 / 交谁</dt><dd>{{ h.stop }}</dd></dl>
      <div v-if="(h.terms || []).length" class="terms"><h4>这里出现的名词</h4>
        <div v-for="k in h.terms" :key="k" class="tm"><b>{{ k }}</b><span>{{ GLOSSARY[k]?.d }}</span></div></div>
      <h4>按顺序做</h4>
      <ol class="steps"><li v-for="(s, i) in h.steps" :key="i">{{ s }}</li></ol>
      <h4>这里防什么（防呆矩阵）</h4>
      <div class="guards">
        <div v-for="(g, i) in h.guards" :key="i" class="g">
          <p><span class="tag amb">前置</span>{{ g.pre }}</p><p><span class="tag red">可能点错</span>{{ g.mistake }}</p><p><span class="tag grn">系统怎么拦</span>{{ g.block }}</p>
          <p class="sm">给你的话：{{ g.tip }}</p><p class="sm">恢复：{{ g.recover }}　接手：{{ g.owner }}　证据：{{ g.evidence }}</p>
        </div>
      </div>
      <h4>教程</h4>
      <div class="vid"><button v-if="h.video" class="btn pri" @click="play(h.video)"><Icon name="play" />看这一步的小视频</button><span v-else class="tag amb">这一步的视频还没录：按上面的步骤录，录好放网盘，在这里配置链接</span><button v-if="!isSvc" class="btn" @click="play(FULL.new)">看完整版（虚拟产品体系）</button></div>
      <h4>公司制度（跳到 Wiki 看解读）</h4>
      <div class="wk"><template v-for="k in wikiKeys" :key="k"><a v-if="WIKI[k].u" :href="WIKI[k].u" target="_blank" rel="noopener" class="btn sm">{{ WIKI[k].t }} ↗</a><span v-else class="tag">{{ WIKI[k].t }}：Wiki 节点待补</span></template></div>
      <p class="muted" style="margin-top: 8px">这里只讲怎么操作；制度怎么解读以 Wiki 为准。<a @click="toManual">打开完整说明书 ›</a></p>
      <div v-if="tourPage" class="tour"><button class="btn pri" @click="startT(0)">开始本页导览</button> <button v-if="pos > 0" class="btn" @click="startT(pos)">接着看（第 {{ pos + 1 }} 步）</button><p class="muted">逐步高亮页面上真实的控件，只说明、不替你点。</p></div>
      <div class="tour"><button class="btn" @click="again">一键重新新手指导（只重置学习进度）</button><p class="muted">真实任务、库存、订单、审批都不会动。</p></div>
    </aside>
  </div>
</template>
<script setup>
import { computed } from 'vue'
import Icon from './Icon.vue'
import { ui, toast, openVideo } from './ui.js'
import { HELP, FULL } from './help.js'
import { GLOSSARY } from './glossary.js'
import { WIKI } from './wiki.js'
import { TOUR_OF_HELP, tourPos } from './tour.js'
import { post } from './api.js'
import { loadAll } from './store.js'
const h = computed(() => HELP[ui.help])
const close = () => (ui.help = null)
const isSvc = computed(() => String(ui.help || '').startsWith('svc-'))
const wikiKeys = computed(() => (h.value?.wiki?.length ? h.value.wiki : ['entry', 'rules']))
const toManual = () => { const k = ui.help; ui.help = null; location.hash = '#/manual?k=' + encodeURIComponent(k) }
const tourPage = computed(() => TOUR_OF_HELP[ui.help])
const pos = computed(() => (tourPage.value ? tourPos(tourPage.value) : 0))
function startT(i) { const page = tourPage.value; ui.help = null; ui.tour = { page, i } }
const play = (v) => { openVideo(v) }
async function again() { await post('/demo/learning/reset'); await loadAll(); toast('学习进度已重置，去「学」里从头来；真实业务没有动'); close(); location.hash = '#/learn' }
</script>
<style scoped>
.mask { position: fixed; inset: 0; background: rgba(8, 12, 22, .45); z-index: 70; display: flex; justify-content: flex-end; }
.drawer { width: min(560px, 100%); height: 100%; background: var(--panel); overflow-y: auto; padding: 26px 28px 40px; box-shadow: var(--sh-up); }
.top { display: flex; justify-content: space-between; align-items: center; } .top h2 { font-size: 24px; letter-spacing: -.01em; }
.x { width: 36px; height: 36px; border-radius: 50%; background: var(--soft); display: flex; align-items: center; justify-content: center; } .x svg { width: 18px; height: 18px; }
.lead { font-size: 16px; margin: 12px 0 16px; color: var(--ink2); }
h4 { margin: 22px 0 10px; font-size: 15px; }
.steps { margin: 0; padding-left: 22px; display: grid; gap: 8px; font-size: 15px; }
.guards { display: grid; gap: 12px; } .g { background: var(--soft); border-radius: 16px; padding: 14px 16px; } .g p { margin: 4px 0; font-size: 14px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; } .g .sm { font-size: 12.5px; color: var(--mute); }
.vid { display: flex; gap: 8px; flex-wrap: wrap; } .vid svg { width: 18px; height: 18px; }
.tour { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--line); }
.terms { margin-top: 6px; } .tm { display: grid; grid-template-columns: 96px 1fr; gap: 10px; padding: 8px 0; border-top: 1px solid var(--line); font-size: 13.5px; } .tm b { color: var(--acc); } .tm span { color: var(--ink2); line-height: 1.55; }
.wk { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
</style>
