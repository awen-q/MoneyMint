/**
 * 主题色源护栏（阶段 0 固化）。
 *
 * 扫描 frontend/src/**\/*.{vue,ts,css} 中的十六进制色值与 rgb()/rgba() 字面量，
 * 输出「文件:行号」；白名单支持整文件放行（allowFiles）与指定行放行（allowLines）。
 *
 * - 直接运行：node scripts/check-theme-sources.mjs（npm run check:theme）
 * - 测试复用：import { scanSources } from '../../scripts/check-theme-sources.mjs'
 *
 * 目标：阶段 0 收编完成后，除 tokens.css 与 themeTokens.ts 两个唯一色值源外，
 * 源码中不再出现任何硬编码色值；阶段 3 换暖色时只需改 token 值。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 色值字面量：#rgb / #rgba / #rrggbb / #rrggbbaa，以及 rgb() / rgba()。 */
const COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\(/g
const SOURCE_EXTENSIONS = ['.vue', '.ts', '.css']

/**
 * `--fb-*` **声明**：行首（允许缩进）的 `--fb-x:`。
 *
 * 用行首锚定而不是「任意位置出现 `--fb-x:`」：`var(--fb-a, --fb-b: x)` 这种
 * 病态写法不该被当成声明；而 `background: var(--fb-bg);` 里的 `var(` 不带冒号，
 * 也不会误命中。
 */
const FB_DECL_PATTERN = /^[ \t]*(--fb-[A-Za-z0-9_-]+)[ \t]*:/gm

/**
 * `--fb-*` **引用**：`var(--fb-x)` 与 `var(--fb-x, fallback)`。
 *
 * 第二个捕获组用来判断是否带 fallback：带 fallback 的引用即使变量没声明，
 * 视觉上也会退到 fallback（不一定是 bug），所以报告里要能区分，供人判断。
 */
const FB_REF_PATTERN = /var\(\s*(--fb-[A-Za-z0-9_-]+)(\s*,)?/g

/** 归一为正斜杠，Windows 下与白名单/输出一致。 */
function toPosix(filePath) {
  return filePath.split(sep).join('/')
}

/**
 * 纯函数：在一段文本里找出色值字面量及其行号。
 *
 * @param {string} text 源文件文本
 * @returns {Array<{line: number, text: string}>} 命中列表（同一行多处均记录）
 */
export function findColorLiterals(text) {
  const hits = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    // 每行使用独立 lastIndex 的正则实例，避免跨行状态污染。
    const pattern = new RegExp(COLOR_PATTERN.source, 'g')
    const line = lines[i] ?? ''
    let match = pattern.exec(line)
    while (match !== null) {
      hits.push({ line: i + 1, text: match[0] })
      match = pattern.exec(line)
    }
  }
  return hits
}

/**
 * 递归列出目录内所有受管源码文件。
 *
 * @param {string} dir 目录绝对路径
 * @returns {string[]} 文件绝对路径列表（按 readdirSync 顺序）
 */
function listSourceFiles(dir) {
  if (!existsSync(dir)) {
    return []
  }
  const result = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      result.push(...listSourceFiles(full))
    } else if (SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      result.push(full)
    }
  }
  return result
}

/**
 * 纯函数（无副作用输出）：扫描源码树，返回未授权的色值命中。
 *
 * @param {string} root 前端根目录绝对路径（其下应有 src/）
 * @param {{allowFiles?: string[], allowLines?: Array<{file: string, line: number}>}} exceptions 白名单
 * @returns {Array<{file: string, line: number, text: string}>} 相对 root 的命中列表
 */
export function scanSources(root, exceptions) {
  const allowFiles = new Set((exceptions?.allowFiles ?? []).map(toPosix))
  const allowLines = new Set(
    (exceptions?.allowLines ?? []).map((item) => `${toPosix(item.file)}:${item.line}`),
  )
  const hits = []
  for (const absolute of listSourceFiles(join(root, 'src'))) {
    const file = toPosix(relative(root, absolute))
    if (allowFiles.has(file)) {
      continue
    }
    const text = readFileSync(absolute, 'utf8')
    for (const hit of findColorLiterals(text)) {
      if (allowLines.has(`${file}:${hit.line}`)) {
        continue
      }
      hits.push({ file, line: hit.line, text: hit.text })
    }
  }
  return hits
}

