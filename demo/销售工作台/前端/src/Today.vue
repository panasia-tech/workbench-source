<template>
  <div class="page work-today">
    <header class="head" data-tour="today-head">
      <div>
        <h1>今天</h1>
        <p class="sub">{{ me.name || '读取账号中…' }}<template v-if="me.post"> · {{ me.post }}</template> · {{ sup ? '全队任务' : '我的任务' }}</p>
      </div>
      <div class="acts"><button class="btn pri" @click="goGallery">🖼 问题商品 Gallery</button><button class="btn" @click="openHelp('today')"><Icon name="help" />怎么用</button><button class="btn" data-tour="today-exc" @click="excOpen = true">遇到没见过的情况</button><Q k="d-exc" /><button class="btn" @click="devOpen = true">提给开发</button><Q k="d-dev" /></div>
    </header>


    <section class="task-summary" data-tour="today-count" aria-label="任务筛选">
      <span>任务状态<Q k="d-count" /></span>
      <button :class="{ selected: filter === 'all' }" :aria-pressed="filter === 'all'" @click="filter = 'all'">全部 <b>{{ sup ? reds.length : mineList.length }}</b></button>
      <button v-if="!sup" :class="{ selected: filter === 'red' }" :aria-pressed="filter === 'red'" @click="filter = 'red'"><i class="dot red"></i>要处理 <b>{{ reds.length }}</b></button>
      <button v-if="!sup" :class="{ selected: filter === 'amb' }" :aria-pressed="filter === 'amb'" @click="filter = 'amb'"><i class="dot amb"></i>注意 <b>{{ ambs.length }}</b></button>
      <button class="btn sm task-refresh" @click="loadAll(true)"><Icon name="refresh" />刷新</button>
    </section>
    <div class="today-layout">
    <aside class="today-aside">
    <section v-if="state.collab && state.collab.state !== 'taken'" data-tour="today-collab" class="collab" :class="state.collab.state">
      <div class="cl-l"><span class="tag" :class="state.collab.state === 'open' ? 'amb' : 'red'">协同请求</span><Q k="d-collab" /><h3>{{ state.collab.title }}</h3><p class="muted">来自 {{ state.collab.from }}</p></div>
      <div class="cl-r">
        <p v-if="state.collab.state === 'open'" class="cd"><b>{{ left }}</b> 秒内没人接，转给在岗同事 {{ state.collab.peer }}</p>
        <p v-else-if="state.collab.state === 'peer'" class="cd"><b>{{ left }}</b> 秒内没人接，转主管。已转给 {{ state.collab.peer }}</p>
        <p v-else class="cd">两轮 60 秒都没人接，已经弹给主管了。</p>
        <Lock :ok="!locked" reason="先做完练习" @go="take">我来接</Lock> <button class="btn sm" @click="recollab">演示：重新计时</button>
      </div>
    </section>


    <section class="card picks" :class="{ todo: !myPicks }" data-tour="today-picks">
      <div class="pk-h"><h3>今天的选品日报<Q k="d-picks" /> <small>实物、卡券、虚拟服务，各 1 条</small></h3>
        <span class="tag" :class="myPicks ? 'grn' : 'amb'">{{ myPicks ? '已交 ' + myPicks.at : '今天还没交' }}</span>
        <span class="tag" v-if="REAL_MODE">演示</span>
        <button class="btn" :class="myPicks ? '' : 'pri'" :disabled="locked" @click="openPicks">{{ myPicks ? '改一改' : '写今天的选品日报' }}</button></div>
      <div v-if="myPicks" class="pk-row">
        <div v-for="k in PK_KEYS" :key="k" class="pk-c"><span class="muted">{{ PK[k].label }}</span>
          <b v-if="!myPicks.items[k].none">{{ myPicks.items[k].title }}</b><b v-else class="muted">今天没找到</b>
          <small>{{ myPicks.items[k].none ? myPicks.items[k].why : myPicks.items[k].basis }}</small></div>
      </div>
      <p v-if="myPicks && myPicks.support" class="muted">需要的支持：{{ myPicks.support }}</p>
      <p v-else-if="!myPicks" class="muted">线索从哪来都行（逛闲鱼、同行、旅行见闻、榜单），但要写依据；今天确实没找到，要写原因，不能空着交。</p>
      <div v-if="sup && picks && picks.team.length" class="pk-team"><span class="muted">全队：</span>
        <span v-for="m in picks.team" :key="m.user" class="tag" :class="m.done ? 'grn' : 'amb'">{{ m.name }} {{ m.done ? '已交' + (m.none ? '（' + m.none + ' 条没找到）' : '') : '还没交' }}</span></div>
    </section>

    <section v-if="hist.total > 0 || hist.base > 0" class="card histc" data-tour="today-hist">
      <div class="pk-h"><h3>历史商品清洗，今天清完<Q k="d-hist" /> <small>库龄满 {{ IMG_RULES.historyDays }} 天的老库存，图和价都要清，是强制完成的</small></h3>
        <span class="tag" :class="hist.total === 0 ? 'grn' : 'amb'">{{ hist.total === 0 ? '今天清完了' : '还剩 ' + hist.total + ' 件' }}</span></div>
      <div class="bar"><i :style="{ width: hist.pct + '%', background: hist.total === 0 ? 'var(--grn)' : 'var(--acc)' }"></i></div>
      <p class="muted">今天开始时 {{ hist.base }} 件，已清 {{ hist.base - hist.total }} 件。<template v-if="sup && imgLoadRows.some((r) => r.hist)">　还没清完：<b v-for="r in imgLoadRows.filter((x) => x.hist)" :key="r.user + r.role" class="rm">{{ nameOf(r.user) }} {{ r.hist }} 件</b></template></p>
    </section>

    <section v-if="sup" class="card entc" data-tour="today-ent">
      <div class="pk-h">
        <h3>各店铺组派单排期均衡<Q k="d-ent" /> <small>业务侧仅展示中性排期可用态，不暴露任何限额数字</small></h3>
        <button class="btn sm" @click="openAdminPolicyModal">⚙ 一次性容量配置（仅管理端）</button>
      </div>
      <div v-for="e in ents.items" :key="e.id" class="ent">
        <b>{{ e.name }}</b>
        <span class="muted">{{ (e.shops || []).join('、') }}</span>
        <span class="tag" :class="e.state">{{ e.badge || (e.state === 'red' ? '本月排期已满 · 暂停派新' : e.state === 'amb' ? '优先派空闲号' : '正常接单') }}</span>
      </div>
      <p class="muted sm">{{ ents.rule }}</p>
    </section>

    <div v-if="showPolicyModal && sup" class="mask" @click.self="showPolicyModal = false">
      <div class="modal" style="width:min(680px,94vw);max-height:86vh;overflow:auto">
        <h3 style="margin:0 0 6px">🔒 店铺分组月度派单容量上限（一次性后台配置）</h3>
        <p class="muted sm" style="margin-bottom:14px">仅管理端可见（与 5370 主台账实时互通）。保存后一线销售端绝不显示任何金额，仅接收「正常接单 / 优先派空闲号 / 本月排期已满·暂停派新」状态。</p>
        <div v-for="p in adminPolicies" :key="p.id" style="border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:10px;background:var(--soft)">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <b>{{ p.group_code }} · {{ p.group_name }}</b>
            <span class="tag" :class="p.state">{{ p.dispatch_badge }}</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:13px">
            <label>均衡提醒阈值(元)<input type="number" v-model.number="p.soft_balance_cap_yuan" style="width:100%;height:34px;border-radius:8px;border:1px solid var(--line);padding:0 8px;margin-top:4px" /></label>
            <label>排期暂停上限(元)<input type="number" v-model.number="p.hard_pause_cap_yuan" style="width:100%;height:34px;border-radius:8px;border:1px solid var(--line);padding:0 8px;margin-top:4px" /></label>
            <label>当期已占用额度(元)<input type="number" v-model.number="p.current_month_used_yuan" style="width:100%;height:34px;border-radius:8px;border:1px solid var(--line);padding:0 8px;margin-top:4px" /></label>
          </div>
        </div>
        <div class="mfoot">
          <button class="btn ghost" @click="showPolicyModal = false">关闭</button>
          <button class="btn pri" :disabled="savingPol" @click="saveAdminPolicies">{{ savingPol ? '保存中…' : '保存一次性容量配置' }}</button>
        </div>
      </div>
    </div>



    <section class="cards">
      <div class="card comm" data-tour="today-comm"><p class="k">{{ sup ? '我的提成（示例）' : '今天的提成' }}<Q k="d-comm" /></p><template v-if="me.real"><p class="big">—</p><p class="k2">提成还没接入真实数据</p></template><template v-else><p class="big">¥{{ comm.day_ok + comm.day_pend }}</p><p class="m"><span class="tag grn">已确认 ¥{{ comm.day_ok }}</span><span class="tag amb">待确认 ¥{{ comm.day_pend }}</span></p>
        <p class="k2">本月 ¥{{ comm.mon_ok + comm.mon_pend }}（已确认 ¥{{ comm.mon_ok }} · 待确认 ¥{{ comm.mon_pend }}）</p></template></div>
      <div class="card" data-tour="today-team"><p class="k">团队目标进度<Q k="d-team" /></p><template v-if="me.real"><p class="big">—</p><p class="k2">团队目标还没接入真实数据</p></template><template v-else><p class="big">{{ Math.round((team.done / team.target) * 100) }}%</p>
        <div class="bar"><i :style="{ width: (team.done / team.target) * 100 + '%', background: 'var(--acc)' }"></i></div><p class="k2">本月 {{ team.done }} / {{ team.target }} 单；只显示团队进度，不排名</p></template></div>
    </section>
    </aside>
    <div class="today-queue">
    <section v-if="!sup" class="grp" data-tour="today-list">
      <h2 class="queue-title">待办任务</h2>
      <div v-show="filter !== 'amb'" class="queue-section">
      <h2><i class="dot red"></i>要处理<em>{{ reds.length }}</em><Q k="d-list" /></h2>
      <div v-for="t in redsShown" :key="t.id"><TaskRow :t="t" :locked="locked" @go="run(t)" /><AssignedFlow v-if="t.kind === 'assigned'" :task="t.task" :locked="locked" /></div>
      <p v-if="reds.length > CAP" class="more">还有 {{ reds.length - CAP }} 件红的没列出来（按最急的排）。<a @click="go('gallery/all')">去「库存商品」看全部</a></p>
      <p v-if="locked" class="empty">练习做完后，你的任务会出现在这里。</p>
      <p v-else-if="!reds.length && uname === 'newbie'" class="empty">主管还没给你派任务。第一天先去「库存商品」里点几件熟悉一下；遇到没见过的情况，点上面「遇到没见过的情况」。</p>
      <p v-else-if="state.loading && !state.loaded" class="empty">正在读取任务…</p><p v-else-if="!reds.length" class="empty">今天没有红灯。</p>
      </div>
      <div v-show="filter !== 'red'" class="queue-section">
      <h2><i class="dot amb"></i>注意<em>{{ ambs.length }}</em></h2>
      <div v-for="t in ambsShown" :key="t.id"><TaskRow :t="t" :locked="locked" @go="run(t)" /><AssignedFlow v-if="t.kind === 'assigned'" :task="t.task" :locked="locked" /></div>
      <p v-if="ambs.length > CAP" class="more">还有 {{ ambs.length - CAP }} 件黄的没列出来。<a @click="go('gallery/all')">去「库存商品」看全部</a></p>
      </div>
    </section>

    <section v-else class="grp" data-tour="today-list">
      <h2><i class="dot red"></i>全队红灯清单<em>{{ reds.length }}</em><Q k="d-list" /></h2>
      <div v-for="t in redsShown" :key="t.id" class="srow">
        <TaskRow :t="t" :locked="false" @go="run(t)" /><AssignedFlow v-if="t.kind === 'assigned'" :task="t.task" :locked="locked" />
        <div class="re"><span class="muted">{{ t.imgTask ? '系统自动派给 ' : REAL_MODE ? '系统建议派给 ' : '现在是 ' }}{{ nameOf(t.owner) || (t.imgTask ? '（没有合适的人）' : '（不分人，谁看到谁做）') }}</span>
          <!-- 图片任务由系统自动派，主管不用分；只有请假等例外才手动换人 -->
          <template v-if="!REAL_MODE && (!t.imgTask || swapOpen[t.id])"><select :id="'s-' + t.id"><option v-for="(n, u) in TEAM" :key="u" :value="u" :selected="u === t.owner">{{ n }}</option></select>
          <button class="btn sm" @click="reassign(t)">{{ t.imgTask ? '换人' : '改派' }}</button></template>
          <button v-else-if="!REAL_MODE && t.imgTask" class="btn sm ghost" @click="swapOpen[t.id] = true">换人（例外）</button></div>
      </div>
      <p v-if="!reds.length" class="empty">全队没有红灯。</p>

      <div class="two">
        <div class="card"><h3>图片任务自动派发<Q k="d-imgtask" /> <small>系统按规则自动派，主管不用分；有人请假等例外才手动换人</small></h3>
          <div v-for="r in imgLoadRows" :key="r.user + r.role" class="who"><b>{{ nameOf(r.user) }}</b><span class="muted">{{ r.role === 'WAREHOUSE' ? '仓管' : '销售' }} · 今天 {{ r.n }} 件<template v-if="r.hist">（其中历史清洗 {{ r.hist }}）</template></span><div class="bar"><i :style="{ width: Math.min(100, (r.n / maxLoad) * 100) + '%', background: 'var(--acc)' }"></i></div></div>
          <p v-if="state.imgSummary.history || state.imgSummary.fresh" class="muted" style="margin-top: 8px">新货 {{ state.imgSummary.fresh }} 件（每天新上的，十几二十票）；<b>历史清洗 {{ state.imgSummary.history }} 件</b>（库龄满 {{ IMG_RULES.historyDays }} 天的老库存，一次性，一天清完）。</p>
          <p v-if="!imgLoadRows.length" class="muted">现在没有图片任务。</p>
          <p class="muted" style="margin-top: 8px">规矩：缺实拍图、缺库位图 → 仓管；上架图（每个号各一组）→ 销售。红的先于黄的，库龄长的先；同一个型号的上架图给同一个人做（一个人做才能保证各号不雷同）；谁手上少先给谁；不设每天上限，当天派完；历史清洗一天做完。行情价每天抓一次，较上一次波动超过 {{ IMG_RULES.priceAlertPct }}% 就报警，派给销售核对。{{ REAL_MODE ? '真实版只读：这里只显示建议，不会写进系统。' : '' }}</p></div>
        <div class="card"><h3>每个人今天的进度<Q k="d-progress" /></h3>
          <div v-for="(n, u) in TEAM" :key="u" class="who"><b>{{ n }}</b><span class="muted">红 {{ countOf(u, 'red') }} · 黄 {{ countOf(u, 'amb') }}</span><div class="bar"><i :style="{ width: doneRate(u) + '%', background: 'var(--grn)' }"></i></div></div>
        </div>
        <div class="card"><h3>每日上架计划<Q k="d-plan" /> <small>每 20–30 分钟一票，单号每天最多 10 票</small></h3>
          <div v-for="a in state.plan?.accounts || []" :key="a.id" class="who"><b>{{ a.label }}</b><span class="muted">今天 {{ a.used }}/{{ a.limit }} 票</span><div class="bar"><i :style="{ width: (a.used / a.limit) * 100 + '%', background: a.used >= a.limit ? 'var(--red)' : 'var(--acc)' }"></i></div></div>
          <p class="muted" style="margin-top: 8px">满 10 票后第 11 票不发，下架删除也照计；顺延到明天。</p></div>
      </div>

      <div class="card" style="margin-top: 22px"><h3>加派任务<Q k="d-assign" /> <small>软件里生成，再推到钉钉 TB（接法待程序员评估）</small></h3>
        <div class="asg"><select v-model="af.cat"><option>显示器</option><option>手机</option><option>卡券</option><option>服务</option></select>
          <input v-model="af.req" placeholder="要求，例如：今天把飞利浦显示器过一遍，缺图的补拍" /><input v-model="af.scope" placeholder="交付范围：对象 / 地区 / 品牌" /><input v-model="af.due" placeholder="交付时间，例如 11-13 18:00" />
          <select v-model="af.to"><option v-for="(n, u) in TEAM" :key="u" :value="u">{{ n }}</option></select>
          <label class="file"><input type="checkbox" v-model="af.file" />附件：飞利浦显示器清单.xlsx</label>
          <button class="btn pri" @click="assign">派出去</button></div>
      </div>
      <div class="card" style="margin-top: 22px"><h3>员工上报的「没见过的情况」<Q k="d-exc" /></h3>
        <p v-if="!state.exceptions.length" class="muted">暂时没有。</p>
        <div v-for="e in state.exceptions" :key="e.id" class="exc"><span class="tag red">新情况</span><div><b>{{ e.who }}</b> {{ e.t }}<br />{{ e.text }}</div>
          <button v-if="!e.ruled" class="btn sm" @click="rule(e)">记成规则</button><span v-else class="tag grn">已记成规则草案</span></div>
      </div>
    </section>

    <section v-if="devs.length" class="card devs" style="margin-top: 22px"><h3>{{ sup ? '员工提给开发的需求' : '我提给开发的需求' }}<Q k="d-dev" /> <small>演示：正式环境一条对应禅道里的一条，状态以禅道为准</small></h3>
      <div v-for="r in devs" :key="r.id" class="exc"><span class="tag" :class="r.kind === 'bug' ? 'red' : 'acc'">{{ r.kind === 'bug' ? '软件问题' : '想要新功能' }}</span>
        <div><b>{{ r.id }} · {{ r.title }}</b> <span class="muted">{{ r.who }} · {{ r.t }}<template v-if="r.page"> · {{ r.page }}</template></span><br />{{ r.text }}</div>
        <div class="dv-r"><span class="tag" :class="r.status === '已验收' ? 'grn' : r.status === '打回重改' ? 'red' : 'amb'">{{ r.status }}</span>
          <template v-if="sup && r.status === '待评审'"><button class="btn sm" @click="devStatus(r, '开发中')">评审通过，开发中</button></template>
          <template v-if="sup && r.status === '开发中'"><button class="btn sm" @click="devStatus(r, '待提需求的人验收')">开发好了，请他验收</button></template>
          <template v-if="r.by === uname && r.status === '待提需求的人验收'"><button class="btn sm pri" @click="devStatus(r, '已验收')">验收通过</button><button class="btn sm" @click="devStatus(r, '打回重改')">打回重改</button></template></div></div>
    </section>

    </div>
    </div>

    <div v-if="handoff" class="mask" @click.self="handoff = null"><div class="modal big" role="dialog" aria-label="任务转交">
      <h3>转交给 {{ nameOf(handoff.to) }}</h3><p class="muted">{{ handoff.t.title }}</p>
      <label>已做<input v-model.trim="handoff.done" /></label>
      <label>未完成<input v-model.trim="handoff.remaining" /></label>
      <label>下一步<input v-model.trim="handoff.next" /></label>
      <div class="mfoot"><button class="btn" @click="handoff = null">取消</button><button class="btn pri" @click="confirmHandoff">确认转交</button></div>
    </div></div>
    <div v-if="pkOpen" class="mask" @click.self="pkOpen = false"><div class="modal big"><h3>今天的选品日报</h3><p class="muted">实物、卡券、虚拟服务各 1 条。每条写品名和依据（在哪里看到的、为什么值得做）；链接可不填。今天确实没找到，勾「今天没找到」写原因。合规方面拿不准的也写上，有没有律师意见不在这里判断。</p>
      <div v-for="k in PK_KEYS" :key="k" class="pk-blk"><h4>{{ PK[k].label }}</h4>
        <label class="ck"><input type="checkbox" v-model="pk[k].none" />今天没找到</label>
        <template v-if="!pk[k].none"><input v-model="pk[k].title" :placeholder="PK[k].ph" /><input v-model="pk[k].basis" placeholder="依据：在哪里看到的、为什么值得做" /><input v-model="pk[k].link" placeholder="链接（可不填）" /></template>
        <input v-else v-model="pk[k].why" placeholder="原因，例如：今天都在清洗历史库存，没来得及看" /></div>
      <div class="pk-blk"><h4>今天需要什么支持（可不填）</h4><input v-model="pkSupport" placeholder="例如：缺实拍图的货要仓管补拍；某个型号行情价没抓到" /></div>
      <div class="mfoot"><button class="btn" @click="pkOpen = false">取消</button><button class="btn pri" @click="savePicks">交日报</button></div></div></div>

    <div v-if="devOpen" class="mask" @click.self="devOpen = false"><div class="modal big"><h3>提给开发</h3><p class="muted"><b>不要私发给程序员</b>：私下发的需求没人评审、没人担责，程序员不接。在这里提，谁提的谁验收。</p>
      <div class="rw2"><label class="ck"><input type="radio" value="bug" v-model="dv.kind" />软件问题（用着不对）</label><label class="ck"><input type="radio" value="feature" v-model="dv.kind" />想要新功能</label></div>
      <input v-model="dv.title" placeholder="标题：哪一页的什么事，例如「库存商品页缩略图太小看不清」" /><input v-model="dv.page" placeholder="是哪一页（可不填）" />
      <textarea v-model="dv.text" placeholder="你在做什么、看到了什么、希望变成什么。能说清楚就行，不用写技术词。"></textarea>
      <div class="mfoot"><button class="btn" @click="devOpen = false">取消</button><button class="btn pri" @click="sendDev">提交</button></div></div></div>

    <div v-if="excOpen" class="mask" @click.self="excOpen = false"><div class="modal"><h3>遇到没见过的情况</h3><p class="muted">写一句话说发生了什么。主管会马上在红灯清单里看到，处理完会变成大家都能看到的规则。</p>
      <textarea v-model="excText" placeholder="例如：买家说卡密已被使用，但我们这边查是没用过的"></textarea>
      <div class="mfoot"><button class="btn" @click="excOpen = false">取消</button><button class="btn pri" @click="sendExc">发给主管</button></div></div></div>
  </div>
