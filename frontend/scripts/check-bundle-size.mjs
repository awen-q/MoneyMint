/**
 * 构建物体积门禁。
 *
 * 为什么需要它：check-test-floor 只防「用例数假绿」，防不住「悄悄引了 1MB 库」。
 * ECharts 全量产物 raw 1,030,855 B / gzip 333,290 B，是引入前全站 JS（raw 502,235 B）
 * 的两倍多。走 echarts/core 按需 + 动态 import 后应压到 gzip 105~160 KB，
 * 这个脚本把「应」变成「必须」。
 *
 * 四条断言的分工：
 *  - echarts chunk 单块 ≤ 190KB gzip：防止有人 `import 'echarts'` 全量，或顺手注册
 *    CanvasRenderer/DatasetComponent 把体积撑回去。
 *  - 全站 JS gzip 总和 ≤ 420KB：防止「没超标但一路加」的温水式膨胀。
 *  - **echarts chunk 不可从入口静态到达**：防懒加载失效（首屏白拉约 174KB）。
 *  - **echarts 特征串必须恰好命中 1 个 chunk**：防 manualChunks 失效导致代码被拆散
 *    或并进主包，也防「检测手段本身失效」时静默放行（后者是最危险的一种绿）。
 *
 * 为什么用 `_echarts_instance_` 而不是 `zrender` / `echarts` / 版本号做特征串：
 *  - `zrender` 那 1 次命中来自 license banner 注释，打开 `legalComments:'none'` 后归零
 *    → 断言会永久变绿，正是要避免的假绿；
 *  - `echarts` 在**入口 chunk** 的 `__vite__mapDeps` 依赖数组里天然出现（`m.f=[...]`），
 *    会误报；
 *  - 版本号 `5.6.0` 被 tree-shake 掉，实测 0 次。
 *  `_echarts_instance_` 是 `init()` 写进容器 DOM 的属性名常量，实测
 *  echarts chunk = 1、入口 = 0，且 `legalComments:'none'` 下仍是 1。
 *
 * 零新依赖：只用 node 内置 zlib / fs / path / os。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

/**
 * echarts chunk gzip 上限（KB）。
 *
 * 2026-11-19 实测（真实 vite build + manualChunks，薄 register + 静态具名导入，
 * 3 图 + Grid + Tooltip + SVGRenderer）：**169.3 KB**（zlib level 9；vite 自报 173.67）。
 * 改造前走 barrel 动态 import 是 336.19 KB —— 差异全部来自 barrel 不可 tree-shake。
 * 上限按「实测 169.3 + 约 12% 余量」定为 190 KB。再加图表类型必须重新实测
 * 并显式上调，不许拿余量硬塞。
 */
const ECHARTS_GZIP_LIMIT_KB = 190

/**
 * 全站 JS gzip 总和上限（KB）= 引入 ECharts 前的基线 + echarts chunk + 余量。
 * 基线 2026-11-19 实测：dist/assets/*.js gzip 合计 181.6 KB（raw 492.6 KB）。
 * 加上 echarts chunk（实测 169.3 KB）≈ 351 KB，余量放到 420 KB。
 * 每次有意引入新依赖时必须同步上调此值，并在 PR 说明里写清新基线。
 */
const TOTAL_GZIP_LIMIT_KB = 420

/**
 * echarts 特征串：`init()` 写进容器 DOM 的属性名常量（DOM_ATTRIBUTE_KEY）。
 * 比 `zrender`（只出现在 license banner 注释里）稳定，且不会像 `echarts`
 * 那样被 `__vite__mapDeps` 的依赖数组误报。
 */
const ECHARTS_MARKER = '_echarts_instance_'

/** 只匹配**静态** import 边：`from"./x.js"` 与 `import"./x.js"`；不匹配 `import("./x.js")`。 */
const STATIC_EDGE_RE = /(?:from|import)\s*["'](\.\/[^"']+\.js)["']/g

/** 入口脚本：`<script type="module" src="...">`。属性顺序不固定，故分两步匹配。 */
const SCRIPT_TAG_RE = /<script\b[^>]*>/g

const KB = 1024

/**
 * 从 index.html 取出入口 chunk 文件名。
 *
 * @param {string} html index.html 文本
 * @returns {string[]} assets 目录内的文件名（去掉 `./assets/` 之类前缀）
 */
