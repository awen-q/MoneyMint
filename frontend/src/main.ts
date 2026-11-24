import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { initTheme } from './composables/useTheme'
import router from './router'
import { readLedgerId } from './core/storage'
import { initLocale } from './i18n'
import { checkAndReload } from './stores/dataFreshness'
import './styles/tokens.css'

// 应用入口：Pinia 状态容器 + hash 路由 + 设计 token 样式。
// 主题在挂载前按持久化偏好（跟随系统 / 浅纸 / 夜纸）同步到 DOM / meta；
// index.html 的内联脚本已先行按同一套口径预设，避免暗色用户冷启动闪浅纸。
initTheme()
// 语言初始化（i18n 阶段 0）：localStorage 合法持久值 → navigator.language 检测
// → 异常兜底 zh-CN；随后接管 document.title（index.html 的中文 title 是 JS 未执行兜底）。
// 检测只允许发生在这里——i18n 模块单例的初始值恒为 'zh-CN'，测试环境不调用本函数。
initLocale()
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
