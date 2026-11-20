<template>
  <div class="sl">
    <div class="sl-rule"><b>只有屏幕能这样切。</b>屏幕是显示面板，录一段会变化的画面，切出来每张都不一样，各号就不会雷同。机身、外壳、边框还是要正常拍实拍，不能靠切片。视频必须是<b>这件货自己的屏幕</b>，不能拿网上的视频。</div>

    <div class="sl-pick">
      <label class="btn pri"><input type="file" accept="video/*" capture="environment" hidden @change="onFile" />手机录一段</label>
      <label class="btn"><input type="file" accept="video/*" hidden @change="onFile" />选已有视频</label>
      <label class="sl-n">切成 <input v-model.number="n" type="number" min="10" max="200" /> 张</label>
      <span class="muted">手机上点「手机录一段」直接打开摄像头；电脑上选文件。录 10 秒左右，屏幕上放会变化的画面，手机拿稳。</span>
    </div>

    <div v-if="busy" class="sl-prog"><div class="sl-bar"><i :style="{ width: pct + '%' }"></i></div><span>{{ phase }}　{{ done }} / {{ n }}</span></div>
    <p v-if="err" class="errbox">{{ err }}</p>

    <template v-if="frames.length && !busy">
      <div class="sl-sum">
        <span class="tag grn">清楚可用 {{ cnt.ok }}</span><span class="tag red" v-if="cnt.blur">模糊 {{ cnt.blur }}</span><span class="tag amb" v-if="cnt.dark">太暗 {{ cnt.dark }}</span><span class="tag amb" v-if="cnt.glare">过曝 / 反光 {{ cnt.glare }}</span><span class="tag" v-if="cnt.dup">和上一张几乎一样 {{ cnt.dup }}</span>
        <span class="muted">视频 {{ meta.dur.toFixed(1) }} 秒 · {{ meta.w }}×{{ meta.h }}</span>
      </div>
      <p v-if="verdict" class="sl-warn" :class="verdict.cls">{{ verdict.text }}</p>
      <div class="sl-act"><button class="btn sm" @click="pickOk">只留清楚的</button><button class="btn sm" @click="setAll(true)">全选</button><button class="btn sm" @click="setAll(false)">全不选</button><span class="muted">已选 {{ chosen }} 张。点图放大看。</span></div>
      <div class="sl-grid">
        <figure v-for="f in frames" :key="f.i" class="sl-fr" :class="{ off: !f.on, bad: f.flags.length }">
          <img :src="f.url" alt="" loading="lazy" @click="big = f" />
          <label class="sl-ck"><input v-model="f.on" type="checkbox" /></label>
          <figcaption><span>{{ f.t.toFixed(1) }}s</span><b v-for="x in f.flags" :key="x" :class="x">{{ FL[x] }}</b></figcaption>
        </figure>
      </div>
      <div class="sl-up">
        <button class="btn pri" :disabled="REAL || !chosen || uploading" @click="upload">{{ uploading ? '上传中 ' + upDone + ' / ' + chosen : '把选中的 ' + chosen + ' 张存为这件货的实拍图' }}</button>
        <span v-if="REAL" class="muted">真实环境只读，不上传到生产：这里可以先切、先看效果。</span>
        <span v-else class="muted">演示：存进演示库，页面按「实拍图」算。</span>
      </div>
    </template>

    <div v-if="big" class="sl-mask" @click="big = null"><img :src="big.url" alt="" /><p>第 {{ big.i + 1 }} 张 · {{ big.t.toFixed(1) }} 秒　{{ big.flags.map((x) => FL[x]).join('、') || '没发现问题' }}</p></div>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { post, REAL } from './api.js'
import { toast } from './ui.js'

const props = defineProps({ item: Object })
const emit = defineEmits(['uploaded'])
const n = ref(100)
const busy = ref(false), phase = ref(''), done = ref(0), err = ref(''), uploading = ref(false), upDone = ref(0)
const frames = ref([]), meta = reactive({ dur: 0, w: 0, h: 0 }), big = ref(null)
const FL = { blur: '模糊', dark: '太暗', glare: '过曝', dup: '重复' }
const pct = computed(() => (n.value ? Math.round((done.value / n.value) * 100) : 0))
const chosen = computed(() => frames.value.filter((f) => f.on).length)
const cnt = computed(() => { const c = { ok: 0, blur: 0, dark: 0, glare: 0, dup: 0 }; for (const f of frames.value) { if (!f.flags.length) c.ok++; for (const x of f.flags) c[x]++ } return c })
const verdict = computed(() => {
  const t = frames.value.length; if (!t) return null
  if (cnt.value.dup / t > 0.6) return { cls: 'red', text: `有 ${cnt.value.dup} 张和上一张几乎一样：屏幕画面基本没变。录的时候屏幕上放会变化的画面（比如换纯色、放测试视频），不然切出来都一样，各号还是会雷同。` }
  if (cnt.value.ok < 12) return { cls: 'amb', text: `清楚可用的只有 ${cnt.value.ok} 张，给各号分图可能不够。建议重录：光线亮一点、手拿稳、关掉屏幕反光。` }
  return { cls: 'grn', text: `清楚可用 ${cnt.value.ok} 张，够各号分着用。` }
})

