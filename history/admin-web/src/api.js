import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// 部署前缀，来自 vite.config.js 的 base（'/console/' → '/console'，根部署时为 ''）
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
const LOGIN_PATH = `${BASE}/login`

let redirecting = false
api.interceptors.response.use(
  (resp) => resp,
  (error) => {
    const status = error?.response?.status
    if (status === 401 || status === 403) {
      localStorage.removeItem('token')
      if (!redirecting && typeof window !== 'undefined' && window.location.pathname !== LOGIN_PATH) {
        redirecting = true
        // 交给 vue-router 的 redirect 必须是 base 相对路径，所以先把前缀切掉
        const inner = window.location.pathname.slice(BASE.length) + window.location.search
        const redirect = encodeURIComponent(inner || '/')
        window.location.replace(`${LOGIN_PATH}?redirect=${redirect}`)
      }
    }
    return Promise.reject(error)
  },
)

export default api
