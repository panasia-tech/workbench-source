#!/usr/bin/env node

/**
 * Deterministic validator for the Phase 01.2 API-SPU contract.
 *
 * This file intentionally has no production imports or third-party
 * dependencies.  The contract is a small YAML frontmatter document; the
 * parser below supports the deliberately narrow mapping/scalar subset used by
 * the contract and JSON fixtures.  Keeping the parser here makes the gate
 * available before the application/server runtime is changed.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_PATHS = Object.freeze([
  ['phase', 'string'],
  ['contract_version', 'positive_integer'],
  ['status', 'status'],
  ['confirmed_by', 'string'],
  ['confirmed_at', 'iso_timestamp'],
  ['ordinary_success_policy', 'ordinary_success_policy'],
  ['schedule', 'object'],
  ['schedule.startup_trigger', 'string'],
  ['schedule.interval', 'duration'],
  ['schedule.timezone', 'iana_timezone'],
  ['schedule.expiry_rule', 'duration'],
  ['schedule.mechanism', 'string'],
  ['concurrency_limit', 'positive_integer'],
  ['retry_policy', 'object'],
  ['retry_policy.max_attempts', 'positive_integer'],
  ['retry_policy.backoff', 'duration'],
  ['risk_pause_resume', 'string'],
  ['out_of_stock_policy', 'out_of_stock_policy'],
  ['multi_sku_writeback_scope', 'string'],
  ['writeback_roles', 'roles'],
  ['expected_version_field', 'string'],
  ['idempotency_key_formula', 'string'],
  ['evidence_backup_policy', 'string'],
  ['rollback_policy', 'rollback_policy'],
  ['price_writeback_policy', 'object'],
  ['price_writeback_policy.mode', 'price_writeback_mode'],
  ['price_writeback_policy.policy_version', 'string'],
  ['price_writeback_policy.target_field', 'price_target_field'],
  ['price_writeback_policy.candidate_ratio_basis', 'candidate_ratio_basis'],
  ['price_writeback_policy.candidate_source', 'candidate_source'],
  ['price_writeback_policy.candidate_freshness', 'duration'],
  ['price_writeback_policy.minimum_sample_count', 'positive_integer'],
  ['price_writeback_policy.cost_floor_ratio', 'positive_number'],
  ['price_writeback_policy.max_spread_ratio', 'bounded_ratio'],
  ['price_writeback_policy.spread_formula', 'spread_formula'],
  ['price_writeback_policy.rounding_increment', 'positive_integer'],
  ['price_writeback_policy.rounding_mode', 'rounding_mode'],
  ['price_writeback_policy.multi_sku_aggregation', 'multi_sku_aggregation'],
  ['price_writeback_policy.recommendation_formula', 'recommendation_formula'],
  ['price_writeback_policy.operator_selection', 'operator_selection'],
  ['price_writeback_policy.ambiguous_or_missing_behavior', 'ambiguous_price_behavior'],
  ['price_writeback_policy.selection_requires_explicit_confirm', 'explicit_confirmation'],
  ['price_writeback_policy.expected_version_field', 'string'],
  ['price_writeback_policy.idempotency_key_formula', 'string'],
])

const TOP_LEVEL_KEYS = new Set([
  'phase',
  'contract_version',
  'status',
  'confirmed_by',
  'confirmed_at',
  'ordinary_success_policy',
  'schedule',
  'concurrency_limit',
  'retry_policy',
  'risk_pause_resume',
  'out_of_stock_policy',
  'multi_sku_writeback_scope',
  'writeback_roles',
  'expected_version_field',
  'idempotency_key_formula',
  'evidence_backup_policy',
  'rollback_policy',
  'price_writeback_policy',
])

const NESTED_KEYS = Object.freeze({
  schedule: new Set(['startup_trigger', 'interval', 'timezone', 'expiry_rule', 'mechanism']),
  retry_policy: new Set(['max_attempts', 'backoff']),
  price_writeback_policy: new Set(['mode', 'policy_version', 'target_field', 'candidate_ratio_basis', 'candidate_source', 'candidate_freshness', 'minimum_sample_count', 'cost_floor_ratio', 'max_spread_ratio', 'spread_formula', 'rounding_increment', 'rounding_mode', 'multi_sku_aggregation', 'recommendation_formula', 'operator_selection', 'ambiguous_or_missing_behavior', 'selection_requires_explicit_confirm', 'expected_version_field', 'idempotency_key_formula']),
})

const ENUMS = Object.freeze({
  status: new Set(['CONFIRMED', 'PENDING_HUMAN_CONFIRMATION']),
  ordinary_success_policy: new Set(['DIRECT_SUCCESS', 'ALL_REVIEW']),
  out_of_stock_policy: new Set(['PAUSED', 'ARCHIVED_READ_ONLY', 'READ_ONLY']),
  rollback_policy: new Set(['NO_DOWNGRADE_AFTER_EVIDENCE']),
  price_writeback_mode: new Set(['MEDIAN_VALID_MARKET_WITH_COST_FLOOR']),
  price_target_field: new Set(['SkuListingInfo.price']),
  candidate_ratio_basis: new Set(['COST_PRICE']),
  candidate_source: new Set(['MARKET_OBSERVATION']),
  spread_formula: new Set(['RANGE_OVER_MEDIAN']),
  rounding_mode: new Set(['NEAREST']),
  multi_sku_aggregation: new Set(['PER_SKU']),
  recommendation_formula: new Set(['MAX_MEDIAN_OR_COST_FLOOR_THEN_ROUND']),
  operator_selection: new Set(['CANDIDATE_OR_RECOMMENDATION_OR_CUSTOM_ABOVE_FLOOR']),
  ambiguous_price_behavior: new Set(['REVIEW_ONLY']),
})

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseScalar(raw) {
  const value = raw.trim()
  if (value === '') return null
  if (value === 'null' || value === '~') return null
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value)

  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      throw new Error('invalid double-quoted scalar')
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }

  // JSON arrays/objects make fixture authoring unambiguous while keeping the
  // frontmatter parser dependency-free.
  if ((value.startsWith('[') && value.endsWith(']')) || (value.startsWith('{') && value.endsWith('}'))) {
    try {
      return JSON.parse(value)
    } catch {
      throw new Error('invalid inline JSON scalar')
    }
  }
  return value
}

function parseFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const lines = normalized.split('\n')
  if (lines[0] !== '---') throw new Error('frontmatter must start with ---')

  let close = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      close = index
      break
    }
  }
  if (close < 0) throw new Error('frontmatter closing --- is missing')

  const root = {}
  const stack = [{ indent: -1, object: root, path: '' }]
  const seen = new Set()

  for (let index = 1; index < close; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/\t/.test(line)) throw new Error(`frontmatter line ${index + 1} uses tabs`)

    const indent = line.match(/^ */)[0].length
    const match = line.trim().match(/^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/)
    if (!match) throw new Error(`invalid frontmatter line ${index + 1}`)
    const [, key, rawValue = ''] = match

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].object
    const parentPath = stack[stack.length - 1].path
    const fullPath = parentPath ? `${parentPath}.${key}` : key
    if (Object.prototype.hasOwnProperty.call(parent, key)) throw new Error(`duplicate field ${fullPath}`)
    if (seen.has(fullPath)) throw new Error(`duplicate field ${fullPath}`)
    seen.add(fullPath)

    const value = rawValue.trim() === '' ? {} : parseScalar(rawValue)
    parent[key] = value
    if (isPlainObject(value) && rawValue.trim() === '') {
      stack.push({ indent, object: value, path: fullPath })
    }
  }
  return root
}

