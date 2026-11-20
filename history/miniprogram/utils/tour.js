// 新手导览只在 H5 里有（h5/src/shell/Tour.vue）：页面上点「怎么用」时通知它走一遍本页；小程序里没有 window，什么都不做
function startTour() {
  if (typeof window !== 'undefined' && window.dispatchEvent) window.dispatchEvent(new Event('mp:tour'))
}

// 「上手练习」里的「重看新手导览」：清掉看过的记录，下次进各页又会自动走一遍
function resetTours() {
  if (typeof window !== 'undefined' && window.dispatchEvent) window.dispatchEvent(new Event('mp:tour-reset'))
}

module.exports = { startTour, resetTours }
