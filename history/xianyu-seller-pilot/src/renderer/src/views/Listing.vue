<!--
  上下架：左边挑货，右边挑店铺，发布/下架。

  # 为什么是左右两栏而不是上下堆

  这个应用里几页都长到要滚两三屏才看得完，找东西费劲（老板 2026-09-16 原话）。
  上下架是个「选一件货 → 选几家店 → 按一下」的动作，它不该需要滚动：
  两栏各自在自己的框里滚，整页不动，按钮永远在看得见的地方。

  # 数据从哪来

  全部走 ERP 既有的那套接口（小程序上架页用的同一套）。上架状态的真源是
  SkuShopListing，多一条写入口就多一处会对不上的地方。

  # 手机和浏览器分开选

  同一件货可能一部分店铺挂在真机上、一部分挂在 AdsPower 浏览器上，两条链路
  成熟度不一样。所以分组显示、分组全选——出了问题能一眼看出是哪边。
-->
<template>
  <div class="listing">
    <!-- 左：待上架的货 -->
    <aside class="pane goods">
      <header class="pane-head">
        <b>待上架</b>
        <el-input
          v-model="keyword" size="small" clearable placeholder="搜货号 / 商品名"
          :prefix-icon="Search" class="search"
        />
      </header>
      <div v-loading="loadingGoods" class="pane-body">
        <el-empty v-if="!filtered.length && !loadingGoods" description="没有待上架的货" :image-size="72" />
        <button
          v-for="g in filtered" :key="g.sku_id" type="button"
          class="good" :class="{ on: g.sku_code === current?.sku_code }"
          @click="pick(g)"
        >
          <img v-if="g.cover_url" :src="g.cover_url" alt="" class="thumb" />
          <span v-else class="thumb thumb--none">无图</span>
          <span class="good-copy">
            <span class="good-name">{{ g.product_name || '未命名商品' }}</span>
            <span class="good-sub">{{ g.sku_code }}</span>
          </span>
          <el-tag size="small" :type="statusType(g.listing_status)" effect="plain">
            {{ statusLabel(g.listing_status) }}
          </el-tag>
        </button>
      </div>
      <footer class="pane-foot">
        共 {{ filtered.length }} 件<template v-if="keyword"> / {{ goods.length }}</template>
        <el-button text size="small" :loading="loadingGoods" @click="loadGoods">刷新</el-button>
      </footer>
    </aside>

    <!-- 右：这件货在各店铺 -->
    <section class="pane shops">
      <template v-if="!current">
        <div class="blank">左边挑一件货</div>
      </template>
      <template v-else>
        <header class="pane-head">
          <div class="cur">
            <b>{{ current.product_name || '未命名商品' }}</b>
            <span class="cur-sub">{{ current.sku_code }}</span>
          </div>
          <el-button size="small" :loading="loadingShops" @click="loadShops">刷新</el-button>
        </header>

        <div v-loading="loadingShops" class="pane-body">
          <el-alert v-if="shopError" :title="shopError" type="warning" show-icon :closable="false" class="mb" />

          <div v-for="group in groups" :key="group.key" class="group">
            <div class="group-head">
              <el-checkbox
                :model-value="group.allOn" :indeterminate="group.some && !group.allOn"
                :disabled="!group.selectable.length" @change="(v) => toggleGroup(group, v)"
              >
                {{ group.label }}
              </el-checkbox>
              <span class="group-count">{{ group.rows.length }} 家</span>
            </div>
            <div v-if="!group.rows.length" class="group-empty">没有这一类的店铺</div>
            <label v-for="s in group.rows" :key="s.shop_id" class="shop" :class="{ busy: isBusy(s) }">
              <el-checkbox :model-value="checked.has(s.shop_id)" :disabled="isBusy(s)" @change="() => toggle(s)" />
              <span class="shop-name">{{ s.shop_label }}</span>
              <el-tag size="small" :type="shopType(s)" effect="plain">{{ shopLabel(s) }}</el-tag>
              <span v-if="s.last_error" class="shop-err" :title="s.last_error">{{ s.last_error }}</span>
            </label>
          </div>
        </div>

        <footer class="pane-foot act">
          <span class="picked">已选 {{ checked.size }} 家</span>
          <el-button
            type="primary" :disabled="!canPublish" :loading="acting === 'publish'"
            @click="act('publish')"
          >上架</el-button>
          <el-button
            :disabled="!canDelist" :loading="acting === 'delist'"
            @click="act('delist')"
          >下架</el-button>
        </footer>
      </template>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search } from '@element-plus/icons-vue'

const route = useRoute()
const router = useRouter()

