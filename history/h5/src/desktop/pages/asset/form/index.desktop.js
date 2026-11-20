import { commonMethods } from '../../../lib/pager.js'

// 资产信息（电脑版）：状态四个选项直接平铺成一排按钮，点一下等于在原来的下拉里选中那一项
export default {
  methods: {
    dkPreview: commonMethods.dkPreview,

    dkPickStatus(e) {
      const idx = Number(e.currentTarget.dataset.index)
      if (Number.isNaN(idx) || idx === this.data.statusIndex) return
      this.onStatusChange({ detail: { value: idx } })
    },
  },
}
