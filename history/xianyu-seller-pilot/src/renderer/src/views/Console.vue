<template>
  <el-container class="console">
    <el-aside width="228px" class="aside">
      <div class="brand" aria-label="卖家工作台">
        <img class="brand-mark" :src="logoUrl" alt="" width="36" height="36" />
        <div class="brand-copy"><b>卖家工作台</b><small>SELLER PILOT</small></div>
      </div>
      <div class="workspace-label">工作区</div>
      <!-- 菜单项来自 menu.js，与路由守卫共用同一份声明：藏起来的页面也进不去 -->
      <el-menu :default-active="activeMenu" router class="menu" aria-label="主功能菜单">
        <el-menu-item v-for="item in menuItems" :key="item.path" :index="item.path" :title="item.hint">
          <el-icon><component :is="ICONS[item.icon]" /></el-icon>
          <span>{{ item.title }}</span>
        </el-menu-item>
      </el-menu>
      <div v-if="roleLabel" class="role-chip">{{ roleLabel }}</div>
      <div v-if="!isWeb && !codeState.disabled" class="update-bar" :class="{ actionable: updateActionable }">
        <div class="update-line">
          <span class="update-version">版本 {{ codeState.current?.versionName || '—' }}</span>
          <el-button text size="small" :loading="codeState.checking" @click="checkUpdate">检查更新</el-button>
        </div>
        <div v-if="codeState.readyToApply" class="update-hint">
          新版本已下载，<el-button text size="small" type="primary" @click="restartForUpdate">重启生效</el-button>
        </div>
        <div v-else-if="codeState.updateAvailable" class="update-hint">
          发现 {{ codeState.latest?.versionName }}
          <el-button text size="small" type="primary" :loading="codeState.downloading" @click="downloadUpdate">下载更新</el-button>
        </div>
        <div v-else-if="codeState.error" class="update-hint update-error" :title="codeState.error">更新检查失败</div>
      </div>
      <div v-if="!isWeb" class="restart-bar" :class="{ active: restart.busy || restart.plan }">
        <div v-if="restart.busy" class="restart-line">
          <el-icon class="is-loading"><Loading /></el-icon><span>{{ restartProgressText }}</span>
        </div>
        <template v-else-if="restart.plan">
          <div class="restart-line" :title="restart.plan.resumeError">
            {{ restart.plan.resumeError ? `${restart.plan.envs} 个执行端没恢复` : '已暂停，可以重启电脑了' }}
          </div>
          <el-button text size="small" type="primary" @click="resumeAfterPause">
            {{ restart.plan.resumeError ? '再试一次' : '不重启了，继续' }}
          </el-button>
        </template>
        <el-button v-else text size="small" :icon="SwitchButton" @click="pauseForRestart">暂停，准备重启电脑</el-button>
      </div>
      <!-- 密码库填进 AdsPower：这台电脑批没批、指纹多少（主人在台账页批准时对着看）。点一下现在去领 -->
      <div v-if="vaultAds.status !== 'unknown' || vaultAds.lastError" class="vault-line" :title="vaultTitle" @click="runVaultAds">
        密码填充：{{ vaultAds.statusLabel }}<template v-if="vaultAds.fingerprint"> · 指纹 {{ vaultAds.fingerprint }}</template>
        <span v-if="vaultAds.lastError" class="vault-err">· {{ vaultAds.lastError }}</span>
      </div>
      <div class="aside-foot">
        <div class="staff-block"><span class="staff-avatar">{{ (staffName || '本').slice(0, 1).toUpperCase() }}</span><span class="staff">{{ staffName || '本机模式' }}</span></div>
        <el-button text size="small" @click="logout">退出登录</el-button>
      </div>
    </el-aside>

    <el-container>
      <el-header class="topbar" aria-label="当前功能域">
        <div class="domain-context">
          <div class="route-title"><h2>{{ domainLabel }}</h2></div>
        </div>
        <div v-if="!isWeb" class="win-ops">
          <el-button text :icon="Minus" @click="minimize" title="最小化" />
          <el-button text :icon="Close" @click="hide" title="收进托盘后台运行" />
        </div>
      </el-header>
      <el-main class="main"><router-view /></el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ChatDotRound, Close, Connection, Cpu, DataAnalysis, Link, List, Loading, Minus, Monitor, User , SwitchButton, Sell, Tools} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { MENU, ROLES, visibleMenu } from '../menu.js'
import logoUrl from '../assets/logo.png'

