import assert from 'node:assert/strict'
import { hasAuthenticatedXianyuCookies } from '../../src/main/xianyu-auth.js'

assert.equal(hasAuthenticatedXianyuCookies([{ name: 'unb', value: 'visitor' }, { name: 'tfstk', value: 'risk' }]), false)
assert.equal(hasAuthenticatedXianyuCookies([{ name: 'cookie2', value: 'session' }]), false)
assert.equal(hasAuthenticatedXianyuCookies([{ name: 'cookie2', value: 'session' }, { name: 'munb', value: 'user' }]), true)
assert.equal(hasAuthenticatedXianyuCookies([{ name: 'havana_lgc2_77', value: 'user-session' }]), true)
assert.equal(hasAuthenticatedXianyuCookies([{ name: 'havana_lgc2_77', value: '' }]), false)

console.log('xianyu auth cookie regression: passed (visitor cookies are not login evidence)')
