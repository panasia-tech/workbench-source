<template>
  <!-- 1. 【场景自动发图设置】弹窗（配置什么场景自动发什么图片卡片） -->
  <div
    v-if="store.ui.autoRuleModalOpen"
    class="modal-mask"
    @click.self="store.ui.autoRuleModalOpen = false"
  >
    <div class="modal-card" style="width: 780px">
      <header class="mc-head">
        <div>
          <h3>🖼 场景自动发图设置（不同场景自动发出对应引导图片）</h3>
          <p class="sub">开启后无需外包客服手动记，系统遇到对应节点会自动把卡片图发进聊天框</p>
        </div>
        <button type="button" class="btn sm" @click="store.ui.autoRuleModalOpen = false">✕ 关闭</button>
      </header>

      <div class="mc-body">
        <div class="rule-list">
          <div v-for="r in store.data.autoRules" :key="r.id" class="rule-item">
            <img
              :src="r.imageUrl"
              :alt="r.sceneName"
              class="rule-thumb"
              title="点击放大查看高清原图"
              @click="openPreview(r.imageUrl, r.sceneName)"
            />
            <div class="rule-info">
              <div style="display: flex; align-items: center; gap: 8px">
                <b>{{ r.sceneName }}</b>
                <span v-if="r.replyKeyword" class="kw-pill">买家回“{{ r.replyKeyword }}”自动激活</span>
              </div>
              <div class="r-desc">触发时机：{{ r.triggerDesc }}</div>
              <input
                v-model="r.accompanyText"
                type="text"
                class="r-input"
                placeholder="伴随图片一起发出的提示话术..."
              />
            </div>
            <div class="rule-ops">
              <label class="switch-lbl">
                <input v-model="r.enabled" type="checkbox" />
                <span>{{ r.enabled ? '自动触发中' : '已关闭' }}</span>
              </label>
              <button type="button" class="btn sm soft" @click="sendNowToCurrentChat(r.id)">
                发到当前聊天试试
              </button>
            </div>
          </div>
        </div>

        <!-- 快速新增一条场景发图 -->
        <div class="add-rule-box">
          <div style="font-weight: 700; font-size: 13px; margin-bottom: 8px">
            + 新增一条场景自动发图（可上传本地图片）
          </div>
          <div class="add-grid">
            <input v-model="newScene" type="text" placeholder="场景名称（如：买家问顺丰包邮时）" />
            <input v-model="newTrigger" type="text" placeholder="触发条件说明（如：识别关键词“发什么快递”）" />
            <input v-model="newText" type="text" placeholder="配图说明文字..." />
            <label class="btn sm">
              📁 选本地图片
              <input type="file" accept="image/*" style="display: none" @change="onPickLocalFile" />
            </label>
            <button type="button" class="btn sm pri" @click="handleAddRule">保存新增</button>
          </div>
          <div v-if="newImgName" style="font-size: 12px; color: #009a29; margin-top: 5px">
            ✓ 已选择图片：{{ newImgName }}
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 2. 【客服绩效考核明细】简洁弹窗 -->
  <div
    v-if="store.ui.kpiModalOpen"
    class="modal-mask"
    @click.self="store.ui.kpiModalOpen = false"
  >
    <div class="modal-card" style="width: 760px">
      <header class="mc-head">
        <div>
          <h3>📊 外包客服今日考核明细（参考千牛/拼多多/抖店标准）</h3>
          <p class="sub">自动统计人工真实回复，夜间 23:00–09:00 免考</p>
        </div>
        <div style="display: flex; gap: 8px">
          <button type="button" class="btn sm pri" @click="exportCsv">导出结算表格</button>
          <button type="button" class="btn sm" @click="store.ui.kpiModalOpen = false">✕ 关闭</button>
        </div>
      </header>

      <div class="mc-body">
        <table class="simple-tbl">
          <thead>
            <tr>
              <th>客服姓名</th>
              <th>今日接待人数</th>
              <th>首次响应</th>
              <th>平均回复</th>
              <th>3分钟回复率</th>
              <th>发实拍执行率</th>
              <th>保修卡激活率</th>
              <th>满意度</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in store.data.kpi.teamRows" :key="row.name" :class="{ warn: !row.ok }">
              <td><b>{{ row.name }}</b></td>
              <td>{{ row.visitors }} 人</td>
              <td>{{ row.firstSec }}</td>
              <td>{{ row.avgSec }}</td>
              <td><b :style="{ color: row.ok ? '#009a29' : '#f53f3f' }">{{ row.threeMinRate }}</b></td>
              <td>{{ row.realShotRate }}</td>
              <td>{{ row.warrantyRate }}</td>
              <td>{{ row.satisfaction }}</td>
              <td>
                <span class="st-pill" :class="row.ok ? 'ok' : 'bad'">{{ row.status }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- 3. 高清大图查看弹窗（看清保修卡富阳法院条款 & 退款3步手机UI指引） -->
  <div
    v-if="store.ui.previewImage"
    class="modal-mask"
    @click.self="store.ui.previewImage = null"
  >
    <div class="modal-card" style="width: 860px">
      <header class="mc-head">
        <h3>🔍 {{ store.ui.previewTitle || '图片高清预览' }}</h3>
        <button type="button" class="btn sm" @click="store.ui.previewImage = null">✕ 关闭</button>
      </header>
      <div style="padding: 18px; background: #1e293b; display: grid; place-items: center">
        <img
          :src="store.ui.previewImage"
          alt="高清预览"
          style="max-width: 100%; max-height: 76vh; border-radius: 12px; background: #fff"
        />
      </div>
    </div>
  </div>

  <!-- 4. 仓管实拍视频播放弹窗 -->
  <div
    v-if="store.ui.videoModalSku"
    class="modal-mask"
    @click.self="store.ui.videoModalSku = null"
  >
    <div class="modal-card" style="width: 640px">
      <header class="mc-head">
        <h3>🎬 {{ store.ui.videoModalSku.videoTitle || '仓管通电实拍视频' }}</h3>
        <button type="button" class="btn sm" @click="store.ui.videoModalSku = null">✕ 关闭</button>
      </header>
      <div class="vid-mock-player">
        <div class="vm-tag">● 仓管高拍仪实录原片 · {{ store.ui.videoModalSku.videoDuration }}</div>
        <div class="vm-main">
          <div style="font-size: 18px; font-weight: 800">{{ store.ui.videoModalSku.title }}</div>
          <div style="font-size: 13px; opacity: 0.86; margin-top: 6px">
            货号：{{ store.ui.videoModalSku.skuCode }} ｜ 机身序列号(SN)：{{ store.ui.videoModalSku.sn }}
          </div>
          <div class="vm-check">✓ 通电功能、屏幕/风力与序列号同框核验无误</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { store, sendRuleCardImage, addCustomAutoRule, showToast } from '../store.js';
import { makeSignRemindCardSvg } from '../data/autoCardsSvg.js';

const newScene = ref('');
const newTrigger = ref('');
const newText = ref('');
const newImgData = ref('');
const newImgName = ref('');

function openPreview(url, title) {
  store.ui.previewImage = url;
  store.ui.previewTitle = title;
}

async function sendNowToCurrentChat(ruleId) {
  await sendRuleCardImage(store.ui.selectedConvId, ruleId, false);
  store.ui.autoRuleModalOpen = false;
  showToast('已将该场景卡片发送到当前聊天窗');
}

function onPickLocalFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  newImgName.value = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    newImgData.value = String(reader.result || '');
  };
  reader.readAsDataURL(file);
}