// menu.js 里每个 icon 名都必须在这里有对应项，漏一个是**静默**的：
// <component :is="undefined"> 什么都不渲染，菜单项就只剩文字（/envs 的 Cpu 漏过一次）。
// menu-role-gating 回归会核对这两边，别只改一头。
const ICONS = { ChatDotRound, DataAnalysis, Monitor, Cpu, User, Link, List, Connection, SwitchButton, Sell, Tools }

const route = useRoute()
const router = useRouter()
const activeMenu = computed(() => route.path.startsWith('/prices') ? '/prices' : route.path)

// 角色决定菜单。未取到 authState 前先不渲染菜单项，避免闪一下越权入口。
const authState = ref(null)
const menuItems = computed(() => (authState.value ? visibleMenu(authState.value) : []))
const roleLabel = computed(() => {
  const role = String(authState.value?.staff?.role || '').toUpperCase()
  return role ? (ROLES[role] || role) : ''
})
// 顶栏标题直接读 menu.js 那份**唯一声明**，不再另抄一份。
// 原来这里维护着第二套 label，改文案时只改一处，于是侧栏说「设备与账号」、
// 顶栏还写着「执行单元」——同一个页面两个名字，用的人当然更懵。
const CHILD_ROUTES = { '/prices/history': { title: '运行历史' } }
const currentEntry = computed(() =>
  CHILD_ROUTES[route.path] || MENU.find((item) => item.path === route.path) || null)
const domainLabel = computed(() => currentEntry.value?.title || '当前功能')

const staffName = ref('')
const isWeb = window.erp?.mode === 'web'

// 代码热更新：主进程启动时已静默查过一次，这里只订阅状态并提供手动入口。
// disabled=true 表示这个构建走整包分发（见 loader.js 的开关），界面就不显示更新入口
const codeState = reactive({ checking: false, downloading: false, current: null, latest: null, updateAvailable: false, readyToApply: false, error: '', disabled: false })
const updateActionable = computed(() => codeState.updateAvailable || codeState.readyToApply)
let stopCodeUpdateState = null
const vaultAds = reactive({ status: 'unknown', statusLabel: '', fingerprint: '', lastError: '', lastRunAt: null, filled: 0, failed: 0 })
let stopVaultAds = null
const vaultTitle = computed(() => `本次开机填好 ${vaultAds.filled} 条、失败 ${vaultAds.failed} 条${vaultAds.lastRunAt ? '，最近一次 ' + new Date(vaultAds.lastRunAt).toLocaleTimeString() : ''}。点一下现在去领。`)
async function runVaultAds() {
  try { Object.assign(vaultAds, await window.erp.runVaultAdsNow() || {}) } catch { /* 老版本主进程没有这个通道 */ }
}

onMounted(async () => {
  try {
    const st = await window.erp.getAuthState()
    authState.value = st
    staffName.value = st.staff?.username || (st.localMode ? '本机模式' : '')
  } catch { /* 登录页已经负责显示鉴权错误，外壳不再承担队列状态。 */ }
  if (isWeb) return
  stopCodeUpdateState = window.erp.onCodeUpdateState((state) => Object.assign(codeState, state || {}))
  try { Object.assign(codeState, await window.erp.getCodeUpdateState() || {}) } catch { /* 老版本主进程没有这个通道 */ }
  if (window.erp.onVaultAdsState) {
    stopVaultAds = window.erp.onVaultAdsState((state) => Object.assign(vaultAds, state || {}))
    try { Object.assign(vaultAds, await window.erp.getVaultAdsState() || {}) } catch { /* 拿不到就不显示 */ }
  }
  stopRestartState = window.erp.onRestartState((state) => applyRestartState(state))
  try { applyRestartState(await window.erp.restartState()) } catch { /* 拿不到就当没暂停 */ }
})

onBeforeUnmount(() => { stopCodeUpdateState?.(); stopRestartState?.(); stopVaultAds?.() })

// 暂停，准备重启电脑（主进程 restart-pause.js）。开机自动恢复也是主进程自己跑的，
// 所以结果一律看状态推送：忙完的那一下按 last 告诉人，不靠按钮的返回值。
const restart = reactive({ busy: '', progress: null, plan: null, last: null })
let stopRestartState = null
const restartProgressText = computed(() => {
  const p = restart.progress || {}
  if (restart.busy === 'pause') {
    if (p.phase === 'crawls') return '正在停采集…'
    if (p.phase === 'draining') return `等 ${p.running} 个任务做完（最多再等 ${Math.ceil((p.leftMs || 0) / 60_000)} 分钟）`
    if (p.phase === 'stopping') return `正在关执行端 ${p.done + 1}/${p.total}`
    return '正在暂停…'
  }
  if (p.phase === 'waiting-ads') return '等 AdsPower 打开…'
  if (p.phase === 'starting') return `正在拉起执行端 ${p.done + 1}/${p.total}`
  return '正在恢复…'
})

