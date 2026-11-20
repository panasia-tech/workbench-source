import { contextBridge, ipcRenderer } from 'electron'

const erp = {
  // 鉴权
  getAuthState: () => ipcRenderer.invoke('auth:get-state'),
  setServer: (url) => ipcRenderer.invoke('auth:set-server', url),
  login: (payload) => ipcRenderer.invoke('auth:login', payload),
  logout: () => ipcRenderer.invoke('auth:logout'),

  // 账号
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  addAccount: (name) => ipcRenderer.invoke('accounts:add', name),
  updateAccount: (id, patch) => ipcRenderer.invoke('accounts:update', { id, patch }),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),

  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 任务 / 爬取
  planTasks: () => ipcRenderer.invoke('tasks:plan'),
  startCrawl: () => ipcRenderer.invoke('crawl:start'),
  stopCrawl: () => ipcRenderer.invoke('crawl:stop'),
  crawlStatus: () => ipcRenderer.invoke('crawl:status'),

  // 结果日志
  queryResults: (params) => ipcRenderer.invoke('results:query', params),
  clearResults: () => ipcRenderer.invoke('results:clear'),

  // 预览
  attachPreview: (accountId, bounds) => ipcRenderer.invoke('preview:attach', { accountId, bounds }),
  setPreviewBounds: (bounds) => ipcRenderer.invoke('preview:set-bounds', bounds),
  detachPreview: () => ipcRenderer.invoke('preview:detach'),
  previewGotoHome: (accountId) => ipcRenderer.invoke('preview:goto-home', accountId),
  previewReload: (accountId) => ipcRenderer.invoke('preview:reload', accountId),

  // 窗口
  hideWindow: () => ipcRenderer.invoke('win:hide'),
  minimizeWindow: () => ipcRenderer.invoke('win:minimize'),

  // 爬取事件订阅；返回取消函数
  onCrawlEvent: (cb) => {
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('crawl:event', handler)
    return () => ipcRenderer.removeListener('crawl:event', handler)
  }
}

contextBridge.exposeInMainWorld('erp', erp)