/**
 * 收集一段 CSS 里**声明**的全部 `--fb-*` 变量名。
 *
 * 注意「声明」与「引用」必须分开收集：`--fb-brand: var(--fb-blue);` 既是声明
 * （`--fb-brand`）又是引用（`--fb-blue`），两边都要记。只做其中一边，
 * 就会要么漏报 var 链断裂、要么把合法 token 报成未声明。
 *
 * @param {string} cssText CSS 文本（tokens.css 全文）
 * @returns {Set<string>} 已声明变量名集合（含 :root / .slip / [data-theme='night'] 等全部块）
 */
export function collectDeclaredVars(cssText) {
  const declared = new Set()
  for (const match of cssText.matchAll(FB_DECL_PATTERN)) {
    declared.add(match[1])
  }
  return declared
}

/**
 * 纯函数：在一段源码文本里找出所有 `--fb-*` 引用及其行号。
 *
 * @param {string} text 源码文本
 * @returns {Array<{line: number, name: string, hasFallback: boolean}>} 引用列表
 */
export function findVarReferences(text) {
  const refs = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    // 每行用独立正则实例，避免 lastIndex 状态跨行污染（与 findColorLiterals 同款处理）。
    const pattern = new RegExp(FB_REF_PATTERN.source, 'g')
    const line = lines[i] ?? ''
    let match = pattern.exec(line)
    while (match !== null) {
      refs.push({
        line: i + 1,
        name: match[1],
        hasFallback: match[2] !== undefined,
      })
      match = pattern.exec(line)
    }
  }
  return refs
}

/**
 * 纯函数：找出引用了「未声明变量」的位置。
 *
 * 为什么这类错误必须静态拦：`var(--fb-success)` 在 `--fb-success` 不存在时
 * 计算值为空 —— 圆点变黑、边框消失、文字变成默认色，**浏览器不报错、控制台不报错**，
 * 只有在肉眼验收时表现为「颜色有点怪」。同族错误还有手滑写成 `--fb-brand-bg`
 * （实际叫 `--fb-brand-soft`）之类，全仓任意一处都可能犯。
 *
 * @param {Array<{file: string, text: string}>} sources 源码文件列表
 * @param {Set<string>} declared 已声明变量名集合
 * @returns {Array<{file: string, line: number, name: string, hasFallback: boolean}>} 未声明引用
 */
export function findUndeclaredVars(sources, declared) {
  const hits = []
  for (const { file, text } of sources) {
    for (const ref of findVarReferences(text)) {
      if (declared.has(ref.name)) continue
      hits.push({ file, line: ref.line, name: ref.name, hasFallback: ref.hasFallback })
    }
  }
  return hits
}

/**
 * 去掉 CSS 注释，避免注释里出现的 `--fb-x:` / `var(--fb-x)` 被当成真声明/真引用。
 *
 * @param {string} text 源码文本
 * @returns {string} 去注释后的文本（保留换行数，行号仍可对齐）
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, ' '),
  )
}

/**
 * 极简 CSS 块扫描：返回顶层块及其**直接**选择器与 body。
 *
 * 只做一件事：把 `:root { … }` 与其他块（`[data-theme='night']`、`.slip`、
 * 组件 scoped 块）区分开。刻意不做完整 CSS 解析 —— 但必须正确处理
 * 「一个文件里有多个 `:root` 块」与「`@media` 里嵌块」这两种情况，
 * 否则规则②会误报（fe-state 提示的「按名字数声明次数 / 只认第一个块」正是这类写法）。
 *
 * @param {string} text 已去注释的文本
 * @returns {Array<{selector: string, body: string, offset: number}>} 顶层块列表
 */
export function parseTopLevelBlocks(text) {
  const blocks = []
  let preludeStart = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '{') {
      const selector = text.slice(preludeStart, i).trim()
      let depth = 1
      let j = i + 1
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth += 1
        else if (text[j] === '}') depth -= 1
        j += 1
      }
      blocks.push({ selector, body: text.slice(i + 1, j - 1), offset: i + 1 })
      i = j
      preludeStart = j
      continue
    }
    if (ch === ';' || ch === '}') preludeStart = i + 1
    i += 1
  }
  return blocks
}

