import { wx } from '../../../../../runtime/globals.js'
import { commonMethods } from '../../../../lib/pager.js'

// 上架审批 · 一件货（电脑版）。手机上点已选的图弹菜单（看大图 / 设为首图 / 去水印 / 拿掉），
// 电脑上图上悬停直接出按钮，点哪个做哪个——做法照原页面 tapPicked 里的那几步，存草稿、提交、审批都还是原方法。
export default {
  data: { dkDewmOk: false },

  // 去水印按钮要等原页面问完「京东云那台能不能用」（this.dewmOk，不在 data 里）才知道显不显示：盯 10 秒
  onLoad() {
    let n = 0
    this.__dkDewmTimer = setInterval(() => {
      n += 1
      if (this.dewmOk !== undefined || n > 20) {
        clearInterval(this.__dkDewmTimer)
        this.__dkDewmTimer = null
        this.setData({ dkDewmOk: !!this.dewmOk })
      }
    }, 500)
  },

  onUnload() {
    if (this.__dkDewmTimer) clearInterval(this.__dkDewmTimer)
  },

  methods: {
    ...commonMethods,

    dkPickedAct(e) {
      const { id, index, act } = e.currentTarget.dataset
      const card = this.data.cards[this._index(id)]
      const i = Number(index)
      const raw = card && card.images[i] && card.images[i].raw
      if (!raw) return
      const d = this.drafts[id]
      if (act === '看大图') {
        const urls = d.images.map((u) => (this.urls[u] && this.urls[u].url) || u)
        wx.previewImage({ urls, current: urls[i] })
        return
      }
      if (!card.editable) return
      if (act === '去水印') {
        if (this.dewmOk) this._dewatermark(id, raw)
        return
      }
      d.images = act === '设为首图' ? [raw].concat(d.images.filter((u) => u !== raw)) : d.images.filter((u) => u !== raw)
      d.dirty = true
      this._render()
    },
  },
}
