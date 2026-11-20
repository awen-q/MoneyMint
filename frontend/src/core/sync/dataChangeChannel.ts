/**
 * 跨标签页「数据已变更」通道（T01）
 *
 * 只用 `storage` 事件：同源其它标签页写入 localStorage 时即时收到通知，
 * Safari 14.1 / iOS 14 原生支持。刻意不用 BC API——那是 Safari 14.1
 * 缺失的能力（见 core/pwa.ts:7），且命中 CI §14.7 兼容门禁禁用清单。
 *
 * 纯信号层：不 import 任何 store / API，事件只描述「哪个账本的快照失效了」，
 * 绝不写同步库、postings 或后端。所有访问都有 try 守卫，Node(Vitest)
 * 与隐私模式下降级为空操作而不抛错。
 */
import type { DataChangeEvent } from './engine'

/** localStorage 键（storage 事件按此 key 过滤）。 */
export const DATA_CHANGE_KEY = 'fambean:data-change'

/** 去重窗口：保留最近若干事件指纹，防止重复投递。 */
const MAX_SEEN = 200

let tabId = ''

/**
 * 本标签页稳定 id。自发自收过滤用；不持久化（刷新页面即新 tab 身份）。
 */
export function getTabId(): string {
  if (tabId === '') {
    const random = Math.random().toString(36).slice(2, 10)
    tabId = `${Date.now().toString(36)}-${random}`
  }
  return tabId
}

function isDataChangeEvent(value: unknown): value is DataChangeEvent {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const evt = value as Record<string, unknown>
  const reasons = ['local-write', 'pull-changes', 'generation-reset', 'cross-tab']
  return (
    typeof evt['ledgerId'] === 'number' &&
    Number.isSafeInteger(evt['ledgerId']) &&
    (evt['ledgerId'] as number) > 0 &&
    typeof evt['seq'] === 'number' &&
    Number.isSafeInteger(evt['seq']) &&
    typeof evt['reason'] === 'string' &&
    reasons.includes(evt['reason'] as string) &&
    typeof evt['tabId'] === 'string' &&
    (evt['tabId'] as string) !== '' &&
    typeof evt['at'] === 'number'
  )
}

/** 广播一次变更（storage 事件，失败静默降级）。 */
export function publishDataChange(evt: DataChangeEvent): void {
  if (!isDataChangeEvent(evt)) {
    return
  }
  try {
    if (typeof localStorage !== 'undefined') {
      // 带 tabId+seq 的唯一值：即使两笔变更发生在同一毫秒也不会被 storage 合并。
      localStorage.setItem(DATA_CHANGE_KEY, JSON.stringify(evt))
    }
  } catch {
    // 隐私模式 / 配额耗尽：本 tab 仍有即时刷新与 60s 同步兜底。
  }
}

/**
 * 订阅其它标签页的变更。返回取消函数。
 *
 * - storage 事件天然不触发源 tab，但仍校验 key / newValue / 形状与 tabId；
 * - 按 `tabId:seq` 去重，防止同一事件被重复投递；
 * - `cross-tab` 回声由消费方不再次 publish 切断（见 dataFreshness.markDirty）。
 */
export function subscribeDataChange(callback: (evt: DataChangeEvent) => void): () => void {
  const seen = new Set<string>()
  const dispatch = (raw: unknown): void => {
    if (!isDataChangeEvent(raw) || raw.tabId === getTabId()) {
      return
    }
    const fingerprint = `${raw.tabId}:${raw.seq}`
    if (seen.has(fingerprint)) {
      return
    }
    seen.add(fingerprint)
    if (seen.size > MAX_SEEN) {
      const oldest = seen.values().next()
      if (oldest.done !== true) {
        seen.delete(oldest.value)
      }
    }
    callback(raw)
  }

  const onStorage = (event: StorageEvent): void => {
    if (event.key !== DATA_CHANGE_KEY || event.newValue === null || event.newValue === '') {
      return
    }
    try {
      dispatch(JSON.parse(event.newValue) as unknown)
    } catch {
      // 损坏 JSON 一律忽略，绝不把解析异常冒泡到事件循环。
    }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage)
  }

  return () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage)
    }
    seen.clear()
  }
}
