import { createRouter, createWebHashHistory } from 'vue-router';
import { getStoredToken } from '../api/client.js';

import LoginView from '../views/LoginView.vue';
import TodayHomeView from '../views/TodayHomeView.vue';
import XianyuMonitorView from '../views/XianyuMonitorView.vue';
import AccountsWindowsView from '../views/AccountsWindowsView.vue';
import ImChatView from '../views/ImChatView.vue';
import CasesListView from '../views/CasesListView.vue';
import CaseDetailView from '../views/CaseDetailView.vue';
import SellersPoolView from '../views/SellersPoolView.vue';
import PricebookView from '../views/PricebookView.vue';
import FinanceLedgerView from '../views/FinanceLedgerView.vue';
import TutorialCenterView from '../views/TutorialCenterView.vue';

const routes = [
  { path: '/login', component: LoginView, meta: { public: true, title: '登录' } },
  { path: '/', component: TodayHomeView, meta: { title: '今日工作台', helpKey: 'home', tourKey: 'home' } },
  { path: '/monitor', component: XianyuMonitorView, meta: { title: '闲鱼监控融合中心', helpKey: 'monitor', tourKey: 'monitor' } },
  { path: '/accounts', component: AccountsWindowsView, meta: { title: '账号 5% 护航 & 1+3 专窗', helpKey: 'home', tourKey: 'home' } },
  { path: '/im', component: ImChatView, meta: { title: '合规议价 IM 与冻结快照', helpKey: 'im', tourKey: 'home' } },
  { path: '/cases', component: CasesListView, meta: { title: '采购全周期订单池', helpKey: 'cases', tourKey: 'cases' } },
  { path: '/cases/:caseId', component: CaseDetailView, meta: { title: '买前 6 步 & 二次议价驾驶舱', helpKey: 'cases', tourKey: 'caseDetail' } },
  { path: '/sellers', component: SellersPoolView, meta: { title: '收藏卖家与黑名单池', helpKey: 'monitor', tourKey: 'monitor' } },
  { path: '/pricebook', component: PricebookView, meta: { title: '四维行情参考表 & 折损基准', helpKey: 'cases', tourKey: 'cases' } },
  { path: '/finance', component: FinanceLedgerView, meta: { title: '财务对账 · 对公 · 两段 10% 提成', helpKey: 'finance', tourKey: 'finance' } },
  { path: '/tutorials', component: TutorialCenterView, meta: { title: '内置视频教程 & 新员工 3 关防踩坑', helpKey: 'home', tourKey: 'home' } },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

router.beforeEach((to) => {
  if (!to.meta.public && !getStoredToken()) {
    return '/login';
  }
  return true;
});

export default router;
