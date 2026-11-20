// 大台账：单独的手机页面（/console/ledger.html），不进后台的路由和菜单。
// 业务员也会用，所以登录走 H5 登录（/api/auth/h5-login），令牌单独存，不和后台的混。
import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import LedgerApp from './LedgerApp.vue'

createApp(LedgerApp).use(ElementPlus, { locale: zhCn }).mount('#app')
