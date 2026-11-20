import type { ReactNode } from 'react';
import {
  ClipboardCheck,
  Handshake,
  Laptop,
  Layers,
  MessageSquare,
  RotateCcw,
  Scale,
  ShoppingCart,
  Truck,
  Warehouse,
} from 'lucide-react';

/**
 * ERP 业务入口清单，照抄 miniprogram/services/workbench.js 的 ENTRY_MAP / ROLE_ENTRY_KEYS。
 * 本期业务模块未原生化：点击统一走免登 H5 深链（createErpEntry 的 url + '#' + h5Path）新标签页打开。
 */
export interface ErpWorkEntry {
  key: string;
  title: string;
  sub: string;
  /** ERP H5（miniprogram 编译产物）页面路径 */
  h5Path: string;
  roles: string[];
  icon: ReactNode;
}

export const ERP_WORK_ENTRIES: ErpWorkEntry[] = [
  {
    key: 'purchase',
    title: '采购录入',
    sub: '闲鱼截图 OCR · 提交采购单',
    h5Path: '/pages/purchase/index',
    roles: ['PURCHASER', 'ADMIN'],
    icon: <ShoppingCart className="h-5 w-5" />,
  },
  {
    key: 'inspection',
    title: '验货',
    sub: '待验货列表 · 拍照入库',
    h5Path: '/pages/inspection/index',
    roles: ['WAREHOUSE', 'ADMIN'],
    icon: <ClipboardCheck className="h-5 w-5" />,
  },
  {
    key: 'warehouse',
    title: '仓库',
    sub: '库存查询 · 出库盘点',
    h5Path: '/pages/warehouse/index',
    roles: ['WAREHOUSE', 'ADMIN'],
    icon: <Warehouse className="h-5 w-5" />,
  },
  {
    key: 'sales',
    title: '销售',
    sub: '待发货 · 自提 · 切单出库',
    h5Path: '/pages/sales/index',
    roles: ['SALES', 'ADMIN'],
    icon: <Truck className="h-5 w-5" />,
  },
  {
    key: 'listing',
    title: '群控中心',
    sub: '填写文案 · 一键全店铺上架',
    h5Path: '/pages/listing/index',
    roles: ['WAREHOUSE', 'SALES', 'ADMIN'],
    icon: <Layers className="h-5 w-5" />,
  },
  {
    key: 'negotiation',
    title: '议价',
    sub: '入库后定价 · 推进上架',
    h5Path: '/pages/negotiation/index',
    roles: ['PURCHASER', 'NEGOTIATOR', 'ADMIN'],
    icon: <Handshake className="h-5 w-5" />,
  },
  {
    key: 'returns',
    title: '退货',
    sub: '已发货退货 · 待入库签收',
    h5Path: '/pages/returns/index',
    roles: ['SALES', 'WAREHOUSE', 'ADMIN'],
    icon: <RotateCcw className="h-5 w-5" />,
  },
  {
    key: 'chat',
    title: '消息',
    sub: '闲鱼买家咨询 · 聚合会话',
    h5Path: '/pages/gc-chat/list/index',
    roles: ['PURCHASER', 'SALES', 'ADMIN'],
    icon: <MessageSquare className="h-5 w-5" />,
  },
  {
    key: 'lawsuit',
    title: '起诉记录',
    sub: '诉讼建档 · 证据/律师/法院材料',
    h5Path: '/pages/lawsuit/index',
    roles: ['PURCHASER', 'ADMIN'],
    icon: <Scale className="h-5 w-5" />,
  },
  {
    key: 'assetIntake',
    title: '资产录入',
    sub: '电脑、显示器等 · 录完进待上架',
    h5Path: '/pages/asset-intake/index',
    roles: ['PURCHASER', 'WAREHOUSE', 'NEGOTIATOR', 'SALES', 'FINANCE', 'ADMIN'],
    icon: <Laptop className="h-5 w-5" />,
  },
];

// 资产录入所有员工都有（用户 2026-10-17 定）
const ERP_ROLE_ENTRY_KEYS: Record<string, string[]> = {
  PURCHASER: ['purchase', 'chat', 'negotiation', 'lawsuit', 'assetIntake'],
  WAREHOUSE: ['inspection', 'warehouse', 'listing', 'returns', 'assetIntake'],
  NEGOTIATOR: ['negotiation', 'assetIntake'],
  SALES: ['sales', 'chat', 'listing', 'warehouse', 'returns', 'assetIntake'],
  FINANCE: ['assetIntake'],
  ADMIN: [
    'purchase',
    'inspection',
    'warehouse',
    'listing',
    'chat',
    'negotiation',
    'sales',
    'returns',
    'lawsuit',
    'assetIntake',
  ],
};

export const ERP_ROLE_LABELS: Record<string, string> = {
  PURCHASER: '采购',
  WAREHOUSE: '仓库',
  NEGOTIATOR: '议价',
  SALES: '销售',
  FINANCE: '财务',
  ADMIN: '管理员',
};

export function erpEntriesForRole(role: string): ErpWorkEntry[] {
  const keys = ERP_ROLE_ENTRY_KEYS[role] ?? ERP_ROLE_ENTRY_KEYS.PURCHASER;
  return keys
    .map((key) => ERP_WORK_ENTRIES.find((entry) => entry.key === key))
    .filter((entry): entry is ErpWorkEntry => Boolean(entry));
}

/** 今日概览统计卡 / 提成行的可见性，口径照 miniprogram/pages/profile/index.js */
export function erpWorkVisibility(role: string): {
  showInspectStat: boolean;
  showInStockStat: boolean;
  showPurchaseStat: boolean;
  showOutboundStat: boolean;
  showPurchaseCommission: boolean;
  showWarehouseCommission: boolean;
  showSalesCommission: boolean;
} {
  return {
    showInspectStat: role === 'WAREHOUSE' || role === 'ADMIN',
    showInStockStat:
      role === 'WAREHOUSE' || role === 'SALES' || role === 'ADMIN',
    showPurchaseStat: role === 'PURCHASER' || role === 'ADMIN',
    showOutboundStat:
      role === 'WAREHOUSE' || role === 'SALES' || role === 'ADMIN',
    showPurchaseCommission: role === 'PURCHASER' || role === 'ADMIN',
    showWarehouseCommission: role === 'WAREHOUSE' || role === 'ADMIN',
    showSalesCommission: role === 'SALES' || role === 'ADMIN',
  };
}

/** 概览统计卡点击跳转的 H5 页面（照 profile/index.js 的 goXxx） */
export const ERP_STAT_H5_PATHS: Record<string, string> = {
  inspect: '/pages/inspection/index',
  inStock: '/pages/warehouse/index',
  purchase: '/pages/purchase/records/index?today=1',
  outbound: '/pages/sales/outbound-records/index',
};
