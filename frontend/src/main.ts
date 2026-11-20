import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { initTheme } from './composables/useTheme'
import router from './router'
import { readLedgerId } from './core/storage'
import { checkAndReload } from './stores/dataFreshness'
import './styles/tokens.css'

// 应用入口：Pinia 状态容器 + hash 路由 + 设计 token 样式。
// 主题在挂载前从 localStorage 同步到 DOM / meta，避免首帧闪浅纸。
initTheme()
const app = createApp(App)
app.use(createPinia())
app.use(router)

// 页面激活补偿：后台回前台（visibilitychange）与桌面切回窗口（focus）
// 各查一次全局脏标记；后台被节流/错过广播时据此补拉。与 startAutoSync
// 的 visibilitychange 并存、各管各的：那边触发同步，这边只检查快照水位。
const onActivate = (): void => {
  if (typeof document === 'undefined' || document.visibilityState === 'visible') {
    checkAndReload(readLedgerId())
  }
}
document.addEventListener('visibilitychange', onActivate)
window.addEventListener('focus', onActivate)

app.mount('#app')
