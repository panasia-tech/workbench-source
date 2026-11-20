import { commonMethods } from '../../../lib/pager.js'

// 验货（电脑版）：
// - 库位：手机是底部滚轮，电脑换成居中对话框（可搜索），点一下就选上（走原来的 confirmLocationPicker）
// - 商品类型：12 个以内平铺成一排点选（走原来的 pickProductType），多了退回下拉
// - 逐项验货 / 分件到货入口（手机上是 H5 补丁加的 navigator）做成顶部按钮，用 dkOpen 打开
export default {
  data: { dkLocQ: '' },
  methods: {
    ...commonMethods,

    noop() {},

    dkLocInput(e) {
      this.setData({ dkLocQ: (e.detail.value || '').trim() })
    },

    dkPickLocation(e) {
      const index = Number(e.currentTarget.dataset.index)
      this.setData({ tempLocationIndex: [index], dkLocQ: '' }, () => this.confirmLocationPicker())
    },

    dkPickType(e) {
      this.pickProductType({ detail: { value: Number(e.currentTarget.dataset.index) } })
    },
    dkPickGrade(e) {
      this.pickGrade({ detail: { value: Number(e.currentTarget.dataset.index) } })
    },
  },
}
