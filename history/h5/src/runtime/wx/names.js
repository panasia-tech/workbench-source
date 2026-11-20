// H5 实现了的 wx.* 接口。scripts/check-compat.mjs 拿它对照小程序源码，
// 小程序新用了这里没有的接口，构建时会打警告。实现见同目录 index.js。
export const WX_APIS = new Set([
  // 界面
  'showToast', 'hideToast', 'showLoading', 'hideLoading', 'showModal', 'showActionSheet',
  'setNavigationBarTitle', 'setNavigationBarColor', 'showNavigationBarLoading', 'hideNavigationBarLoading',
  'hideHomeButton', 'startPullDownRefresh', 'stopPullDownRefresh', 'pageScrollTo', 'nextTick',
  // 路由
  'navigateTo', 'navigateBack', 'redirectTo', 'reLaunch', 'switchTab',
  // 存储
  'getStorageSync', 'setStorageSync', 'removeStorageSync', 'clearStorageSync', 'getStorageInfoSync',
  'getStorage', 'setStorage', 'removeStorage', 'clearStorage',
  // 网络
  'request', 'uploadFile', 'downloadFile', 'connectSocket',
  // 媒体
  'chooseMedia', 'chooseImage', 'chooseVideo', 'previewImage', 'previewMedia', 'getImageInfo',
  'saveImageToPhotosAlbum',
  // 设备 / 系统
  'scanCode', 'setClipboardData', 'getClipboardData', 'makePhoneCall', 'vibrateShort', 'vibrateLong',
  'getNetworkType', 'onNetworkStatusChange', 'offNetworkStatusChange',
  'getSystemInfoSync', 'getSystemInfo', 'getWindowInfo', 'getDeviceInfo', 'getAppBaseInfo',
  'getMenuButtonBoundingClientRect',
  'getAccountInfoSync', 'getLaunchOptionsSync', 'getEnterOptionsSync', 'canIUse',
  'getUpdateManager', 'onAppShow', 'onAppHide', 'offAppShow', 'offAppHide',
  'reportAnalytics', 'reportMonitor', 'createSelectorQuery',
])
