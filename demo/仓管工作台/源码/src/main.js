import { createApp } from 'vue'
import './styles/style.css'
import './styles/stitch.css'
import App from './App.vue'
import { bootstrapBackend } from './store/warehouseStore.js'

createApp(App).mount('#app')
bootstrapBackend()
