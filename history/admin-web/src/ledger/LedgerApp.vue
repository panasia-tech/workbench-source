<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Notebook, Money, Monitor, Files, EditPen, Share, View, Unlock, SwitchButton, Shop, Reading, Lock, Key } from '@element-plus/icons-vue'
import api, { errText, forgetAll, getToken, setToken, settleToken, skipToken } from './api'
import { useDesktop } from './useDesktop'
import SubmitForm from './SubmitForm.vue'
import MyGrants from './MyGrants.vue'
import AdminLedger from './AdminLedger.vue'
import AdminGrants from './AdminGrants.vue'
import AdminLogs from './AdminLogs.vue'
import AdminReconcile from './AdminReconcile.vue'
import AdminDevices from './AdminDevices.vue'
import AdminRecords from './AdminRecords.vue'
import FirstRecord from './FirstRecord.vue'
import OnboardHome from './OnboardHome.vue'
import TutorialWorkshop from './TutorialWorkshop.vue'
import VaultPage from './VaultPage.vue'
import MyAccounts from './MyAccounts.vue'

const me = ref(null)
const checking = ref(true)
const tab = ref('submit')
const form = ref({ username: '', password: '' })
const logging = ref(false)
const isDesktop = useDesktop()

// 电脑上侧栏的图标；手机上的顶部 tab 不用
const ICONS = { ledger: Notebook, reconcile: Money, devices: Monitor, records: Files, submit: EditPen, grants: Share, logs: View, mine: Unlock,
  onboard: Shop, tutorials: Reading, vault: Lock, myvault: Key }
// 台账一个法人都没有时管理员先建第一条，建好之前别的页面都不给进——密码库除外：
// 绑验证器、存密码和台账有没有法人无关，老板第一次进来就要能绑
const firstRun = computed(() => !!me.value?.is_admin && !!me.value?.empty)
const blocked = computed(() => firstRun.value && tab.value !== 'vault')
const tabLabel = computed(() => (blocked.value ? '先建第一条台账' : tabs.value.find((t) => t.key === tab.value)?.label || ''))

const tabs = computed(() => {
  const base = [
    { key: 'submit', label: '填报' },
    { key: 'mine', label: '开放给我的' },
  ]
  // 第五步：审核人（主管）看「开店」「开店教程」；派了开店单的员工看「我的开店」；给了账号的看「我的账号」
  const m = me.value || {}
  const extra = []
  if (m.is_reviewer) extra.push({ key: 'onboard', label: '开店' }, { key: 'tutorials', label: '开店教程' })
  else if (m.my_cases) extra.push({ key: 'onboard', label: '我的开店' })
  if (m.my_vault && !m.is_admin) extra.push({ key: 'myvault', label: '我的账号' })
  if (!m.is_admin) return [...extra, ...base]
  // 管理员什么都看得到，用不着「开放给我的」
  return [
    { key: 'ledger', label: '台账' },
    { key: 'reconcile', label: '对账' },
    { key: 'devices', label: '设备与代理' },
    { key: 'records', label: '其他台账' },
    ...extra,
    { key: 'vault', label: '密码库' },
    base[0],
    { key: 'grants', label: '开放记录' },
    { key: 'logs', label: '查看记录' },
  ]
})

async function loadMe() {
  checking.value = true
  try {
    // 过期的令牌记下不再用，换下一个来源再试；断网、5xx 不丢令牌
    for (let token = getToken(); token; token = getToken()) {
      try {
        const { data } = await api.get('/ledger/me')
        me.value = data
        if (data.is_admin) tab.value = 'ledger'
        else if (data.is_reviewer || data.my_cases) tab.value = 'onboard'
        settleToken()
        return
      } catch (err) {
        me.value = null
        if (err?.response?.status !== 401) {
          ElMessage.error(errText(err, '连不上服务器，稍后刷新再试'))
          return
        }
        skipToken(token)
      }
    }
  } finally {
    checking.value = false
  }
}

async function login() {
  if (!form.value.username.trim() || !form.value.password) {
    ElMessage.warning('账号和密码都要填')
    return
  }
  logging.value = true
  try {
    const { data } = await api.post('/auth/h5-login', form.value)
    setToken(data.token)
    form.value.password = ''
    await loadMe()
  } catch (err) {
    ElMessage.error(errText(err, '登录失败'))
  } finally {
    logging.value = false
  }
}

