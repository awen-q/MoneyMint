/**
 * 同步状态 store（批 5）
 *
 * 包装 SyncEngine 给组件用：状态徽标（SyncBadge）、同步页（P-18）、
 * 记一笔的离线兜底都走这里。引擎是单例；账本 id 复用 client 的
 * getLedgerId()（与 session 同源），切换账本后首次 sync 自动按新账本拉取。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { getLedgerId, syncApi } from '@/api/client'
import {
  SyncEngine,
  toSyncError,
  type SyncErrorInfo,
  type SyncState,
  type SyncStatus,
  type SyncSummary,
} from '@/core/sync/engine'
import { subscribeDataChange as subscribeCrossTabChange } from '@/core/sync/dataChangeChannel'
import { MemorySyncStore, type SyncStore } from '@/core/sync/localStore'
import { IdbSyncStore } from '@/core/sync/idbStore'
import { isRetryingPending } from '@/core/sync/models'
import type { LocalTxn, PendingChange, PendingEntry } from '@/core/sync/models'
import { configureTagMergeStore, tagMergeCoordinator } from '@/core/tagEvents/reconciler'
import { markDirty } from '@/stores/dataFreshness'

let engineInstance: SyncEngine | null = null
let storeInstance: SyncStore | null = null
let stopAutoSync: (() => void) | null = null
/** 同步变更源内部计数：供 SyncBadge / 观测使用；快照层不再订阅它。 */
const dataEpoch = ref(0)

/**
 * P1：非引擎路径（bootstrap / 标签批次 flush / syncNow 包装）的兜底错误通道。
 *
 * 这些路径过去用 `catch(() => undefined)` 完全吞错，页面无从反映；现在写进
 * 顶层错误 ref，由 store 暴露给徽标/同步页，但绝不向外抛，避免 UI 崩。
 */
const runtimeTopError = ref<SyncErrorInfo | undefined>(undefined)
function noteRuntimeError(phase: SyncErrorInfo['phase'], err: unknown): void {
  runtimeTopError.value = toSyncError(err, phase, Date.now())
}
function clearRuntimeError(): void {
  runtimeTopError.value = undefined
}

/**
 * 跨 tab 广播只做桥接：校验账本后转调全局脏标记。
 * 模块级注册一次，与 sync store 实例生命周期无关（页面存活期间始终有效）。
 */
subscribeCrossTabChange((event) => {
  const current = getLedgerId()
  if (current === null || current !== event.ledgerId) {
    return
  }
  dataEpoch.value += 1
  markDirty('cross-tab', event.ledgerId)
})

/** 取（或创建）底层存储：优先 IndexedDB，无则内存降级。 */
async function ensureStore(): Promise<SyncStore> {
  if (storeInstance !== null) return storeInstance
  if (typeof indexedDB !== 'undefined') {
    try {
      storeInstance = await IdbSyncStore.open()
      bindTagMergeStore(storeInstance)
      return storeInstance
    } catch {
      // 打开失败（隐私模式 / 配额）：降级内存，不阻塞记账。
    }
  }
  storeInstance = new MemorySyncStore()
  bindTagMergeStore(storeInstance)
  return storeInstance
}

/** 把 reconciler 与 SyncEngine 绑定到同一存储实例（tag_events 与 pending 仍物理隔离）。 */
function bindTagMergeStore(store: SyncStore): void {
  configureTagMergeStore(store)
}

/**
 * 同步成功后提交离线标签批次（P1）。
 *
 * 只调 reconciler 的 PUT /tags 窄通道，绝不走 engine.push / api.push；
 * 引擎的 pull/push 主循环保持原样。
 */
async function flushTagBatches(): Promise<void> {
  const ledgerId = getLedgerId()
  if (ledgerId === null) {
    return
  }
  try {
    await tagMergeCoordinator.flush(ledgerId)
  } catch (err) {
    noteRuntimeError('push', err)
  }
}

