const { request, BASE_URL } = require('./request')

function uploadMedia(dir, filename, filePath) {
  const token = wx.getStorageSync('token')
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${BASE_URL}/api/oss/upload`,
      filePath,
      name: 'file',
      formData: { dir, filename: filename || '' },
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(res.data))
          } catch (err) {
            reject({ detail: '上传响应解析失败' })
          }
          return
        }
        try {
          reject(JSON.parse(res.data))
        } catch (err) {
          reject({ detail: '上传失败' })
        }
      },
      fail: reject,
    })
  })
}

module.exports = {
  wxLogin: (code) => request({ url: '/api/auth/wx-login', method: 'POST', data: { code } }),
  bind: (data) => request({ url: '/api/auth/bind', method: 'POST', data }),
  devLogin: (data) => request({ url: '/api/auth/dev-login', method: 'POST', data }),
  me: () => request({ url: '/api/auth/me' }),
  setMyGithub: (account) => request({ url: '/api/auth/me/github', method: 'PUT', data: { account } }),
  logout: () => request({ url: '/api/auth/logout', method: 'POST' }),
  changePassword: (data) => request({ url: '/api/auth/change-password', method: 'POST', data }),
  // 手机卡信息（手机号 / ICCID / 空卡序列号）自助管理
  listSimCards: () => request({ url: '/api/auth/sim-cards' }),
  createSimCard: (data) => request({ url: '/api/auth/sim-cards', method: 'POST', data }),
  updateSimCard: (id, data) => request({ url: `/api/auth/sim-cards/${id}`, method: 'PATCH', data }),
  deleteSimCard: (id) => request({ url: `/api/auth/sim-cards/${id}`, method: 'DELETE' }),
  appConfig: () => request({ url: '/api/config' }),
  uploadToken: (dir, filename) => request({ url: '/api/oss/upload-token', method: 'POST', data: { dir, filename } }),
  uploadMedia: (dir, filename, filePath) => uploadMedia(dir, filename, filePath),
  ocrXianyu: (image_url) => request({ url: '/api/ocr/xianyu', method: 'POST', data: { image_url } }),
  ocrPayment: (image_url) => request({ url: '/api/ocr/payment', method: 'POST', data: { image_url } }),
  ocrSkuLabel: (image_url) => request({ url: '/api/ocr/sku-label', method: 'POST', data: { image_url } }),
  createPurchase: (data) => request({ url: '/api/purchase/orders', method: 'POST', data }),
  listPurchase: (params) => request({ url: '/api/purchase/orders', data: params }),
  getPurchase: (id) => request({ url: `/api/purchase/orders/${id}` }),
  updatePurchase: (id, data) => request({ url: `/api/purchase/orders/${id}`, method: 'PUT', data }),
  deletePurchase: (id) => request({ url: `/api/purchase/orders/${id}`, method: 'DELETE' }),
  listPurchaseSnapshots: (orderId) => request({ url: `/api/purchase/orders/${orderId}/snapshots` }),
  // 采购工作台 W10：执行端抓回来的平台订单（待建单 / 要人看）
  listPlatformOrders: (params) => request({ url: '/api/purchase/platform-orders', data: params }),
  // 采购工作台 W06：公司价（首报 / 目标 / 最高，空着是待定）
  purchaseQuote: (params) => request({ url: '/api/purchase/prices/quote', data: params }),
  getPlatformOrder: (id) => request({ url: `/api/purchase/platform-orders/${id}` }),
  platformOrderDraft: (id) => request({ url: `/api/purchase/platform-orders/${id}/draft` }),
  reviewPlatformOrder: (id, note) => request({ url: `/api/purchase/platform-orders/${id}/review`, method: 'POST', data: { note } }),
  savePurchaseSnapshot: (data) => request({ url: '/api/purchase/snapshots', method: 'POST', data }),
  listBargainSessions: (params) => request({ url: '/api/bargain/sessions', data: params }),
  openBargainSession: (data) => request({ url: '/api/bargain/sessions', method: 'POST', data }),
  getBargainSession: (id) => request({ url: `/api/bargain/sessions/${id}` }),
  bargainTransition: (id, data) => request({ url: `/api/bargain/sessions/${id}/transition`, method: 'POST', data }),
  bargainUpdateCheck: (id, data) => request({ url: `/api/bargain/sessions/${id}/checks`, method: 'POST', data }),
  bargainBindPurchase: (id, purchaseOrderId) => request({
    url: `/api/bargain/sessions/${id}/bind-purchase`, method: 'POST', data: { purchase_order_id: purchaseOrderId },
  }),
  listInspection: (params) => request({ url: '/api/inspection/tasks', data: params }),
  getInspection: (id) => request({ url: `/api/inspection/tasks/${id}` }),
  submitInspection: (id, data) => request({ url: `/api/inspection/tasks/${id}/submit`, method: 'POST', data }),
  enabledWarehouseTags: () => request({ url: '/api/master/warehouse-tags/enabled' }),
  enabledProductTypes: () => request({ url: '/api/master/product-types/enabled' }),
  redrawImage: (data) => request({ url: '/api/ai/redraw', method: 'POST', data }),
  listRedrawJobs: (params) => request({ url: '/api/ai/redraw/jobs', data: params }),
  updateInspectionActualAmount: (id, actualAmount) => request({
    url: `/api/inspection/tasks/${id}/actual-amount`,
    method: 'PATCH',
    data: { actual_amount: actualAmount },
  }),
  inventorySummary: () => request({ url: '/api/inventory/summary' }),
  listSkus: (params) => request({ url: '/api/inventory/skus', data: params }),
  skuDetail: (code) => request({ url: `/api/inventory/skus/${code}` }),
  splitSku: (code, items) => request({ url: `/api/inventory/skus/${code}/split`, method: 'POST', data: { items } }),
  updateSku: (code, data) => request({ url: `/api/inventory/skus/${code}`, method: 'PATCH', data }),
  lookupSkuBarcode: (code, barcode) => request({
    url: `/api/inventory/skus/${code}/barcode-lookup`,
    method: 'POST',
    data: barcode ? { barcode } : {},
  }),
  manualInbound: (data) => request({ url: '/api/inventory/manual-inbound', method: 'POST', data }),
  outboundScan: (data) => request({ url: '/api/inventory/outbound/scan', method: 'POST', data }),
  outboundManual: (data) => request({ url: '/api/inventory/outbound/manual', method: 'POST', data }),
  adjust: (data) => request({ url: '/api/inventory/adjust', method: 'POST', data }),
  stocktakeActive: () => request({ url: '/api/inventory/stocktake/active' }),
  stocktakeStart: () => request({ url: '/api/inventory/stocktake/start', method: 'POST' }),
  stocktakeAddItem: (sessionId, data) => request({ url: `/api/inventory/stocktake/${sessionId}/items`, method: 'POST', data }),
  stocktakePause: (sessionId) => request({ url: `/api/inventory/stocktake/${sessionId}/pause`, method: 'POST' }),
  stocktakeResume: (sessionId) => request({ url: `/api/inventory/stocktake/${sessionId}/resume`, method: 'POST' }),
  stocktakeComplete: (sessionId) => request({ url: `/api/inventory/stocktake/${sessionId}/complete`, method: 'POST' }),
  stocktakePropose: (sessionId, data) => request({ url: `/api/inventory/stocktake/${sessionId}/proposals`, method: 'POST', data }),
  stocktakeAutoPropose: (sessionId) => request({ url: `/api/inventory/stocktake/${sessionId}/proposals/auto`, method: 'POST' }),
  stocktakeSubmit: (sessionId) => request({ url: `/api/inventory/stocktake/${sessionId}/submit`, method: 'POST' }),
  stocktakeApprove: (sessionId, data) => request({ url: `/api/inventory/stocktake/${sessionId}/approve`, method: 'POST', data }),
  stocktakeReject: (sessionId, data) => request({ url: `/api/inventory/stocktake/${sessionId}/reject`, method: 'POST', data }),
  stocktakeList: (params) => request({ url: '/api/inventory/stocktake', data: params }),
  stocktakeDetail: (sessionId) => request({ url: `/api/inventory/stocktake/${sessionId}` }),
  listSales: (params) => request({ url: '/api/sales/orders', data: params }),
  listOutbounds: (params) => request({ url: '/api/sales/outbounds', data: params }),
  setOutboundFee: (id, fee) => request({ url: `/api/sales/outbounds/${id}/platform-fee`, method: 'POST', data: { platform_fee: fee } }),
  getSaleOrder: (id) => request({ url: `/api/sales/orders/${id}` }),
  matchSaleSku: (orderId, skuCode) =>
    request({ url: `/api/sales/orders/${orderId}/sku-match`, data: { sku_code: skuCode } }),
  manualDeal: (data) => request({ url: '/api/sales/manual-deal', method: 'POST', data }),
  saleShops: () => request({ url: '/api/sales/sale-shops' }),
  createPickupPayment: (data) => request({ url: '/api/sales/pickup-payment/create', method: 'POST', data }),
  pickupPaymentStatus: (outTradeNo) =>
    request({ url: `/api/sales/pickup-payment/${encodeURIComponent(outTradeNo)}/status` }),
  trackExpress: (no, options = {}) => {
    const refresh = options.refresh ? 'true' : 'false'
    const phone = (options.phone || '').replace(/\D/g, '').slice(0, 4)
    let url = `/api/express/track/${encodeURIComponent(no)}?refresh=${refresh}`
    if (phone) url += `&phone=${encodeURIComponent(phone)}`
    return request({ url })
  },
  dashboardSummary: () => request({ url: '/api/dashboard/summary' }),
  dashboardActivities: (params) => request({ url: '/api/dashboard/activities', data: params }),
  dashboardWorkload: () => request({ url: '/api/dashboard/workload' }),
  dashboardCommission: (params) => request({ url: '/api/dashboard/commission', data: params }),
  dashboardPayslip: (params) => request({ url: '/api/dashboard/payslip', data: params }),
  dashboardAdminStats: (params) => request({ url: '/api/dashboard/admin-stats', data: params }),
  listingFormConfigVersion: () => request({ url: '/api/listing/form-config/version' }),
  listingFormConfig: () => request({ url: '/api/listing/form-config' }),
  listPendingListing: () => request({ url: '/api/listing/pending' }),
  getListing: (code) => request({ url: `/api/listing/skus/${code}` }),
  saveListing: (code, data) => request({ url: `/api/listing/skus/${code}`, method: 'PUT', data }),
  publishShops: (code, data) => request({ url: `/api/listing/skus/${code}/publish`, method: 'POST', data: data || {} }),
  listingImageOptions: (code) => request({ url: `/api/listing/skus/${code}/image-options` }),
  // 上架图管理（各号用的图）
  listingImages: (code) => request({ url: `/api/listing/skus/${code}/listing-images` }),
  setShopImages: (code, shopId, images) => request({ url: `/api/listing/skus/${code}/shops/${shopId}/images`, method: 'PUT', data: { images } }),
  // 素材分池：一张候选图标淘汰（status: 'rejected'，要写原因）或改回可用（'usable'）
  setImageStatus: (code, url, status, reason) => request({ url: `/api/listing/skus/${code}/image-status`, method: 'PUT', data: { url, status, reason } }),
  // 上架审批（每件货每个号的价和图，批过才发）
  listingApprovalSettings: () => request({ url: '/api/listing-approvals/settings' }),
  saveListingApprovalSettings: (data) => request({ url: '/api/listing-approvals/settings', method: 'PUT', data }),
  listingApprovalTasks: (params) => request({ url: '/api/listing-approvals/tasks', data: params }),
  listingApprovalSku: (code) => request({ url: `/api/listing-approvals/skus/${encodeURIComponent(code)}` }),
  saveListingApprovalDraft: (code, shopId, data) => request({ url: `/api/listing-approvals/skus/${encodeURIComponent(code)}/shops/${shopId}`, method: 'PUT', data }),
  submitListingApproval: (code, shopIds) => request({ url: `/api/listing-approvals/skus/${encodeURIComponent(code)}/submit`, method: 'POST', data: { shop_ids: shopIds } }),
  reviewListingApproval: (code, data) => request({ url: `/api/listing-approvals/skus/${encodeURIComponent(code)}/review`, method: 'POST', data }),
  // 去闲鱼水印（补图在京东云跑，单张 3~8 秒，模型冷启动要多等十几秒）
  dewatermarkStatus: () => request({ url: '/api/dewatermark/status' }),
  dewatermarkImage: (url) => request({ url: '/api/dewatermark', method: 'POST', data: { url }, timeout: 90000 }),
  publishAll: (code) => request({ url: `/api/listing/skus/${code}/publish-all`, method: 'POST' }),
  delistShops: (code, data) => request({ url: `/api/listing/skus/${code}/delist`, method: 'POST', data: data || {} }),
  delistAll: (code) => request({ url: `/api/listing/skus/${code}/delist-all`, method: 'POST' }),
  listingShops: (code) => request({ url: `/api/listing/skus/${code}/shops` }),
  // 库龄和自动上架（链接焕新）管理
  skuStockAge: (code) => request({ url: `/api/listing/skus/${code}/stock-age` }),
  setSkuAutoRefresh: (code, data) => request({ url: `/api/listing/skus/${code}/auto-refresh`, method: 'PUT', data }),
  refreshSkuNow: (code, shopIds) =>
    request({ url: `/api/listing/skus/${code}/refresh-now`, method: 'POST', data: shopIds ? { shop_ids: shopIds } : {} }),
  setStockAgeThresholds: (data) => request({ url: '/api/listing/stock-age-thresholds', method: 'PUT', data }),
  // AI 按型号生成的主图(没有同款实拍图可参考):人看过点确认才上架,不对就补一句品类重新生成
  confirmAiImage: (code) => request({ url: `/api/listing/skus/${code}/ai-image/confirm`, method: 'POST' }),
  regenerateAiImage: (code, hint) =>
    request({ url: `/api/listing/skus/${code}/ai-image/regenerate`, method: 'POST', data: { hint: hint || '' } }),
  setShopWorryFree: (code, shopId, value) =>
    request({
      url: `/api/listing/skus/${code}/shops/${shopId}/worry-free`,
      method: 'PUT',
      data: { worry_free_sell: value },
    }),
  // 设备↔闲鱼账号 绑定(新群控;管理员)。ERP 代理 groupcontrol-server。
  gcBindShops: () => request({ url: '/api/gc-bind/shops' }),
  mcpInfo: () => request({ url: '/api/config/mcp-info' }),
  gcBindDevices: () => request({ url: '/api/gc-bind/devices' }),
  gcBind: (data) => request({ url: '/api/gc-bind/bind', method: 'POST', data }),
  listSwitch: (params) => request({ url: '/api/switch/orders', data: params }),
  getSwitch: (id) => request({ url: `/api/switch/orders/${id}` }),
  createSwitch: (data) => request({ url: '/api/switch/orders', method: 'POST', data }),
  switchDeposit: (id, data) => request({ url: `/api/switch/orders/${id}/deposit`, method: 'POST', data }),
  switchFinal: (id, data) => request({ url: `/api/switch/orders/${id}/final-payment`, method: 'POST', data }),
  switchApplyCutoff: (id, data) => request({ url: `/api/switch/orders/${id}/apply-cutoff`, method: 'POST', data }),
  switchCancel: (id) => request({ url: `/api/switch/orders/${id}/cancel`, method: 'POST' }),
  listNegotiationPending: (params) => request({ url: '/api/negotiation/pending', data: params }),
  getNegotiation: (code) => request({ url: `/api/negotiation/skus/${code}` }),
  submitNegotiation: (code, data) =>
    request({ url: `/api/negotiation/skus/${code}/submit`, method: 'POST', data }),
  listNegotiationHistory: (params) => request({ url: '/api/negotiation/history', data: params }),
  getNegotiationHistory: (code) => request({ url: `/api/negotiation/history/${code}` }),
  // 议价后「召回快递」补传环节
  listNegotiationRecallPending: (params) => request({ url: '/api/negotiation/recall-pending', data: params }),
  getNegotiationRecall: (code) => request({ url: `/api/negotiation/recall/${code}` }),
  submitNegotiationRecall: (code, data) =>
    request({ url: `/api/negotiation/skus/${code}/recall`, method: 'POST', data }),
  listLawsuits: (params) => request({ url: '/api/lawsuits', data: params }),
  getLawsuit: (id) => request({ url: `/api/lawsuits/${id}` }),
  createLawsuit: (data) => request({ url: '/api/lawsuits', method: 'POST', data }),
  updateLawsuit: (id, data) => request({ url: `/api/lawsuits/${id}`, method: 'PATCH', data }),
  deleteLawsuit: (id) => request({ url: `/api/lawsuits/${id}`, method: 'DELETE' }),

  listReturns: (params) => request({ url: '/api/returns', data: params }),
  createReturn: (data) => request({ url: '/api/returns', method: 'POST', data }),
  receiveReturn: (id, data) => request({ url: `/api/returns/${id}/receive`, method: 'POST', data }),
  resolveReturn: (id, data) => request({ url: `/api/returns/${id}/resolve`, method: 'POST', data }),
  returnToInbound: (id) => request({ url: `/api/returns/${id}/to-inbound`, method: 'POST' }),
  financeStats: (params) => request({ url: '/api/finance/stats', data: params }),
  financePurchaseDetails: (params) => request({ url: '/api/finance/purchase-details', data: params }),
  financeSalesDetails: (params) => request({ url: '/api/finance/sales-details', data: params }),

  // 货号更换（旧货号 → 51321154 新货号）
  listSkuMigration: (params) => request({ url: '/api/inventory/sku-migration/items', data: params }),
  recodeSkuMigration: (data) => request({ url: '/api/inventory/sku-migration/recode', method: 'POST', data }),
  listBarcodeMigration: (params) => request({ url: '/api/inventory/barcode-migration/items', data: params }),
  recodeBarcodeMigration: (data) => request({ url: '/api/inventory/barcode-migration/recode', method: 'POST', data }),
  // 库存缺口总览：在库没在卖的货还缺什么（认不出型号/缺价/缺图/低于成本/待上架）
  listStockGaps: (params) => request({ url: '/api/stock-gaps', data: params }),
  getStockGapSettings: () => request({ url: '/api/stock-gaps/settings' }),
  saveStockGapSettings: (data) => request({ url: '/api/stock-gaps/settings', method: 'PUT', data }),
  // 商品匹配：一件货对照候选 SPU 确认 / 报找不到 / 管理员验收（退回带原因 + 附件）
  listSpuMatch: (params) => request({ url: '/api/spu-match/items', data: params }),
  getSpuMatch: (code) => request({ url: `/api/spu-match/skus/${encodeURIComponent(code)}` }),
  searchSpu: (q) => request({ url: '/api/spu-match/search', data: { q } }),
  submitSpuMatch: (code, data) => request({ url: `/api/spu-match/skus/${encodeURIComponent(code)}/submit`, method: 'POST', data }),
  reportSpuMatch: (code, data) => request({ url: `/api/spu-match/skus/${encodeURIComponent(code)}/report`, method: 'POST', data }),
  reviewSpuMatch: (code, data) => request({ url: `/api/spu-match/skus/${encodeURIComponent(code)}/review`, method: 'POST', data }),

  // 匿名反馈
  createAnonymousFeedback: (data) => request({ url: '/api/feedback/anonymous', method: 'POST', data }),

  // 资产管理（仅管理员）
  listAssets: (params) => request({ url: '/api/asset/devices', data: params }),
  getAsset: (id) => request({ url: `/api/asset/devices/${id}` }),
  checkAssetNo: (params) => request({ url: '/api/asset/devices/check-no', data: params }),
  createAsset: (data) => request({ url: '/api/asset/devices', method: 'POST', data }),
  updateAsset: (id, data) => request({ url: `/api/asset/devices/${id}`, method: 'PUT', data }),
  deleteAsset: (id) => request({ url: `/api/asset/devices/${id}`, method: 'DELETE' }),

  // 资产录入（所有员工）：别的系统里的电脑、显示器录成在库商品，录完进待上架
  listAssetIntakes: (params) => request({ url: '/api/asset-intake', data: params }),
  getAssetIntake: (code) => request({ url: `/api/asset-intake/${code}` }),
  createAssetIntake: (data) => request({ url: '/api/asset-intake', method: 'POST', data }),
  updateAssetIntake: (code, data) => request({ url: `/api/asset-intake/${code}`, method: 'PUT', data }),

  // 手机号管理（仅管理员）
  listPhones: (params) => request({ url: '/api/phone/numbers', data: params }),
  getPhone: (id) => request({ url: `/api/phone/numbers/${id}` }),
  createPhone: (data) => request({ url: '/api/phone/numbers', method: 'POST', data }),
  updatePhone: (id, data) => request({ url: `/api/phone/numbers/${id}`, method: 'PUT', data }),
  deletePhone: (id) => request({ url: `/api/phone/numbers/${id}`, method: 'DELETE' }),

  // 群控账号档案(初始化:自动采集 SN/IMEI/手机号/会员名,员工补全运营商/套餐/法人等)
  listAccountProfiles: (params) => request({ url: '/api/account-profiles', data: params }),
  getAccountProfile: (id) => request({ url: `/api/account-profiles/${id}` }),
  updateAccountProfile: (id, data) => request({ url: `/api/account-profiles/${id}`, method: 'PUT', data }),
  syncAccountProfiles: () => request({ url: '/api/account-profiles/sync', method: 'POST' }),

  // 群控运维:设备列表 / 任务队列(ERP 代理 groupcontrol-server)
  gcOpsDevices: () => request({ url: '/api/gc-ops/devices' }),
  gcOpsAccountListings: (accountId) => request({ url: `/api/gc-ops/accounts/${accountId}/listings` }),
  gcOpsTasks: (params) => request({ url: '/api/gc-ops/tasks', data: params }),
  gcOpsTask: (id) => request({ url: `/api/gc-ops/tasks/${id}` }),
  gcOpsDeviceRestart: (id) => request({ url: `/api/gc-ops/devices/${id}/restart`, method: 'POST' }),
  gcOpsDeviceSelfCheck: (id) => request({ url: `/api/gc-ops/devices/${id}/self-check`, method: 'POST' }),
  gcOpsDeviceToggle: (id, status) =>
    request({ url: `/api/gc-ops/devices/${id}`, method: 'PATCH', data: { status } }),
  gcOpsTaskRetry: (id) => request({ url: `/api/gc-ops/tasks/${id}/retry`, method: 'POST' }),

  // 聚合聊天:会话、消息、回复直连群控(nginx /gc/ → groupcontrol-server);货和实拍在 ERP
  gcChatConversation: (id) => request({ url: `/gc/chat/conversations/${id}` }),
  gcChatMessages: (id, params) => request({ url: `/gc/chat/conversations/${id}/messages`, data: params }),
  gcChatMarkRead: (id) => request({ url: `/gc/chat/conversations/${id}/read`, method: 'POST' }),
  // body: { text } 或 { media: [{ type: 'image' | 'video', url }] }(只发图片视频,不带文字)
  gcChatReply: (id, body) => request({ url: `/gc/chat/conversations/${id}/reply`, method: 'POST', data: body }),
  // 回了买家：这个会话上开着的协同请求自动关（没人点「我来接」直接回的也算）
  collabReplied: (id) => request({ url: `/api/sales-workbench/collab/replied/${encodeURIComponent(id)}`, method: 'POST' }),
  gcChatResolveItem: (url) => request({ url: '/gc/chat/resolve-item', data: { url } }),
  // SKU 槽:{ sku } 按这件货找同款,或 { q } 按货号 / 上架编码 / 型号找
  chatSkuSlots: (params) => request({ url: '/api/chat-assist/slots', data: params }),
  chatSkuMedia: (skuCode) => request({ url: `/api/chat-assist/skus/${encodeURIComponent(skuCode)}/media` }),
  skuPriceHistory: (code) => request({ url: `/api/inventory/skus/${encodeURIComponent(code)}/price-history` }),
  setPickupAddress: (text) => request({ url: '/api/chat-assist/pickup-address', method: 'PUT', data: { text } }),
}
