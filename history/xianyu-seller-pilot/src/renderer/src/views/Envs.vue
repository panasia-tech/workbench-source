<!--
  浏览器环境：自己建环境、自己定用途、自己登录账号。

  这页之前不存在，环境是靠命令行（adspower-executor 的 manage.py envs）建的，
  用途改一次要人去翻配置文件——本该点一下的事变成了配置问题。

  三条规矩在界面上是硬的，不是提示语：
    1. **用途必填**。用途就是归属：分组名 → 谁驱动（本机代理按这张表强制执行）。
       没有用途的环境谁也不会驱动它，等于建了个孤儿。
    2. **用途只能从登记表里选**，不给自由填。打错一个字就是一个没人认领的分组。
    3. **删除不可逆**，指纹与 cookie 一起没，登录态要重新扫码——所以要二次确认。

  和「账号配置」页的分工：那页管「账号 ↔ 环境」的绑定，这页管环境本身的生老病死。
-->
<template>
  <div class="envs page">
    <div class="bar">
      <div class="title"><b>浏览器环境</b></div>
      <el-tag v-if="purposeSource === 'broker'" size="small" type="success" effect="plain">归属保护生效中</el-tag>
      <el-tag v-else size="small" type="warning" effect="plain">归属保护未生效</el-tag>
      <el-button size="small" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      <el-button size="small" :icon="Setting" @click="purposeDrawer = true">用途登记</el-button>
      <el-button size="small" :icon="Link" @click="connVisible = true">AdsPower 连接</el-button>
      <el-button size="small" type="primary" :icon="Plus" @click="openCreate">新建环境</el-button>
      <span class="stamp">
        <el-tooltip v-if="ver.label" :content="ver.tip" placement="bottom">
          <span class="ver">执行端 {{ ver.label }}</span>
        </el-tooltip>
        <el-button v-if="ver.canUpdate" size="small" type="warning" plain :loading="updatingExec" @click="updateExec">
          更新到 {{ ver.latestName }}
        </el-button>
        {{ stamp }}
      </span>
    </div>

    <div class="page-body">
    <el-alert v-if="purposeSource === 'fallback'" type="warning" :closable="false" show-icon class="err">
      本机代理（adspower-executor 的 <code>manage.py broker</code>）没起，用途登记表用的是内置兜底，
      <b>归属保护当前不生效</b>——两个驱动方可能同时驱动同一个浏览器、互相抢标签页。环境照样能管，但请尽快把代理起起来。
    </el-alert>
    <el-alert v-if="paidOnly" type="info" :closable="false" show-icon class="err">
      AdsPower 免费版只能列出<b>正在运行</b>的环境，下面这张表不完整；完整清单需要付费版的环境枚举权限。
    </el-alert>
    <el-alert v-if="error" type="error" :closable="false" show-icon class="err">
      {{ error }}
      <!-- 连不上是这一页最常见的坏情况，而它几乎总是同一个原因：AdsPower 没开、
           Local API 没开、或端口不是默认的。把「怎么办」摆在报错旁边，不要让人
           先去问人再来改。 -->
      <el-button v-if="looksLikeConnectionError" link type="primary" :icon="QuestionFilled"
                 class="how" @click="connVisible = true">怎么办</el-button>
    </el-alert>

    <el-table v-loading="loading" :data="envs" size="small" class="tbl" empty-text="AdsPower 里还没有环境">
      <el-table-column label="环境" min-width="180">
        <template #default="{ row }">
          <b>{{ row.name || '（未命名）' }}</b>
          <div class="sub mono">{{ row.id }}<span v-if="row.seq"> · #{{ row.seq }}</span></div>
        </template>
      </el-table-column>

      <el-table-column label="用途" min-width="150">
        <template #default="{ row }">
          <el-select
            :model-value="row.group || ''"
            size="small"
            placeholder="未登记"
            :loading="busyId === row.id"
            @change="(value) => changePurpose(row, value)"
          >
            <el-option v-for="(owner, name) in purposes" :key="name" :value="name" :label="purposeLabel(name, owner)" />
          </el-select>
        </template>
      </el-table-column>

      <el-table-column label="谁驱动" min-width="120">
        <template #default="{ row }">
          <el-tag size="small" :type="ownerType(row.owner)" effect="plain">{{ ownerLabel(row.owner) }}</el-tag>
        </template>
      </el-table-column>

      <el-table-column label="代理" min-width="92">
        <template #default="{ row }">
          <el-tag v-if="row.hasProxy" size="small" type="success" effect="plain">已配</el-tag>
          <el-tooltip v-else content="没配代理的环境跑不了活，而且会和别的环境走同一个出口 IP——指纹隔离就白做了" placement="top">
            <el-tag size="small" type="danger" effect="plain">未配</el-tag>
          </el-tooltip>
        </template>
      </el-table-column>

      <el-table-column label="登录账号" min-width="170">
        <template #default="{ row }">
          <template v-if="login[row.id]">
            <el-tag v-if="login[row.id].loggedIn" size="small" type="success" effect="plain">{{ login[row.id].nick }}</el-tag>
            <el-tag v-else size="small" type="info" effect="plain">未登录</el-tag>
            <div v-if="login[row.id].reason" class="sub">{{ login[row.id].reason }}</div>
          </template>
          <el-button v-else-if="envActive(row)" size="small" link :loading="busyId === row.id" @click="readLogin(row, false)">
            读登录态
          </el-button>
          <span v-else class="sub">环境没在跑</span>
        </template>
      </el-table-column>

      <el-table-column label="状态" min-width="86">
        <template #default="{ row }">
          <el-tag size="small" :type="row.running ? 'success' : 'info'" effect="plain">
            {{ row.running ? '运行中' : '已停止' }}
          </el-tag>
        </template>
      </el-table-column>

      <el-table-column label="执行端" min-width="130">
        <template #default="{ row }">
          <template v-if="row.owner === 'executor'">
            <el-tag size="small" :type="executorRunning(row) ? 'success' : 'info'" effect="plain">
              {{ executorRunning(row) ? '在跑' : '没跑' }}
            </el-tag>
            <div class="sub">{{ executorRunning(row) ? rowVersion(row) : '' }}</div>
          </template>
          <span v-else class="sub">—</span>
        </template>
      </el-table-column>

      <!-- 钉在右边：八列最小宽度加起来 1228px，默认窗口里表格只有一千出头，
           「登录闲鱼」「删除」原本被挤到可视区外，得横着拖表格才找得到。 -->
      <el-table-column label="操作" min-width="300" fixed="right">
        <template #default="{ row }">
          <template v-if="row.owner === 'executor'">
            <el-button v-if="!executorRunning(row)" size="small" :loading="busyId === row.id" @click="startExecutor(row)">
              启动执行端
            </el-button>
            <el-button v-else size="small" type="warning" plain :loading="busyId === row.id" @click="stopExecutor(row)">
              停执行端并关浏览器
            </el-button>
          </template>
          <template v-else>
            <el-button v-if="!row.running" size="small" :loading="busyId === row.id" @click="start(row)">启动</el-button>
            <el-button v-else size="small" :loading="busyId === row.id" @click="stop(row)">关闭</el-button>
          </template>
          <el-button v-if="!login[row.id]?.loggedIn" size="small" :icon="Key" :loading="busyId === row.id" @click="goLogin(row)">登录闲鱼</el-button>
          <el-button v-else size="small" link :loading="busyId === row.id" @click="goLogin(row)">重登</el-button>
          <el-button size="small" type="danger" text :icon="Delete" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    </div>

    <!-- 用途登记：配一次就不动的东西，不该常驻页面占掉半屏。
         它原来是第二张无上限的表，跟环境表上下堆着——环境一多，用途表就被推到
         视口外，而它恰恰是解释「谁驱动」那一列的地方。 -->
    <el-drawer v-model="purposeDrawer" title="用途登记" size="min(560px, 92vw)" :append-to-body="true">
      <p class="drawer-intro">
        分组 → 谁驱动。它是「同机两个驱动各管哪些环境」的唯一说明书：
        <b>没登记的分组，本机代理一律拒绝驱动</b>，所以删一条不等于清理，等于让那批环境没人管。
      </p>
      <div class="bar sub">
        <el-button size="small" :icon="Plus" @click="openPurpose()">新增用途</el-button>
      </div>


    <el-table :data="purposeRows" size="small" class="tbl" empty-text="还没有登记任何用途">
      <el-table-column label="用途" min-width="140">
        <template #default="{ row }"><b>{{ row.name }}</b></template>
      </el-table-column>
      <el-table-column label="谁驱动" min-width="150">
        <template #default="{ row }">
          <el-tag size="small" :type="ownerType(row.owner)" effect="plain">{{ ownerLabel(row.owner) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="下面挂了几个环境" min-width="130">
        <template #default="{ row }">
          <span :class="{ muted: !row.count }">{{ row.count }} 个</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" min-width="150">
        <template #default="{ row }">
          <el-button size="small" @click="openPurpose(row)">改</el-button>
          <el-button size="small" type="danger" text :icon="Delete" @click="removePurpose(row)">删</el-button>
        </template>
      </el-table-column>
    </el-table>
    </el-drawer>


    <el-dialog v-model="purposeVisible" :title="purposeForm.isNew ? '新增用途' : `改用途「${purposeForm.name}」`" width="470px">
      <el-form label-width="92px">
        <el-form-item label="用途名">
          <el-input v-model="purposeForm.name" :disabled="!purposeForm.isNew" maxlength="32" placeholder="例如：采购 / 行情 / 售后" />
          <div class="hint">就是 AdsPower 里的分组名。</div>
        </el-form-item>
        <el-form-item label="谁驱动">
          <el-select v-model="purposeForm.owner" placeholder="必选">
            <el-option v-for="o in validOwners" :key="o" :value="o" :label="ownerLabel(o)" />
          </el-select>
          <div class="hint">
            执行端 = 常驻跑消息门铃与会话任务；桌面端 = 这台客户端自己开窗口用；
            隔离 = 两边都不碰，用于停用或需要人工操作的环境。
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="purposeVisible = false">取消</el-button>
        <el-button type="primary" :loading="purposeSaving" @click="submitPurpose">保存</el-button>
      </template>
    </el-dialog>

    <!-- AdsPower 连接：地址能改 + 教程就在旁边。
         端口写死过一次，现场遇到非默认端口就只能干瞪眼（老板 2026-09-19 原话：
         「这个端口不能改吗？怎么没有修改的地方」）。会随机器变的东西是一个输入框，
         不是一次提问。 -->
    <el-dialog v-model="connVisible" title="AdsPower 连接" width="560px" @open="loadConn">
      <el-form label-width="110px" label-position="left">
        <el-form-item label="本体地址">
          <el-input v-model="conn.url" placeholder="http://127.0.0.1:50325" spellcheck="false" />
          <div class="hint">
            AdsPower 的 Local API 地址。默认端口 50325；你的 AdsPower 改过端口就填改后的。
          </div>
        </el-form-item>
        <el-form-item label="归属代理">
          <span class="mono fixed">http://127.0.0.1:50326</span>
          <div class="hint">
            adspower-executor 的 <code>manage.py broker</code>，是我们自己的组件，固定不改。
            它没起时会自动降级直连上面那个地址。
          </div>
        </el-form-item>
        <el-form-item v-if="conn.result" label="测试结果">
          <el-tag :type="conn.ok ? 'success' : 'danger'" effect="plain">{{ conn.result }}</el-tag>
        </el-form-item>
      </el-form>

      <el-divider content-position="left">连不上？照这个顺序查</el-divider>
      <ol class="steps">
        <li>AdsPower 客户端开着吗——它关着时这个接口根本不存在。</li>
        <li>AdsPower 里的 <b>Local API 开了吗</b>，开了之后它会显示自己在用哪个端口。</li>
        <li>那个端口跟上面填的一致吗？不一致就改上面这一栏。</li>
        <li>还要用归属保护的话，再起 adspower-executor 的 <code>manage.py broker</code>。</li>
      </ol>
      <div class="docs">
        <span class="hint">AdsPower 官方文档：</span>
        <el-button link type="primary" @click="openDoc('intro')">Local API 介绍（含开启步骤）</el-button>
        <el-button link type="primary" @click="openDoc('api')">接口文档（含使用前准备）</el-button>
        <el-button link type="primary" @click="openDoc('help')">API &amp; MCP 帮助中心</el-button>
      </div>

      <template #footer>
        <el-button @click="connVisible = false">关闭</el-button>
        <el-button :loading="conn.testing" @click="testConn">测试连接</el-button>
        <el-button type="primary" :loading="conn.saving" @click="saveConn">保存并刷新</el-button>
      </template>
    </el-dialog>

    <!-- 找不到执行端时自己装：几十 MB 要下一会儿，进度摆出来，不让人以为点了没反应。
         装的过程中关不掉——关了也停不下后台的下载，只会让人以为装完了。 -->
    <el-dialog v-model="install.visible" :title="install.upgrade ? '正在更新执行端' : '正在安装执行端'" width="420px" :append-to-body="true"
               :close-on-click-modal="false" :close-on-press-escape="false" :show-close="false">
      <p class="install-text">{{ installText }}</p>
      <el-progress :percentage="installPercent" :indeterminate="!installMeasured" :duration="2"
                   :show-text="installMeasured" />
    </el-dialog>

    <el-dialog v-model="createVisible" title="新建环境" width="520px">
      <el-form label-width="92px">
        <el-form-item label="环境名">
          <el-input v-model="form.name" placeholder="例如：采购-张三 / 行情爬虫02" maxlength="40" show-word-limit />
          <div class="hint">盘点时全靠它认人，写清楚归谁用。</div>
        </el-form-item>
        <el-form-item label="用途">
          <el-select v-model="form.purpose" placeholder="必选">
            <el-option v-for="(owner, name) in purposes" :key="name" :value="name" :label="purposeLabel(name, owner)" />
          </el-select>
          <div class="hint">选错可以随时改。</div>
        </el-form-item>
        <el-form-item label="代理">
          <el-switch v-model="form.useProxy" active-text="配 socks5" inactive-text="不走代理" />
          <div class="hint">
            出口 IP 必须境内，境外会频繁触发人脸验证；<b>两个环境别共用同一个出口</b>，那正是指纹隔离要防的。
          </div>
        </el-form-item>
        <template v-if="form.useProxy">
          <el-form-item label="主机 : 端口">
            <div class="row">
              <el-input v-model="form.proxyHost" placeholder="127.0.0.1" />
              <el-input v-model="form.proxyPort" placeholder="1080" style="max-width: 110px" />
            </div>
          </el-form-item>
          <el-form-item label="账号 : 密码">
            <div class="row">
              <el-input v-model="form.proxyUser" placeholder="可留空" />
              <el-input v-model="form.proxyPass" type="password" placeholder="可留空" show-password />
            </div>
            <div class="hint">凭据只透传给 AdsPower，本端不落库、不回显——列表里只显示「配没配」。</div>
          </el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Key, Link, Plus, QuestionFilled, Refresh, Setting } from '@element-plus/icons-vue'

const envs = ref([])
const purposes = ref({})
const purposeSource = ref('')
const paidOnly = ref(false)
const login = reactive({})
const loading = ref(false)
const creating = ref(false)
const busyId = ref('')
const error = ref('')
const stamp = ref('')
const createVisible = ref(false)
const validOwners = ref(['executor', 'desktop', 'none'])
const purposeVisible = ref(false)
// 用途登记收进抽屉：配一次就不动的东西不该常驻页面
const purposeDrawer = ref(false)
const purposeSaving = ref(false)
const purposeForm = reactive({ name: '', owner: 'executor', isNew: true })
const connVisible = ref(false)
// 执行端自动安装的进度（主进程推过来；找不到执行端时，点「启动执行端」「登录闲鱼」会先装）
const install = reactive({ visible: false, phase: '', received: 0, total: 0, upgrade: false })
const installMeasured = computed(() => install.phase === 'download' && install.total > 0)
const installPercent = computed(() => (installMeasured.value
  ? Math.min(100, Math.round((install.received / install.total) * 100)) : 100))
const installText = computed(() => {
  const mb = (n) => (n / 1048576).toFixed(1)
  if (install.phase === 'download') {
    const what = install.upgrade ? '新版执行端' : '执行端'
    return install.total ? `正在下载${what} ${mb(install.received)} / ${mb(install.total)} MB` : `正在下载${what}…`
  }
  if (install.phase === 'extract') return '正在解压…'
  if (install.phase === 'config') return install.upgrade ? '正在换上新版…' : '正在写配置…'
  return ''
})
const conn = reactive({ url: '', testing: false, saving: false, result: '', ok: false })
// 执行端版本：disk = 本机下好的，running = 每个在跑的实际跑的，latest = 线上最新
const versions = ref(null)
const updatingExec = ref(false)
const ver = computed(() => {
  const v = versions.value
  if (!v || !v.kind) return { label: '' }
  const latest = v.latest
  const running = Object.values(v.running || {})
  const behind = latest ? running.filter((r) => r.stale || r.codeVersion < latest.codeVersion).length : 0
  const diskBehind = latest && (v.disk?.codeVersion || 0) < latest.codeVersion
  // 显示在跑里最旧的那个：顶部要回答的是「这台电脑上还有没有旧的在跑」
  const oldest = running.reduce((a, r) => (!a || r.stale || r.codeVersion < a.codeVersion ? r : a), null)
  const shown = oldest ? (oldest.stale ? '旧版' : oldest.versionName) : (v.disk?.versionName || '')
  const tip = !latest
    ? '线上版本读不到，先按本机的显示'
    : behind ? `${behind} 个执行端还在跑旧代码，线上最新 ${latest.versionName}`
      : diskBehind ? `线上有 ${latest.versionName}，下次启动执行端前会先更新` : '已是最新'
  return {
    label: shown,
    tip,
    latestName: latest?.versionName || '',
    // 源码版改代码就生效，不走热更新
    canUpdate: v.kind === 'packaged' && Boolean(latest) && (behind > 0 || diskBehind)
  }
})

function rowVersion(row) {
  const r = versions.value?.running?.[row.id]
  if (!r) return '浏览器由它托管'
  if (r.stale) return '旧版，要更新'
  const latest = versions.value?.latest
  return latest && r.codeVersion < latest.codeVersion ? `${r.versionName}，要更新` : r.versionName
}

async function loadVersions() {
  try {
    versions.value = await call(() => window.erp.executorVersions(), '读取执行端版本失败')
  } catch {
    versions.value = null   // 少一行版本显示，不挡页面
  }
}

async function updateExec() {
  updatingExec.value = true
  try {
    const res = await call(() => window.erp.executorUpdate(), '更新执行端失败')
    const done = res.results.filter((r) => r.ok)
    const skipped = res.results.filter((r) => r.skipped)
    const failed = res.results.filter((r) => !r.ok && !r.skipped)
    const requeued = res.results.reduce((n, r) => n + (r.requeued?.length || 0), 0)
    if (failed.length) {
      ElMessage.error(`${failed.length} 个执行端没重启成：${failed.map((f) => f.note).join('；')}`)
    } else if (skipped.length) {
      ElMessage.warning(`重启了 ${done.length} 个；${skipped.length} 个手上的任务还没跑完，这次没动它，过会儿再点一次`)
    } else if (!res.results.length) {
      ElMessage.success(`新代码已下好（${res.versionName}），执行端下次启动就用上`)
    } else {
      ElMessage.success(`已更新到 ${res.versionName}，重启了 ${done.length} 个执行端，浏览器没关`
        + (requeued ? `；${requeued} 个被打断的任务已重新排队` : ''))
    }
  } catch (e) {
    ElMessage.error(e?.message || '更新执行端失败')
  } finally {
    updatingExec.value = false
    await load()
  }
}

/** 只有「连不上」才递教程：权限、付费版限制那些错，点进去看端口是白费工夫。 */
const looksLikeConnectionError = computed(() => /连不上|没有应答|没打开|Local API/.test(error.value || ''))
const form = reactive({
  name: '', purpose: '', useProxy: false,
  proxyHost: '', proxyPort: '', proxyUser: '', proxyPass: ''
})

const OWNER_LABEL = { executor: '执行端', desktop: '桌面端', none: '隔离（谁也不碰）' }

function ownerLabel(owner) {
  return OWNER_LABEL[owner] || '未登记'
}

function ownerType(owner) {
  if (owner === 'none') return 'warning'
  if (!owner) return 'info'
  return 'success'
}

function purposeLabel(name, owner) {
  return `${name} · ${ownerLabel(owner)}`
}

/** IPC 统一回 {ok, data|reason}：失败不抛，界面如实显示原因（含代理的 403 判词）。 */
async function call(fn, fallbackMessage) {
  const result = await fn()
  if (result?.ok) return result.data
  throw new Error(result?.reason || fallbackMessage)
}

/** 打开弹窗时读当前值：显示的是**实际在用**的地址，不是设置里那串可能没生效的文本。 */
async function loadConn() {
  conn.result = ''
  try {
    const cur = await window.erp.adsPowerDirectUrl()
    conn.url = cur?.url || ''
  } catch {
    conn.url = ''
  }
}

async function testConn() {
  conn.testing = true
  conn.result = ''
  try {
    // 先存再测：测的必须是人刚填的那个地址，不是上一次保存的。
    await window.erp.setSettings({ adsPowerDirectUrl: String(conn.url || '').trim() })
    const res = await window.erp.adsPowerHealth()
    conn.ok = Boolean(res?.ok)
    conn.result = res?.ok ? '通了' : (res?.reason || '连不上')
  } catch (e) {
    conn.ok = false
    conn.result = e?.message || '连不上'
  } finally {
    conn.testing = false
  }
}

async function saveConn() {
  conn.saving = true
  try {
    await window.erp.setSettings({ adsPowerDirectUrl: String(conn.url || '').trim() })
    await loadConn()
    ElMessage.success(`已保存，现在用 ${conn.url || '默认端口'}`)
    connVisible.value = false
    await load()
  } catch (e) {
    ElMessage.error(e?.message || '保存失败')
  } finally {
    conn.saving = false
  }
}

async function openDoc(key) {
  const res = await window.erp.openAdsPowerDoc(key)
  if (!res?.ok) ElMessage.warning(res?.reason || '打不开这篇文档')
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await call(() => window.erp.envList(), '读取环境清单失败')
    envs.value = data.envs || []
    purposes.value = data.purposes || {}
    purposeSource.value = data.purposeSource || ''
    try {
      const table = await call(() => window.erp.envPurposes(), '读取用途登记表失败')
      if (table?.validOwners?.length) validOwners.value = table.validOwners
      if (table?.purposes) purposes.value = table.purposes
    } catch {
      // 代理没起时读不到，上面 listEnvs 已经给了兜底表，这里不再打断
    }
    paidOnly.value = Boolean(data.paidOnly)
    stamp.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    void autoReadLoginStates()
    void loadVersions()
  } catch (e) {
    error.value = e?.message || '读取环境清单失败'
    envs.value = []
  } finally {
    loading.value = false
  }
}