function parseContract(text, sourcePath = '') {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{')) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`invalid JSON contract${sourcePath ? `: ${sourcePath}` : ''}`)
    }
    if (!isPlainObject(parsed)) throw new Error('JSON contract root must be an object')
    return parsed
  }
  return parseFrontmatter(text)
}

function pathParts(fieldPath) {
  return fieldPath.split('.')
}

function getPath(root, fieldPath) {
  let current = root
  for (const part of pathParts(fieldPath)) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) return undefined
    current = current[part]
  }
  return current
}

function collectPaths(value, prefix = '') {
  const result = []
  if (!isPlainObject(value)) return result
  for (const key of Object.keys(value).sort()) {
    const current = prefix ? `${prefix}.${key}` : key
    result.push(current)
    if (isPlainObject(value[key])) result.push(...collectPaths(value[key], current))
  }
  return result
}

function addError(errors, code, fieldPath, message) {
  errors.push({ code, path: fieldPath, message })
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isBoundedRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function isIsoTimestamp(value) {
  if (!isNonEmptyString(value)) return false
  // Require an unambiguous ISO-8601 date/time with a UTC designator or offset.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() !== 'Invalid Date'
}

function isPositiveDuration(value) {
  if (!isNonEmptyString(value)) return false
  // The contract uses compact positive durations (15m, 6h, 1d, ...).
  if (/^[1-9]\d*(?:ms|s|m|h|d|w)$/.test(value)) return true

  // Also accept the unambiguous positive ISO-8601 duration form (PT15M,
  // P1D).  A zero-only duration is deliberately rejected.
  const match = value.match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/)
  if (!match || match[0] !== value) return false
  const components = match.slice(1).filter((component) => component !== undefined).map(Number)
  return components.length > 0 && components.some((component) => component > 0)
}

