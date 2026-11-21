import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import legacy from '@vitejs/plugin-legacy'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

const FRONTEND_ROOT = fileURLToPath(new URL('.', import.meta.url))

// 从 package.json 读取版本号并注入到前端（顶部版本标识用）。
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string }

/**
 * 构建元数据（短提交号 + 构建日期）：只用于报 bug 时定位构建，
 * 不是版本事实源——版本号三处一致性仍由 scripts/verify-version.sh 守门。
 * Docker 构建上下文排除了 .git，取不到时降级为 unknown，不影响构建。
 */
function buildHash(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: FRONTEND_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

const buildDate = new Date().toISOString().slice(0, 10)

// Vite 配置：入口为 frontend/index.html，产物输出到 frontend/dist。
// base 用相对路径，方便反代到任意子路径；legacy 兜底 Safari 14。
export default defineConfig({
  base: './',
  plugins: [
    vue(),
    legacy({
      targets: ['Safari >= 14'],
      // 不生成旧浏览器 chunk（现代构建本身已降到 es2015），只补现代浏览器缺失的 polyfill。
      renderLegacyChunks: false,
      modernPolyfills: true,
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_BUILD_HASH__: JSON.stringify(buildHash()),
    __APP_BUILD_DATE__: JSON.stringify(buildDate),
  },
  build: {
    // 注意：不能输出到 ../web（那是 Flutter 源目录），统一落在 frontend/dist。
    // Vite 的 root 是 frontend/，此处写 'dist' 即计划里的 frontend/dist；
    // 若照字面写 '../dist' 会落到仓库根目录（与后端二进制目录冲突）。
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2015',
    rollupOptions: {
      output: {
        // echarts 与 zrender 合并成**一个**确定性命名的 chunk：
        // ①不给 Rollup 自由拆成 2~3 片的机会（否则三页各拉一次碎片）；
        // ②账单/统计/资产统计三页共享同一份缓存，第二页不再重复下载；
        // ③命名固定含 "echarts"，供 scripts/check-bundle-size.mjs 定位与门禁。
        // 注意：不能用 legacy- / polyfills- 前缀（scripts/compat.mjs 会跳过该前缀，
        // 等于让兼容扫描对 echarts 形同虚设）。
        // 刻意**不**把 tslib 并进来：目前只有 echarts/zrender 声明它，无害；但将来任何
        // 模块静态 import 'tslib'，就会被迫连带下载整个 echarts chunk（约 174 KB），
        // 而「单块 + 总量」两条门禁恰好都查不出这种搭车。
        manualChunks(id: string) {
          if (/[\\/]node_modules[\\/](echarts|zrender)[\\/]/.test(id)) {
            return 'echarts'
          }
          return undefined
        },
      },
    },
  },
  server: {
    proxy: {
      // 开发期跨域：前端始终请求相对 /api，由 Vite 转发到后端。
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 把 `[Vue warn]` 从噪音提升为失败（见 setupVueWarn.ts 的三条约束说明）。
    setupFiles: ['./src/test/setupVueWarn.ts'],
    // 部分平台下多 worker 并发写 vite-node 的 SSR 临时缓存会触发 EPERM，
    // 导致部分测试文件加载失败；顺序执行测试文件即可稳定全绿。
    fileParallelism: false,
  },
})
