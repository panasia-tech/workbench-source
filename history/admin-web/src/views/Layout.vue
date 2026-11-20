<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { User, ShoppingCart, Box, SwitchButton, DocumentChecked, View, Sell, Shop, List, Switch, FolderOpened, Location, PriceTag, Tools, Monitor } from '@element-plus/icons-vue'
import BeianFooter from '../components/BeianFooter.vue'
import { canOpen } from '../utils/consoleAccess'

const route = useRoute()
const router = useRouter()

const pageTitle = computed(() => route.meta.title || '管理后台')

const allGroups = [
  {
    title: '采购验货', icon: ShoppingCart,
    children: [
      { index: '/orders/purchase', title: '采购订单' },
      { index: '/orders/bargain', title: '采购议价' },
      { index: '/inspection-ops/workbench', title: '开箱验货' },
      { index: '/inspection', title: '验货记录' },
      { index: '/inspection-ops/exceptions', title: '拒签退款跟踪' },
      { index: '/inspection-ops/templates', title: '验货规范' },
    ],
  },
  {
    title: '库存盘点', icon: Box,
    children: [
      { index: '/inventory/skus', title: '库存 SKU' },
      { index: '/inventory/stocktake', title: '盘点审批' },
      { index: '/inventory/stocktake-records', title: '盘点记录' },
    ],
  },
  {
    title: '上架销售', icon: Sell,
    children: [
      { index: '/listing/pending', title: '上架管理' },
      { index: '/listing/auto', title: '自动上架' },
      { index: '/listing/approvals', title: '上架审批' },
      { index: '/orders/sales', title: '销售订单' },
      { index: '/inspection-ops/review', title: '出库复核' },
      { index: '/switch/orders', title: '切单管理' },
      { index: '/negotiation/tasks', title: '历史议价处理' },
    ],
  },
  {
    title: '基础资料', icon: FolderOpened,
    children: [
      { index: '/master/purchase-accounts', title: '采购账号' },
      { index: '/master/purchase-prices', title: '采购价格表' },
      { index: '/master/sale-shops', title: '销售店铺' },
      { index: '/master/locations', title: '库位管理' },
      { index: '/master/warehouse-tags', title: '仓库标签' },
      { index: '/master/product-types', title: 'AI 生图' },
      { index: '/master/product-images', title: '图片爬虫' },
      { index: '/master/spu', title: 'SPU 对照表' },
      { index: '/ledger', title: '大台账', href: `${import.meta.env.BASE_URL}ledger.html?from=admin` },
    ],
  },
  {
    title: '市场行情', icon: PriceTag,
    children: [
      { index: '/market/products', title: '商品比价' },
    ],
  },
  {
    title: '工具', icon: Tools,
    children: [
      { index: '/tools/assets', title: '资产管理' },
      { index: '/tools/phones', title: '手机号管理' },
      { index: '/tools/frames', title: '商品切片' },
    ],
  },
  {
    title: '群控', icon: Monitor,
    children: [
      { index: '/gc/devices', title: '设备列表' },
      { index: '/gc/tasks', title: '任务队列' },
      { index: '/gc/chat-sla', title: '消息响应' },
    ],
  },
  {
    title: '系统管理', icon: User,
    children: [
      { index: '/staff', title: '员工管理' },
      { index: '/system/sso', title: '统一登录' },
      { index: '/ops/anonymous-feedback', title: '匿名反馈箱' },
      { index: '/orders/archive', title: '批量归档' },
    ],
  },
]

const visibleGroups = allGroups
  .map((g) => ({ ...g, children: g.children.filter((c) => canOpen(c.index)) }))
  .filter((g) => g.children.length)

// 当前路由所在分组默认展开
const openedGroups = computed(() => {
  const i = visibleGroups.findIndex((g) => g.children.some((c) => route.path.startsWith(c.index)))
  return i >= 0 ? ['g' + i] : ['g0']
})

// 大台账是单独打包的页面，不进后台路由：新标签页打开，令牌它自己借后台的
function onSelect(index) {
  const item = visibleGroups.flatMap((g) => g.children).find((c) => c.index === index)
  if (item && item.href) window.open(item.href, '_blank')
}

