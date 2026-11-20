<template>
  <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="name === 'grid'"><rect x="3.5" y="3.5" width="7" height="7" rx="2" /><rect x="13.5" y="3.5" width="7" height="7" rx="2" /><rect x="3.5" y="13.5" width="7" height="7" rx="2" /><rect x="13.5" y="13.5" width="7" height="7" rx="2" /></template>
    <template v-else-if="name === 'box'"><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5 12 12l8-4.5M12 12v9" /></template>
    <template v-else-if="name === 'ticket'"><path d="M4 8a2 2 0 0 0 0 4v0a2 2 0 0 1 0 4v1.5A1.5 1.5 0 0 0 5.5 19h13a1.5 1.5 0 0 0 1.5-1.5V16a2 2 0 0 1 0-4v0a2 2 0 0 0 0-4V6.5A1.5 1.5 0 0 0 18.5 5h-13A1.5 1.5 0 0 0 4 6.5z" /><path d="M14 5v2.5M14 10.5v3M14 16.5V19" /></template>
    <template v-else-if="name === 'spark'"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></template>
    <template v-else-if="name === 'chat'"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V16A2.5 2.5 0 0 1 4 13.5z" /><path d="M8 9h8M8 12h5" /></template>
    <template v-else-if="name === 'assist'"><circle cx="9" cy="8.5" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0M17 8.5v5M14.5 11h5" /></template>
    <template v-else-if="name === 'pick'"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.5" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></template>
    <template v-else-if="name === 'ledger'"><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></template>
    <template v-else-if="name === 'people'"><circle cx="9" cy="8" r="3.2" /><path d="M3 19a6 6 0 0 1 12 0M16 5.5a3 3 0 0 1 0 5.6M18 19a5 5 0 0 0-3-4.6" /></template>
    <template v-else-if="name === 'back'"><path d="M15 5l-7 7 7 7" /></template>
    <template v-else-if="name === 'search'"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4-4" /></template>
    <template v-else-if="name === 'lock'"><rect x="5" y="11" width="14" height="9" rx="2.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></template>
    <template v-else-if="name === 'help'"><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4M12 17h.01" /></template>
    <template v-else-if="name === 'play'"><circle cx="12" cy="12" r="9" /><path d="m10 8.5 5 3.5-5 3.5z" /></template>
    <template v-else-if="name === 'today'"><rect x="4" y="5" width="16" height="15" rx="3" /><path d="M8 3v4M16 3v4M4 10h16M8 14.5l2.5 2.5L16 13" /></template>
    <template v-else-if="name === 'order'"><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></template>
    <template v-else-if="name === 'skill'"><rect x="4" y="4" width="7" height="7" rx="2" /><rect x="13" y="4" width="7" height="7" rx="2" /><rect x="4" y="13" width="7" height="7" rx="2" /><path d="M16.5 13v7M13 16.5h7" /></template>
    <template v-else-if="name === 'book'"><path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" /><path d="M5 17a3 3 0 0 1 3-3h10" /></template>
    <template v-else-if="name === 'learn'"><path d="M3 8.5 12 4l9 4.5-9 4.5z" /><path d="M7 11v5c0 1.5 2.2 3 5 3s5-1.5 5-3v-5" /></template>
    <template v-else-if="name === 'me'"><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" /></template>
    <template v-else-if="name === 'close'"><path d="M6 6l12 12M18 6 6 18" /></template>
    <template v-else-if="name === 'refresh'"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></template>
  </svg>
</template>
<script setup>
defineProps({ name: String })
</script>