function isIanaTimezone(value) {
  if (!isNonEmptyString(value)) return false
  if (value === 'UTC') return true
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: value })
    const resolved = formatter.resolvedOptions().timeZone
    if (typeof Intl.supportedValuesOf === 'function') {
      return Intl.supportedValuesOf('timeZone').includes(value) || resolved === value
    }
    return resolved === value
  } catch {
    return false
  }
}

function validateRoles(value) {
  if (isNonEmptyString(value)) return true
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every((role) => isNonEmptyString(role))
}

function unresolvedToken(value, options) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  if (options.rejectPending && /^PENDING(?:_|$)/.test(normalized)) return 'PENDING'
  if (options.rejectTbd && normalized === 'TBD') return 'TBD'
  return null
}

function scanUnresolved(value, fieldPath, options, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanUnresolved(item, `${fieldPath}[${index}]`, options, errors))
    return
  }
  if (isPlainObject(value)) {
    Object.keys(value).sort().forEach((key) => scanUnresolved(value[key], fieldPath ? `${fieldPath}.${key}` : key, options, errors))
    return
  }
  const token = unresolvedToken(value, options)
  if (token) addError(errors, 'UNRESOLVED_VALUE', fieldPath, `${token} placeholder is not allowed`)
}

function validateContract(contract, options = {}) {
  const errors = []
  if (!isPlainObject(contract)) {
    addError(errors, 'ROOT_TYPE', '', 'contract root must be an object')
    return errors
  }

  for (const fieldPath of collectPaths(contract)) {
    const [topLevel] = fieldPath.split('.')
    if (!TOP_LEVEL_KEYS.has(topLevel)) {
      addError(errors, 'UNKNOWN_FIELD', fieldPath, 'field is not part of the contract schema')
      continue
    }
    if (fieldPath.includes('.')) {
      const [parent, child] = fieldPath.split('.')
      if (!NESTED_KEYS[parent]?.has(child)) addError(errors, 'UNKNOWN_FIELD', fieldPath, 'field is not part of the contract schema')
    }
  }

  for (const [fieldPath, type] of REQUIRED_PATHS) {
    const value = getPath(contract, fieldPath)
    if (value === undefined) {
      addError(errors, 'MISSING_FIELD', fieldPath, 'required field is missing')
      continue
    }
    if (value === null || (typeof value === 'string' && value.trim() === '')) {
      addError(errors, 'EMPTY_FIELD', fieldPath, 'required field must not be empty')
      continue
    }

    if (type === 'object') {
      if (!isPlainObject(value)) addError(errors, 'INVALID_TYPE', fieldPath, 'expected an object')
      continue
    }
    if (type === 'string' && !isNonEmptyString(value)) {
      addError(errors, 'INVALID_TYPE', fieldPath, 'expected a non-empty string')
      continue
    }
    if (type === 'roles' && !validateRoles(value)) {
      addError(errors, 'INVALID_TYPE', fieldPath, 'expected a non-empty string or array of non-empty strings')
      continue
    }
    if (type === 'positive_integer' && !isPositiveInteger(value)) {
      addError(errors, 'INVALID_POSITIVE_INTEGER', fieldPath, 'expected a positive safe integer')
      continue
    }
    if (type === 'status' || type === 'ordinary_success_policy' || type === 'out_of_stock_policy' || type === 'rollback_policy' || type === 'price_writeback_mode' || type === 'price_target_field' || type === 'candidate_ratio_basis' || type === 'candidate_source' || type === 'spread_formula' || type === 'rounding_mode' || type === 'multi_sku_aggregation' || type === 'recommendation_formula' || type === 'operator_selection' || type === 'ambiguous_price_behavior') {
      if (typeof value !== 'string' || !ENUMS[type].has(value)) {
        addError(errors, 'INVALID_ENUM', fieldPath, `unsupported ${type} value`)
      }
      continue
    }
    if (type === 'positive_number' && !isPositiveNumber(value)) {
      addError(errors, 'INVALID_POSITIVE_NUMBER', fieldPath, 'expected a positive finite number')
      continue
    }
    if (type === 'bounded_ratio' && !isBoundedRatio(value)) {
      addError(errors, 'INVALID_RATIO', fieldPath, 'expected a finite ratio between 0 and 1')
      continue
    }
    if (type === 'explicit_confirmation' && value !== true) {
      addError(errors, 'INVALID_CONFIRMATION', fieldPath, 'explicit confirmation must be true')
      continue
    }
    if (type === 'duration' && !isPositiveDuration(value)) {
      addError(errors, 'INVALID_DURATION', fieldPath, 'expected a positive duration such as 15m, 6h, or 1d')
      continue
    }
    if (type === 'iana_timezone' && !isIanaTimezone(value)) {
      addError(errors, 'INVALID_TIMEZONE', fieldPath, 'expected an IANA timezone')
      continue
    }
    if (type === 'iso_timestamp' && !isIsoTimestamp(value)) {
      addError(errors, 'INVALID_TIMESTAMP', fieldPath, 'expected an ISO-8601 timestamp with timezone')
    }
  }

  if (options.requireConfirmed && getPath(contract, 'status') !== 'CONFIRMED') {
    addError(errors, 'REQUIRE_CONFIRMED', 'status', 'status must be CONFIRMED')
  }
  if (options.expectedVersion !== undefined && getPath(contract, 'contract_version') !== options.expectedVersion) {
    addError(errors, 'VERSION_MISMATCH', 'contract_version', `expected contract version ${options.expectedVersion}`)
  }

  for (const requirement of options.requireValues ?? []) {
    const actual = getPath(contract, requirement.path)
    if (actual === undefined) {
      addError(errors, 'REQUIRE_VALUE_MISSING', requirement.path, 'required value path is missing')
    } else {
      const actualText = typeof actual === 'string' ? actual : JSON.stringify(actual)
      if (actualText !== requirement.value) addError(errors, 'REQUIRE_VALUE_MISMATCH', requirement.path, 'required value does not match')
    }
  }

  if (options.rejectPending || options.rejectTbd) scanUnresolved(contract, '', options, errors)
  return errors
}

