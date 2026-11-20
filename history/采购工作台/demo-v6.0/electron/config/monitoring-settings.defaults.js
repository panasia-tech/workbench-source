/**
 * 监控运行时默认配置（安装包内置）
 * 用户可改数据目录下的 monitoring-settings.js（module.exports）覆盖其中任意字段
 */

export default {
  /** 新建监控任务时，若未指定轮询间隔则使用此值（毫秒） */
  defaultPollIntervalMs: 60 * 1000,

  /** 轮询间隔允许的最小值（毫秒），过小易触发风控或被封 */
  minPollIntervalMs: 500,

  /** 轮询间隔允许的最大值（毫秒） */
  maxPollIntervalMs: 10 * 60 * 1000,

  /**
   * 每次安排「下一次刷新」时，在任务配置的 pollInterval 基础上随机加减的范围（毫秒）
   * 例如 5000 表示实际等待时间在 [基准-5s, 基准+5s] 内随机；设为 0 则不做抖动
   */
  pollJitterMs: 5000,

  /** 新建监控时默认购买数量 */
  defaultPurchaseQuantity: 1,

  /** 购买数量下限 */
  minPurchaseQuantity: 1,

  /** 购买数量上限 */
  maxPurchaseQuantity: 200,

  /**
   * 页面 framenavigated 防抖：合并短时间内的多次导航再处理（毫秒）
   */
  navDebounceMs: 500,

  /**
   * 同 URL 在多久内不重复执行 handlePageLoad（毫秒），避免一次刷新触发多次逻辑
   */
  navDedupMs: 3000,

  /**
   * 是否优先使用系统已安装的 Chrome 启动监控浏览器
   * true 时使用 channel: 'chrome'（Playwright 查找 /Applications/Google Chrome.app）
   * 若 Playwright 找不到（如 Chrome 在 ~/Applications），可设置 chromeExecutablePath 指定路径
   */
  useSystemChrome: false,

  /**
   * Chrome 可执行文件完整路径；仅当 useSystemChrome 为 true 且 Playwright 自检失败时使用
   * macOS 常见路径：'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
   * 若 Chrome 在用户目录：'/Users/你的用户名/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
   */
  chromeExecutablePath: '',

  /**
   * 刷新页面前是否模拟真人操作（随机滚动、偶尔点击），用于弱化机械性行为特征
   * true 时每次刷新前随机滚动页面并约 30% 概率点击「评价」「规格」等 tab
   */
  simulateHumanBehaviorBeforeRefresh: true,

  /**
   * 轮询时若已在当前监控对应的商品详情页，是否跳过整页刷新（location reload）
   * false（默认）：每次轮询整页刷新，重新拉页面与库存接口，便于反复确认「有没有货」（推荐）
   * true：不 reload，仅再跑页面检测逻辑；一般不用于「要看最新库存」的场景
   */
  softPollOnItemPage: false
}
