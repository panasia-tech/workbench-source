<template>
  <wx-picker-view-column>
    <div ref="scroll" class="wx-pvc__scroll"><slot /></div>
  </wx-picker-view-column>
</template>

<script>
import { createWheel } from './wheel.js'

export default {
  name: 'MpPickerViewColumn',
  inject: { pv: { from: 'mpPickerView', default: null } },
  data() {
    return { index: 0 }
  },
  computed: {
    want() {
      return this.pv ? this.pv.valueAt(this.pv.indexOf(this)) : 0
    },
  },
  watch: {
    want(v) {
      if (this.wheel && this.wheel.current() !== v) this.wheel.scrollTo(v)
    },
    'pv.itemH'() {
      this.$nextTick(() => this.wheel && this.wheel.scrollTo(this.want))
    },
    'pv.height'() {
      this.$nextTick(() => this.wheel && this.wheel.scrollTo(this.want))
    },
  },
  mounted() {
    if (this.pv) this.pv.register(this)
    this.wheel = createWheel(this.$refs.scroll, {
      itemHeight: () => (this.pv ? this.pv.itemH : 34),
      onSettle: (i) => {
        const max = Math.max(0, this.$refs.scroll.children.length - 1)
        this.index = Math.min(i, max)
        if (this.pv) this.pv.columnChanged()
      },
    })
    this.$nextTick(() => this.wheel.scrollTo(this.want))
  },
  beforeUnmount() {
    if (this.wheel) this.wheel.destroy()
    if (this.pv) this.pv.unregister(this)
  },
  methods: {
    current() {
      const max = Math.max(0, this.$refs.scroll ? this.$refs.scroll.children.length - 1 : 0)
      return Math.min(this.wheel ? this.wheel.current() : this.index, max)
    },
  },
}
</script>
