// App({...})：getApp() 返回的就是传给 App 的那个对象（带 globalData 和自定义方法）
let appInstance = { globalData: {} }

export function initApp(def) {
  const o = (def && def.options) || {}
  if (!o.globalData) o.globalData = {}
  appInstance = o
  return appInstance
}

export function launchApp(info) {
  for (const hook of ['onLaunch', 'onShow']) {
    if (typeof appInstance[hook] !== 'function') continue
    try {
      appInstance[hook](info)
    } catch (e) {
      console.error(`[app] ${hook} 出错：`, e)
    }
  }
}

export function getApp() {
  return appInstance
}
