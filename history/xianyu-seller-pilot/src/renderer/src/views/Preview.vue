<template>
  <div class="preview-page">
    <section class="hero panel">
      <div class="hero-copy">
        <div class="eyebrow"><el-icon><Connection /></el-icon> 外部指纹环境</div>
        <h1>闲鱼账号入口</h1>
      </div>
      <el-tag type="success" effect="light" round>{{ isWeb ? '服务器后台运行' : '用 AdsPower 打开' }}</el-tag>
    </section>

    <section v-if="!accounts.length" class="panel empty-state">
      <el-icon><User /></el-icon>
      <h2>还没有闲鱼账号</h2>
      <p>{{ isWeb ? '请先在「账号配置」新增服务器 Camoufox Profile。' : '请先在「账号配置」新增账号并绑定AdsPower环境。' }}</p>
    </section>

    <section v-else class="workspace">
      <div class="panel account-panel">
        <div class="panel-heading">
          <div>
            <h2>选择账号</h2>
            <span>{{ isWeb ? `${accounts.length} 个服务器 Profile · 采集任务由后台调度` : `${accounts.length} 个账号 · 点击即打开对应AdsPower 窗口` }}</span>
          </div>
          <el-button text :icon="RefreshRight" :loading="loading" @click="loadAccounts">刷新</el-button>
        </div>

        <div class="account-list">
          <button
            v-for="account in accounts"
            :key="account.id"
            type="button"
            class="account-card"
            :class="{ active: account.id === activeId }"
            @click="openAccount(account)"
          >
            <span class="account-avatar"><el-icon><User /></el-icon></span>
            <span class="account-main">
              <strong>{{ account.name || '未命名账号' }}</strong>
              <small>{{ browserLabel(account) }}</small>
            </span>
            <span class="account-state">
              <el-tag v-if="account.loggedIn" type="success" size="small" effect="plain">已登录</el-tag>
              <el-tag v-else type="warning" size="small" effect="plain">未登录</el-tag>
              <el-icon><ArrowRight /></el-icon>
            </span>
          </button>
        </div>
      </div>

      <div class="panel detail-panel">
        <template v-if="activeAccount">
          <div class="detail-heading">
            <div class="detail-title">
              <span class="detail-avatar"><el-icon><User /></el-icon></span>
              <div>
                <h2>{{ activeAccount.name || '未命名账号' }}</h2>
                <span>当前选择的采集账号</span>
              </div>
            </div>
            <el-tag v-if="activeAccount.loggedIn" type="success">已登录</el-tag>
            <el-tag v-else type="warning">需要登录</el-tag>
          </div>

          <div class="facts">
            <div class="fact">
              <span>浏览器环境</span>
              <strong :class="{ muted: !isAdsAccount(activeAccount) }">
                {{ isWeb ? (activeAccount.provider || 'Camoufox') : (isAdsAccount(activeAccount) ? 'AdsPower' : '尚未绑定 AdsPower') }}
              </strong>
            </div>
            <div class="fact">
              <span>环境 ID</span>
              <strong class="mono">{{ activeAccount.vendorProfileId || activeAccount.adsPowerId || '未配置' }}</strong>
            </div>
            <div class="fact">
              <span>任务状态</span>
              <strong>{{ activeAccount.enabled ? '参与采集' : '已暂停' }}</strong>
            </div>
          </div>

          <div v-if="isWeb" class="open-box">
            <el-icon><Connection /></el-icon>
            <div>
              <strong>服务器后台采集</strong>
              <p>{{ activeAccount.provider === 'camoufox' ? 'Camoufox 在公司服务器上保持独立登录态并执行调度；员工可在下方通过 H5 完成首次登录或扫码。' : '当前服务器 Provider 为 ' + (activeAccount.provider || '未知') + '，任务仍由服务器调度；该 Provider 暂不提供 H5 人工画面，请由管理员切换到 Camoufox。' }}</p>
            </div>
          </div>
          <div v-else-if="!isAdsAccount(activeAccount)" class="warning-box">
            <el-icon><WarningFilled /></el-icon>
            <div>
              <strong>此账号没有绑定AdsPower 环境</strong>
              <p>请到「账号绑定」绑定环境。</p>
            </div>
          </div>
          <div v-else class="open-box">
            <el-icon><Connection /></el-icon>
            <div>
              <strong>用绑定的 AdsPower 环境打开</strong>
            </div>
          </div>

          <div v-if="!isWeb" class="actions">
            <el-button
              type="primary"
              size="large"
              :icon="Promotion"
              :loading="openingId === activeAccount.id"
              :disabled="!isAdsAccount(activeAccount)"
              @click="openAccount(activeAccount)"
            >
              打开AdsPower 窗口
            </el-button>
            <el-button size="large" :icon="RefreshRight" @click="refreshAccount">刷新账号状态</el-button>
          </div>
          <div v-if="isWeb && activeAccount.provider === 'camoufox'" class="manual-browser panel-inset">
            <div class="manual-heading">
              <div>
                <strong>服务器登录画面</strong>
                <p>登录凭据只留在服务器，不经过员工电脑。</p>
              </div>
              <div class="manual-actions">
                <el-button type="primary" size="small" :loading="manualLoading" @click="startManualSession">打开 / 刷新</el-button>
                <el-button v-if="manualSession" size="small" :loading="manualLoading" @click="closeManualSession">关闭</el-button>
              </div>
            </div>
            <p v-if="manualError" class="open-message error">{{ manualError }}</p>
            <div v-if="manualScreenshot" class="manual-screen-wrap">
              <img class="manual-screen" :src="manualScreenshot" alt="服务器浏览器画面" />
            </div>
            <div v-if="manualSession" class="manual-controls">
              <div class="manual-status"><el-tag size="small" type="warning">需要员工完成登录</el-tag><span>会话有效至 {{ formatExpiry(manualSession.expiresAt) }}</span></div>
              <div class="manual-row">
                <el-input v-model="manualRef" size="small" placeholder="控件编号，例如 @e1" aria-label="控件编号" />
                <el-input v-model="manualText" size="small" placeholder="填写内容（可选）" aria-label="填写内容" />
                <el-button size="small" @click="runManualAction('click')">点击</el-button>
                <el-button size="small" @click="runManualAction('fill')">填写</el-button>
              </div>
              <div class="manual-row manual-row-secondary">
                <el-input v-model="manualKey" size="small" placeholder="按键，例如 Enter" aria-label="按键" />
                <el-button size="small" @click="runManualAction('press')">按键</el-button>
                <el-button size="small" @click="runManualAction('scroll', { direction: 'up' })">向上滚动</el-button>
                <el-button size="small" @click="runManualAction('scroll', { direction: 'down' })">向下滚动</el-button>
              </div>
              <details v-if="manualSnapshot" class="manual-snapshot">
                <summary>显示页面控件编号</summary>
                <pre>{{ manualSnapshot }}</pre>
              </details>
            </div>
          </div>
          <p v-if="!isWeb && openMessage" class="open-message" :class="{ error: openError }">{{ openMessage }}</p>
        </template>
        <div v-else class="detail-placeholder">请选择一个账号</div>
      </div>
    </section>

    <section class="control-hint panel">
      <el-icon><InfoFilled /></el-icon>
      <span>{{ isWeb ? '采集任务、浏览器登录态和数据都在服务器；本 H5 不连接员工电脑上的浏览器。' : '采集任务会在后台独立运行；本页只负责打开对应的AdsPower 环境，不提供网页嵌入和滚动操作。' }}</span>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowRight, Connection, InfoFilled, Promotion, RefreshRight, User, WarningFilled } from '@element-plus/icons-vue'

