<template>
  <section id="learn" class="sf card wide">
    <h3>学习到交付全流程 <small>同行操作我们的电脑 → 三个成品 → Agent 操作客户的电脑</small>
      <span class="hb"><button class="btn sm" @click="openHelp('svc-' + cur)"><Icon name="help" />这一步怎么用</button><button class="btn sm" @click="goManual">说明书</button></span></h3>

    <div class="ban"><b>为什么这样做：</b>技术服务是「会做的人手里的隐性知识」。我们请<Term k="同行" />远程操作公司的<Term k="学习机" />，自己采集<Term k="三路采集" />证据，把方法学下来，做成<Term k="手绘教程" />（给人看，Agent 卡住时人兜底）、<Term k="SOP" />和 AI agent 的 <Term k="Skill" />，复现通过再卖；对客交付时，Agent 经<Term k="向日葵" />（备用<Term k="ToDesk" />）操作客户电脑。</div>

    <div class="case">
      <div><span>要学的服务</span><b>{{ L.case.goal }}</b></div>
      <div><span>客户场景</span><b>{{ L.case.scene }}</b></div>
      <div><span>环境</span><b>{{ L.case.env }}</b></div>
      <div><span>原始现象</span><b>{{ L.case.symptom }}</b></div>
      <div><span>同行 · 报价 · 时效</span><b>{{ L.case.peer }} · {{ L.case.price }} · {{ L.case.sla }}</b></div>
    </div>

    <div class="rail" ref="rail">
      <div class="inner">
        <div class="phs"><span v-for="g in PH" :key="g.t" :class="g.c" :style="{ gridColumn: 'span ' + (g.to - g.from + 1) }"><b>{{ g.t }}</b><small>{{ g.sub }}</small></span></div>
        <ol class="steps">
          <li v-for="n in nodes" :key="n.n" :class="[n.state, { sel: shown && shown.n === n.n }]">
            <button type="button" class="nbtn" :title="n.title" @click="sel = n.n"><i>{{ n.state === 'done' ? '✓' : n.n }}</i><span>{{ SHORT[n.n] || n.title }}</span></button>
            <Q :k="'svc-' + n.n" />
          </li>
        </ol>
      </div>
    </div>
    <div v-if="shown" class="cn" :class="shown.state">
      <div class="cnh"><b>第 {{ shown.n }} 步 · {{ shown.title }}</b><em>{{ shown.role }}</em><span v-if="shown.state === 'cur'" class="tag grn">现在做这一步</span><span v-else-if="shown.state === 'done'" class="tag">已完成</span><span v-else class="tag">还没到</span><button v-if="sel && sel !== cur" class="btn sm" @click="sel = null">回到当前步骤</button></div>
      <p class="nd">{{ shown.desc }}</p>
    </div>

    <!-- 当前这一步要做的事 -->
    <div class="act">
      <template v-if="cur === 1">
        <h4>第 1 步：立项，写服务研究卡</h4>
        <p class="muted">要学的是一个<b>具体的服务结果</b>，不是宽泛的「维修」。缺的写「待核」，不要空着。</p>
        <div class="fm"><label>要学的服务结果<input v-model="c1.goal" placeholder="例如：处理《三角洲行动》启动时的虚拟化报警" /></label><label>客户场景<input v-model="c1.scene" placeholder="客户在什么情况下遇到这个问题" /></label>
          <label>设备 / 系统 / 版本<input v-model="c1.env" placeholder="例如：Windows 11，机型待客户补" /></label><label>报价（可后补）<input v-model="c1.price" placeholder="例如：¥39" /></label></div>
        <button class="btn pri" :disabled="busy || locked" @click="call('step', { n: 1, ...c1 })">存成服务研究卡</button>
      </template>
      <template v-else-if="cur === 2">
        <h4>第 2 步：先复现原始问题</h4>
        <p class="muted">自己把客户的问题重现一遍，记下真实的<Term k="复现">错误码、弹窗文字、Windows 环境</Term>，并截图（截图存在你电脑上，这里写文字）。</p>
        <textarea v-model="sym" placeholder="复现时看到了什么：错误码、弹窗原文、环境"></textarea>
        <button class="btn pri" :disabled="busy || locked" @click="call('step', { n: 2, symptom: sym })">已复现</button>
      </template>
      <template v-else-if="cur === 3">
        <h4>第 3 步：找同行，谈可接范围</h4>
        <p class="muted">在闲鱼找做这项服务的<Term k="同行" />。<b>不要</b>把密码、验证码写进来。</p>
        <div class="fm"><label>同行是谁（昵称 / 店铺）<input v-model="pr.peer" /></label><label>他能接什么、用什么工具、交付条件<input v-model="pr.scope" /></label><label>报价<input v-model="pr.price" /></label></div>
        <button class="btn pri" :disabled="busy || locked" @click="call('step', { n: 3, ...pr })">确认</button>
        <div class="peers"><b>多个同行 / 多套方法（选一套主方法）：</b>
          <div v-for="(x, i) in peers" :key="i" class="prow"><span class="tag" :class="x.main ? 'grn' : ''">{{ x.main ? '主方法' : '备选' }}</span><b>{{ x.peer }}</b><span class="muted">{{ x.scope }} · {{ x.price }}</span><button class="btn sm" @click="setMain(i)">设为主方法</button></div>
          <div class="rw"><input v-model="np.peer" placeholder="再加一个同行" /><input v-model="np.scope" placeholder="他能接什么" /><input v-model="np.price" placeholder="报价" /><button class="btn sm" @click="addPeer">加同行</button></div>
          <p class="muted sm">一项服务可以学多个同行，入库时选一套主方法；学习成本（付给同行多少）记在下面。</p>
          <div class="rw"><input v-model.number="np.cost" type="number" placeholder="付给同行的学习成本" /><button class="btn sm" @click="saveCost">记学习成本</button></div>
        </div>
      </template>
      <template v-else-if="cur === 5">
        <h4>第 5 步：开会话，检查三路采集</h4>
        <p class="muted">三路都在记录才能开始：缺一路，先处理采集。</p>
        <div class="fm"><label>学习机<input v-model="cp.machine" placeholder="例如：公司学习机 A" /></label><label>同行用的远控<input v-model="cp.remote" placeholder="向日葵 / ToDesk / 其他" /></label></div>
        <label class="ck"><input type="checkbox" v-model="cp.tools" />工具与环境清单（<Term k="osquery" />）在记录</label>
        <label class="ck"><input type="checkbox" v-model="cp.events" />后台操作事件（<Term k="Fibratus" />）在记录</label>
        <label class="ck"><input type="checkbox" v-model="cp.video" />屏幕录像（<Term k="OBS" />）在记录</label>
        <button class="btn pri" :disabled="busy || locked" @click="call('start_capture', cp)">开会话，可以开始</button>
      </template>
      <template v-else-if="cur === 6">
        <h4>第 6 步：同行远程操作</h4>
        <p class="muted">同行用他习惯的远控操作公司这台学习机，我方全程在场；越界（翻文件、装无关软件）立即断连。操作完了点下面。</p>
        <input v-model="pn" class="wide" placeholder="同行大概做了什么、有没有越界" />
        <button class="btn pri" :disabled="busy || locked" @click="call('step', { n: 6, note: pn })">同行操作完成</button>
      </template>
      <template v-else-if="cur === 7">
        <h4>第 7 步：标记关键节点</h4>
        <p class="muted">报警、弹窗、验证、失败、重启、解决，标上<Term k="时间码" />。看不清的写「未知」。已标 {{ L.keynodes.length }} 条。</p>
        <div class="rw"><input v-model="kn.t" placeholder="时间码 00:03:12" style="max-width: 140px" /><select v-model="kn.kind"><option v-for="k in KINDS" :key="k">{{ k }}</option></select><input v-model="kn.text" placeholder="发生了什么" /><button class="btn sm pri" :disabled="busy || locked" @click="call('keynode', kn)">加一条</button></div>
      </template>
      <template v-else-if="cur === 8">
        <h4>第 8 步：验证原问题</h4>
        <p class="muted">回到最初的问题，真的恢复了吗？（工具显示成功、进度 100% 都不算）</p>
        <div class="rw"><input v-model="ver" placeholder="怎么验证的、结果是什么" /><button class="btn sm pri" :disabled="busy || locked" @click="call('verify', { ok: true, note: ver })">恢复了</button><button class="btn sm" :disabled="busy || locked" @click="call('verify', { ok: false, note: ver })">没恢复</button></div>
      </template>

      <template v-else-if="cur === 4">
        <h4>第 4 步：确认学习机是安全的</h4>
        <label class="ck"><input type="checkbox" v-model="env.isolated" />这台学习机是<Term k="隔离环境" />：没有任何正式运营账号、店铺环境、支付工具、客户资料</label>
        <label class="ck"><input type="checkbox" v-model="env.present" />我方人员全程在场（人在场或 AI 在场监看），发现越界立即断连</label>
        <button class="btn pri" :disabled="busy || locked" @click="call('confirm_env', env)">确认，可以开始</button>
      </template>

      <template v-else-if="cur === 9">
        <h4>第 9 步：保全证据，补录缺口，结束会话</h4>
        <div class="tblwrap"><table class="tbl"><tr><th>证据</th><th>状态</th><th>说明</th></tr>
          <tr v-for="(c, k) in L.capture" :key="k"><td><b>{{ c.name }}</b></td><td><span class="tag" :class="ST[c.state].cls">{{ ST[c.state].t }}</span></td><td>{{ c.detail }}</td></tr></table></div>

        <div v-for="ch in missing" :key="ch" class="sup">
          <p><b>补录「{{ L.capture[ch].name }}」</b>（请<Term k="同行" />再演示或说明一次；拿不到就标<Term k="未知" />，不让 Agent 猜）</p>
          <textarea v-model="sup[ch]" :placeholder="ch === 'terminal' ? '贴命令正文和输出（多行都行）' : '贴下载的完整网址、文件名、大小'"></textarea>
          <div class="rw"><button class="btn sm pri" :disabled="busy || locked" @click="supplement(ch, false)">补录</button><button class="btn sm" :disabled="busy || locked" @click="supplement(ch, true)">同行也拿不到，标「未知」</button></div>
        </div>

        <div class="ver">
          <p><b><Term k="业务验证">验证原问题</Term></b>：回到最初的问题，真的恢复了吗？（工具显示成功、进度 100% 都不算）</p>
          <div v-if="L.verify.state === 'pending'" class="rw"><input v-model="ver" placeholder="怎么验证的、结果是什么" /><button class="btn sm pri" :disabled="busy || locked" @click="call('verify', { ok: true, note: ver })">恢复了</button><button class="btn sm" :disabled="busy || locked" @click="call('verify', { ok: false, note: ver })">没恢复</button></div>
          <p v-else class="okline">已验证：{{ L.verify.state === 'ok' ? '恢复了' : '没恢复' }}。{{ L.verify.note }}</p>
        </div>
        <button class="btn pri" :disabled="busy || locked" @click="call('finish')">保全证据，结束会话（<Term k="收尾" />）</button>
      </template>

      <template v-else-if="cur === 10">
        <h4>第 10 步：做三个成品</h4>
        <div class="outs">
          <div class="o"><b>{{ O.sop.name }}</b><span class="tag" :class="OS[O.sop.state].cls">{{ OS[O.sop.state].t }}</span><p>{{ O.sop.detail }}</p><button class="btn sm" :disabled="busy || locked" @click="call('build', { which: 'sop' })">整理 SOP</button></div>
          <div class="o"><b>{{ O.video.name }}</b><span class="tag" :class="OS[O.video.state].cls">{{ OS[O.video.state].t }}</span><p>{{ O.video.detail }}</p>
            <div class="rw"><input v-model="vf" placeholder="MP4 文件路径，例如 tutorials/xxx.mp4" /><input v-model.number="vs" type="number" placeholder="时长（秒）" style="width: 110px" /></div>
            <button class="btn sm" :disabled="busy || locked" @click="call('build', { which: 'video', file: vf, seconds: vs })">登记视频</button></div>
          <div class="o"><b>{{ O.skill.name }}</b><span class="tag" :class="OS[O.skill.state].cls">{{ OS[O.skill.state].t }}</span><p>{{ O.skill.detail }}</p><button class="btn sm" :disabled="busy || locked" @click="call('build', { which: 'skill' })">生成 Skill</button></div>
        </div>
      </template>

      <template v-else-if="cur === 11">
        <h4>第 11 步：在干净 Windows 上独立复现</h4>
        <p class="muted">另一套干净的 Windows，只靠 Skill 重做一遍。写清楚在哪套机器、怎么做的、结果是什么。</p>
        <div class="rw"><input v-model="rp" placeholder="在哪套干净 Windows、怎么做的、结果" /><button class="btn sm pri" :disabled="busy || locked" @click="call('repro', { ok: true, note: rp })">复现通过</button><button class="btn sm" :disabled="busy || locked" @click="call('repro', { ok: false, note: rp })">没通过</button></div>
      </template>

      <template v-else-if="cur === 12">
        <h4>第 12 步：进可售服务能力库</h4>
        <button class="btn pri" :disabled="busy || locked" @click="call('release')">登记为可售服务能力 v1.0</button>
      </template>

      <template v-else-if="cur === 13">
        <h4>第 13 步：客户对接与远控接入（智能体接手）</h4>
        <p class="muted">对接客户、教客户装和配<Term k="向日葵" />或<Term k="ToDesk" />、取<Term k="临时识别码" />，这些是重复劳动，将来由智能体接手：用<Term k="云端CodexDesktop">云端的 Codex Desktop</Term>，加这项服务的<Term k="专属Skill">专属 Skill</Term>，不是一个裸 API 能解决的。人只在异常时介入。</p>
        <div v-if="L.library.state === 'listed'" class="rw"><input v-model="buyer" placeholder="演示：下单的客户" /><button class="btn sm pri" :disabled="busy || locked" @click="call('onboard', { buyer })">演示：客户下单，智能体接手对接</button></div>
        <p v-else class="muted">这项服务还没进可售服务能力库，不能对客交付；急单先转同行。</p>
      </template>

      <template v-else-if="cur === 14">
        <h4>第 14 步：对客交付</h4>
        <p class="muted">远控首选 {{ L.delivery?.remote }}。Agent 操作，员工联络；Agent 卡住时人按「教程视频 + SOP」兜底（不靠 computer use）；急单、疑难可转同行。</p>
        <div v-if="L.delivery?.orders?.length" class="tblwrap"><table class="tbl"><tr><th>订单</th><th>客户</th><th>设备 · 接入</th><th>进度</th><th>版本</th><th>时效</th></tr>
          <tr v-for="o in L.delivery.orders" :key="o.id"><td>{{ o.id }}</td><td>{{ o.buyer }}</td><td>{{ o.device }} · {{ o.remote }}</td><td>{{ o.state }}</td><td>{{ L.library.version }}</td><td>还剩 {{ o.due_min }} 分钟</td></tr></table></div>
        <div class="handover"><b>转同行交接单（原始现象 / 已做 / 环境 / 材料）：</b><textarea v-model="reserve.handoffText" placeholder="客户原始报错、已经做过什么、设备环境、材料在哪"></textarea><div class="rw"><button class="btn sm" @click="makeHandover">生成交接单（演示）</button><button class="btn sm" @click="call('handoff', { text: '转同行交付（急单 / 疑难）' })">转同行（急单 / 疑难）</button><button class="btn sm" @click="call('handoff', { text: 'Agent 卡住，人按教程视频 + SOP 兜底' })">Agent 卡住，人来兜底</button></div></div>
      </template>

      <template v-else><p class="muted">这一步没有要你动手的事，等上一步的人做完。</p></template>
    </div>

    <!-- 执行环境：云端 Codex Desktop + 专属 Skill + 远控通道 -->
    <div v-if="L.runner" class="runner"><h4>执行环境<Q k="svc-runner" /> <small>对客交付不是一个裸 API，是下面三样合起来</small></h4>
      <div class="rr"><div><span>运行器</span><b><Term k="云端CodexDesktop">{{ L.runner.name }}</Term></b></div><div><span>专属 Skill</span><b><Term k="专属Skill">{{ L.runner.skill }}</Term></b></div><div><span>远控通道</span><b>{{ L.runner.remote }}</b></div><div><span>状态</span><b><span class="tag amb">{{ L.runner.state }}</span></b></div></div>
      <p class="muted sm">{{ L.runner.note }}</p>
      <div v-if="L.onboarding" class="ob"><b>客户对接（智能体做）：</b><span v-for="(x, i) in L.onboarding.steps" :key="i" class="tag" :class="x.state === 'done' ? 'grn' : 'amb'">{{ x.state === 'done' ? '✓ ' : '' }}{{ x.t }} · {{ x.who }}</span></div></div>

    <!-- 常驻：证据、关键节点、三成品、红线 -->
    <div class="grid2">
      <div class="bx"><h4>五路证据<Q k="svc-evidence" /></h4>
        <div v-for="(c, k) in L.capture" :key="k" class="ev"><span class="tag" :class="ST[c.state].cls">{{ ST[c.state].t }}</span><b>{{ c.name }}</b></div>
        <p class="muted sm">会话 {{ L.session.id }} · {{ L.session.machine }} · 同行用 {{ L.session.remote }} · {{ L.session.segments }} 段</p></div>
      <div class="bx"><h4>关键节点<Q k="svc-key" /> <small>（演示数据，不是真实采集）</small></h4>
        <div v-for="(k, i) in L.keynodes" :key="i" class="kn"><code>{{ k.t }}</code><span class="tag" :class="{ 警告: 'red', 重启: 'amb', 解决: 'grn' }[k.kind] || ''">{{ k.kind }}</span>{{ k.text }}</div></div>
      <div class="bx"><h4>三个成品<Q k="svc-outputs" /></h4>
        <div v-for="(o, k) in O" :key="k" class="ev"><span class="tag" :class="OS[o.state].cls">{{ OS[o.state].t }}</span><b>{{ o.name }}</b></div>
        <p class="muted sm">能力库：{{ L.library.state === 'listed' ? '已入库 ' + L.library.version : '还没入库' }}</p></div>
      <div class="bx red"><h4>安全红线<Q k="svc-redline" /></h4>
        <ul><li>远控只在<Term k="隔离环境" />里进行，我方全程在场</li><li>结束先保全证据，再断开、改凭据、清理</li><li>同行的账号密码不进教程、不进 Skill</li><li>缺的证据写「未知」，不让 Agent 猜成一键脚本</li><li>没复现通过，不卖</li></ul></div>
    </div>
    <p v-if="err" class="errbox">{{ err }}</p>
  </section>
