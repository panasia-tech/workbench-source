const BASE_URL = 'http://127.0.0.1:8000'

// 统一把后端/网络原始报错翻成人话:detail 在这里改写一次,
// 各页面 err.detail 拿到的就已是可展示文案(中文业务提示原样放行,见 errmsg.js)
const { friendly } = require('@utils/errmsg')

function rawRequest(options) {
  const token = wx.getStorageSync('token')
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${BASE_URL}${options.url}`,
      method: options.method || 'GET',
      data: options.data,
      ...(options.timeout ? { timeout: options.timeout } : {}),
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
            : { detail: res.data || '' }
          error.statusCode = res.statusCode
          error.detail = friendly(error)
          reject(error)
        }
      },
      fail(wxErr) {
        reject({ statusCode: 0, detail: friendly(wxErr), errMsg: wxErr && wxErr.errMsg })
      },
    })
  })
}

// 并发 401 只触发一次静默重登
let reloginPromise = null

function silentRelogin() {
  if (!reloginPromise) {
    // 延迟 require 避免 request -> auth -> api -> request 循环依赖
    const auth = require('./auth')
    reloginPromise = auth.bootstrap().then(
      (data) => { reloginPromise = null; return data },
      (err) => { reloginPromise = null; throw err }
    )
  }
  return reloginPromise
}

function request(options) {
  return rawRequest(options).catch((err) => {
    if (!err || err.statusCode !== 401 || options._retried) throw err
    const oldToken = wx.getStorageSync('token')
    return silentRelogin().then(() => {
      const newToken = wx.getStorageSync('token')
      // 重登失败（未绑定/被停用），bootstrap 已跳转绑定页
      if (!newToken || newToken === oldToken) throw err
      return rawRequest({ ...options, _retried: true })
    })
  })
}

module.exports = { request, BASE_URL }