const route = useRoute()
const accounts = ref([])
const activeId = ref(null)
const loading = ref(false)
const openingId = ref(null)
const openMessage = ref('')
const openError = ref(false)
const isWeb = window.erp?.mode === 'web'
const manualSession = ref(null)
const manualScreenshot = ref('')
const manualSnapshot = ref('')
const manualRef = ref('')
const manualText = ref('')
const manualKey = ref('')
const manualLoading = ref(false)
const manualError = ref('')

const activeAccount = computed(() => accounts.value.find((account) => account.id === activeId.value) || null)

function isAdsAccount(account) {
  return account?.browserProvider === 'adspower' && Boolean(account?.adsPowerId)
}

function browserLabel(account) {
  if (isWeb) return `${account.provider || 'Camoufox'} · ${(account.vendorProfileId || account.adsPowerId || '').slice(0, 8)}`
  if (isAdsAccount(account)) return `AdsPower 环境 · ${account.adsPowerId.slice(0, 8)}`
  return '未绑定AdsPower 环境'
}

async function loadAccounts() {
  loading.value = true
  try {
    accounts.value = await window.erp.listAccounts()
    const wanted = String(route.query.account || '')
    if (wanted && accounts.value.some((account) => account.id === wanted)) activeId.value = wanted
    else if (!accounts.value.some((account) => account.id === activeId.value)) activeId.value = accounts.value[0]?.id || null
  } catch (error) {
    accounts.value = []
    activeId.value = null
    ElMessage.error(error?.message || '读取账号失败')
  } finally {
    loading.value = false
  }
}

