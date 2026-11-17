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

/** Windows 下把路径统一成正斜杠，便于与 JSON 白名单比较。 */
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

function main() {
  // 自检：确保正则没有写错，避免「永远通过」的假绿灯。
  const sampleHits = findColorLiterals('#abcdef\nrgb(1, 2, 3)')
  if (sampleHits.length !== 2) {
    console.error('[theme] FAIL: 色值扫描器自检失败，规则未能命中样本')
    process.exitCode = 1
    return
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const hits = scanSources(root, loadExceptions())
  if (hits.length === 0) {
    console.log('[theme] PASS：src/**/*.{vue,ts,css} 无未授权硬编码色值')
    return
  }
  console.error(`[theme] FAIL：发现 ${hits.length} 处未授权硬编码色值：`)
  for (const hit of hits) {
    console.error(`  ${hit.file}:${hit.line}  ${hit.text}`)
  }
  process.exitCode = 1
}

// 仅作为 CLI 直接执行时跑 main；被测试 import 时保持无副作用。
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main()
}
