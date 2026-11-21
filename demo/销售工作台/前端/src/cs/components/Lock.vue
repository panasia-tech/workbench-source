<template>
  <div class="lock-box">
    <div class="lock-actions">
      <button
        type="button"
        class="btn"
        :class="[kind || 'pri', block ? 'block' : '']"
        :disabled="!ok || busy"
        @click="ok && !busy && $emit('go')"
      >
        <Icon v-if="!ok" name="lock" size="15" />
        <slot />
      </button>
      <button v-if="!ok && fixText" type="button" class="btn sm soft-acc" @click="$emit('fix')">
        {{ fixText }} ›
      </button>
    </div>
    <div v-if="!ok && reason" class="lock-why">
      <b>🔒 锁定原因：</b>{{ reason }}
      <div v-if="penalty" class="lock-pen">⚠️ 防呆说明：{{ penalty }}</div>
    </div>
  </div>
</template>

<script setup>
import Icon from './Icon.vue';

defineProps({
  ok: { type: Boolean, default: true },
  busy: { type: Boolean, default: false },
  kind: { type: String, default: 'pri' },
  block: { type: Boolean, default: false },
  reason: { type: String, default: '' },
  penalty: { type: String, default: '' },
  fixText: { type: String, default: '' },
});

defineEmits(['go', 'fix']);
</script>

<style scoped>
.lock-box {
  display: grid;
  gap: 6px;
}
.lock-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.lock-why {
  font-size: 12px;
  line-height: 1.45;
  padding: 7px 10px;
  border-radius: 9px;
  background: var(--amb-soft);
  color: var(--amb-ink);
  border: 1px solid rgba(217, 119, 6, 0.25);
}
.lock-pen {
  margin-top: 3px;
  opacity: 0.9;
}
</style>
