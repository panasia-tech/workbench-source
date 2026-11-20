import api from '../../../../../miniprogram/services/api.js'
import { desktopPager, commonMethods } from '../../lib/pager.js'

// 退货管理（电脑版）：手机版只拉第一页 50 条，电脑上换成表格 + 页码；
// 退回原因、收货时的商品状态在手机列表里没显示，电脑表格里拆成列，这里把编码翻成中文
const REASON_LABEL = {
  CUSTOMER_CANCEL: '客户取消',
  CUSTOMER_REJECT: '客户拒收',
  CUSTOMER_RETURN: '客户退货',
  WRONG_ITEM: '发错商品',
  LOGISTICS_RETURN: '物流退回',
  INTERNAL_ERROR: '内部出库错误',
  OTHER: '其他',
}

const CONDITION_LABEL = {
  NORMAL: '正常',
  OPENED: '已拆封',
  USED: '轻微使用',
  ABNORMAL: '异常',
}

const RESOLUTION_LABEL = {
  RESTOCK: '已恢复在库',
  LOSS: '已报损',
  REJECT: '已驳回重核',
}

function decorate(item) {
  return {
    ...item,
    dkReason: REASON_LABEL[item.reason_code] || item.reason_code || '',
    dkCondition: CONDITION_LABEL[item.received_condition] || item.received_condition || '',
    dkResolution: RESOLUTION_LABEL[item.resolution] || '',
  }
}

const pager = desktopPager({
  fetch: (params) => api.listReturns(params).then((res) => ({ ...res, items: (res.items || []).map(decorate) })),
  params() {
    return this.data.listTab ? { status: this.data.listTab } : {}
  },
})

export default {
  data: { ...pager.data },
  methods: {
    ...pager.methods,
    ...commonMethods,
  },
}
