/** 闲鱼主站（Playwright 采集游客 _m_h5_tk 等） */
export const GOOFISH_HOME_URL = 'https://www.goofish.com/'

/** 窗口登录起始页：闲鱼 PC 主页（一键登录 / 重新登录 / Playwright 账号采集） */
export const GOOFISH_WINDOW_LOGIN_URL = GOOFISH_HOME_URL

/** 历史 H5 消息页（旧版窗口登录；站点跳转或旧分区仍可能命中） */
export const GOOFISH_LEGACY_H5_MESSAGE_LOGIN_URL =
  'https://h5.m.goofish.com/app/idleFish-F2e/fish-mini-pha/message.html'

/** @param {string} url */
export function isGoofishWindowLoginPageUrl(url) {
  try {
    const u = new URL(String(url || '').trim())
    if (u.hostname !== 'h5.m.goofish.com') return false
    return /message\.html/i.test(u.pathname)
  } catch {
    return false
  }
}

/** 一键登录 / 定时批量登录：开窗后在此时间内未自动完成登录则关窗，不写凭证 */
export const GOOFISH_BATCH_LOGIN_AUTO_CLOSE_MS = 6000

/** 检测过期：批量打开各账号闲鱼主页，此毫秒后自动关窗并落盘（与手动关窗一致） */
export const GOOFISH_VERIFY_AUTO_CLOSE_MS = 3000

/** 嵌入模式默认：鱼小铺卖家工作台 */
export const GOOFISH_SELLER_URL = 'https://seller.goofish.com/'

/** 鱼小铺消息中台 */
export const GOOFISH_IM_URL = 'https://seller.goofish.com/?site=COMMONPRO#/im'

/** 闲鱼主站消息（非鱼小铺） */
export const GOOFISH_IM_PUBLIC_URL = 'https://www.goofish.com/im'

/** 闲鱼收货地址列表（秒拍「添加地址」开窗） */
export const GOOFISH_DELIVER_ADDRESS_URL =
  'https://h5.m.goofish.com/ww/idle/address/list.htm'
