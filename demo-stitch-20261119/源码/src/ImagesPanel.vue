<template>
  <div class="imgp">
    <div class="tabs" role="tablist">
      <button v-for="t in tabs" :key="t.k" role="tab" :class="{ on: tab === t.k, bad: t.bad }" @click="tab = t.k">{{ t.t }}<b>{{ t.n }}</b></button>
    </div>
    <p class="why">{{ WHY[tab] }}</p>

    <template v-if="tab === 'loc'">
      <div v-if="kinds.loc.length" class="grid"><button v-for="u in kinds.loc" :key="u" @click="zoom = u"><img :src="u" alt="库位图" loading="lazy" /></button></div>
      <p v-else class="none">没有库位图。不会拿别的图顶替；让仓管到库位上补拍一张。</p>
    </template>

    <template v-else-if="tab === 'real'">
      <div v-if="kinds.real.length || kinds.defect.length" class="grid">
        <button v-for="u in kinds.real" :key="u" @click="zoom = u"><img :src="u" alt="实拍图" loading="lazy" /><em>实拍</em></button>
        <button v-for="u in kinds.defect" :key="u" @click="zoom = u"><img :src="u" alt="瑕疵图" loading="lazy" /><em class="def">瑕疵</em></button>
      </div>
      <p v-if="!kinds.real.length" class="none">没有这件货自己的实拍图。{{ kinds.material.length ? '下面有 ' + kinds.material.length + ' 张商品图素材，但那不是这件货的照片，不能当实拍。' : '' }}让仓管 / 验货补拍。</p>
    </template>

    <template v-else-if="tab === 'listing'">
      <div v-if="dups.length" class="dup"><b>图片雷同，平台会判铺货：</b>
        <p v-for="(x, i) in dups" :key="i">「{{ x.a }}」和「{{ x.b }}」有 {{ x.n }} 张同样的图，要换掉其中一个号的。</p></div>
      <div v-for="s in shownShops" :key="s.id" class="shop" :class="{ none: !s.images.length, hot: !s.images.length && s.listed }">
        <div class="sh"><b>{{ s.label }}</b><span class="tag" :class="s.lvl">{{ s.state }}</span><span v-if="s.listed" class="tag dark">在架</span><span class="muted">{{ s.images.length ? s.images.length + ' 张' : '' }}</span></div>
        <div v-if="s.images.length" class="row"><button v-for="u in s.images" :key="u" @click="zoom = u"><img :src="u" alt="上架图" loading="lazy" /></button></div>
        <p v-else class="none sm">{{ s.listed ? '这个号已经在架，尚未绑定独立上架图：请在上方三栏图库选几张直接同步。' : '还没有选定这个号的上架图。' }}</p>
      </div>
      <div v-if="foldedNone.length" class="none">还有 {{ foldedNone.length }} 个号没有自己的上架图：<span v-for="s in foldedNone" :key="s.id" class="nm">{{ s.label }}</span></div>
      <p v-if="!shops.length" class="none">还没有读到各个号的上架情况。</p>
    </template>

    <template v-else>
      <p class="muted">{{ crawled.length ? '爬虫按型号搜到 ' + crawled.length + ' 张同款图。' : '没有搜到同款参考图。' }}{{ rejected ? '被淘汰 ' + rejected + ' 张。' : '' }}</p>
      <div v-if="crawled.length" class="grid"><button v-for="u in crawled" :key="u" @click="zoom = u"><img :src="u" alt="同款参考图" loading="lazy" /><em class="ref">参考</em></button></div>
    </template>

    <div v-if="zoom" class="zoom" @click="zoom = ''"><img :src="zoom" alt="" /></div>
  </div>
