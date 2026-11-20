// 录入资产（电脑版）：成色四档直接平铺成一排按钮，点一下等于在原来的下拉里选中那一项
export default {
  methods: {
    dkPickGrade(e) {
      if (!this.data.editable) return
      const idx = Number(e.currentTarget.dataset.index)
      if (Number.isNaN(idx) || idx === this.data.gradeIndex) return
      this.pickGrade({ detail: { value: idx } })
    },
  },
}