function parseArgs(argv) {
  const options = { requireValues: [] }
  const errors = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      if (index + 1 >= argv.length) {
        errors.push({ code: 'CLI_MISSING_VALUE', path: arg, message: 'option requires a value' })
        return ''
      }
      index += 1
      return argv[index]
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--contract') {
      options.contractPath = next()
    } else if (arg.startsWith('--contract=')) {
      options.contractPath = arg.slice('--contract='.length)
    } else if (arg === '--expected-version') {
      options.expectedVersionRaw = next()
    } else if (arg.startsWith('--expected-version=')) {
      options.expectedVersionRaw = arg.slice('--expected-version='.length)
    } else if (arg === '--require-confirmed') {
      options.requireConfirmed = true
    } else if (arg === '--reject-pending') {
      options.rejectPending = true
    } else if (arg === '--reject-tbd') {
      options.rejectTbd = true
    } else if (arg === '--print-hash') {
      options.printHash = true
    } else if (arg === '--json-out') {
      options.jsonOut = next()
    } else if (arg.startsWith('--json-out=')) {
      options.jsonOut = arg.slice('--json-out='.length)
    } else if (arg === '--require-value') {
      const expression = next()
      const separator = expression.indexOf('=')
      if (separator <= 0) errors.push({ code: 'CLI_INVALID_REQUIRE_VALUE', path: '--require-value', message: 'expected path=value' })
      else options.requireValues.push({ path: expression.slice(0, separator), value: expression.slice(separator + 1) })
    } else if (arg.startsWith('--require-value=')) {
      const expression = arg.slice('--require-value='.length)
      const separator = expression.indexOf('=')
      if (separator <= 0) errors.push({ code: 'CLI_INVALID_REQUIRE_VALUE', path: '--require-value', message: 'expected path=value' })
      else options.requireValues.push({ path: expression.slice(0, separator), value: expression.slice(separator + 1) })
    } else {
      errors.push({ code: 'CLI_UNKNOWN_OPTION', path: arg, message: 'unknown option' })
    }
  }

  if (options.expectedVersionRaw !== undefined) {
    if (!/^\d+$/.test(options.expectedVersionRaw) || Number(options.expectedVersionRaw) <= 0) {
      errors.push({ code: 'CLI_INVALID_VERSION', path: '--expected-version', message: 'expected a positive integer' })
    } else options.expectedVersion = Number(options.expectedVersionRaw)
  }
  if (!options.help && !options.contractPath) errors.push({ code: 'CLI_MISSING_CONTRACT', path: '--contract', message: 'contract path is required' })
  return { options, errors }
}

