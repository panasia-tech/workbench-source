<template>
  <div>
    <div class="grid grid-2" style="align-items: start; margin-bottom: 14px;">
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">📏 泛亚《四维行情参考表》（监听 / 秒拍 / 采购出价唯一法定天花板）</h3>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>SKU / 机型</th>
                <th>版本/成色线</th>
                <th>市场参考 M</th>
                <th>首探出价</th>
                <th>目标成交</th>
                <th>绝不可破上限 C</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in items" :key="p.id">
                <td>
                  <strong>{{ p.model_name }}</strong>
                  <div class="muted num">{{ p.sku_code }}</div>
                </td>
                <td><span class="tag slate">v{{ p.version_no }}</span> <span class="muted">{{ p.condition_grade }}</span></td>
                <td class="num"><strong>{{ fmtYuan(p.ref_cents) }}</strong></td>
                <td class="num" style="color: #0f766e;">{{ fmtYuan(p.initial_offer_cents) }}</td>
                <td class="num" style="color: #1d4ed8;">{{ fmtYuan(p.target_cents) }}</td>
                <td class="num" style="color: #dc2626;"><strong>{{ fmtYuan(p.ceiling_cents) }}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h3 class="card-title" style="margin-bottom: 10px;">🔧 P3 / P4 到货瑕疵拆项折损速查表（二次议价铁证锚点）</h3>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px;">
          <div v-for="(r, i) in P3_P4_CHEATSHEET" :key="i" style="border: 1px solid var(--border); border-radius: 8px; padding: 9px 11px; background: #f8fafc;">
            <div style="display: flex; justify-content: space-between;">
              <strong>{{ r.defect }}</strong>
              <span class="tag red num">锚定减 {{ r.anchor }}</span>
            </div>
            <div class="muted" style="margin-top: 2px;">{{ r.note }}</div>
          </div>
        </div>

        <div style="border-top: 1px solid var(--border); padding-top: 12px;">
          <strong style="font-size: 13px;">发布/调价新版本行情（仅 ADMIN 主管或 FINANCE 会计有权 403）</strong>
          <div class="grid grid-2" style="gap: 8px; margin-top: 8px;">
            <input v-model="pbForm.sku_code" class="input" placeholder="SKU 编码" />
            <input v-model="pbForm.model_name" class="input" placeholder="机型名称" />
            <input v-model.number="pbForm.ref_yuan" type="number" class="input" placeholder="市场参考价 M ¥" />
            <input v-model.number="pbForm.target_yuan" type="number" class="input" placeholder="目标价 ¥" />
            <input v-model.number="pbForm.ceiling_yuan" type="number" class="input" placeholder="最高上限 C ¥" />
            <button class="btn btn-primary" @click="publishPb">发布新版本行情</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { apiRequest } from '../api/client.js';
import { fmtYuan, handleApiError, pushToast } from '../store/store.js';
import { P3_P4_CHEATSHEET } from '../data/tutorials.js';

const items = ref([]);
const pbForm = reactive({
  sku_code: 'IP15P-256-NAT',
  model_name: 'iPhone 15 Pro 256G 国行原色',
  ref_yuan: 5050,
  target_yuan: 4600,
  ceiling_yuan: 4750,
});

async function load() {
  try {
    const res = await apiRequest('/api/pricebook');
    items.value = res.items || [];
  } catch (err) {
    handleApiError(err);
  }
}

async function publishPb() {
  try {
    const res = await apiRequest('/api/pricebook', { method: 'POST', body: pbForm });
    items.value = res.items || [];
    pushToast('新版《四维行情参考表》发布成功，同步约束所有监控与采购单！', 'info');
  } catch (err) {
    handleApiError(err);
  }
}

onMounted(load);
</script>
