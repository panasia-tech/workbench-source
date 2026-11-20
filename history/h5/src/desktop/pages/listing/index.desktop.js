import { commonMethods } from '../../lib/pager.js'

// 群控中心（电脑版）：数字卡片要三个筛选各有几件——跟在原筛选后面算一下，手机上多一个没人用的字段，不影响
function countOf(items) {
  const counts = { all: items.length, draft: 0, list: 0 }
  items.forEach((item) => {
    const s = item.listing_status
    if (!s || s === 'DRAFT') counts.draft += 1
    if (s === 'READY' || s === 'CREATED' || s === 'FAILED') counts.list += 1
  })
  return counts
}

export default {
  data: { dkCounts: { all: 0, draft: 0, list: 0 } },
  methods: {
    ...commonMethods,

    applyFilter() {
      this.__mobile_applyFilter()
      this.setData({ dkCounts: countOf(this.data.allItems || []) })
    },
  },
}