function stableResult({ ok, contract, hash, errors, options }) {
  const result = {
    ok,
    contract_version: typeof contract?.contract_version === 'number' ? contract.contract_version : null,
    status: typeof contract?.status === 'string' ? contract.status : null,
    errors,
  }
  if (options.printHash) result.sha256 = hash
  return result
}

function writeJsonOut(destination, result) {
  if (!destination) return
  const resolved = path.resolve(destination)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, `${JSON.stringify(result)}\n`, 'utf8')
}

export function run(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv)
  if (parsed.options.help) {
    const result = {
      ok: true,
      usage: 'node market-spu-contract-check.mjs --contract PATH [--expected-version N] [--require-confirmed] [--reject-pending] [--reject-tbd] [--require-value path=value] [--print-hash] [--json-out PATH]',
    }
    console.log(JSON.stringify(result))
    return 0
  }
  if (parsed.errors.length > 0) {
    const result = stableResult({ ok: false, contract: null, hash: null, errors: parsed.errors, options: parsed.options })
    try { writeJsonOut(parsed.options.jsonOut, result) } catch { /* CLI errors remain deterministic on stdout. */ }
    console.log(JSON.stringify(result))
    return 1
  }

  let bytes
  let contract = null
  let errors = []
  try {
    bytes = fs.readFileSync(path.resolve(parsed.options.contractPath))
    const text = bytes.toString('utf8')
    contract = parseContract(text, parsed.options.contractPath)
    errors = validateContract(contract, parsed.options)
  } catch (error) {
    errors = [{ code: 'CONTRACT_READ_OR_PARSE', path: 'contract', message: error instanceof Error ? error.message : 'unable to read or parse contract' }]
  }

  const hash = bytes ? crypto.createHash('sha256').update(bytes).digest('hex') : null
  const result = stableResult({ ok: errors.length === 0, contract, hash, errors, options: parsed.options })
  try {
    writeJsonOut(parsed.options.jsonOut, result)
  } catch (error) {
    result.ok = false
    result.errors.push({ code: 'JSON_OUT_WRITE', path: 'json-out', message: error instanceof Error ? error.message : 'unable to write JSON output' })
  }
  console.log(JSON.stringify(result))
  return result.ok ? 0 : 1
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  process.exitCode = run()
}
