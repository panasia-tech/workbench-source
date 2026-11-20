// 同一份页面代码既跑在小程序里，也被 h5/ 编译成网页。少数地方两边做法不同，在这里分开。

// H5 运行时的 getAppBaseInfo 回 SDKVersion: 'h5'（h5/src/runtime/wx/index.js）
function isH5() {
  try {
    return wx.getAppBaseInfo().SDKVersion === 'h5'
  } catch (e) {
    return false
  }
}

// 打开外部链接：H5 新开标签页；小程序打不开外站，复制链接让人去浏览器或闲鱼里打开
function openUrl(url) {
  if (!url) return
  if (isH5()) {
    window.open(url, '_blank', 'noopener')
    return
  }
  wx.setClipboardData({
    data: url,
    success: () => wx.showToast({ title: '链接已复制，去闲鱼里打开', icon: 'none' }),
  })
}

// 自己画导航栏（页面配置 navigationStyle: custom）时的尺寸：
// navPadTop 顶部让出状态栏；navHeight 和胶囊按钮等高对齐；navPadRight 给小程序右上角胶囊让位
function navMetrics() {
  let win = {}
  try {
    win = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {}
  } catch (e) {}
  const statusBar = win.statusBarHeight || 0
  let rect = null
  try {
    rect = wx.getMenuButtonBoundingClientRect()
  } catch (e) {}
  const navHeight = rect && rect.height ? (rect.top - statusBar) * 2 + rect.height : 44
  const navPadRight = rect && rect.left && win.windowWidth ? Math.max(0, win.windowWidth - rect.left) : 0
  return {
    // H5 的状态栏高度是 0，刘海屏靠 safe-area 让位
    navPadTop: isH5() ? 'env(safe-area-inset-top)' : `${statusBar}px`,
    navHeight,
    navPadRight,
  }
}

module.exports = { isH5, openUrl, navMetrics }
