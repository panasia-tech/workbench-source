<template>
  <div class="grid grid-2" style="align-items: start;">
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">⭐ 收藏优质卖家池（双向联动店铺上新监听）</h3>
      </div>

      <div style="border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin-bottom: 12px; background: #f8fafc;">
        <div class="grid grid-2" style="gap: 8px;">
          <input v-model="form.seller_id" class="input" placeholder="卖家 ID（可选，自动生成）" />
          <input v-model="form.seller_nick" class="input" placeholder="卖家昵称（必填）" />
          <input v-model="form.category_focus" class="input" placeholder="主营品类（如 Sony相机/苹果）" />
          <select v-model="form.visibility_scope" class="select">
            <option value="personal">个人私藏</option>
            <option value="team">团队共享优质卖家</option>
          </select>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px;">
          <label style="display: flex; gap: 6px; font-size: 12px;">
            <input type="checkbox" v-model="form.enable_shop_monitor" /> 自动开启闲鱼监控店铺上新盯梢
          </label>
          <button class="btn btn-sm btn-primary" @click="saveFavorite">保存并同步</button>
        </div>
      </div>

      <div v-for="s in data.favorites" :key="s.seller_id" style="border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin-bottom: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong>{{ s.seller_nick }} (<code>{{ s.seller_id }}</code>)</strong>
          <div style="display: flex; gap: 6px;">
            <span class="tag" :class="s.visibility_scope === 'team' ? 'blue' : 'slate'">{{ s.visibility_scope === 'team' ? '团队共享' : '个人私藏' }}</span>
            <span v-if="s.shop_monitor_id" class="tag grn">🏪 店铺监控 {{ s.shop_monitor_id }}</span>
          </div>
        </div>
        <div class="muted" style="margin-top: 4px;">主营：{{ s.category_focus }} · 累计合作 {{ s.total_deals }} 单 · {{ s.notes }}</div>
      </div>
    </div>

    <div class="card">
      <h3 class="card-title" style="margin-bottom: 10px;">🚫 卖家黑名单（与店铺监控 409 互斥，自动剔除所有轮询）</h3>
      <div v-for="b in data.blacklist" :key="b.user_id" style="border: 1px solid #fecaca; background: #fef2f2; border-radius: 8px; padding: 10px; margin-bottom: 8px;">
        <div style="display: flex; justify-content: space-between;">
          <strong>{{ b.nick }} (<code>{{ b.user_id }}</code>)</strong>
          <button class="btn btn-sm" @click="removeBl(b.user_id)">移出黑名单</button>
        </div>
        <div class="muted" style="color: #991b1b; margin-top: 3px;">拉黑理由：{{ b.reason }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { apiRequest } from '../api/client.js';
import { handleApiError, pushToast } from '../store/store.js';

const data = ref({ favorites: [], blacklist: [] });
const form = reactive({
  seller_id: '',
  seller_nick: '',
  category_focus: '',
  visibility_scope: 'team',
  enable_shop_monitor: true,
});

async function load() {
  try {
    const res = await apiRequest('/api/sellers');
    data.value = res.data;
  } catch (err) {
    handleApiError(err);
  }
}

async function saveFavorite() {
  try {
    const res = await apiRequest('/api/sellers/favorites', { method: 'POST', body: form });
    data.value = res.data;
    form.seller_id = '';
    form.seller_nick = '';
    pushToast('卖家池已更新并同步监控配置！', 'info');
  } catch (err) {
    handleApiError(err);
  }
}

async function removeBl(uid) {
  try {
    const res = await apiRequest(`/api/sellers/blacklist/${encodeURIComponent(uid)}`, { method: 'DELETE' });
    data.value = res.data;
  } catch (err) {
    handleApiError(err);
  }
}

onMounted(load);
</script>
