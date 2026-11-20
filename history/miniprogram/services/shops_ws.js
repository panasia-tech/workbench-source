const { BASE_URL } = require('./request')

// GET /skus/{code}/shops 的推送版:连上后服务端代跑回写,快照变了推一帧
// ({type:'shops', shops, settled}),全部收敛(gc_pending 清零)后推 settled 并关闭。
// 连不上/异常断开时走 onFallback(),页面回退 HTTP 轮询——WS 只是更快的路径,不是唯一路径。
function watchSkuShops(skuCode, handlers) {
  const token = wx.getStorageSync('token')
  const wsBase = BASE_URL.replace(/^http/, 'ws')
  const task = wx.connectSocket({
    url: `${wsBase}/ws/sku-shops/${encodeURIComponent(skuCode)}?token=${token}`,
  })
  let opened = false
  let settledSeen = false

  task.onOpen(() => {
    opened = true
  })
  task.onMessage((res) => {
    try {
      const msg = JSON.parse(res.data)
      if (msg.type !== 'shops') return
      if (msg.settled) settledSeen = true
      handlers.onShops && handlers.onShops(msg.shops || [], !!msg.settled)
    } catch (e) { /* 坏帧忽略,等下一帧 */ }
  })
  task.onError(() => {
    if (!opened) {
      handlers.onFallback && handlers.onFallback()
    }
  })
  task.onClose(() => {
    // 服务端收敛后正常关闭(settledSeen)是结束;否则视为异常断开,回退轮询。
    handlers.onClose && handlers.onClose({ settled: settledSeen, opened })
  })

  return {
    close() {
      settledSeen = true // 主动关闭不触发回退
      task.close({})
    },
  }
}

module.exports = { watchSkuShops }
