<template>
  <div class="lock-wrap">
    <div class="lock-row">
      <button
        type="button"
        class="btn"
        :class="kind || 'pri'"
        :disabled="!ok || busy"
        @click="ok && !busy && $emit('go')"
      >
        <Icon v-if="!ok" name="lock" size="15" />
        <slot />
      </button>
      <button v-if="!ok && fixText" type="button" class="btn sm fix-btn" @click="$emit('fix')">
        {{ fixText }} ›
      </button>
    </div>
    <p v-if="!ok && reason" class="why">🔒 灰色的原因：{{ reason }}</p>
    <p v-if="!ok && penalty" class="pen">⚠️ 强行跳过的后果：{{ penalty }}</p>
  </div>
</template>

<script setup>
import Icon from './Icon.vue';

defineProps({
  ok: { type: Boolean, default: true },
  busy: { type: Boolean, default: false },
  kind: { type: String, default: 'pri' },
  reason: { type: String, default: '' },
  penalty: { type: String, default: '' },
  fixText: { type: String, default: '' },
});

defineEmits(['go', 'fix']);
</script>

<style scoped>
.lock-wrap {
  display: grid;
  gap: 6px;
  align-items: start;
}
.lock-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.fix-btn {
  background: var(--acc-soft);
  color: var(--acc);
  border-color: var(--acc);
  font-weight: 700;
}
.why {
  font-size: 13px;
  font-weight: 700;
  color: var(--amb-ink);
  background: var(--amb-soft);
  padding: 6px 11px;
  border-radius: 10px;
  line-height: 1.45;
}
.pen {
  font-size: 12.5px;
  color: var(--mute);
  padding: 0 4px;
  line-height: 1.45;
}
</style>
