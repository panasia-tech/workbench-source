/**
 * 小程序运行环境
 * - dev: 开发环境（开发者工具），每次启动账号密码登录，不调用 wx.login
 * - test: 测试/正式环境，微信静默登录，首次绑定 openid
 *
 * 默认按微信 envVersion 自动判断；需要时可设置 ENV_OVERRIDE 强制指定。
 */
const ENV_OVERRIDE = 'test'

function detectEnv() {
  if (ENV_OVERRIDE === 'dev' || ENV_OVERRIDE === 'test') {
    return ENV_OVERRIDE
  }
  try {
    const { miniProgram } = wx.getAccountInfoSync()
    // develop=开发版 trial=体验版 release=正式版
    if (miniProgram.envVersion === 'develop') return 'dev'
    return 'test'
  } catch (e) {
    return 'dev'
  }
}

const ENV = detectEnv()

module.exports = {
  ENV,
  isDev: ENV === 'dev',
  isTest: ENV === 'test',
}