</template>

<script setup>
import Q from './Q.vue'
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import Icon from './Icon.vue'
import Lock from './Lock.vue'
import TaskRow from './TaskRow.vue'
import AssignedFlow from './AssignedFlow.vue'
import { state, buildTasks, loadAll, NAME, nameOf, IMG_RULES } from './store.js'
import { api, post } from './api.js'
import { openHelp, toast } from './ui.js'

const me = computed(() => state.me || { name: '', post: '', dept: '销售部', practice_done: true, supervisor: false })
const goGallery = () => { location.hash = '#/gallery/all' }
const sup = computed(() => me.value.supervisor)
const locked = computed(() => !me.value.practice_done)
const comm = computed(() => ({ day_ok: 0, day_pend: 0, mon_ok: 0, mon_pend: 0, ...me.value.commission }))
const team = computed(() => me.value.team || { target: 120, done: 74 })
// 能被派活的人：销售 + 仓管（来自员工名单）；读不到名单时用演示的两个人
const TEAM = computed(() => (Object.keys(state.pool || {}).length ? state.pool : { chenxm: '陈小满', zhoubb: '周小北' }))
const REAL_MODE = !!window.__REAL__
const swapOpen = reactive({})
const filter = ref('all')
const uname = computed(() => me.value.username || localStorage.getItem('erp_user') || 'chenxm')
const list = computed(() => buildTasks(uname.value))
// 真实版的商品任务没有「负责人」（真 ERP 没这个概念），谁打开谁看；图片任务才按派发规则分人
const mineList = computed(() => (sup.value ? list.value : list.value.filter((t) => t.owner === uname.value || (REAL_MODE && !t.owner))))
const reds = computed(() => mineList.value.filter((t) => t.lvl === 'red'))
const ambs = computed(() => mineList.value.filter((t) => t.lvl === 'amb'))
// 货多的时候（真数据几百件）只列最急的 30 条，其余去「库存商品」里按颜色筛
const CAP = 30
const redsShown = computed(() => reds.value.slice(0, CAP))
const ambsShown = computed(() => ambs.value.slice(0, CAP))
const imgLoadRows = computed(() => Object.values(state.imgLoad || {}).filter((x) => x.user).sort((a, b) => b.n - a.n))
const maxLoad = computed(() => Math.max(1, ...imgLoadRows.value.map((x) => x.n)))
const countOf = (u, l) => list.value.filter((t) => t.owner === u && t.lvl === l).length
const doneRate = (u) => { const t = list.value.filter((x) => x.owner === u).length; return Math.max(8, 100 - t * 6) }

