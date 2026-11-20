import api from '../../../../../../miniprogram/services/api.js'
import material from '../../../../../../miniprogram/utils/image-material.js'
import { wx } from '../../../../runtime/globals.js'

// 店铺上架（电脑版）：手机上「点店铺展开 / 收起」「长按看大图或淘汰」在电脑上换成左边点店铺、图上悬停出按钮。
// 选图规则（每店至少 1 张、店铺之间不重复、最多 9 张）全在原页面的 togglePickImage / submitPublish 里，这里不碰。

// 跟原页面 imageOptionsOf 一样：候选图 = 实拍 + 同款，待复核的角标写毛病
function imageOptionsOf(opts) {
  const photos = ((opts && opts.photos) || []).map((o) => ({
    ...o,
    kind: material.badgeOf(o, o.kind || '实拍'),
  }))
  const crawled = ((opts && opts.crawled) || []).map((o) => ({
    ...o,
    kind: material.badgeOf(o, o.kind || '同款'),
  }))
  return {
    imgOptions: photos.concat(crawled),
    imgPhotoCount: photos.length,
    imgCrawledCount: crawled.length,
    imgCrawledUsableCount: crawled.filter((o) => o.status !== 'review').length,
    crawlStatus: (opts && opts.crawl_status) || '',
    crawlProgress: (opts && opts.crawl_progress) || null,
    crawlError: (opts && opts.crawl_error) || '',
    archiveCount: (opts && opts.archive_count) || 0,
    crawlerEnabled: !opts || opts.crawler_enabled !== false,
    spuMatch: (opts && opts.spu_match) || null,
    imgHeld: (opts && opts.held) || {},
    imgRejectReasons: (opts && opts.reject_reasons) || [],
  }
}

export default {
  methods: {
    // 左边点店铺只打开、不收起（手机上再点一下是收起）
    dkOpenPickShop(e) {
      const id = e.currentTarget.dataset.id
      if (id && id !== this.data.pickShopId) this._setImages({ pickShopId: id })
    },

    dkPreviewPick(e) {
      const { preview, url } = e.currentTarget.dataset
      const current = preview || url
      if (!current) return
      const urls = this.data.imgOptions.map((o) => o.preview || o.url).filter(Boolean)
      wx.previewImage({ urls: urls.length ? urls : [current], current })
    },

    // 同手机长按菜单里的「淘汰这张」：问原因 → 标淘汰 → 各店铺里拿掉这张 → 重拉候选
    dkRejectPick(e) {
      const { url } = e.currentTarget.dataset
      material.reject(this.data.skuCode, url, this.data.imgRejectReasons).then((res) => {
        if (!res) return
        const shopImages = {}
        Object.keys(this.data.shopImages || {}).forEach((id) => {
          shopImages[id] = this.data.shopImages[id].filter((u) => u !== url)
        })
        return api.listingImageOptions(this.data.skuCode).then((opts) => {
          this._setImages({ ...imageOptionsOf(opts), shopImages })
        })
      })
    },

    // 原模板靠 button 的 disabled 挡；电脑版用 view 当按钮，在这里挡（缺图的提示仍由 submitPublish 自己弹）
    dkSubmit() {
      if (this.data.submitting || !this.data.selectedCount) return
      this.submitPublish()
    },
  },
}
