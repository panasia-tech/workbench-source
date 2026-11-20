const auth = require('./services/auth')
const appConfig = require('./services/config')
const listingFormConfig = require('./services/listing-form-config')

App({
  globalData: {
    user: null,
    tabs: [],
    landingPage: '',
    /** @type {{ orderId?: string, skuCode?: string } | null} */
  },

  onLaunch() {
    auth.bootstrap(this).then(() => {
      if (wx.getStorageSync('token')) {
        return Promise.all([
          appConfig.refreshConfig(),
          listingFormConfig.refreshFormConfig(),
        ])
      }
      return null
    }).catch(() => {})
  },
})
