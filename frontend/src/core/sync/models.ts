/**
 * 同步内核本地模型（批 5，§6.6）
 *
 * 与旧版 `sync_models.dart` / `local_store.dart` 行为逐条对齐：
 * - 本地实体以 uuid 为主键，账户/交易/待推队列/水位/uuid 映射五张表；
 * - 本地生成 uuid 用 `loc-` 前缀（旧版口径），push 后按 server_uuid 重映射；
 * - pending 携带死信字段（§6.6.1 #1）：attempts / last_error_code / next_retry_at /
 *   state(pending|dead)——旧版没有这些字段导致 4xx 无限重试，本版补齐。
 *
 * wire 结构（SyncChange / PullResult / PushResult / PushRequest）复用
 * `@/api/types`，与 31 端点契约一致，不重复定义。
 */
import type { SyncChange } from '@/api/types'

/** 本地分录：引用账户 uuid（本地 `loc-*` 或服务端 uuid，push 前重映射）。 */
export interface LocalPosting {
  account_uuid: string
  commodity: string
  amount: string
}

/** 本地账户（服务端 pull 实体 / 本地创建共用形态，字段名与 wire 一致）。 */
export interface LocalAccount {
  uuid: string
  name: string
  display_name?: string
  type: string
  open_date: string
  close_date?: string
  commodity_restriction?: string
  icon?: string
  color?: string
  parent_uuid?: string
  sub_type?: string
  sort_order?: number
}

/** 本地交易。 */
export interface LocalTxn {
  uuid: string
  date: string
  flag: string
  description: string
  tags: string[]
  /**
   * 标签原地更新的权威时间（服务端迁移 018 随 loadEntity 下发；旧响应缺失）。
   * P0 只做类型兼容与整条覆盖，不据此处做合并判定；P1 的 LWW 收敛再消费。
   */
  tags_updated_at?: string
  reversed_of?: string
  /** A-02：原交易「已冲正」标记，随 pull 的 op=update 整条覆盖下发；旧响应可能缺失。 */
  reversed_by?: string
  created_by_name?: string
  postings: LocalPosting[]
}

/**
 * 单条离线标签意图（P1）：删除写 remove 墓碑，不从数组抹掉。
 *
 * 与 `PendingChange` **物理隔离**：本类型只服务 IndexedDB `tag_events` store
 * 与 PUT /tags 窄通道，永不进入 pending / sync/push（经济事实同步）。
 */
export interface TagEvent {
  tag: string
  op: 'add' | 'remove'
  /** ISO 8601 UTC 毫秒串，与后端 tags_updated_at 同格式，可直接字典序比较。 */
  ts: string
  device_id: string
}

/**
 * 每笔交易一个标签事件批次（key = `${ledgerId}:${uuid}`）。
 *
 * `baseTags` 是最近一次 pull / commit 的服务端标签（PUT 的 CAS 基线）；
 * `clientOpId` 在批次首次创建时固定，跨 409 重试与页面刷新不变；
 * `committed` 标记本批已成功提交、events 仅存保留的 remove 墓碑（不重放）。
 */
export interface TagEventBatch {
  uuid: string
  baseTags: string[]
  events: TagEvent[]
  clientOpId: string
  conflictMerged?: boolean
  committed?: boolean
}

/**
 * 待推送变更。op 省略 = create（旧版口径）。
 * state：pending（待推 / 退避中）| dead（永久失败，同步页可见可丢弃）。
 */
export interface PendingChange {
  entity_type: 'account' | 'transaction' | 'commodity'
  op?: 'create' | 'delete' | 'close' | 'update'
  key: string
  entity: Record<string, unknown>
}

/**
 * P1 可观测字段（全部可选，兼容升级前落库的旧行）。
 *
 * `display_label` 在 `recordEntry` 写入时生成：UI 不再解析 `change.entity`，
 * 也不必猜测交易描述 / 账户名 / 币种 uuid 展示在哪一个字段。
 * 三个时间戳均为毫秒 epoch；`state_changed_at` 在转死信 / 改退避 / 立即重试时更新，
 * `last_attempt_at` 只在真实尝试（push 结果或退避）时更新。
 */
export interface PendingObservability {
  entity_type?: PendingChange['entity_type']
  op?: PendingChange['op']
  entity_uuid?: string
  display_label?: string
  created_at?: number
  state_changed_at?: number
  last_attempt_at?: number
}

/** 待推送条目（含死信元数据；id 由存储层分配，单调递增保序）。 */
export interface PendingEntry extends PendingObservability {
  id: number
  /**
   * 归属账本（P0 补写）。旧数据可能没有该字段：一律视为「未知归属」，
   * 不参与任何账本作用域的读写（详见 localStore.ownsPendingRow）。
   */
  ledger_id?: number
  state: 'pending' | 'dead'
  attempts: number
  last_error_code?: string
  last_error?: string
  /** 下次重试时间戳（ms）；0 表示立即可推。 */
  next_retry_at: number
  change: PendingChange
}