function applyRestartState(state) {
  const finished = restart.busy && !state?.busy ? restart.busy : ''
  Object.assign(restart, { busy: '', progress: null, plan: null, last: null }, state || {})
  if (finished && restart.last?.kind === finished) reportRestart(restart.last)
}

function reportRestart(last) {
  if (!last.ok) return ElMessage.error(`${last.kind === 'pause' ? '暂停' : '恢复'}没成：${last.reason}`)
  const d = last.data || {}
  const notes = (d.notes || []).join('；')
  if (last.kind === 'pause') {
    if (d.nothing) return ElMessage.success(d.alreadyPaused ? '已经暂停了，可以重启电脑' : '现在没有在跑的任务，可以直接重启电脑')
    if (d.timedOut) return ElMessage.warning(`已暂停，可以重启电脑了。有 ${d.unfinished} 个任务没等完，重启后重新排队`)
    if (notes) return ElMessage.warning(`已暂停，可以重启电脑了（${notes}）`)
    return ElMessage.success('已暂停，可以重启电脑了')
  }
  if (d.nothing) return
  if (d.waitingAds) return ElMessage.warning('AdsPower 没打开，打开后点「再试一次」')
  if (d.failed?.length) return ElMessage.warning(`恢复了 ${d.started} 个执行端，${d.failed.length} 个没起来`)
  const extra = [d.requeued ? `${d.requeued} 个被打断的任务已重新排队` : '', d.crawls?.length ? '采集已接着跑' : '']
    .filter(Boolean).join('，')
  ElMessage[notes ? 'warning' : 'success'](`已恢复 ${d.started} 个执行端${extra ? `，${extra}` : ''}${notes ? `（${notes}）` : ''}`)
}

async function pauseForRestart() {
  try {
    await ElMessageBox.confirm('等手上的任务做完（最多 6 分钟），再关掉执行端和浏览器。重启电脑后打开卖家工作台会自动接着干。',
      '暂停，准备重启电脑', { confirmButtonText: '暂停', cancelButtonText: '取消', type: 'warning' })
  } catch { return }
  const res = await window.erp.restartPause()
  if (res?.busy) ElMessage.warning(res.reason)
}

async function resumeAfterPause() {
  const res = await window.erp.restartResume()
  if (res?.busy) ElMessage.warning(res.reason)
}

async function checkUpdate() {
  const state = await window.erp.checkCodeUpdate()
  Object.assign(codeState, state || {})
  if (codeState.error) return ElMessage.warning(`检查更新失败：${codeState.error}`)
  if (!codeState.updateAvailable) ElMessage.success(`已是最新版本 ${codeState.current?.versionName || ''}`)
}

async function downloadUpdate() {
  const result = await window.erp.downloadCodeUpdate()
  if (!result?.ok) return ElMessage.error(result?.reason || '下载更新失败')
  ElMessage.success(`${result.versionName} 已下载，重启后生效`)
}

async function restartForUpdate() {
  try {
    await ElMessageBox.confirm('重启应用以启用新版本？正在运行的采集任务会中断。', '重启生效', { confirmButtonText: '立即重启', cancelButtonText: '稍后', type: 'warning' })
  } catch { return }
  void window.erp.restartForCodeUpdate()
}
function minimize() { void window.erp.minimizeWindow() }
function hide() { void window.erp.hideWindow() }

async function logout() {
  try {
    const res = await window.erp.logout()
    if (res && res.ok === false) {
      // 本地配置文件被占用时写盘会失败；当前进程已经按未登录处理，照样回登录页
      ElMessage.warning(res.reason || '本地配置写入失败，但本次已按退出处理')
    }
  } catch (error) {
    ElMessage.warning(error?.message || '退出登录时本地配置写入失败')
  } finally {
    router.replace('/login')
  }
}
</script>

