import { commonMethods } from '../../lib/pager.js'

// 采购录入（电脑版）：采购账号平铺成一排，点一下就选（账号多于 8 个时模板里退回下拉）
export default {
  methods: {
    ...commonMethods,

    dkPickAccount(e) {
      this.onPurchaseAccountChange({ detail: { value: Number(e.currentTarget.dataset.index) } })
    },
  },
}
