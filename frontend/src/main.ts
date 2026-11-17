import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { initTheme } from './composables/useTheme'
import router from './router'
import './styles/tokens.css'

// 应用入口：Pinia 状态容器 + hash 路由 + 设计 token 样式。
// 主题在挂载前从 localStorage 同步到 DOM / meta，避免首帧闪浅纸。
initTheme()
const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
