import { commonMethods } from '../../../lib/pager.js'
import { wx } from '../../../../runtime/globals.js'

// 编辑采购单（电脑版）：采购账号平铺成一排点选；底部多一个「取消」回上一页
export default {
  methods: {
    ...commonMethods,

    dkPickAccount(e) {
      this.onPurchaseAccountChange({ detail: { value: Number(e.currentTarget.dataset.index) } })
    },

    dkBack() {
      wx.navigateBack()
    },
  },
}
