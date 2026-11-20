// 配置写盘被 Windows 文件锁挡住时的重试和提示（src/main/safe-store.js）。
// 跑法：node scripts/test/config-write-resilience-regression.mjs
import assert from 'node:assert/strict'
import { makeResilientStore, writeWithRetry } from '../../src/main/safe-store.js'

let attempts = 0
const value = writeWithRetry(() => {
  attempts += 1
  if (attempts < 3) {
    const error = new Error('locked')
    error.code = 'EPERM'
    throw error
  }
  return attempts
}, '测试写盘')
assert.equal(value, 3, 'EPERM 两次后第三次应成功')
assert.equal(attempts, 3)

let failed = null
try {
  writeWithRetry(() => {
    const error = new Error('locked')
    error.code = 'EPERM'
    throw error
  }, '保存登录配置')
} catch (error) {
  failed = error
}
assert.ok(failed, '一直失败时必须抛错')
assert.match(failed.message, /保存登录配置失败/, '错误要带业务名称')
assert.match(failed.message, /关闭其他巡航台实例/, '错误要告诉用户怎么做')
assert.match(failed.message, /EPERM/, '错误要保留底层 code 方便排障')

const fake = {
  value: null,
  fail: false,
  set(key, next) {
    if (this.fail) {
      const error = new Error('locked')
      error.code = 'EPERM'
      throw error
    }
    this.value = next
  },
  delete() {},
  clear() {}
}
makeResilientStore(fake, '保存测试配置')
fake.set('tokenEnc', 'x')
assert.equal(fake.value, 'x', '正常写入仍要落值')

console.log('config-write-resilience-regression: PASS')
