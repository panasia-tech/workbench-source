import { wx } from '../../../../runtime/globals.js'

// 手动入库（电脑版）：底部操作条多一个「取消」（手机上靠导航栏返回）
export default {
  methods: {
    dkBack() {
      wx.navigateBack()
    },
  },
}