// 协同请求：60 秒没人接 → 转在岗同事 → 再 60 秒 → 转主管（服务器按时间算，这里只显示倒计时）
const nowS = ref(0)
const left = computed(() => Math.max(0, (state.collab?.left ?? 0) - nowS.value))
let timer, poll
onMounted(() => {
  timer = setInterval(() => { nowS.value++ }, 1000)
  poll = setInterval(async () => { try { state.collab = await api('/demo/collab'); nowS.value = 0 } catch { /* 下次再读 */ } }, 4000)
})
onUnmounted(() => { clearInterval(timer); clearInterval(poll) })
async function take() { await post('/demo/collab/take'); state.collab = await api('/demo/collab'); toast('已接单，已通知消息工作台') }
async function recollab() { await post('/demo/collab/reset'); state.collab = await api('/demo/collab'); nowS.value = 0 }

const go = (h) => { location.hash = '#/' + h }
function run(t) {
  if (locked.value) return toast('真实任务先锁着，先去「学」里做完 3 个练习')
  if (t.kind === 'item') {
    if (t.go.item.kind === 'phys' && !t.go.item.locked) {
      if (t.go.jump === 'price') { location.hash = `#/price-cleaning/${encodeURIComponent(t.go.item.id)}`; return }
      if (t.go.jump === 'shops') { location.hash = `#/image-cleaning/${encodeURIComponent(t.go.item.id)}`; return }
    }
    location.hash = `#/item/${t.go.item.kind}/${encodeURIComponent(t.go.item.id)}${t.go.jump ? '?jump=' + t.go.jump : ''}`
  }
  else if (t.kind === 'link') { if (t.url) window.open(t.url, '_blank', 'noopener'); else location.hash = '#/wash' }
  else if (t.kind === 'order') location.hash = '#/orders?oid=' + encodeURIComponent(t.go.oid)
  else if (t.kind === 'assigned') toast(t.task.scope ? '交付范围：' + t.task.scope : '在任务下方查看状态和下一步')
}
const handoff = ref(null)
async function reassign(t) {
  const to = document.getElementById('s-' + t.id).value
  if (t.kind === 'assigned') { handoff.value = { t, to, done: '', remaining: '', next: '' }; return }
  try {
    await post('/demo/owner', { key: t.imgTask ? t.id : t.kind === 'order' ? 'order:' + t.id.slice(3) : t.go.item.key, to })
    await loadAll()
    toast('已改派给 ' + nameOf(to))
  } catch (e) { toast(e.message) }
}
async function confirmHandoff() {
  const { t, ...body } = handoff.value
  try {
    await post(`/demo/tasks/${t.aid}/reassign`, body)
    handoff.value = null
    await loadAll()
    toast('已改派给 ' + nameOf(body.to))
  } catch (e) { toast(e.message) }
}
const af = reactive({ cat: '显示器', req: '', scope: '', due: '', to: 'chenxm', file: true })
async function assign() {
  try {
    const r = await post('/demo/tasks', { cat: af.cat, req: af.req, scope: af.scope, due: af.due, to: af.to, files: af.file ? ['飞利浦显示器清单.xlsx'] : [] })
    await loadAll()
    af.req = ''; af.scope = ''; af.due = ''
    toast(r.tb)
  } catch (e) { toast(e.message) }
}
const excOpen = ref(false)
const excText = ref('')
async function sendExc() { try { await post('/demo/exceptions', { text: excText.value }); excText.value = ''; excOpen.value = false; await loadAll(); toast('已发给主管，他的红灯清单里能看到') } catch (e) { toast(e.message) } }
async function rule(e) { await post(`/demo/exceptions/${e.id}/rule`); await loadAll(); toast('已记成规则草案，等主管补处理口径') }

