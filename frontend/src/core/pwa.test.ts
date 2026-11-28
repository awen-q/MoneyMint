// @vitest-environment jsdom
/**
 * PWA 主动检查（checkForUpdate）契约：离线 / 无注册返回 false，waiting 判定，
 * updatefound 与 update() 的竞态等待，以及 confirmUpdate 原有行为不回归。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerServiceWorker, type PwaHandle } from '@/core/pwa'

type Listener = () => void

interface ContainerHarness {
  registerMock: ReturnType<typeof vi.fn>
  controllerListeners: Set<Listener>
}

function fakeWorker(state = 'installed'): ServiceWorker {
  return {
    state,
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as ServiceWorker
}

function fakeRegistration(options: {
  waiting?: ServiceWorker | null
  installing?: ServiceWorker | null
  updateImpl?: () => Promise<unknown>
} = {}): ServiceWorkerRegistration {
  return {
    waiting: options.waiting ?? null,
    installing: options.installing ?? null,
    update: vi.fn(options.updateImpl ?? (() => Promise.resolve())),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as ServiceWorkerRegistration
}

/** 把 fake container 装到 navigator.serviceWorker 上。 */
function installContainer(
  registration: ServiceWorkerRegistration | null,
  registrationFails = false,
  controller: ServiceWorker | null = null,
): ContainerHarness {
  const registerMock = registrationFails
    ? vi.fn().mockRejectedValue(new Error('offline'))
    : vi.fn().mockResolvedValue(registration)
  const controllerListeners = new Set<Listener>()
  const container = {
    register: registerMock,
    controller,
    addEventListener: vi.fn((_type: string, listener: Listener) => {
      controllerListeners.add(listener)
    }),
    removeEventListener: vi.fn(),
  }
  Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true })
  return { registerMock, controllerListeners }
}

/** 等待 register() 的 then 回调落定。 */
async function readyHandle(): Promise<PwaHandle> {
  const handle = registerServiceWorker(vi.fn())
  expect(handle).not.toBeNull()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
  return handle as PwaHandle
}

beforeEach(() => {
  // Vitest 默认 DEV=true；生产分支才会真正注册 SW。
  vi.stubEnv('DEV', false)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'serviceWorker')
})

describe('checkForUpdate', () => {
  it('update() 后存在 waiting worker 时返回 true', async () => {
    const waiting = fakeWorker()
    const registration = fakeRegistration({ waiting })
    const { registerMock } = installContainer(registration)

    const handle = await readyHandle()
    const result = await handle.checkForUpdate()

    expect(registerMock).toHaveBeenCalledWith('/sw.js')
    expect(registration.update).toHaveBeenCalledTimes(1)
    expect(result).toBe(true)
  })

  it('没有 waiting worker 时返回 false', async () => {
    const registration = fakeRegistration({ waiting: null })
    installContainer(registration)

    const handle = await readyHandle()
    expect(await handle.checkForUpdate()).toBe(false)
  })

  it('update() reject（离线）时吞掉错误并返回 false', async () => {
    const registration = fakeRegistration({
      updateImpl: () => Promise.reject(new Error('offline')),
    })
    installContainer(registration)

    const handle = await readyHandle()
    await expect(handle.checkForUpdate()).resolves.toBe(false)
  })

  it('无 SW 支持 / DEV / 注册失败时安全降级', async () => {
    // 无 SW 支持：直接返回 null，没有可调用的 handle。
    Reflect.deleteProperty(navigator, 'serviceWorker')
    expect(registerServiceWorker(vi.fn())).toBeNull()

    // DEV：同样不注册。
    vi.stubEnv('DEV', true)
    installContainer(fakeRegistration())
    expect(registerServiceWorker(vi.fn())).toBeNull()

    // 注册失败（含无 registration 的情形）：handle 存在但 checkForUpdate 返回 false。
    vi.stubEnv('DEV', false)
    installContainer(null, true)
    const handle = await readyHandle()
    await expect(handle.checkForUpdate()).resolves.toBe(false)
  })

  it('update() resolve 时 installing 尚未落定：等 statechange 后按 waiting 判定', async () => {
    const installing = fakeWorker('installing')
    const registration = fakeRegistration({ installing })
    const stateListeners = new Set<Listener>()
    installing.addEventListener = vi.fn((_type: string, listener: Listener) => {
      stateListeners.add(listener)
    })
    installing.removeEventListener = vi.fn((_type: string, listener: Listener) => {
      stateListeners.delete(listener)
    })
    const mutableRegistration = registration as ServiceWorkerRegistration & {
      waiting: ServiceWorker | null
      installing: ServiceWorker | null
    }
    registration.update = vi.fn().mockImplementation(async () => {
      setTimeout(() => {
        mutableRegistration.installing = null
        mutableRegistration.waiting = installing
        ;(installing as ServiceWorker & { state: string }).state = 'installed'
        stateListeners.forEach((listener) => listener())
      }, 0)
      return registration
    })
    installContainer(registration)

    const handle = await readyHandle()
    expect(await handle.checkForUpdate()).toBe(true)
  })

  it('installing 始终不落定：超时后安全降级为 false', async () => {
    const installing = fakeWorker('installing')
    const registration = fakeRegistration({ installing })
    installContainer(registration)

    const handle = await readyHandle()
    vi.useFakeTimers()
    const pending = handle.checkForUpdate()
    // 让 update() 的 await 先落定，使等待计时器挂上。
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(3000)
    await expect(pending).resolves.toBe(false)
  })
})

describe('confirmUpdate 回归', () => {
  it('向 waiting worker 发 SKIP_WAITING，并在 controllerchange 后刷新', async () => {
    const waiting = fakeWorker()
    const registration = fakeRegistration({ waiting })
    // confirmUpdate 只在已有 controller（即有旧版本接管）的场景下生效。
    const { controllerListeners } = installContainer(registration, false, fakeWorker())
    // jsdom 的 window.location.reload 不可 spy，替换整个 window 全局即可。
    const reload = vi.fn()
    vi.stubGlobal('window', { location: { reload } })

    const handle = await readyHandle()
    handle.confirmUpdate()

    expect(waiting.postMessage).toHaveBeenCalledWith('SKIP_WAITING')
    expect(reload).not.toHaveBeenCalled()
    controllerListeners.forEach((listener) => listener())
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
