// 直接上架入口(仓库列表/详情、上架列表等跳过上架信息表单页的入口)共用:
// 若该 SKU 从未保存过上架信息(服务端返回 status=DRAFT),按表单默认值自动保存一次,
// 保证上架页和服务端建品/publish 有数据;已保存过则原样不动。
const api = require('./api')
const listingFormConfig = require('./listing-form-config')

function ensureListingSaved(skuCode) {
  if (!skuCode) return Promise.resolve(false)
  return listingFormConfig
    .ensureFormConfig()
    .then(() => api.getListing(skuCode))
    .then((info) => {
      if (!info || info.status !== 'DRAFT') return false
      const defaults = listingFormConfig.getDefaults()
      const price =
        Number(info.price) > 0
          ? Number(info.price)
          : Number(info.suggest_price) > 0
            ? Number(info.suggest_price)
            : null
      // 没有有效售价(建议价 0)就不自动保存:提交了后端也会 400 拒,留着 DRAFT 让用户去表单页填价
      if (price == null) return false
      return api
        .saveListing(skuCode, {
          title: info.title || info.product_name || '',
          desc: info.desc || '',
          price,
          original_price: info.original_price != null ? Number(info.original_price) : null,
          express_fee: defaults.express_fee ? Number(defaults.express_fee) : null,
          images: info.images || [],
          stuff_status: defaults.stuff_status != null ? defaults.stuff_status : 95,
        })
        .then(() => true)
    })
}

// 跳转上架页前默认保存一次;保存失败不阻塞跳转(上架页会展示真实错误)。
function gotoPublish(skuCode) {
  if (!skuCode) return
  ensureListingSaved(skuCode)
    .catch(() => {})
    .then(() => {
      wx.navigateTo({ url: `/pages/listing/publish/index?code=${skuCode}` })
    })
}

module.exports = { ensureListingSaved, gotoPublish }
