import api from '../../../../../../miniprogram/services/api.js'
import { isDesktop } from '../../../../runtime/viewport.js'
import { desktopPager, commonMethods } from '../../../lib/pager.js'

// 创建退货单（电脑版）：左边出库记录表格 + 页码（每页 50 条），右边填退货信息。
// 手机版的 loadList(reset) 是 scroll-view 触底加载；电脑上 reset 时拉第 1 页、触底不加载，翻页走页码
const pager = desktopPager({
  fetch: (params) => api.listOutbounds(params),
  params() {
    const p = { all_operators: true }
    const q = (this.data.q || '').trim()
    if (q) p.q = q
    return p
  },
})

export default {
  data: { ...pager.data, total: 0 },
  methods: {
    dkLoad: pager.methods.dkLoad,
    dkPrev: pager.methods.dkPrev,
    dkNext: pager.methods.dkNext,
    ...commonMethods,

    loadList(reset) {
      if (!isDesktop.value) return this.__mobile_loadList(reset)
      return reset ? this.dkLoad(1) : Promise.resolve()
    },

    // 电脑上直接在表格里取消选中（手机上是再点一次那一行）
    dkUnselect() {
      this.setData({ selectedCode: '' })
    },
  },
}