</template>
<script setup>
import Q from './Q.vue'
import { computed, reactive, ref, onMounted, watch, nextTick } from 'vue'
import Icon from './Icon.vue'
import Term from './Term.vue'
import { post } from './api.js'
import { openHelp, toast as say } from './ui.js'
import { state } from './store.js'
import { finalDb, reserveOf } from './demoFinal.js'
const props = defineProps({ p: Object })
const emit = defineEmits(['changed'])
const L = computed(() => props.p.learn)
const O = computed(() => L.value.outputs)
const nodes = computed(() => props.p.learn_nodes || [])
const cur = computed(() => (nodes.value.find((n) => n.state === 'cur') || { n: 14 }).n)
const sel = ref(null), rail = ref(null)
const shown = computed(() => nodes.value.find((n) => n.n === (sel.value || cur.value)))
const SHORT = { 1: '立项', 2: '复现问题', 3: '找同行', 4: '学习机', 5: '三路采集', 6: '同行操作', 7: '标关键点', 8: '验证恢复', 9: '保全补录', 10: '三个成品', 11: '干净机复现', 12: '入能力库', 13: '对接客户', 14: '对客交付' }
const PH = [{ t: '学习', sub: '同行操作我们的电脑', from: 1, to: 9, c: 'p1' }, { t: '成品', sub: '教程 · SOP · Skill', from: 10, to: 12, c: 'p2' }, { t: '交付', sub: 'Agent 操作客户电脑', from: 13, to: 14, c: 'p3' }]
const centerCur = () => nextTick(() => { const r = rail.value, li = r && r.querySelector('li.cur'); if (r && li) r.scrollLeft = Math.max(0, li.offsetLeft - r.clientWidth / 2 + li.offsetWidth / 2) })
onMounted(centerCur)
const locked = computed(() => !state.me?.practice_done)
const busy = ref(false), err = ref('')
watch(() => cur.value, () => { sel.value = null; centerCur() })
const env = reactive({ isolated: false, present: false })
const c1 = reactive({ goal: props.p.learn.case.goal || '', scene: props.p.learn.case.scene || '', env: props.p.learn.case.env || '', price: props.p.learn.case.price || '' })
const sym = ref(''), pr = reactive({ peer: '', scope: '', price: '' }), cp = reactive({ machine: '', remote: '向日葵', tools: false, events: false, video: false }), pn = ref('')
const kn = reactive({ t: '', kind: '警告', text: '' })
const KINDS = ['警告', '弹窗', '验证', '失败', '重启', '解决']
const sup = reactive({ terminal: '', downloads: '' })
const ver = ref(''), vf = ref(''), vs = ref(null), rp = ref(''), buyer = ref('')
const reserve = computed(() => reserveOf(props.p.id))
const peers = computed(() => { if (!finalDb.peers) finalDb.peers = {}; if (!finalDb.peers[props.p.id]) finalDb.peers[props.p.id] = [{ peer: props.p.learn?.case?.peer || '同行 A', scope: '远程刷机', price: props.p.learn?.case?.price || '¥99', main: true }]; return finalDb.peers[props.p.id] })
const np = reactive({ peer: '', scope: '', price: '', cost: null })
const ST = { ok: { t: '已取得', cls: 'grn' }, missing: { t: '缺', cls: 'red' }, partial: { t: '不全', cls: 'amb' }, unknown: { t: '未知', cls: 'amb' } }
const OS = { none: { t: '还没有', cls: '' }, draft: { t: '草稿', cls: 'amb' }, ready: { t: '已定稿', cls: 'grn' }, built: { t: '已有 MP4', cls: 'grn' }, generated: { t: '已生成，待复现', cls: 'amb' }, verified: { t: '复现通过', cls: 'grn' }, failed: { t: '复现没通过', cls: 'red' } }
const missing = computed(() => ['terminal', 'downloads'].filter((k) => L.value.capture[k].state === 'missing' || L.value.capture[k].state === 'partial'))
async function call(action, body = {}) {
  busy.value = true; err.value = ''
  try { await post(`/virtual/products/${encodeURIComponent(props.p.id)}/learn/${action}`, body); emit('changed') } catch (e) { err.value = e.message } finally { busy.value = false }
}
const supplement = (ch, unavailable) => call('supplement', { channel: ch, content: sup[ch], unavailable })
const goManual = () => { location.hash = '#/manual?k=svc-' + cur.value }
function addPeer() { if (!np.peer.trim()) return; peers.value.push({ peer: np.peer.trim(), scope: np.scope, price: np.price, main: false }); np.peer = np.scope = np.price = '' }
function setMain(i) { peers.value.forEach((x, j) => (x.main = j === i)) }
function saveCost() { reserve.value.cost = np.cost; reserve.value.handoffText = reserve.value.handoffText || ''; err.value = ''; say('学习成本已记：¥' + (np.cost || 0) + '（演示）') }
function makeHandover() { if (!reserve.value.handoffText) return; reserve.value.commit = reserve.value.commit || ''; say('交接单已生成（演示）：原始现象 / 已做 / 环境 / 材料') }
</script>
<style scoped>
.sf h3 { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; } .hb { margin-left: auto; display: inline-flex; gap: 8px; }
.ban { background: var(--soft); border-radius: 14px; padding: 12px 16px; font-size: 14px; line-height: 1.7; color: var(--ink2); margin: 10px 0; }
.case { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; margin: 10px 0 16px; } .case div { background: var(--soft); border-radius: 14px; padding: 10px 14px; } .case span { display: block; font-size: 12.5px; color: var(--mute); } .case b { font-size: 14.5px; font-weight: 700; }
.rail { overflow-x: auto; margin: 6px 0 4px; padding-bottom: 6px; } .inner { min-width: 1120px; }
.phs { display: grid; grid-template-columns: repeat(14, 1fr); gap: 0; margin-bottom: 8px; } .phs span { display: flex; align-items: baseline; gap: 8px; padding: 5px 12px; border-radius: 10px; margin: 0 3px; font-size: 12.5px; color: var(--ink2); background: var(--soft); white-space: nowrap; overflow: hidden; } .phs b { font-size: 13.5px; color: var(--ink); } .phs small { color: var(--mute); } .phs .p2 { background: var(--acc-soft); } .phs .p3 { background: var(--grn-soft, var(--soft)); }
.steps { list-style: none; display: grid; grid-template-columns: repeat(14, 1fr); margin: 0; padding: 0; }
.steps li { position: relative; display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 12.5px; font-weight: 600; color: var(--mute); text-align: center; padding: 0 2px; }
.steps li::before { content: ''; position: absolute; top: 17px; left: -50%; width: 100%; height: 3px; background: var(--line); z-index: 0; } .steps li:first-child::before { display: none; }
.nbtn { all: unset; position: relative; z-index: 1; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 6px; border-radius: 12px; padding: 0 2px 2px; } .nbtn:focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; }
.nbtn span { line-height: 1.3; }
.steps li i { width: 36px; height: 36px; border-radius: 50%; background: var(--soft); border: 3px solid var(--line); display: flex; align-items: center; justify-content: center; font-style: normal; font-weight: 800; font-size: 14px; }
.steps li.done { color: var(--grn-ink); } .steps li.done i { background: var(--grn); border-color: var(--grn); color: #fff; } .steps li.done::before { background: var(--grn); }
.steps li.cur { color: var(--acc); } .steps li.cur i { background: var(--acc); border-color: var(--acc); color: #fff; box-shadow: 0 0 0 6px var(--acc-soft); } .steps li.cur::before { background: var(--grn); }
.steps li.sel .nbtn span { text-decoration: underline; text-underline-offset: 4px; }
.cn { margin: 10px 0 0; background: var(--acc-soft); border-radius: 16px; padding: 12px 16px; } .cn.done, .cn.todo { background: var(--soft); }
.cnh { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; } .cnh b { font-size: 16.5px; } .cnh em { font-style: normal; font-size: 13px; color: var(--mute); } .cnh .btn { margin-left: auto; margin-top: 0; }
.nd { margin: 6px 0 0; font-size: 14px; color: var(--ink2); line-height: 1.7; }
.act { margin-top: 14px; background: var(--soft); border-radius: 18px; padding: 16px 18px; } .act h4 { margin: 0 0 8px; font-size: 17px; }
.fm { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; margin: 8px 0 12px; } .fm label { display: grid; gap: 5px; font-size: 13px; font-weight: 600; color: var(--mute); } .fm input, .act textarea.wide, input.wide, .rw select { height: 40px; border: 1px solid var(--line); border-radius: 10px; padding: 0 12px; background: var(--panel); color: var(--ink); font: inherit; font-weight: 400; } input.wide { width: 100%; margin-bottom: 8px; } .act > textarea { width: 100%; min-height: 84px; margin: 6px 0 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); color: var(--ink); padding: 10px; font: inherit; }
.ck { display: flex; gap: 10px; align-items: flex-start; margin: 8px 0; font-size: 14.5px; } .ck input { margin-top: 4px; width: 18px; height: 18px; }
.sup { background: var(--panel); border-radius: 14px; padding: 12px 14px; margin: 10px 0; } .sup textarea { width: 100%; min-height: 84px; margin: 8px 0; border: 1px solid var(--line); border-radius: 12px; background: var(--soft); color: var(--ink); padding: 10px; font: inherit; }
.rw { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0; } .rw input { flex: 1; min-width: 200px; height: 38px; border: 1px solid var(--line); border-radius: 10px; padding: 0 10px; background: var(--panel); color: var(--ink); }
.ver { margin: 12px 0; } .okline { color: var(--grn-ink); font-size: 14px; }
.outs { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; } .o { background: var(--panel); border-radius: 14px; padding: 12px 14px; } .o p { font-size: 13.5px; color: var(--mute); margin: 6px 0; }
.runner { margin-top: 14px; background: var(--acc-soft); border-radius: 16px; padding: 12px 16px; } .runner h4 { margin: 0 0 8px; font-size: 15px; } .runner h4 small { font-weight: 400; color: var(--ink2); } .rr { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; } .rr div { background: var(--panel); border-radius: 12px; padding: 8px 12px; } .rr span { display: block; font-size: 12px; color: var(--mute); } .rr b { font-size: 14px; } .ob { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 8px; font-size: 13px; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-top: 14px; } .bx { background: var(--soft); border-radius: 14px; padding: 12px 14px; } .bx h4 { margin: 0 0 8px; font-size: 15px; } .bx h4 small { font-weight: 400; color: var(--mute); }
.bx.red { background: var(--red-soft); color: var(--red-ink); } .bx ul { margin: 0; padding-left: 18px; font-size: 13.5px; line-height: 1.7; }
.ev { display: flex; gap: 8px; align-items: center; margin: 5px 0; font-size: 13.5px; } .kn { display: flex; gap: 8px; align-items: baseline; margin: 5px 0; font-size: 13.5px; } .kn code { color: var(--mute); }
.sm { font-size: 12.5px; margin-top: 8px; } .errbox { margin-top: 12px; } .peers { margin-top: 12px; background: var(--panel); border-radius: 12px; padding: 10px 12px; } .prow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 5px 0; border-top: 1px solid var(--line); font-size: 13px; } .handover { margin: 10px 0; background: var(--panel); border-radius: 12px; padding: 10px 12px; } .handover textarea { width: 100%; min-height: 60px; border: 1px solid var(--line); border-radius: 10px; background: var(--soft); color: var(--ink); padding: 8px; font: inherit; }
</style>