const seek = (v, t) => new Promise((res) => { const h = () => { v.removeEventListener('seeked', h); res() }; v.addEventListener('seeked', h); v.currentTime = t })
const toBlob = (c) => new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85))

// 清晰度（拉普拉斯方差）、亮度、64 位差值哈希：都在浏览器里算，不上传
function measure(ctx2, w, h) {
  const d = ctx2.getImageData(0, 0, w, h).data, g = new Float32Array(w * h)
  let sum = 0, bright = 0
  for (let i = 0; i < w * h; i++) { const y = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; g[i] = y; sum += y; if (y > 250) bright++ }
  let s1 = 0, s2 = 0, c = 0
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const k = y * w + x, l = 4 * g[k] - g[k - 1] - g[k + 1] - g[k - w] - g[k + w]; s1 += l; s2 += l * l; c++ }
  // 颜色签名：4×4 格，每格平均 R G B。纯色切换的屏幕（测试屏幕常这样）差值哈希分不出来，要靠颜色
  const sig = [], gx = 4, gy = 4
  for (let cy = 0; cy < gy; cy++) for (let cxx = 0; cxx < gx; cxx++) {
    let r = 0, gg = 0, b = 0, k = 0
    for (let y = Math.floor((cy * h) / gy); y < Math.floor(((cy + 1) * h) / gy); y++) for (let x = Math.floor((cxx * w) / gx); x < Math.floor(((cxx + 1) * w) / gx); x++) { const o = (y * w + x) * 4; r += d[o]; gg += d[o + 1]; b += d[o + 2]; k++ }
    sig.push(r / k, gg / k, b / k)
  }
  return { mean: sum / (w * h), glare: bright / (w * h), lap: s2 / c - (s1 / c) ** 2, sig }
}
function dhash(ctx9) {
  const d = ctx9.getImageData(0, 0, 9, 8).data, bits = []
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const a = d[(y * 9 + x) * 4], b = d[(y * 9 + x + 1) * 4]; bits.push(a > b ? 1 : 0) }
  return bits
}
const ham = (a, b) => a.reduce((s, x, i) => s + (x !== b[i] ? 1 : 0), 0)
const cdist = (a, b) => a.reduce((s, x, i) => s + Math.abs(x - b[i]), 0) / a.length   // 平均每个颜色值差多少（0–255）

