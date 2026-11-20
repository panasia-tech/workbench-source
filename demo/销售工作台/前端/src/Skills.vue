<template>
  <div class="page sk">
    <header class="head">
      <div><p class="eyebrow">虚拟产品 · 服务</p><h1>服务 Skill 台账<Q k="skills" /></h1>
        <p class="sub">每一项服务能力（Skill）一行，按服务类型分类，像餐饮卡券那样一层层分。复现通过、三个成品齐了才算「已入库」。</p></div>
      <div class="sum"><button class="btn pri" @click="mk = true">+ 新建立项</button><span class="tag grn">已入库 {{ n('listed') }}</span><span class="tag amb">学习中 {{ n('learning') }}</span><span class="tag">赛马中 {{ n('racing') }}</span></div>
    </header>

    <div v-if="mk" class="mask" @click.self="mk = false"><div class="modal"><h3>服务立项</h3>
      <p class="muted">从「学习到交付」第 1 步开始。服务名称要写<b>具体的服务结果</b>，不要写「维修」。（只有远程操作类走学习流程；AI 工作流类走赛马。）</p>
      <label>服务类型<select v-model="nf.leaf"><option value="">选一个</option><option v-for="lf in remoteLeaves" :key="lf.id" :value="lf.id">{{ lf.name }}</option></select></label>
      <label>服务名称<input v-model="nf.name" placeholder="例如：处理《三角洲行动》启动时的虚拟化报警" /></label>
      <p v-if="nerr" class="errbox">{{ nerr }}</p>
      <div class="mf"><button class="btn" @click="mk = false">取消</button><button class="btn pri" @click="create">立项，去第 1 步</button></div></div></div>

    <div v-if="det" class="mask" @click.self="det = null"><div class="modal wide2"><div class="mh"><h3>{{ det.name }}</h3><button class="btn sm" @click="det = null">关闭</button></div>
      <p class="path">{{ det.path.join(' › ') }} · <code>{{ det.id }}</code> · {{ det.status_label }}</p>
      <dl class="kv"><dt>要学 / 要做的</dt><dd>{{ det.case || '—' }}</dd><dt>执行环境</dt><dd>{{ det.runner }}<template v-if="det.remote !== '—'"> · 远控 {{ det.remote }}</template></dd><dt>执行方式</dt><dd>{{ det.exec }}（<Term k="RPA固化">RPA 固化</Term>、<Term k="ComputerUse">Computer Use</Term> 是什么）</dd><dt>依赖的工具</dt><dd>{{ det.deps.join('；') || '—' }}</dd><dt>风险</dt><dd>{{ det.risk }}</dd><dt>负责人</dt><dd>{{ det.owner }}</dd></dl>
      <div class="same"><b>三成品同版：</b><span class="tag" :class="det.version ? 'grn' : 'amb'">{{ det.version || '还没版本' }}</span><span class="muted sm">教程 / SOP / Skill 必须引用同一个版本；订单用的是哪版也要能回看。</span></div>
      <div class="same"><b>复现：</b><span class="tag" :class="det.repro === 'ok' ? 'grn' : det.repro === 'failed' ? 'red' : 'amb'">{{ det.repro === 'ok' ? '干净环境通过' : det.repro === 'failed' ? '没通过' : '还没复现' }}</span><button class="btn sm" @click="dlMd">下载 SOP（MD）</button><button class="btn sm" :disabled="!det.version" @click="accept">主管验收（演示）</button><span v-if="acc[det.id]" class="tag grn">已验收 {{ acc[det.id].by }} · {{ acc[det.id].at }}</span></div>
      <h4>版本记录（改动出新版本，不覆盖旧的）</h4>
      <p v-if="!det.log.length" class="muted">还没有已入库的版本。</p>
      <div v-for="v in det.log" :key="v.v" class="lg"><b>{{ v.v }}</b><span class="muted">{{ v.date }}</span><span>{{ v.note }}</span></div>
      <p class="muted sm">统计和日期是演示值，不是真实数据。</p>
      <div class="mf"><button class="btn pri" @click="go(det)">打开服务页</button></div></div></div>

    <div class="cols">
      <aside class="tree card">
        <button class="all" :class="{ on: !sel }" @click="sel = ''">全部服务<em>{{ items.length }}</em></button>
        <div v-for="g in tree" :key="g.id" class="grp">
          <p class="gh">{{ g.name }}<em>{{ g.count }}</em></p><p class="gn">{{ g.note }}</p>
          <button v-for="lf in g.leaves" :key="lf.id" class="lf" :class="{ on: sel === lf.id, none: !lf.count }" @click="sel = lf.id">{{ lf.name }}<em>{{ lf.listed }}/{{ lf.count }}</em></button>
        </div>
      </aside>

      <section class="list">
        <div class="tb"><div class="tabs2"><button v-for="t in TABS" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">{{ t.t }}<em>{{ n(t.k) }}</em></button></div>
          <div class="tabs2 vw" role="group" aria-label="显示方式"><button :class="{ on: view === 'gallery' }" @click="setView('gallery')">Gallery</button><button :class="{ on: view === 'table' }" @click="setView('table')">表格</button></div></div>

        <div v-if="view === 'gallery' && shown.length" class="gal">
          <article v-for="e in shown" :key="e.id" class="gc card" :class="e.status" @click="go(e)">
            <div class="gi"><img :src="`/api/demo-img/V-${e.cover}.jpg`" alt="" /><span class="tag gs" :class="ST[e.status].cls">{{ e.status_label }}</span><span class="tag dark gk">{{ e.kind === 'remote' ? '远程操作类' : 'AI 工作流类' }}</span></div>
            <div class="gb"><h3>{{ e.name }}</h3><p class="path">{{ e.path.slice(1).join(' › ') }}</p>
              <p class="gp"><i>进度</i>{{ e.step }}</p>
              <p v-if="e.outputs" class="gt"><b class="tag" :class="OS[e.outputs.video].cls">教程 {{ OS[e.outputs.video].t }}</b><b class="tag" :class="OS[e.outputs.sop].cls">SOP {{ OS[e.outputs.sop].t }}</b><b class="tag" :class="OS[e.outputs.skill].cls">Skill {{ OS[e.outputs.skill].t }}</b></p>
              <p class="gp"><i>成交</i>{{ e.stats.orders }} 单<template v-if="e.stats.ok != null">，成功率 {{ e.stats.ok }}%</template> · <code>{{ e.id }}</code></p>
              <p class="gp"><i>执行方式</i>{{ e.exec.split('；')[0] }}</p><div class="ga"><button class="btn sm" @click.stop="det = e">详情</button><button class="btn sm pri" @click.stop="go(e)">打开服务页</button></div></div>
          </article>
        </div>

        <div v-else-if="view === 'table' && shown.length" class="card tbl-wrap"><table class="tbl2">
          <thead><tr><th>编号</th><th>服务</th><th>分类</th><th>状态</th><th>版本</th><th>进度</th><th>三个成品</th><th>证据</th><th>成交</th><th>负责人</th><th></th></tr></thead>
          <tbody><tr v-for="e in shown" :key="e.id" :class="e.status">
            <td><code>{{ e.id }}</code></td><td class="nm"><b>{{ e.name }}</b><small>{{ e.kind === 'remote' ? '远程操作类' : 'AI 工作流类' }}</small></td><td>{{ e.path.slice(1).join(' › ') }}</td>
            <td><span class="tag" :class="ST[e.status].cls">{{ e.status_label }}</span></td><td>{{ e.version || '—' }}</td><td>{{ e.step }}</td>
            <td><template v-if="e.outputs"><b class="tag" :class="OS[e.outputs.video].cls">教程 {{ OS[e.outputs.video].t }}</b> <b class="tag" :class="OS[e.outputs.sop].cls">SOP {{ OS[e.outputs.sop].t }}</b> <b class="tag" :class="OS[e.outputs.skill].cls">Skill {{ OS[e.outputs.skill].t }}</b></template><template v-else>—</template></td>
            <td><template v-if="e.evidence">{{ e.evidence.ok }}/{{ e.evidence.total }}<template v-if="e.evidence.gaps.length">（缺{{ e.evidence.gaps.map((g) => (g === 'terminal' ? '终端命令' : '下载来源')).join('、') }}）</template></template><template v-else>—</template></td>
            <td>{{ e.stats.orders }} 单<template v-if="e.stats.ok != null"> · {{ e.stats.ok }}%</template></td><td>{{ e.owner }}</td>
            <td class="ac"><button class="btn sm" @click="det = e">详情</button> <button class="btn sm pri" @click="go(e)">打开服务页</button></td></tr></tbody></table></div>

        <div v-if="!shown.length" class="empty card"><b>{{ leafName ? '「' + leafName + '」还没有 Skill' : '这一类现在没有' }}</b>
          <p>立项方式：走「学习到交付」流程——写服务研究卡 → 复现问题 → 找同行 → 学习机上同行实操 → 三个成品 → 干净 Windows 复现 → 入库。<Q k="svc-1" /></p><button v-if="sel && !leafName.includes('AI')" class="btn pri" @click="startNew">在「{{ leafName }}」下立项</button></div>
        <p class="muted foot">数据是演示数据；真实的 Skill 台账要程序员把服务能力库接进来。</p>
      </section>
    </div>
  </div>