function firstDone() {
  me.value = { ...me.value, empty: false }
  tab.value = 'ledger'
}

function logout() {
  // 借来的也不再借：不然一刷新又用后台 / H5 那个号登回来，退出等于没退
  forgetAll()
  me.value = null
}

onMounted(loadMe)
</script>

<template>
  <!-- 电脑（≥1024）是后台式布局：左侧竖排导航，右边顶栏 + 铺满的内容区；手机是原来的顶部标题 + tab。
       两套共用一棵树，只换外面的导航，下面的 <main> 和里面的页面不动——窗口拖过 1024 宽时
       页面不会重建，看到哪个法人、第几页、打开的开放记录都还在 -->
  <div :class="isDesktop ? 'lgd' : 'lg-page'">
    <div v-if="checking" :class="isDesktop ? 'lgd-center' : 'lg-center'">加载中…</div>

    <div v-else-if="!me && isDesktop" class="lgd-login-wrap">
      <div class="lgd-login">
        <div class="lgd-login__brand">
          <div class="lgd-logo">账</div>
          <div>
            <h1 class="lgd-login__title">大台账</h1>
            <p class="lgd-login__sub">用 ERP 账号登录</p>
          </div>
        </div>
        <el-input v-model="form.username" placeholder="账号" size="large" autocomplete="username" />
        <el-input
          v-model="form.password"
          placeholder="密码"
          type="password"
          size="large"
          show-password
          autocomplete="current-password"
          @keyup.enter="login"
        />
        <el-button type="primary" size="large" :loading="logging" @click="login">登录</el-button>
      </div>
      <footer class="lg-beian">
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">浙ICP备2026010391号-2</a>
      </footer>
    </div>

    <div v-else-if="!me" class="lg-login">
      <h1 class="lg-title">大台账</h1>
      <p class="lg-sub">用 ERP 账号登录</p>
      <el-input v-model="form.username" placeholder="账号" size="large" autocomplete="username" />
      <el-input
        v-model="form.password"
        placeholder="密码"
        type="password"
        size="large"
        show-password
        autocomplete="current-password"
        @keyup.enter="login"
      />
      <el-button type="primary" size="large" :loading="logging" @click="login">登录</el-button>
    </div>

    <div v-else :class="isDesktop ? 'lgd-layout' : 'lg-shell'">
      <aside v-if="isDesktop" class="lgd-aside">
        <div class="lgd-brand">
          <div class="lgd-logo">账</div>
          <div class="lgd-brand__name">大台账</div>
        </div>
        <el-menu
          class="lgd-menu"
          background-color="transparent"
          text-color="rgba(255,255,255,0.75)"
          active-text-color="#fff"
          :default-active="tab"
          @select="(k) => (tab = k)"
        >
          <el-menu-item v-for="t in tabs" :key="t.key" :index="t.key" :disabled="firstRun && !['vault', 'ledger'].includes(t.key)">
            <el-icon><component :is="ICONS[t.key]" /></el-icon>
            <span>{{ t.label }}</span>
          </el-menu-item>
        </el-menu>
        <div class="lgd-aside__foot">
          <div class="lgd-who">{{ me.name }}<span>{{ me.is_admin ? '管理员' : me.is_reviewer ? '审核人' : '业务员' }}</span></div>
          <el-button class="lgd-logout" :icon="SwitchButton" @click="logout">退出登录</el-button>
          <footer class="lg-beian lgd-beian">
            <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">浙ICP备2026010391号-2</a>
          </footer>
        </div>
      </aside>
      <template v-else>
        <header class="lg-head">
          <span class="lg-head__title">大台账</span>
          <span class="lg-head__who">{{ me.name }} · <a @click="logout">退出</a></span>
        </header>
        <nav v-if="!firstRun" class="lg-tabs">
          <button
            v-for="t in tabs"
            :key="t.key"
            :class="['lg-tab', { 'lg-tab--on': tab === t.key }]"
            @click="tab = t.key"
          >{{ t.label }}</button>
        </nav>
      </template>
      <div :class="isDesktop ? 'lgd-body' : 'lg-body'">
        <header v-if="isDesktop" class="lgd-header">
          <h1 class="lgd-header__title">{{ tabLabel }}</h1>
        </header>
        <main :class="isDesktop ? 'lgd-main' : 'lg-main'">
          <FirstRecord v-if="blocked" @done="firstDone" />
          <SubmitForm v-else-if="tab === 'submit'" />
          <MyGrants v-else-if="tab === 'mine'" :read-minutes="me.read_minutes" />
          <AdminLedger v-else-if="tab === 'ledger'" />
          <AdminGrants v-else-if="tab === 'grants'" />
          <AdminLogs v-else-if="tab === 'logs'" />
          <AdminReconcile v-else-if="tab === 'reconcile'" />
          <AdminDevices v-else-if="tab === 'devices'" />
          <AdminRecords v-else-if="tab === 'records'" />
          <OnboardHome v-else-if="tab === 'onboard'" :is-admin="me.is_admin" @goto="(k) => (tab = k)" />
          <TutorialWorkshop v-else-if="tab === 'tutorials'" :is-boss="me.is_admin" />
          <VaultPage v-else-if="tab === 'vault'" />
          <MyAccounts v-else-if="tab === 'myvault'" />
        </main>
      </div>
    </div>

    <footer v-if="!isDesktop" class="lg-beian">
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">浙ICP备2026010391号-2</a>
    </footer>
  </div>