// 选品日报（实物 / 卡券 / 虚拟服务各 1 条）和「提给开发」（走禅道，不私发）
const PK_KEYS = ['phys', 'voucher', 'service']
const PK = { phys: { label: '实物', ph: '品名，例如：某型号显示器' }, voucher: { label: '卡券', ph: '品名，例如：星巴克中杯券' }, service: { label: '虚拟服务', ph: '品名，例如：CAD 图纸描图' } }
const picks = ref(null), pkOpen = ref(false), pkSupport = ref('')
const mk = () => ({ title: '', basis: '', link: '', none: false, why: '' })
const pk = reactive({ phys: mk(), voucher: mk(), service: mk() })
const myPicks = computed(() => picks.value?.mine || null)
async function loadPicks() { try { picks.value = await api('/demo/picks') } catch { /* 读不到就不显示 */ } }
function openPicks() {
  const m = myPicks.value?.items || {}
  for (const k of PK_KEYS) Object.assign(pk[k], mk(), m[k] || {})
  pkSupport.value = myPicks.value?.support || ''
  pkOpen.value = true
}
async function savePicks() {
  const items = {}
  for (const k of PK_KEYS) items[k] = pk[k].none ? { none: true, why: pk[k].why } : { title: pk[k].title, basis: pk[k].basis, link: pk[k].link }
  try { await post('/demo/picks', { items, support: pkSupport.value }); pkOpen.value = false; await loadPicks(); toast('选品日报已交，主管那边能看到') } catch (e) { toast(e.message) }
}
const devs = ref([]), devOpen = ref(false), dv = reactive({ kind: 'bug', title: '', text: '', page: '' })
async function loadDevs() { try { devs.value = (await api('/demo/devreq')).items || [] } catch { /* 没有就不显示 */ } }
async function sendDev() {
  try { await post('/demo/devreq', { ...dv }); Object.assign(dv, { kind: 'bug', title: '', text: '', page: '' }); devOpen.value = false; await loadDevs(); toast('已提交，评审后进开发；做完由你验收') } catch (e) { toast(e.message) }
}
async function devStatus(r, status) { try { await post(`/demo/devreq/${r.id}/status`, { status }); await loadDevs() } catch (e) { toast(e.message) } }
onMounted(() => { loadPicks(); loadDevs() })

