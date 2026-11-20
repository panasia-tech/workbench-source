/** 游客 Cookie 获取 · 用户提示（渲染进程与 Electron 主进程共用） */

export const GUEST_COOKIE_AUTH_WINDOW_TITLE = '获取游客登录状态'

export const GUEST_COOKIE_AUTH_BANNER_MAIN =
  '正在获取游客登录状态：请等下方闲鱼页加载完成，不用登录账号。'

export const GUEST_COOKIE_AUTH_BANNER_SUB =
  '首页加载好后会自动保存并关闭本窗口，请稍等，不要手动关窗。'

export const GUEST_COOKIE_AUTH_NOTIFY_OPENING =
  '正在打开闲鱼页获取游客登录状态，请等页面加载完成，无需登录。'

export const GUEST_COOKIE_AUTH_NOTIFY_HINT =
  '已打开闲鱼页：等首页加载完会自动保存并关窗，请稍等。'

export const GUEST_COOKIE_AUTH_MODAL_INTRO =
  '点「游客授权」会打开闲鱼页。首页加载完成后会自动保存并关窗，您无需登录淘宝账号。'

export const GUEST_COOKIE_AUTH_MODAL_STEPS = [
  '① 点「游客授权」会打开闲鱼网页',
  '② 等首页加载完成，不用登录账号',
  '③ 软件会自动保存并关闭窗口，请稍等'
]

export const GUEST_COOKIE_AUTH_DIALOG_TITLE = '需要先获取游客登录状态'

export const GUEST_COOKIE_AUTH_DIALOG_CONTENT =
  '还没有可用的游客登录状态。点「去获取」后会打开闲鱼页，等首页加载完会自动保存，不必登录账号。'

export const GUEST_COOKIE_AUTH_TIMEOUT_MSG =
  '获取超时：请确认闲鱼页已加载完成，再点一次「游客授权」重试。'
