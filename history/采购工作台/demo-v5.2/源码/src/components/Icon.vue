<template>
  <svg
    class="ic"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'today'">
      <rect x="3" y="4" width="18" height="18" rx="3" />
      <path d="M16 2v4M8 2v4M3 10h18M9 15l2 2 4-4" />
    </template>
    <template v-else-if="name === 'grid'">
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </template>
    <template v-else-if="name === 'chat'">
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.7 8.7 0 0 1-4-.9L3 20l1.2-4.4A8.4 8.4 0 1 1 21 11.5Z" />
    </template>
    <template v-else-if="name === 'ledger'">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M3 10h18M8 15h3M15 15h2" />
    </template>
    <template v-else-if="name === 'spark'">
      <path d="M12 3l2.2 5.3L20 10.5l-5.8 2.2L12 18l-2.2-5.3L4 10.5l5.8-2.2L12 3Z" />
    </template>
    <template v-else-if="name === 'skill'">
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-6.3 6.3 2.8 2.8 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.8-2.8 2.6-2.6Z" />
    </template>
    <template v-else-if="name === 'learn'">
      <path d="M2 9l10-5 10 5-10 5L2 9Z" />
      <path d="M6 11.5v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5" />
    </template>
    <template v-else-if="name === 'book'">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
    </template>
    <template v-else-if="name === 'order'">
      <path d="M9 4h10a2 2 0 0 1 2 2v14l-3-2-3 2-3-2-3 2V6a2 2 0 0 1 2-2Z" />
      <path d="M9 9h8M9 13h6" />
    </template>
    <template v-else-if="name === 'box'">
      <path d="M21 8l-9-5-9 5v8l9 5 9-5V8Z" />
      <path d="M3.3 7.5L12 12l8.7-4.5M12 12v9" />
    </template>
    <template v-else-if="name === 'back'">
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </template>
    <template v-else-if="name === 'help'">
      <circle cx="12" cy="12" r="9.5" />
      <path d="M9.4 9a2.8 2.8 0 0 1 5.3 1c0 1.8-2.7 2.2-2.7 3.8M12 17.5h.01" />
    </template>
    <template v-else-if="name === 'search'">
      <circle cx="11" cy="11" r="7.5" />
      <path d="M20 20l-3.6-3.6" />
    </template>
    <template v-else-if="name === 'refresh'">
      <path d="M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5" />
    </template>
    <template v-else-if="name === 'lock'">
      <rect x="4" y="11" width="16" height="10" rx="2.5" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </template>
    <template v-else-if="name === 'close'">
      <path d="M18 6L6 18M6 6l12 12" />
    </template>
    <template v-else-if="name === 'play'">
      <polygon points="6,4 20,12 6,20" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'chev'">
      <path d="M9 6l6 6-6 6" />
    </template>
    <template v-else-if="name === 'alert'">
      <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </template>
    <template v-else-if="name === 'check'">
      <path d="M20 6L9 17l-5-5" />
    </template>
    <template v-else-if="name === 'sun'">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M12 5v14M5 12h14" />
    </template>
    <template v-else-if="name === 'star'">
      <polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.7 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2" />
    </template>
    <template v-else>
      <circle cx="12" cy="12" r="8" />
    </template>
  </svg>
</template>

<script setup>
defineProps({
  name: { type: String, default: 'grid' },
  size: { type: [Number, String], default: 20 },
});
</script>

<style scoped>
.ic {
  display: inline-block;
  vertical-align: middle;
  flex: none;
}
</style>
