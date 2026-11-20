import { wx } from '../../../../runtime/globals.js'

// 拆分库存（电脑版）：底部「取消」；「确认拆分」在金额对不上时和手机上的 disabled 按钮一样不响应
export default {
  methods: {
    dkBack() {
      wx.navigateBack()
    },

    dkSubmit() {
      if (!this.data.matched) return
      this.submit()
    },
  },
}
