<template>
  <div class="lk" :class="{ off: !ok }">
    <button class="btn" :class="kind" :disabled="!ok || busy" @click="$emit('go')">
      <Icon v-if="!ok" name="lock" class="li" /><slot />
    </button>
    <p v-if="!ok && reason" class="why"><b>灰色的原因：</b>{{ reason }}</p>
    <p v-if="penalty" class="pen">{{ penalty }}</p>
  </div>
</template>
<script setup>
import Icon from './Icon.vue'
defineProps({
  ok: { type: Boolean, default: true },
  reason: String,
  penalty: String,
  kind: { type: String, default: 'pri' },
  busy: Boolean
})
defineEmits(['go'])
</script>
<style scoped>
.lk { display: inline-flex; flex-direction: column; gap: 6px; align-items: flex-start; max-width: 520px; }
.li { width: 15px; height: 15px; }
.why {
  font-size: 12.5px;
  color: var(--red-ink);
  background: var(--red-soft);
  border: 1px solid #f4c6c3;
  border-radius: 8px;
  padding: 6px 10px;
  line-height: 1.45;
}
.pen { font-size: 12px; color: var(--mute); line-height: 1.45; }
</style>
