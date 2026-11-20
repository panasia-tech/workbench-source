import { commonMethods } from '../../../lib/pager.js'

// 收货核对（电脑版）：商品状态只有 4 个选项，电脑上平铺成一排直接点（还是走原来的 onConditionChange）
export default {
  methods: {
    ...commonMethods,

    dkPickCondition(e) {
      this.onConditionChange({ detail: { value: Number(e.currentTarget.dataset.index) } })
    },
  },
}
