import api from '../../../../../miniprogram/services/api.js'
import { desktopPager, commonMethods } from '../../lib/pager.js'

// 账号档案（电脑版）：表格 + 页码；行加工（异常策略文案、采集不全）沿用页面的 _decorate，拉完顺手刷新「待完善」角标
const pager = desktopPager({
  fetch(params) {
    return api.listAccountProfiles(params).then((res) => ({ ...res, items: this._decorate(res.items || []) }))
  },
  params() {
    const p = {}
    const q = (this.data.q || '').trim()
    if (q) p.q = q
    if (this.data.status) p.status = this.data.status
    return p
  },
  after() {
    this._countPending()
  },
})

export default {
  data: { ...pager.data },
  methods: {
    ...pager.methods,
    ...commonMethods,
  },
}
