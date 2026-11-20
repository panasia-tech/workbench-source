// https://trade.jd.com/


/**
 * 京东规则配置 - 按域名区分
 * jd.com（大陆）、jd.hk（香港）
 *
 * checkoutType: 下单流程类型
 * - 'popup': 详情页弹窗下单（jd.com）
 * - 'redirect': 跳转到新页面下单（jd.hk）
 */

export const jdRule = {
  'jd.com': {
    checkoutType: 'popup', // 详情页弹窗下单
    // 仅用于点击「立即购买」后的快速探测（须保持少量、可见性可靠；宽 iframe 匹配勿放这里，否则会拖慢 tryClickBuy）
    popup: ['.settlement-lite-popup', '#settlement-lite iframe[src*="settlement-lite"]', 'iframe[src*="pf.jd.com"]'],
    buy: [
      '#choose-btns .newcomer-now-buy',
      '#choose-btns >> text=立即购买',
      '#choose-btns #bottom-btns div.first-row >> text=立即购买',
      '#bottom-btns .bottom-btns-root > div:has(.first-row >> text=立即购买)',
      '#bottom-btns div.first-row:has-text("立即购买")',
      '#bottom-btns >> text=立即购买',
      // 勿单独 div:not(#add-to-cart)：易命中非购买列（客服/店铺等）导致误点
      '#bottom-btns .bottom-btns-root > div:not(#add-to-cart):has-text("立即购买")',
      '#bottom-btns .bottom-btns-root > div:has-text("立即购买")',
      '#InitTradeUrl',
    ],
    // 先 button/a/支付区（trade.jd.com PC 结算快）；再 div 文案（弹窗/H5）
    create: [
      'button:has-text("提交订单")',
      'a:has-text("提交订单")',
      '[class*="submit"]:has-text("提交订单")',
      '.payment-action-submit button',
      '.payment-action .payment-action-submit button',
      'button.btn-primary.btn-large',
      '.payment-action-submit .btn-primary',
      'button:has-text("立即支付")',
      'a:has-text("立即支付")',
      '[class*="submit"]:has-text("立即支付")',
      'div.first-row:has-text("提交订单")',
      'div.first-row:has-text("立即支付")',
      'div:has-text("立即支付")',
      'div:has-text("确认订单并支付")',
      'div:has-text("确认并支付")',
      'div:has-text("去结算")',
      'div:has-text("去支付")',
      '[class*="submitOrder"] div:has-text("立即支付")',
      '[class*="submitOrder"] div:has-text("确认订单并支付")',
      '[class*="submit-"]:has-text("立即支付")',
      '[class*="submit-"]:has-text("确认订单并支付")',
    ],
  },
  'jd.hk': {
    checkoutType: 'redirect', // 跳转页面下单
    buy: [
      '#choose-btns .newcomer-now-buy',
      '#choose-btns >> text=立即购买',
      '#choose-btns #bottom-btns div.first-row >> text=立即购买',
      '#bottom-btns .bottom-btns-root > div:has(.first-row >> text=立即购买)',
      '#bottom-btns div.first-row:has-text("立即购买")',
      '#bottom-btns >> text=立即购买',
      '#bottom-btns .bottom-btns-root > div:not(#add-to-cart):has-text("立即购买")',
      '#bottom-btns .bottom-btns-root > div:has-text("立即购买")',
      '#InitTradeUrl',
    ],
    create: [
      'button:has-text("提交订单")',
      'a:has-text("提交订单")',
      '[class*="submit"]:has-text("提交订单")',
      '.payment-action-submit button',
      '.payment-action .payment-action-submit button',
      'button.btn-primary.btn-large',
      '.payment-action-submit .btn-primary',
    ],
  },
}
