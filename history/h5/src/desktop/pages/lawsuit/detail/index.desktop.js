import api from '../../../../../../miniprogram/services/api.js'
import { isDesktop } from '../../../../runtime/viewport.js'

// 起诉单（电脑版）：右栏多显示卖家、快递单号、建单人、最后整理人——手机版 loadDetail 只留了采购单几个字段，
// 这里电脑上另读一次详情把这几项存进 dkMeta（只读展示，不参与保存）
export default {
  data: { dkMeta: null },
  onLoad(options) {
    const id = (options && options.id) || ''
    if (!id || !isDesktop.value) return
    api.getLawsuit(id)
      .then((d) => {
        this.setData({
          dkMeta: {
            seller_name: d.seller_name || '',
            tracking_no: d.tracking_no || '',
            created_by_name: d.created_by_name || '',
            created_at: d.created_at || '',
            last_action_by_name: d.last_action_by_name || '',
            last_action_at: d.last_action_at || '',
          },
        })
      })
      .catch(() => {})
  },
}