const goods = ref([])
const shops = ref([])
const current = ref(null)
const checked = ref(new Set())
const keyword = ref('')
const loadingGoods = ref(false)
const loadingShops = ref(false)
const shopError = ref('')
const acting = ref('')

// 在架/在途的店铺不能再点「上架」，在途的也不能点「下架」——让按钮自己说清楚，
// 比点下去再弹一个「该店铺已在架」强。
const LISTED = new Set(['LISTED', 'SOLD'])
const TRANSIENT = new Set(['LISTING', 'PENDING'])

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  if (!q) return goods.value
  return goods.value.filter((g) =>
    `${g.sku_code} ${g.product_name || ''}`.toLowerCase().includes(q))
})

function rowsOf(kind) {
  return shops.value.filter((s) =>
    kind === 'browser' ? s.device_kind === 'browser' : s.device_kind !== 'browser')
}

function groupOf(key, label) {
  const rows = rowsOf(key)
  const selectable = rows.filter((s) => !isBusy(s))
  const on = selectable.filter((s) => checked.value.has(s.shop_id))
  return { key, label, rows, selectable, allOn: selectable.length > 0 && on.length === selectable.length, some: on.length > 0 }
}

// 手机那一档的判据是「不是 browser」而不是「等于 android」：没绑设备的店铺默认
// 按真机算，漏判成浏览器会把货发到一条还没验过的链路上。
const groups = computed(() => [groupOf('android', '手机'), groupOf('browser', '浏览器')])

const canPublish = computed(() =>
  checked.value.size > 0 && [...checked.value].some((id) => {
    const s = shops.value.find((x) => x.shop_id === id)
    return s && !LISTED.has(s.publish_status) && !isBusy(s)
  }))

const canDelist = computed(() =>
  checked.value.size > 0 && [...checked.value].some((id) => {
    const s = shops.value.find((x) => x.shop_id === id)
    return s && LISTED.has(s.publish_status) && !isBusy(s)
  }))

function isBusy(s) {
  return TRANSIENT.has(s.publish_status) || Boolean(s.gc_pending)
}

function statusLabel(v) {
  return { DRAFT: '待填信息', READY: '可上架', CREATED: '已建', FAILED: '失败' }[v] || '待上架'
}
function statusType(v) {
  return v === 'FAILED' ? 'danger' : v === 'READY' || v === 'CREATED' ? 'success' : 'info'
}
function shopLabel(s) {
  if (s.gc_pending) return s.publish_status === 'LISTED' ? '下架中' : '处理中'
  return { LISTED: '在架', SOLD: '已售', LISTING: '上架中', DELISTED: '已下架', FAILED: '失败' }[s.publish_status] || '未上架'
}
function shopType(s) {
  if (s.gc_pending || s.publish_status === 'LISTING') return 'warning'
  if (s.publish_status === 'FAILED') return 'danger'
  if (LISTED.has(s.publish_status)) return 'success'
  return 'info'
}

async function loadGoods() {
  loadingGoods.value = true
  try {
    goods.value = await window.erp.getPendingListings()
    if (current.value && !goods.value.some((g) => g.sku_code === current.value.sku_code)) {
      // 刚发出去的货会从待上架列表里消失，别让右边停在一件已经不在了的货上
      current.value = null
      shops.value = []
    }
  } catch (e) {
    ElMessage.warning(e?.message || '读不到待上架清单')
  } finally {
    loadingGoods.value = false
  }
}

async function loadShops() {
  if (!current.value) return
  loadingShops.value = true
  shopError.value = ''
  try {
    shops.value = await window.erp.getSkuShops(current.value.sku_code)
    if (!shops.value.length) shopError.value = '这件货没有可用的店铺，先去后台把店铺和群控账号绑上'
    // 默认勾上还没上架、也不在处理中的——最常见的动作是「发到所有还没发的店」
    checked.value = new Set(shops.value.filter((s) => !LISTED.has(s.publish_status) && !isBusy(s)).map((s) => s.shop_id))
  } catch (e) {
    shopError.value = e?.message || '读不到店铺上架状态'
    shops.value = []
  } finally {
    loadingShops.value = false
  }
}

function pick(g) {
  current.value = g
  checked.value = new Set()
  loadShops()
}

function toggle(s) {
  const next = new Set(checked.value)
  next.has(s.shop_id) ? next.delete(s.shop_id) : next.add(s.shop_id)
  checked.value = next
}

function toggleGroup(group, on) {
  const next = new Set(checked.value)
  for (const s of group.selectable) on ? next.add(s.shop_id) : next.delete(s.shop_id)
  checked.value = next
}

