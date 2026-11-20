// ERP 后端客户端：crawler-login / refresh / crawl-tasks / prices
import axios from 'axios'
import { getServerBaseUrl, getToken } from './store.js'

function client() {
  const inst = axios.create({ baseURL: getServerBaseUrl() + '/api', timeout: 20000 })
  inst.interceptors.request.use((config) => {
    const token = getToken()
    if (token) config.headers.Authorization = `Bearer ${token}`
    return config
  })
  return inst
}

export async function login(username, password) {
  // 不带 token 调用（登录前 store 里可能有旧 token，这里显式新建）
  const inst = axios.create({ baseURL: getServerBaseUrl() + '/api', timeout: 20000 })
  const { data } = await inst.post('/auth/crawler-login', { username, password })
  return data // { token, staff }
}

export async function refresh() {
  const { data } = await client().post('/auth/refresh')
  return data
}

export async function fetchTasks() {
  const { data } = await client().get('/market/crawl-tasks')
  return data // [{ id, name, keyword }]
}

export async function uploadPrice({ productId, price, trendDelta, searchHeat, raw }) {
  const body = { product_id: productId, price }
  if (trendDelta != null) body.trend_delta = trendDelta
  if (searchHeat != null) body.search_heat = searchHeat
  if (raw) body.raw = raw
  const { data } = await client().post('/market/prices', body)
  return data
}
