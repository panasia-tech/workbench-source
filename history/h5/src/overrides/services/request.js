// H5 版 request：和小程序版同一套返回约定（2xx resolve 响应体，其余 reject 并带 statusCode）。
// 差别只在 401：H5 没有 wx.login 可以静默重登，直接回登录页。
// BASE_URL 默认同源（页面挂在 panasia.fun/h5/，接口走同域名的 /api，省掉跨域预检）。
const BASE_URL = String(import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '')

function networkError(err) {
  const detail = navigator.onLine ? '服务器连不上，稍后再试' : '网络断了，连上再试'
  return { ...(err || {}), detail }
}

function rawRequest(options) {
  const token = wx.getStorageSync('token')
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${BASE_URL}${options.url}`,
      method: options.method || 'GET',
      data: options.data,
      header: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data)
        } else {
          const error = (res.data && typeof res.data === 'object')
            ? res.data
            : { detail: res.data || '请求失败' }
          error.statusCode = res.statusCode
          reject(error)
        }
      },
      fail(err) {
        reject(networkError(err))
      },
    })
  })
}

function request(options) {
  return rawRequest(options).catch((err) => {
    if (err && err.statusCode === 401 && !options._noAuthRedirect) {
      // 延迟 require：request -> auth -> api -> request 会成环
      require('./auth').handleUnauthorized(options.url)
    }
    throw err
  })
}

module.exports = { request, BASE_URL }