</template>
<script setup>
import { computed, ref, watch } from 'vue'
const props = defineProps({ kinds: Object, shops: Array, dups: Array, crawled: { type: Array, default: () => [] }, rejected: { type: Number, default: 0 }, max: { type: Number, default: 9 }, start: { type: String, default: 'listing' } })
const tab = ref(props.start)
const zoom = ref('')
watch(() => props.start, (v) => { tab.value = v })
// 号很多（真数据 22 个）时，没有图的号合并成一块，不一个号一大行
const many = computed(() => props.shops.length > 6)
const shownShops = computed(() => (many.value ? props.shops.filter((s) => s.images.length || s.listed) : props.shops))
const foldedNone = computed(() => (many.value ? props.shops.filter((s) => !s.images.length && !s.listed) : []))
const done = computed(() => props.shops.filter((s) => s.images.length).length)
const tabs = computed(() => [
  { k: 'listing', t: '上架图（各号）', n: `${done.value}/${props.shops.length}`, bad: props.dups.length > 0 || props.shops.some((s) => s.listed && !s.images.length) },
  { k: 'real', t: '实拍图', n: props.kinds.real.length + (props.kinds.defect.length ? `+${props.kinds.defect.length}` : ''), bad: !props.kinds.real.length },
  { k: 'loc', t: '库位图', n: props.kinds.loc.length, bad: !props.kinds.loc.length },
  { k: 'ref', t: '同款参考图', n: props.crawled.length, bad: false }
])
const WHY = computed(() => ({
  listing: `每个闲鱼号各用一组自己的图（每号最多 ${props.max} 张），号和号之间不能雷同：我们有几百个号，图片一样或太像，平台和买家就会判我们铺货。图从这件货的实拍图和商品图素材里挑。`,
  real: '这件货自己的照片，验货时拍的，每件货都不一样（划痕、成色、货号贴纸）。是做上架图的原料，不能拿别的货、同款图或库位图顶替。',
  loc: '仓管找货、盘点用，和商品图分开，只在仓库里用，不会拿来上架。',
  ref: '爬虫按品牌型号搜来的同款图，只当参考，不是这件货本身；要用也得先由人审核（图片服务的「图片合格 / 标记需处理」）。'
}))
</script>
<style scoped>
.tabs { display: flex; gap: 8px; flex-wrap: wrap; } .tabs button { height: 38px; padding: 0 16px; border-radius: 999px; background: var(--soft); color: var(--ink2); font-weight: 700; font-size: 14px; display: inline-flex; align-items: center; gap: 8px; }
.tabs button b { font-size: 13px; padding: 1px 8px; border-radius: 999px; background: var(--panel); } .tabs button.on { background: var(--ink); color: var(--bg); } .tabs button.on b { background: rgba(255, 255, 255, .22); color: inherit; }
.tabs button.bad b { background: var(--red); color: #fff; }
.why { margin: 12px 0; color: var(--mute); font-size: 14px; line-height: 1.6; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; } .grid button { position: relative; aspect-ratio: 1; border-radius: 14px; overflow: hidden; background: var(--soft); padding: 0; }
.grid img, .row img { width: 100%; height: 100%; object-fit: cover; display: block; } .grid em { position: absolute; left: 8px; bottom: 8px; font-style: normal; font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 8px; background: rgba(0, 0, 0, .55); color: #fff; } .grid em.def { background: var(--red); } .grid em.ref { background: var(--amb-ink); }
.none { padding: 18px; border: 2px dashed var(--line); border-radius: 14px; color: var(--ink2); font-size: 14.5px; } .nm { display: inline-block; margin: 4px 6px 0 0; padding: 2px 9px; border-radius: 999px; background: var(--soft); font-size: 12.5px; color: var(--ink2); }
.none.sm { padding: 10px 12px; margin: 8px 0 0; font-size: 13.5px; }
.dup { background: var(--red-soft); color: var(--red-ink); padding: 12px 16px; border-radius: 14px; margin-bottom: 12px; } .dup p { margin: 4px 0 0; font-size: 14px; }
.shop { border: 2px solid var(--line); border-radius: 16px; padding: 12px 14px; margin-bottom: 10px; } .shop.hot { border-color: var(--red); } .shop.none { border-style: solid; }
.sh { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; } .sh b { margin-right: auto; font-size: 15px; }
.row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; } .row button { width: 84px; height: 84px; border-radius: 12px; overflow: hidden; padding: 0; background: var(--soft); }
.zoom { position: fixed; inset: 0; z-index: 90; background: rgba(6, 10, 20, .8); display: flex; align-items: center; justify-content: center; cursor: zoom-out; } .zoom img { max-width: 92vw; max-height: 90vh; border-radius: 16px; }
</style>
