<template>
  <div v-if="store.helpDrawerOpen" class="drawer-backdrop" @click.self="store.helpDrawerOpen = false">
    <div class="drawer-box">
      <div class="card-header">
        <div>
          <h3 class="card-title">❓ 本页防呆与红线指南</h3>
          <div class="muted">{{ helpInfo.title }}</div>
        </div>
        <button class="btn btn-sm" @click="store.helpDrawerOpen = false">✕</button>
      </div>

      <div class="banner amb" style="margin-top: 6px;">
        <div>
          <strong>当前页必守红线</strong>
          <ul style="margin: 6px 0 0 16px; padding: 0; font-size: 12px;">
            <li v-for="(b, idx) in helpInfo.bullets" :key="idx" style="margin-bottom: 5px;">{{ b }}</li>
          </ul>
        </div>
      </div>

      <div style="margin: 14px 0;">
        <button class="btn btn-primary" style="width: 100%;" @click="openFullTutorialCenter">
          🎓 打开内置视频教程与 3 关防踩坑考试
        </button>
      </div>

      <h4 style="font-size: 13px; margin: 14px 0 8px;">📋 全链路 16 条硬防呆清单（全栈后端 400/403/409/422 真实兜底）</h4>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        <div
          v-for="(rule, i) in FOOLPROOF_16_RULES"
          :key="i"
          style="font-size: 12px; padding: 7px 9px; background: #f8fafc; border: 1px solid var(--border); border-radius: 6px;"
        >
          {{ rule }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { store } from '../store/store.js';
import { PAGE_HELPS, FOOLPROOF_16_RULES } from '../data/tutorials.js';

const router = useRouter();
const helpInfo = computed(() => PAGE_HELPS[store.helpPageKey] || PAGE_HELPS.home);

function openFullTutorialCenter() {
  store.helpDrawerOpen = false;
  router.push('/tutorials');
}
</script>
