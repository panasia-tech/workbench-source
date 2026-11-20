<template>
  <wx-button
    v-mp-hover="{ cls: hoverCls, start: hoverStartTime, stay: hoverStayTime }"
    role="button"
    :tabindex="dis ? -1 : 0"
    :type="type || undefined"
    :size="size || undefined"
    :plain="isTrue(plain) ? '' : undefined"
    :disabled="dis ? '' : undefined"
    :loading="busy ? '' : undefined"
    :aria-disabled="dis ? 'true' : undefined"
    @keydown.enter="$el.click()"
  ><i v-if="busy" class="wx-button__loading" /><slot /></wx-button>
</template>

<script>
import { isTrue } from '../runtime/util.js'

// <button>：样式全靠 base.css 里的 wx-button 默认值 + 页面 class；disabled 时点不动（pointer-events: none）
export default {
  name: 'MpButton',
  props: {
    size: { default: '' },
    type: { default: '' },
    plain: { default: false },
    disabled: { default: false },
    loading: { default: false },
    formType: { default: '' },
    openType: { default: '' },
    hoverClass: { default: 'button-hover' },
    hoverStartTime: { default: 20 },
    hoverStayTime: { default: 70 },
    mpOn: { default: null },
  },
  computed: {
    dis() {
      return isTrue(this.disabled)
    },
    busy() {
      return isTrue(this.loading)
    },
    hoverCls() {
      return this.dis ? 'none' : this.hoverClass
    },
  },
  methods: { isTrue },
}
</script>
