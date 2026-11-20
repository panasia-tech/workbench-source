<template>
  <textarea
    ref="el"
    class="wx-textarea"
    :class="[phClasses, { 'wx-textarea--auto': auto }]"
    :value="shown"
    :placeholder="placeholder"
    :disabled="isTrue(disabled)"
    :maxlength="maxLen"
    :name="name || undefined"
    :enterkeyhint="confirmType && confirmType !== 'return' ? confirmType : undefined"
    rows="1"
    @input="onInput"
    @focus="onFocus"
    @blur="onBlur"
    @keydown.enter="onEnter"
    @compositionstart="composing = true"
    @compositionend="onCompositionEnd"
  />
</template>

<script>
import { beginCapture, endCapture } from '../runtime/instance.js'
import { isTrue } from '../runtime/util.js'

export default {
  name: 'MpTextarea',
  props: {
    value: { default: '' },
    placeholder: { default: '' },
    placeholderClass: { default: '' },
    placeholderStyle: { default: '' },
    disabled: { default: false },
    maxlength: { default: 140 },
    focus: { default: false },
    autoFocus: { default: false },
    autoHeight: { default: false },
    confirmType: { default: 'return' },
    name: { default: '' },
    mpOn: { default: null },
  },
  data() {
    return { composing: false }
  },
  computed: {
    shown() {
      return this.value == null ? '' : String(this.value)
    },
    auto() {
      return isTrue(this.autoHeight)
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
    shown() {
      this.$nextTick(this.resize)
    },
    focus(v) {
      if (isTrue(v)) this.$nextTick(() => this.$refs.el && this.$refs.el.focus())
    },
  },
  mounted() {
    this.resize()
    if (isTrue(this.focus) || isTrue(this.autoFocus)) this.$refs.el.focus()
  },
  methods: {
    isTrue,
    emit(type, detail, e) {
      const fn = this.mpOn && this.mpOn[type]
      return typeof fn === 'function' ? fn(detail, e) : undefined
    },
    resize() {
      const el = this.$refs.el
      if (!el || !this.auto) return
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    },
    onInput(e) {
      this.resize()
      if (this.composing) return
      this.dispatchInput(e)
    },
    onCompositionEnd(e) {
      this.composing = false
      this.dispatchInput(e)
    },
    dispatchInput(e) {
      const el = e.target
      let ret
      let written
      beginCapture()
      try {
        ret = this.emit('input', { value: el.value, cursor: el.selectionStart, keyCode: undefined }, e)
      } finally {
        written = endCapture()
      }
      if (typeof ret === 'string' || typeof ret === 'number') {
        el.value = String(ret)
        this.resize()
        return
      }
      this.$nextTick(() => {
        const want = this.shown
        if (el.value !== want && written.has(want)) {
          el.value = want
          this.resize()
        }
      })
    },
    onEnter(e) {
      if (this.confirmType && this.confirmType !== 'return' && !e.isComposing) {
        e.preventDefault()
        this.emit('confirm', { value: e.target.value }, e)
      }
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
