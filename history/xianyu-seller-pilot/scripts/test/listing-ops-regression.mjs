// 上下架页与合并后的运维页（纯离线，只读源码与菜单表）。
//
// 钉三件容易做错的事：
//
//   1. 上下架打的是 ERP 既有接口，不另起一条写入口 —— 上架状态的真源是
//      SkuShopListing，多一条写路径就多一处会对不上的地方；
//   2. 手机那一档的判据是「不是 browser」而不是「等于 android」 —— 没绑设备的
//      店铺默认按真机算，漏判成浏览器会把货发到一条还没验过的链路上；
//   3. 合并掉的四个旧地址必须还进得去（重定向），否则书签和页面之间的互跳会 404。
//
// 跑法：node scripts/test/listing-ops-regression.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MENU, canVisit, visibleMenu } from '../../src/renderer/src/menu.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const listing = read('src/renderer/src/views/Listing.vue')
const ops = read('src/renderer/src/views/Ops.vue')
const router = read('src/renderer/src/router.js')
const api = read('src/main/api.js')

const auth = (role) => ({ staff: { role } })

// --- 1. 走 ERP 既有接口 -------------------------------------------------------
for (const path of ['/listing/pending', '/listing/skus/', '/publish', '/delist']) {
  assert.ok(api.includes(path), `上下架要打 ERP 既有接口，缺 ${path}`)
}
// 动作做完要**重新问服务端**，不能本地把状态改成"已上架"就算完。
// 上下架是异步的：ERP 建作业、群控收单、真机或浏览器动手、再回写。本地乐观更新
// 会在界面上造出一份和服务端不一致的事实，而且失败时也不会自己变回去。
assert.match(
  listing,
  /await loadShops\(\)[\s\S]{0,60}await loadGoods\(\)/,
  '上下架成功后要重新拉一遍店铺与待上架清单，不许本地乐观改状态'
)
assert.ok(
  !/publish_status\s*=\s*['"]/.test(listing),
  '不许在端上给 publish_status 赋值：那个字段的真源在服务端'
)

// --- 2. 手机那一档按「不是 browser」判 ---------------------------------------
assert.match(
  listing,
  /device_kind !== 'browser'/,
  "手机组判据必须是「不是 browser」：没绑设备的店铺默认按真机算，漏判会把货发到没验过的链路"
)
assert.ok(
  !/device_kind === 'android'/.test(listing),
  "不能用「等于 android」判手机：没绑设备的店铺 device_kind 是 null，会被漏掉"
)

// --- 3. 在架/在途不能重复操作 -------------------------------------------------
assert.match(listing, /LISTED[\s\S]{0,80}SOLD/, '已在架和已售要一起挡住「再上架一次」')
assert.match(listing, /gc_pending/, '在途的作业（gc_pending）期间不能再点，否则会下重复指令')

// --- 4. 异步语义：只说"已下发"，不说"已完成" ---------------------------------
assert.match(
  listing,
  /指令已下发/,
  '上下架是异步的（群控收单后才动手）。说"已完成"会让人以为闲鱼上已经变了'
)

// --- 5. 合并后的菜单 ----------------------------------------------------------
const adminPaths = visibleMenu(auth('ADMIN')).map((m) => m.path)
assert.ok(adminPaths.includes('/ops'), '运维合成一页')
for (const gone of ['/envs', '/accounts', '/units', '/crawlers']) {
  assert.ok(!adminPaths.includes(gone), `${gone} 不该再单独占一行侧栏`)
}
assert.ok(adminPaths.length <= 7, `侧栏项数要收住，现在 ${adminPaths.length} 项`)

// 销售终于有自己的活了：合并前它只有两项，没有一件是它自己的
const salesPaths = visibleMenu(auth('SALES')).map((m) => m.path)
assert.ok(salesPaths.includes('/listing'), '销售要有上下架')
assert.equal(canVisit(auth('SALES'), '/ops'), false, '运维是管理员的，销售进不去')
assert.equal(canVisit(auth('PURCHASER'), '/listing'), false, '上下架是销售的活，不给采购')

// --- 6. 旧地址仍然进得去 ------------------------------------------------------
for (const [from, tab] of [['envs', 'envs'], ['accounts', 'accounts'], ['units', 'units'], ['crawlers', 'crawlers']]) {
  assert.match(
    router,
    new RegExp(`path: '${from}', redirect: '/ops\\?tab=${tab}'`),
    `/${from} 要重定向到运维页的对应标签，否则旧书签和页面间互跳会 404`
  )
}

// --- 7. 标签页按需挂载 --------------------------------------------------------
assert.match(
  ops,
  /loaded\.(envs|accounts|units|crawlers)|loaded\[/,
  '四个标签要按需挂载：这几页各自都在轮询，一进来全开等于四倍请求'
)
assert.ok(
  !/v-if="tab ===/.test(ops),
  '挂过的标签不要再卸掉：来回切一次就重新加载一遍，会让人以为点错了'
)

// --- 8. 菜单表本身仍然自洽 ----------------------------------------------------
const icons = read('src/renderer/src/views/Console.vue')
for (const item of MENU) {
  assert.ok(icons.includes(item.icon), `菜单 ${item.path} 用的图标 ${item.icon} 没在 Console.vue 注册`)
}

console.log('listing-ops regression: passed (走既有接口 + 手机判据 + 异步语义 + 侧栏收到 7 项 + 旧地址可达)')

// --- 9. 页框：整页不滚，内容自己滚 -------------------------------------------
// 老板 2026-09-16：「页面太长了，找东西很费劲。」查下来主因是**表格没有高度上限**，
// 内容一多就把工具条和分页顶出视口。下面这几条钉住治法，免得下次加个区块又退回去。
const pageCss = read('src/renderer/src/assets/page.css')
const mainJs = read('src/renderer/src/main.js')
assert.ok(mainJs.includes('assets/page.css'), '页框工具类要全局引入，否则各页又会各写一套')
for (const cls of ['.page', '.page-body', '.page-tabs']) {
  assert.ok(pageCss.includes(cls), `页框缺 ${cls}`)
}
assert.match(
  pageCss,
  /min-height:\s*0/,
  'flex 容器没有 min-height:0，子元素会撑破父容器，滚动条跑到外面去——这是最常踩的一脚'
)

const envs = read('src/renderer/src/views/Envs.vue')
assert.match(envs, /class="envs page"/, '浏览器环境页要用页框：它原来连高度上限都没有')
assert.match(envs, /class="page-body"/, '会滚的那部分要圈出来')

// 魔法数字：height: calc(100vh - <某个会过期的数字>)。上面加一行说明就得回来改它，
// 不改就露出双滚动条。页框用 flex 算，不需要这种数字。
for (const f of ['Listing.vue', 'Ops.vue', 'Envs.vue']) {
  assert.ok(
    !/calc\(100vh\s*-\s*\d+px\)/.test(read(`src/renderer/src/views/${f}`)),
    `${f} 不该再用 100vh 减魔法数字撑高度，那个数字绑着它上面所有东西`
  )
}

// 用途登记：配一次就不动的东西，不该常驻页面占掉半屏
assert.match(envs, /el-drawer[\s\S]{0,200}用途登记/, '用途登记收进抽屉，不再是第二张无上限的表')

// --- 10. 跨页带上下文 ---------------------------------------------------------
// 比面包屑值钱：从库存看到一件货想发出去，不该让人切页再从列表里把它找回来。
const wms = read('src/renderer/src/views/Wms.vue')
assert.match(wms, /去上架/, '库存商品要能直接跳去上下架')
assert.match(wms, /path: '\/listing'/, '跳转要带 query，落到那件货上')
assert.match(listing, /route\.query\.q/, '上下架页要接住带过来的搜索词')
assert.match(
  listing,
  /filtered\.value\.length === 1[\s\S]{0,40}pick/,
  '只命中一条时直接选中：否则人还得再点一次刚才就在眼前的那件货'
)
assert.match(listing, /\/ops\?tab=accounts/, '「没有可用店铺」要给条路去绑定，不能只报错不给出口')

console.log('listing-ops regression: 页框与跨页跳转 8 条追加通过')
