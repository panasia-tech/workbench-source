// 搜索结果页选择器集中之后，值必须和搬之前一模一样（纯离线）。
//
// 这次改动是**纯搬运**：把散在 goofish.js 各处的 `[class*="…"]` 字面量提到
// selectors.js。搬运最怕的就是搬错一个字——而搬错的症状不是报错，是「采集
// 突然抓不到卡片」或者「价格全变成 0」，要等跑一轮才看得出来。
//
// 所以这里把每个选择器的**字面值**钉死。它们是 2026-06 对着真实闲鱼页面量出来的，
// 改它们要有新的实测依据，不能顺手改。
//
// 跑法：node scripts/test/selectors-regression.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as S from '../../src/main/selectors.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (p) => readFileSync(join(root, p), 'utf8')

// --- 1. 值和搬之前逐条相同 ----------------------------------------------------
assert.equal(S.SEARCH_CONTAINER, '[class*="search-container"]')
assert.equal(S.CARD, '[class*="feeds-item-wrap"]')
assert.equal(S.RESULT_CARD, '[class*="search-container"] [class*="feeds-item-wrap"]')
assert.equal(S.CARD_IMAGE, 'img[class*="feeds-image"]')
assert.equal(S.PRICE_WRAP, '[class*="price-wrap"]')
assert.equal(S.PRICE_INT, '[class*="number"]')
assert.equal(S.PRICE_DEC, '[class*="decimal"]')
assert.equal(
  S.NORMAL_CONTENT,
  'a[href*="/item"], [data-item-id], [data-itemid], [class*="feeds-item"], [class*="search-container"]'
)

// --- 2. 卡片必须连着容器一起选 ------------------------------------------------
// 少了前半截 search-container，「猜你喜欢」的卡片会被一起收进来，
// 于是抓到一批和搜索词无关的脏价——2026-06 踩过，所以容器是判据的一部分。
assert.ok(
  S.RESULT_CARD.startsWith(S.SEARCH_CONTAINER),
  '结果卡片必须限定在 search-container 内，否则会抓到「猜你喜欢」'
)

// --- 3. 一律用属性包含，不许写死完整 class 名 --------------------------------
// 闲鱼是 css-modules 打包，class 带 `--` 哈希后缀，每次发版都变。
for (const [name, value] of Object.entries(S)) {
  if (typeof value !== 'string') continue
  assert.ok(
    !/class="[^"*]/.test(value),
    `${name} 写死了完整 class 名，闲鱼一发版就失效——要用 [class*="前缀"]`
  )
}

// --- 4. goofish.js 里不许再留散落的字面量 ------------------------------------
const goofish = read('src/main/goofish.js')
for (const literal of ['feeds-item-wrap"]', 'price-wrap"]', 'feeds-image"]']) {
  const hits = goofish.split(literal).length - 1
  assert.equal(hits, 0, `goofish.js 里还剩 ${hits} 处「${literal}」字面量，没搬干净`)
}
assert.match(goofish, /selectorsLiteral\(\)/, '页面脚本要注入选择器表')

// 每段跑在页面上下文里的脚本都得拿到 S，少注一段就是运行时 ReferenceError
const scripts = goofish.split('`(').length - 1
const injected = goofish.split('const S = ${selectorsLiteral()}').length - 1
assert.ok(injected >= 5, `只有 ${injected} 段脚本注入了选择器表，共有 ${scripts} 段模板脚本`)

// --- 5. 群控那边是另一套页面，不该被并进来 -----------------------------------
// 群控网页版读的是发布表单/个人宝贝列表/消息页，这边读搜索结果页，
// 真正重叠的只有价格组件。合成一张表会得到九成条目只有一个使用方的文件。
for (const name of ['CONVERSATION_ITEM', 'EDITOR', 'SELLER_BUTTON', 'CARD_WARP']) {
  assert.ok(!(name in S), `${name} 是群控那边的页面，不该出现在搜索页选择器里`)
}

console.log('selectors regression: passed（8 个选择器值锁定 + 容器限定 + 无散落字面量 + 5 段脚本都注入）')
