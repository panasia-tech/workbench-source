// 滚轮列：scroll-snap 吸附 + 停稳后算出选中项。底部选择器和 <picker-view> 共用。

export function createWheel(el, { itemHeight, onSettle }) {
  let timer = null
  let lastIndex = -1
  let programmatic = false

  const indexNow = () => Math.max(0, Math.round(el.scrollTop / itemHeight()))

  const settle = () => {
    clearTimeout(timer)
    if (programmatic) {
      programmatic = false
      return
    }
    const i = indexNow()
    if (i !== lastIndex) {
      lastIndex = i
      onSettle(i)
    }
  }

  const onScroll = () => {
    clearTimeout(timer)
    timer = setTimeout(settle, 120)
  }

  el.addEventListener('scroll', onScroll, { passive: true })
  if ('onscrollend' in el) el.addEventListener('scrollend', settle)

  return {
    scrollTo(index, smooth = false) {
      const top = Math.max(0, index) * itemHeight()
      lastIndex = index
      if (Math.abs(el.scrollTop - top) < 1) return
      programmatic = true
      el.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
      if (!smooth) setTimeout(() => { programmatic = false }, 50)
    },
    current: indexNow,
    destroy() {
      clearTimeout(timer)
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('scrollend', settle)
    },
  }
}
