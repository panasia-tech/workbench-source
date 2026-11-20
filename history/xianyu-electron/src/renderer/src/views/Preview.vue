<template>
  <div class="preview">
    <div class="bar">
      <div class="tabs">
        <div
          v-for="a in accounts"
          :key="a.id"
          class="tab"
          :class="{ active: a.id === activeId }"
          @click="select(a.id)"
        >
          <el-icon><Monitor /></el-icon>
          <span class="t">{{ a.name }}</span>
          <el-tag v-if="a.loggedIn" type="success" size="small" effect="plain">已登录</el-tag>
        </div>
        <div v-if="!accounts.length" class="empty">请先到「账号配置」新增账号</div>
      </div>
      <div class="ops" v-if="activeId">
        <el-button size="small" :icon="HomeFilled" @click="gotoHome">闲鱼首页(扫码登录)</el-button>
        <el-button size="small" :icon="RefreshRight" @click="reload">刷新</el-button>
      </div>
    </div>
    <!-- 浏览器视图由主进程 attach 到这块占位区 -->
    <div ref="holder" class="holder">
      <div v-if="!activeId" class="ph">选择上方账号标签查看其浏览器</div>
    </div>
  </div>
</template>

<script setup>
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { HomeFilled, Monitor, RefreshRight } from '@element-plus/icons-vue'

const route = useRoute()
const accounts = ref([])
const activeId = ref(null)
const holder = ref(null)
let ro = null

function currentBounds() {
  const el = holder.value
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
}

async function attach() {
  if (!activeId.value) return
  await nextTick()
  const b = currentBounds()
  if (b) await window.erp.attachPreview(activeId.value, b)
}

async function select(id) {
  activeId.value = id
  await attach()
}

function syncBounds() {
  const b = currentBounds()
  if (b && activeId.value) window.erp.setPreviewBounds(b)
}

function gotoHome() { window.erp.previewGotoHome(activeId.value) }
function reload() { window.erp.previewReload(activeId.value) }

onMounted(async () => {
  accounts.value = await window.erp.listAccounts()
  const wanted = route.query.account
  if (wanted && accounts.value.some((a) => a.id === wanted)) activeId.value = wanted
  else if (accounts.value.length) activeId.value = accounts.value[0].id
  await attach()

  ro = new ResizeObserver(syncBounds)
  if (holder.value) ro.observe(holder.value)
  window.addEventListener('resize', syncBounds)
})

onUnmounted(() => {
  window.erp.detachPreview() // 离开预览页就卸下视图（爬取仍在后台继续）
  if (ro) ro.disconnect()
  window.removeEventListener('resize', syncBounds)
})
</script>

<style scoped>
.preview { height: 100%; display: flex; flex-direction: column; }
.bar { display: flex; justify-content: space-between; align-items: center; background: #fff; border: 1px solid #ebeef5; border-radius: 6px 6px 0 0; padding: 4px 8px; }
.tabs { display: flex; gap: 4px; overflow-x: auto; }
.tab { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 6px; cursor: pointer; color: #606266; white-space: nowrap; }
.tab.active { background: #ecf5ff; color: #409eff; }
.tab .t { font-size: 13px; }
.empty, .ph { color: #909399; font-size: 13px; padding: 8px; }
.ops { display: flex; gap: 6px; }
.holder { flex: 1; background: #f0f2f5; border: 1px solid #ebeef5; border-top: none; border-radius: 0 0 6px 6px; display: flex; align-items: center; justify-content: center; }
</style>
