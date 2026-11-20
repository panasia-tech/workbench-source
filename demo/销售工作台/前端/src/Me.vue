<template>
  <div class="page personal">
    <header class="head"><div><p class="eyebrow">{{ me.dept }} · {{ me.post }}</p><h1>我的</h1></div></header>
    <section class="cols">
      <div class="card"><h3>提成明细<Q k="me-comm" /> <small>只看自己，不公开排名；「待确认」= 订单还没过售后期</small></h3>
        <div class="sum"><div><span>今天</span><b>¥{{ c.day_ok + c.day_pend }}</b><small>已确认 ¥{{ c.day_ok }} · 待确认 ¥{{ c.day_pend }}</small></div><div><span>本月</span><b>¥{{ c.mon_ok + c.mon_pend }}</b><small>已确认 ¥{{ c.mon_ok }} · 待确认 ¥{{ c.mon_pend }}</small></div></div>
        <div class="tblwrap"><table class="tbl"><tr><th>时间</th><th>来源</th><th>金额</th><th>状态</th></tr><tr v-for="(r, i) in me.ledger" :key="i"><td>{{ r.t }}</td><td>{{ r.src }}</td><td class="num">¥{{ r.amt }}</td><td><span class="tag" :class="r.st === 'ok' ? 'grn' : 'amb'">{{ r.st === 'ok' ? '已确认' : '待确认' }}</span></td></tr></table></div>
        <p class="muted" style="margin-top: 10px">口径：码券类成交提成 10%、服务类 20%；上新奖 跟卖型 20 元、路测型 200 元；建卡人 6 个月内分 5%；退款、纠纷扣回。实物每单固定 ¥10。<span class="tag amb">数值按方案草案，以公司正式通知为准</span></p></div>
      <div class="card"><h3>你能看到什么<Q k="me-access" /> <small>按钉钉组织架构的部门和岗位分配</small></h3>
        <dl class="kv"><dt>部门</dt><dd>{{ me.dept }}</dd><dt>岗位</dt><dd>{{ me.post }}</dd><dt>能进</dt><dd>今天、库存商品（实物 / 虚拟 / 服务）、订单、学</dd><dt>不能做</dt><dd>改别人的任务、批准自己提交的上架（主管除外）、看财务和 HR 数据</dd></dl>
        <h3 style="margin-top: 22px">字号</h3><div class="seg"><button :class="{ on: ui.fontBig }" @click="setFont(true)">大（默认）</button><button :class="{ on: !ui.fontBig }" @click="setFont(false)">标准</button></div>
        <p class="muted" style="margin-top: 8px">13 寸笔记本按大字号设计；27 寸显示器上只会多排几列，不会把字拉大。</p>
        <h3 style="margin-top: 22px">新手指导</h3><button class="btn" @click="again">一键从头再学（只重置学习进度）</button></div>
      <div class="card"><h3>MCP / 工具配置<Q k="me-mcp" /> <small>名称、地址、用途、启用状态；密钥只显示掩码</small></h3>
        <div v-for="m in db.mcp" :key="m.id" class="mcp"><div><b>{{ m.name }}</b><small>{{ m.addr }}</small><p>{{ m.use }} · 密钥 {{ m.secret }}</p></div><span class="tag" :class="m.enabled ? 'grn' : 'red'">{{ m.enabled ? '已启用' : '已停用' }}</span><span class="tag" :class="m.test === '正常' ? 'grn' : 'amb'">{{ m.test }}</span><button class="btn sm" @click="test(m)">测试连接</button><button class="btn sm" @click="m.enabled = !m.enabled">{{ m.enabled ? '停用' : '启用' }}</button></div>
        <div class="mcpadd"><input v-model="nm.name" placeholder="名称" /><input v-model="nm.addr" placeholder="地址" /><input v-model="nm.use" placeholder="用途" /><button class="btn sm pri" @click="addMcp">+ 加一个</button></div>
        <p class="muted sm">测试只是演示；真实连接由程序员配，密钥不进页面、不进日志。任务里进 Codex 要带原任务材料，不是空白聊天。</p></div>
    </section>
  </div>
</template>
<script setup>
import Q from './Q.vue'
import { computed, reactive } from 'vue'
import { state, loadAll } from './store.js'
import { ui, setFont, toast } from './ui.js'
import { post } from './api.js'
import { finalDb as db } from './demoFinal.js'
const me = computed(() => state.me || { dept: '', post: '', ledger: [], commission: {} })
const c = computed(() => ({ day_ok: 0, day_pend: 0, mon_ok: 0, mon_pend: 0, ...me.value.commission }))
const nm = reactive({ name: '', addr: '', use: '' })
function test(m) { m.test = m.test === '正常' ? '失败：超时（演示）' : '正常'; toast(m.name + '：' + m.test) }
function addMcp() { if (!nm.name.trim()) return toast('先写名称'); db.mcp.push({ id: 'M' + (db.mcp.length + 1), name: nm.name.trim(), addr: nm.addr, use: nm.use, enabled: true, secret: '••••••', test: '未测试' }); nm.name = nm.addr = nm.use = ''; toast('已加，启用前先测试') }
async function again() { await post('/demo/learning/reset'); await loadAll(true); toast('学习进度已重置；真实业务没有动') }
</script>
<style scoped>
.page { padding: 34px 44px 80px; max-width: 1400px; } .eyebrow { color: var(--acc); font-weight: 700; font-size: 14px; } h1 { font-size: 38px; font-weight: 800; letter-spacing: -.02em; }
.cols { display: grid; grid-template-columns: 1.3fr 1fr; gap: 22px; margin-top: 24px; } @media (max-width: 1100px) { .cols { grid-template-columns: 1fr; } }
.sum { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 16px; } .sum div { background: var(--soft); border-radius: 16px; padding: 14px 18px; } .sum span { color: var(--mute); font-size: 13px; display: block; } .sum b { font-size: 32px; letter-spacing: -.02em; } .sum small { display: block; color: var(--mute); }
.mcp { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 9px 0; border-top: 1px solid var(--line); font-size: 13px; } .mcp > div { flex: 1; min-width: 180px; display: grid; gap: 2px; } .mcp b { font-size: 14px; } .mcp small { color: var(--mute); font-size: 11.5px; } .mcp p { color: var(--mute); font-size: 12px; margin: 0; } .mcpadd { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; } .mcpadd input { flex: 1; min-width: 100px; height: 32px; border: 1px solid var(--line); border-radius: 8px; padding: 0 8px; background: var(--soft); color: var(--ink); } .sm { font-size: 12px; } .seg { display: inline-flex; gap: 4px; padding: 4px; background: var(--soft); border-radius: 14px; } .seg button { height: 36px; padding: 0 16px; border-radius: 10px; font-weight: 700; } .seg button.on { background: var(--ink); color: var(--bg); }
</style>