/** 块内声明名（不锚行首：块内一般是 `  --fb-x: v;`，也允许单行多声明）。 */
const DECL_ANYWHERE_PATTERN = /(--fb-[A-Za-z0-9_-]+)\s*:/g

/**
 * 收集一段 CSS 里所有块的 `--fb-*` 声明，并记录**首次出现的块选择器**（供报错文案用）。
 *
 * @param {string} cssText CSS 文本
 * @returns {Map<string, string>} 变量名 → 声明它的块选择器
 */
export function collectDeclarationsByScope(cssText) {
  const scopes = new Map()
  for (const block of parseTopLevelBlocks(stripComments(cssText))) {
    // 嵌套块（如 @media 里的 body）也算「声明过」，但归到外层选择器名下即可。
    for (const match of block.body.matchAll(DECL_ANYWHERE_PATTERN)) {
      const name = match[1]
      if (!scopes.has(name)) {
        scopes.set(name, block.selector.replace(/\s+/g, ' '))
      }
    }
  }
  return scopes
}

/**
 * 收集 `:root` 里声明的 `--fb-*`（多个 `:root` 块合并）。
 *
 * 这是规则②（声明层）与兜底规则的共同基础：
 * - 规则②断言「声明过的名字必须在 `:root` 里也有值」；
 * - 兜底规则只在「该名字在 `:root` 有值」时才禁止 fallback。
 *
 * @param {string} cssText tokens.css 文本
 * @returns {Set<string>} 在 `:root` 有值的变量名
 */
export function collectRootVars(cssText) {
  const rootVars = new Set()
  const clean = stripComments(cssText)
  for (const block of parseTopLevelBlocks(clean)) {
    if (block.selector !== ':root') continue
    for (const match of block.body.matchAll(DECL_ANYWHERE_PATTERN)) {
      rootVars.add(match[1])
    }
  }
  return rootVars
}

/**
 * 纯函数：找出「声明过但 `:root` 里没有值」的 `--fb-*`（规则②）。
 *
 * 关掉的 bug 类：token 只在 `[data-theme='night']` / `.slip` / 组件 scoped 块里声明，
 * **亮纸模式下它根本不存在** → 所有引用它的地方解析为空 → 渲染成默认色、浏览器不报错。
 * 症状与 `var(--fb-success)`（token 名拼错）完全同型，只是成因相反：
 * 一个是「引用了不存在的名字」，一个是「名字存在但只在暗色下存在」。
 *
 * @param {Array<{file: string, text: string}>} sources 源码文件（.css 与 .vue 的 style 块）
 * @param {Set<string>} rootVars `:root` 里有值的名字
 * @returns {Array<{file: string, name: string, scope: string}>} 命中列表
 */
export function findNonRootDeclarations(sources, rootVars) {
  const hits = []
  for (const { file, text } of sources) {
    for (const [name, scope] of collectDeclarationsByScope(text)) {
      if (rootVars.has(name)) continue
      hits.push({ file, name, scope })
    }
  }
  return hits
}

/**
 * 读取 `src/**` 下全部受管源码（含 `tokens.css` 自身）。
 *
 * @param {string} root frontend 根目录
 * @returns {Array<{file: string, text: string}>} 相对路径 + 文本
 */
function readSources(root) {
  return listSourceFiles(join(root, 'src')).map((absolute) => ({
    file: toPosix(relative(root, absolute)),
    text: readFileSync(absolute, 'utf8'),
  }))
}

/** tokens.css 绝对路径。 */
function tokensCssPath(root) {
  return join(root, 'src', 'styles', 'tokens.css')
}

/**
 * 读取 tokens.css 文本（缺失时返回空串）。
 *
 * @param {string} root frontend 根目录
 * @returns {string} tokens.css 内容
 */
