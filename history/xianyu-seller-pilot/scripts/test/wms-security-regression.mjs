import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { normalizeInStockSkus, safeWmsErrorReason } from '../../src/main/wms-match.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (file) => readFileSync(resolve(root, file), 'utf8')
const wms = read('src/main/wms.js')
const api = read('src/main/api.js')
const index = read('src/main/index.js')
const taskStore = read('src/main/task-store.js')
const wmsView = read('src/renderer/src/views/Wms.vue')

// Inventory trust boundary: only IN_STOCK rows, first duplicate SKU wins, blank
// identifiers never enter the cache.
const normalized = normalizeInStockSkus([
  { sku_code: 'A-1', status: 'IN_STOCK', model: 'M-1' },
  { sku_code: 'A-1', status: 'IN_STOCK', model: 'M-1-duplicate' },
  { sku_code: 'A-2', status: 'SHIPPED', model: 'M-2' },
  { sku_code: '', status: 'IN_STOCK', model: 'missing' },
  { sku_code: 'A-3', status: 'in_stock', model: 'M-3' }
])
assert.deepEqual(normalized.map((row) => row.sku_code), ['A-1', 'A-3'])
assert.equal(normalized[0].model, 'M-1', 'duplicate SKU policy must be deterministic first-write-wins')

