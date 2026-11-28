/**
 * 构建期把 src/i18n/en.ts 导出成 public/i18n/en.json（构建时 Vite 原样复制到 dist）。
 *
 * 为什么需要它：门禁只统计 dist/assets/*.js 的 gzip，动态 import 拆出的懒 chunk
 * 仍然计入 assets，所以「把 en 改成 import('./en')」是零收益。英文字典只有完全
 * 脱离 JS 产物（public 下的 JSON + fetch）才能真正省下约 21.72 KB gzip。
 *
 * 单一事实源：英文文案仍只维护在 src/i18n/en.ts，本脚本用 esbuild（Vite 既有
 * 依赖，零新增包）把 TS 转换成 JS 后求值，绝不正则手工抄字符串，避免漂移。
 * 同时校验 en / zh-CN 键集合一致，与 i18n.test.ts 的 parity 断言同口径。
 *
 * 顺带产出 public/i18n/build-meta.json：记录源码指纹（src + index.html +
 * vite.config.ts + package.json 内容 sha256）与 en.json 的 sha256。门禁脚本
 * 比对 dist/i18n/build-meta.json 与当前源码指纹，堵住「陈旧 dist 假绿」。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'

/** frontend 根目录绝对路径。 */
export const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 参与源码指纹的顶层条目；public/dist/scripts 是生成物或门禁自身，不计入。 */
const FINGERPRINT_ROOTS = ['src', 'index.html', 'vite.config.ts', 'package.json']

/** 计算 Buffer 的 sha256 十六进制串。 */
export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * 递归收集参与指纹的源码相对路径（POSIX 分隔符，排序后稳定）。
 *
 * @returns {string[]} 相对 frontend 根的源码文件路径
 */
export function collectSourceFiles() {
  const files = []
  const walk = (relative) => {
    const absolute = path.join(FRONTEND_ROOT, relative)
    const info = statSync(absolute)
    if (info.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        walk(path.posix.join(relative, name).split(path.sep).join('/'))
      }
    } else if (info.isFile()) {
      files.push(relative.split(path.sep).join('/'))
    }
  }
  for (const relative of FINGERPRINT_ROOTS) walk(relative)
  return files.sort()
}

/**
 * 源码指纹：路径 + 内容一起哈希，任何源码改动都会让已构建 dist 变「陈旧」。
 * 与 mtime 无关，git checkout / Docker COPY 不会误报。
 *
 * @returns {string} sha256 十六进制串
 */
export function sourceFingerprint() {
  const hash = createHash('sha256')
  for (const relative of collectSourceFiles()) {
    hash.update(relative)
    hash.update('\u0000')
    hash.update(readFileSync(path.join(FRONTEND_ROOT, relative)))
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

/**
 * 用 esbuild 求值一个 TS 模块的具名导出（只用 Vite 已有依赖）。
 *
 * @param {string} relativePath 相对 frontend 根的 TS 文件路径
 * @param {string} exportName 要取出的导出名
 * @returns {Promise<unknown>} 导出的运行时值
 */
async function loadTsExport(relativePath, exportName) {
  const source = readFileSync(path.join(FRONTEND_ROOT, relativePath), 'utf8')
  const { code } = await esbuild.transform(source, {
    loader: 'ts',
    format: 'esm',
    target: 'es2019',
  })
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  const module = await import(moduleUrl)
  const value = module[exportName]
  if (value === undefined) {
    throw new Error(`${relativePath} 未导出 ${exportName}，无法生成字典`)
  }
  return value
}

/**
 * 断言对象是「key → 非空字符串」的平层字典。
 *
 * @param {unknown} value 待校验值
 * @param {string} label 报错用的名字
 * @returns {Record<string, string>} 校验通过的字典
 */
function assertStringDictionary(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是平层对象`)
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`${label} 的键 ${key} 不是非空字符串`)
    }
  }
  return value
}

async function main() {
  const en = assertStringDictionary(await loadTsExport('src/i18n/en.ts', 'en'), '英文字典')
  const zhCN = assertStringDictionary(await loadTsExport('src/i18n/zh-CN.ts', 'zhCN'), '中文字典')

  // 与 i18n.test.ts:71 的 parity 断言同口径：构建期就拦住字典漂移。
  const enKeys = Object.keys(en).sort()
  const zhKeys = Object.keys(zhCN).sort()
  if (enKeys.length !== zhKeys.length || enKeys.some((key, index) => key !== zhKeys[index])) {
    throw new Error('en / zh-CN 键集合不一致，拒绝生成 en.json')
  }

  const outputDir = path.join(FRONTEND_ROOT, 'public', 'i18n')
  mkdirSync(outputDir, { recursive: true })
  const json = `${JSON.stringify(en, null, 2)}\n`
  writeFileSync(path.join(outputDir, 'en.json'), json, 'utf8')

  const meta = {
    sourceHash: sourceFingerprint(),
    enJsonSha256: sha256(Buffer.from(json, 'utf8')),
    keyCount: enKeys.length,
    generatedAt: new Date().toISOString(),
  }
  writeFileSync(
    path.join(outputDir, 'build-meta.json'),
    `${JSON.stringify(meta, null, 2)}\n`,
    'utf8',
  )
  console.log(
    `[generate-en-dict] 已生成 public/i18n/en.json（${enKeys.length} 键 / ${Buffer.byteLength(json)} B），` +
      `源码指纹 ${meta.sourceHash.slice(0, 12)}`,
  )
}

// 被门禁脚本 import 时保持无副作用，仅 CLI 直接执行时生成。
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[generate-en-dict] 生成失败：', error)
    process.exit(1)
  })
}