async function handleAddRule() {
  if (!newScene.value.trim()) {
    showToast('请先填写场景名称');
    return;
  }
  await addCustomAutoRule({
    sceneName: newScene.value.trim(),
    triggerDesc: newTrigger.value.trim() || '命中该业务场景时自动发出',
    accompanyText: newText.value.trim() || `亲，请查看【${newScene.value.trim()}】说明图：`,
    imageUrl: newImgData.value || makeSignRemindCardSvg(),
  });
  newScene.value = '';
  newTrigger.value = '';
  newText.value = '';
  newImgData.value = '';
  newImgName.value = '';
}

function exportCsv() {
  const head = ['客服姓名', '今日接待人数', '首次响应', '平均回复', '3分钟回复率', '实拍执行率', '保修激活率', '满意度', '状态'];
  const lines = store.data.kpi.teamRows.map((r) =>
    [r.name, r.visitors, r.firstSec, r.avgSec, r.threeMinRate, r.realShotRate, r.warrantyRate, r.satisfaction, r.status].join(','),
  );
  const blob = new Blob(['\uFEFF' + [head.join(','), ...lines].join('\n')], {
    type: 'text/csv;charset=utf-8;',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '客服绩效考核表.csv';
  a.click();
  showToast('已导出客服绩效考核结算表格');
}
</script>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 150;
  background: rgba(15, 23, 42, 0.52);
  display: grid;
  place-items: center;
  padding: 20px;
}
.modal-card {
  background: #fff;
  border-radius: 16px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.22);
  overflow: hidden;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}
