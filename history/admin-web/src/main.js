import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import './styles/global.css'
import { setupResizableTables } from './plugins/table-defaults.js'
import App from './App.vue'
import router from './router'

setupResizableTables()

createApp(App).use(ElementPlus).use(router).mount('#app')
