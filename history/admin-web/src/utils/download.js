// blob 响应触发浏览器下载（文件名由前端指定，后端响应头用 ASCII 名避免编码兼容问题）
export function downloadBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  window.URL.revokeObjectURL(url)
}

// responseType: 'blob' 的请求出错时，响应体也是 Blob，需读出来才能拿到后端 detail
export async function blobErrorDetail(err) {
  try {
    const data = err?.response?.data
    if (data instanceof Blob) return JSON.parse(await data.text())?.detail || null
    return data?.detail || null
  } catch {
    return null
  }
}