async function act(kind) {
  const ids = [...checked.value]
  const targets = shops.value.filter((s) => ids.includes(s.shop_id) && !isBusy(s) &&
    (kind === 'publish' ? !LISTED.has(s.publish_status) : LISTED.has(s.publish_status)))
  if (!targets.length) return ElMessage.warning(kind === 'publish' ? '选中的店铺都已经在架了' : '选中的店铺都不在架')

  const verb = kind === 'publish' ? '上架' : '下架'
  const names = targets.map((s) => s.shop_label).join('、')
  try {
    await ElMessageBox.confirm(
      `把「${current.value.product_name || current.value.sku_code}」${verb}到 ${targets.length} 家店铺：${names}`,
      `确认${verb}`, { type: 'warning', confirmButtonText: verb }
    )
  } catch { return }

  acting.value = kind
  try {
    const res = kind === 'publish'
      ? await window.erp.publishSku(current.value.sku_code, targets.map((s) => s.shop_id))
      : await window.erp.delistSku(current.value.sku_code, targets.map((s) => s.shop_id))
    if (!res?.ok) return ElMessage.warning(res?.reason || `${verb}失败`)
    // 真机/浏览器都是异步的：群控收单后才动手，这里只说"已派出去"，不说"已完成"
    ElMessage.success(`${verb}指令已下发到 ${targets.length} 家店铺，处理完状态会自己变`)
    await loadShops()
    await loadGoods()
  } finally {
    acting.value = ''
  }
}

function goBind() {
  router.push('/ops?tab=accounts')
}

onMounted(async () => {
  // 从「库存商品」带着货过来时地址里有 q：预填搜索框，并且只有一条就直接选中，
  // 省掉「刚才明明就在眼前的那件货，现在要我自己再找一遍」。
  const q = String(route.query.q || '').trim()
  if (q) keyword.value = q
  await loadGoods()
  if (q && filtered.value.length === 1) pick(filtered.value[0])
})
</script>

<style scoped>
.listing {
  --ink: #21312b; --muted: #7c8983; --line: #e1e9e4; --paper: #fbfdfb;
  color: var(--ink);
  display: grid; grid-template-columns: minmax(280px, 340px) 1fr; gap: 14px;
  /* 整页不滚：两栏各自在框里滚，按钮永远看得见。
     高度由外壳给（.main 已经 overflow:auto），不用 100vh 减一个会过期的数字。 */
  height: 100%; min-height: 0;
}
.pane { display: flex; flex-direction: column; min-height: 0; border: 1px solid var(--line); border-radius: 12px; background: var(--paper); }
.pane-head { display: flex; align-items: center; gap: 10px; padding: 13px 15px; border-bottom: 1px solid var(--line); }
.pane-head b { font-size: 14px; }
.search { flex: 1; }
.pane-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; }
.pane-foot { display: flex; align-items: center; gap: 10px; padding: 10px 15px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
.pane-foot.act { justify-content: flex-end; }
.picked { margin-right: auto; }

.good { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 9px; border: 1px solid transparent; border-radius: 9px; background: none; text-align: left; cursor: pointer; font: inherit; color: inherit; }
.good:hover { background: #f2f8f4; }
.good.on { border-color: #b7e4c7; background: #eef8f1; }
.good:focus-visible { outline: 2px solid #3c7e5b; outline-offset: 1px; }
.thumb { width: 38px; height: 38px; object-fit: cover; border-radius: 7px; background: #eef2ef; flex-shrink: 0; }
.thumb--none { display: grid; place-items: center; color: #a8b2ac; font-size: 10px; }
.good-copy { flex: 1; min-width: 0; }
.good-name { display: block; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.good-sub { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }

.blank { display: grid; place-items: center; height: 100%; color: var(--muted); font-size: 13px; }
.cur { min-width: 0; }
.cur b { font-size: 14px; }
.cur-sub { margin-left: 8px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.pane-head .el-button { margin-left: auto; }

.group { margin-bottom: 14px; }
.group-head { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 7px; background: #f2f6f3; }
.group-count { color: var(--muted); font-size: 11.5px; }
.group-empty { padding: 8px 10px; color: var(--muted); font-size: 12px; }
.shop { display: flex; align-items: center; gap: 9px; padding: 7px 9px; border-radius: 7px; cursor: pointer; }
.shop:hover { background: #f6faf7; }
.shop.busy { cursor: default; opacity: .6; }
.shop-name { font-size: 13px; }
.shop-err { margin-left: auto; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #a66d24; font-size: 11.5px; }
.mb { margin-bottom: 10px; }

@media (max-width: 900px) {
  .listing { grid-template-columns: 1fr; height: auto; }
  .pane-body { max-height: 46vh; }
}
</style>
