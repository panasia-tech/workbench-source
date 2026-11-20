import assert from 'node:assert/strict'
import { searchQueriesForTask } from '../../src/main/search-queries.js'

// 显示器默认保留型号和品牌+型号两条真实基础查询。
const monitor = searchQueriesForTask({ brand: '飞利浦', model: '27M1N5500ZR', category: '显示器' })
assert.deepEqual(monitor, ['27M1N5500ZR', '飞利浦 27M1N5500ZR'], '显示器默认搜索型号和品牌+型号')

// 空气净化器：自然叫法“小米空气净化器5”，绝不能变成“小米 5”
const purifier = searchQueriesForTask({ brand: '小米', model: '5', category: '空气净化器' })
assert.deepEqual(purifier, ['小米空气净化器5'], '空气净化器应搜自然叫法“小米空气净化器5”')
assert.ok(!purifier.includes('小米 5'), '不允许退化搜索成“小米 5”')

// 扫地/扫拖机器人：自然叫法“云鲸 J5”，不拼“云鲸扫拖机器人J5”
const robot = searchQueriesForTask({ brand: '云鲸', model: 'J5', category: '扫拖机器人' })
assert.deepEqual(robot, ['云鲸 J5'], '扫地机器人应搜“品牌 型号”')

// Apple产品品类：大众叫法；同一个品牌换到音响品类不能偷套 Apple 规则。
const appleTv = searchQueriesForTask({ brand: '苹果', model: 'APPLETV64G', category: 'Apple产品' })
assert.deepEqual(appleTv, ['Apple TV'], 'Apple TV 应搜“Apple TV”')
const airpods = searchQueriesForTask({ brand: '苹果', model: 'AIRPODSPRO3', category: 'Apple产品' })
assert.deepEqual(airpods, ['AirPods Pro 3'], 'AirPods Pro 3 应搜大众叫法')
const homepod = searchQueriesForTask({ brand: '苹果', model: 'HOMEPODMINI', category: 'Apple产品' })
assert.deepEqual(homepod, ['HomePod mini'], 'Apple产品只搜 HomePod mini 型号名')
const appleSpeaker = searchQueriesForTask({ brand: '苹果', model: 'HOMEPODMINI', category: '音响' })
assert.deepEqual(appleSpeaker, ['苹果HOMEPODMINI'], '换成音响品类后按音响整词规则，不按品牌套 Apple 映射')

// 无分类默认：整词搜索，不再误判为显示器。
const plain = searchQueriesForTask({ brand: 'AOC', model: '24G10ZE' })
assert.deepEqual(plain, ['AOC 24G10ZE'], '无分类应走默认整词策略')
const garmin = searchQueriesForTask({ brand: '佳明', model: 'Forerunner 265' })
assert.deepEqual(garmin, ['佳明 Forerunner 265'], '默认品类应按品牌+型号整词搜索')

// 异常队列（放宽）：净化器仍以自然叫法为基底扩展
const purifierBroad = searchQueriesForTask({ brand: '小米', model: '5S', category: '空气净化器' }, { strategy: 'broad' })
assert.ok(purifierBroad.some((q) => q.includes('小米空气净化器5S')), '放宽搜索也应以自然叫法为基底')

// 旧调用方传入的行级词保持顺序，并受到 12 项总量保护。
const configured = searchQueriesForTask({
  brand: 'HKC',
  model: 'MG25H11Q',
  searchKeywords: ['MG25H11Q', 'G25H4', 'HKC MG25H11Q']
})
assert.deepEqual(configured, ['MG25H11Q', 'G25H4', 'HKC MG25H11Q'])

const exactTwelve = Array.from({ length: 12 }, (_, index) => `显式字段-${index + 1}`)
const cappedWithAlias = searchQueriesForTask({
  searchKeywords: exactTwelve,
  aliases: ['第十三个别称']
})
assert.deepEqual(cappedWithAlias, exactTwelve, '已有 12 个显式字段时别称不能执行第 13 个 query')
assert.equal(cappedWithAlias.length, 12)

const legacyAliasFallback = searchQueriesForTask({
  brand: 'HKC',
  model: 'G25H4',
  category: '显示器',
  aliases: ['G25H4 180Hz']
})
assert.deepEqual(legacyAliasFallback, ['G25H4', 'HKC G25H4', 'G25H4 180Hz'], '没有持久化 searchKeywords 的旧任务仍要保留明确 accepted alias')

console.log('search queries regression: passed (legacy fallback plus row-level explicit count)')