</template>
<script setup>
import Term from './Term.vue'
import { computed, onMounted, ref } from 'vue'
import Q from './Q.vue'
import { api, post } from './api.js'
import { finalDb } from './demoFinal.js'
const tree = ref([]), items = ref([])
const sel = ref(''), tab = ref('all')
// 显示方式：Gallery（大图卡）或表格，记在本浏览器里
const VIEW_KEY = 'sk_view'
const view = ref((() => { if (/[?&]v=table/.test(location.hash)) return 'table'; if (/[?&]v=gallery/.test(location.hash)) return 'gallery'; try { return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'gallery' } catch { return 'gallery' } })())
const setView = (v) => { view.value = v; try { localStorage.setItem(VIEW_KEY, v) } catch { /* 存不了就算了 */ } }
const TABS = [{ k: 'all', t: '全部' }, { k: 'listed', t: '已入库' }, { k: 'learning', t: '学习中' }, { k: 'racing', t: '赛马中' }]
const ST = { listed: { cls: 'grn' }, learning: { cls: 'amb' }, racing: { cls: '' } }
const OS = { none: { t: '还没有', cls: '' }, draft: { t: '草稿', cls: 'amb' }, ready: { t: '已定稿', cls: 'grn' }, built: { t: '有 MP4', cls: 'grn' }, generated: { t: '待复现', cls: 'amb' }, verified: { t: '复现通过', cls: 'grn' }, failed: { t: '没通过', cls: 'red' } }
const n = (k) => (k === 'all' ? items.value.length : items.value.filter((e) => e.status === k).length)
const leafName = computed(() => tree.value.flatMap((g) => g.leaves).find((l) => l.id === sel.value)?.name || '')
const shown = computed(() => items.value.filter((e) => (!sel.value || e.leaf === sel.value) && (tab.value === 'all' || e.status === tab.value)))
const det = ref(null)
const acc = finalDb.skillAccept || (finalDb.skillAccept = {})
const mk = ref(false), nerr = ref(''), nf = ref({ leaf: '', name: '' })
const remoteLeaves = computed(() => tree.value.filter((g) => g.kind === 'remote').flatMap((g) => g.leaves))
const startNew = () => { nf.value = { leaf: sel.value, name: '' }; nerr.value = ''; mk.value = true }
async function create() {
  nerr.value = ''
  try { const p = await post('/virtual/skills', nf.value); mk.value = false; location.hash = `#/item/svc/${encodeURIComponent(p.id)}` } catch (e) { nerr.value = e.message }
}
const go = (e) => { location.hash = `#/item/svc/${encodeURIComponent(e.product_id)}` }
function dlMd() {
  const d = det.value
  const md = `# ${d.name}\n\n- 编号：${d.id}\n- 版本：${d.version || '—'}\n- 分类：${d.path.join(' › ')}\n- 负责人：${d.owner}\n- 执行方式：${d.exec}\n- 依赖：${d.deps.join('；')}\n\n## 适用\n${d.case}\n\n## 步骤\n${(d.steps || []).join('\n') || '（以服务页的 14 步为准）'}\n\n## 风险\n${d.risk}\n\n## 复现\n${d.repro === 'ok' ? '干净 Windows 独立复现通过' : '还没通过'}\n\n## 版本记录\n${(d.log || []).map((v) => `- ${v.v} ${v.date} ${v.note}`).join('\n')}\n`
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' })); a.download = `${d.id}_SOP_${d.version || 'draft'}.md`; a.click()
}
function accept() { acc[det.value.id] = { by: localStorage.getItem('erp_user') || 'chenxm', at: new Date().toISOString().slice(5, 10) }; det.value = { ...det.value } }
onMounted(async () => { try { const d = await api('/virtual/skills'); tree.value = d.tree; items.value = d.items } catch { /* 读不到就空着 */ } })
</script>
<style scoped>
.sk { padding: 26px 44px 90px; max-width: 1560px; } .sk .head { display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap; justify-content: space-between; } .sk h1 { font-size: 34px; margin: 6px 0; letter-spacing: -.02em; } .sk .eyebrow { margin: 0; font-size: 13px; font-weight: 700; color: var(--acc); } .sk .sub { margin: 0; color: var(--mute); max-width: 760px; }
.tabs2 { display: inline-flex; gap: 6px; background: var(--soft); padding: 4px; border-radius: 14px; } .tabs2 button { height: 36px; padding: 0 16px; border-radius: 10px; font-weight: 700; font-size: 14px; color: var(--ink2); display: inline-flex; align-items: center; gap: 8px; } .tabs2 button.on { background: var(--panel); color: var(--ink); box-shadow: var(--sh); } .tabs2 em { font-style: normal; font-size: 12.5px; color: var(--mute); }
.lf, .all { min-height: 0; line-height: 1.3; }
.sk .sum { display: flex; gap: 8px; align-items: center; } .cols { display: grid; grid-template-columns: 280px 1fr; gap: 20px; margin-top: 18px; align-items: start; } @media (max-width: 1000px) { .cols { grid-template-columns: 1fr; } }
.tree { padding: 14px; position: sticky; top: 12px; } .all, .lf { display: flex; width: 100%; justify-content: space-between; align-items: center; padding: 9px 12px; border-radius: 12px; font-weight: 700; font-size: 14.5px; text-align: left; color: var(--ink2); } .all:hover, .lf:hover { background: var(--soft); } .all.on, .lf.on { background: var(--acc-soft); color: var(--acc); }
.all em, .lf em, .gh em { font-style: normal; font-size: 12.5px; color: var(--mute); font-weight: 600; } .lf { padding-left: 24px; font-weight: 600; } .lf.none { color: var(--mute); }
.gh { margin: 14px 12px 2px; font-weight: 800; font-size: 14.5px; display: flex; justify-content: space-between; } .gn { margin: 0 12px 6px; font-size: 12px; color: var(--mute); line-height: 1.5; }
.tb { margin-bottom: 12px; } .it { margin-bottom: 14px; border-left: 6px solid var(--line); } .it.listed { border-left-color: var(--grn); } .it.learning { border-left-color: var(--amb); }
.r1 { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; } .push { flex: 1; } .r1 code { color: var(--mute); font-size: 12.5px; } .it h3 { margin: 8px 0 2px; font-size: 19px; } .path { margin: 0; color: var(--mute); font-size: 13px; }
.r2 { display: flex; gap: 16px 22px; flex-wrap: wrap; margin-top: 10px; font-size: 13.5px; } .r2 span { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; } .r2 i { font-style: normal; color: var(--mute); }
.dt { margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--line); } .dt h4 { margin: 14px 0 6px; font-size: 14.5px; } .lg { display: flex; gap: 12px; padding: 6px 0; font-size: 13.5px; } .sm { font-size: 12.5px; } .same { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; font-size: 13.5px; } .same .btn { height: 28px; padding: 0 10px; font-size: 12px; }
.mask { position: fixed; inset: 0; z-index: 70; background: rgba(8, 12, 22, .5); display: flex; align-items: center; justify-content: center; padding: 20px; } .modal { width: min(520px, 100%); background: var(--panel); border-radius: 20px; padding: 24px; display: grid; gap: 12px; box-shadow: var(--sh-up); } .modal label { display: grid; gap: 6px; font-size: 13px; font-weight: 600; color: var(--mute); } .modal input, .modal select { height: 42px; border: 1px solid var(--line); border-radius: 10px; padding: 0 12px; background: var(--soft); color: var(--ink); font: inherit; font-weight: 400; } .mf { display: flex; justify-content: flex-end; gap: 8px; }
.empty { padding: 28px; } .empty p { color: var(--ink2); line-height: 1.7; } .foot { margin: 8px 0 0; font-size: 12.5px; }