/** uuid 只取前 8 位作为人可读兜底摘要（旧版日志口径）。 */
export function shortUuid(uuid: string): string {
  const value = uuid.trim()
  return value.length > 8 ? value.slice(0, 8) : value
}

/** 从待推变更生成可观测摘要；纯函数，两个 SyncStore 实现共用。 */
export function describePendingChange(
  change: PendingChange,
): Required<Pick<PendingEntry, 'entity_type' | 'op' | 'entity_uuid' | 'display_label'>> {
  const entity = change.entity ?? {}
  const rawUuid =
    typeof entity['uuid'] === 'string' && entity['uuid'].trim() !== ''
      ? entity['uuid']
      : change.key
  const readText = (field: string): string => {
    const value = entity[field]
    return typeof value === 'string' ? value.trim() : ''
  }

  let label = ''
  if (change.entity_type === 'transaction') {
    label = readText('description') || shortUuid(rawUuid)
  } else if (change.entity_type === 'account') {
    label = readText('display_name') || readText('name') || shortUuid(rawUuid)
  } else if (change.entity_type === 'commodity') {
    label = rawUuid
  } else {
    label = shortUuid(rawUuid)
  }

  return {
    entity_type: change.entity_type,
    op: change.op ?? 'create',
    entity_uuid: rawUuid,
    display_label: label === '' ? shortUuid(rawUuid) : label,
  }
}

/**
 * 「重试中」= 尚未死信、但已失败过且当前有逐条错误或仍处在退避窗口。
 *
 * `retryNow` 会清掉逐条错误并把 next_retry_at 归零，条目随即回到「正常排队」，
 * 直到下一轮 push 再次失败才重新出现在 UI 的失败列表里。
 */
export function isRetryingPending(entry: PendingEntry, now: number = Date.now()): boolean {
  return (
    entry.state === 'pending' &&
    entry.attempts > 0 &&
    (typeof entry.last_error === 'string' && entry.last_error !== ''
      ? true
      : entry.next_retry_at > now)
  )
}

/** push 逐条结果（对齐 wire `results[]`；status 为字符串以兼容宽松解析）。 */
export interface SyncPushResultItem {
  index: number
  entity_type: string
  uuid?: string
  status: string
  accepted: boolean
  server_uuid?: string
  error?: string
  code?: string
  balances?: Array<{ commodity: string; amount: string }>
}

/**
 * 逐条结果分类（§6.6.1 #1 死信规则）：
 * - merged：自然键合并（server_uuid ≠ 本地 uuid）→ 重映射后重推；
 * - dead：永久失败码 → 转 dead，同步页可见；
 * - removed：成功 → 移除 pending；
 * - retry：临时失败 → 退避重试。
 * 码表与后端 `internal/domain/errors.go` 同源（契约测试断言）。
 */
export type ResultDisposition = 'removed' | 'merged' | 'dead' | 'retry'

/** 永久失败码（→ dead）。与后端稳定码白名单一致。 */
export const DEAD_CODES: readonly string[] = [
  'account_closed',
  'account_balance_not_zero',
  'opening_via_api_only',
  'idempotency_key_deleted',
  'idempotency_payload_mismatch',
  'validation',
]

/** 可重映射后重试的码（→ 全量 pull + 自然键重映射 + 重试一次）。 */
export const REMAP_RETRY_CODES: readonly string[] = ['account_not_found']

/** 按逐条结果分类（纯函数，便于契约测试）。 */
export function classifyResult(item: SyncPushResultItem): ResultDisposition {
  if (item.status !== 'ok') {
    if (item.code !== undefined && DEAD_CODES.includes(item.code)) return 'dead'
    if (item.code !== undefined && REMAP_RETRY_CODES.includes(item.code)) return 'retry'
    return 'retry' // 未知码按临时失败退避，不静默丢数据（RK-05）
  }
  if (
    item.server_uuid !== undefined &&
    item.server_uuid !== '' &&
    item.uuid !== '' &&
    item.server_uuid !== item.uuid
  ) {
    return 'merged'
  }
  return 'removed'
}

/** pull 变更的应用语义（对齐 local_store.dart `applyChange`；wire 省略 op = create）。 */
export type PullOp = 'create' | 'delete' | 'close' | 'update'

export function applyOpOf(change: SyncChange): PullOp {
  const raw = change.op as string | undefined
  const op = raw === undefined || raw === '' ? 'create' : raw
  return op as PullOp
}
