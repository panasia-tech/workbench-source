<template>
  <div class="lg">
    <form class="card" @submit.prevent="go">
      <div class="brand">泛</div>
      <h1>登录</h1>
      <p class="muted">{{ REAL ? '用 ERP 账号登录，查看真实数据。' : '本机演示账号登录。' }}</p>
      <label>账号<input v-model.trim="u" autocomplete="username" autofocus /></label>
      <label>密码<input v-model="p" type="password" autocomplete="current-password" /></label>
      <p v-if="err" class="err">{{ err }}</p>
      <button class="btn pri" :disabled="busy || !u || !p">{{ busy ? '登录中…' : '登录' }}</button>
    </form>
  </div>
</template>
<script setup>
import { ref } from 'vue'
import { REAL } from './api.js'
const u = ref(''), p = ref(''), err = ref(''), busy = ref(false)
async function go() {
  busy.value = true; err.value = ''
  try {
    const r = await fetch('/api/auth/h5-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u.value, password: p.value }) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok || !d.token) throw new Error(typeof d.detail === 'string' ? d.detail : `登录失败（HTTP ${r.status}）`)
    localStorage.setItem('erp_token', d.token); localStorage.setItem('erp_user', u.value); localStorage.setItem('erp_staff', JSON.stringify(d.staff || {}))
    sessionStorage.removeItem('relogin')
    location.reload()
  } catch (e) { err.value = e.message || '登录失败'; busy.value = false }
}
</script>
<style scoped>
.lg { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
.card { width: min(380px, 100%); display: grid; gap: 14px; }
.brand { width: 52px; height: 52px; border-radius: 17px; background: var(--acc); color: #fff; font-weight: 800; font-size: 26px; display: flex; align-items: center; justify-content: center; }
h1 { margin: 0; font-size: 28px; } label { display: grid; gap: 6px; font-size: 14px; color: var(--ink2); }
input { padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line); background: var(--soft); color: var(--ink); font-size: 16px; }
.err { color: var(--red-ink); background: var(--red-soft); padding: 8px 12px; border-radius: 10px; margin: 0; font-size: 14px; }
.btn.pri { padding: 12px; font-size: 16px; }
</style>
