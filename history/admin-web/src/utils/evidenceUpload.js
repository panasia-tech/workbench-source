import api from '../api'

// 走服务器的上传被 nginx 限在 50m；更大的直传 OSS（未带 Content-Type，签名里没算它）
const SERVER_UPLOAD_LIMIT = 45 * 1024 * 1024

function objectName(ext) {
  const rand = Math.random().toString(36).slice(2, 10)
  return `${Date.now().toString(36)}${rand}${ext}`
}

// name 给了就用它（录像重试上传沿用同一个文件名，服务端按地址去重，不会重复归档）
export function newObjectName(ext) {
  return objectName(ext)
}

export async function uploadEvidence(blob, dir, ext, name) {
  const filename = name || objectName(ext)
  if (blob.size <= SERVER_UPLOAD_LIMIT) {
    const form = new FormData()
    form.append('dir', dir)
    form.append('filename', filename)
    form.append('file', blob, filename)
    const { data } = await api.post('/oss/upload', form)
    return data.public_url
  }
  const { data } = await api.post('/oss/upload-token', { dir, filename })
  const resp = await fetch(data.upload_url, { method: 'PUT', body: new Blob([blob]) })
  if (!resp.ok) throw new Error(`upload ${resp.status}`)
  return data.public_url
}

export function errorText(err, fallback) {
  return err?.response?.data?.detail || fallback
}

export const checkResultLabels = { PASS: '通过', FAIL: '不通过', UNTESTABLE: '无法测试' }
export const checkResultTypes = { PASS: 'success', FAIL: 'danger', UNTESTABLE: 'warning' }
export const exceptionTypeLabels = { DAMAGED: '坏货', MISMATCH: '货不对版', OTHER: '其他', MISSING: '没到货' }
export const evidenceKindLabels = { UNBOX_VIDEO: '开箱视频', PRODUCT_PHOTO: '商品照', DEFECT_PHOTO: '瑕疵照' }
export const rejectStatusLabels = {
  PENDING: '待拒签',
  REJECTED: '已拒签',
  RETURNING: '退回中',
  RETURNED: '已退回',
  NOT_NEEDED: '不用退',
}
export const returnLogisticsLabels = { IN_TRANSIT: '在途', ABNORMAL: '异常（丢件/拒收等）', SIGNED: '网点已签收' }
export const refundStatusLabels = {
  PENDING: '待申请',
  APPLIED: '已申请',
  ACCEPTED: '已受理',
  PARTIAL: '部分到账',
  RECEIVED: '全额到账',
  DENIED: '被驳回',
  NOT_NEEDED: '不用退款',
}
