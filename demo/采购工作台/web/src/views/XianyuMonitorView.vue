<template>
  <div v-if="ov">
    <div class="banner blue" style="margin-bottom: 12px;">
      <div>
        <strong>🛒 闲鱼多维商品监控融合中心（复用 sxjk-item-filter 过滤链 · areas.json · 钉钉加签）</strong>
        <div class="muted" style="color: #1e3a8a;">
          与泛亚《四维行情表》、5% 防红标号池、黑名单、422 违禁词扫描和一键 10 图锁单完全打通。
        </div>
      </div>
      <div style="display: flex; gap: 8px;">
        <button class="btn btn-sm" @click="openVideoTutorial('ch2', 20.54)">▶ 监控防呆视频教学</button>
        <button class="btn btn-sm btn-primary" @click="loadOverview">🔄 刷新监控数据</button>
      </div>
    </div>

    <div class="tabs" data-tour="mon-tabs">
      <button class="tab-btn" :class="{ active: activeTab === 'hits' }" @click="activeTab = 'hits'">
        🎯 实时命中捡漏池 ({{ ov.hits.length }})
      </button>
      <button class="tab-btn" :class="{ active: activeTab === 'listen' }" @click="activeTab = 'listen'">
        🔍 全域关键词监听 ({{ ov.listen_tasks.length }})
      </button>
      <button class="tab-btn" :class="{ active: activeTab === 'shop' }" @click="activeTab = 'shop'">
        🏪 店铺上新监控 ({{ ov.shop_tasks.length }})
      </button>
      <button class="tab-btn" :class="{ active: activeTab === 'config' }" @click="activeTab = 'config'">
        ⚙ 基础配置（钉钉加签测试 / 话术 / 黑名单 / 日志）
      </button>
    </div>

    <!-- TAB 1: 实时命中商品池 -->
    <div v-if="activeTab === 'hits'" class="grid grid-2">
      <div
        v-for="(hit, idx) in ov.hits"
        :key="hit.hit_id"
        class="card"
        :data-tour="idx === 0 ? 'mon-hit-warning' : undefined"
        :style="hit.suspect_quality_flag ? 'border-color: #f59e0b; border-width: 2px;' : ''"
      >
        <div style="display: flex; gap: 14px;">
          <img
            :src="hit.pic_url"
            alt="宝贝实拍"
            style="width: 112px; height: 112px; object-fit: cover; border-radius: 10px; border: 1px solid var(--border); cursor: pointer; flex-shrink: 0;"
            @click="openLightbox(hit.title, hit.images, `监控命中 ${hit.hit_id} · 挂价 ¥${hit.price_yuan}`)"
          />
          <div style="flex: 1; min-width: 0;">
            <div style="display: flex; justify-content: space-between; align-items: start; gap: 8px;">
              <strong style="font-size: 14px;">{{ hit.title }}</strong>
              <span class="tag" :class="hit.source_type === 'shop' ? 'blue' : 'slate'">{{ hit.source_task_name }}</span>
            </div>
            <div class="muted" style="margin: 4px 0 6px;">{{ hit.desc_text }}</div>
            <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
              <span style="font-size: 18px; font-weight: 800; color: #dc2626;" class="num">¥{{ hit.price_yuan }}</span>
              <span class="tag grn num" v-if="hit.ref_cents">
                M={{ fmtYuan(hit.ref_cents) }} · 预计买前10%赚 {{ fmtYuan(hit.prebuy_comm_cents) }}
              </span>
              <span class="muted">卖家：{{ hit.seller_nick }} · {{ hit.area_text }}</span>
            </div>
          </div>
        </div>

        <div v-if="hit.prebuy_warning" class="banner amb" style="margin: 10px 0 8px; padding: 8px 10px; font-size: 12px;">
          {{ hit.prebuy_warning }}
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="muted">下单接手账号：</span>
            <select v-model="hitTargetAccount[hit.hit_id]" class="select" style="width: 215px; padding: 4px 8px;">
              <option v-for="a in ov.accounts" :key="a.id" :value="a.id">
                {{ a.account_name }} ({{ a.refund_rate_pct }}% {{ a.risk_level === 'grn' ? '安全✅' : '⚠️逼近5%' }})
              </option>
            </select>
          </div>
          <div style="display: flex; gap: 6px;">
            <router-link v-if="hit.linked_case_id" :to="`/cases/${hit.linked_case_id}`" class="btn btn-sm btn-primary">
              ✓ 已建单 {{ hit.linked_case_id }} →
            </router-link>
            <template v-else>
              <button class="btn btn-sm btn-blue" @click="promoteHit(hit, false)">📸 锁10图快照并转采购单</button>
              <button class="btn btn-sm btn-primary" @click="promoteHit(hit, true)">⚡ 秒拍锁单</button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 2: 全域关键词监听 -->
    <div v-if="activeTab === 'listen'" class="grid grid-2" style="align-items: start;">
      <div class="card" data-tour="mon-create-task">
        <div class="card-header">
          <h3 class="card-title">{{ taskForm.id ? '编辑全域监听任务' : '➕ 新建全域关键词监听（受行情上限 + 5%防红标校验）' }}</h3>
          <button v-if="taskForm.id" class="btn btn-sm" @click="resetTaskForm">新建空白</button>
        </div>

        <div class="grid grid-2" style="gap: 10px;">
          <div>
            <label class="field-label">任务名称</label>
            <input v-model="taskForm.name" class="input" placeholder="如 MacBook M3 捡漏线" />
          </div>
          <div>
            <label class="field-label">关联《四维行情表》SKU（自动约束上限）</label>
            <select v-model="taskForm.pricebook_sku" class="select" @change="onSkuPicked">
              <option value="">-- 不绑 SKU（仅填区间） --</option>
              <option v-for="p in pricebookList" :key="p.sku_code" :value="p.sku_code">
                {{ p.model_name }} (上限 {{ fmtYuan(p.ceiling_cents) }})
              </option>
            </select>
          </div>
        </div>

        <div style="display: flex; gap: 8px; align-items: end; margin-top: 10px;">
          <div style="flex: 1;">
            <label class="field-label">闲鱼主搜索词</label>
            <input v-model="taskForm.search_keyword" class="input" placeholder="如 iPhone 15 Pro 256 / MacBook Pro M3" />
          </div>
          <button class="btn btn-sm btn-blue" type="button" @click="autoGenKeywords">🧠 智能生成包含/排除词</button>
        </div>

        <div style="margin-top: 10px;">
          <label class="field-label">标题必须含任一段包含词（用 | 分隔）</label>
          <input v-model="taskForm.match_sub" class="input" placeholder="国行 | 原色 | 几乎全新" />
        </div>
        <div class="grid grid-2" style="gap: 10px; margin-top: 10px;">
          <div>
            <label class="field-label">标题排除词（优先剔除）</label>
            <input v-model="taskForm.exclude_keywords" class="input" placeholder="坏机 | 维修 | 定金 | 美版" />
          </div>
          <div>
            <label class="field-label">商家昵称排除词</label>
            <input v-model="taskForm.seller_exclude_keywords" class="input" placeholder="回收宝 | 二手批发" />
          </div>
        </div>

        <div class="grid grid-3" style="gap: 10px; margin-top: 10px;">
          <div>
            <label class="field-label">监听最低价 (¥)</label>
            <input v-model.number="taskForm.price_from" type="number" class="input" />
          </div>
          <div>
            <label class="field-label">监听最高价 (¥) <span v-if="selectedPb" class="muted">≤{{ selectedPb.ceiling_cents / 100 }}</span></label>
            <input v-model.number="taskForm.price_to" type="number" class="input" />
          </div>
          <div>
            <label class="field-label">轮询间隔 (秒，单号需≥3)</label>
            <input v-model.number="taskForm.interval_seconds" type="number" class="input" />
          </div>
        </div>

        <div class="grid grid-2" style="gap: 10px; margin-top: 10px;">
          <div>
            <label class="field-label">地区过滤（源自 shared/areas.json）</label>
            <select v-model="selectedProvince" class="select">
              <option value="">全国所有省份</option>
              <option v-for="ar in areas" :key="ar.value" :value="ar.value">{{ ar.label }}</option>
            </select>
          </div>
          <div>
            <label class="field-label">监听执行闲鱼账号</label>
            <select v-model="taskForm.listen_account_ids[0]" class="select">
              <option v-for="a in ov.accounts" :key="a.id" :value="a.id">{{ a.account_name }} ({{ a.refund_rate_pct }}%)</option>
            </select>
          </div>
        </div>

        <div style="margin-top: 10px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: #f8fafc;">
          <label style="display: flex; align-items: center; gap: 8px; font-weight: 600; cursor: pointer;">
            <input type="checkbox" v-model="taskForm.miaopai_enabled" />
            启用条件自动秒拍锁单（5% 防红标护航：高风险禁选接近红标号）
          </label>
          <div v-if="taskForm.miaopai_enabled" class="grid grid-2" style="gap: 8px; margin-top: 8px;">
            <div>
              <label class="field-label">指定秒拍安全账号</label>
              <select v-model="taskForm.miaopai_account_ids[0]" class="select">
                <option v-for="a in ov.accounts" :key="a.id" :value="a.id">
                  {{ a.account_name }} ({{ a.refund_rate_pct }}% {{ a.will_breach_on_next_refund ? '🚫禁选' : '✅安全' }})
                </option>
              </select>
            </div>
            <div>
              <label class="field-label">自动秒拍上限价 (¥)</label>
              <input v-model.number="taskForm.miaopai_price_to" type="number" class="input" />
            </div>
          </div>
        </div>

        <div class="grid grid-2" style="gap: 10px; margin-top: 10px;">
          <div>
            <label class="field-label">推送钉钉群机器人（未测禁绑 409）</label>
            <select v-model="selectedBotId" class="select">
              <option value="">暂不推送钉钉</option>
              <option v-for="b in ov.robots" :key="b.id" :value="b.id">
                {{ b.name }} {{ Number(b.last_test_ok) === 1 ? '✅已测' : '⚠未测' }}
              </option>
            </select>
          </div>
          <div>
            <label class="field-label">命中自动打招呼话术（422 合规模板）</label>
            <select v-model="selectedGreetingId" class="select">
              <option value="">不自动发首句招呼</option>
              <option v-for="g in ov.greetings" :key="g.id" :value="g.id">{{ g.title }}</option>
            </select>
          </div>
        </div>

        <div style="margin-top: 14px; display: flex; justify-content: flex-end; gap: 8px;">
          <button class="btn btn-primary" :disabled="busy" @click="saveListenTask">💾 验证防呆并保存监听任务</button>
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 12px;">
        <div v-for="t in ov.listen_tasks" :key="t.id" class="card">
          <div class="card-header" style="margin-bottom: 6px;">
            <div>
              <strong>{{ t.name }}</strong>
              <span class="tag slate" style="margin-left: 6px;">{{ t.search_keyword }}</span>
              <span class="tag" :class="t.enabled ? 'grn' : 'slate'" style="margin-left: 4px;">{{ t.enabled ? '监听运行中' : '已暂停' }}</span>
            </div>
            <div style="display: flex; gap: 6px;">
              <button class="btn btn-sm btn-primary" :disabled="busy" @click="pollNow(t.id)">⚡ 立即拉取筛选一次</button>
              <button class="btn btn-sm" @click="editTask(t)">编辑</button>
            </div>
          </div>
          <div class="muted">
            SKU：<code>{{ t.pricebook_sku || '未绑' }}</code> · 价格区间：<strong class="num">¥{{ t.price_from ?? 0 }}–¥{{ t.price_to ?? '∞' }}</strong> · 间隔 <strong class="num">{{ t.interval_seconds }}s</strong> · 累计命中 <strong class="num">{{ t.hit_count }}</strong> 条
          </div>
          <div class="muted" style="margin-top: 4px;">
            包含词：<code>{{ t.match_sub }}</code> | 排除词：<code>{{ t.exclude_keywords }}</code>
          </div>
          <div v-if="lastPollReport[t.id]" class="banner grn" style="margin-top: 8px; padding: 8px 10px; font-size: 12px;">
            上次实跑滤网：抓 {{ lastPollReport[t.id].raw_count }} 条 → 全局价拦 {{ lastPollReport[t.id].stats?.removed?.globalPrice || 0 }} → 排除词拦 {{ lastPollReport[t.id].stats?.removed?.excludeTitle || 0 }} → 黑名单拦 {{ lastPollReport[t.id].stats?.removed?.blacklist || 0 }} → 净命中 <strong>{{ lastPollReport[t.id].matched_count }} 条</strong>！
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 3: 店铺上新监听 -->
    <div v-if="activeTab === 'shop'" class="grid grid-2" style="align-items: start;">
      <div class="card">
        <h3 class="card-title" style="margin-bottom: 10px;">➕ 新增店铺上新监控（双向同步收藏卖家 + 黑名单 409 互斥）</h3>
        <div class="grid grid-2" style="gap: 10px;">
          <div>
            <label class="field-label">卖家 ID（试试填 BLK-SELLER-991 测黑名单拦截）</label>
            <input v-model="shopForm.seller_user_id" class="input" placeholder="如 SELLER-GF-015 或 BLK-SELLER-991" />
          </div>
          <div>
            <label class="field-label">卖家昵称</label>
            <input v-model="shopForm.seller_nick" class="input" placeholder="如 苏州工作室老陈" />
          </div>
        </div>
        <div class="grid grid-2" style="gap: 10px; margin-top: 10px;">
          <div>
            <label class="field-label">关联行情参考 SKU</label>
            <select v-model="shopForm.pricebook_sku" class="select">
              <option value="">不限定</option>
              <option v-for="p in pricebookList" :key="p.sku_code" :value="p.sku_code">{{ p.model_name }} (≤{{ fmtYuan(p.ceiling_cents) }})</option>
            </select>
          </div>
          <div>
            <label class="field-label">监控最高预算 (¥)</label>
            <input v-model.number="shopForm.price_to" type="number" class="input" />
          </div>
        </div>
        <div style="margin-top: 12px; display: flex; justify-content: flex-end;">
          <button class="btn btn-primary" :disabled="busy" @click="saveShopTask">💾 保存店铺监听</button>
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 10px;">
        <div v-for="s in ov.shop_tasks" :key="s.id" class="card">
          <div class="card-header" style="margin-bottom: 4px;">
            <strong>🏪 {{ s.seller_nick }} (<code>{{ s.seller_user_id }}</code>)</strong>
            <span class="tag" :class="s.enabled ? 'grn' : 'slate'">{{ s.enabled ? '上新蹲守中' : '已停用' }}</span>
          </div>
          <div class="muted">限定 SKU：<code>{{ s.pricebook_sku || '全部' }}</code> · 上限 ¥{{ s.price_to }} · 绑定号 {{ (s.listen_account_ids || []).join(', ') }}</div>
        </div>
      </div>
    </div>

    <!-- TAB 4: 基础配置（钉钉/话术/黑名单/日志） -->
    <div v-if="activeTab === 'config'" class="grid grid-2" style="align-items: start;">
      <div class="card">
        <h3 class="card-title" style="margin-bottom: 10px;">🤖 钉钉群机器人与 SEC 加签测试（未测试 409 禁绑）</h3>
        <div v-for="b in ov.robots" :key="b.id" style="border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin-bottom: 8px; background: #f8fafc;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <strong>{{ b.name }}</strong>
            <span class="tag" :class="Number(b.last_test_ok) === 1 ? 'grn' : 'red'">
              {{ Number(b.last_test_ok) === 1 ? '✅ 测试通过' : '❌ 待验证' }}
            </span>
          </div>
          <div class="muted" style="margin: 4px 0;">{{ b.last_test_msg }}</div>
          <div style="display: flex; gap: 8px; align-items: center; margin-top: 6px;">
            <input v-model="b.secret" class="input" placeholder="填写 SEC 加签密钥（测试前必填）" style="flex: 1;" />
            <button class="btn btn-sm" @click="saveBotSecret(b)">保存密钥</button>
            <button class="btn btn-sm btn-primary" @click="testBot(b.id)">🧪 发送测试消息</button>
          </div>
        </div>
      </div>

      <div class="card">
        <h3 class="card-title" style="margin-bottom: 10px;">💬 合规打招呼话术库（422 防泄密 / 引流 / 扯皮扫描）</h3>
        <div v-for="g in ov.greetings" :key="g.id" style="padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; font-size: 12px;">
          <strong>{{ g.title }}</strong>
          <div class="muted" style="margin-top: 2px;">{{ g.text_content }}</div>
        </div>
        <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border);">
          <label class="field-label">新增打招呼模板（尝试输入「加微信 / 底价 / 小二介入」测试 422 拦截）</label>
          <input v-model="newGreeting.title" class="input" placeholder="话术标题" style="margin-bottom: 6px;" />
          <textarea v-model="newGreeting.text_content" class="textarea" rows="2" placeholder="输入合规话术正文..."></textarea>
          <button class="btn btn-sm btn-primary" style="margin-top: 6px;" @click="saveGreeting">💾 扫描并保存话术</button>
        </div>
      </div>

      <div class="card">
        <h3 class="card-title" style="margin-bottom: 10px;">🚫 商家黑名单（自动剔除轮询 & 停用店铺监听）</h3>
        <div style="display: flex; gap: 6px; margin-bottom: 10px;">
          <input v-model="newBlacklist.user_id" class="input" placeholder="卖家 ID" />
          <input v-model="newBlacklist.nick" class="input" placeholder="昵称" />
          <input v-model="newBlacklist.reason" class="input" placeholder="拉黑原因" />
          <button class="btn btn-sm btn-danger" @click="addBlacklist">拉黑</button>
        </div>
        <div v-for="bl in ov.blacklist" :key="bl.user_id" style="display: flex; justify-content: space-between; align-items: center; padding: 7px 9px; border-bottom: 1px solid var(--border); font-size: 12px;">
          <div><strong>{{ bl.nick }}</strong> (<code>{{ bl.user_id }}</code>) · <span class="muted">{{ bl.reason }}</span></div>
          <button class="btn btn-sm" @click="removeBlacklist(bl.user_id)">移出</button>
        </div>
      </div>

      <div class="card">
        <h3 class="card-title" style="margin-bottom: 10px;">📜 监控轮询与过滤漏斗审计日志</h3>
        <div class="table-wrap" style="max-height: 260px;">
          <table>
            <thead>
              <tr><th>任务</th><th>原始</th><th>过滤数</th><th>净命中</th><th>执行号</th></tr>
            </thead>
            <tbody>
              <tr v-for="l in ov.logs" :key="l.id">
                <td>{{ l.task_name }}</td>
                <td class="num">{{ l.raw_count }}</td>
                <td class="num">{{ l.filtered_out_count }}</td>
                <td class="num"><strong>{{ l.matched_count }}</strong></td>
                <td>{{ l.account_id }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { apiRequest } from '../api/client.js';
import { pushToast, handleApiError, openLightbox, openVideoTutorial, fmtYuan, refreshGlobalSummary } from '../store/store.js';

const ov = ref(null);
const activeTab = ref('hits');
const busy = ref(false);
const pricebookList = ref([]);
const areas = ref([]);
const hitTargetAccount = reactive({});
const lastPollReport = reactive({});
const selectedProvince = ref('');
const selectedBotId = ref('BOT-01');
const selectedGreetingId = ref(1);

const taskForm = reactive({
  id: '',
  name: '',
  search_keyword: '',
  match_sub: '',
  exclude_keywords: '坏机 | 维修 | 定金 | 租赁',
  seller_exclude_keywords: '官方商城 | 回收宝',
  price_from: 1000,
  price_to: 4750,
  interval_seconds: 15,
  pricebook_sku: 'IP15P-256-NAT',
  listen_account_ids: ['ACC-GF-03'],
  miaopai_enabled: false,
  miaopai_account_ids: ['ACC-GF-03'],
  miaopai_price_to: 4600,
});

const shopForm = reactive({
  seller_user_id: '',
  seller_nick: '',
  pricebook_sku: 'IP15P-256-NAT',
  price_to: 4700,
});

const newGreeting = reactive({ title: '', text_content: '' });
const newBlacklist = reactive({ user_id: '', nick: '', reason: '' });

const selectedPb = computed(() => pricebookList.value.find((p) => p.sku_code === taskForm.pricebook_sku));

function onSkuPicked() {
  if (selectedPb.value) {
    taskForm.price_to = selectedPb.value.ceiling_cents / 100;
    taskForm.price_from = Math.round((selectedPb.value.initial_offer_cents / 100) * 0.85);
    taskForm.miaopai_price_to = selectedPb.value.target_cents / 100;
  }
}

async function autoGenKeywords() {
  try {
    const res = await apiRequest('/api/monitor/generate-keywords', {
      method: 'POST',
      body: { search_keyword: taskForm.search_keyword },
    });
    taskForm.match_sub = res.data.match_sub;
    taskForm.exclude_keywords = res.data.exclude_keywords;
    taskForm.seller_exclude_keywords = res.data.seller_exclude_keywords;
    pushToast('已自动生成包含词与排除词过滤方案', 'info');
  } catch (err) {
    handleApiError(err);
  }
}

function resetTaskForm() {
  taskForm.id = '';
  taskForm.name = '';
  taskForm.search_keyword = '';
  taskForm.match_sub = '';
}

function editTask(t) {
  taskForm.id = t.id;
  taskForm.name = t.name;
  taskForm.search_keyword = t.search_keyword;
  taskForm.match_sub = t.match_sub;
  taskForm.exclude_keywords = t.exclude_keywords;
  taskForm.seller_exclude_keywords = t.seller_exclude_keywords;
  taskForm.price_from = t.price_from;
  taskForm.price_to = t.price_to;
  taskForm.interval_seconds = t.interval_seconds;
  taskForm.pricebook_sku = t.pricebook_sku;
  taskForm.listen_account_ids = t.listen_account_ids?.length ? [...t.listen_account_ids] : ['ACC-GF-03'];
  taskForm.miaopai_enabled = Boolean(t.miaopai_enabled);
  taskForm.miaopai_account_ids = t.miaopai_account_ids?.length ? [...t.miaopai_account_ids] : ['ACC-GF-03'];
  taskForm.miaopai_price_to = t.miaopai_price_to || t.price_to;
  selectedBotId.value = t.dingtalk_robot_ids?.[0] || '';
  selectedGreetingId.value = t.greeting_template_ids?.[0] || '';
}

async function loadOverview() {
  try {
    const [oRes, pbRes, arRes] = await Promise.all([
      apiRequest('/api/monitor/overview'),
      apiRequest('/api/pricebook'),
      apiRequest('/api/monitor/areas'),
    ]);
    ov.value = oRes.data;
    pricebookList.value = pbRes.items || [];
    areas.value = arRes.data || [];
    for (const h of ov.value.hits) {
      if (!hitTargetAccount[h.hit_id]) hitTargetAccount[h.hit_id] = h.account_id || 'ACC-GF-03';
    }
  } catch (err) {
    handleApiError(err);
  }
}

async function saveListenTask() {
  busy.value = true;
  try {
    await apiRequest('/api/monitor/tasks', {
      method: 'POST',
      body: {
        ...taskForm,
        division_options: selectedProvince.value ? [selectedProvince.value] : [],
        dingtalk_robot_ids: selectedBotId.value ? [selectedBotId.value] : [],
        greeting_enabled: Boolean(selectedGreetingId.value),
        greeting_template_ids: selectedGreetingId.value ? [Number(selectedGreetingId.value)] : [],
      },
    });
    pushToast('监控任务防呆校验通过并已保存！', 'info');
    resetTaskForm();
    await loadOverview();
    await refreshGlobalSummary();
  } catch (err) {
    handleApiError(err);
  } finally {
    busy.value = false;
  }
}

async function pollNow(taskId) {
  busy.value = true;
  try {
    const res = await apiRequest(`/api/monitor/tasks/${encodeURIComponent(taskId)}/poll`, { method: 'POST', body: {} });
    lastPollReport[taskId] = res.data;
    pushToast(`轮询完成：新增 ${res.data.created_hits.length} 条净命中单`, 'info');
    await loadOverview();
    await refreshGlobalSummary();
  } catch (err) {
    handleApiError(err);
  } finally {
    busy.value = false;
  }
}

async function promoteHit(hit, lockOrder) {
  busy.value = true;
  try {
    const res = await apiRequest(`/api/monitor/hits/${encodeURIComponent(hit.hit_id)}/promote`, {
      method: 'POST',
      body: { account_id: hitTargetAccount[hit.hit_id], lock_order: lockOrder },
    });
    pushToast(`成功锁图 ${res.data.snapshot_id} 并生成采购单 ${res.data.case.case_id}！`, 'info');
    await loadOverview();
    await refreshGlobalSummary();
  } catch (err) {
    handleApiError(err);
  } finally {
    busy.value = false;
  }
}

async function saveShopTask() {
  busy.value = true;
  try {
    await apiRequest('/api/monitor/shops', { method: 'POST', body: shopForm });
    pushToast('店铺上新监听已保存并同步入收藏卖家池！', 'info');
    shopForm.seller_user_id = '';
    shopForm.seller_nick = '';
    await loadOverview();
  } catch (err) {
    handleApiError(err);
  } finally {
    busy.value = false;
  }
}

async function saveBotSecret(b) {
  try {
    await apiRequest('/api/monitor/robots', { method: 'POST', body: b });
    pushToast('机器人密钥已保存，请点击发送测试消息', 'info');
    await loadOverview();
  } catch (err) {
    handleApiError(err);
  }
}

async function testBot(id) {
  try {
    await apiRequest(`/api/monitor/robots/${encodeURIComponent(id)}/test`, { method: 'POST', body: {} });
    pushToast('钉钉加签测试通过！现在允许将该机器人绑定监控任务', 'info');
    await loadOverview();
  } catch (err) {
    handleApiError(err);
  }
}

async function saveGreeting() {
  try {
    await apiRequest('/api/monitor/greetings', { method: 'POST', body: newGreeting });
    pushToast('合规话术已通过 422 扫描并保存', 'info');
    newGreeting.title = '';
    newGreeting.text_content = '';
    await loadOverview();
  } catch (err) {
    handleApiError(err);
  }
}

async function addBlacklist() {
  try {
    await apiRequest('/api/sellers/blacklist', { method: 'POST', body: newBlacklist });
    pushToast('已加入黑名单，同卖家店铺监控已自动停用', 'warn');
    newBlacklist.user_id = '';
    newBlacklist.nick = '';
    newBlacklist.reason = '';
    await loadOverview();
  } catch (err) {
    handleApiError(err);
  }
}

async function removeBlacklist(uid) {
  try {
    await apiRequest(`/api/sellers/blacklist/${encodeURIComponent(uid)}`, { method: 'DELETE' });
    await loadOverview();
  } catch (err) {
    handleApiError(err);
  }
}

onMounted(loadOverview);
</script>
