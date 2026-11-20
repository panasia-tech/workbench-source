import assert from 'node:assert/strict'
import {
  CATEGORY_SEARCH_QUERY_LIMITS,
  buildCategorySearchQuery,
  categorySearchModeExample,
  categorySearchModeLabel,
  categorySearchModeSummary,
  categorySearchProfile,
  categorySearchQueryPlan,
  normalizeCategorySearchInput,
  normalizeCategorySearchModes
} from '../../src/shared/category-search.js'

assert.deepEqual(CATEGORY_SEARCH_QUERY_LIMITS, { primary: 2, alias: 1, total: 3 })
assert.deepEqual(normalizeCategorySearchInput({ brand: ['小米'], model: 5, category: ' 空气净化器 ' }), {
  brand: '', model: '5', category: '空气净化器'
})
assert.deepEqual(normalizeCategorySearchModes({ '显示 器': ' COMBINED ' }).显示器, 'combined')
assert.equal(buildCategorySearchQuery({ brand: '小米', model: '空气 净化器5', category: '空气 净化器' }), '小米空气 净化器5')

const monitor = categorySearchProfile('监视器')
assert.equal(monitor.category, '显示器')
assert.equal(categorySearchModeLabel(monitor.mode), '主型号搜索')
assert.equal(categorySearchModeExample(monitor, 'combined'), '主搜索：KTC 27GS820')
assert.deepEqual(categorySearchModeSummary({ 显示器: 'combined' }), { split: 0, combined: 6, text: '0 个主型号 · 6 个整词' })

const plan = categorySearchQueryPlan({ brand: 'KTC', model: '27GS820', category: '监视器' })
assert.deepEqual(plan.primaryQueries, ['27GS820', 'KTC 27GS820'])
assert.deepEqual(plan.queries, ['27GS820', 'KTC 27GS820'])
assert.equal(plan.aliasSlot.maxQueries, 1)
assert.equal(plan.maxQueryCount, 3)

console.log('category search rules regression: passed')
