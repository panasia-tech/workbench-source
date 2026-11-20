/**
 * 调起微信扫码（条形码），封装 wx.scanCode。
 * @see https://developers.weixin.qq.com/miniprogram/dev/api/device/scan/wx.scanCode.html
 * @param {object} [options]
 * @param {boolean} [options.onlyFromCamera=true] 仅相机，不允许相册选图
 * @param {string[]} [options.scanType=['barCode']] 识别码制，可传 ['barCode','qrCode']
 * @returns {Promise<string>} 条码内容（已 trim）
 */
function scanBarcode(options = {}) {
  const { onlyFromCamera = true, scanType = ['barCode'] } = options
  return new Promise((resolve, reject) => {
    wx.scanCode({
      onlyFromCamera,
      scanType,
      success: (res) => {
        const text = (res.result || '').trim()
        if (!text) {
          wx.showToast({ title: '未识别到条码', icon: 'none' })
          reject(new Error('empty barcode'))
          return
        }
        resolve(text)
      },
      fail: (err) => {
        const msg = err.errMsg || ''
        if (msg.includes('cancel') || msg.includes('fail cancel')) {
          reject(err)
          return
        }
        wx.showToast({ title: '扫码失败', icon: 'none' })
        reject(err)
      },
    })
  })
}

module.exports = { scanBarcode }
