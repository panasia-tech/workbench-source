<template>
  <wx-picker :class="{ 'wx-picker--disabled': dis }" @click="open">
    <slot />
    <input
      v-if="nativeType"
      ref="native"
      class="wx-picker__native"
      :type="nativeType"
      :value="nativeValue"
      :min="start || undefined"
      :max="end || undefined"
      :disabled="dis"
      tabindex="-1"
      aria-hidden="true"
      @click.stop="showNative"
      @change="onNativeChange"
    >
  </wx-picker>
</template>

<script>
import { openPickerSheet } from '../runtime/ui.js'
import { isTrue, warnOnce } from '../runtime/util.js'

// <picker>
//   selector / multiSelector → 底部滚轮（自己画，确认时总会触发 change，和小程序一致）
//   date / time             → 系统原生选择器（iOS 滚轮、安卓日历都比自己画的顺手）
//   date + fields=month/year → 支持 month 输入框就用原生，否则滚轮

const supportsType = (() => {
  const cache = {}
  return (t) => {
    if (!(t in cache)) {
      const i = document.createElement('input')
      i.setAttribute('type', t)
      cache[t] = i.type === t
    }
    return cache[t]
  }
})()

export default {
  name: 'MpPicker',
  props: {
    mode: { default: 'selector' },
    range: { default: () => [] },
    rangeKey: { default: '' },
    value: { default: undefined },
    start: { default: '' },
    end: { default: '' },
    fields: { default: 'day' },
    disabled: { default: false },
    headerText: { default: '' },
    mpOn: { default: null },
  },
  computed: {
    dis() {
      return isTrue(this.disabled)
    },
    nativeType() {
      if (this.mode === 'time') return 'time'
      if (this.mode !== 'date') return ''
      if (this.fields === 'month') return supportsType('month') ? 'month' : ''
      if (this.fields === 'year') return ''
      return 'date'
    },
    nativeValue() {
      return this.value == null ? '' : String(this.value)
    },
  },
  methods: {
    emit(type, detail, e) {
      const fn = this.mpOn && this.mpOn[type]
      return typeof fn === 'function' ? fn(detail, e) : undefined
    },
    labels(list) {
      return (Array.isArray(list) ? list : []).map((item) => {
        if (this.rangeKey && item && typeof item === 'object') return item[this.rangeKey] == null ? '' : String(item[this.rangeKey])
        return item == null ? '' : String(item)
      })
    },
    showNative() {
      const el = this.$refs.native
      if (!el || this.dis) return
      try {
        if (el.showPicker) el.showPicker()
      } catch {
        /* 已经在点击里，原生行为会接着弹 */
      }
    },
    onNativeChange(e) {
      const v = e.target.value
      if (!v) return // iOS 的「清除」：小程序的 picker 没有清空，忽略
      this.emit('change', { value: v }, e)
    },
    async open() {
      if (this.dis || this.nativeType) return
      if (this.mode === 'selector') {
        const cols = [this.labels(this.range)]
        if (!cols[0].length) return
        const anchor = this.$el && this.$el.getBoundingClientRect ? this.$el.getBoundingClientRect() : null
        const res = await openPickerSheet({ columns: cols, value: [Number(this.value) || 0], title: this.headerText, anchor })
        if (res) this.emit('change', { value: String(res[0]) })
        else this.emit('cancel', {})
      } else if (this.mode === 'multiSelector') {
        const cols = (Array.isArray(this.range) ? this.range : []).map((c) => this.labels(c))
        const value = Array.isArray(this.value) ? this.value : []
        const res = await openPickerSheet({ columns: cols, value, title: this.headerText })
        if (res) this.emit('change', { value: res })
        else this.emit('cancel', {})
      } else if (this.mode === 'date') {
        await this.openYearMonth()
      } else {
        warnOnce(`picker mode="${this.mode}" 在 H5 里没有实现`)
      }
    },
    async openYearMonth() {
      const now = new Date()
      const startY = Number(String(this.start || '').slice(0, 4)) || now.getFullYear() - 20
      const endY = Number(String(this.end || '').slice(0, 4)) || now.getFullYear() + 5
      const years = []
      for (let y = startY; y <= endY; y++) years.push(y)
      const cur = String(this.value || '')
      const cy = Number(cur.slice(0, 4)) || now.getFullYear()
      const cm = Number(cur.slice(5, 7)) || now.getMonth() + 1
      const columns = [years.map((y) => `${y}年`)]
      const value = [Math.max(0, years.indexOf(cy))]
      if (this.fields === 'month') {
        columns.push(Array.from({ length: 12 }, (_, i) => `${i + 1}月`))
        value.push(cm - 1)
      }
      const res = await openPickerSheet({ columns, value, title: this.headerText })
      if (!res) {
        this.emit('cancel', {})
        return
      }
      const y = years[res[0]]
      const v = this.fields === 'month' ? `${y}-${String(res[1] + 1).padStart(2, '0')}` : String(y)
      this.emit('change', { value: v })
    },
  },
}
</script>
