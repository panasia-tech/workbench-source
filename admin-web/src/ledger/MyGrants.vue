<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { errText } from './api'
import LedgerTree from './LedgerTree.vue'
import LedgerDesk from './LedgerDesk.vue'
import { useDesktop } from './useDesktop'

const isDesktop = useDesktop()
const statuses = ref({}) // 电脑上详情里显示「在用 / 暂停」要用（手机上先打开、再拉宽也要有，所以一进来就取）

const props = defineProps({ readMinutes: { type: Number, default: 10 } })

const list = ref([])
const loading = ref(false)
const opened = ref(null) // { grantId, lp, until(ms) }
const left = ref('')
let timer = null

async function load() {
  loading.value = true
  try {
    list.value = (await api.get('/ledger/my-grants')).data.items
  } catch (err) {
    ElMessage.error(errText(err, '加载失败'))
  } finally {
    loading.value = false
  }
}

function tick() {
  if (!opened.value) return
  const ms = opened.value.until - Date.now()
  if (ms <= 0) {
    // 时间到：页面上的内容立刻清掉，服务端也不会再给
    opened.value = null
    clearInterval(timer)
    ElMessage.info('时间到了，这条已经看不到了')
    load()
    return
  }
  const s = Math.ceil(ms / 1000)
  left.value = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

async function open(g) {
  if (g.state === 'waiting') {
    try {
      await ElMessageBox.confirm(`打开后只能看 ${props.readMinutes} 分钟，过了就再也看不到。现在打开吗？`, '打开', {
        confirmButtonText: '打开',
        cancelButtonText: '先不打开',
      })
    } catch {
      return
    }
  }
  try {
    const { data } = await api.post(`/ledger/my-grants/${g.id}/open`)
    // 倒计时按服务端给的截止时间（北京时间字符串）算
    const until = new Date(`${data.grant.read_until.replace(' ', 'T')}:00+08:00`).getTime()
    opened.value = { grantId: g.id, lp: data.legal_person, until }
    clearInterval(timer)
    timer = setInterval(tick, 1000)
    tick()
  } catch (err) {
    ElMessage.error(errText(err, '打不开'))
    load()
  }
}

function close() {
  opened.value = null
  clearInterval(timer)
  load()
}

onMounted(async () => {
  load()
  try {
    statuses.value = (await api.get('/ledger/options')).data.statuses || {}
  } catch {
    /* 拿不到就显示原值 */
  }
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <!-- 电脑：开放给我的是一张表；打开后上面倒计时，下面左树右详情（只读） -->
  <template v-if="isDesktop">
    <div v-if="opened">
      <div class="lgd-card">
        <div class="lgd-card__head">
          <div class="d-head">
            <el-tag type="warning" effect="dark" class="d-left">还能看 {{ left }}</el-tag>
            <span class="lgd-muted">时间到了这页会自动清掉，之后再也看不到</span>
          </div>
          <el-button @click="close">看完了</el-button>
        </div>
      </div>
      <LedgerDesk :lp="opened.lp" :statuses="statuses" />
    </div>

    <div v-else class="lgd-card">
      <div class="lgd-card__head">
        <h3 class="lgd-card__title">开放给我的 <small>打开后只能看 {{ readMinutes }} 分钟</small></h3>
        <el-button @click="load">刷新</el-button>
      </div>
      <div class="lgd-card__body--table">
        <el-table v-loading="loading" :data="list" stripe empty-text="现在没有开放给你的">
          <el-table-column label="开放原因" min-width="260">
            <template #default="{ row }">{{ row.reason || '管理员开放给你一条' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="row.state === 'reading' ? 'warning' : 'primary'">{{ row.state === 'reading' ? '正在看' : '等你打开' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="期限" min-width="200">
            <template #default="{ row }">
              <template v-if="row.state === 'reading'">正在看，{{ row.read_until }} 前</template>
              <template v-else>{{ row.expires_at }} 前要打开</template>
            </template>
          </el-table-column>
          <el-table-column label="" width="120" align="center">
            <template #default="{ row }">
              <el-button type="primary" size="small" @click="open(row)">{{ row.state === 'reading' ? '接着看' : '打开' }}</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>
  </template>

  <!-- 手机：原样 -->
  <template v-else>
    <div v-if="opened">
      <div class="lg-card lg-row">
        <span class="lg-warn">还能看 {{ left }}</span>
        <el-button size="small" @click="close">看完了</el-button>
      </div>
      <div class="lg-card"><LedgerTree :lp="opened.lp" /></div>
    </div>

    <div v-else v-loading="loading">
      <div v-if="!list.length && !loading" class="lg-card lg-muted">现在没有开放给你的</div>
      <div v-for="g in list" :key="g.id" class="lg-card">
        <div class="lg-row">
          <div>
            <div>{{ g.reason || '管理员开放给你一条' }}</div>
            <div class="lg-muted">
              <template v-if="g.state === 'reading'">正在看，{{ g.read_until }} 前</template>
              <template v-else>{{ g.expires_at }} 前要打开</template>
            </div>
          </div>
          <el-button type="primary" @click="open(g)">{{ g.state === 'reading' ? '接着看' : '打开' }}</el-button>
        </div>
      </div>
    </div>
  </template>
</template>

<style scoped>
.d-head { display: flex; align-items: center; gap: 12px; }
.d-left { font-size: 14px; font-variant-numeric: tabular-nums; }
</style>
