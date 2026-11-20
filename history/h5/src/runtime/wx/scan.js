import { openScanner } from '../ui.js'
import { promisify } from '../util.js'

// wx.scanCode → 全屏扫码层（src/shell/Scanner.vue）。识别用 BarcodeDetector，
// 浏览器没有原生实现（iOS Safari）时换成 zxing-wasm，wasm 跟着站点走，不依赖外网 CDN。

const FORMATS = {
  barCode: ['code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'itf', 'upc_a', 'upc_e'],
  qrCode: ['qr_code'],
  datamatrix: ['data_matrix'],
  pdf417: ['pdf417'],
}

function mpScanType(format) {
  if (format === 'pdf417') return 'PDF_417'
  return String(format || '').toUpperCase()
}

export const scanCode = promisify('scanCode', async (options) => {
  const types = options.scanType && options.scanType.length ? options.scanType : ['barCode', 'qrCode']
  const formats = [...new Set(types.flatMap((t) => FORMATS[t] || []))]
  const res = await openScanner(formats.length ? formats : [...FORMATS.barCode, ...FORMATS.qrCode])
  return { result: res.text, scanType: mpScanType(res.format), charSet: 'utf-8', path: '', rawData: '' }
})