async function openAccount(account) {
  if (!account) return
  if (isWeb && activeId.value && activeId.value !== account.id && manualSession.value) {
    const previousId = activeId.value
    const previousSessionId = manualSession.value.sessionId
    window.erp.closeManualBrowserSession?.(previousId, previousSessionId).catch(() => {})
    manualSession.value = null
    manualScreenshot.value = ''
    manualSnapshot.value = ''
  }
  activeId.value = account.id
  openMessage.value = ''
  openError.value = false
  if (isWeb) return
  if (!isAdsAccount(account)) {
    openError.value = true
    openMessage.value = '该账号尚未绑定AdsPower 环境，已阻止打开 Electron 内置浏览器。'
    return
  }

  openingId.value = account.id
  try {
    const open = window.erp.openAdsPowerProfile
    if (typeof open !== 'function') throw new Error('当前版本缺少AdsPower打开接口，请重新安装应用')
    const result = await open(account.id)
    if (result?.ok === false) throw new Error(result.reason || result.message || result.error || 'AdsPower 环境打开失败')
    openMessage.value = '已请求打开AdsPower 窗口，请在AdsPower中完成登录或继续操作。'
    ElMessage.success('AdsPower 窗口已打开')
  } catch (error) {
    openError.value = true
    openMessage.value = error?.message || 'AdsPower 窗口打开失败'
    ElMessage.error(openMessage.value)
  } finally {
    openingId.value = null
  }
}

function applyManualResult(result) {
  manualSession.value = result?.session || null
  manualSnapshot.value = typeof result?.snapshot === 'string' ? result.snapshot : result?.snapshot ? JSON.stringify(result.snapshot, null, 2) : ''
  const image = result?.screenshot
  manualScreenshot.value = image?.base64 ? `data:${image.mimeType || 'image/png'};base64,${image.base64}` : ''
}

function formatExpiry(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString()
}

async function startManualSession() {
  if (!activeAccount.value) return
  manualLoading.value = true
  manualError.value = ''
  try {
    const result = manualSession.value
      ? await window.erp.getManualBrowserSession(activeAccount.value.id)
      : await window.erp.openAdsPowerProfile(activeAccount.value.id)
    applyManualResult(result)
    ElMessage.success('服务器浏览器已准备好，请在画面中完成登录')
  } catch (error) {
    if (String(error?.message || '').includes('manual browser session')) {
      manualSession.value = null
      manualScreenshot.value = ''
      manualSnapshot.value = ''
    }
    manualError.value = error?.message || '服务器浏览器打开失败'
    ElMessage.error(manualError.value)
  } finally { manualLoading.value = false }
}

