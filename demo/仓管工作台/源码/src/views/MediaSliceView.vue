<template>
  <div class="page">
    <header class="head">
      <div>
        <h1>补图与切片<Q k="media" /></h1>
        <p class="sub">缺本件实拍图、缺库位图由系统自动派给仓管（不设每日上限，当天清完）；显示器通电播壁纸录 10 秒视频，自动筛废片分给多个闲鱼号不重样。</p>
      </div>
      <div class="acts">
        <button class="btn" @click="openHelp('media')"><Icon name="help" />怎么用</button>
      </div>
    </header>

    <!-- 上半区：自动派发缺图补拍队列 -->
    <section class="card" style="margin-top:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <h3 style="margin:0">自动派发补图队列 <small>缺实拍图 / 缺库位图归仓管，拍完实时消除库存红黄灯</small></h3>
        <span class="tag" :class="pendingCount === 0 ? 'grn' : 'red'">{{ pendingCount === 0 ? '✓ 今日缺图已全部清零' : `待补拍 ${pendingCount} 件` }}</span>
      </div>

      <div class="mt-grid">
        <div v-for="m in store.data.mediaTasks" :key="m.id" class="mt-card" :class="{ done: m.done }">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <span class="tag" :class="m.done ? 'grn' : (m.missingType.includes('实拍') ? 'red' : 'amb')">
              {{ m.done ? '✓ 已补齐回写' : m.missingType }}
            </span>
            <span class="muted" style="font-size:12px">库龄 {{ m.ageDays }} 天 · 自动派给 {{ m.assigneeName }}</span>
          </div>
          <b style="font-size:15px">{{ m.model }}</b>
          <p class="muted" style="font-size:12.5px">货号 <code>{{ m.skuCode }}</code> · 库位 <b>{{ m.location }}</b> · 严禁拿同款商品图或旧图冒充</p>
          <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
            <Lock
              v-if="!m.done"
              :ok="!locked"
              reason="先去「学」完成 3 个练习"
              kind="pri sm"
              @go="completeMediaTask(m)"
            >现场拍好 · 一键回写槽位</Lock>
            <button class="btn sm" @click="openItemDetail(m.skuCode)">看单件档案 ›</button>
          </div>
        </div>
      </div>
    </section>

    <!-- 下半区：显示器内置壁纸轮播 + 10秒实拍视频自动防雷同切片台 -->
    <section class="card" style="margin-top:16px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:12px">
        <div>
          <h3 style="margin:0">显示器内置壁纸轮播 · 10秒实拍视频切片台 <span class="tag acc">单件 #{{ sw.skuCode }} · {{ sw.model }}</span></h3>
          <p class="muted" style="font-size:13px;margin-top:4px">
            用法：点开壁纸轮播让屏幕每 2–3 秒换一张图，手机对着真实显示器拍 10 秒视频 → 电脑抽帧剔除模糊/过曝/切换残影/近重复 → 自动给 <b>{{ sw.targetAccounts.length }} 个闲鱼号</b>各分一组不重复的图（仍共用同一件库存！）。
          </p>
        </div>
        <div class="why-box amb" style="font-size:12px">
          <b>防呆边界：</b>壁纸展示图保留真实外框细节，但<b>绝不能代替纯色屏坏点验货证据</b>！
        </div>
      </div>

      <!-- 壁纸轮播模拟预览条 -->
      <div class="wp-bar">
        <div class="wp-screen" :class="wpTheme">
          <b>内置全屏壁纸轮播预览 · {{ WP_LABELS[wpTheme] }}</b>
          <span>每张停留 2.5 秒平滑切换 · 手机连边框一起实拍 10 秒</span>
        </div>
        <div class="wp-ctrls">
          <span class="muted" style="font-size:12.5px">切换轮播壁纸组：</span>
          <div class="seg">
            <button v-for="(lb, k) in WP_LABELS" :key="k" :class="{ on: wpTheme === k }" @click="wpTheme = k">{{ lb }}</button>
          </div>
          <p class="muted" style="font-size:12px">当前原片：{{ sw.videoName }}</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <Lock
              :ok="cleanCount >= minNeeded && !locked"
              :reason="locked ? '先做完 3 个练习' : `有效清晰帧只剩 ${cleanCount} 张，不够分给 ${sw.targetAccounts.length} 个店铺号（每号至少 2 张共需 ${minNeeded} 张），请重拍一段 10 秒视频或恢复误删的清晰帧`"
              @go="autoCleanAndAssignSlices"
            >自动剔除废片并按 {{ sw.targetAccounts.length }} 个闲鱼号不重复分图</Lock>
            <span v-if="sw.packagedAt" class="tag grn">✓ 已于 {{ sw.packagedAt }} 分包同步至销售配图池</span>
          </div>
        </div>
      </div>

      <!-- 10 帧候选抽帧网格（可手动点选切换合格/淘汰，验证素材不足提示） -->
      <div class="frames-grid">
        <div
          v-for="f in sw.frames"
          :key="f.id"
          class="fr-card"
          :class="{ bad: f.quality !== 'ok', sel: f.selected }"
          @click="toggleFrame(f)"
        >
          <img :src="f.src" :alt="f.ts" />
          <div class="fr-foot">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <b>#{{ f.id }} · {{ f.ts }}</b>
              <span class="tag" :class="f.quality === 'ok' ? 'grn' : 'red'">{{ QUAL_TEXT[f.quality] }}</span>
            </div>
            <span v-if="f.assignedTo" class="tag acc" style="width:fit-content">分给：{{ f.assignedTo }}</span>
            <span v-else class="muted" style="font-size:11.5px">{{ f.quality === 'ok' ? '点击可测试剔除/保留' : '系统自动识别淘汰' }}</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import Icon from '../components/Icon.vue'
