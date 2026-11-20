<template>
  <input
    ref="el"
    class="wx-input"
    :class="phClasses"
    :type="htmlType"
    :inputmode="inputMode"
    :pattern="type === 'number' ? '[0-9]*' : undefined"
    :enterkeyhint="enterKeyHint"
    :value="shown"
    :placeholder="placeholder"
    :disabled="isTrue(disabled)"
    :maxlength="maxLen"
    :name="name || undefined"
    :autocomplete="autocomplete || 'off'"
    autocapitalize="off"
    autocorrect="off"
    spellcheck="false"
    @input="onInput"
    @keydown.enter="onEnter"
    @focus="onFocus"
    @blur="onBlur"
    @compositionstart="composing = true"
    @compositionend="onCompositionEnd"
  >
</template>

<script>
import { beginCapture, endCapture } from '../runtime/instance.js'
import { isTrue } from '../runtime/util.js'

// <input>：事件 detail 与小程序一致（value / cursor），bindinput 返回字符串会替换输入框内容。
export default {
  name: 'MpInput',
  props: {
    value: { default: '' },
    type: { default: 'text' },
    password: { default: false },
    placeholder: { default: '' },
    placeholderClass: { default: '' },
    placeholderStyle: { default: '' },
    disabled: { default: false },
    maxlength: { default: 140 },
    focus: { default: false },
    autoFocus: { default: false },
    confirmType: { default: 'done' },
    confirmHold: { default: false },
    name: { default: '' },
    // H5 专用（小程序 input 没有这个属性）：登录页用 username / current-password，让系统的密码管理认得出
    autocomplete: { default: '' },
    mpOn: { default: null },
  },
  data() {
    return { composing: false }
  },
  computed: {
    shown() {
      return this.value == null ? '' : String(this.value)
    },
    htmlType() {
      return isTrue(this.password) || this.type === 'safe-password' ? 'password' : 'DEMO_ONLY_REDACTED'
    },
    inputMode() {
      if (this.type === 'number') return 'numeric'
      if (this.type === 'digit') return 'decimal'
      return undefined
    },
    enterKeyHint() {
      const map = { send: 'send', search: 'search', next: 'next', go: 'go', done: 'done' }
      return map[this.confirmType] || 'done'
    },
    maxLen() {
      const n = Number(this.maxlength)
      return Number.isFinite(n) && n >= 0 ? n : undefined
    },
    phClasses() {
      return String(this.placeholderClass || '').split(/\s+/).filter(Boolean).map((c) => `wx-ph--${c}`)
    },
  },
  watch: {
    focus(v) {
      if (isTrue(v)) this.$nextTick(() => this.$refs.el && this.$refs.el.focus())
    },
  },
  mounted() {
    if (isTrue(this.focus) || isTrue(this.autoFocus)) this.$refs.el.focus()
  },
  methods: {
    isTrue,
    emit(type, detail, e) {
      const fn = this.mpOn && this.mpOn[type]
      return typeof fn === 'function' ? fn(detail, e) : undefined
    },
    onInput(e) {
      if (this.composing) return
      this.dispatchInput(e)
    },
    onCompositionEnd(e) {
      this.composing = false
      this.dispatchInput(e)
    },
    dispatchInput(e) {
      const el = e.target
      const value = el.value
      let ret
      let written
      beginCapture()
      try {
        ret = this.emit('input', { value, cursor: el.selectionStart == null ? value.length : el.selectionStart, keyCode: undefined }, e)
      } finally {
        written = endCapture()
      }
      if (typeof ret === 'string' || typeof ret === 'number') {
        el.value = String(ret)
        return
      }
      // 页面在 bindinput 里把值改了（比如截掉多余小数），但改完和改之前一样、Vue 不重渲染时，手动回写一下
      this.$nextTick(() => {
        const want = this.shown
        if (el.value !== want && written.has(want)) el.value = want
      })
    },
    onEnter(e) {
      if (e.isComposing) return
      this.emit('confirm', { value: e.target.value }, e)
      if (!isTrue(this.confirmHold)) e.target.blur()
    },
    onFocus(e) {
      this.emit('focus', { value: e.target.value, height: 0 }, e)
    },
    onBlur(e) {
      this.emit('blur', { value: e.target.value, cursor: e.target.selectionStart }, e)
    },
  },
}
</script>
