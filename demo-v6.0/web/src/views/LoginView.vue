<template>
  <div style="min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #0f172a 0%, #134e4a 100%); padding: 24px;">
    <div style="width: 100%; max-width: 920px; display: grid; grid-template-columns: 1.05fr 1fr; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 28px 64px rgba(0,0,0,0.34);">
      <div style="background: #f8fafc; padding: 28px 26px; border-right: 1px solid #e2e8f0;">
        <div class="tag grn" style="margin-bottom: 10px;">v6.0 全栈生产架构正式版 · WAL SQLite</div>
        <h1 style="margin: 0 0 8px; font-size: 22px; color: #0f172a;">泛亚采购工作台 × 闲鱼监控助手</h1>
        <p class="muted" style="font-size: 13px; margin: 0 0 18px;">
          集成闲鱼全域/店铺监控引擎、1+3 专窗、5% 退款/纠纷红标拦截、次日 10 点昨日对账单防漏单、双轨 9 步二次议价与内置原声视频教学。
        </p>

        <div style="font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 8px;">真实岗位测试账号（点选自动填入下方表单，仍走 scrypt + JWT 鉴权）：</div>
        <div style="display: flex; flex-direction: column; gap: 7px;">
          <button
            v-for="u in presetAccounts"
            :key="u.username"
            type="button"
            class="btn"
            style="justify-content: space-between; text-align: left; padding: 8px 11px;"
            @click="fillCredentials(u.username)"
          >
            <span><strong>{{ u.name }}</strong>（<code>{{ u.username }}</code> · {{ u.roleText }}）</span>
            <span class="tag" :class="u.tagClass">{{ u.badge }}</span>
          </button>
        </div>
        <div class="muted" style="margin-top: 10px;">统一初始密码：<code>Panasia@2026</code> · 连续输错 5 次触发 429 锁定 5 分钟</div>
      </div>

      <div style="padding: 34px 30px; display: flex; flex-direction: column; justify-content: center;">
        <h2 style="margin: 0 0 6px; font-size: 19px;">员工账号实名登录</h2>
        <div class="muted" style="margin-bottom: 18px;">严禁无身份代签收或跨岗核销，所有动作入库审计</div>

        <form @submit.prevent="doLogin">
          <div style="margin-bottom: 12px;">
            <label class="field-label">员工账号</label>
            <input v-model="username" class="input" placeholder="如 liming / newbie / zhaocg / chenkj / wangzg" required />
          </div>
          <div style="margin-bottom: 16px;">
            <label class="field-label">登录密码</label>
            <input v-model="password" type="password" class="input" placeholder="输入密码" required />
          </div>
          <div v-if="errMsg" class="banner red" style="margin-bottom: 12px; font-size: 12px;">{{ errMsg }}</div>
          <button type="submit" class="btn btn-primary" style="width: 100%; padding: 10px;" :disabled="loading">
            {{ loading ? '正在验证 scrypt 签名…' : '🔐 安全登录进入工作台' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { loginWithPassword, pushToast } from '../store/store.js';

const router = useRouter();
const username = ref('liming');
const password = ref('Panasia@2026');
const loading = ref(false);
const errMsg = ref('');

const presetAccounts = [
  { username: 'liming', name: '李明', roleText: '采购员', badge: '已通关 3/3', tagClass: 'grn' },
  { username: 'newbie', name: '陈小新', roleText: '新采购员', badge: '0/3 锁定保护', tagClass: 'red' },
  { username: 'zhaocg', name: '赵仓管', roleText: '仓管验收', badge: '10m 验机权', tagClass: 'blue' },
  { username: 'chenkj', name: '陈会计', roleText: '财务核销', badge: 'T+1 审批/签收', tagClass: 'amb' },
  { username: 'wangzg', name: '王主管', roleText: '全权主管', badge: 'ADMIN 特批', tagClass: 'slate' },
];

function fillCredentials(u) {
  username.value = u;
  password.value = 'Panasia@2026';
  errMsg.value = '';
}

async function doLogin() {
  errMsg.value = '';
  loading.value = true;
  try {
    const staff = await loginWithPassword(username.value, password.value);
    pushToast(`欢迎回来，${staff.name}（${staff.role_label}）`, 'info');
    router.push('/');
  } catch (err) {
    errMsg.value = err?.message || '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>
