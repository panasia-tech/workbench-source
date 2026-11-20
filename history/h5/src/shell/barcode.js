// 条码识别器：有原生 BarcodeDetector（安卓 Chrome）就用原生；没有（iOS Safari）用 zxing-wasm。
// wasm 打进站点自己的静态资源，不走 jsDelivr——国内访问不稳，离线也要能扫。

const cache = new Map()

export function createDetector(formats) {
  const key = formats.join(',')
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      if ('BarcodeDetector' in window) {
        try {
          const supported = await window.BarcodeDetector.getSupportedFormats()
          if (formats.every((f) => supported.includes(f))) return { detector: new window.BarcodeDetector({ formats }), native: true }
        } catch {
          /* 原生不可用，走 wasm */
        }
      }
      const [{ BarcodeDetector, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
        import('barcode-detector/ponyfill'),
        import('zxing-wasm/reader/zxing_reader.wasm?url'),
      ])
      prepareZXingModule({
        overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
      })
      return { detector: new BarcodeDetector({ formats }), native: false }
    })().catch((e) => {
      cache.delete(key)
      throw e
    }))
  }
  return cache.get(key)
}
