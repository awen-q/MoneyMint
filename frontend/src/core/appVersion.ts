/**
 * 应用版本展示（唯一消费者是侧栏版本行与设置页「关于」卡片）。
 *
 * _version_ 的事实源只有 frontend/package.json，经 vite define 注入；
 * buildHash / buildDate 是构建元数据，不进 scripts/verify-version.sh 的三处校验，
 * 因此不会引入第四处版本事实源。报 bug 时复制整段即可定位到具体构建。
 */
export interface VersionInfo {
  version: string
  buildHash: string
  buildDate: string
}

/** 由构建期常量组装，模块内不自行读取时钟或 git。 */
export const APP_VERSION: VersionInfo = {
  version: __APP_VERSION__,
  buildHash: __APP_BUILD_HASH__,
  buildDate: __APP_BUILD_DATE__,
}

/** SemVer 预发布号（如 0.6.2-pre）才算预览版；正式版 x.y.z 不打角标。 */
export function isPrerelease(version: string): boolean {
  return version.includes('-')
}

/** 侧栏/独立页的极简版本文案。 */
export function shortVersion(info: VersionInfo): string {
  return `v${info.version}`
}

/** 「复制版本信息」按钮的整段文案：家人报 bug 一键粘贴即可。 */
export function versionCopyText(info: VersionInfo): string {
  const badge = isPrerelease(info.version) ? '（预览版）' : ''
  return `FamBean v${info.version}${badge}\n构建：${info.buildHash}\n日期：${info.buildDate}`
}