async function closeManualSession() {
  if (!activeAccount.value || !manualSession.value) return
  manualLoading.value = true
  try { await window.erp.closeManualBrowserSession(activeAccount.value.id, manualSession.value.sessionId); manualSession.value = null; manualScreenshot.value = ''; manualSnapshot.value = '' } catch (error) { manualError.value = error?.message || '服务器浏览器关闭失败' } finally { manualLoading.value = false }
}

async function runManualAction(type, extra = {}) {
  if (!activeAccount.value || !manualSession.value) return
  manualLoading.value = true
  manualError.value = ''
  try {
    const result = await window.erp.manualBrowserAction(activeAccount.value.id, { sessionId: manualSession.value.sessionId, type, ref: manualRef.value, text: manualText.value, key: manualKey.value, ...extra })
    applyManualResult(result)
  } catch (error) { manualError.value = error?.message || '服务器浏览器操作失败'; ElMessage.error(manualError.value) } finally { manualLoading.value = false }
}

async function refreshAccount() {
  await loadAccounts()
  if (activeAccount.value) await openAccount(activeAccount.value)
}

onMounted(async () => {
  await loadAccounts()
  // 从账号配置“去登录”进入时，直接打开指定AdsPower 环境；普通进入页面只选中账号，避免意外弹窗。
  if (!isWeb && route.query.account && activeAccount.value) await openAccount(activeAccount.value)
})
</script>

