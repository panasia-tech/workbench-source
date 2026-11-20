<template>
  <div class="af">
    <span class="tag" :class="statusColor">{{ task.status }}</span>
    <span class="muted">负责人：<b>{{ task.assigneeName }}</b></span>
    <span v-if="task.evidence" class="muted">回执：<code>{{ task.evidence }}</code></span>
    <template v-if="locked">
      <a @click="go('learn')">先做完 3 个练习后可推进状态 ›</a>
    </template>
    <template v-else>
      <button
        v-for="action in actions"
        :key="action.to"
        class="btn sm"
        :class="{ pri: action.primary, ok: action.ok }"
        @click="choose(action)"
      >{{ action.label }}</button>
      <div v-if="pending" class="action-form">
        <label>{{ pending.prompt }}<textarea v-model.trim="note" :placeholder="pending.ph" /></label>
        <div class="fm-btns">
          <button class="btn sm" @click="pending = null">取消</button>
          <button class="btn sm pri" @click="save(pending.to)">确认提交</button>
        </div>
      </div>
    </template>
    <details v-if="task.handoffHistory?.length" class="history">
      <summary>交接和流转记录 · {{ task.handoffHistory.length }} 条</summary>
      <p v-for="(r, i) in [...task.handoffHistory].reverse()" :key="i">
        <b>{{ r.at }}</b> · {{ r.from }} → {{ r.to }}：已做「{{ r.donePart }}」
        <template v-if="r.todoPart"> · 未完「{{ r.todoPart }}」 · 下一步「{{ r.nextStep }}」</template>
      </p>
    </details>
  </div>
</template>
<script setup>
import { computed, ref } from 'vue'
import { currentUser, isSupervisor, go, updateTaskStatusGeneral } from '../store/warehouseStore.js'

const props = defineProps({ task: Object, locked: Boolean })
const pending = ref(null)
const note = ref('')

const statusColor = computed(() => {
  const s = props.task?.status
  if (s === '已验收') return 'grn'
  if (s === '受阻' || s === '退回补正') return 'red'
  if (s === '待验收' || s === '等待外部') return 'amb'
  return ''
})

const actions = computed(() => {
  const current = props.task?.status
  const own = props.task?.assignee === currentUser.value.id
  const sup = isSupervisor.value
  if (current === '待验收' && sup) {
    return [
      { to: '已验收', label: '验收通过', ok: true },
      { to: '退回补正', label: '退回补正（写原因）', prompt: '退回补正原因（经办人会原样看到）', ph: '例如：库位照片里没有拍到编号附件袋标签，请补拍一张' }
    ]
  }
  if (current === '受阻' && sup) {
    return [{ to: '执行中', label: '主管接管并恢复执行', primary: true }]
  }
  if (!own && !sup) return []
  return ({
    待接收: [{ to: '执行中', label: '接收任务', primary: true }],
    执行中: [
      { to: '等待外部', label: '等待外部', prompt: '等谁、等什么回执、何时复查', ph: '例如：等原采购员张敏回传闲鱼卖家退差截图' },
      { to: '受阻', label: '受阻升级主管', prompt: '受阻原因与需要主管协助的事项', ph: '例如：快递员拒不签字确认外箱挤压' },
      { to: '待验收', label: '提交验收', prompt: '交付结果与可核查证据编号（必填）', ph: '例如：拆封录像 REC-880105.mp4 + 瑕疵微距照2张', primary: true }
    ],
    等待外部: [{ to: '执行中', label: '外部已回执 · 恢复执行', primary: true }],
    退回补正: [{ to: '待验收', label: '补完再交验收', prompt: '补正结果与新证据编号', ph: '例如：已重拍 A-04 含附件袋同框照 #LOC-026', primary: true }]
  })[current] || []
})

function choose(action) {
  note.value = ''
  if (action.prompt) pending.value = action
  else save(action.to)
}

function save(status) {
  updateTaskStatusGeneral(props.task.id, status, note.value)
  pending.value = null
}
</script>
<style scoped>
.af {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  padding: 7px 12px;
  margin: -5px 0 12px;
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 7px;
  font-size: 12.5px;
}
.action-form, .history { width: 100%; }
.action-form label { display: grid; gap: 5px; margin-top: 6px; font-weight: 600; color: var(--ink2); }
.action-form textarea { padding: 7px 10px; border: 1px solid var(--line); border-radius: 6px; min-height: 58px; background: var(--panel); }
.fm-btns { display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px; }
.history summary { cursor: pointer; color: var(--acc); font-weight: 600; }
.history p { margin-top: 5px; color: var(--mute); line-height: 1.45; }
</style>