function logout() {
  localStorage.removeItem('token')
  router.push('/login')
}
</script>

<template>
  <el-container class="app-layout">
    <el-aside width="var(--aside-width)" class="app-aside">
      <div class="aside-brand">
        <div class="aside-logo">ERP</div>
        <div class="aside-name">泛亚货运社</div>
      </div>

      <el-menu
        router
        class="aside-menu"
        background-color="transparent"
        text-color="rgba(255,255,255,0.75)"
        active-text-color="#fff"
        :default-active="route.path"
        :default-openeds="openedGroups"
        @select="onSelect"
      >
        <el-sub-menu v-for="(group, gi) in visibleGroups" :key="gi" :index="'g' + gi">
          <template #title>
            <el-icon><component :is="group.icon" /></el-icon>
            <span>{{ group.title }}</span>
          </template>
          <el-menu-item v-for="item in group.children" :key="item.index" :index="item.index">
            <span>{{ item.title }}</span>
          </el-menu-item>
        </el-sub-menu>
      </el-menu>

      <div class="aside-footer">
        <el-button class="logout-btn" :icon="SwitchButton" @click="logout">
          退出登录
        </el-button>
        <BeianFooter class="aside-beian" />
      </div>
    </el-aside>

    <el-container class="app-body">
      <el-header class="app-header" height="var(--header-height)">
        <h1 class="app-header__title">{{ pageTitle }}</h1>
      </el-header>
      <el-main class="app-main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
/* 固定视口高度，避免整页（含侧栏）随右侧内容一起滚动 */
.app-layout {
  height: 100vh;
  overflow: hidden;
}

.app-aside {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--brand-dark);
  border-right: 1px solid rgba(255, 255, 255, 0.06);
}

.aside-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.aside-logo {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: linear-gradient(135deg, #1677ff, #003a70);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  line-height: 36px;
  text-align: center;
  flex-shrink: 0;
}

.aside-name {
  font-size: 15px;
  font-weight: 600;
  color: #fff;
  line-height: 1.3;
}

.aside-menu {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border-right: none;
  padding: 8px;
}

.aside-menu :deep(.el-menu-item) {
  height: 44px;
  margin-bottom: 4px;
  border-radius: 8px;
}

/* 二级菜单分组标题 */
.aside-menu :deep(.el-sub-menu__title) {
  height: 44px;
  margin-bottom: 4px;
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.9);
}

.aside-menu :deep(.el-sub-menu__title:hover) {
  background: rgba(255, 255, 255, 0.08) !important;
}

/* 分组内的子项:整体透明背景 + 缩进 */
.aside-menu :deep(.el-sub-menu .el-menu) {
  background: transparent !important;
}

.aside-menu :deep(.el-sub-menu .el-menu-item) {
  height: 40px;
  min-width: 0;
  padding-left: 44px !important;
}

.aside-menu :deep(.el-menu-item.is-active) {
  background: var(--brand-primary) !important;
  color: #fff !important;
}

.aside-menu :deep(.el-menu-item:hover) {
  background: rgba(255, 255, 255, 0.08) !important;
}

.aside-menu :deep(.el-menu-item.is-active:hover) {
  background: var(--brand-primary) !important;
}

.aside-menu :deep(.el-icon) {
  margin-right: 8px;
}

.aside-footer {
  padding: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.aside-beian {
  margin-top: 12px;
}

.logout-btn {
  width: 100%;
  color: rgba(255, 255, 255, 0.75);
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: transparent;
}

.logout-btn:hover {
  color: #fff;
  border-color: rgba(255, 255, 255, 0.3);
  background: rgba(255, 255, 255, 0.06);
}

.app-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--page-bg);
}

.app-header {
  display: flex;
  align-items: center;
  padding: 0 24px;
  background: #fff;
  border-bottom: 1px solid var(--border-color);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
}

.app-header__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.app-main {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 24px 24px;
  width: 100%;
}
</style>
