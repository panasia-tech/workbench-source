<!--
  消息聚合台（M1）：一个列表看全部账号的会话，取代逐个账号切换回复。
  数据源是群控服务端的 /gc/chat/*（会话来自 AdsPower 登录的闲鱼网页版卖家后台）。

  回复是**异步**的：点发送只是建一条 chat_reply 任务，真正发出由调度器派发到
  对应账号的执行端，且受 op_min_interval_sec 反风控节流。所以界面上必须如实
  显示「已排队」而不是「已发送」——否则销售会以为发出去了。
-->
<template>
  <div class="inbox">
    <aside class="rail">
      <div class="kpi">
        <div class="kpi-main">
          <span class="kpi-num" :class="rateClass">{{ ratePct }}</span>
          <span class="kpi-label">今日回复率</span>
        </div>
        <div class="kpi-sub">
          <span>待回 <b :class="{ warn: overall.pending > 0 }">{{ overall.pending }}</b></span>
          <span>已回 <b>{{ overall.replied }}</b></span>
        </div>
        <div v-if="overall.commission_per_order" class="kpi-foot">
          计件 ¥{{ overall.commission_per_order }}/单
        </div>
      </div>

      <div class="rail-title">按账号</div>
      <ul class="accounts">
        <li :class="{ on: !accountId }" @click="pick('')">
          <span class="a-nick">全部账号</span>
          <span class="a-num">{{ overall.incoming }}</span>
        </li>
        <li v-for="a in byAccount" :key="a.account_id" :class="{ on: accountId === a.account_id }"
            @click="pick(a.account_id)">
          <span class="a-nick">{{ a.account_nick || a.account_id }}</span>
          <span class="a-num" :class="{ warn: a.pending > 0 }">{{ a.pending || 0 }}</span>
        </li>
      </ul>
    </aside>

    <section class="list">
      <div class="list-bar">
        <b>会话</b>
        <span class="muted">{{ conversations.length }} 条</span>
        <el-button size="small" :loading="loading" @click="loadAll">刷新</el-button>
      </div>
      <el-alert v-if="error" type="error" :closable="false" show-icon class="err">{{ error }}</el-alert>
      <ul v-loading="loading" class="convs">
        <li v-for="c in conversations" :key="c.id" :class="{ on: current?.id === c.id }" @click="open(c)">
          <div class="c-top">
            <b class="c-nick">{{ c.peer_nick || c.peer_key }}</b>
            <span v-if="c.unread" class="c-badge">{{ c.unread }}</span>
            <span class="c-at">{{ ago(c.last_message_at) }}</span>
          </div>
          <div class="c-item">{{ c.item_title || '—' }}</div>
          <div class="c-last">{{ c.last_message || '' }}</div>
          <div class="c-acc">{{ c.account_nick || c.account_id }}</div>
        </li>
        <li v-if="!loading && !conversations.length" class="empty">没有会话</li>
      </ul>
    </section>

    <section class="thread">
      <template v-if="current">
        <div class="t-head">
          <div>
            <b>{{ current.peer_nick || current.peer_key }}</b>
            <span class="muted">{{ current.account_nick || current.account_id }}</span>
          </div>
          <span class="muted">{{ current.item_title || '' }}</span>
        </div>
        <div ref="scroller" class="bubbles">
          <div v-for="m in messages" :key="m.id" class="bubble" :class="m.direction">
            <div class="b-text">{{ m.text }}</div>
            <div class="b-at">{{ fmt(m.msg_at || m.created_at) }}</div>
          </div>
          <div v-if="!messages.length" class="empty">没有消息记录</div>
        </div>
        <div class="composer">
          <el-input v-model="draft" type="textarea" :rows="3" resize="none"
                    placeholder="回复内容（回车换行，点发送排队）" @keydown.enter.meta.prevent="send" />
          <div class="c-actions">
            <span class="muted hint">
              发送是异步的：建单后由该账号的执行端发出，受反风控节流影响可能延迟几十秒。
            </span>
            <el-button type="primary" size="small" :loading="sending" :disabled="!draft.trim()" @click="send">
              发送
            </el-button>
          </div>
          <el-alert v-if="queued" type="success" :closable="false" show-icon class="queued">
            已排队（job {{ queued }}）——发出后会出现在上面的消息记录里
          </el-alert>
        </div>
      </template>
      <div v-else class="empty pick">从左边选一个会话</div>
    </section>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'

const conversations = ref([])
const byAccount = ref([])
const overall = ref({ incoming: 0, replied: 0, pending: 0, rate: 1, commission_per_order: 10 })
const messages = ref([])
const current = ref(null)
const accountId = ref('')
const draft = ref('')
const queued = ref('')
const loading = ref(false)
const sending = ref(false)
const error = ref('')
const scroller = ref(null)
let timer = null

const ratePct = computed(() => `${Math.round((Number(overall.value.rate) || 0) * 100)}%`)
const rateClass = computed(() => {
  const r = Number(overall.value.rate) || 0
  return r >= 0.95 ? 'ok' : r >= 0.8 ? 'mid' : 'bad'
})

function fmt(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { hour12: false }).slice(5)
}

function ago(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const m = Math.floor(ms / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`
}

async function loadAll() {
  loading.value = true
  error.value = ''
  try {
    const [convs, stats, per] = await Promise.all([
      window.erp.chatConversations(accountId.value || undefined),
      window.erp.chatReplyRate(accountId.value || undefined),
      window.erp.chatReplyRate(undefined, true)
    ])
    conversations.value = Array.isArray(convs) ? convs : []
    overall.value = stats || overall.value
    byAccount.value = Array.isArray(per) ? per : []
    // 当前会话可能已经不在筛选结果里了，别留一个指向空气的详情面板
    if (current.value && !conversations.value.some((c) => c.id === current.value.id)) {
      current.value = null
      messages.value = []
    } else if (current.value) {
      await loadMessages(current.value.id)
    }
  } catch (e) {
    error.value = e?.message || '读取会话失败'
  } finally {
    loading.value = false
  }
}

async function loadMessages(id) {
  messages.value = await window.erp.chatMessages(id) || []
  await nextTick()
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
}

async function open(conv) {
  current.value = conv
  queued.value = ''
  draft.value = ''
  try {
    await loadMessages(conv.id)
    // 打开即已读：只清本系统的未读计数，不动闲鱼端红点
    await window.erp.chatMarkRead(conv.id).catch(() => {})
    conv.unread = 0
  } catch (e) {
    ElMessage.error(e?.message || '读取消息失败')
  }
}

function pick(id) {
  accountId.value = id
  loadAll()
}

async function send() {
  const text = draft.value.trim()
  if (!text || !current.value) return
  sending.value = true
  try {
    const res = await window.erp.chatReply(current.value.id, text)
    queued.value = res?.job_id || 'ok'
    draft.value = ''
  } catch (e) {
    ElMessage.error(e?.message || '回复排队失败')
  } finally {
    sending.value = false
  }
}

onMounted(() => {
  loadAll()
  timer = setInterval(loadAll, 15_000)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<style scoped>
.inbox { display: grid; grid-template-columns: 190px 300px 1fr; gap: 12px; height: calc(100vh - 150px); min-height: 420px; }
.rail, .list, .thread { background: #fff; border: 1px solid #e6ebe8; border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; }
.muted { color: #8d9a92; font-size: 12px; }

.kpi { padding: 14px 16px; border-bottom: 1px solid #eef2f0; }
.kpi-main { display: flex; align-items: baseline; gap: 8px; }
.kpi-num { font-size: 30px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1; }
.kpi-num.ok { color: #1d6a57; } .kpi-num.mid { color: #b87309; } .kpi-num.bad { color: #a32e1c; }
.kpi-label { color: #8d9a92; font-size: 12px; }
.kpi-sub { display: flex; gap: 14px; margin-top: 8px; font-size: 12px; color: #6b7a72; }
.kpi-sub b { font-variant-numeric: tabular-nums; } .kpi-sub b.warn { color: #a32e1c; }
.kpi-foot { margin-top: 6px; font-size: 11px; color: #8d9a92; }

.rail-title { padding: 10px 16px 4px; font-size: 11px; letter-spacing: .08em; color: #8d9a92; }
.accounts { list-style: none; margin: 0; padding: 0 8px 8px; overflow-y: auto; }
.accounts li { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; cursor: pointer; font-size: 12.5px; }
.accounts li:hover { background: #f3f7f5; }
.accounts li.on { background: #e8f3ee; color: #1d6a57; font-weight: 500; }
.a-nick { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.a-num { font-variant-numeric: tabular-nums; font-size: 11.5px; color: #8d9a92; }
.a-num.warn { color: #a32e1c; font-weight: 600; }

.list-bar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #eef2f0; }
.list-bar b { font-size: 13px; } .list-bar .el-button { margin-left: auto; }
.err { margin: 8px; width: auto; }
.convs { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
.convs li { padding: 10px 14px; border-bottom: 1px solid #f2f5f3; cursor: pointer; }
.convs li:hover { background: #f8faf9; }
.convs li.on { background: #eef6f2; }
.c-top { display: flex; align-items: center; gap: 7px; }
.c-nick { font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-badge { background: #a32e1c; color: #fff; font-size: 10px; padding: 0 5px; border-radius: 8px; line-height: 15px; }
.c-at { font-size: 11px; color: #9aa8a0; white-space: nowrap; }
.c-item { font-size: 11.5px; color: #6b7a72; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-last { font-size: 12px; color: #8d9a92; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-acc { font-size: 10.5px; color: #a8b4ad; margin-top: 4px; }

.t-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 11px 16px; border-bottom: 1px solid #eef2f0; }
.t-head b { font-size: 13.5px; margin-right: 8px; }
.bubbles { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; background: #fafcfb; }
.bubble { max-width: 74%; padding: 8px 11px; border-radius: 9px; font-size: 13px; line-height: 1.6; }
.bubble.in { align-self: flex-start; background: #fff; border: 1px solid #e6ebe8; }
.bubble.out { align-self: flex-end; background: #dff0e7; }
.b-text { white-space: pre-wrap; word-break: break-word; }
.b-at { margin-top: 3px; font-size: 10.5px; color: #9aa8a0; }
.composer { border-top: 1px solid #eef2f0; padding: 10px 14px 12px; }
.c-actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
.c-actions .hint { flex: 1; line-height: 1.5; }
.queued { margin-top: 8px; }
.empty { color: #9aa8a0; font-size: 12.5px; padding: 18px; text-align: center; }
.pick { margin: auto; }
</style>