export function parseEntryScripts(html) {
  const names = []
  for (const [tag] of html.matchAll(SCRIPT_TAG_RE)) {
    if (!/\btype\s*=\s*["']module["']/.test(tag)) continue
    const src = /\bsrc\s*=\s*["']([^"']+)["']/.exec(tag)
    if (!src) continue
    names.push(path.basename(src[1]))
  }
  return names
}

/**
 * 从入口出发只沿**静态** import 边遍历，返回可达集合**与缺失文件清单**。
 *
 * 判据原理（两种产物形态）：
 *  - 坏：入口里出现 `}from"./echarts-xxx.js"` / `import"./echarts-xxx.js"`；
 *  - 好：入口里只有 `m.f=["assets/reg-...js","assets/echarts-...js"]` 这种纯字符串数组，
 *    真正的静态边在 `reg-*.js` 里（懒 chunk 依赖 echarts chunk 是正常且必要的）。
 *
 * ⚠️ 两条都不能省：
 * 1. **缺失文件不进 `reachable`**。早先版本先 `seen.add` 再 `existsSync` 后 `continue`，
 *    于是入口文件名进了可达集合却从未被读过 → 不产生任何静态边 →
 *    「不可静态到达」断言打印 ✓。**入口 chunk 缺失 = 门禁绿**，比 mtime 陈旧更隐蔽：
 *    它不需要任何时间假设，只要 `index.html` 与 `assets` 版本不一致就能触发。
 * 2. **缺失必须作为信号返回给调用方去 fail**。只把名字从 `reachable` 里剔掉是无效加固：
 *    调用方判据是 `reachable.has(echartsChunk.name)`，剔掉之后结论仍是 `false` → 照样绿。
 *
 * 不变式（谁改这段都要守住）：`reachable` **只**包含「真实读到过内容」的文件；
 * 调用方在 `missing` 非空时**不得**使用 `reachable`（现实现用 `else` 跳过判定）。
 * 两条同时成立才安全 —— 只做其中一条，缺的那条会在将来某次「顺手简化」时重新变成假绿。
 *
 * @param {string} assetsDir 产物 assets 目录
 * @param {string[]} roots 入口 chunk 文件名
 * @returns {{reachable: Set<string>, missing: string[]}} 静态可达集合（只含真实读过的文件） + 缺失文件名
 */
export function staticReachable(assetsDir, roots) {
  const seen = new Set()
  const missing = []
  const stack = [...roots]
  while (stack.length > 0) {
    const name = stack.pop()
    if (name === undefined || seen.has(name)) continue
    const file = path.join(assetsDir, name)
    if (!existsSync(file)) {
      // 缺失：单独记账，不进 reachable —— 让返回值本身诚实，
      // 避免将来有调用方把「没读过」误当成「没有这条边」。
      if (missing.indexOf(name) < 0) missing.push(name)
      continue
    }
    seen.add(name)
    const code = readFileSync(file, 'utf8')
    for (const match of code.matchAll(STATIC_EDGE_RE)) {
      stack.push(path.basename(match[1]))
    }
  }
  return { reachable: seen, missing }
}

/**
 * 可达性判定（纯函数）。
 *
 * 为什么把它抽出来：不变式是**合取式** ——
 *   ① `reachable` 只含真实读过的文件（`staticReachable` 保证）；
 *   ② 调用方在 `missing` 非空时不得使用 `reachable`。
 * 第 ② 半原先只活在 `main()` 的 `else` 里，而 `selfCheckRules()` 只测导出函数、
 * 不跑 `main()` → 谁把 `else` 拆掉、恢复「无条件算 leaked」，自检全绿、JSDoc 也不报警。
 * 抽成纯函数后，两半都能被自检钉住；`main()` 退化为纯 I/O + 打印（文案属呈现层，留在这里）。
 *
 * @param {{reachable: Set<string>, missing: string[]}} traversal `staticReachable` 的返回值
 * @param {string} echartsChunkName echarts chunk 文件名
 * @returns {{status: 'incomplete' | 'leaked' | 'ok'}} 判定结果
 */
export function reachabilityVerdict(traversal, echartsChunkName) {
  const { reachable, missing } = traversal
  // 产物不完整优先于一切：此时 `reachable.has(...)` 的结论没有意义，
  // 哪怕它恰好是 true（leaked）也不能据此下判断。
  if (missing.length > 0) return { status: 'incomplete' }
  return { status: reachable.has(echartsChunkName) ? 'leaked' : 'ok' }
}

/**
 * 图表消费者：`src/views` 与 `src/components` 下引用了 charts/ 的 .vue 文件。
 *
 * 为什么要它：没有消费者时缺 echarts chunk 是正常的（页面尚未接入）；
 * 有消费者却缺 chunk，说明懒加载失效或 chunk 被并进主包 —— 必须 fail。
 * 图表组件自身（src/components/charts/）不算消费者，它们本来就是图表实现。
 *
 * @param {string} root frontend 根目录
 * @returns {string[]} 相对 root 的消费者路径（POSIX 分隔符）
 */
export function findChartConsumers(root) {
  const chartDir = path.join(root, 'src', 'components', 'charts')
  const consumerRe = /(?:components|core)\/charts\//
  const consumers = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (name.endsWith('.vue') && !full.startsWith(chartDir + path.sep)) {
        if (consumerRe.test(readFileSync(full, 'utf8'))) {
          consumers.push(path.relative(root, full).split(path.sep).join('/'))
        }
      }
    }
  }
  walk(path.join(root, 'src', 'views'))
  walk(path.join(root, 'src', 'components'))
  return consumers
}

