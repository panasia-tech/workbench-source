<template>
  <div class="tr" :class="lvl">
    <span class="ic">{{ LV[lvl]?.icon || '•' }}</span>
    <span class="th" :class="{ ph: !thumb }">
      <img v-if="thumb" :src="thumb" alt="" />
      <Icon v-else :name="iconName" />
    </span>
    <div class="mid">
      <div class="line">
        <span class="tag" :class="lvl === 'red' ? 'red' : 'amb'">{{ t.category }}</span>
        <span class="tag">{{ t.status }}</span>
        <h3>{{ t.title }}</h3>
      </div>
      <p>{{ t.summary }} <span class="meta">· 单号 {{ t.refNo }} · 时限 {{ t.deadline }}</span></p>
    </div>
    <div class="act">
      <button class="btn pri sm" :class="{ dis: locked }" @click="$emit('go')">
        <Icon v-if="locked" name="lock" class="li" />{{ btnText }}
      </button>
    </div>
  </div>
</template>
<script setup>
import { computed } from 'vue'
import Icon from './Icon.vue'
import { LV, store } from '../store/warehouseStore.js'

const props = defineProps({ t: Object, locked: Boolean })
defineEmits(['go'])

const lvl = computed(() => (props.t?.urgency === 'red' ? 'red' : 'amb'))
const thumb = computed(() => {
  const code = props.t?.skuCode
  if (!code) return ''
  const sku = store.data.skus.find(s => s.code === code)
  if (sku?.realThumb) return sku.realThumb
  const insp = store.data.inspections.find(i => i.skuCode === code)
  if (insp?.realPhotos?.[0]) return insp.realPhotos[0]
  return ''
})
const iconName = computed(() => {
  const r = props.t?.route
  if (r === 'orders') return 'inbox'
  if (r === 'asn') return 'inbound'
  if (r === 'locations') return 'pin'
  if (r === 'ledger') return 'ledger'
  if (r === 'outbound') return 'truck'
  if (r === 'inspect') return 'scan'
  if (r === 'anomaly') return 'alert'
  if (r === 'media') return 'camera'
  return 'today'
})
const btnText = computed(() => {
  if (props.t?.route === 'orders') return '去聚合打单'
  if (props.t?.route === 'asn') return '去签收上架'
  if (props.t?.route === 'inspect') return '去验货'
  if (props.t?.route === 'anomaly') return '去处理'
  if (props.t?.route === 'outbound') return '去复核'
  if (props.t?.route === 'media') return '去补图'
  return '去处理'
})
</script>
<style scoped>
.tr {
  display: flex;
  align-items: center;
  gap: 13px;
  background: var(--panel);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 10px;
  border: 1px solid var(--line);
  border-left: 4px solid var(--line);
}
.tr.red { border-left-color: var(--red); }
.tr.amb { border-left-color: var(--amb); }
.ic {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  font-size: 12px;
  flex: none;
}
.red .ic { background: var(--red-soft); color: var(--red); }
.amb .ic { background: var(--amb-soft); color: var(--amb-ink); }
.th {
  width: 48px;
  height: 48px;
  border-radius: 7px;
  overflow: hidden;
  flex: none;
  background: var(--soft);
  border: 1px solid var(--line);
}
.th.ph { display: flex; align-items: center; justify-content: center; color: var(--mute); }
.th.ph svg { width: 22px; height: 22px; }
.th img { width: 100%; height: 100%; object-fit: cover; }
.mid { flex: 1; min-width: 0; }
.line { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; }
h3 { font-size: 14.5px; line-height: 1.35; font-weight: 680; }
.mid p { color: var(--mute); font-size: 12.5px; margin-top: 3px; line-height: 1.45; }
.meta { color: var(--ink2); font-weight: 500; }
.act { display: flex; gap: 8px; flex: none; }
.dis { opacity: .6; }
.li { width: 14px; height: 14px; }
</style>