</template>

<style>
:root {
  --lg-bg: #f5f7fa;
  --lg-card: #fff;
  --lg-ink: #1f2937;
  --lg-ink-2: #6b7280;
  --lg-line: #e5e7eb;
  --lg-accent: #2563eb;
  --lg-warn: #b45309;
  --lg-danger: #dc2626;
}
body { background: var(--lg-bg); color: var(--lg-ink); font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
.lg-page { max-width: 720px; margin: 0 auto; min-height: 100vh; display: flex; flex-direction: column; }
.lg-center { padding: 80px 16px; text-align: center; color: var(--lg-ink-2); }
.lg-login { display: flex; flex-direction: column; gap: 14px; padding: 72px 24px; }
.lg-title { margin: 0; font-size: 26px; }
.lg-sub { margin: 0 0 8px; color: var(--lg-ink-2); }
.lg-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 6px; }
.lg-head__title { font-size: 20px; font-weight: 700; }
.lg-head__who { font-size: 13px; color: var(--lg-ink-2); }
.lg-head__who a { color: var(--lg-accent); cursor: pointer; }
.lg-tabs { display: flex; gap: 6px; padding: 8px 16px; overflow-x: auto; position: sticky; top: 0; background: var(--lg-bg); z-index: 5; }
.lg-tab { flex-shrink: 0; border: 1px solid var(--lg-line); background: var(--lg-card); color: var(--lg-ink-2); border-radius: 18px; padding: 6px 11px; font-size: 14px; }
.lg-tab--on { background: var(--lg-accent); border-color: var(--lg-accent); color: #fff; }
.lg-shell, .lg-body { flex: 1; display: flex; flex-direction: column; }
.lg-main { flex: 1; padding: 8px 16px 24px; }
.lg-card { background: var(--lg-card); border: 1px solid var(--lg-line); border-radius: 10px; padding: 14px; margin-bottom: 12px; }
.lg-muted { color: var(--lg-ink-2); font-size: 13px; }
.lg-warn { color: var(--lg-warn); }
.lg-tag { display: inline-block; font-size: 12px; padding: 1px 6px; border-radius: 4px; background: #fffbeb; color: var(--lg-warn); border: 1px solid #fde68a; margin-left: 6px; }
.lg-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.lg-beian { text-align: center; padding: 16px; font-size: 12px; }
.lg-beian a { color: #8c8c8c; text-decoration: none; }
.lg-form .el-form-item { margin-bottom: 12px; }
.lg-section { font-size: 13px; font-weight: 700; color: var(--lg-ink-2); margin: 14px 0 8px; }

/* ---------- 电脑（≥1024，见 useDesktop.js）：全部挂在 .lgd 下面，手机上不出现这些 class ---------- */
.lgd { --lgd-dark: #001529; --lgd-primary: #1677ff; --lgd-page: #f0f2f5; --lgd-line: #f0f0f0; --lgd-ink-2: #8c8c8c; background: var(--lgd-page); min-height: 100vh; }
.lgd *, .lgd *::before, .lgd *::after { box-sizing: border-box; }
.lgd-center { padding: 120px 16px; text-align: center; color: var(--lg-ink-2); }
.lgd-logo { width: 36px; height: 36px; border-radius: 8px; background: linear-gradient(135deg, #1677ff, #003a70); color: #fff; font-size: 15px; font-weight: 700; line-height: 36px; text-align: center; flex-shrink: 0; }

.lgd-login-wrap { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.lgd-login { width: 400px; background: #fff; border: 1px solid var(--lgd-line); border-radius: 10px; box-shadow: 0 6px 24px rgba(0, 21, 41, 0.08); padding: 32px 32px 28px; display: flex; flex-direction: column; gap: 14px; }
.lgd-login__brand { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.lgd-login__title { margin: 0; font-size: 20px; }
.lgd-login__sub { margin: 2px 0 0; font-size: 13px; color: var(--lg-ink-2); }

.lgd-layout { display: flex; height: 100vh; overflow: hidden; }
.lgd-aside { width: 200px; flex-shrink: 0; display: flex; flex-direction: column; height: 100%; overflow: hidden; background: var(--lgd-dark); }
.lgd-brand { display: flex; align-items: center; gap: 12px; padding: 20px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
.lgd-brand__name { font-size: 16px; font-weight: 600; color: #fff; }
.lgd-menu { flex: 1; min-height: 0; overflow-y: auto; border-right: none; padding: 8px; }
.lgd-menu .el-menu-item { height: 44px; margin-bottom: 4px; border-radius: 8px; }
.lgd-menu .el-menu-item:hover { background: rgba(255, 255, 255, 0.08) !important; }
.lgd-menu .el-menu-item.is-active { background: var(--lgd-primary) !important; color: #fff !important; }
.lgd-aside__foot { padding: 16px; border-top: 1px solid rgba(255, 255, 255, 0.08); }
.lgd-who { color: #fff; font-size: 14px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: baseline; }
.lgd-who span { font-size: 12px; color: rgba(255, 255, 255, 0.5); }
.lgd-logout { width: 100%; color: rgba(255, 255, 255, 0.75); border: 1px solid rgba(255, 255, 255, 0.15); background: transparent; }
.lgd-logout:hover, .lgd-logout:focus { color: #fff; border-color: rgba(255, 255, 255, 0.3); background: rgba(255, 255, 255, 0.06); }
.lgd-beian { padding: 12px 0 0; }
.lgd-beian a { color: rgba(255, 255, 255, 0.45); }
.lgd-body { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; overflow: hidden; background: var(--lgd-page); }
.lgd-header { height: 56px; flex-shrink: 0; display: flex; align-items: center; padding: 0 24px; background: #fff; border-bottom: 1px solid var(--lgd-line); box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04); }
.lgd-header__title { margin: 0; font-size: 18px; font-weight: 600; }
.lgd-main { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 24px 24px; }

/* 后台同款的白卡片：头（标题 + 工具条）+ 身（表格贴边） */
.lgd-card { background: #fff; border: 1px solid var(--lgd-line); border-radius: 8px; margin-bottom: 16px; }
.lgd-card__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--lgd-line); flex-wrap: wrap; }
.lgd-card__title { margin: 0; font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.lgd-card__title small { font-size: 13px; font-weight: 400; color: var(--lgd-ink-2); }
.lgd-card__body { padding: 20px; }
.lgd-card__body--table { padding: 0; }
.lgd-card .el-table th.el-table__cell { background: #fafafa; color: var(--lgd-ink-2); font-weight: 500; }
.lgd-card__body--table .el-table { border-radius: 0 0 8px 8px; }
.lgd-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lgd-pager { display: flex; justify-content: flex-end; padding: 12px 20px; }
.lgd-muted { color: var(--lgd-ink-2); font-size: 12px; }
.lgd-danger { color: var(--lg-danger); }
.lgd-ok { color: #047857; }
.lgd-num { font-variant-numeric: tabular-nums; }
.lgd-back { color: var(--lgd-primary); cursor: pointer; font-size: 14px; white-space: nowrap; }
.lgd .el-table .el-button.is-link + .el-button.is-link { margin-left: 10px; }
</style>
