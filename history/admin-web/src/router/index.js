import { createRouter, createWebHistory } from 'vue-router'
import Login from '../views/Login.vue'
import Layout from '../views/Layout.vue'
import Staff from '../views/Staff.vue'
import PurchaseOrders from '../views/PurchaseOrders.vue'
import Inspections from '../views/Inspections.vue'
import { canOpen, homePath } from '../utils/consoleAccess'
import InspectionWorkbench from '../views/InspectionWorkbench.vue'
import InspectionTemplates from '../views/InspectionTemplates.vue'
import InspectionExceptions from '../views/InspectionExceptions.vue'
import OutboundReview from '../views/OutboundReview.vue'
import FrameSlicer from '../views/FrameSlicer.vue'
import Skus from '../views/Skus.vue'
import SalesOrders from '../views/SalesOrders.vue'
import Stocktake from '../views/Stocktake.vue'
import PurchaseAccounts from '../views/PurchaseAccounts.vue'
import PurchasePrices from '../views/PurchasePrices.vue'
import SaleShops from '../views/SaleShops.vue'
import Locations from '../views/Locations.vue'
import WarehouseTags from '../views/WarehouseTags.vue'
import AiImage from '../views/AiImage.vue'
import SpuCatalog from '../views/SpuCatalog.vue'
import ProductImages from '../views/ProductImages.vue'
import SwitchOrders from '../views/SwitchOrders.vue'
import ListingPending from '../views/ListingPending.vue'
import AutoListing from '../views/AutoListing.vue'
import ListingApprovals from '../views/ListingApprovals.vue'
import StocktakeDetail from '../views/StocktakeDetail.vue'
import StocktakeRecords from '../views/StocktakeRecords.vue'
import OrderArchive from '../views/OrderArchive.vue'
import NegotiationTasks from '../views/NegotiationTasks.vue'
import BargainSessions from '../views/BargainSessions.vue'
import MarketPrices from '../views/MarketPrices.vue'
import AnonymousFeedback from '../views/AnonymousFeedback.vue'
import Assets from '../views/Assets.vue'
import Phones from '../views/Phones.vue'
import GcDevices from '../views/GcDevices.vue'
import GcTasks from '../views/GcTasks.vue'
import ChatSla from '../views/ChatSla.vue'
import Sso from '../views/Sso.vue'

const routes = [
  { path: '/login', component: Login, meta: { title: '登录', guest: true } },
  {
    path: '/',
    component: Layout,
    meta: { requiresAuth: true },
    children: [
      { path: '', redirect: '/staff' },
      { path: 'staff', component: Staff, meta: { title: '员工管理' } },
      { path: 'system/sso', component: Sso, meta: { title: '统一登录' } },
      { path: 'master/purchase-accounts', component: PurchaseAccounts, meta: { title: '采购账号' } },
      { path: 'master/purchase-prices', component: PurchasePrices, meta: { title: '采购价格表' } },
      { path: 'master/sale-shops', component: SaleShops, meta: { title: '销售店铺' } },
      { path: 'master/locations', component: Locations, meta: { title: '库位管理' } },
      { path: 'master/warehouse-tags', component: WarehouseTags, meta: { title: '仓库标签' } },
      { path: 'master/product-types', component: AiImage, meta: { title: 'AI 生图' } },
      { path: 'master/spu', component: SpuCatalog, meta: { title: 'SPU 对照表' } },
      { path: 'master/product-images', component: ProductImages, meta: { title: '图片爬虫' } },
      { path: 'listing/pending', component: ListingPending, meta: { title: '上架管理' } },
      { path: 'listing/auto', component: AutoListing, meta: { title: '自动上架' } },
      { path: 'listing/approvals', component: ListingApprovals, meta: { title: '上架审批' } },
      { path: 'switch/orders', component: SwitchOrders, meta: { title: '切单管理' } },
      { path: 'negotiation/tasks', component: NegotiationTasks, meta: { title: '历史议价处理' } },
      { path: 'orders/purchase', component: PurchaseOrders, meta: { title: '采购订单' } },
      { path: 'orders/bargain', component: BargainSessions, meta: { title: '采购议价' } },
      { path: 'orders/archive', component: OrderArchive, meta: { title: '批量归档' } },
      { path: 'inspection', component: Inspections, meta: { title: '验货记录' } },
      { path: 'inspection-ops/workbench', component: InspectionWorkbench, meta: { title: '开箱验货' } },
      { path: 'inspection-ops/templates', component: InspectionTemplates, meta: { title: '验货规范' } },
      { path: 'inspection-ops/exceptions', component: InspectionExceptions, meta: { title: '拒签退款跟踪' } },
      { path: 'inspection-ops/review', component: OutboundReview, meta: { title: '出库复核' } },
      { path: 'tools/frames', component: FrameSlicer, meta: { title: '商品切片' } },
      { path: 'orders/sales', component: SalesOrders, meta: { title: '销售订单' } },
      { path: 'inventory/skus', component: Skus, meta: { title: '库存 SKU' } },
      { path: 'inventory/stocktake', component: Stocktake, meta: { title: '盘点审批' } },
      { path: 'inventory/stocktake-records', component: StocktakeRecords, meta: { title: '盘点记录' } },
      { path: 'inventory/stocktake/:id', component: StocktakeDetail, meta: { title: '盘点详情' } },
      { path: 'market/products', component: MarketPrices, meta: { title: '商品比价' } },
      { path: 'ops/anonymous-feedback', component: AnonymousFeedback, meta: { title: '匿名反馈箱' } },
      { path: 'tools/assets', component: Assets, meta: { title: '资产管理' } },
      { path: 'tools/phones', component: Phones, meta: { title: '手机号管理' } },
      { path: 'gc/devices', component: GcDevices, meta: { title: '设备列表' } },
      { path: 'gc/tasks', component: GcTasks, meta: { title: '任务队列' } },
      { path: 'ledger', component: { render: () => null }, beforeEnter: () => false },
      { path: 'gc/chat-sla', component: ChatSla, meta: { title: '消息响应' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

// base 取自 vite.config.js 的 base（构建期注入），后台整体挂在子路径下
const router = createRouter({ history: createWebHistory(import.meta.env.BASE_URL), routes })

router.beforeEach((to) => {
  const hasToken = !!localStorage.getItem('token')
  if (to.meta.requiresAuth && !hasToken) {
    return { path: '/login', query: to.fullPath !== '/' ? { redirect: to.fullPath } : undefined }
  }
  if (to.meta.guest && hasToken) {
    return { path: '/' }
  }
  if (to.meta.requiresAuth && !canOpen(to.path) && to.path !== homePath()) {
    if (homePath()) return { path: homePath() }
    localStorage.removeItem('token')
    return { path: '/login' }
  }
  return true
})

export default router
