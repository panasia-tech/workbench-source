<script setup>
// 采购工作台 W06：公司内部采购价格表。首报 / 目标 / 最高分开填，空着就是「待定」；改价加新版，旧版和锁过的采购单都还在。
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import api from '../api'

const loading = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const q = ref('')
const accessories = ref({})

const EMPTY = { brand: '', model: '', spec: '', accessory: 'unit', first_offer: '', target: '', ceiling: '', source: '', note: '' }
const editOpen = ref(false)
const edit = ref({ ...EMPTY })
const editing = ref(false) // true = 给已有的加一版（型号那几栏锁住）
const saving = ref(false)
const histOpen = ref(false)
const hist = ref([])

async function load(p = 1) {
  loading.value = true
  try {
    const { data } = await api.get('/purchase/prices', { params: { q: q.value.trim() || undefined, page: p, size: 50 } })
    list.value = data.items
    total.value = data.total
    accessories.value = data.accessories
    page.value = p
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    loading.value = false
  }
}

function startAdd() {
  edit.value = { ...EMPTY }
  editing.value = false
  editOpen.value = true
}

function startNewVersion(row) {
  edit.value = { ...EMPTY, ...row, spec: row.spec || '', first_offer: row.first_offer || '', target: row.target || '', ceiling: row.ceiling || '', source: '', note: '' }
  editing.value = true
  editOpen.value = true
}

async function save() {
  saving.value = true
  try {
    const body = { ...edit.value }
    for (const k of ['spec', 'first_offer', 'target', 'ceiling', 'source', 'note']) if (body[k] === '') body[k] = null
    await api.post('/purchase/prices', body)
    ElMessage.success(editing.value ? '已加新版，旧版留着' : '已加上')
    editOpen.value = false
    await load(page.value)
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  } finally {
    saving.value = false
  }
}

async function showHistory(row) {
  try {
    hist.value = (await api.get(`/purchase/prices/${row.id}/history`)).data.items
    histOpen.value = true
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  }
}

async function retire(row) {
  try {
    await ElMessageBox.confirm(`不收「${row.brand} ${row.model} ${row.spec || ''} ${row.accessory_label}」了？当前这版停用，历史和锁过的采购单还在。`,
      '停用', { type: 'warning', confirmButtonText: '停用', cancelButtonText: '不停' })
  } catch {
    return
  }
  try {
    await api.delete(`/purchase/prices/${row.id}`)
    ElMessage.success('已停用')
    await load(page.value)
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '停用失败')
  }
}

const money = (v) => (v == null ? '待定' : `¥${v}`)
const day = (v) => (v ? v.slice(0, 10) : '—')

onMounted(() => load())
</script>

<template>
  <div class="page">
    <el-card shadow="never">
      <template #header>
        <div class="pp-head">
          <span>采购价格表 <small class="pp-muted">共 {{ total }} 条 · 首报 / 目标 / 最高空着就是「待定」，不拿来自动报价</small></span>
          <div class="pp-tools">
            <el-input v-model="q" placeholder="搜品牌、型号、规格" clearable style="width: 220px" @keyup.enter="load(1)" @clear="load(1)" />
            <el-button @click="load(1)">查询</el-button>
            <el-button type="primary" :icon="Plus" @click="startAdd">加一条</el-button>
          </div>
        </div>
      </template>
      <el-table v-loading="loading" :data="list" size="small" stripe>
        <el-table-column label="型号" min-width="200">
          <template #default="{ row }">{{ row.brand }} {{ row.model }} <span class="pp-muted">{{ row.spec || '' }}</span></template>
        </el-table-column>
        <el-table-column label="配件" prop="accessory_label" width="170" />
        <el-table-column label="首报" width="100" align="right"><template #default="{ row }"><span :class="{ 'pp-pending': !row.first_offer }">{{ money(row.first_offer) }}</span></template></el-table-column>
        <el-table-column label="目标" width="100" align="right"><template #default="{ row }"><span :class="{ 'pp-pending': !row.target }">{{ money(row.target) }}</span></template></el-table-column>
        <el-table-column label="最高" width="100" align="right"><template #default="{ row }"><span :class="{ 'pp-pending': !row.ceiling }">{{ money(row.ceiling) }}</span></template></el-table-column>
        <el-table-column label="版本" width="110"><template #default="{ row }">v{{ row.version }} · {{ day(row.effective_from) }}</template></el-table-column>
        <el-table-column label="依据" prop="source" min-width="140" show-overflow-tooltip />
        <el-table-column label="" width="190" align="center">
          <template #default="{ row }">
            <el-button link type="primary" @click="startNewVersion(row)">改价</el-button>
            <el-button link @click="showHistory(row)">历次价格</el-button>
            <el-button link type="danger" @click="retire(row)">停用</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination v-if="total > 50" class="pp-pager" layout="prev, pager, next" :total="total" :page-size="50" :current-page="page" @current-change="load" />
    </el-card>

    <el-dialog v-model="editOpen" :title="editing ? '改价（加一版，旧版留着）' : '加一条'" width="520px">
      <el-form label-width="90px">
        <el-form-item label="品牌"><el-input v-model="edit.brand" :disabled="editing" /></el-form-item>
        <el-form-item label="型号"><el-input v-model="edit.model" :disabled="editing" /></el-form-item>
        <el-form-item label="规格"><el-input v-model="edit.spec" :disabled="editing" placeholder="容量、尺寸……同型号几种规格要分开" /></el-form-item>
        <el-form-item label="配件">
          <el-select v-model="edit.accessory" :disabled="editing" style="width: 100%">
            <el-option v-for="(label, key) in accessories" :key="key" :label="label" :value="key" />
          </el-select>
        </el-form-item>
        <el-form-item label="首报"><el-input v-model="edit.first_offer" placeholder="空着 = 待定" /></el-form-item>
        <el-form-item label="目标"><el-input v-model="edit.target" placeholder="空着 = 待定" /></el-form-item>
        <el-form-item label="最高"><el-input v-model="edit.ceiling" placeholder="空着 = 待定；采购不能超过" /></el-form-item>
        <el-form-item label="依据"><el-input v-model="edit.source" placeholder="谁定的、按哪次行情" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="edit.note" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="histOpen" title="历次价格" width="640px">
      <el-table :data="hist" size="small">
        <el-table-column label="版本" width="70"><template #default="{ row }">v{{ row.version }}</template></el-table-column>
        <el-table-column label="首报" width="90" align="right"><template #default="{ row }">{{ money(row.first_offer) }}</template></el-table-column>
        <el-table-column label="目标" width="90" align="right"><template #default="{ row }">{{ money(row.target) }}</template></el-table-column>
        <el-table-column label="最高" width="90" align="right"><template #default="{ row }">{{ money(row.ceiling) }}</template></el-table-column>
        <el-table-column label="生效" width="100"><template #default="{ row }">{{ day(row.effective_from) }}</template></el-table-column>
        <el-table-column label="状态" width="90"><template #default="{ row }">{{ row.superseded_at ? '已替换' : '现在用' }}</template></el-table-column>
        <el-table-column label="依据" prop="source" show-overflow-tooltip />
      </el-table>
    </el-dialog>
  </div>
</template>

<style scoped>
.pp-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.pp-tools { display: flex; gap: 8px; }
.pp-muted { color: #909399; font-weight: normal; }
.pp-pending { color: #b45309; }
.pp-pager { margin-top: 12px; justify-content: flex-end; }
</style>
