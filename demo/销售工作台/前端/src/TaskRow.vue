<template>
  <div class="tr" :class="t.lvl">
    <span class="ic">{{ LV[t.lvl].icon }}</span>
    <span class="th" :class="{ ph: !t.img }"><img v-if="t.img" :src="t.img" alt="" loading="lazy" /><Icon v-else :name="t.kind === 'order' ? 'order' : 'today'" /></span>
    <div class="mid"><div class="line"><span class="tag" :class="t.lvl === 'red' ? 'red' : 'amb'">{{ t.tag }}</span><h3>{{ t.title }}</h3></div><p>{{ t.desc }}</p></div>
    <div class="act">
      <button class="btn pri sm" :class="{ dis: locked }" @click="$emit('go')"><Icon v-if="locked" name="lock" class="li" />{{ t.kind === 'assigned' ? '看要求' : t.kind === 'link' ? '去审核' : '去处理' }}</button>
    </div>
  </div>
</template>
<script setup>
import Icon from './Icon.vue'
import { LV } from './store.js'
defineProps({ t: Object, locked: Boolean })
defineEmits(['go'])
</script>
<style scoped>
.tr { display: flex; align-items: center; gap: 16px; background: var(--panel); border-radius: 20px; padding: 16px 20px; margin-bottom: 12px; box-shadow: var(--sh); border-left: 8px solid var(--line); }
.tr.red { border-left-color: var(--red); } .tr.amb { border-left-color: var(--amb); } .tr.grn { border-left-color: var(--grn); }
.ic { width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 800; flex: none; }
.red .ic { background: var(--red-soft); color: var(--red); } .amb .ic { background: var(--amb-soft); color: var(--amb-ink); }
.th { width: 76px; height: 76px; border-radius: 16px; overflow: hidden; flex: none; background: var(--soft); } .th.ph { display: flex; align-items: center; justify-content: center; color: var(--mute); } .th.ph svg { width: 30px; height: 30px; }
.th img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mid { flex: 1; min-width: 0; } .line { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; } h3 { font-size: 17px; line-height: 1.35; } .mid p { color: var(--mute); font-size: 13.5px; margin-top: 3px; }
.act { display: flex; gap: 8px; flex: none; } .dis { opacity: .6; } .li { width: 14px; height: 14px; }
</style>