// 历史清洗督促：今天开始时多少件、现在还剩多少件（基数记在本浏览器里，按天算）
const hist = computed(() => {
  const total = state.imgSummary?.history || 0, day = new Date().toISOString().slice(0, 10), k = 'hist_base_' + day
  let base = total
  try { base = Math.max(total, Number(localStorage.getItem(k) || 0)); localStorage.setItem(k, String(base)) } catch { /* 存不了就用当前数 */ }
  return { total, base, pct: base ? Math.round(((base - total) / base) * 100) : 100 }
})
// 店铺分组派单排期状态（全脱敏）+ 管理端一次性容量上限抽屉
const ents = ref({ items: [], rule: '' })
const showPolicyModal = ref(false)
const adminPolicies = ref([])
const savingPol = ref(false)
async function openAdminPolicyModal() {
  try {
    const r = await api('/demo/admin/dispatch-policies')
    adminPolicies.value = r.items || []
    showPolicyModal.value = true
  } catch (e) { toast(e.message || '仅管理端可访问') }
}
async function saveAdminPolicies() {
  savingPol.value = true
  try {
    const r = await api('/demo/admin/dispatch-policies', { method: 'POST', body: { items: adminPolicies.value } })
    adminPolicies.value = r.items || []
    ents.value = await api('/demo/entities')
    showPolicyModal.value = false
    toast('已保存一次性店铺派单容量配置')
  } catch (e) { toast(e.message || '保存失败') } finally { savingPol.value = false }
}
onMounted(async () => { try { ents.value = await api('/demo/entities') } catch { /* 读不到就不显示 */ } })
</script>

