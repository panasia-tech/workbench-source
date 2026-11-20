const media = require('../../utils/media')

Component({
  properties: {
    urls: { type: Array, value: [] },
    displayUrls: { type: Array, value: [] },
    thumbSize: { type: String, value: 'medium' },
    preview: { type: Boolean, value: true },
    removable: { type: Boolean, value: false },
  },

  data: {
    items: [],
  },

  observers: {
    'urls, displayUrls'() {
      this.syncUrls(this.getEffectiveUrls())
    },
  },

  lifetimes: {
    attached() {
      this.syncUrls(this.getEffectiveUrls())
    },
  },

  methods: {
    getEffectiveUrls() {
      const displayUrls = this.properties.displayUrls || []
      if (displayUrls.length) return displayUrls
      return this.properties.urls || []
    },

    syncUrls(urls) {
      this.setData({ items: media.normalizeMediaList(urls) })
    },

    onThumbTap(e) {
      const index = e.currentTarget.dataset.index
      const item = this.data.items[index]
      if (!item || item.archived) return
      const all = media.previewUrls(this.getEffectiveUrls())
      if (!all.length) return
      const current = item.displayUrl
      const currentIndex = Math.max(0, all.indexOf(current))
      if (item.isVideo) {
        wx.previewMedia({ sources: [{ url: current, type: 'video' }] })
      } else {
        wx.previewImage({ urls: all, current })
      }
      this.triggerEvent('preview', { index: currentIndex, url: current })
    },

    onRemoveTap(e) {
      const index = e.currentTarget.dataset.index
      this.triggerEvent('remove', { index })
    },
  },
})
