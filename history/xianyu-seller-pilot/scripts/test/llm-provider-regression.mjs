import assert from 'node:assert/strict'

process.env.XIAN_YU_LLM_PROVIDER = 'qwen'
process.env.XIAN_YU_LLM_API_KEY = 'DEMO_ONLY_REDACTED'
delete process.env.XIAN_YU_LLM_MODEL
delete process.env.XIAN_YU_LLM_BASE_URL

const { getAliasProviderStatus } = await import('../../src/main/llm-alias.js')
let status = getAliasProviderStatus()
assert.equal(status.provider, 'qwen')
assert.equal(status.model, 'qwen3.8-max')
assert.equal(status.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
assert.equal(status.supportsWebSearch, true)
assert.equal(status.webSearchCostCny, 0.004)

process.env.XIAN_YU_LLM_PROVIDER = 'deepseek'
status = getAliasProviderStatus()
assert.equal(status.provider, 'deepseek')
assert.equal(status.model, 'deepseek-v4-flash')
assert.equal(status.baseUrl, 'https://api.deepseek.com')
assert.equal(status.supportsWebSearch, false)

delete process.env.XIAN_YU_LLM_API_KEY
status = getAliasProviderStatus()
assert.equal(status.configured, false)

console.log('llm provider regression: passed (qwen/deepseek hot swap defaults and search capability)')