async function onFile(e) {
  const file = e.target.files?.[0]; e.target.value = ''
  if (!file) return
  err.value = ''; frames.value = []; big.value = null
  const N = Math.max(10, Math.min(200, Math.round(n.value) || 100)); n.value = N
  busy.value = true; phase.value = '读视频'; done.value = 0
  const url = URL.createObjectURL(file)
  try {
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('这个视频打不开，换一个格式（手机直接录的一般都行）')) })
    if (!isFinite(v.duration)) { v.currentTime = 1e7; await new Promise((r) => v.addEventListener('timeupdate', r, { once: true })); await seek(v, 0) }
    const dur = v.duration
    if (!dur || dur < 1) throw new Error('视频太短（不到 1 秒），重录一段 10 秒左右的')
    if (dur > 120) throw new Error('视频太长（超过 2 分钟），录 10 秒左右就够')
    const W = v.videoWidth, H = v.videoHeight, sc = Math.min(1, 1280 / Math.max(W, H)), cw = Math.round(W * sc), ch = Math.round(H * sc)
    Object.assign(meta, { dur, w: W, h: H })
    const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch; const cx = cv.getContext('2d')
    const sm = document.createElement('canvas'); sm.width = 160; sm.height = Math.max(1, Math.round((160 * H) / W)); const sx = sm.getContext('2d', { willReadFrequently: true })
    const h9 = document.createElement('canvas'); h9.width = 9; h9.height = 8; const hx = h9.getContext('2d', { willReadFrequently: true })
    phase.value = '切片'
    const out = []
    for (let i = 0; i < N; i++) {
      const t = Math.min(dur - 0.05, ((i + 0.5) * dur) / N)
      await seek(v, t)
      cx.drawImage(v, 0, 0, cw, ch); sx.drawImage(v, 0, 0, sm.width, sm.height); hx.drawImage(v, 0, 0, 9, 8)
      const m = measure(sx, sm.width, sm.height), blob = await toBlob(cv)
      out.push({ i, t, blob, url: URL.createObjectURL(blob), m, hash: dhash(hx), flags: [], on: true })
      done.value = i + 1
      if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0))   // 让进度条动起来
    }
    // 打标：模糊（比这段视频的中位数明显糊）、太暗、过曝 / 反光、和上一张留下来的几乎一样
    const laps = out.map((f) => f.m.lap).sort((a, b) => a - b), med = laps[Math.floor(laps.length / 2)]
    let last = null, lastSig = null
    for (const f of out) {
      if (f.m.mean >= 35 && f.m.mean <= 235 && f.m.lap < med * 0.45) f.flags.push('blur')   // 太暗 / 过曝的另算，不重复标糊
      if (f.m.mean < 35) f.flags.push('dark')
      if (f.m.mean > 235 || f.m.glare > 0.3) f.flags.push('glare')
      if (last && ham(f.hash, last) <= 4 && cdist(f.m.sig, lastSig) < 10) f.flags.push('dup')   // 轮廓和颜色都和上一张「不重复的」几乎一样
      else { last = f.hash; lastSig = f.m.sig }
      f.on = !f.flags.length
    }
    frames.value = out
  } catch (x) { err.value = x.message || String(x) } finally { busy.value = false; URL.revokeObjectURL(url) }
}
const setAll = (on) => frames.value.forEach((f) => { f.on = on })
const pickOk = () => frames.value.forEach((f) => { f.on = !f.flags.length })
const asDataUrl = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob) })
async function upload() {
  err.value = ''; uploading.value = true; upDone.value = 0
  const pick = frames.value.filter((f) => f.on)
  try {
    for (let s = 0; s < pick.length; s += 10) {
      const part = pick.slice(s, s + 10)
      await post('/demo/slices', { sku_code: props.item.code, start: s, frames: await Promise.all(part.map((f) => asDataUrl(f.blob))) })
      upDone.value = s + part.length
    }
    toast(`已存 ${pick.length} 张实拍图`); emit('uploaded'); frames.value = []
  } catch (x) { err.value = x.message } finally { uploading.value = false }
}
</script>

<style scoped>
.sl { display: grid; gap: 12px; } .sl-rule { padding: 10px 14px; border-radius: 12px; background: var(--amb-soft); color: var(--amb-ink); font-size: 13.5px; line-height: 1.7; }
.sl-pick { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; } .sl-n { display: inline-flex; gap: 6px; align-items: center; font-size: 14px; font-weight: 600; } .sl-n input { width: 72px; height: 38px; border: 1px solid var(--line); border-radius: 10px; padding: 0 8px; background: var(--soft); color: var(--ink); font: inherit; text-align: center; }
.sl-prog { display: flex; align-items: center; gap: 12px; font-size: 14px; } .sl-bar { flex: 1; height: 10px; background: var(--soft); border-radius: 999px; overflow: hidden; } .sl-bar i { display: block; height: 100%; background: var(--acc); transition: width .1s; }
.sl-sum { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; } .sl-warn { margin: 0; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.6; } .sl-warn.red { background: var(--red-soft); color: var(--red-ink); } .sl-warn.amb { background: var(--amb-soft); color: var(--amb-ink); } .sl-warn.grn { background: var(--grn-soft); color: var(--grn-ink); }
.sl-act { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.sl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); grid-auto-rows: max-content; align-content: start; gap: 10px; max-height: 560px; overflow-y: auto; padding: 2px; }
.sl-fr { margin: 0; position: relative; border-radius: 12px; overflow: hidden; border: 2px solid transparent; background: var(--soft); } .sl-fr.off { opacity: .45; } .sl-fr.bad { border-color: var(--amb); } .sl-fr img { width: 100%; height: auto; aspect-ratio: 16 / 10; object-fit: cover; display: block; cursor: zoom-in; min-height: 70px; }
.sl-ck { position: absolute; left: 6px; top: 6px; background: rgba(0, 0, 0, .55); border-radius: 8px; padding: 3px 5px; display: flex; } .sl-ck input { width: 17px; height: 17px; }
.sl-fr figcaption { display: flex; gap: 4px; flex-wrap: wrap; padding: 5px 8px; font-size: 12px; color: var(--mute); } .sl-fr figcaption b { font-weight: 700; padding: 0 6px; border-radius: 999px; background: var(--amb-soft); color: var(--amb-ink); } .sl-fr figcaption b.blur { background: var(--red-soft); color: var(--red-ink); }
.sl-up { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; } .errbox { margin: 0; }
.sl-mask { position: fixed; inset: 0; z-index: 80; background: rgba(0, 0, 0, .82); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; cursor: zoom-out; } .sl-mask img { max-width: 92vw; max-height: 82vh; border-radius: 12px; } .sl-mask p { color: #fff; margin: 0; }
</style>
