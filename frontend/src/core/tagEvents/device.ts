/**
 * 设备标识与本地批次号（P1）。
 *
 * `stableDeviceId` 从 TagInlineEditor.vue 抽出，编辑器 / 事件存储 / reconciler
 * 共用同一 id（localStorage key 保持不变，兼容 P0 已缓存的设备号）。
 * Safari 14.1 兼容：不用 crypto.randomUUID，只用 getRandomValues / Math.random。
 *
 * 批次号存 meta store `tagOpSeq.<ledgerId>`，由存储层在同一事务里原子 +1，
 * 保证 `clientOpId = device_id:seq` 在一次离线会话内单调且唯一。
 */
import type { SyncStore } from '@/core/sync/localStore'

const DEVICE_ID_KEY = 'fambean.tagEditDeviceId'

/** 本机稳定 device id（隐私模式 / 无 localStorage 时降级为内存值）。 */
export function stableDeviceId(): string {
  try {
    if (typeof localStorage !== 'undefined') {
      const cached = localStorage.getItem(DEVICE_ID_KEY)
      if (cached !== null && cached !== '') {
        return cached
      }
    }
  } catch {
    // 隐私模式禁用存储：本次会话内用内存值即可，不阻断审计。
  }

  const bytes = new Uint8Array(8)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  let hex = ''
  for (let i = 0; i < bytes.length; i += 1) {
    hex += (bytes[i] + 0x100).toString(16).slice(1)
  }
  const id = `web-${hex}`
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DEVICE_ID_KEY, id)
    }
  } catch {
    // 写失败不影响本次请求。
  }
  return id
}

/** 取（并原子 +1）账本级标签批次号；存储层保证同一事务内读-改-写。 */
export async function getOrCreateSeq(store: SyncStore, ledgerId: number): Promise<number> {
  return store.nextTagOpSeq(ledgerId)
}

/** 由设备号与批次号拼出固定 client_op_id。 */
export function makeClientOpId(deviceId: string, seq: number): string {
  return `${deviceId}:${seq}`
}
