<template>
  <wx-image :class="modeClass" :style="hostStyle">
    <img
      v-if="src"
      :src="src"
      alt=""
      draggable="false"
      :loading="isTrue(lazyLoad) ? 'lazy' : undefined"
      :class="{ 'wx-image--menu': isTrue(showMenuByLongpress), 'wx-image--broken': broken }"
      :style="imgStyle"
      @load="onLoad"
      @error="onError"
    >
  </wx-image>
</template>

<script>
import { isTrue } from '../runtime/util.js'

// <image>：外层是尺寸盒（默认 320×240，和小程序一样，页面 class 决定实际大小），里面的 img 按 mode 铺。
const FIT = { scaleToFill: 'fill', aspectFit: 'contain', aspectFill: 'cover' }
const POS = {
  top: 'center top', bottom: 'center bottom', center: 'center center', left: 'left center', right: 'right center',
  'top left': 'left top', 'top right': 'right top', 'bottom left': 'left bottom', 'bottom right': 'right bottom',
}

export default {
  name: 'MpImage',
  props: {
    src: { default: '' },
    mode: { default: 'scaleToFill' },
    lazyLoad: { default: false },
    showMenuByLongpress: { default: false },
    webp: { default: false },
    mpOn: { default: null },
  },
  data() {
    return { broken: false }
  },
  watch: {
    src() {
      this.broken = false
    },
  },
  computed: {
    modeClass() {
      if (this.mode === 'widthFix') return 'wx-image--width-fix'
      if (this.mode === 'heightFix') return 'wx-image--height-fix'
      return ''
    },
    hostStyle() {
      if (this.mode === 'widthFix') return { height: 'auto' }
      if (this.mode === 'heightFix') return { width: 'auto' }
      return null
    },
    imgStyle() {
      if (this.mode === 'widthFix') return { width: '100%', height: 'auto' }
      if (this.mode === 'heightFix') return { height: '100%', width: 'auto' }
      if (FIT[this.mode]) return { objectFit: FIT[this.mode] }
      if (POS[this.mode]) return { objectFit: 'none', objectPosition: POS[this.mode] }
      return { objectFit: 'fill' }
    },
  },
  methods: {
    isTrue,
    onLoad(e) {
      const fn = this.mpOn && this.mpOn.load
      if (typeof fn === 'function') fn({ width: e.target.naturalWidth, height: e.target.naturalHeight }, e)
    },
    onError(e) {
      // 加载失败：小程序是留白，浏览器会画个破图标，这里藏掉
      this.broken = true
      const fn = this.mpOn && this.mpOn.error
      if (typeof fn === 'function') fn({ errMsg: 'image load error' }, e)
    },
  },
}
</script>
