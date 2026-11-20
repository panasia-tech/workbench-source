// 一个 AdsPower 环境对应哪几家店铺。
//
// 链路：环境 ID = 群控浏览器设备的 hw_id → 设备上登着的群控账号 → ERP 店铺。
// 数据来自 ERP 的店铺对账（/gc-bind/shops），那里的设备跟的是账号的**当前**设备：
// 号已经换到手机上的话，旧环境就对不上这家店——删一个早已不用的环境，不能把正在
// 手机上卖货的店停掉。

/**
 * @returns {{ supported: boolean, shops: {id: string, label: string}[] }}
 *   supported=false：服务端还是旧版本、对账里没有 device_hw_id。这时要说「查不了」，
 *   不能当成「没有对应店铺」——那样环境删了，店还开着在派货。
 */
export function shopsForEnv(rows, envId) {
  const id = String(envId || '').trim()
  const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : []
  const supported = list.length === 0 || list.some((row) => Object.hasOwn(row, 'device_hw_id'))
  const shops = !id ? [] : list
    .filter((row) => row.device_kind === 'browser' && row.device_hw_id === id)
    .map((row) => ({ id: String(row.shop_id), label: String(row.shop_label || row.nick || row.shop_code || '') }))
  return { supported, shops }
}
