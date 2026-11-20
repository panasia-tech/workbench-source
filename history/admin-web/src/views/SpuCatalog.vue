<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Search, Upload, Download, Document, Warning } from '@element-plus/icons-vue'
import api from '../api'

const loading = ref(false)
const list = ref([])
const brands = ref([])
const form = ref({ brand: '', model: '', spec: '', spu_code: '', note: '', sku_codes: '' })

// 筛选 / 分页
const q = ref('')
const brandFilter = ref(null)
const enabledFilter = ref(null) // null=全部 true=启用 false=停用
const unmapped = ref(false)
const page = ref(1)
const pageSize = ref(50)
const total = ref(0)

// 导入
const importing = ref(false)
const importMode = ref('merge') // merge=合并 replace=覆盖
const fileInput = ref(null)

// 追加 SKU 编码
const skuDialog = ref(false)
const skuTarget = ref(null)
const skuText = ref('')
const skuNote = ref('')
const skuSaving = ref(false)

async function load() {
  loading.value = true
  try {
    const params = { page: page.value, page_size: pageSize.value }
    if (q.value.trim()) params.q = q.value.trim()
    if (brandFilter.value) params.brand = brandFilter.value
    if (enabledFilter.value !== null) params.enabled = enabledFilter.value
    if (unmapped.value) params.unmapped = true
    const { data } = await api.get('/spu/items', { params })
    list.value = data.items
    total.value = data.total
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    loading.value = false
  }
}

async function loadBrands() {
  try {
    const { data } = await api.get('/spu/brands')
    brands.value = data
  } catch {
    brands.value = []
  }
}

function search() {
  page.value = 1
  load()
}

function onPageChange(p) {
  page.value = p
  load()
}

// ---------- 导入 / 导出 ----------
async function download(path, filename) {
  try {
    const resp = await api.get(path, { responseType: 'blob' })
    const url = window.URL.createObjectURL(resp.data)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    window.URL.revokeObjectURL(url)
  } catch {
    ElMessage.error('下载失败')
  }
}

async function triggerImport(mode) {
  importMode.value = mode
  if (mode === 'replace') {
    try {
      await ElMessageBox.confirm(
        '覆盖导入：导入后对照表将与文件严格一致——文件里没有的 SPU 会被删除，' +
          '其全部 SKU 对应一并删除且不可恢复。建议先「下载全部」做备份。确定继续？',
        '覆盖导入',
        { type: 'warning', confirmButtonText: '选择文件并导入', cancelButtonText: '取消' },
      )
    } catch {
      return
    }
  }
  fileInput.value?.click()
}

async function postImport(file, dryRun) {
  const fd = new FormData()
  fd.append('file', file)
  const { data } = await api.post('/spu/items/import', fd, {
    params: { replace: importMode.value === 'replace', dry_run: dryRun },
  })
  return data
}

function listHtml(title, lines, color) {
  if (!lines?.length) return ''
  const shown = lines.slice(0, 20).map((x) => x.replace(/</g, '&lt;')).join('<br/>')
  const more = lines.length > 20 ? `<br/>…还有 ${lines.length - 20} 条` : ''
  return `<p style="margin-top:8px;color:${color}">${title} ${lines.length} 条：</p><p>${shown}${more}</p>`
}

function summaryHtml(data) {
  return (
    `<p>有效数据 ${data.total} 行。</p>` +
    `<p>SPU：新建 ${data.spu_created}、更新 ${data.spu_updated}、删除 ${data.spu_deleted}。</p>` +
    `<p>SKU 对应：新挂 ${data.sku_created}、改挂 ${data.sku_moved}、` +
    `未变 ${data.sku_skipped}、删除 ${data.sku_deleted}。</p>`
  )
}

