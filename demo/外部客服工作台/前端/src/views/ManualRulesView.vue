<template>
  <div class="page-scroll">
    <div class="page-wrap">
      <header class="card">
        <span class="tag acc">唯一事实来源 · 对齐《泛亚工作台 UI 设计总纲领 v1.0》</span>
        <h1 style="font-size: 21px; margin-top: 6px">客服工作台速查说明书 · 防呆矩阵 · 实时操作审计日志</h1>
        <p class="muted" style="font-size: 13px; margin-top: 4px">
          汇总全站所有「?」帮助条目、业务术语大白话词典与不可篡改审计流水（当前后端状态：{{ store.serverOnline ? 'SQLite WAL 联机持久化已连接' : '浏览器本地持久化模式' }}）
        </p>
      </header>

      <!-- 名词大白话速查 -->
      <section class="card">
        <h2 style="font-size: 16.5px; margin-bottom: 12px">一、核心业务名词大白话词典（外部人员 1 分钟看懂）</h2>
        <div class="dict-grid">
          <div v-for="(desc, term) in TERMS" :key="term" class="dict-card">
            <b>📖 {{ term }}</b>
            <p>{{ desc }}</p>
          </div>
        </div>
      </section>

      <!-- 全站防呆矩阵汇总 -->
      <section class="card">
        <h2 style="font-size: 16.5px; margin-bottom: 12px">二、工作台 7 字段硬防呆保护矩阵（界面直接拦住错误，不靠事后罚款）</h2>
        <table class="matrix-tbl">
          <thead>
            <tr>
              <th>前置场景</th>
              <th>容易犯的错</th>
              <th>系统怎么硬拦截</th>
              <th>下一步怎么点</th>
              <th>怎么恢复</th>
              <th>责任角色 / 留证</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(g, i) in allGuards" :key="i">
              <td>{{ g.pre }}</td>
              <td>{{ g.mistake }}</td>
              <td><b>{{ g.block }}</b></td>
              <td>{{ g.tip }}</td>
              <td>{{ g.recover }}</td>
              <td>{{ g.owner }}（{{ g.evidence }}）</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- 实时审计日志 -->
      <section class="card">
        <h2 style="font-size: 16.5px; margin-bottom: 12px">三、实时不可篡改操作审计流水（最近 30 条）</h2>
        <div v-if="!store.auditLogs.length" class="muted" style="font-size: 13px">
          尚无新操作记录——去「接待台」挑一件 WMS 真机发实拍或测试自动发货熔断，此处将实时记录完整凭证链。
        </div>
        <div v-else class="log-list">
          <div v-for="lg in store.auditLogs.slice(0, 30)" :key="lg.seq" class="log-row">
            <span class="mono muted">#{{ lg.seq }} · {{ lg.createdAt }}</span>
            <span class="tag acc">{{ lg.action }}</span>
            <b>{{ lg.actor }}</b>
            <span>{{ lg.summary }}</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { store } from '../store.js';
import { HELP, TERMS } from '../data/helpAndRules.js';

const allGuards = computed(() =>
  Object.values(HELP).flatMap((h) => h.guards || []),
);
</script>

<style scoped>
.dict-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.dict-card {
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--panel-alt);
  border: 1px solid var(--line);
  display: grid;
  gap: 5px;
  font-size: 13px;
}
.dict-card b {
  color: var(--acc);
}
.dict-card p {
  color: var(--ink2);
  line-height: 1.48;
}

.matrix-tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.matrix-tbl th,
.matrix-tbl td {
  padding: 10px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}
.matrix-tbl th {
  background: var(--panel-alt);
  color: var(--mute);
  font-weight: 800;
}

.log-list {
  display: grid;
  gap: 6px;
}
.log-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 9px;
  background: var(--panel-alt);
  font-size: 12.5px;
}
</style>
