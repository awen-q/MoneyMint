/**
 * PWA 注册与更新提示（批 5，E-04 / AC-35）
 *
 * - 仅生产环境注册（dev 无 SW，避免 Vite HMR 与缓存打架）；
 * - 新 SW 安装完成进入 waiting 时**不自动激活**，回调通知 UI 出
 *   「有新版本」横幅；用户确认后才 skipWaiting 并在 controllerchange 后刷新；
 * - Safari 14.1 兼容：只用最基础的 SW API，无 BroadcastChannel / locks。
 */

/** 主动检查时等待 installing worker 落定的最长时间（毫秒）。 */
const INSTALL_SETTLE_TIMEOUT_MS = 3000

export interface PwaHandle {
  /** 用户确认更新：激活等待中的 SW 并刷新页面。 */
  confirmUpdate: () => void
  /** 主动检查新版本：返回是否有等待激活的新 SW。 */
  checkForUpdate: () => Promise<boolean>
}

/**
 * `registration.update()` 在部分浏览器 resolve 时 installing 尚未进入 installed，
 * 此时直接读 waiting 会漏判。监听 statechange 等它落定；超时则安全降级（按无
 * 等待处理，用户仍可走 reload 路径）。
 */
function waitForInstallingToSettle(registration: ServiceWorkerRegistration): Promise<void> {
  const maybeWorker = registration.installing
  if (maybeWorker === null) {
    return Promise.resolve()
  }
  // 显式收窄为非空类型：下面的函数声明会被提升，闭包内不能依赖控制流收窄。
  const worker: ServiceWorker = maybeWorker

  return new Promise<void>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    function onStateChange(): void {
      if (
        registration.installing === null ||
        worker.state === 'installed' ||
        worker.state === 'activated' ||
        worker.state === 'redundant'
      ) {
        finish()
      }
    }

    function finish(): void {
      if (settled) {
        return
      }
      settled = true
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      worker.removeEventListener('statechange', onStateChange)
      resolve()
    }

    timer = setTimeout(finish, INSTALL_SETTLE_TIMEOUT_MS)
    worker.addEventListener('statechange', onStateChange)
    // 注册监听期间可能已经落定，补一次同步判定，避免永远等到超时。
    onStateChange()
  })
}

export function registerServiceWorker(onUpdateAvailable: () => void): PwaHandle | null {
  if (typeof navigator === 'undefined' || navigator.serviceWorker === undefined) {
    return null
  }
  if (import.meta.env.DEV) {
    return null
  }

  let registration: ServiceWorkerRegistration | null = null
  let waitingWorker: ServiceWorker | null = null

  const confirmUpdate = (): void => {
    if (waitingWorker === null) return
    waitingWorker.postMessage('SKIP_WAITING')
    // 新 SW 接管后刷新一次，加载新产物。
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload()
    }, { once: true })
  }

  /**
   * 主动拉取新版本并判定是否有 waiting worker。离线 / 注册失败 / DEV 均返回
   * false 而不抛错——此时仍可安全重载缓存壳。
   */
  const checkForUpdate = async (): Promise<boolean> => {
    const current = registration
    if (current === null) {
      return false
    }
    try {
      await current.update()
    } catch {
      // 网络失败 / 离线：吞掉错误，继续按缓存壳路径处理。
      return false
    }
    await waitForInstallingToSettle(current)
    if (current.waiting !== null) {
      waitingWorker = current.waiting
      return true
    }
    return false
  }

  navigator.serviceWorker
    .register('/sw.js')
    .then((reg) => {
      registration = reg
      const current = reg
      if (current.waiting !== null && navigator.serviceWorker.controller !== null) {
        waitingWorker = current.waiting
        onUpdateAvailable()
      }
      current.addEventListener('updatefound', () => {
        const installing = current.installing
        if (installing === null) return
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller !== null) {
            waitingWorker = installing
            onUpdateAvailable()
          }
        })
      })
    })
    .catch(() => {
      // SW 注册失败不影响功能（如非 HTTPS 内网环境）。
    })

  return { confirmUpdate, checkForUpdate }
}
