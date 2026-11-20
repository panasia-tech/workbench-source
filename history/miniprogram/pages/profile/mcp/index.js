const api = require('@services/api')

Page({
  data: {
    loading: true,
    enabled: false,
    url: '',
    key: '',
    error: '',
  },

  onLoad() {
    api
      .mcpInfo()
      .then((r) => {
        this.setData({ loading: false, enabled: !!r.enabled, url: r.url || '', key: r.key || '' })
      })
      .catch((err) => {
        this.setData({ loading: false, error: err.detail || '加载失败' })
      })
  },

  copy(e) {
    const text = e.currentTarget.dataset.text
    if (!text) return
    wx.setClipboardData({ data: text })
  },

  copyConfig() {
    // Kimi Code / Claude Code / Cursor 等通用 streamable-http MCP 配置
    const snippet = JSON.stringify(
      {
        mcpServers: {
          'erp-readonly': {
            type: 'http',
            url: this.data.url,
            headers: { Authorization: `Bearer ${this.data.key}` },
          },
        },
      },
      null,
      2
    )
    wx.setClipboardData({ data: snippet })
    wx.showToast({ title: '配置已复制' })
  },
})
