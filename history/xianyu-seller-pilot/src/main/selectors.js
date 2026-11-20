// 闲鱼网页版**搜索结果页**的选择器。改版只改这一个文件。
//
// # 为什么用 [class*="前缀"] 而不是完整 class 名
//
// 闲鱼前端是 css-modules 打包，class 名带 `--` 哈希后缀（`feeds-item-wrap--a1b2c3`），
// 每次发版哈希都变。写死全名等于每次发版都失效，所以一律用属性包含选择器。
// 这条约定执行端那份 selectors.py 里也写着，是同一个道理。
//
// # 为什么不和群控那份合成一张表
//
// 2026-09-16 核对：群控网页版流程读的是**发布表单 / 个人宝贝列表 / 消息页**，
// 这边读的是**搜索结果页**，真正重叠的只有价格那一个组件（已放进共用表）。
// 强行并成一份，会得到一个九成条目只有一个使用方的文件——那不是收敛漂移，
// 是加一层间接。各收各的，共享的那点单独共享。
//
// # 页面结构（2026-06 实测，闲鱼网页版）
//
//   真实结果   div[class*=search-container] a[class*=feeds-item-wrap]
//              「猜你喜欢」在这个容器之外，所以这样选天然排除它
//   价格       卡片内 div[class*=price-wrap] > span[class*=number] + span[class*=decimal]
//              ⚠️ 必须读子 span：容器 innerText 会把「X人想要」的热度数字粘在价格后面
//   无在售     body 出现「没有找到你想要的宝贝 / 减少筛选内容」→ 不取价、不上报
//              （否则会抓到「猜你喜欢」的脏价）

/** 搜索结果容器（「猜你喜欢」在它之外）。 */
export const SEARCH_CONTAINER = '[class*="search-container"]'

/** 一张商品卡片。 */
export const CARD = '[class*="feeds-item-wrap"]'

/** 搜索结果里的卡片：容器 + 卡片，两段都要，少了前半截会把猜你喜欢一起收进来。 */
export const RESULT_CARD = `${SEARCH_CONTAINER} ${CARD}`

/** 卡片主图。取不到时各调用点自行回退到 img。 */
export const CARD_IMAGE = 'img[class*="feeds-image"]'

/** 价格区与它的整数/小数两段。 */
export const PRICE_WRAP = '[class*="price-wrap"]'
export const PRICE_INT = '[class*="number"]'
export const PRICE_DEC = '[class*="decimal"]'

/** 「这页有正常商品内容」的判据——风控检测用它排除误判。 */
export const NORMAL_CONTENT =
  'a[href*="/item"], [data-item-id], [data-itemid], [class*="feeds-item"], [class*="search-container"]'

/**
 * 注进页面脚本用的字面量。
 *
 * 采集逻辑跑在页面上下文里（executeJavaScript），拿不到本模块的作用域，
 * 只能把这张表序列化成字面量随脚本一起送进去。
 */
export function selectorsLiteral() {
  return JSON.stringify({
    SEARCH_CONTAINER,
    CARD,
    RESULT_CARD,
    CARD_IMAGE,
    PRICE_WRAP,
    PRICE_INT,
    PRICE_DEC,
    NORMAL_CONTENT,
  })
}