async function onFileChange(e) {
  const file = e.target.files?.[0]
  e.target.value = '' // 允许重复选择同一文件
  if (!file) return
  importing.value = true
  try {
    // 先预览：重复导入会覆盖已有品牌型号、改挂已有编码，先给人看清再写
    const preview = await postImport(file, true)
    if (preview.changes?.length) {
      try {
        await ElMessageBox.confirm(
          summaryHtml(preview) + listHtml('会改动已有数据', preview.changes, '#f56c6c') +
            listHtml('提示', preview.warnings, '#e6a23c'),
          '导入前确认',
          { type: 'warning', dangerouslyUseHTMLString: true, confirmButtonText: '确认导入', cancelButtonText: '取消' },
        )
      } catch {
        return
      }
    }
    const data = await postImport(file, false)
    ElMessageBox.alert(
      summaryHtml(data) + listHtml('已改动', data.changes, '#f56c6c') + listHtml('提示', data.warnings, '#e6a23c'),
      '导入完成',
      { type: 'success', dangerouslyUseHTMLString: true },
    )
    page.value = 1
    await Promise.all([load(), loadBrands()])
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '导入失败')
  } finally {
    importing.value = false
  }
}

// ---------- 待补正式编码 ----------
const pendingVisible = ref(false)
const pendingLoading = ref(false)
const pendingRows = ref([])

async function showPending() {
  pendingVisible.value = true
  pendingLoading.value = true
  try {
    const { data } = await api.get('/spu/pending-codes')
    pendingRows.value = data
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    pendingLoading.value = false
  }
}

// ---------- SPU 增删改 ----------
async function create() {
  if (!form.value.brand.trim() || !form.value.spu_code.trim()) {
    ElMessage.warning('请填写品牌与 SPU 编码')
    return
  }
  try {
    await api.post('/spu/items', {
      spu_code: form.value.spu_code.trim(),
      brand: form.value.brand.trim(),
      model: form.value.model.trim() || null,
      spec: form.value.spec.trim() || null,
      note: form.value.note.trim() || null,
      sku_codes: splitCodes(form.value.sku_codes),
    })
    ElMessage.success('添加成功')
    form.value = { brand: '', model: '', spec: '', spu_code: '', note: '', sku_codes: '' }
    await Promise.all([load(), loadBrands()])
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '添加失败')
  }
}