<style scoped>
.page { padding: 34px 44px 80px; max-width: 1500px; }
.head { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; flex-wrap: wrap; } .acts { display: flex; gap: 10px; } .acts svg { width: 18px; height: 18px; }
.eyebrow { color: var(--acc); font-weight: 700; font-size: 14px; } h1 { font-size: 38px; letter-spacing: -.02em; font-weight: 800; line-height: 1.15; margin-top: 4px; } .sub { color: var(--mute); margin-top: 8px; font-size: 15px; }
.gate { display: flex; align-items: center; gap: 16px; margin-top: 22px; padding: 18px 22px; background: var(--amb-soft); color: var(--amb-ink); border-radius: 20px; font-size: 15px; } .gate svg { width: 26px; height: 26px; flex: none; } .gate div { flex: 1; }
.cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; margin-top: 26px; }
.k { color: var(--mute); font-weight: 600; font-size: 13.5px; } .big { font-size: 44px; font-weight: 800; letter-spacing: -.03em; line-height: 1.1; margin: 4px 0 8px; } .big small { font-size: 15px; font-weight: 600; color: var(--mute); letter-spacing: 0; }
.m { display: flex; gap: 8px; flex-wrap: wrap; } .k2 { color: var(--mute); font-size: 13px; margin-top: 10px; }
.cards .bar { margin: 10px 0 4px; }
.collab { margin-top: 26px; display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; align-items: center; padding: 20px 24px; border-radius: 22px; background: var(--amb-soft); border: 2px solid #f6cf72; } .collab.peer, .collab.sup { background: var(--red-soft); border-color: var(--red); }
.collab h3 { font-size: 18px; margin: 6px 0 2px; max-width: 640px; } .cl-r { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; } .cd { font-size: 15px; } .cd b { font-size: 26px; }
.grp { margin-top: 34px; } .grp h2 { display: flex; align-items: center; gap: 10px; font-size: 21px; margin-bottom: 14px; } .grp h2 em { font-style: normal; font-size: 13px; font-weight: 700; background: var(--soft); color: var(--mute); border-radius: 999px; padding: 1px 10px; }
.empty { color: var(--mute); padding: 18px 4px; }
.srow { margin-bottom: 12px; } .re { display: flex; align-items: center; gap: 10px; margin: -4px 0 0 28px; padding: 8px 14px; background: var(--soft); border-radius: 0 0 16px 16px; } .re select { height: 32px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel); padding: 0 10px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 26px; }
.who { display: grid; grid-template-columns: 90px 1fr; gap: 4px 12px; align-items: center; margin-bottom: 12px; } .who .bar { grid-column: 1 / -1; height: 9px; }
.asg { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; } .asg input[type=text], .asg input:not([type]) { flex: 1; min-width: 260px; } .asg select, .asg input:not([type=checkbox]) { height: 40px; border-radius: 12px; border: 1px solid var(--line); background: var(--panel); padding: 0 12px; } .file { font-size: 14px; display: flex; gap: 6px; align-items: center; }
.exc { display: flex; gap: 12px; align-items: flex-start; padding: 10px 0; border-top: 1px solid var(--line); } .exc div { flex: 1; font-size: 14px; }
.mask { position: fixed; inset: 0; background: rgba(8, 12, 22, .5); z-index: 60; display: flex; align-items: center; justify-content: center; } .modal { background: var(--panel); border-radius: 24px; padding: 26px; width: min(520px, 92vw); box-shadow: var(--sh-up); } .modal textarea { width: 100%; height: 110px; margin-top: 14px; border-radius: 14px; border: 1px solid var(--line); background: var(--soft); padding: 12px; } .mfoot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
.btn.ghost { background: none; color: var(--mute); font-weight: 600; }
.more { color: var(--mute); font-size: 14px; margin: 4px 0 8px; padding-left: 6px; }

