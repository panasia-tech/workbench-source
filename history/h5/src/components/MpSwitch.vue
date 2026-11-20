<template>
  <wx-switch
    role="switch"
    :tabindex="dis ? -1 : 0"
    :aria-checked="on ? 'true' : 'false'"
    :class="{ 'wx-switch--on': on, 'wx-switch--disabled': dis, 'wx-switch--checkbox': type === 'checkbox' }"
    @click="toggle"
    @keydown.space.prevent="toggle"
  ><span class="wx-switch__track" :style="on ? { background: color, borderColor: color } : null"><span class="wx-switch__knob" /></span></wx-switch>
</template>

<script>
import { isTrue } from '../runtime/util.js'

// <switch>：点一下先自己翻过去再派发 change（小程序就是这样，页面不 setData 也会翻）
export default {
  name: 'MpSwitch',
  props: {
    checked: { default: false },
    disabled: { default: false },
    type: { default: 'switch' },
    color: { default: '#04BE02' },
    mpOn: { default: null },
  },
  data() {
    return { on: isTrue(this.checked) }
  },
  computed: {
    dis() {
      return isTrue(this.disabled)
    },
  },
  watch: {
    checked(v) {
      this.on = isTrue(v)
    },
  },
  methods: {
    toggle(e) {
      if (this.dis) return
      this.on = !this.on
      const fn = this.mpOn && this.mpOn.change
      if (typeof fn === 'function') fn({ value: this.on }, e)
    },
  },
}
</script>
