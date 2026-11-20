import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLlmService } = require('../../server/ai/llm-service.js')
const { createDatabase } = require('../../server/db/database.js')
const { createAuthService } = require('../../server/auth/auth-service.js')
const { buildHttpApp } = require('../../server/http/app.js')

const externalRoot = process.env.XIAN_YU_TEST_TMP || '/Volumes/ChatGPT/Codex-External/xianyu-server-ai-regression'

async function serviceContract() {
  const calls = []
  const env = { XIAN_YU_LLM_PROVIDER: 'zhipu', XIAN_YU_LLM_API_KEY: 'DEMO_ONLY_REDACTED', XIAN_YU_LLM_BASE_URL: 'https://llm.example.test/v4' }
  const service = createLlmService({ env, post: async (url, body, options) => {
    calls.push({ url, body, options })
    if (url.endsWith('/web_search')) return { data: { search_result: [{ title: '官方型号', content: '规格证据', link: 'https://example.test/model', media: 'official' }] } }
    return { data: { choices: [{ message: { content: JSON.stringify({ aliases: ['型号别名', '型号别名'] }) } }] } }
  } })
  assert.equal(service.status().configured, true)
  assert.equal(service.status().supportsWebSearch, true)
  const aliases = await service.suggestAliases({ brand: '测试品牌', model: '测试型号' })
  assert.deepEqual(aliases.aliases, ['型号别名'])
  assert.match(calls[0].options.headers.Authorization, /^Bearer server-test-secret$/)
  const evidence = await service.searchTaskEvidence({ brand: '测试品牌', model: '测试型号' }, { reason: '人工打回' })
  assert.equal(evidence.ok, true)
  assert.equal(evidence.results[0].link, 'https://example.test/model')

  const noKey = createLlmService({ env: { XIAN_YU_LLM_PROVIDER: 'qwen' } })
  assert.equal(noKey.status().configured, false)
  const deepseek = createLlmService({ env: { XIAN_YU_LLM_PROVIDER: 'deepseek', XIAN_YU_LLM_API_KEY: 'DEMO_ONLY_REDACTED' }, post: async () => { throw new Error('must not call deepseek web search') } })
  const skipped = await deepseek.searchTaskEvidence({ brand: '测试', model: '型号' })
  assert.equal(skipped.ok, false)
  assert.match(skipped.reason, /没有联网搜索通道/)
}

async function routeContract() {
  fs.mkdirSync(externalRoot, { recursive: true })
  const tempDir = fs.mkdtempSync(path.join(externalRoot, 'run-'))
  const db = createDatabase({ filename: path.join(tempDir, 'server.sqlite') })
  const auth = createAuthService({ db })
  const admin = auth.createUser({ username: 'ai-admin', password: 'DEMO_ONLY_REDACTED', role: 'admin' })
  const operator = auth.createUser({ username: 'ai-operator', password: 'DEMO_ONLY_REDACTED', role: 'operator' })
  const viewer = auth.createUser({ username: 'ai-viewer', password: 'DEMO_ONLY_REDACTED', role: 'read_only' })
  const task = db.createWorkbenchCollection({ sourceFile: 'ai.xlsx', sheetName: '行情任务', createdBy: admin.id, tasks: [{ id: 'ai-task-1', brand: '测试品牌', model: '测试型号', name: '测试型号', alias: '', spuCode: 'SPU-AI', referencePrice: 100, category: '显示器', searchKeywords: ['测试型号'] }] })
  const taskId = task.id ? db.listWorkbenchTasks({ page: 1, pageSize: 10 }).items[0].id : db.listWorkbenchTasks({ page: 1, pageSize: 10 }).items[0].id
  const llm = {
    status: () => ({ configured: true, provider: 'fixture', supportsWebSearch: true, webSearchCostCny: 0 }),
    suggestAliases: async () => ({ ok: true, configured: true, aliases: ['AI别名'], source: 'fixture', model: 'fixture-model' }),
    searchTaskEvidence: async () => ({ ok: true, configured: true, query: '测试品牌 测试型号 显示器', source: 'fixture-search', estimatedCostCny: 0, results: [{ title: '证据', content: '内容', link: 'https://example.test/evidence' }] })
  }
  const app = buildHttpApp({ db, auth, llm, config: { provider: 'fake', dataDir: tempDir } })
  await app.fastify.ready()
  const login = async (username, password) => {
    const response = await app.fastify.inject({ method: 'POST', url: '/auth/login', payload: { username, password } })
    assert.equal(response.statusCode, 200)
    return String(response.headers['set-cookie']).split(';')[0]
  }
  const adminCookie = await login('ai-admin', 'ai-admin-pass-123')
  const operatorCookie = await login('ai-operator', 'ai-operator-pass-123')
  const viewerCookie = await login('ai-viewer', 'ai-viewer-pass-123')

  const status = await app.fastify.inject({ method: 'GET', url: '/workbench/ai/status', headers: { cookie: viewerCookie } })
  assert.equal(status.statusCode, 200)
  assert.equal(status.json().supportsWebSearch, true)
  const aliasForbidden = await app.fastify.inject({ method: 'POST', url: `/workbench/tasks/${taskId}/aliases/suggest`, headers: { cookie: viewerCookie }, payload: {} })
  assert.equal(aliasForbidden.statusCode, 403)
  const alias = await app.fastify.inject({ method: 'POST', url: `/workbench/tasks/${taskId}/aliases/suggest`, headers: { cookie: operatorCookie }, payload: {} })
  assert.equal(alias.statusCode, 200)
  assert.deepEqual(alias.json().aliases, ['AI别名'])
  assert.deepEqual(db.getWorkbenchTask(taskId).aliases, ['AI别名'])

  db.setWorkbenchTaskOverride(taskId, { ...db.getWorkbenchTaskOverride(taskId), aiReviewStatus: 'candidate' }, admin.id)
  const search = await app.fastify.inject({ method: 'POST', url: `/workbench/tasks/${taskId}/ai-search`, headers: { cookie: operatorCookie }, payload: { reason: '人工打回' } })
  assert.equal(search.statusCode, 200)
  assert.equal(search.json().status, 'needs_review')
  assert.equal(db.getWorkbenchTask(taskId).aiWebSearchResults[0].link, 'https://example.test/evidence')
  const events = await app.fastify.inject({ method: 'GET', url: `/workbench/tasks/${taskId}/ai-events?limit=10`, headers: { cookie: viewerCookie } })
  assert.equal(events.statusCode, 200)
  assert.equal(events.json().items.length, 2)
  const approved = await app.fastify.inject({ method: 'POST', url: `/workbench/tasks/${taskId}/ai-review/approve`, headers: { cookie: operatorCookie }, payload: {} })
  assert.equal(approved.statusCode, 200)
  assert.equal(approved.json().task.aiReviewStatus, 'approved')
  await app.fastify.close()
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
}

try {
  await serviceContract()
  await routeContract()
  console.log('server-ai-regression: PASS (server provider contract + H5 aliases/search/review routes)')
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