.picks { margin-top: 22px; } .picks.todo { border: 2px solid #f6cf72; } .pk-h { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; } .pk-h h3 { margin: 0; } .pk-h .btn { margin-left: auto; }
.pk-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
.pk-c { background: var(--soft); border-radius: 14px; padding: 10px 14px; display: grid; gap: 2px; } .pk-c b { font-size: 15.5px; } .pk-c small { color: var(--mute); font-size: 13px; }
.pk-team { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
.modal.big { width: min(720px, 94vw); max-height: 90vh; overflow: auto; } .modal.big input:not([type]), .modal.big input[type=text] { width: 100%; height: 40px; border: 1px solid var(--line); border-radius: 10px; padding: 0 12px; background: var(--panel); color: var(--ink); font: inherit; margin: 6px 0; }
.pk-blk { border-top: 1px solid var(--line); padding: 10px 0 4px; } .pk-blk h4 { margin: 0 0 2px; font-size: 16px; } .ck { display: flex; gap: 8px; align-items: center; font-size: 14px; margin: 4px 0; } .rw2 { display: flex; gap: 18px; flex-wrap: wrap; margin: 8px 0; }
.dv-r { display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
.histc, .entc { margin-top: 22px; } .histc .bar { margin: 10px 0; } .rm { margin-right: 12px; font-weight: 600; } .ent { display: grid; grid-template-columns: 170px 1fr 220px auto; gap: 6px 14px; align-items: center; padding: 8px 0; border-top: 1px solid var(--line); } .ent .bar { margin: 0; height: 9px; } .entc .sm { font-size: 12.5px; margin: 8px 0 0; }
</style>
