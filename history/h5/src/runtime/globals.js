// 小程序脚本里的全局量。compiler/cjs.js 给每个小程序文件注入这一行 import。
export { wx } from './wx/index.js'
export { getApp } from './app.js'
export { getCurrentPages } from './router.js'

export function Behavior(options) {
  return options
}

// WXS 专用
export function getDate(...args) {
  return new Date(...args)
}

export function getRegExp(pattern, flags) {
  return new RegExp(pattern, flags)
}
