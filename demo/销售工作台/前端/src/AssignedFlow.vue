<template>
  <div class="af">
    <span class="tag">{{ task.status }}</span>
    <span v-if="task.due" class="tag">交付 {{ task.due }}</span>
    <span v-if="task.scope" class="muted">范围 {{ task.scope }}</span>
    <template v-if="locked"><a href="#/learn">完成三个练习后可操作</a></template>
    <template v-else>
      <button v-for="action in actions" :key="action.to" class="btn sm" :class="{ pri: action.primary }" @click="choose(action)">{{ action.label }}</button>
      <div v-if="pending" class="action-form">
        <label>{{ pending.prompt }}<textarea v-model.trim="note" /></label>
        <button class="btn sm" @click="pending = null">取消</button><button class="btn sm pri" @click="save(pending.to)">确认</button>
      </div>
    </template>
    <details v-if="task.history?.length" class="history">
      <summary>交接和验收记录 · {{ task.history.length }}</summary>
      <p v-for="(r, i) in [...task.history].reverse()" :key="i">{{ r.action }} · {{ nameOf(r.by) || r.by }} · {{ r.at }}<br v-if="r.note" />{{ r.note }}</p>
    </details>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { post } from './api.js'
import { loadAll, nameOf, state } from './store.js'
import { toast } from './ui.js'

const props = defineProps({ task: Object, locked: Boolean })
const pending = ref(null)
const note = ref('')
const actions = computed(() => {
  const current = props.task.status
  const own = props.task.to === state.me?.username
  const supervisor = state.me?.supervisor
  if (current === '待验收' && supervisor) return [
    { to: '已验收', label: '验收通过', primary: true },
    { to: '退回补正', label: '退回补正', prompt: '退回原因' },
  ]
  if (current === '受阻待接管' && supervisor) return [{ to: '执行中', label: '接管恢复', primary: true }]
  if (!own) return []
  return ({
    待接收: [{ to: '执行中', label: '接收', primary: true }],
    执行中: [
      { to: '等待外部', label: '等待外部', prompt: '等谁、等什么、何时复查' },
      { to: '受阻待接管', label: '受阻', prompt: '受阻原因与需要的帮助' },
      { to: '待验收', label: '提交验收', prompt: '交付结果与证据', primary: true },
    ],
    等待外部: [{ to: '执行中', label: '恢复执行' }],
    退回补正: [{ to: '待验收', label: '补完再交', prompt: '补正结果与证据', primary: true }],
  })[current] || []
})
function choose(action) {
  note.value = ''
  if (action.prompt) pending.value = action
  else save(action.to)
}
async function save(status) {
  try {
    await post(`/demo/tasks/${props.task.id}/status`, { status, note: note.value })
    pending.value = null
    await loadAll()
    toast('任务状态 · ' + status)
  } catch (e) { toast(e.message) }
}
</script>

<style scoped>
.af { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px 10px; margin: -7px 0 12px; background: var(--soft); border-radius: 7px; font-size: 13px; }
.action-form, .history { width: 100%; }
.action-form label { display: grid; gap: 4px; margin: 4px 0; }
.action-form textarea { padding: 6px; border: 1px solid var(--line); border-radius: 6px; min-height: 55px; }
.action-form .btn + .btn { margin-left: 6px; }
.history p { margin-top: 7px; color: var(--mute); }
</style>
