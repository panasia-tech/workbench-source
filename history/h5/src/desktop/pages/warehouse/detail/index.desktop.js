import { wx } from '../../../../runtime/globals.js'

// 商品详情（电脑版）：各店铺那一行的「⋯」弹菜单在电脑上直接平铺成操作链接，分支和手机版 onShopMore 一样
export default {
  methods: {
    dkShopAct(e) {
      const { index, act } = e.currentTarget.dataset
      const shop = this.data.shops[Number(index)]
      if (!shop) return
      if (act === 'delist') this.goDelist()
      else if (act === 'publish') this.goPublish()
      else if (shop.age && shop.age.can_refresh) this._confirmRefresh(`重新上架「${shop.shop_label}」？`, [shop.shop_id])
      else wx.showToast({ title: (shop.age && shop.age.note) || '这家店现在不能重新上架', icon: 'none' })
    },
  },
}