// 用途表 + 每个用途下挂了几个环境（一眼能看出删掉它会影响谁）
const purposeRows = computed(() => Object.entries(purposes.value).map(([name, owner]) => ({
  name, owner, count: envs.value.filter((e) => e.group === name).length
})))

function openPurpose(row = null) {
  Object.assign(purposeForm, row
    ? { name: row.name, owner: row.owner || 'executor', isNew: false }
    : { name: '', owner: 'executor', isNew: true })
  purposeVisible.value = true
}

async function submitPurpose() {
  purposeSaving.value = true
  try {
    await call(() => window.erp.envPurposeSave(purposeForm.name, purposeForm.owner), '保存用途失败')
    ElMessage.success(`用途「${purposeForm.name.trim()}」已保存`)
    purposeVisible.value = false
    await load()
  } catch (e) {
    ElMessage.error(e?.message || '保存用途失败')
  } finally {
    purposeSaving.value = false
  }
}

async function removePurpose(row) {
  try {
    await ElMessageBox.confirm(
      `删除用途「${row.name}」？`
      + (row.count ? `它下面还有 ${row.count} 个环境，需要先把它们改到别的用途。` : '它下面没有环境，删掉是安全的。'),
      '确认删除', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await call(() => window.erp.envPurposeDelete(row.name), '删除用途失败')
    ElMessage.success(`用途「${row.name}」已删除`)
    await load()
  } catch (e) {
    // 代理会拦下"下面还有环境"这种删除并说明理由，原样显示
    ElMessage.error(e?.message || '删除用途失败')
  }
}

function openCreate() {
  Object.assign(form, {
    name: '', purpose: '', useProxy: false,
    proxyHost: '', proxyPort: '', proxyUser: '', proxyPass: ''
  })
  createVisible.value = true
}

function proxyPayload() {
  if (!form.useProxy) return null
  return {
    proxy_soft: 'other',
    proxy_type: 'socks5',
    proxy_host: form.proxyHost.trim(),
    proxy_port: form.proxyPort.trim(),
    proxy_user: form.proxyUser.trim(),
    proxy_password: form.proxyPass
  }
}

async function submitCreate() {
  creating.value = true
  try {
    const created = await call(
      () => window.erp.envCreate({ name: form.name, purpose: form.purpose, proxy: proxyPayload() }),
      '新建环境失败'
    )
    ElMessage.success(`已建环境「${created.name}」，用途「${created.group}」，由${ownerLabel(created.owner)}驱动`)
    createVisible.value = false
    await load()
  } catch (e) {
    ElMessage.error(e?.message || '新建环境失败')
  } finally {
    creating.value = false
  }
}

async function changePurpose(row, purpose) {
  if (!purpose || purpose === row.group) return
  busyId.value = row.id
  try {
    await call(() => window.erp.envSetPurpose(row.id, purpose), '改用途失败')
    ElMessage.success(`「${row.name || row.id}」的用途已改成「${purpose}」`)
    await load()
  } catch (e) {
    ElMessage.error(e?.message || '改用途失败')
    await load()   // 失败也刷新：让表里显示的用途回到它真实的样子
  } finally {
    busyId.value = ''
  }
}

function executorRunning(row) {
  return /运行中|pid=/.test(String(row.executor || ''))
}

// 浏览器「活着」的统一判定：归执行端的环境浏览器是执行端托管的，执行端在跑就算活着
// （row.running 是桌面端直控视角，对执行端的环境不作数）；其余看 row.running。
function envActive(row) {
  return row.owner === 'executor' ? executorRunning(row) : Boolean(row.running)
}

// 列表加载后静默回读在跑环境的登录态：已登录的行不再挂「登录闲鱼」按钮（按状态给按钮，
// 2026-10-13 用户拍板）。不弹消息不占 busyId——这是后台回填，不是人点的操作；
// 单个环境探测失败就当未知，按钮保持原样，绝不打扰。
async function autoReadLoginStates() {
  const rows = envs.value.filter((row) => envActive(row))
  for (const row of rows) {
    if (login[row.id]?.loggedIn) continue
    try {
      const state = await window.erp.envLoginState(row.id, false)
      if (state) login[row.id] = state
    } catch { /* 探测失败就保持未知 */ }
  }
}

/**
 * 归执行端驱动的环境，「关闭」要关的是**执行端**，不是浏览器。
 *
 * 只调 AdsPower 的 browser/stop 有两个问题：一来桌面端没资格驱动执行端的环境，
 * 会被代理 403；二来就算关掉了，执行端的浏览器自愈会在几秒内把它重开——
 * 现场看到的就是「关不掉」。所以这里先停进程，再连浏览器一起关。
 */
async function stopExecutor(row) {
  try {
    await ElMessageBox.confirm(
      `停止「${row.name || row.id}」的执行端，并关掉它的浏览器？`
      + '停掉后这个号不再实时收消息（周期扫描仍在），直到你重新启动它。',
      '停止执行端', { type: 'warning', confirmButtonText: '停止', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  busyId.value = row.id
  try {
    await call(() => window.erp.envExecutorStop(row.id, true), '停止执行端失败')
    ElMessage.success('执行端已停止，浏览器已关闭')
    delete login[row.id]
    await load()
  } catch (e) {
    ElMessage.error(e?.message || '停止执行端失败')
  } finally {
    busyId.value = ''
  }
}

async function startExecutor(row) {
  busyId.value = row.id
  try {
    await call(() => window.erp.envExecutorStart(row.id), '启动执行端失败')
    ElMessage.success('执行端已拉起（它会自己开浏览器并常驻监听消息）')
    await load()
  } catch (e) {
    ElMessage.error(e?.message || '启动执行端失败')
  } finally {
    busyId.value = ''
  }
}

async function start(row) {
  busyId.value = row.id
  try {
    await call(() => window.erp.envStart(row.id), '启动环境失败')
    ElMessage.success('环境已启动')
    await load()
  } catch (e) {
    // 代理的 403 归属判词原样显示：它说明「这个环境归另一方驱动」，
    // 是设计要的结果，不该被包装成一句含糊的「启动失败」。
    ElMessage.error(e?.message || '启动环境失败')
  } finally {
    busyId.value = ''
  }
}

async function stop(row) {
  busyId.value = row.id
  try {
    await call(() => window.erp.envStop(row.id), '关闭环境失败')
    ElMessage.success('环境已关闭')
    delete login[row.id]
    await load()
  } catch (e) {
    ElMessage.error(e?.message || '关闭环境失败')
  } finally {
    busyId.value = ''
  }
}

async function readLogin(row, openTab) {
  busyId.value = row.id
  try {
    const state = await call(() => window.erp.envLoginState(row.id, openTab), '回读登录态失败')
    login[row.id] = state
    if (state.loggedIn) ElMessage.success(`已登录：${state.nick}`)
    else if (!state.running) ElMessage.warning('环境没在跑，先启动它')
    else ElMessage.info('这个环境还没登录闲鱼')
    return state
  } catch (e) {
    ElMessage.error(e?.message || '回读登录态失败')
    return null
  } finally {
    busyId.value = ''
  }
}

/**
 * 登录闲鱼：环境没起就先起，再在里面打开闲鱼首页，然后由人扫码。
 * 登录态 AdsPower 的接口看不到，只能扫完码点「读登录态」回读昵称确认。
 */
/**
 * 登录闲鱼：先把浏览器弄起来，再在里面打开闲鱼，然后由人扫码。
 *
 * **归执行端的环境要走执行端**：直接调 AdsPower 的 browser/start 会被归属规则 403
 * （「环境属于分组「采购」，归 executor 驱动，但请求方自称 desktop」），
 * 而且就算绕过去，执行端起来时还会再开一次。所以这里按 owner 分道：
 * 执行端的环境 → 拉起执行端（它自己会开浏览器并常驻监听）；其余 → 直接开浏览器。
 *
 * 登录态回读那步**不受归属限制**：它直连调试端口，不经 Local API。
 */
async function goLogin(row) {
  const viaExecutor = row.owner === 'executor'
  const needStart = viaExecutor ? !executorRunning(row) : !row.running
  if (needStart) {
    busyId.value = row.id
    try {
      await call(
        () => (viaExecutor ? window.erp.envExecutorStart(row.id) : window.erp.envStart(row.id)),
        viaExecutor ? '启动执行端失败' : '启动环境失败'
      )
      if (viaExecutor) {
        ElMessage.success('执行端已拉起，正在开浏览器…')
        await new Promise((r) => setTimeout(r, 6000))   // 等它把浏览器开起来
      }
    } catch (e) {
      ElMessage.error(e?.message || '启动失败')
      busyId.value = ''
      return
    }
    busyId.value = ''
  }
  const state = await readLogin(row, true)
  if (state && !state.loggedIn) {
    ElMessage.info('已在该环境里打开闲鱼，请到 AdsPower 窗口扫码登录，完成后点「读登录态」确认')
  }
  await load()
}

async function remove(row) {
  // 先查它对应哪几家店铺。删环境删不掉群控账号，店铺不停的话，上架会一直往一个
  // 永远发不出去的号里派货。查不到要明说，不能当成「没有对应店铺」。
  busyId.value = row.id
  let shops = []
  let shopNote = ''
  try {
    const found = await call(() => window.erp.envShops(row.id), '查不到对应店铺')
    shops = found.shops || []
    if (!found.supported) shopNote = '服务器还查不了环境对应哪家店铺，删完请到后台「销售店铺」把对应的店停用。'
  } catch (e) {
    shopNote = `没查到它对应哪家店铺（${e?.message || e}），删完请到后台「销售店铺」核对。`
  } finally {
    busyId.value = ''
  }
  const names = shops.map((s) => `「${s.label}」`).join('、')
  try {
    await ElMessageBox.confirm(
      `删除环境「${row.name || row.id}」？`
      + '指纹与 cookie 会一并消失，登录态要重新扫码，不可恢复。'
      + (shops.length ? `对应的店铺${names}会一并停用，不再派货。` : '')
      + (executorRunning(row) ? '（它的执行端还在跑，会先停掉）' : '')
      + shopNote,
      '确认删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  busyId.value = row.id
  let shopsStopped = false
  try {
    // 先停店铺再删环境：店铺停了还能在后台再启用，环境删了回不来。店铺停不掉就
    // 不往下删，免得落个环境没了、店还开着派货。
    if (shops.length) {
      await call(() => window.erp.envDisableShops(shops.map((s) => s.id)), '停用店铺失败')
      shopsStopped = true
    }
    // 执行端还在驱动它就先停：删掉环境却留着进程，那个执行端会一直去开一个
    // 已经不存在的环境，日志里刷一串谁也看不懂的错。
    if (executorRunning(row)) {
      await call(() => window.erp.envExecutorStop(row.id, true), '停止执行端失败')
    }
    await call(() => window.erp.envDelete([row.id]), '删除环境失败')
    ElMessage.success(shops.length ? `环境已删除，店铺${names}已停用` : '环境已删除')
    delete login[row.id]
    await load()
  } catch (e) {
    ElMessage.error((shopsStopped ? `店铺${names}已停用，但` : '') + (e?.message || '删除环境失败'))
  } finally {
    busyId.value = ''
  }
}

onMounted(load)

let offInstall = null
onMounted(() => {
  offInstall = window.erp.onExecutorInstall?.((progress) => {
    Object.assign(install, { received: 0, total: 0, upgrade: false }, progress)
    install.visible = !['done', 'error'].includes(progress.phase)
  })
})
onBeforeUnmount(() => offInstall?.())
</script>

<style scoped>
.envs { gap: 12px; }
.envs .page-body { display: flex; flex-direction: column; gap: 12px; }
.envs .bar { flex: none; }
.drawer-intro { margin: 0 0 14px; padding: 11px 12px; border-radius: 8px; background: #f4faf5; color: #658071; font-size: 12px; line-height: 1.55; }
.bar { display: flex; align-items: center; gap: 10px; }
.bar.sub { margin-top: 6px; padding-top: 12px; border-top: 1px solid #e7ece9; }
.muted { color: #a8b3ad; }
.title b { font-size: 15px; }
.title small { margin-left: 8px; color: #8d9a92; font-size: 12px; }
.stamp { margin-left: auto; display: flex; align-items: center; gap: 8px; color: #8d9a92; font-size: 12px; font-variant-numeric: tabular-nums; }
.ver { cursor: default; }
.err { margin: 0; }
.tbl { width: 100%; }
.sub { color: #8d9a92; font-size: 11.5px; line-height: 1.5; margin-top: 2px; }
.mono { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; }
.hint { color: #8d9a92; font-size: 11.5px; line-height: 1.6; margin-top: 4px; }
.how { margin-left: 8px; }
.fixed { color: #8d9a92; }
.steps { margin: 0 0 10px; padding-left: 20px; color: #5c6b63; font-size: 12.5px; line-height: 1.9; }
.docs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.docs .hint { margin-top: 0; }
.row { display: flex; gap: 8px; width: 100%; }
.install-text { margin: 0 0 12px; color: #5c6b63; font-size: 13px; }
</style>
