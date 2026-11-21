/// <reference types="vite/client" />

/**
 * 构建期注入的应用版本号（来自 frontend/package.json 的 version 字段）。
 * 由 vite.config.ts 的 define.__APP_VERSION__ 提供。
 */
declare const __APP_VERSION__: string

/**
 * 构建元数据：短提交号（git 不可用时为 unknown）与构建日期（YYYY-MM-DD）。
 * 由 vite.config.ts 的 define 提供，仅用于展示与排障，不参与版本一致性校验。
 */
declare const __APP_BUILD_HASH__: string
declare const __APP_BUILD_DATE__: string
