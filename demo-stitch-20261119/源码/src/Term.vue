<template><span class="term" role="button" tabindex="0" @click.stop="openTerm(k)" @keydown.enter="openTerm(k)"><slot>{{ k }}</slot></span></template>
<script setup>
import { openTerm } from './ui.js'
defineProps({ k: String })
</script>
<style scoped>.term { border-bottom: 2px dotted var(--acc); cursor: help; color: inherit; } .term:hover { color: var(--acc); }</style>
