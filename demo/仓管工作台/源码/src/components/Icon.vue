<template>
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="name === 'grid'"><rect x="3.5" y="3.5" width="7" height="7" rx="2" /><rect x="13.5" y="3.5" width="7" height="7" rx="2" /><rect x="3.5" y="13.5" width="7" height="7" rx="2" /><rect x="13.5" y="13.5" width="7" height="7" rx="2" /></template>
    <template v-else-if="name === 'today'"><rect x="4" y="5" width="16" height="15" rx="3" /><path d="M8 3v4M16 3v4M4 10h16M8 14.5l2.5 2.5L16 13" /></template>
    <template v-else-if="name === 'box'"><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5 12 12l8-4.5M12 12v9" /></template>
    <template v-else-if="name === 'scan'"><path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2" /><path d="M7 12h10M9 8v8M15 9v6" /></template>
    <template v-else-if="name === 'camera'"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h2l1.4-2h4.2l1.4 2h2A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z" /><circle cx="12" cy="12.5" r="3.3" /></template>
    <template v-else-if="name === 'alert'"><path d="M12 3.5 21 19a1 1 0 0 1-.87 1.5H3.87A1 1 0 0 1 3 19z" /><path d="M12 9v4.5M12 16.8h.01" /></template>
    <template v-else-if="name === 'truck'"><rect x="2.5" y="6" width="11.5" height="9.5" rx="1.5" /><path d="M14 9h4l3 3.2v3.3h-7z" /><circle cx="7" cy="17.5" r="2" /><circle cx="17.5" cy="17.5" r="2" /></template>
    <template v-else-if="name === 'layers'"><path d="m12 3 9 4.5-9 4.5-9-4.5z" /><path d="m3 12 9 4.5 9-4.5M3 16.5 12 21l9-4.5" /></template>
    <template v-else-if="name === 'ledger'"><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></template>
    <template v-else-if="name === 'skill'"><rect x="4" y="4" width="7" height="7" rx="2" /><rect x="13" y="4" width="7" height="7" rx="2" /><rect x="4" y="13" width="7" height="7" rx="2" /><path d="M16.5 13v7M13 16.5h7" /></template>
    <template v-else-if="name === 'book'"><path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" /><path d="M5 17a3 3 0 0 1 3-3h10" /></template>
    <template v-else-if="name === 'learn'"><path d="M3 8.5 12 4l9 4.5-9 4.5z" /><path d="M7 11v5c0 1.5 2.2 3 5 3s5-1.5 5-3v-5" /></template>
    <template v-else-if="name === 'people'"><circle cx="9" cy="8" r="3.2" /><path d="M3 19a6 6 0 0 1 12 0M16 5.5a3 3 0 0 1 0 5.6M18 19a5 5 0 0 0-3-4.6" /></template>
    <template v-else-if="name === 'back'"><path d="M15 5l-7 7 7 7" /></template>
    <template v-else-if="name === 'search'"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4-4" /></template>
    <template v-else-if="name === 'lock'"><rect x="5" y="11" width="14" height="9" rx="2.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></template>
    <template v-else-if="name === 'help'"><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4M12 17h.01" /></template>
    <template v-else-if="name === 'play'"><circle cx="12" cy="12" r="9" /><path d="m10 8.5 5 3.5-5 3.5z" /></template>
    <template v-else-if="name === 'close'"><path d="M6 6l12 12M18 6 6 18" /></template>
    <template v-else-if="name === 'refresh'"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></template>
    <template v-else-if="name === 'download'"><path d="M12 4v11M7.5 11.5 12 16l4.5-4.5M4 19h16" /></template>
    <template v-else-if="name === 'check'"><path d="M5 12.5l4.5 4.5L19 7.5" /></template>
    <template v-else-if="name === 'inbox'"><path d="M4 5h16l2 8v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5z" /><path d="M2 13h6l1.5 2.5h5L16 13h6" /></template>
    <template v-else-if="name === 'merge'"><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="12" r="2.2" /><path d="M8.2 6h3.3a3 3 0 0 1 3 3v0a3 3 0 0 0 1.3 2.5M8.2 18h3.3a3 3 0 0 0 3-3v0" /></template>
    <template v-else-if="name === 'pin'"><path d="M4 5h16v14H4z" /><path d="M4 10h16M4 14.5h16M9.5 5v14M15 5v14" /></template>
    <template v-else-if="name === 'printer'"><path d="M7 8V4h10v4" /><rect x="4" y="8" width="16" height="8" rx="2" /><path d="M7 13h10v7H7z" /></template>
    <template v-else-if="name === 'transfer'"><path d="M4 8h13l-3-3M20 16H7l3 3" /></template>
    <template v-else-if="name === 'inbound'"><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /><path d="M12 3v12M7.5 10.5 12 15l4.5-4.5" /></template>
    <template v-else-if="name === 'pda'"><rect x="6" y="2.5" width="12" height="19" rx="2.5" /><path d="M9 6.5h6M9.5 17.5h5" /></template>
    <template v-else-if="name === 'spark'"><path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 16v4M17 18h4" /></template>
    <template v-else-if="name === 'flow'"><rect x="3" y="4" width="6" height="5" rx="1.5" /><rect x="15" y="4" width="6" height="5" rx="1.5" /><rect x="9" y="15" width="6" height="5" rx="1.5" /><path d="M9 6.5h6M12 9v6" /></template>
    <template v-else-if="name === 'chat'"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.8 8.8 0 0 1-3.8-.8L3 20.5l1.5-4.7A8.3 8.3 0 0 1 3 11.5a8.5 8.5 0 0 1 9-8.4 8.5 8.5 0 0 1 9 8.4z" /><path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" /></template>
    <template v-else-if="name === 'battery'"><rect x="2.5" y="7" width="16.5" height="10" rx="2" /><path d="M21.5 10.5v3M11.5 9.5l-2 2.5h3l-2 2.5" /></template>
    <template v-else-if="name === 'shield'"><path d="M12 3 19 6v5.5c0 4.5-3 7.8-7 9.5-4-1.7-7-5-7-9.5V6z" /><path d="m9 12 2 2 4-4" /></template>
    <template v-else-if="name === 'chart'"><path d="M4 19.5h16M7 16v-5M12 16V7M17 16v-8" /></template>
    <template v-else><circle cx="12" cy="12" r="8" /></template>
  </svg>
</template>
<script setup>
defineProps({ name: String })
</script>