<style scoped>
.console { height: 100%; }
.aside { display: flex; flex-direction: column; background: #17211f; color: #fff; border-right: 1px solid rgba(255,255,255,.06); }
.brand { min-height: 78px; display: flex; align-items: center; gap: 11px; padding: 0 20px; color: #f4f7f5; letter-spacing: .3px; }
.brand-copy { min-width: 0; }.brand b { display: block; font-size: 14px; font-weight: 650; white-space: nowrap; }.brand small { display: block; margin-top: 4px; color: #8d9e98; font-size: 9px; letter-spacing: 1.6px; }.brand-mark { width: 36px; height: 36px; flex: 0 0 auto; object-fit: contain; box-shadow: 0 5px 16px rgba(58,180,214,.18); }
.workspace-label { padding: 8px 20px 6px; color: #60756a; font-size: 10px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; }
.menu { flex: 1; border-right: none; background: transparent; }
.menu :deep(.el-menu-item) { height: 44px; font-size: 12.5px; margin: 3px 10px; border-radius: 9px; color: #aab8b2; }
.menu :deep(.el-menu-item:hover) { background: rgba(183,228,199,.08); color: #f4f7f5; }
.menu :deep(.el-menu-item.is-active) { color: #d9f5e4; background: rgba(183,228,199,.16); }
.menu :deep(.el-menu-item .el-icon) { width: 22px; margin-right: 10px; font-size: 17px; }
.role-chip { margin: 6px 16px 0; padding: 3px 9px; align-self: flex-start; display: inline-block;
  border-radius: 4px; background: rgba(183,228,199,.12); color: #a4cdb2; font-size: 10.5px; letter-spacing: .04em; }
.update-bar { padding: 10px 14px; border-top: 1px solid rgba(255,255,255,.08); color: #809188; font-size: 11px; }
.update-bar.actionable { background: rgba(183,228,199,.07); }
.update-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.update-version { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.update-hint { margin-top: 2px; color: #a4cdb2; }
.update-error { color: #d9a2a2; cursor: help; }
.update-bar :deep(.el-button) { padding: 2px 0; font-size: 11px; color: #809188; }
.update-bar :deep(.el-button:hover) { color: #d9f5e4; }
.update-bar :deep(.el-button--primary) { color: #7fd6a0; }
.restart-bar { padding: 8px 14px; border-top: 1px solid rgba(255,255,255,.08); color: #a4cdb2; font-size: 11px; }
.restart-bar.active { background: rgba(230,180,90,.09); color: #e8c98f; }
.restart-line { display: flex; align-items: center; gap: 6px; line-height: 18px; }
.restart-bar :deep(.el-button) { padding: 2px 0; font-size: 11px; color: #809188; }
.restart-bar :deep(.el-button:hover) { color: #d9f5e4; }
.restart-bar :deep(.el-button--primary) { color: #7fd6a0; }
.vault-line { padding: 6px 14px; color: #aab8b2; font-size: 11px; line-height: 1.5; cursor: pointer; border-top: 1px solid rgba(255,255,255,.06); }.vault-line:hover { color: #d9f5e4; }.vault-err { color: #f3b8a6; }
.aside-foot { padding: 12px 14px 14px; display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid rgba(255,255,255,.1); }.staff-block { display: flex; min-width: 0; align-items: center; gap: 8px; }.staff-avatar { width: 26px; height: 26px; display: grid; flex: 0 0 auto; place-items: center; border-radius: 50%; background: rgba(183,228,199,.16); color: #cbeed8; font-size: 11px; font-weight: 700; }.staff { overflow: hidden; color: #aab8b2; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.aside-foot :deep(.el-button) { flex: 0 0 auto; padding: 4px; color: #809188; font-size: 11px; }.aside-foot :deep(.el-button:hover) { color: #d9f5e4; }
.topbar { display: flex; align-items: center; justify-content: space-between; min-height: 68px; height: auto; padding: 11px 22px; background: #fbfcfb; border-bottom: 1px solid #e7ece9; }.domain-context { display: flex; min-width: 0; flex-direction: column; gap: 5px; }.route-kicker { color: #8a9a91; font-size: 9px; font-weight: 700; letter-spacing: 1.4px; }.route-title { display: flex; min-width: 0; align-items: baseline; flex-wrap: wrap; gap: 10px; }.route-title h2 { margin: 0; color: #2b4135; font-size: 17px; font-weight: 700; }.route-title span { color: #85938c; font-size: 11px; }.win-ops { display: flex; gap: 2px; }.win-ops :deep(.el-button) { color: #8a9991; }.win-ops :deep(.el-button:hover) { color: #355b45; background: #eff7f1; }
.main { min-width: 0; overflow: auto; background: #f4f7f5; padding: 18px 20px 24px; }
@media (max-width: 1120px) { .aside { width: 198px !important; }.brand { padding-inline: 14px; }.workspace-label { padding-inline: 14px; }.menu :deep(.el-menu-item) { margin-inline: 6px; }.topbar { padding-inline: 14px; }.main { padding-inline: 14px; } }
</style>