export const useSyncStore = defineStore('sync', () => {
  const status = ref<SyncStatus>('idle')
  const lastSyncAt = ref(0)
  const pendingCount = ref(0)
  const deadCount = ref(0)
  const deadItems = ref<PendingEntry[]>([])
  /** P1：全部 pending（含正常排队）；失败子集由同一个 isRetryingPending 口径派生。 */
  const pendingItems = ref<PendingEntry[]>([])
  const retryingItems = computed(() =>
    pendingItems.value.filter((entry) => isRetryingPending(entry)),
  )
  const retryingCount = computed(() => retryingItems.value.length)
  const quietCount = computed(() => Math.max(0, pendingCount.value - retryingCount.value))
  const stateTopError = ref<SyncErrorInfo | undefined>(undefined)
  const lastSyncSummary = ref<SyncSummary | undefined>(undefined)
  /** 引擎顶层错误优先；store 自身 catch 的错误作为兜底。 */
  const topError = computed(() => stateTopError.value ?? runtimeTopError.value)
  const initialized = ref(false)

  const hasBacklog = computed(() => pendingCount.value + deadCount.value > 0)

  async function ensureEngine(): Promise<SyncEngine> {
    if (engineInstance !== null) return engineInstance
    const store = await ensureStore()
    const engine = new SyncEngine(store, syncApi, () => getLedgerId())
    engine.subscribe((state: SyncState) => {
      status.value = state.status
      lastSyncAt.value = state.lastSyncAt
      pendingCount.value = state.pendingCount
      deadCount.value = state.deadCount
      stateTopError.value = state.lastSyncError
      lastSyncSummary.value = state.lastSyncSummary
      // P1：自动同步（无页面按钮）也要刷新明细，否则徽标的失败子集
      // 会停留在上次页面读取的快照，与同步页列表不一致。
      void loadQueues().catch(() => undefined)
      // P1：online / 定时 / 可见性触发的 sync 成功后统一 flush 标签批次。
      if (state.status === 'ok') {
        clearRuntimeError()
        void flushTagBatches()
      }
    })
    // pull 到真实变更 → 转调全局脏标记；只读观察，不改变同步库状态。
    engine.subscribeDataChange((event) => {
      dataEpoch.value += 1
      if (getLedgerId() !== event.ledgerId) {
        return
      }
      markDirty(event.reason, event.ledgerId)
    })
    engineInstance = engine
    return engine
  }

  /** 应用启动时调用：建引擎、订阅状态、挂自动同步。 */
  async function bootstrap(): Promise<void> {
    if (initialized.value) return
    initialized.value = true
    const engine = await ensureEngine()
    stopAutoSync = engine.startAutoSync()
    void engine.sync().then((outcome) => {
      if (outcome === 'ok') void flushTagBatches()
    }).catch((err: unknown) => {
      // 引擎内部已写 SyncState；这里兜住启动链上的意外（建存储/订阅失败等）。
      noteRuntimeError('lease', err)
    })
  }

  /** 手动触发同步（同步页按钮）。 */
  async function syncNow(): Promise<'ok' | 'offline' | 'error' | 'skipped'> {
    try {
      const engine = await ensureEngine()
      const outcome = await engine.sync()
      if (outcome === 'ok') {
        await flushTagBatches()
      }
      await loadQueues()
      return outcome
    } catch (err) {
      // 不向外抛：UI 按钮不该因同步包装层异常崩掉；错误写顶层通道供页面显示。
      noteRuntimeError('push', err)
      await loadQueues().catch(() => undefined)
      return 'error'
    }
  }

  /** 刷新队列计数与死信列表（同步页 / 徽标）。 */
  async function loadQueues(): Promise<void> {
    await ensureEngine()
    if (storeInstance === null) return
    const ledgerId = getLedgerId()
    if (ledgerId === null) {
      deadItems.value = []
      pendingItems.value = []
      pendingCount.value = 0
      deadCount.value = 0
      return
    }
    deadItems.value = await storeInstance.getPending(ledgerId, 'dead')
    pendingItems.value = await storeInstance.getPending(ledgerId, 'pending')
    pendingCount.value = pendingItems.value.length
    deadCount.value = deadItems.value.length
  }

  /** 离线兜底：本地落一笔交易并入队（AC-04）。uuid 为本地 `loc-*` 生成。 */
  async function recordTxnOffline(txn: LocalTxn, pending: PendingChange): Promise<void> {
    const engine = await ensureEngine()
    await engine.recordOffline({ txn, pending })
    await loadQueues()
  }

  /** 死信：重试（state 回 pending、清退避）。 */
  async function reviveDead(ids: number[]): Promise<void> {
    if (storeInstance === null) return
    const ledgerId = getLedgerId()
    if (ledgerId === null) return
    try {
      await storeInstance.reviveDead(ledgerId, ids)
      await loadQueues()
      void (await ensureEngine()).sync().then((outcome) => {
        if (outcome === 'ok') void flushTagBatches()
      }).catch((err: unknown) => {
        noteRuntimeError('push', err)
      })
    } catch (err) {
      noteRuntimeError('push', err)
    }
  }

  /**
   * 重试中的 pending 条目：立即重试（P1）。
   * 只走引擎的 requestRetry（内部 retryNow + sync，非 leader 跳过），避免多 tab 来回通知。
   */
  async function retryPending(ids: number[]): Promise<void> {
    if (ids.length === 0) return
    try {
      const engine = await ensureEngine()
      await engine.requestRetry(ids)
      await loadQueues()
    } catch (err) {
      noteRuntimeError('push', err)
      await loadQueues().catch(() => undefined)
    }
  }

  /** 死信：丢弃（用户在同步页明确确认后）。 */
  async function discardDead(ids: number[]): Promise<void> {
    if (storeInstance === null) return
    const ledgerId = getLedgerId()
    if (ledgerId === null) return
    await storeInstance.discardPending(ledgerId, ids)
    await loadQueues()
  }

  /** 卸载自动同步（测试 / 登出清理用）。 */
  function stopEngine(): void {
    if (stopAutoSync !== null) {
      stopAutoSync()
      stopAutoSync = null
    }
  }

  return {
    status,
    lastSyncAt,
    pendingCount,
    deadCount,
    deadItems,
    pendingItems,
    retryingItems,
    retryingCount,
    quietCount,
    topError,
    lastSyncSummary,
    hasBacklog,
    initialized,
    dataEpoch,
    bootstrap,
    syncNow,
    loadQueues,
    recordTxnOffline,
    retryPending,
    reviveDead,
    discardDead,
    stopEngine,
  }
})
