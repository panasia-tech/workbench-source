import api from '../../../../../miniprogram/services/api.js'
import { desktopPager, commonMethods } from '../../lib/pager.js'

// 起诉记录（电脑版）：表格 + 页码（每页 50 条）。状态文字和手机版 index.js 的 STATUS_META 同一张表
const STATUS_META = {
  DRAFT: { text: '待提交证据', cls: 'tag-muted' },
  EVIDENCE_SUBMITTED: { text: '已提交证据', cls: 'tag-warning' },
  SUBMITTED_LAWYER: { text: '已提交律师回复', cls: 'tag-info' },
  PENDING_HEARING: { text: '待开庭', cls: 'tag-warning' },
  JUDGED: { text: '已判决', cls: 'tag-success' },
}

function decorate(item) {
  const meta = STATUS_META[item.status] || STATUS_META.DRAFT
  return { ...item, statusText: meta.text, statusCls: meta.cls }
}

const pager = desktopPager({
  fetch: (params) => api.listLawsuits(params).then((res) => ({ ...res, items: (res.items || []).map(decorate) })),
  params() {
    const { q, status } = this.data
    const p = {}
    if ((q || '').trim()) p.q = q.trim()
    if (status) p.status = status
    return p
  },
})

export default {
  data: { ...pager.data },
  methods: {
    ...pager.methods,
    ...commonMethods,
  },
}
