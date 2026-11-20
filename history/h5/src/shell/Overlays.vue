<template>
  <!-- toast / loading -->
  <div v-if="toast.visible && toast.mask" class="mp-toast-mask" />
  <Transition name="mp-fade">
    <div v-if="toast.visible" :key="toast.seq" class="mp-toast" :class="toast.icon === 'none' && !toast.image ? 'mp-toast--text' : 'mp-toast--icon'" role="status" aria-live="polite">
      <template v-if="toast.icon !== 'none' || toast.image">
        <img v-if="toast.image" class="mp-toast__img" :src="toast.image" alt="">
        <span v-else-if="toast.loading" class="mp-spinner mp-spinner--light mp-toast__spin" />
        <svg v-else-if="toast.icon === 'error'" class="mp-toast__svg" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-width="3" /><path d="M16 16l16 16M32 16L16 32" stroke="currentColor" stroke-width="3" stroke-linecap="round" /></svg>
        <svg v-else class="mp-toast__svg" viewBox="0 0 48 48" aria-hidden="true"><path d="M11 25l9 9 17-19" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
        <span v-if="toast.title" class="mp-toast__title">{{ toast.title }}</span>
      </template>
      <span v-else class="mp-toast__text">{{ toast.title }}</span>
    </div>
  </Transition>

  <!-- modal -->
  <Transition name="mp-fade">
    <div v-if="modal.visible && modal.current" class="mp-mask mp-mask--center" @touchmove="guardTouch">
      <div class="mp-modal" role="dialog" aria-modal="true">
        <div v-if="m.title" class="mp-modal__title">{{ m.title }}</div>
        <div v-if="!m.editable && m.content" class="mp-modal__content" :class="{ 'mp-modal__content--solo': !m.title }">{{ m.content }}</div>
        <div v-if="m.editable" class="mp-modal__edit">
          <input v-model="modal.inputValue" class="mp-modal__input" :placeholder="m.placeholderText" @keydown.enter="answer(true)">
        </div>
        <div class="mp-modal__btns">
          <button v-if="m.showCancel" type="button" class="mp-modal__btn" :style="{ color: m.cancelColor }" @click="answer(false)">{{ m.cancelText }}</button>
          <button type="button" class="mp-modal__btn mp-modal__btn--ok" :style="{ color: m.confirmColor }" @click="answer(true)">{{ m.confirmText }}</button>
        </div>
      </div>
    </div>
  </Transition>

  <!-- action sheet -->
  <Transition name="mp-sheet">
    <div v-if="actionSheet.visible && actionSheet.current" class="mp-mask mp-mask--bottom" @click.self="sheet(-1)" @touchmove="guardTouch">
      <div class="mp-sheet" role="menu">
        <div v-if="a.alertText" class="mp-sheet__alert">{{ a.alertText }}</div>
        <button v-for="(item, i) in a.itemList" :key="i" type="button" role="menuitem" class="mp-sheet__item" :style="{ color: a.itemColor }" @click="sheet(i)">{{ item }}</button>
        <div class="mp-sheet__gap" />
        <button type="button" class="mp-sheet__item mp-sheet__cancel" @click="sheet(-1)">取消</button>
      </div>
    </div>
  </Transition>

  <!-- 电脑上的单列选择器：贴在框下面的下拉列表，选项多时带搜索 -->
  <div v-if="pickerSheet.visible && dropdown" class="dk-pop-mask" @click.self="pickClose(null)">
    <div class="dk-pop" :style="popStyle" role="listbox" :aria-label="pickerSheet.title || '选择'">
      <input v-if="options.length > 12" ref="popSearch" v-model="popQuery" class="dk-input dk-pop__search" placeholder="搜索" @keydown.enter="pickFirst">
      <div class="dk-pop__list">
        <button
          v-for="o in shownOptions"
          :key="o.i"
          type="button"
          role="option"
          class="dk-pop__item"
          :class="{ 'dk-pop__item--on': o.i === pickerSheet.value[0] }"
          :aria-selected="o.i === pickerSheet.value[0]"
          @click="pickClose([o.i])"
        >{{ o.label }}</button>
        <div v-if="!shownOptions.length" class="dk-pop__empty">没有匹配的选项</div>
      </div>
    </div>
  </div>

  <!-- 滚轮选择器 -->
  <Transition name="mp-sheet">
    <div v-if="pickerSheet.visible && !dropdown" class="mp-mask mp-mask--bottom" @click.self="pickClose(null)" @touchmove="guardTouch">
      <div class="mp-picker-sheet">
        <div class="mp-picker-sheet__head">
          <button type="button" class="mp-picker-sheet__btn" @click="pickClose(null)">取消</button>
          <span class="mp-picker-sheet__title">{{ pickerSheet.title }}</span>
          <button type="button" class="mp-picker-sheet__btn mp-picker-sheet__btn--ok" @click="pickClose([...pickerSheet.value])">确定</button>
        </div>
        <div class="mp-picker-sheet__cols">
          <WheelColumn v-for="(col, ci) in pickerSheet.columns" :key="ci" v-model="pickerSheet.value[ci]" class="mp-picker-sheet__col" :items="col" :item-height="44" />
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  actionSheet, answerActionSheet, answerModal, closePickerSheet, modal, pickerSheet, toast,
} from '../runtime/ui.js'
import WheelColumn from '../components/WheelColumn.vue'
import { insideScrollable } from '../runtime/instance.js'
import { closeTopLayer } from '../runtime/router.js'
import { isDesktop } from '../runtime/viewport.js'