function splitCodes(text) {
  // 一行一个：编码本身含空格与全角逗号（如「SANC G7Pro Max」），不能按这些字符切
  return (text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

async function saveRow(row) {
  try {
    await api.patch(`/spu/items/${row.id}`, {
      spu_code: (row.spu_code || '').trim(),
      brand: (row.brand || '').trim(),
      model: (row.model || '').trim() || null,
      spec: (row.spec || '').trim() || null,
      note: (row.note || '').trim() || null,
    })
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  }
}

async function toggleEnabled(row) {
  try {
    await api.patch(`/spu/items/${row.id}`, { enabled: !row.enabled })
    row.enabled = !row.enabled
    ElMessage.success('已更新')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '更新失败')
  }
}

async function removeRow(row) {
  try {
    await ElMessageBox.confirm(
      `确定删除「${row.brand_model}／${row.spu_code}」吗？其下 ${row.sku_count} 条 SKU 对应将一并删除，` +
        '且不可恢复。只是暂时不用的话建议改为「停用」。',
      '删除 SPU',
      { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消' },
    )
    await api.delete(`/spu/items/${row.id}`)
    ElMessage.success('已删除')
    await load()
  } catch (err) {
    if (err === 'cancel' || err === 'close' || err?.message === 'cancel') return
    ElMessage.error(err.response?.data?.detail || '删除失败')
  }
}

// ---------- SKU 对应 ----------
function openSkuDialog(row) {
  skuTarget.value = row
  skuText.value = ''
  skuNote.value = ''
  skuDialog.value = true
}

async function submitSkus() {
  const codes = splitCodes(skuText.value)
  if (!codes.length) {
    ElMessage.warning('请填写 SKU 编码，一行一个')
    return
  }
  skuSaving.value = true
  try {
    const { data } = await api.post(`/spu/items/${skuTarget.value.id}/skus`, {
      sku_codes: codes,
      note: skuNote.value.trim() || null,
    })
    Object.assign(skuTarget.value, data)
    ElMessage.success('已添加')
    skuDialog.value = false
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '添加失败')
  } finally {
    skuSaving.value = false
  }
}

// 挂错款时改挂到另一个 SPU：输 SPU 编码，确认前后再改
async function moveSku(spu, sku) {
  let code
  try {
    const { value } = await ElMessageBox.prompt(
      `把 SKU 编码「${sku.sku_code}」从「${spu.brand_model}／${spu.spu_code}」改挂到哪个 SPU？输入目标 SPU 编码`,
      '改挂',
      { inputPlaceholder: '目标 SPU 编码', confirmButtonText: '下一步', cancelButtonText: '取消' },
    )
    code = (value || '').trim()
  } catch {
    return
  }
  if (!code) return
  try {
    const { data } = await api.get('/spu/items', { params: { q: code, page: 1, page_size: 20 } })
    const target = (data.items || []).find((x) => x.spu_code.toLowerCase() === code.toLowerCase())
    if (!target) {
      ElMessage.error(`没有 SPU 编码为「${code}」的商品`)
      return
    }
    if (target.id === spu.id) return
    await ElMessageBox.confirm(
      `「${sku.sku_code}」：${spu.brand_model}${spu.spec ? '（' + spu.spec + '）' : ''}／${spu.spu_code}` +
        ` → ${target.brand_model}${target.spec ? '（' + target.spec + '）' : ''}／${target.spu_code}。确定改挂？`,
      '确认改挂',
      { type: 'warning', confirmButtonText: '改挂', cancelButtonText: '取消' },
    )
    await api.patch(`/spu/skus/${sku.id}`, { spu_id: target.id })
    ElMessage.success('已改挂')
    await load()
  } catch (err) {
    if (err === 'cancel' || err === 'close') return
    ElMessage.error(err.response?.data?.detail || '改挂失败')
  }
}

async function removeSku(row, sku) {
  try {
    await ElMessageBox.confirm(`确定解除「${sku.sku_code}」与本 SPU 的对应吗？`, '删除对应', {
      type: 'warning',
      confirmButtonText: '确定删除',
      cancelButtonText: '取消',
    })
    await api.delete(`/spu/skus/${sku.id}`)
    row.skus = row.skus.filter((s) => s.id !== sku.id)
    row.sku_count = row.skus.length
    ElMessage.success('已删除')
  } catch (err) {
    if (err === 'cancel' || err === 'close' || err?.message === 'cancel') return
    ElMessage.error(err.response?.data?.detail || '删除失败')
  }
}

onMounted(() => {
  load()
  loadBrands()
})
</script>

<template>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">新增 SPU</h3>
    </div>
    <div class="page-card__body">
      <el-form label-width="100px" class="create-form" @submit.prevent>
        <el-form-item label="品牌">
          <el-input v-model="form.brand" placeholder="如 小米" class="f-short" />
        </el-form-item>
        <el-form-item label="型号">
          <el-input v-model="form.model" placeholder="如 空气净化器4PRO；无型号可留空" class="f-name" />
        </el-form-item>
        <el-form-item label="配置">
          <el-input v-model="form.spec" placeholder="影响报价的配置/地区，如 8+256G 国行" class="f-name" />
        </el-form-item>
        <el-form-item label="SPU 编码">
          <el-input v-model="form.spu_code" placeholder="69码或内部码，如 90000638" class="f-short" />
        </el-form-item>
        <el-form-item label="SKU 编码">
          <el-input
            v-model="form.sku_codes"
            type="textarea"
            :rows="3"
            placeholder="选填，一行一个（编码里可能带空格，不要用逗号分隔）"
            class="f-name"
          />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" placeholder="选填" class="f-name" />
        </el-form-item>
        <el-form-item label=" ">
          <el-button type="primary" :icon="Plus" @click="create">添加 SPU</el-button>
        </el-form-item>
      </el-form>
      <p class="form-hint">
        一个 SPU = 一款货（品牌+型号+SPU 编码），下面挂着它在仓库/各渠道的一堆 SKU 编码。
        SPU 编码唯一；一个 SKU 编码只能挂一个 SPU，挂错了在对应行上「改挂」即可。
        同款不同批次各有 SPU 编码是正常的（如盛色 N50PRO6 有 3 个），品牌+型号本身不唯一。
      </p>
    </div>
  </div>

  <div class="page-card">
    <div class="page-card__header list-header">
      <h3 class="page-card__title">SPU 对照表</h3>
      <div class="list-tools">
        <el-input
          v-model="q"
          placeholder="搜品牌 / 型号 / SPU编码 / SKU编码"
          class="tool-search"
          clearable
          :prefix-icon="Search"
          @keyup.enter="search"
          @clear="search"
        />
        <el-select v-model="brandFilter" class="tool-filter" clearable placeholder="全部品牌" @change="search">
          <el-option v-for="b in brands" :key="b" :label="b" :value="b" />
        </el-select>
        <el-select v-model="enabledFilter" class="tool-filter-sm" @change="search">
          <el-option label="全部" :value="null" />
          <el-option label="启用" :value="true" />
          <el-option label="停用" :value="false" />
        </el-select>
        <el-checkbox v-model="unmapped" @change="search">只看没挂 SKU</el-checkbox>
        <el-button @click="search">查询</el-button>
        <el-button :icon="Warning" @click="showPending">待补编码</el-button>
        <el-button :icon="Document" @click="download('/spu/items/import-template', 'spu_sku_template.xlsx')">
          模板
        </el-button>
        <el-button :icon="Download" @click="download('/spu/items/export', 'spu_sku_all.xlsx')">下载全部</el-button>
        <el-button type="primary" :icon="Upload" :loading="importing" @click="triggerImport('merge')">
          合并导入
        </el-button>
        <el-button type="danger" plain :loading="importing" @click="triggerImport('replace')">覆盖导入</el-button>
        <input ref="fileInput" type="file" accept=".xlsx,.xls" style="display: none" @change="onFileChange" />
      </div>
    </div>
    <div class="page-card__body page-card__body--table table--compact">
      <el-table v-loading="loading" :data="list" stripe empty-text="暂无 SPU" style="width: 100%" row-key="id">
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="sku-panel">
              <p v-if="!row.skus.length" class="sku-empty">还没挂 SKU 编码。</p>
              <el-table v-else :data="row.skus" size="small" stripe>
                <el-table-column label="SKU 编码" min-width="260">
                  <template #default="{ row: sku }">
                    <span :class="{ 'code-bad': sku.placeholder_reason }">{{ sku.sku_code }}</span>
                    <el-tag v-if="sku.placeholder_reason" type="warning" size="small" effect="plain" class="code-tag">
                      {{ sku.placeholder_reason }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="note" label="备注" min-width="200">
                  <template #default="{ row: sku }">{{ sku.note || '—' }}</template>
                </el-table-column>
                <el-table-column label="操作" width="130" align="center">
                  <template #default="{ row: sku }">
                    <el-button link type="primary" @click="moveSku(row, sku)">改挂</el-button>
                    <el-button link type="danger" @click="removeSku(row, sku)">删除</el-button>
                  </template>
                </el-table-column>
              </el-table>
              <el-button class="sku-add" size="small" :icon="Plus" @click="openSkuDialog(row)">追加 SKU 编码</el-button>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="品牌" width="130">
          <template #default="{ row }">
            <el-input v-model="row.brand" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="型号" min-width="180">
          <template #default="{ row }">
            <el-input v-model="row.model" size="small" placeholder="（无型号）" />
          </template>
        </el-table-column>
        <el-table-column label="配置" min-width="150">
          <template #default="{ row }">
            <!-- 同品牌同型号有多个 SPU 时，员工匹配商品靠它分清，不写就不让员工在这几个之间挑 -->
            <el-input v-model="row.spec" size="small" placeholder="如 8+256G 国行" />
          </template>
        </el-table-column>
        <el-table-column label="SPU 编码" width="170">
          <template #default="{ row }">
            <el-input v-model="row.spu_code" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="SKU 数" width="104" align="center">
          <template #default="{ row }">
            <!-- 正式/总数：挂了一堆临时码也等于没编码，只看总数会看不出来 -->
            <el-tag :type="row.real_sku_count ? 'success' : 'danger'" size="small" effect="plain">
              {{ row.real_sku_count }} / {{ row.sku_count }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="备注" min-width="150">
          <template #default="{ row }">
            <el-input v-model="row.note" size="small" placeholder="选填" />
          </template>
        </el-table-column>
        <el-table-column label="启用" width="72" align="center">
          <template #default="{ row }">
            <el-switch :model-value="row.enabled" @change="toggleEnabled(row)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" align="center" class-name="col-action">
          <template #default="{ row }">
            <el-button link type="primary" @click="saveRow(row)">保存</el-button>
            <el-button link type="primary" @click="openSkuDialog(row)">加 SKU</el-button>
            <el-button link type="danger" @click="removeRow(row)">删除</el-button>
          </template>
        </el-table-column>
        <el-table-column class-name="is-filler" label="" min-width="1" :resizable="false" />
      </el-table>
      <div class="list-pager">
        <el-pagination
          background
          layout="total, prev, pager, next"
          :total="total"
          :page-size="pageSize"
          :current-page="page"
          @current-change="onPageChange"
        />
      </div>
    </div>
  </div>

  <el-dialog v-model="pendingVisible" title="待补正式编码的款" width="720px">
    <p class="form-hint" style="margin-top: 0">
      这些款在仓库侧一个可用编码都没有——挂着临时码、占位数字或直接写了商品名的，都算没有。
      「下载清单」导出的表最后一列留空，给仓库填好正式编码后，用「合并导入」回灌即可。
    </p>
    <el-table v-loading="pendingLoading" :data="pendingRows" stripe max-height="420" empty-text="都有正式编码了">
      <el-table-column prop="brand_model" label="品牌+型号" min-width="180" />
      <el-table-column prop="spu_code" label="SPU 编码" width="150" />
      <el-table-column label="现有编码" min-width="240">
        <template #default="{ row }">
          <div v-for="(code, i) in row.codes" :key="code" class="pending-code">
            <span class="code-bad">{{ code }}</span>
            <span class="pending-reason">{{ row.reasons[i] }}</span>
          </div>
          <span v-if="!row.codes.length" class="pending-reason">还没挂任何编码</span>
        </template>
      </el-table-column>
    </el-table>
    <template #footer>
      <span class="pending-total">共 {{ pendingRows.length }} 款</span>
      <el-button @click="pendingVisible = false">关闭</el-button>
      <el-button type="primary" :icon="Download" @click="download('/spu/pending-codes/export', 'spu_pending_codes.xlsx')">
        下载清单
      </el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="skuDialog" :title="`追加 SKU 编码 — ${skuTarget?.brand_model || ''}`" width="520px">
    <el-form label-width="80px" @submit.prevent>
      <el-form-item label="SKU 编码">
        <el-input
          v-model="skuText"
          type="textarea"
          :rows="6"
          placeholder="一行一个，可整列从 Excel 粘贴&#10;513211540140&#10;SANC G7Pro Max"
        />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="skuNote" placeholder="选填，本次添加的编码统一带上" />
      </el-form-item>
    </el-form>
    <p class="form-hint">
      编码里可能带空格或全角逗号，所以只按换行拆分。已挂在别的 SPU 下的编码会被拒绝，
      需要先在原 SPU 里删除对应、或直接改挂。
    </p>
    <template #footer>
      <el-button @click="skuDialog = false">取消</el-button>
      <el-button type="primary" :loading="skuSaving" @click="submitSkus">添加</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.form-hint {
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--text-secondary, #909399);
  line-height: 1.7;
}
.create-form {
  max-width: 680px;
}
.f-name {
  width: 360px;
}
.f-short {
  width: 220px;
}
.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.list-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tool-search {
  width: 230px;
}
.tool-filter {
  width: 130px;
}
.tool-filter-sm {
  width: 100px;
}
.list-pager {
  display: flex;
  justify-content: flex-end;
  padding: 12px 0 4px;
}
.sku-panel {
  padding: 8px 16px 12px 48px;
}
.sku-empty {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--text-secondary, #909399);
}
.sku-add {
  margin-top: 10px;
}
.code-bad {
  color: #f56c6c;
}
.code-tag {
  margin-left: 8px;
}
.pending-code {
  line-height: 1.9;
}
.pending-reason {
  margin-left: 8px;
  font-size: 12px;
  color: var(--text-secondary, #909399);
}
.pending-total {
  float: left;
  line-height: 32px;
  font-size: 13px;
  color: var(--text-secondary, #909399);
}
</style>
