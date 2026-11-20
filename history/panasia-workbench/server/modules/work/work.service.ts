import { Injectable } from '@nestjs/common';
import { BindingService } from '../integration/binding.service';
import type { WorkEntry, WorkOverview } from '@shared/api.interface';
import type { EmployeeRole } from '@shared/api.interface';
import type { ErpCounterField } from './erp-overview.service';
import { ErpOverviewService } from './erp-overview.service';

interface WorkEntrySpec {
  key: string;
  title: string;
  description: string;
}

const PROCUREMENT_ENTRIES: WorkEntrySpec[] = [
  {
    key: 'rfq',
    title: '今日询价',
    description: '发起与管理询价单，跟踪供应商报价',
  },
  {
    key: 'material-request',
    title: '待采购商品',
    description: '查看待采购物料需求',
  },
  {
    key: 'item-price',
    title: '行情价',
    description: '查看商品价格与行情波动',
  },
  {
    key: 'supplier',
    title: '供应商',
    description: '供应商档案与联系方式',
  },
  {
    key: 'purchase-order',
    title: '采购订单',
    description: '采购订单进度与收货状态',
  },
  {
    key: 'item',
    title: '商品池',
    description: '全部商品与规格信息',
  },
  {
    key: 'stock',
    title: '库存查询',
    description: '各仓库库存余量查询',
  },
];

const SALES_ENTRIES: WorkEntrySpec[] = [
  {
    key: 'customer',
    title: '客户',
    description: '客户档案与联系方式',
  },
  {
    key: 'quotation',
    title: '报价',
    description: '给客户的报价单管理',
  },
  {
    key: 'sales-order',
    title: '订单',
    description: '销售订单与发货进度',
  },
  {
    key: 'issue',
    title: '售后',
    description: '客户售后与问题处理',
  },
  {
    key: 'stock',
    title: '库存',
    description: '商品库存余量查询',
  },
  {
    key: 'sales-analytics',
    title: '销售数据',
    description: '销售额与销售分析报表',
  },
];

const WAREHOUSE_ENTRIES: WorkEntrySpec[] = [
  {
    key: 'stock-entry-receipt',
    title: '入库',
    description: '采购入库与其他入库单',
  },
  {
    key: 'stock-entry-issue',
    title: '出库',
    description: '领料出库与发货出库单',
  },
  {
    key: 'stock-reconciliation',
    title: '盘点',
    description: '库存盘点与账目校正',
  },
  {
    key: 'warehouse',
    title: '库位',
    description: '仓库与库位结构管理',
  },
  {
    key: 'quality',
    title: '异常件',
    description: '质检异常与不合格品处理',
  },
  {
    key: 'asset',
    title: '资产',
    description: '固定资产台账管理',
  },
];

const ENTRY_COUNTER_FIELD: Record<string, ErpCounterField> = {
  'purchase-order': 'today_purchase',
  'stock-entry-receipt': 'today_inbound',
  'stock-entry-issue': 'today_outbound',
  stock: 'in_stock',
};

/**
 * 业务入口打开腾讯 ERP 员工手机端 H5（ERPNext 已弃用）。
 * 这些入口给采购/销售/仓库员工用，打开 H5 首页再进对应功能；后台 /console/ 是管理员用的，不放这里。
 */
const ERP_H5_URL = (process.env.ERP_H5_URL ?? '').trim() || 'http://127.0.0.1:8000';

const ROLE_LABELS: Record<EmployeeRole, string> = {
  procurement: '采购',
  sales: '销售',
  warehouse: '仓库',
  general: '通用',
  admin: '管理员',
};

const WORKBENCH_NAMES: Record<EmployeeRole, string> = {
  procurement: '采购工作台',
  sales: '销售工作台',
  warehouse: '仓库工作台',
  general: '工作台',
  admin: '工作台',
};

@Injectable()
export class WorkService {
  constructor(
    private readonly erpOverview: ErpOverviewService,
    private readonly bindingService: BindingService,
  ) {}

  async getWorkOverview(userId: string): Promise<WorkOverview> {
    const binding = await this.bindingService.getBinding(userId);
    const role: EmployeeRole = binding?.role ?? 'general';
    const hint =
      role === 'general'
        ? '请先在「我的」中设置岗位，工作台将显示对应业务入口'
        : null;
    const specs =
      role === 'procurement'
        ? PROCUREMENT_ENTRIES
        : role === 'sales'
          ? SALES_ENTRIES
          : role === 'warehouse'
            ? WAREHOUSE_ENTRIES
            : [];
    const counters = await this.erpOverview.getCounters();
    const entries: WorkEntry[] = specs.map((spec: WorkEntrySpec): WorkEntry => {
      const field = ENTRY_COUNTER_FIELD[spec.key];
      return {
        key: spec.key,
        title: spec.title,
        description: spec.description,
        count: counters && field ? counters[field] : null,
        externalUrl: ERP_H5_URL,
      };
    });
    return {
      role,
      roleLabel: ROLE_LABELS[role],
      workbenchName: WORKBENCH_NAMES[role],
      hint,
      entries,
    };
  }
}
