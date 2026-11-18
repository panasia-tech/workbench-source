<template>
  <div class="dpage">
    <div class="ph">
      <div>
        <h1>我的 · 岗位权限边界与 SQLite 审计留痕</h1>
        <p class="sub">当前登录：{{ currentUser.name }}（{{ currentUser.roleLabel }} · {{ currentUser.station }}）</p>
      </div>
      <div class="row">
        <span class="tag" :class="isSupervisor ? 'acc' : ''">{{ isSupervisor ? '主管权限（含审批/派工/调账/发标准）' : '一线经办权限（主管审批按钮自动带锁说明）' }}</span>
      </div>
    </div>

    <div class="cols-main-aside">
      <div class="card">
        <h2>当前岗位能看什么、能做什么</h2>
        <div class="kv" style="margin-top:10px">
          <span class="k">姓名与岗位</span><span><b>{{ currentUser.name }}</b> · {{ currentUser.roleLabel }}</span>
          <span class="k">负责工位</span><span>{{ currentUser.station }}</span>
          <span class="k">上岗演练门禁</span>
          <span>
            <span v-if="currentUser.practiceDone" class="tag grn">✓ 3 项沙盒演练已通关（真实写权限已开放）</span>
            <span v-else class="tag red">✕ 尚未通关（真实写操作前后端双重拦截）</span>
          </span>
          <span class="k">经办权限</span><span>收货拆封录制、坏货全检、拍三种图与显示器10秒视频切图、扫码防串件出库、自提核验、退回三代比对、盘点实扫举证</span>
          <span class="k">主管专属权限</span>
          <span>
            {{ isSupervisor ? '✓ 当前账号可执行：' : '🔒 当前账号不可执行（需切换周卫东）：' }}
            议价留货解除隔离、任务加派/三要素改派/验收、盘点差异调账回写、外部爬虫标准升版发布、新情况沉淀规则
          </span>
        </div>

        <h2 style="margin-top:18px">界面偏好与演练重置</h2>
        <div class="row" style="gap:10px;margin-top:10px;flex-wrap:wrap">
          <span class="muted" style="font-size:13px">工位屏幕字号：</span>
          <button class="btn sm" :class="store.fontBig ? 'pri' : ''" @click="setFontBig(true)">大字号（默认，适合验货台远看）</button>
          <button class="btn sm" :class="!store.fontBig ? 'pri' : ''" @click="setFontBig(false)">标准字号（单屏看更多行）</button>
        </div>

        <div class="row" style="gap:10px;margin-top:12px;flex-wrap:wrap">
          <button class="btn sm" @click="resetPracticeProgress">只重置当前账号学习进度</button>
          <button class="btn sm" @click="go('learn')">去「学」看沙盒演练 ›</button>
        </div>
      </div>

      <div class="card">
        <div class="ch">
          <div>
            <h2>本机 SQLite 不可篡改审计流水</h2>
            <p class="muted" style="font-size:12px">所有关键动作与越权拦截均实时写入 warehouse_state.sqlite3</p>
          </div>
          <button class="btn sm" @click="loadLogs">刷新日志</button>
        </div>

        <div v-if="logs.length === 0" class="muted" style="padding:16px 0;font-size:13px">
          {{ store.backendOnline ? '暂无最新操作流水，去任意页面执行一次操作即可实时落库。' : '当前为纯静态离线预览模式（运行 bash 启动H5.sh 可启用 Python + SQLite 服务端审计接口）。' }}
        </div>
        <table v-else class="tbl">
          <thead>
            <tr>
              <th style="width:70px">流水号</th>
              <th style="width:145px">记录时间</th>
              <th style="width:90px">操作人</th>
              <th>动作编码与校验结果</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in logs" :key="l.seq || l.id">
              <td class="mono">#{{ l.seq || l.id }}</td>
              <td class="mono muted" style="font-size:12px">{{ (l.createdAt || l.created_at || '').slice(5, 19).replace('T', ' ') }}</td>
              <td><b>{{ l.actor }}</b></td>
              <td>
                <span class="tag" :class="String(l.action).startsWith('DENIED') ? 'red' : 'grn'">{{ l.action }}</span>
                <span v-if="l.summary" class="muted" style="font-size:12px;margin-left:6px">{{ l.summary }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { store, currentUser, isSupervisor, setFontBig, resetPracticeProgress, go } from '../store/warehouseStore.js'

const logs = ref([])

async function loadLogs() {
  try {
    const r = await fetch('/api/wh/logs')
    if (r.ok) {
      const data = await r.json()
      logs.value = (data.logs || []).slice(0, 15)
    }
  } catch (_) {}
}

onMounted(loadLogs)
</script>