<style scoped>
.preview-page { min-height: 100%; padding: 4px; color: #1f2937; background: #f6f8fb; }
.panel { background: #fff; border: 1px solid #e6ebf2; border-radius: 14px; box-shadow: 0 8px 24px rgba(15, 23, 42, .035); }
.hero { display: flex; justify-content: space-between; align-items: center; padding: 24px 28px; margin-bottom: 16px; background: linear-gradient(135deg, #f6fbff, #fff); }
.eyebrow { display: flex; align-items: center; gap: 6px; color: #2563eb; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.hero h1 { margin: 7px 0 6px; color: #111827; font-size: 24px; line-height: 1.2; }
.hero p { margin: 0; color: #64748b; font-size: 13px; }
.workspace { display: grid; grid-template-columns: minmax(260px, 34%) 1fr; gap: 16px; align-items: stretch; }
.account-panel, .detail-panel { min-height: 440px; padding: 20px; }
.panel-heading, .detail-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.panel-heading h2, .detail-heading h2 { margin: 0 0 4px; color: #111827; font-size: 16px; }
.panel-heading span, .detail-heading span { color: #94a3b8; font-size: 12px; }
.account-list { display: flex; flex-direction: column; gap: 8px; margin-top: 18px; }
.account-card { display: flex; align-items: center; width: 100%; padding: 12px; color: #334155; text-align: left; background: #fff; border: 1px solid #e8edf3; border-radius: 11px; cursor: pointer; transition: border-color .18s, background .18s, transform .18s; }
.account-card:hover { background: #f8fbff; border-color: #b9d7ff; transform: translateY(-1px); }
.account-card.active { background: #eff6ff; border-color: #60a5fa; box-shadow: inset 3px 0 #2563eb; }
.account-avatar, .detail-avatar { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; color: #2563eb; background: #dbeafe; border-radius: 10px; }
.account-avatar { width: 32px; height: 32px; margin-right: 10px; }
.account-main { display: flex; flex: 1; flex-direction: column; min-width: 0; gap: 3px; }
.account-main strong { overflow: hidden; color: #1e293b; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.account-main small { overflow: hidden; color: #94a3b8; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.account-state { display: flex; align-items: center; gap: 6px; margin-left: 8px; }
.account-state .el-icon { color: #94a3b8; }
.detail-heading { padding-bottom: 20px; border-bottom: 1px solid #eef2f7; }
.detail-title { display: flex; align-items: center; gap: 12px; }
.detail-avatar { width: 42px; height: 42px; font-size: 20px; border-radius: 12px; }
.facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 22px 0; }
.fact { padding: 13px; background: #f8fafc; border-radius: 10px; }
.fact span { display: block; margin-bottom: 8px; color: #94a3b8; font-size: 11px; }
.fact strong { display: block; overflow: hidden; color: #334155; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.fact strong.muted { color: #f59e0b; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.warning-box, .open-box { display: flex; align-items: flex-start; gap: 11px; padding: 15px; border-radius: 10px; }
.warning-box { color: #92400e; background: #fffbeb; border: 1px solid #fde68a; }
.warning-box > .el-icon { margin-top: 2px; color: #f59e0b; }
.open-box { color: #1e40af; background: #eff6ff; border: 1px solid #bfdbfe; }
.open-box > .el-icon { margin-top: 2px; color: #2563eb; }
.warning-box strong, .open-box strong { font-size: 13px; }
.warning-box p, .open-box p { margin: 5px 0 0; color: #64748b; font-size: 12px; line-height: 1.55; }
.actions { display: flex; gap: 10px; margin-top: 24px; }
.open-message { margin: 12px 0 0; color: #16a34a; font-size: 12px; }
.open-message.error { color: #dc2626; }
.panel-inset { margin-top: 18px; padding: 14px; background: #f8fafc; border: 1px solid #e5eaf2; border-radius: 12px; }
.manual-heading, .manual-status, .manual-row { display: flex; align-items: center; gap: 8px; }
.manual-heading { justify-content: space-between; align-items: flex-start; }
.manual-heading strong { color: #334155; font-size: 13px; }
.manual-heading p { margin: 4px 0 0; color: #64748b; font-size: 11px; }
.manual-actions { display: flex; gap: 6px; }
.manual-screen-wrap { display: flex; justify-content: center; margin-top: 12px; overflow: auto; min-height: 120px; background: #e2e8f0; border-radius: 8px; }
.manual-screen { display: block; max-width: 100%; height: auto; object-fit: contain; }
.manual-controls { margin-top: 12px; }
.manual-status { margin-bottom: 8px; color: #64748b; font-size: 11px; }
.manual-row { margin-top: 8px; }
.manual-row .el-input { flex: 1; min-width: 0; }
.manual-row-secondary { flex-wrap: wrap; }
.manual-snapshot { margin-top: 10px; color: #475569; font-size: 11px; }
.manual-snapshot pre { max-height: 180px; margin: 8px 0 0; overflow: auto; padding: 10px; color: #334155; background: #fff; border: 1px solid #e5eaf2; border-radius: 8px; white-space: pre-wrap; }
.detail-placeholder, .empty-state { display: flex; align-items: center; justify-content: center; flex-direction: column; min-height: 440px; color: #94a3b8; }
.empty-state { padding: 40px; }
.empty-state > .el-icon { color: #93c5fd; font-size: 34px; }
.empty-state h2 { margin: 14px 0 6px; color: #334155; font-size: 17px; }
.empty-state p { margin: 0; font-size: 13px; }
.control-hint { display: flex; align-items: center; gap: 8px; margin-top: 16px; padding: 12px 16px; color: #64748b; font-size: 12px; }
.control-hint > .el-icon { color: #2563eb; }
@media (max-width: 820px) {
  .hero { align-items: flex-start; flex-direction: column; gap: 14px; }
  .workspace { grid-template-columns: 1fr; }
  .account-panel, .detail-panel { min-height: auto; }
  .facts { grid-template-columns: 1fr; }
  .actions { flex-wrap: wrap; }
}
</style>
