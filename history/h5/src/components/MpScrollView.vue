<template>
  <wx-scroll-view
    ref="el"
    :class="{ 'wx-scroll-x': x, 'wx-scroll-y': y, 'wx-scroll-none': !x && !y, 'wx-no-scrollbar': noBar }"
    @scroll.passive="onScroll"
  ><slot /></wx-scroll-view>
</template>

<script>
import { isTrue, lengthToPx } from '../runtime/util.js'

// <scroll-view>：一个 overflow 容器。scrolltolower / scrolltoupper 按「进入阈值」触发一次，离开再进再触发。
export default {
  name: 'MpScrollView',
  props: {
    scrollX: { default: false },
    scrollY: { default: false },
    upperThreshold: { default: 50 },
    lowerThreshold: { default: 50 },
    scrollTop: { default: undefined },
    scrollLeft: { default: undefined },
    scrollIntoView: { default: '' },
    scrollWithAnimation: { default: false },
    showScrollbar: { default: true },
    enhanced: { default: false },
    enableFlex: { default: false },
    mpOn: { default: null },
  },
  data() {
    return { atLower: false, atUpper: true, lastTop: 0, lastLeft: 0 }
  },
  computed: {
    x() { return isTrue(this.scrollX) },
    y() { return isTrue(this.scrollY) },
    noBar() { return this.showScrollbar === false || this.showScrollbar === 'false' },
    behavior() { return isTrue(this.scrollWithAnimation) ? 'smooth' : 'auto' },
  },
  watch: {
    scrollTop(v) { this.applyTop(v) },
    scrollLeft(v) { this.applyLeft(v) },
    scrollIntoView(v) { this.$nextTick(() => this.intoView(v)) },
  },
  mounted() {
    if (this.scrollTop != null) this.applyTop(this.scrollTop)
    if (this.scrollLeft != null) this.applyLeft(this.scrollLeft)
    if (this.scrollIntoView) this.$nextTick(() => this.intoView(this.scrollIntoView))
  },
  methods: {
    emit(type, detail, e) {
      const fn = this.mpOn && this.mpOn[type]
      if (typeof fn === 'function') fn(detail, e)
    },
    applyTop(v) {
      if (v == null || v === '') return
      this.$nextTick(() => this.$refs.el.scrollTo({ top: lengthToPx(v), behavior: this.behavior }))
    },
    applyLeft(v) {
      if (v == null || v === '') return
      this.$nextTick(() => this.$refs.el.scrollTo({ left: lengthToPx(v), behavior: this.behavior }))
    },
    intoView(id) {
      if (!id) return
      const box = this.$refs.el
      let target = null
      try {
        target = box.querySelector(`#${CSS.escape(id)}`)
      } catch {
        return
      }
      if (!target) return
      const br = box.getBoundingClientRect()
      const tr = target.getBoundingClientRect()
      box.scrollTo({
        top: this.y ? box.scrollTop + tr.top - br.top : undefined,
        left: this.x ? box.scrollLeft + tr.left - br.left : undefined,
        behavior: this.behavior,
      })
    },
    onScroll(e) {
      const el = this.$refs.el
      const detail = {
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        scrollWidth: el.scrollWidth,
        deltaX: el.scrollLeft - this.lastLeft,
        deltaY: el.scrollTop - this.lastTop,
      }
      this.lastLeft = el.scrollLeft
      this.lastTop = el.scrollTop
      this.emit('scroll', detail, e)
      const lower = Number(this.lowerThreshold) || 50
      const upper = Number(this.upperThreshold) || 50
      const nearLower = this.y
        ? el.scrollHeight - el.scrollTop - el.clientHeight <= lower
        : el.scrollWidth - el.scrollLeft - el.clientWidth <= lower
      const nearUpper = this.y ? el.scrollTop <= upper : el.scrollLeft <= upper
      if (nearLower && !this.atLower) this.emit('scrolltolower', { direction: this.y ? 'bottom' : 'right' }, e)
      if (nearUpper && !this.atUpper) this.emit('scrolltoupper', { direction: this.y ? 'top' : 'left' }, e)
      this.atLower = nearLower
      this.atUpper = nearUpper
    },
  },
}
</script>
