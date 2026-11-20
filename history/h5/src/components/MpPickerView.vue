<template>
  <wx-picker-view ref="el" :style="{ '--pv-item-h': `${itemH}px`, '--pv-pad': `${pad}px` }">
    <slot />
    <div class="wx-pv__mask" :style="{ backgroundSize: `100% ${pad}px` }" />
    <div class="wx-pv__indicator" :style="{ top: `${pad}px`, height: `${itemH}px` }" />
  </wx-picker-view>
</template>

<script>
import { lengthToPx } from '../runtime/util.js'

// <picker-view>：列是 <picker-view-column>，子项高度强制等于选中框高度（小程序也是这么排的）
export default {
  name: 'MpPickerView',
  provide() {
    return { mpPickerView: this }
  },
  props: {
    value: { default: () => [] },
    indicatorStyle: { default: '' },
    indicatorClass: { default: '' },
    maskStyle: { default: '' },
    mpOn: { default: null },
  },
  data() {
    return { columns: [], height: 0 }
  },
  computed: {
    itemH() {
      const m = String(this.indicatorStyle || '').match(/height\s*:\s*([\d.]+\s*(?:rpx|px)?)/)
      return Math.round(m ? lengthToPx(m[1].replace(/\s+/g, ''), 34) : 34)
    },
    pad() {
      return Math.max(0, Math.round((this.height - this.itemH) / 2))
    },
  },
  mounted() {
    this.measure()
    if (window.ResizeObserver) {
      this.ro = new ResizeObserver(() => this.measure())
      this.ro.observe(this.$refs.el)
    }
  },
  beforeUnmount() {
    if (this.ro) this.ro.disconnect()
  },
  methods: {
    measure() {
      this.height = this.$refs.el ? this.$refs.el.clientHeight : 0
    },
    register(col) {
      this.columns.push(col)
      return this.columns.length - 1
    },
    unregister(col) {
      const i = this.columns.indexOf(col)
      if (i >= 0) this.columns.splice(i, 1)
    },
    indexOf(col) {
      return this.columns.indexOf(col)
    },
    valueAt(i) {
      const v = Array.isArray(this.value) ? this.value[i] : 0
      return Number(v) || 0
    },
    columnChanged() {
      const value = this.columns.map((c) => c.current())
      const fn = this.mpOn && this.mpOn.change
      if (typeof fn === 'function') fn({ value })
    },
  },
}
</script>
