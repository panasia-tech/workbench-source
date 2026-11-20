// 删 AdsPower 环境时顺带停用它对应的店铺（src/main/env-shops.js + Envs.vue 的删除流程）。
//
// 群控没有删账号的接口：环境删了，群控账号和 ERP 店铺都还在，上架会一直往一个
// 永远发不出去的号里派货。这里钉死：
//   1. 只认账号的**当前**设备——号换到手机上之后，删旧环境不能把那家店停掉；
//   2. 服务端旧版本（对账里没有 device_hw_id）要如实说「查不了」，不能当成「没有对应店铺」；
//   3. 先停店铺再删环境：店铺能再启用，环境删了回不来。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { shopsForEnv } from '../../src/main/env-shops.js'

const row = (over) => ({
  shop_id: 's', shop_code: 'gc-x', shop_label: '店', nick: '店',
  device_kind: 'browser', device_hw_id: null, ...over
})

// --- 1. 按环境 ID 找到店铺，手机和别的环境不算 --------------------------------
{
  const rows = [
    row({ shop_id: 'a', shop_label: '嘻喵喵酱', device_hw_id: 'k1gnuq4m' }),
    row({ shop_id: 'b', shop_label: '别的环境', device_hw_id: 'k1other' }),
    row({ shop_id: 'c', shop_label: '手机号', device_kind: 'android', device_hw_id: 'k1gnuq4m' }),
    row({ shop_id: 'd', shop_label: '没绑设备', device_kind: null, device_hw_id: null })
  ]
  const found = shopsForEnv(rows, 'k1gnuq4m')
  assert.equal(found.supported, true)
  assert.deepEqual(found.shops, [{ id: 'a', label: '嘻喵喵酱' }],
    'hw_id 撞上的手机设备也不能算：只停浏览器环境上的那家')
  assert.deepEqual(shopsForEnv(rows, 'k1nobody').shops, [], '没登过号的环境没有对应店铺')
  assert.deepEqual(shopsForEnv(rows, '').shops, [], '没给环境 ID 不能匹配到任何店')
}

// --- 2. 服务端旧版本：查不了要说查不了 ----------------------------------------
{
  const old = [{ shop_id: 'a', shop_label: '店', device_kind: 'browser', device_id: 'dev1' }]
  const found = shopsForEnv(old, 'k1gnuq4m')
  assert.equal(found.supported, false, '把「查不了」当成「没有」，环境删了店还开着在派货')
  assert.deepEqual(found.shops, [])
  assert.equal(shopsForEnv([], 'k1').supported, true, '一家启用的店都没有，就是真的没有')
  assert.equal(shopsForEnv(null, 'k1').supported, true)
}

// --- 3. 删除流程：先查店铺、先停店铺，最后才删环境 ------------------------------
{
  const page = readFileSync(new URL('../../src/renderer/src/views/Envs.vue', import.meta.url), 'utf8')
  const body = page.slice(page.indexOf('async function remove(row)'))
  const at = (needle) => {
    const index = body.indexOf(needle)
    assert.ok(index >= 0, `删除流程里应调用 ${needle}`)
    return index
  }
  assert.ok(at('window.erp.envShops(') < at('ElMessageBox.confirm('), '确认框里要先说清会停哪家店')
  assert.ok(at('window.erp.envDisableShops(') < at('window.erp.envDelete('),
    '店铺停不掉就不该删环境：环境删了回不来')
}

console.log('env-shops-regression: PASS')
