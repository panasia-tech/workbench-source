<template><button class="q" :title="tip || '这里的名词解释、步骤、防呆、视频、制度（跳 Wiki）'" aria-label="这里怎么用" @click.stop="openHelp(k)">?</button></template>
<script setup>
import { openHelp } from './ui.js'
defineProps({ k: String, tip: String })
</script>
<style scoped>
.q { flex: none; width: 20px; height: 20px; margin-left: 6px; border-radius: 50%; background: var(--acc-soft); color: var(--acc); font-weight: 800; font-size: 12px; line-height: 1; vertical-align: middle; display: inline-flex; align-items: center; justify-content: center; cursor: help; }
.q:hover { background: var(--acc); color: #fff; }
</style>
