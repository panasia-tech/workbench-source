// 账号档案（电脑版）：运营商、账号种类直接平铺成一排按钮，点一下等于在原来的下拉里选中那一项
export default {
  methods: {
    dkPickCarrier(e) {
      const idx = Number(e.currentTarget.dataset.index)
      if (Number.isNaN(idx)) return
      this.onCarrierChange({ detail: { value: idx } })
    },

    dkPickType(e) {
      const idx = Number(e.currentTarget.dataset.index)
      if (Number.isNaN(idx)) return
      this.onTypeChange({ detail: { value: idx } })
    },
  },
}