import Q from '../components/Q.vue'
import Lock from '../components/Lock.vue'
import {
  store,
  currentUser,
  openItemDetail,
  openHelp,
  completeMediaTask,
  autoCleanAndAssignSlices
} from '../store/warehouseStore.js'

const WP_LABELS = { aurora: '极光流体壁纸', sunset: '落日山脉壁纸', forest: '暗调森系壁纸' }
const QUAL_TEXT = {
  ok: '✓ 清晰可用',
  dup: '✕ 近重复帧',
  switch: '✕ 切换残影',
  glare: '✕ 反光过曝',
  blur: '✕ 对焦模糊'
}

const wpTheme = ref('aurora')
const sw = computed(() => store.data.sliceWorkbench)
const locked = computed(() => !currentUser.value.practiceDone)
const pendingCount = computed(() => store.data.mediaTasks.filter(m => !m.done).length)
const minNeeded = computed(() => sw.value.targetAccounts.length * 2)
const cleanCount = computed(() => sw.value.frames.filter(f => f.quality === 'ok').length)

function toggleFrame(f) {
  if (locked.value) return
  f.quality = f.quality === 'ok' ? 'blur' : 'ok'
  f.selected = f.quality === 'ok'
  if (f.quality !== 'ok') f.assignedTo = ''
}
</script>

<style scoped>
.mt-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.mt-card { background: var(--soft); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; display: grid; gap: 6px; }
.mt-card.done { background: #f4fbf7; border-color: #bfead3; }

.wp-bar { display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: 16px; margin-bottom: 16px; align-items: center; }
.wp-screen {
  height: 124px;
  border-radius: 10px;
  border: 5px solid #1e293b;
  padding: 16px;
  color: #fff;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
.wp-screen.aurora { background: linear-gradient(135deg, #0f172a, #1d4ed8 55%, #10b981); }
.wp-screen.sunset { background: linear-gradient(135deg, #31102f, #c2410c 58%, #f59e0b); }
.wp-screen.forest { background: linear-gradient(135deg, #052e16, #15803d 55%, #0284c7); }
.wp-screen span { font-size: 12px; opacity: .88; }
.wp-ctrls { display: grid; gap: 8px; }

.frames-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
.fr-card {
  border: 1px solid var(--line);
  border-radius: 9px;
  overflow: hidden;
  background: var(--panel);
  cursor: pointer;
}
.fr-card.sel { box-shadow: 0 0 0 2px var(--acc); }
.fr-card.bad { opacity: .68; background: #fff8f7; }
.fr-card img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; }
.fr-foot { padding: 8px 10px; display: grid; gap: 5px; font-size: 12px; }
</style>