.vw { margin-left: 12px; } .tb { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 0; }
.gal { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 18px; } .gc { padding: 0; overflow: hidden; cursor: pointer; border-top: 5px solid var(--line); transition: transform .12s; } .gc:hover { transform: translateY(-3px); } .gc.listed { border-top-color: var(--grn); } .gc.learning { border-top-color: var(--amb); }
.gi { position: relative; aspect-ratio: 4 / 3; background: var(--soft); } .gi img { width: 100%; height: 100%; object-fit: cover; display: block; } .gs { position: absolute; left: 12px; top: 12px; } .gk { position: absolute; right: 12px; top: 12px; }
.gb { padding: 14px 16px 16px; display: grid; gap: 6px; } .gb h3 { margin: 0; font-size: 17px; line-height: 1.35; } .gp { margin: 0; font-size: 13.5px; color: var(--ink2); } .gp i { font-style: normal; color: var(--mute); margin-right: 8px; } .gt { margin: 0; display: flex; gap: 6px; flex-wrap: wrap; }
.tbl-wrap { padding: 0; overflow-x: auto; } .tbl2 { width: 100%; border-collapse: collapse; font-size: 13.5px; min-width: 1320px; } .tbl2 td:nth-child(1), .tbl2 td:nth-child(5), .tbl2 td:nth-child(9) { white-space: nowrap; } .tbl2 td:nth-child(2) { min-width: 230px; } .tbl2 td:nth-child(3) { min-width: 170px; } .tbl2 td:nth-child(6) { min-width: 150px; } .tbl2 td:nth-child(7) { min-width: 210px; } .tbl2 th { text-align: left; font-size: 12.5px; color: var(--mute); font-weight: 700; padding: 12px 14px; border-bottom: 1px solid var(--line); white-space: nowrap; } .tbl2 td { padding: 12px 14px; border-bottom: 1px solid var(--line); vertical-align: top; } .tbl2 tr:last-child td { border-bottom: 0; } .tbl2 .nm b { display: block; font-size: 14.5px; } .tbl2 .nm small { color: var(--mute); } .tbl2 tr.listed td:first-child { box-shadow: inset 4px 0 0 var(--grn); } .tbl2 tr.learning td:first-child { box-shadow: inset 4px 0 0 var(--amb); }
.wide2 { width: min(720px, 100%); max-height: 88vh; overflow: auto; } .mh { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; } .mh h3 { margin: 0; } .ga { display: flex; gap: 8px; margin-top: 4px; } .ac { white-space: nowrap; } .kv { display: grid; grid-template-columns: 110px 1fr; gap: 8px 14px; margin: 8px 0; font-size: 14px; } .kv dt { color: var(--mute); } .kv dd { margin: 0; }
</style>