.mc-head {
  padding: 16px 20px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.mc-head h3 {
  font-size: 16px;
}
.mc-head .sub {
  font-size: 12px;
  color: var(--mute);
  margin-top: 3px;
}
.mc-body {
  padding: 18px 20px;
  overflow-y: auto;
  display: grid;
  gap: 16px;
}

.rule-list {
  display: grid;
  gap: 12px;
}
.rule-item {
  display: grid;
  grid-template-columns: 140px 1fr auto;
  gap: 14px;
  align-items: center;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: #fafbfc;
}
.rule-thumb {
  width: 140px;
  height: 90px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--line);
  cursor: zoom-in;
  background: #fff;
}
.rule-info {
  display: grid;
  gap: 5px;
}
.kw-pill {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--grn-soft);
  color: #00801e;
  font-size: 11px;
  font-weight: 700;
}
.r-desc {
  font-size: 12px;
  color: var(--mute);
}
.r-input {
  width: 100%;
  height: 31px;
  padding: 0 9px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: #fff;
  font-size: 12px;
}
.rule-ops {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}
.switch-lbl {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 700;
  cursor: pointer;
}

.add-rule-box {
  padding: 14px;
  border-radius: 12px;
  background: var(--soft);
  border: 1px dashed #cbd5e1;
}
.add-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1.2fr auto auto;
  gap: 8px;
}
.add-grid input {
  height: 30px;
  padding: 0 9px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: #fff;
  font-size: 12px;
}

.simple-tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.simple-tbl th,
.simple-tbl td {
  padding: 11px 10px;
  border-bottom: 1px solid var(--line);
  text-align: left;
}
.simple-tbl th {
  background: #f7f8fa;
  color: var(--ink2);
  font-weight: 700;
}
.simple-tbl tr.warn {
  background: #fff3f0;
}
.st-pill {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 700;
}
.st-pill.ok {
  background: var(--grn-soft);
  color: #00801e;
}
.st-pill.bad {
  background: var(--red-soft);
  color: var(--red);
}

.vid-mock-player {
  padding: 28px 24px;
  background: linear-gradient(145deg, #0f172a, #1e3a8a);
  color: #fff;
  text-align: center;
  display: grid;
  gap: 14px;
}
.vm-tag {
  font-size: 12px;
  color: #38bdf8;
  font-family: monospace;
}
.vm-check {
  display: inline-block;
  margin-top: 12px;
  padding: 6px 14px;
  border-radius: 999px;
  background: rgba(16, 185, 129, 0.22);
  color: #6ee7b7;
  font-size: 12.5px;
  font-weight: 700;
}
</style>