// Timeout and pagination guards are source-level contracts around the real REST
// and MCP adapters; they must not be replaced with an unbounded Promise race.
assert.match(api, /AbortController/)
assert.match(api, /WMS_REQUEST_TIMEOUT_MS/)
assert.match(api, /WMS 分页重复/)
assert.match(api, /WMS 分页响应不一致/)
assert.match(wms, /AbortController/)
assert.match(wms, /MCP 请求超时/)
assert.match(wms, /status: 'IN_STOCK'/)
assert.match(wms, /normalizeInStockSkus/)
assert.match(wms, /replaceWmsCache\(normalized, syncedAt\)/)
assert.match(wms, /updateWmsSku\(\{ taskId, skuCode, patch = \{\}, timeoutMs = WMS_REQUEST_TIMEOUT_MS \} = \{\}\)/)
assert.match(wms, /assertWritebackTaskReady\(task, code\)/)
assert.match(wms, /fetchInventorySku\(code, \{ token: admin\.token/)
assert.match(wms, /assertVerifiedWmsWriteback/)
assert.match(wms, /API 回写后 GET 校验失败/)
assert.match(wms, /LIMIT \$\{safeLimit\}/)
assert.match(wms, /sanitizeWmsApiWritebackPatch/)
assert.doesNotMatch(wms, /allowed\[.*suggest_price|allowed\[.*sale_price/)
assert.match(api, /INVENTORY_FORBIDDEN_WRITEBACK_FIELDS/)
assert.match(api, /If-Match/)

// Cache replacement occurs only after complete validation and uses the one
// task-center invalidation boundary from Plan 01.
assert.match(taskStore, /export const replaceWmsCache\s*=\s*\(list, syncedAt\)/)
assert.match(taskStore, /meta\.set\('wmsSkus'/)
assert.match(taskStore, /meta\.set\('wmsSyncedAt'/)
assert.match(taskStore, /replaceWmsCache[\s\S]*?invalidateTaskCenterSnapshot\(\)/)

// The MCP allowlist must cover the api subdomain the ERP actually advertises
// (/api/config/mcp-info returns http://127.0.0.1:8000) and must follow the
// configured server, otherwise the fallback channel is unreachable by design.
assert.match(wms, /MCP_BUILTIN_HOSTS = Object\.freeze\(\['api\.panasia\.fun', 'panasia\.fun'\]\)/)
assert.match(wms, /function mcpAllowedHosts\(\)/)
assert.match(wms, /hosts\.add\(`api\.\$\{hostname\}`\)/)
assert.doesNotMatch(wms, /parsed\.hostname !== MCP_ALLOWED_HOST/)
// streamable-http mounts on a trailing slash; boundedFetch refuses redirects, so
// the missing slash has to be normalised instead of turning into a 307 failure.
assert.match(wms, /if \(!parsed\.pathname\.endsWith\('\/'\)\) parsed\.pathname \+= '\/'/)

// REST must never fire an anonymous inventory request: /api/inventory/skus only
// answers to Authorization. Reads now ride the workbench's own ERP login (the
// server lets CRAWLER list in-stock models with cost masked); the separate
// admin credential stays optional and is required only for writeback.
assert.doesNotMatch(wms, /let restToken = null/)
assert.match(wms, /async function resolveRestReadToken/)
assert.match(wms, /ensureCrawlerToken/)
assert.match(wms, /尚未登录 ERP/)
assert.match(wms, /回写 API 名称需要在连接设置里填回写管理账号/)
// 回写账号是可选项：一组过期/写错的凭据不能把本来能走通的读库存整条堵死。
assert.match(wms, /回写管理账号不可用，改用工作台登录态读库存/)
// 保存那边「留空 = 保持不变」，所以必须另有一条显式的清除路径，否则填错就永久卡住。
const appStoreSrc = read('src/main/store.js')
assert.match(appStoreSrc, /export function clearWmsRestCredentials/)
assert.match(index, /ipcMain\.handle\('wms:clear-writeback-credentials'/)
assert.match(wmsView, /clearWmsWritebackCredentials/)
// 用自身登录态时「200 + 0 条」既可能是真空库存，也可能是服务端还没放行这个角色；
// 两者无法区分，而误判会清空整份快照，所以这条路径必须拒绝空结果。
assert.match(wms, /if \(!privileged && rows\.length === 0\)/)
assert.match(wms, /allowEmpty: privileged/)
const syncService = read('src/main/wms-sync-service.js')
// 「是否已配置」必须与 resolveRestReadToken 真能拿到令牌的条件一致，
// 否则装好但没点过登录的机器会停在 unconfigured，连一次同步都不尝试。
assert.match(syncService, /store\.getToken\(\)/, '登录态本身就让 REST 只读可用')
assert.match(syncService, /readErpCredentials/, '私有凭据也能静默登录，判定不能漏算')

// The server base URL is a configuration item with a default, validated once at
// the store boundary so a broken value cannot poison every later request.
const appStore = read('src/main/store.js')
assert.match(appStore, /export const DEFAULT_SERVER_BASE_URL = 'https:\/\/panasia\.fun'/)
assert.match(appStore, /export function normalizeServerBaseUrl/)
assert.match(appStore, /服务器地址不能为空/)
assert.match(appStore, /只有本机调试地址可以用 http/)
assert.match(index, /defaultServerBaseUrl: store\.DEFAULT_SERVER_BASE_URL/)
assert.match(index, /reason: e\?\.message \|\| '服务器地址无效'/)

// Credential-bearing errors must be safe even when an adapter throws an axios
// message containing a bearer token or query-string secret.
const redacted = safeWmsErrorReason(new Error('authorization=Bearer top-secret token=abc123 https://wms.example/sync?api_key=leak'))
assert.doesNotMatch(redacted, /top-secret|abc123|leak/)
assert.match(redacted, /REDACTED/)

// An HTTP failure must surface the server's own detail; axios only exposes
// "Request failed with status code 403", which names no cause an operator can act on.
const forbidden = Object.assign(new Error('Request failed with status code 403'), {
  response: { status: 403, data: { detail: '非管理员账号' } }
})
assert.match(safeWmsErrorReason(forbidden), /HTTP 403：非管理员账号/)
const stringDetail = Object.assign(new Error('Request failed with status code 401'), {
  response: { status: 401, data: 'unauthorized' }
})
assert.match(safeWmsErrorReason(stringDetail), /HTTP 401：unauthorized/)
// A bearer token inside the response body must still be redacted.
const leaky = Object.assign(new Error('boom'), {
  response: { status: 400, data: { detail: 'authorization=Bearer leaked-value' } }
})
assert.doesNotMatch(safeWmsErrorReason(leaky), /leaked-value/)

// IPC DTOs remove raw credentials and expose only configuration metadata. Empty
// renderer fields are write-only updates, so saving a URL does not erase secrets.
assert.match(index, /delete dto\.wmsMcpKey/)
assert.match(index, /delete dto\.wmsRestUsername/)
assert.match(index, /delete dto\.wmsRestPassword/)
assert.match(index, /wmsMcpKeyConfigured/)
assert.match(index, /tasks:manual-correction/)
assert.match(index, /wms:update-sku/)
assert.match(index, /safeWmsErrorReason\(error, 'API 名称回写失败'\)/)
assert.match(index, /taskSettingsPatch/)
assert.match(wmsView, /wmsMcpKeyConfigured/)
assert.match(wmsView, /if \(wmsMcpKey\.value\.trim\(\)\) patch\.wmsMcpKey/)
assert.match(wmsView, /if \(wmsRestPassword\.value\.trim\(\)\) patch\.wmsRestPassword/)
assert.doesNotMatch(wmsView, /wmsMcpKey\.value\s*=\s*settings\.wmsMcpKey/)
assert.match(wmsView, /getWmsProjection/)
assert.match(wmsView, /API-SPU 管理/)
assert.doesNotMatch(wmsView, /getWmsCatalog/)
assert.doesNotMatch(wmsView, /型号精确匹配|SPU精准匹配|wmsCandidates|匹配方式/)

// Only approved HTTPS Goofish URLs are handed to shell.openExternal; all other
// schemes/hosts and sensitive query material are rejected before the call.
assert.match(index, /validateExternalGoofishUrl/)
assert.match(index, /parsed\.protocol !== 'https:'/)
assert.match(index, /goofish\.com/)
assert.match(index, /shell\.openExternal\(validated\.url\)/)
assert.doesNotMatch(index, /shell\.openExternal\(url\)/)

console.log('wms security regression: passed (timeout/filter/dedupe/cache/DTO/external-link contracts)')
