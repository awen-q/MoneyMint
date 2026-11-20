/**
 * 全局「需要刷新」脏标记中枢（T04，融合方案）
 *
 * 三类变更源（本地写 / 同步 pull / 跨 tab 广播）统一收敛为一个信号：
 * `dirtyByLedger[ledgerId].version`。快照层（ledgerData）只 watch 这一个
 * version，`savedEpoch` / `dataEpoch` 降级为变更源内部计数，不再参与快照失效。
 *
 * 双触发：
 * 1. 置脏即时半边——version 变化被 ledgerData 的 watch 捕获，页面 visible 时
 *    立刻 `checkAndReload()`（不依赖用户切页/聚焦，保证前台实时性）；
 * 2. 激活补偿半边——`visibilitychange` / `window focus` / `router.afterEach`
 *    调 `checkAndReload()`，version > 消费水位才 reload，已消费即 noop。
 *
 * 去重：version + 消费水位；BroadcastChannel 自发自收由通道按 tabId 过滤；
 * 消费方收到 `cross-tab` 后不再次 publish，避免回声循环。
 *
 * 账本隔离：标记按 ledgerId 分桶；未选择账本时用哨兵 0（仍要让
 * ledgerData 走「尚未选择账本」分支显示错误，不能静默吞掉）。
 */
import { defineStore } from 'pinia'
import { reactive } from 'vue'

import { readLedgerId } from '@/core/storage'
import { getTabId, publishDataChange } from '@/core/sync/dataChangeChannel'
import type { DataChangeEvent, DataChangeReason } from '@/core/sync/engine'

/** 变更原因（与 DataChangeReason 同一组字面量）。 */
export type DirtyReason = DataChangeReason

/** 一条脏标记；version 单调递增，配合消费水位判断「自上次刷新以来是否变过」。 */
export interface DirtyMark {
  ledgerId: number
  version: number
  reason: DirtyReason
  tabId: string
  at: number
}

/** 按账本分桶的脏标记（模块级单例，Pinia store 只是它的门面）。 */
export const dirtyByLedger = reactive<Record<number, DirtyMark>>({})

/** 每个账本已消费到的 version（不是 UI 状态，无需响应式）。 */
const consumedByLedger = new Map<number, number>()

/** ledgerData 注册的 reload 回调；避免 dataFreshness 反向 import store 造成环。 */
type ReloadHandler = (ledgerId: number) => void
let reloadHandler: ReloadHandler | null = null

/** 未选择账本时的哨兵桶（真实账本 id 从 1 起）。 */
const NO_LEDGER_KEY = 0

/** 归一账本 id：显式值优先，其次持久化账本，最后落到哨兵 0。 */
function ledgerKeyOf(ledgerId?: number | null): number {
  if (typeof ledgerId === 'number' && Number.isSafeInteger(ledgerId) && ledgerId > 0) {
    return ledgerId
  }
  const persisted = readLedgerId()
  return persisted !== null && persisted > 0 ? persisted : NO_LEDGER_KEY
}

/** 注册快照 reload 回调，返回注销函数（Pinia scope 销毁时调用）。 */
export function registerReloadHandler(handler: ReloadHandler): () => void {
  reloadHandler = handler
  return () => {
    if (reloadHandler === handler) {
      reloadHandler = null
    }
  }
}

/** 页面是否处于可刷新状态；测试(Node)无 document 时按 visible 处理。 */
export function isPageVisible(): boolean {
  if (typeof document === 'undefined') {
    return true
  }
  return document.visibilityState !== 'hidden'
}

/**
 * 置脏：version+1，visible 时由 ledgerData 的 watch 即时 reload；
 * 同时广播其它 tab。`cross-tab` 来源不再广播，防止 A→B→A 无限回声。
 */
export function markDirty(reason: DirtyReason, ledgerId?: number | null): void {
  const key = ledgerKeyOf(ledgerId)
  const previous = dirtyByLedger[key]
  const version = (previous === undefined ? 0 : previous.version) + 1
  const mark: DirtyMark = {
    ledgerId: key,
    version,
    reason,
    tabId: getTabId(),
    at: Date.now(),
  }
  dirtyByLedger[key] = mark

  if (reason !== 'cross-tab' && key !== NO_LEDGER_KEY) {
    const event: DataChangeEvent = {
      ledgerId: key,
      seq: version,
      reason,
      tabId: mark.tabId,
      at: mark.at,
    }
    publishDataChange(event)
  }
}

/** 返回当前 version 并记为「已消费」。 */
export function consume(ledgerId?: number | null): number {
  const key = ledgerKeyOf(ledgerId)
  const version = dirtyByLedger[key] === undefined ? 0 : dirtyByLedger[key].version
  consumedByLedger.set(key, version)
  return version
}

/**
 * 只读检查 + 必要时触发一次 reload。
 *
 * 消费水位在 reload **发起时**推进：置脏即时触发与激活补偿因此不会重复拉；
 * reload 失败也不回退水位——下一次真实变更会再 bump version 从而可重试。
 */
export function checkAndReload(ledgerId?: number | null): boolean {
  const key = ledgerKeyOf(ledgerId)
  const mark = dirtyByLedger[key]
  if (mark === undefined) {
    return false
  }
  const consumed = consumedByLedger.get(key) ?? 0
  if (mark.version <= consumed || reloadHandler === null) {
    return false
  }
  consumedByLedger.set(key, mark.version)
  reloadHandler(mark.ledgerId)
  return true
}

/** 供需要 store 形态的调用方 / 可观测性使用；状态与纯函数同源。 */
export const useDataFreshnessStore = defineStore('dataFreshness', () => ({
  dirtyByLedger,
  markDirty,
  consume,
  checkAndReload,
  isPageVisible,
}))