const m = computed(() => (modal.current ? modal.current.o : {}))
const a = computed(() => (actionSheet.current ? actionSheet.current.o : {}))

// 点击里同步回调：回调里接着 chooseMedia 才拿得到用户手势
const answer = (ok) => answerModal(ok)
const sheet = (i) => answerActionSheet(i)
const pickClose = (v) => closePickerSheet(v)

// 电脑上单列选择器换成下拉列表（多列的、月份的还是滚轮）
const dropdown = computed(() => isDesktop.value && pickerSheet.columns.length === 1)
const options = computed(() => (pickerSheet.columns[0] || []).map((label, i) => ({ i, label: String(label) })))
const popQuery = ref('')
const popSearch = ref(null)
const shownOptions = computed(() => {
  const q = popQuery.value.trim().toLowerCase()
  return q ? options.value.filter((o) => o.label.toLowerCase().includes(q)) : options.value
})
const popStyle = computed(() => {
  const r = pickerSheet.anchor
  if (!r) return { left: '50%', top: '20%', transform: 'translateX(-50%)', minWidth: '280px' }
  const vh = window.innerHeight
  const style = { left: `${Math.max(8, Math.min(r.left, window.innerWidth - 248))}px`, minWidth: `${Math.max(r.width, 240)}px` }
  // 下面放不下就往上开
  if (vh - r.bottom < 300 && r.top > vh - r.bottom) style.bottom = `${vh - r.top + 4}px`
  else style.top = `${r.bottom + 4}px`
  return style
})
const pickFirst = () => {
  if (shownOptions.value.length) pickClose([shownOptions.value[0].i])
}
watch(() => pickerSheet.visible && dropdown.value, (open) => {
  popQuery.value = ''
  if (open) {
    nextTick(() => {
      if (popSearch.value) popSearch.value.focus()
      const on = document.querySelector('.dk-pop__item--on')
      if (on) on.scrollIntoView({ block: 'nearest' })
    })
  }
})

// 电脑上按 Esc = 手机的返回键：关最上面一层弹层（模态框、菜单、选择器、图片预览、扫码）。
// 没有弹层时不做任何事——不拿 Esc 退页面，免得填到一半的表单丢了
function onKey(e) {
  if (e.key !== 'Escape' || e.isComposing) return
  if (closeTopLayer()) e.preventDefault()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

// 遮罩挡住底下页面滚动；弹层里本身能滚的内容照常滚
function guardTouch(e) {
  if (e.cancelable && !insideScrollable(e.target, e.currentTarget)) e.preventDefault()
}
</script>
