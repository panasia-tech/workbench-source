<template>
  <el-container class="console">
    <el-aside width="200px" class="aside">
      <div class="brand">闲鱼行情爬虫</div>
      <el-menu :default-active="activeMenu" router class="menu">
        <el-menu-item index="/accounts"><el-icon><User /></el-icon><span>账号配置</span></el-menu-item>
        <el-menu-item index="/prices"><el-icon><List /></el-icon><span>爬取内容</span></el-menu-item>
        <el-menu-item index="/preview"><el-icon><Monitor /></el-icon><span>预览</span></el-menu-item>
      </el-menu>
      <div class="aside-foot">
        <span class="staff">{{ staffName }}</span>
        <el-button text size="small" @click="logout">退出登录</el-button>
      </div>
    </el-aside>

    <el-container>
      <el-header class="topbar">
        <div class="ctrl">
          <el-button v-if="!running" type="primary" :icon="VideoPlay" @click="start">开始爬取</el-button>
          <el-button v-else type="danger" :icon="VideoPause" @click="stop">停止</el-button>
          <el-tag v-if="running" type="success" effect="plain">运行中</el-tag>
          <span class="counters" v-if="counters.total">
            进度 {{ counters.success + counters.fail + counters.empty }}/{{ counters.total }}
            ·成功 <b style="color:#67c23a">{{ counters.success }}</b>
            ·无在售 <b style="color:#909399">{{ counters.empty }}</b>
            ·失败 <b style="color:#f56c6c">{{ counters.fail }}</b>
          </span>
          <span class="cur" v-if="cur">当前：{{ cur }}</span>
        </div>
        <div class="win-ops">
          <el-button text :icon="Minus" @click="minimize" title="最小化" />
          <el-button text :icon="Close" @click="hide" title="收进托盘后台运行" />
        </div>
      </el-header>
      <el-main class="main"><router-view /></el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Close, List, Minus, Monitor, User, VideoPause, VideoPlay } from '@element-plus/icons-vue'

const route = useRoute()
const router = useRouter()
const activeMenu = computed(() => route.path)

const staffName = ref('')
const running = ref(false)
const cur = ref('')
const counters = reactive({ success: 0, fail: 0, empty: 0, total: 0 })
let off = null

onMounted(async () => {
  const st = await window.erp.getAuthState()
  staffName.value = st.staff?.username || ''
  running.value = (await window.erp.crawlStatus()).running
  off = window.erp.onCrawlEvent(({ type, payload }) => {
    if (type === 'start') {
      running.value = true
      counters.success = 0; counters.fail = 0; counters.empty = 0; counters.total = payload.total
    } else if (type === 'counters') {
      counters.success = payload.success; counters.fail = payload.fail; counters.empty = payload.empty
    } else if (type === 'progress') {
      cur.value = `${payload.accountName} · ${payload.current}`
    } else if (type === 'done' || type === 'error') {
      running.value = false
      cur.value = ''
      if (type === 'done') ElMessage.success(`爬取结束：成功 ${payload.success}，无在售 ${payload.empty}，失败 ${payload.fail}`)
      else ElMessage.error('爬取出错：' + (payload.message || ''))
    } else if (type === 'daily-trigger') {
      running.value = true
    }
  })
})
onUnmounted(() => off && off())

async function start() {
  const res = await window.erp.startCrawl()
  if (!res.ok) ElMessage.warning(res.reason || '无法开始')
}
function stop() { window.erp.stopCrawl() }
function minimize() { window.erp.minimizeWindow() }
function hide() { window.erp.hideWindow() }

async function logout() {
  await window.erp.logout()
  router.replace('/login')
}
</script>

<style scoped>
.console { height: 100%; }
.aside { display: flex; flex-direction: column; background: #1f2d3d; color: #fff; }
.brand { height: 56px; line-height: 56px; text-align: center; font-weight: 600; color: #fff; letter-spacing: 1px; }
.menu { flex: 1; border-right: none; background: transparent; }
.menu :deep(.el-menu-item) { color: #c0c4cc; }
.menu :deep(.el-menu-item.is-active) { color: #fff; background: #2b5876; }
.aside-foot { padding: 12px; display: flex; flex-direction: column; gap: 4px; border-top: 1px solid rgba(255,255,255,.1); }
.staff { font-size: 12px; color: #909399; }
.topbar { display: flex; align-items: center; justify-content: space-between; background: #fff; border-bottom: 1px solid #ebeef5; }
.ctrl { display: flex; align-items: center; gap: 12px; }
.counters { font-size: 13px; color: #606266; }
.cur { font-size: 12px; color: #909399; }
.main { background: #f5f7fa; padding: 16px; }
</style>
