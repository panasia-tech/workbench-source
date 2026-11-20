<template>
  <wx-navigator v-mp-hover="{ cls: hoverClass, start: hoverStartTime, stay: hoverStayTime }" role="link" @click="go"><slot /></wx-navigator>
</template>

<script>
import { wx } from '../runtime/wx/index.js'

export default {
  name: 'MpNavigator',
  props: {
    url: { default: '' },
    openType: { default: 'navigate' },
    delta: { default: 1 },
    hoverClass: { default: 'navigator-hover' },
    hoverStartTime: { default: 50 },
    hoverStayTime: { default: 600 },
    mpOn: { default: null },
  },
  methods: {
    go() {
      const done = (type) => (res) => {
        const fn = this.mpOn && this.mpOn[type]
        if (typeof fn === 'function') fn(res)
      }
      const o = { url: this.url, success: done('success'), fail: done('fail'), complete: done('complete') }
      const map = { navigate: 'navigateTo', redirect: 'redirectTo', switchTab: 'switchTab', reLaunch: 'reLaunch' }
      if (this.openType === 'navigateBack') wx.navigateBack({ delta: Number(this.delta) || 1, ...o })
      else if (map[this.openType]) wx[map[this.openType]](o)
    },
  },
}
</script>
