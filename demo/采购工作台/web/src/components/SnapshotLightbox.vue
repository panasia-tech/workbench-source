<template>
  <div v-if="store.lightbox.open" class="modal-backdrop" @click.self="store.lightbox.open = false">
    <div class="modal-box" style="max-width: 820px;">
      <div class="card-header">
        <div>
          <h3 class="card-title">📸 不可篡改多图快照留证：{{" "}}{{ store.lightbox.title }}</h3>
          <div class="muted">{{ store.lightbox.meta }}</div>
        </div>
        <button class="btn btn-sm" @click="store.lightbox.open = false">✕ 关闭</button>
      </div>
      <div class="grid grid-2" style="gap: 12px;">
        <div v-for="(img, idx) in store.lightbox.images" :key="idx" style="border: 1px solid var(--border); border-radius: 8px; padding: 8px; background: #f8fafc;">
          <img :src="img" :alt="'证据图 ' + (idx + 1)" style="width: 100%; max-height: 300px; object-fit: contain; border-radius: 6px;" />
          <div class="muted" style="margin-top: 4px; text-align: center;">快照存证图 #{{ idx + 1 }}（{{ img }}）</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { store } from '../store/store.js';
</script>
