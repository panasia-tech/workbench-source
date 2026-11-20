// 后台对非管理员只开验货和上架审批相关的页面。接口各自校验角色，这里只管菜单和跳转：
// 没权限的接口回 403 会把人踢回登录页，所以不能让人走到那些页面上。
const WORKBENCH = '/inspection-ops/workbench'
const EXCEPTIONS = '/inspection-ops/exceptions'
const TEMPLATES = '/inspection-ops/templates'
const REVIEW = '/inspection-ops/review'
const FRAMES = '/tools/frames'
const LISTING_APPROVALS = '/listing/approvals'

const ROLE_PAGES = {
  WAREHOUSE: [WORKBENCH, EXCEPTIONS, TEMPLATES, FRAMES, LISTING_APPROVALS],
  PURCHASER: [EXCEPTIONS, REVIEW, FRAMES, LISTING_APPROVALS, '/orders/bargain'],
  BUSINESS: [EXCEPTIONS, REVIEW, LISTING_APPROVALS, '/orders/bargain'],
  NEGOTIATOR: [EXCEPTIONS, REVIEW, LISTING_APPROVALS, '/orders/bargain'],
  SALES: [REVIEW, FRAMES, LISTING_APPROVALS],
}

export function currentRole() {
  const payload = (localStorage.getItem('token') || '').split('.')[1]
  if (!payload) return ''
  try {
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).role || ''
  } catch {
    return ''
  }
}

export function isAdmin() {
  return currentRole() === 'ADMIN'
}

export function canOpen(path) {
  return isAdmin() || (ROLE_PAGES[currentRole()] || []).includes(path)
}

export function homePath() {
  return isAdmin() ? '/staff' : (ROLE_PAGES[currentRole()] || [])[0] || ''
}