function fail(message) {
  console.error(`\n[check-bundle-size] ✗ ${message}\n`)
  process.exit(1)
}

const fmt = (bytes) => `${(bytes / KB).toFixed(1)} KB`

/**
 * 规则自检：用**合成产物**验证断言真的会触发，防止「规则写错 = 永久假绿灯」。
 *
 * 合成产物长这样（在临时目录里建、验完即删）：
 *   entry.js  ──静态──▶ lazy.js  ──静态──▶ payload.js
 *   dyn.js    ──动态──▶ payload.js（`import("./payload.js")`，不应被算作静态边）
 *   broken.js ──静态──▶ ghost.js（文件不存在，必须被记进 missing 而不是静默跳过）
 * 断言：能找到 payload（经 lazy 静态边）、dyn 不带出 payload、
 *      broken 的 ghost 出现在 missing 里。
 */
function selfCheckRules() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-bundle-gate-'))
  try {
    writeFileSync(path.join(dir, 'entry.js'), 'import{a}from"./lazy.js";console.log(a)')
    writeFileSync(path.join(dir, 'lazy.js'), 'import{b}from"./payload.js";export const a=b')
    writeFileSync(path.join(dir, 'dyn.js'), 'void import("./payload.js")')
    writeFileSync(path.join(dir, 'payload.js'), 'export const b=1')
    writeFileSync(path.join(dir, 'broken.js'), 'import{c}from"./ghost.js";export const z=c')
    writeFileSync(
      path.join(dir, 'index.html'),
      '<link rel="modulepreload" href="./assets/x.js"><script type="module" src="./assets/entry.js"></script>',
    )

    const viaStatic = staticReachable(dir, ['entry.js'])
    const viaDynamic = staticReachable(dir, ['dyn.js'])
    const broken = staticReachable(dir, ['broken.js'])
    // 反向用例（最重要）：roots 本身就指向不存在的文件 ——
    // 这正是「入口 chunk 缺失 → 门禁假绿」那条路径，没有它这次加固等于没验证过。
    const missingRoot = staticReachable(dir, ['nope.js'])
    const entries = parseEntryScripts(readFileSync(path.join(dir, 'index.html'), 'utf8'))

    // 不变式的第二半（调用方不得在 missing 非空时使用 reachable）——
    // 这三条把 `main()` 里曾经零覆盖的判定搬到了被测位置。
    const verdictOk = reachabilityVerdict({ reachable: new Set(), missing: [] }, 'echarts.js')
    const verdictLeaked = reachabilityVerdict(
      { reachable: new Set(['echarts.js']), missing: [] },
      'echarts.js',
    )
    // 关键：`reachable` 恰好**不含** echarts chunk，但 missing 非空 ——
    // 「脏集合时代」这种输入会得出 ok（假绿），必须判为 incomplete。
    const verdictIncomplete = reachabilityVerdict(
      { reachable: new Set(), missing: ['x.js'] },
      'echarts.js',
    )
    // 即使 leaked 与 missing 同时为真，也只能判 incomplete（优先级不可倒）。
    const verdictBoth = reachabilityVerdict(
      { reachable: new Set(['echarts.js']), missing: ['x.js'] },
      'echarts.js',
    )

    return (
      viaStatic.reachable.has('payload.js') &&
      viaStatic.missing.length === 0 &&
      !viaDynamic.reachable.has('payload.js') &&
      // 缺失文件：必须进 missing，且不得进 reachable（否则集合是脏的）。
      broken.missing.includes('ghost.js') &&
      !broken.reachable.has('ghost.js') &&
      missingRoot.missing.length === 1 &&
      missingRoot.missing[0] === 'nope.js' &&
      missingRoot.reachable.size === 0 &&
      // 不变式第二半。
      verdictOk.status === 'ok' &&
      verdictLeaked.status === 'leaked' &&
      verdictIncomplete.status === 'incomplete' &&
      verdictBoth.status === 'incomplete' &&
      entries.length === 1 &&
      entries[0] === 'entry.js'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function main() {
  if (!selfCheckRules()) {
    fail(
      '门禁规则自检失败：静态可达性 / 入口解析未能命中合成产物，疑似规则写错（会变成假绿灯）',
    )
  }

  const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const assetsDir = path.join(frontendRoot, 'dist', 'assets')

  let files
  try {
    files = readdirSync(assetsDir)
  } catch {
    fail(`找不到 ${assetsDir}，请先执行 npm run build`)
  }

  const jsFiles = files.filter((f) => f.endsWith('.js'))
  if (jsFiles.length === 0) fail('dist/assets 下没有 .js 产物，构建可能失败')

  const measured = jsFiles.map((name) => {
    const buf = readFileSync(path.join(assetsDir, name))
    const content = buf.toString('utf8')
    return {
      name,
      raw: buf.length,
      gzip: zlib.gzipSync(buf, { level: 9 }).length,
      content,
      carriesECharts: content.includes(ECHARTS_MARKER),
    }
  })

  const consumers = findChartConsumers(frontendRoot)
  const markerHits = measured.filter((f) => f.carriesECharts)
  const totalGzip = measured.reduce((sum, f) => sum + f.gzip, 0)
  const totalRaw = measured.reduce((sum, f) => sum + f.raw, 0)

  console.log('[check-bundle-size] 产物清单（gzip，降序）')
  for (const f of [...measured].sort((a, b) => b.gzip - a.gzip)) {
    console.log(`  ${fmt(f.gzip).padStart(10)}  ${f.name}`)
  }
  console.log(
    `[check-bundle-size] 合计 raw ${fmt(totalRaw)} / gzip ${fmt(totalGzip)}（上限 ${TOTAL_GZIP_LIMIT_KB} KB）`,
  )
  console.log(
    `[check-bundle-size] 图表消费者 ${consumers.length} 个` +
      `${consumers.length > 0 ? `：${consumers.join(', ')}` : '（页面尚未接入）'}`,
  )

  let failed = false

  // ---- 断言 1/2：echarts 特征串恰好命中 1 个 chunk ----
  const expectsEcharts = consumers.length > 0 || markerHits.length > 0
  if (!expectsEcharts) {
    console.log(
      '[check-bundle-size] 提示：未发现 echarts 特征串，且 src 下没有图表消费者' +
        '（页面接入前属预期）。',
    )
  } else if (markerHits.length === 0) {
    // 关键：找不到必须 fail —— 「检测手段失效」本身必须是可观测故障。
    failed = true
    console.error(
      `[check-bundle-size] ✗ 有 ${consumers.length} 个图表消费者，但产物中没有 chunk 含 ` +
        `特征串 ${ECHARTS_MARKER}：懒加载失效 / echarts 被并进主包 / 门禁特征串已过期。`,
    )
    for (const consumer of consumers) console.error(`  消费者：${consumer}`)
  } else if (markerHits.length > 1) {
    failed = true
    console.error(
      `[check-bundle-size] ✗ echarts 代码分散在 ${markerHits.length} 个 chunk，` +
        'manualChunks 没生效（会导致多页各拉一份碎片）：',
    )
    for (const f of markerHits) console.error(`  ${f.name}（gzip ${fmt(f.gzip)}）`)
  } else {
    const echartsChunk = markerHits[0]
    if (!echartsChunk.name.includes('echarts')) {
      // 改名即绕过：体积门禁只认 vite.config.ts 里固定的 "echarts" 名字。
      failed = true
      console.error(
        `[check-bundle-size] ✗ 含 echarts 特征串的 chunk 叫 ${echartsChunk.name}，` +
          '但 manualChunks 约定名必须含 "echarts"。改名等于放弃体积门禁。',
      )
    }

    const limit = ECHARTS_GZIP_LIMIT_KB * KB
    const ok = echartsChunk.gzip <= limit
    console.log(
      `[check-bundle-size] ${ok ? '✓' : '✗'} ${echartsChunk.name} gzip ${fmt(echartsChunk.gzip)}` +
        `（上限 ${ECHARTS_GZIP_LIMIT_KB} KB）`,
    )
    if (!ok) {
      failed = true
      console.error(
        '  超限排查顺序：① 是否有 import \'echarts\' 全量；② 是否注册了 CanvasRenderer / ' +
          'DatasetComponent / UniversalTransition；③ manualChunks 是否把 echarts 并入主包；' +
          '④ echarts.ts 是否又直接 import("echarts/charts") 之类的 barrel —— barrel 不可 ' +
          'tree-shake，必须走 core/charts/register.ts 的静态具名导入。',
      )
    }

    // ---- 断言 3：echarts chunk 不可从入口静态到达（懒加载是否真的生效） ----
    let html = ''
    try {
      html = readFileSync(path.join(frontendRoot, 'dist', 'index.html'), 'utf8')
    } catch {
      failed = true
      console.error('[check-bundle-size] ✗ 读不到 dist/index.html，无法校验懒加载')
    }
    const entryScripts = parseEntryScripts(html)
    if (entryScripts.length === 0) {
      failed = true
      console.error('[check-bundle-size] ✗ dist/index.html 里没有 module 入口脚本')
    } else {
      const traversal = staticReachable(assetsDir, entryScripts)
      const verdict = reachabilityVerdict(traversal, echartsChunk.name)

      if (verdict.status === 'incomplete') {
        // 产物不完整时**不出可达性结论**：打 ✓ 或 ✗ 都无意义。
        failed = true
        console.error(
          `[check-bundle-size] ✗ dist 产物不完整：index.html 引用了 ${traversal.missing.length} 个` +
            '在 assets 下不存在的文件 —— index.html 与 assets 版本不一致（build 被中断 / 并发写），' +
            '此时任何可达性结论都不可信，请重新 build。',
        )
        for (const name of traversal.missing) console.error(`  缺失：${name}`)
      } else {
        const leaked = verdict.status === 'leaked'
        console.log(
          `[check-bundle-size] ${leaked ? '✗' : '✓'} 静态可达性：入口 ` +
            `${entryScripts.join(', ')} → ${traversal.reachable.size} 个 chunk，` +
            `${leaked ? '包含' : '不含'} ${echartsChunk.name}`,
        )
        if (leaked) {
          failed = true
          console.error(
            '  echarts chunk 可从入口静态到达：懒加载已失效，首屏会白拉约 170 KB。' +
              '检查是否有源码静态 import 了 core/charts/*（必须走 initChart 的动态 import）。',
          )
        }
      }
    }
  }

  // ---- 断言 4：全站 JS gzip 总量 ----
  if (totalGzip > TOTAL_GZIP_LIMIT_KB * KB) {
    failed = true
    console.error(
      `[check-bundle-size] ✗ 全站 JS gzip ${fmt(totalGzip)} 超上限 ${TOTAL_GZIP_LIMIT_KB} KB`,
    )
  } else {
    console.log(
      `[check-bundle-size] ✓ 全站 JS gzip ${fmt(totalGzip)} ≤ ${TOTAL_GZIP_LIMIT_KB} KB`,
    )
  }

  if (failed) process.exit(1)
  console.log('[check-bundle-size] 全部通过')
}

// 仅作为 CLI 直接执行时跑 main；被测试 import 时保持无副作用。
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main()
}
