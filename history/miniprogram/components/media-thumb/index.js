const media = require('../../utils/media')

Component({
  properties: {
    url: { type: String, value: '' },
    previewUrl: { type: String, value: '' },
    size: { type: String, value: 'medium' },
    preview: { type: Boolean, value: true },
    groupUrls: { type: Array, value: [] },
  },

  data: {
    archived: false,
    displayUrl: '',
    isVideo: false,
    hasMedia: false,
  },

  observers: {
    url(value) {
      this.syncUrl(value)
    },
  },

  lifetimes: {
    attached() {
      this.syncUrl(this.properties.url)
    },
  },

  methods: {
    syncUrl(url) {
      this.setData(media.normalizeMedia(url))
    },

    onTap() {
      const { archived, displayUrl, isVideo } = this.data
      if (archived) {
        wx.showToast({ title: '文件已归档至 NAS', icon: 'none' })
        this.triggerEvent('archivedtap', { url: this.properties.url })
        return
      }
      if (!this.properties.preview) {
        this.triggerEvent('tap', { url: this.properties.url })
        return
      }
      const previewRaw = this.properties.previewUrl || this.properties.url
      const preview = media.resolveDisplayUrl(previewRaw)
      if (!preview) return
      if (isVideo) {
        wx.previewMedia({ sources: [{ url: preview, type: 'video' }] })
      } else {
        const group = media.previewUrls(this.properties.groupUrls)
        const urls = group.length ? group : [preview]
        wx.previewImage({ urls, current: urls.indexOf(preview) >= 0 ? preview : urls[0] })
      }
      this.triggerEvent('tap', { url: preview })
    },
  },
})
