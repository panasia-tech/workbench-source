import { createApp } from 'vue'
import ElementPlus, { ElMessage } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
// 页框工具类：整页不滚、内容自己滚。用法与三条规矩见文件头。
import './assets/page.css'
import * as Icons from '@element-plus/icons-vue'
import App from './App.vue'
import router from './router.js'

const app = createApp(App)
app.use(ElementPlus, { locale: zhCn })
for (const [name, comp] of Object.entries(Icons)) app.component(name, comp)
app.use(router)

// 主进程收到 401 会推 auth:expired；这里统一清掉当前页并回登录页。
// 不依赖某个页面自己 catch：消息聚合台、设备页、任务页都会触发同一条路径。
if (window.erp?.onAuthExpired) {
  window.erp.onAuthExpired(({ detail } = {}) => {
    ElMessage.warning(detail || '登录已过期，请重新登录')
    if (router.currentRoute.value.path !== '/login') router.replace('/login')
  })
}

app.mount('#app')
