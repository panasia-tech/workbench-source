// 上架素材分池（11-10）：候选图 可用 / 待复核 / 淘汰。上架图片管理、上架挑图两处共用。
const api = require('@services/api')

const REASONS = ['不是这个型号', '水印 / 广告字', '截图', '头像 / 表情包', '模糊 / 看不清']
const OTHER = '其他原因…'

// 角标：待复核写毛病（同款·水印），其他照来源写
function badgeOf(item, kind) {
  if (item.status === 'review') return `${kind}·${item.reason || '待复核'}`
  return kind
}

function askReason(reasons) {
  const list = ((reasons && reasons.length ? reasons : REASONS).slice(0, 5)).concat(OTHER)
  return new Promise((resolve) => {
    wx.showActionSheet({
      alertText: '为什么淘汰这张？',
      itemList: list,
      success: (r) => {
        if (list[r.tapIndex] !== OTHER) {
          resolve(list[r.tapIndex])
          return
        }
        wx.showModal({
          title: '淘汰原因',
          editable: true,
          placeholderText: '写一句为什么不能用',
          success: (m) => resolve(m.confirm && (m.content || '').trim() ? m.content.trim() : null),
          fail: () => resolve(null),
        })
      },
      fail: () => resolve(null),
    })
  })
}

// 问原因 → 标淘汰。返回服务端结果；没选原因返回 null
function reject(code, url, reasons) {
  return askReason(reasons).then((reason) => {
    if (!reason) return null
    return api.setImageStatus(code, url, 'rejected', reason).then((r) => {
      if (r.used_by && r.used_by.length) {
        wx.showModal({
          title: '已淘汰',
          content: `「${r.used_by.join('、')}」还在用这张，去这个号的图里把它拿掉。`,
          showCancel: false,
        })
      } else {
        wx.showToast({ title: '已淘汰', icon: 'none' })
      }
      return r
    })
  }).catch((err) => {
    wx.showToast({ title: (err && err.detail) || '没标上', icon: 'none' })
    return null
  })
}

function restore(code, url) {
  return api.setImageStatus(code, url, 'usable').then((r) => {
    wx.showToast({ title: r.status === 'review' ? `已放回，${r.reason || '质量差'}待复核` : '已放回', icon: 'none' })
    return r
  }).catch((err) => {
    wx.showToast({ title: (err && err.detail) || '没改成', icon: 'none' })
    return null
  })
}

module.exports = { badgeOf, reject, restore }
