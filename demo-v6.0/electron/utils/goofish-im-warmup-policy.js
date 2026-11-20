/**
 * 私聊 WebSocket 预热策略（主进程读环境变量，勿加 VITE_ 前缀）。
 *
 * - XIANYU_GOOFISH_IM_BOOT_WARMUP：启动后是否逐个账号握手（默认 0 关闭）
 * - XIANYU_GOOFISH_IM_AUTO_WARMUP：登录落盘、嵌入消息页等自动预热（默认 0 关闭）
 *   验证关窗后的私聊重连不受此开关限制；手动仍可用：账号页点「连接私聊」、任务里开打招呼
 */

export function isGoofishImBootRealtimeWarmupEnabled() {
  const v = String(process.env.XIANYU_GOOFISH_IM_BOOT_WARMUP ?? '0').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'off'
}

export function isGoofishImAutoWarmupEnabled() {
  const v = String(process.env.XIANYU_GOOFISH_IM_AUTO_WARMUP ?? '0').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on'
}

/** 是否同步到 persist:xianyu_sxjk_<账号id>（独立闲鱼窗口用）；默认关，嵌入只用 embed_shared */
export function isGoofishPerAccountListingPartitionSyncEnabled() {
  const v = String(process.env.XIANYU_GOOFISH_LISTING_PARTITION_SYNC ?? '0').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on'
}
