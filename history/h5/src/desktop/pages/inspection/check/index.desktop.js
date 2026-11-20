import { commonMethods } from '../../../lib/pager.js'

// 逐项验货（电脑版）：验货规范 10 个以内平铺点选（走原来的 onTemplateChange），多了退回下拉；
// 填写面板里的照片点开看大图
export default {
  methods: {
    ...commonMethods,

    dkPickTemplate(e) {
      this.onTemplateChange({ detail: { value: Number(e.currentTarget.dataset.index) } })
    },
  },
}