function readTokensCss(root) {
  const file = tokensCssPath(root)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/**
 * 只保留能承载 CSS 声明的源码：`.css` 全文件 + `.vue` 的 `<style>` 块。
 *
 * `.ts` 里不会有 CSS 声明（运行时 `setProperty` 不算声明，它必须在 CSS 里有首帧值，
 * 见 `tokens.css:125-126` 对 `--vvh` 的规定），故跳过。
 *
 * @param {Array<{file: string, text: string}>} sources 全部源码
 * @returns {Array<{file: string, text: string}>} 可声明 CSS 变量的源码
 */
function cssSources(sources) {
  const result = []
  for (const source of sources) {
    if (source.file.endsWith('.css')) {
      result.push(source)
      continue
    }
    if (!source.file.endsWith('.vue')) continue
    const styles = [...source.text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    for (const match of styles) {
      result.push({ file: source.file, text: match[1] })
    }
  }
  return result
}

/**
 * 扫描整个 src，返回 `var(--fb-*)` 引用了未声明变量的清单。
 *
 * 与 `scanSources` 的关键差别：**不跳过白名单文件**。`tokens.css` 自己就有
 * `--fb-primary-soft: var(--fb-brand-soft)` 这类引用，它们同样必须过校验 ——
 * 否则「在 tokens.css 里」会成为最难发现的一类漏网。
 *
 * @param {string} root frontend 根目录绝对路径
 * @returns {Array<{file: string, line: number, name: string, hasFallback: boolean}>} 命中列表
 */
export function scanVarReferences(root) {
  return findUndeclaredVars(readSources(root), collectDeclaredVars(readTokensCss(root)))
}

/**
 * 扫描规则②：声明过但 `:root` 没有值的 `--fb-*`。
 *
 * @param {string} root frontend 根目录绝对路径
 * @returns {Array<{file: string, name: string, scope: string}>} 命中列表
 */
export function scanNonRootDeclarations(root) {
  const rootVars = collectRootVars(readTokensCss(root))
  return findNonRootDeclarations(cssSources(readSources(root)), rootVars)
}

/**
 * 纯函数：找出「`:root` 有值、却仍写了 fallback」的 `var(--fb-*, X)`。
 *
 * 判据是**条件式**的（只对 `:root` 内已声明的 token 生效），这一点很关键：
 * - `:root` 有值的 token，在任何主题下都能解析出值 → fallback 永不执行 → 纯死代码；
 * - **不在 `:root` 的 token**（例如只在 `[data-theme='night']` 声明）在亮纸下不存在，
 *   此时 `var(--fb-night-glow, #000)` 的 fallback 是**正确且必要**的写法，绝不能禁。
 *
 * 所以本规则的正确性不依赖「观察到 76/76 都在 :root」这个事实，而依赖
 * **规则②强制的不变量**：声明过的名字必须在 `:root` 有值。两条规则互锁——
 * ② 让「token 有没有值」变成静态可判，本规则才有资格说「fallback 恒死」。
 * 若将来把 ② 放宽，本规则须同步收窄。
 *
 * 为什么要禁死兜底：它一旦存在就会掩盖「token 名写错」——
 * `var(--fb-text, inherit)`（`--fb-text` 是拼错的名字）视觉上退到 `inherit`、
 * 浏览器不报错，只在肉眼验收时表现为「颜色有点怪」。本轮 4 处即此类。
 *
 * 真有第三方注入 token 的需求，正确做法是**先声明再引用**，不是加 fallback。
 *
 * @param {Array<{file: string, text: string}>} sources 源码文件列表
 * @param {Set<string>} rootVars `:root` 里有值的名字
 * @returns {Array<{file: string, line: number, name: string}>} 命中列表
 */
export function findFallbackRefs(sources, rootVars) {
  const hits = []
  for (const { file, text } of sources) {
    for (const ref of findVarReferences(text)) {
      if (!ref.hasFallback) continue
      // 只对「:root 有值」的名字生效：不在 :root 的名字，fallback 可能是合法兜底。
      if (!rootVars.has(ref.name)) continue
      hits.push({ file, line: ref.line, name: ref.name })
    }
  }
  return hits
}

/**
 * 扫描整个 src，返回死兜底（`:root` 已声明 token 的 fallback）清单。
 *
 * @param {string} root frontend 根目录绝对路径
 * @returns {Array<{file: string, line: number, name: string}>} 命中列表
 */
export function scanFallbackRefs(root) {
  return findFallbackRefs(readSources(root), collectRootVars(readTokensCss(root)))
}
/**
 * 读取白名单配置。
 *
 * @param {string} [filePath] 可选的配置文件路径，默认 scripts/theme-exceptions.json
 * @returns {{allowFiles: string[], allowLines: Array<{file: string, line: number, reason?: string}>}} 白名单
 */
export function loadExceptions(filePath) {
  const configPath =
    filePath ?? join(dirname(fileURLToPath(import.meta.url)), 'theme-exceptions.json')
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  return {
    allowFiles: Array.isArray(parsed.allowFiles) ? parsed.allowFiles : [],
    allowLines: Array.isArray(parsed.allowLines) ? parsed.allowLines : [],
  }
}

/**
 * 自检：色值扫描器必须能命中样本（防「规则写错 = 永远通过」）。
 *
 * @returns {boolean} true 表示命中了预期的 2 处
 */
function selfCheckColorScanner() {
  return findColorLiterals('#abcdef\nrgb(1, 2, 3)').length === 2
}

/**
 * 自检：`var(--fb-*)` 引用校验器必须**既命中真错、又不误伤**。
 *
 * 为什么必须有这条反向用例：断言型代码最容易出「恒真」——
 * 如果正则写错（比如漏了 `var(` 前缀、或把 `--fb-` 拼成 `--f-`），
 * 校验函数会永远返回空数组，`check:theme` 永远绿，而这个门禁等于不存在。
 * 本仓已有多起同类教训（`zrender` 特征串只来自 banner、`not.toThrow()` 恒真），
 * 所以这里用合成样本把「该命中」和「不该命中」都钉住。
 *
 * @returns {boolean} true 表示校验器行为符合预期
 */
function selfCheckVarRules() {
  const tokensCss = [
    ':root {',
    '  --fb-known: #123456;',
    '  --fb-alias: var(--fb-known);', // 既是声明又是引用：两边都要记
    '  --fb-broken-chain: var(--fb-missing-in-tokens);', // tokens.css 内部的断裂引用也要报
    '}',
    "[data-theme='night'] {",
    '  --fb-night-only: #000;',
    '}',
  ].join('\n')

  const declared = collectDeclaredVars(tokensCss)
  const componentText = [
    '.a { color: var(--fb-known); }', // 已声明 → 不报
    '.b { color: var(--fb-night-only); }', // 只在 night 块声明 → ① 放过（② 负责报它）
    '.c { color: var(--fb-nonexistent); }', // ← 命中
    '.d { color: var(--fb-with-fallback, 12px); }', // 未声明但带 fallback → ① 仍要报
    '.e { color: var(--other-lib-var); }', // 非 --fb- 前缀 → 不归 ① 管
  ].join('\n')

  const sources = [
    { file: 'src/styles/tokens.css', text: tokensCss },
    { file: 'src/components/Demo.vue', text: componentText },
  ]

  const hits = findUndeclaredVars(sources, declared)

  const names = hits.map((hit) => hit.name).sort()
  // `--fb-broken-chain` 本身是**声明**（不该报）；它引用的 `--fb-missing-in-tokens`
  // 才是未声明项 —— 这条正是「声明与引用分开收集」的验证点：搞混就会漏报或误报。
  const expected = [
    '--fb-missing-in-tokens',
    '--fb-nonexistent',
    '--fb-with-fallback',
  ].sort()

  // ---- 规则②（声明层）反向用例 ----
  const rootVars = collectRootVars(tokensCss)
  const nonRoot = findNonRootDeclarations(sources, rootVars)
  const nonRootNames = nonRoot.map((hit) => hit.name).sort()
  // 应报：只在 night 块声明的那个；不应报：在 :root 有值的（含「:root 与 night 都声明」
  // 的正例 B —— 防的是「只认第一个 :root 块 / 把 night 覆盖当重复声明」这类实现）。
  const nonRootExpected = ['--fb-night-only']
  const multiRootMerged =
    collectRootVars(':root { --fb-a: 1; }\n:root { --fb-b: 2; }').size === 2

  // ---- 兜底规则（条件式）反向用例 ----
  // 关键：`:root` 有值 → 报；只在 night 声明（不在 :root）→ **不得报**。
  // 这两条合起来证明判据真的是「条件式」而不是「一律禁」。
  const fallbackAll = findFallbackRefs(
    [
      {
        file: 'src/components/Demo.vue',
        text: [
          '.x { color: var(--fb-known, red); }', // :root 有值 → 命中
          '.y { color: var(--fb-night-only, red); }', // 不在 :root → 不命中
        ].join('\n'),
      },
    ],
    rootVars,
  )
  const fallbackNames = fallbackAll.map((hit) => hit.name)

  return (
    names.length === expected.length &&
    names.every((name, index) => name === expected[index]) &&
    nonRootNames.length === nonRootExpected.length &&
    nonRootNames.every((name, index) => name === nonRootExpected[index]) &&
    multiRootMerged &&
    // 条件判据的两侧都必须成立，缺一侧就等于「一律禁」或「一律不报」。
    fallbackNames.length === 1 &&
    fallbackNames[0] === '--fb-known' &&
    // 声明集合本身也要自检：两块作用域都要被收集到。
    declared.has('--fb-known') &&
    declared.has('--fb-night-only')
  )
}

function main() {
  // 自检：确保规则没有写错，避免「永远通过」的假绿灯。
  if (!selfCheckColorScanner()) {
    console.error('[theme] FAIL: 色值扫描器自检失败，规则未能命中样本')
    process.exitCode = 1
    return
  }
  if (!selfCheckVarRules()) {
    console.error('[theme] FAIL: var(--fb-*) 引用校验器自检失败，反向用例未按预期命中')
    process.exitCode = 1
    return
  }

  // `--self-check`：只跑自检（给验收/调试用，不依赖当前仓的源码状态）。
  if (process.argv.includes('--self-check')) {
    console.log('[theme] self-check PASS：色值扫描器与 var 引用校验器均能命中样本')
    return
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  let failed = false

  // ① 硬编码色值
  const colorHits = scanSources(root, loadExceptions())
  if (colorHits.length === 0) {
    console.log('[theme] PASS：src/**/*.{vue,ts,css} 无未授权硬编码色值')
  } else {
    failed = true
    console.error(`[theme] FAIL：发现 ${colorHits.length} 处未授权硬编码色值：`)
    for (const hit of colorHits) {
      console.error(`  ${hit.file}:${hit.line}  ${hit.text}`)
    }
  }

  // ② var(--fb-*) 引用必须在 tokens.css 里声明过
  const varHits = scanVarReferences(root)
  if (varHits.length === 0) {
    console.log('[theme] PASS：所有 var(--fb-*) 引用均已在 tokens.css 声明')
  } else {
    failed = true
    console.error(
      `[theme] FAIL：发现 ${varHits.length} 处引用了未声明的 --fb-* 变量` +
        '（计算结果为空 → 颜色变默认值，浏览器不报错）：',
    )
    for (const hit of varHits) {
      const note = hit.hasFallback ? '（带 fallback，视觉会退到兜底值）' : ''
      console.error(`  ${hit.file}:${hit.line}  ${hit.name}${note}`)
    }
  }

  // ③ 规则②（声明层）：声明过的 --fb-* 必须在 :root 有值
  const nonRootHits = scanNonRootDeclarations(root)
  if (nonRootHits.length === 0) {
    console.log('[theme] PASS：所有 --fb-* 声明都在 :root 有值（暗色/局部作用域不会孤立存在）')
  } else {
    failed = true
    console.error(
      `[theme] FAIL：发现 ${nonRootHits.length} 个 --fb-* 只在非 :root 作用域声明，` +
        '亮纸模式下它们没有值 → 引用处解析为空（渲染成默认色、浏览器不报错）：',
    )
    for (const hit of nonRootHits) {
      console.error(
        `  ${hit.file}  ${hit.name}  只在「${hit.scope}」声明，请在 tokens.css 的 :root 补一条`,
      )
    }
  }

  // ④ 兜底规则：`:root` 已声明 token 的 fallback 是死代码
  const fallbackHits = scanFallbackRefs(root)
  if (fallbackHits.length === 0) {
    console.log('[theme] PASS：无 var(--fb-*, fallback) 死兜底')
  } else {
    failed = true
    console.error(
      `[theme] FAIL：发现 ${fallbackHits.length} 处对「:root 已声明」的 token 写了 fallback。` +
        '它永不生效、是死代码，且会掩盖「token 名写错」（本轮 4 处 --fb-text/--fb-surface 即此类）：',
    )
    for (const hit of fallbackHits) {
      console.error(`  ${hit.file}:${hit.line}  ${hit.name}`)
    }
  }

  if (failed) process.exitCode = 1
}

// 仅作为 CLI 直接执行时跑 main；被测试 import 时保持无副作用。
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main()
}
