/**
 * check-theme-sources.mjs 的 TypeScript 声明。
 * 让 src/**\/*.test.ts 在 strict 模式下可 import 扫描纯函数而不引入 any。
 */
export interface ColorLiteralHit {
  line: number
  text: string
}

export interface ThemeSourceHit extends ColorLiteralHit {
  file: string
}

export interface ThemeAllowLine {
  file: string
  line: number
  reason?: string
}

export interface ThemeExceptions {
  allowFiles: string[]
  allowLines: ThemeAllowLine[]
}

export declare function findColorLiterals(text: string): ColorLiteralHit[]

export declare function scanSources(root: string, exceptions: ThemeExceptions): ThemeSourceHit[]

export declare function loadExceptions(filePath?: string): ThemeExceptions
