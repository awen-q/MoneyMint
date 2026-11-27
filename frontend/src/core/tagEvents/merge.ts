/**
 * 标签离线合并收敛内核（P1，纯函数）。
 *
 * 规则与服务端 `service.normalizeTags` / `canonicalTags` 同口径，且是前端
 * **唯一**一份规范化实现（编辑器、收敛、pull 重放、reconciler 全部 import 这里）：
 *   trim → 丢空 → 精确去重（大小写敏感）→ 字典序排序。
 *
 * 收敛要点（§2.5）：把服务端 tags 折叠为 `add@tags_updated_at@device_id=''`
 * 基线，本地事件按 LWW（先 ts、后 device_id）覆盖；remove 为墓碑且胜出；
 * 不同 tag 天然并集。跨设备冲突由服务端 CAS 串行化 + 409 re-pull 重收敛落地。
 *
 * 不触碰经济事实：本模块只产出 tags 数组 / LocalTxn 的标签字段。
 */
import type { LocalTxn, TagEvent, TagEventBatch } from '@/core/sync/models'

/** 墓碑保留默认：单交易最多 100 条、30 天内（D1，可配置常量）。 */
export const TAG_TOMBSTONE_KEEP = 100
export const TAG_TOMBSTONE_DAYS = 30

/** 收敛决策（服务端基线的 device_id 恒为空串，字典序最小）。 */
export interface TagDecision {
  tag: string
  op: 'add' | 'remove'
  ts: string
  device_id: string
}

/** pull 重放结果：交易仍 1 行，批次回写，冲突标签数用于非阻断提示。 */
export interface TagReplayResult {
  entity: LocalTxn
  batch: TagEventBatch | null
  conflictCount: number
}

/**
 * 与服务端同口径的标签规范化（唯一实现，编辑器 / 收敛 / 重放共用）。
 * 非字符串项直接丢弃，避免脏 wire 数据混进收敛基线。
 */
export function normalizeTags(input: string[] | unknown): string[] {
  const out: string[] = []
  if (!Array.isArray(input)) {
    return out
  }
  for (const raw of input) {
    if (typeof raw !== 'string') {
      continue
    }
    const value = raw.trim()
    if (value === '') {
      continue
    }
    let duplicated = false
    for (const existing of out) {
      if (existing === value) {
        duplicated = true
        break
      }
    }
    if (!duplicated) {
      out.push(value)
    }
  }
  out.sort()
  return out
}

/** 两个已规范化数组是否逐项相等（409 结果幂等判定）。 */
export function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

/** 宽松读取服务端平铺在错误体 / wire 上的字符串数组。 */
export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      out.push(item)
    }
  }
  return out
}

/** a 是否严格晚于 b：先比 ISO ts 字典序，再比 device_id 字典序。 */
export function later(a: TagDecision, b: TagDecision): boolean {
  if (a.ts !== b.ts) {
    return a.ts > b.ts
  }
  return a.device_id > b.device_id
}

/**
 * 单调混合时钟：同毫秒 / 时钟回拨时基于上一条 ts +1ms。
 * 输出 ISO 8601 UTC 毫秒串，可直接与后端 tags_updated_at 字典序比较。
 */
export function nextTs(prevTs = ''): string {
  const parsed = prevTs === '' ? Number.NaN : Date.parse(prevTs)
  const now = Date.now()
  const ms = Math.max(now, Number.isFinite(parsed) ? parsed + 1 : now)
  return new Date(ms).toISOString()
}

/** 批次内最大 ts（新事件必须严格晚于它；空串表示无历史）。 */
export function maxEventTs(events: TagEvent[]): string {
  let max = ''
  for (const event of events) {
    if (event.ts > max) {
      max = event.ts
    }
  }
  return max
}

/**
 * 收敛：serverTags + 本地 events → finalTags（确定性，同输入同输出）。
 *
 * 服务端基线 device_id='' 恒输给任意真实设备的同 ts 事件；
 * remove 胜出时该 tag 不进最终集合；不同 tag 各自决策 → 并集。
 */
export function converge(
  serverTags: string[],
  serverTagsUpdatedAt: string,
  events: TagEvent[],
): string[] {
  const win = new Map<string, TagDecision>()
  const baselineTs = typeof serverTagsUpdatedAt === 'string' ? serverTagsUpdatedAt : ''
  for (const tag of normalizeTags(serverTags)) {
    win.set(tag, { tag, op: 'add', ts: baselineTs, device_id: '' })
  }
  for (const event of events) {
    const tag = event.tag.trim()
    if (tag === '') {
      continue
    }
    const decision: TagDecision = {
      tag,
      op: event.op,
      ts: typeof event.ts === 'string' ? event.ts : '',
      device_id: typeof event.device_id === 'string' ? event.device_id : '',
    }
    const current = win.get(tag)
    if (current === undefined || later(decision, current)) {
      win.set(tag, decision)
    }
  }
  const final: string[] = []
  for (const [tag, decision] of win) {
    if (decision.op === 'add') {
      final.push(tag)
    }
  }
  return normalizeTags(final)
}

/**
 * 同时出现 add 与 remove 的标签数（服务端基线算作 add）。
 * 供编辑记录面板的浅色提示行显示「{n} 处冲突」，不阻断用户操作。
 */
export function mergeConflictCount(
  base: string[],
  updatedAt: string,
  events: TagEvent[],
): number {
  void updatedAt // ts 只参与 LWW 胜负；冲突只看「同 tag 两种意图」。
  const ops = new Map<string, Set<string>>()
  for (const tag of normalizeTags(base)) {
    ops.set(tag, new Set(['add']))
  }
  for (const event of events) {
    const tag = event.tag.trim()
    if (tag === '') {
      continue
    }
    const set = ops.get(tag) ?? new Set<string>()
    set.add(event.op)
    ops.set(tag, set)
  }
  let count = 0
  for (const set of ops.values()) {
    if (set.has('add') && set.has('remove')) {
      count += 1
    }
  }
  return count
}

/** 是否发生「同一 tag 既有 add 又有 remove」的合并冲突。 */
export function hasMergeConflict(base: string[], updatedAt: string, events: TagEvent[]): boolean {
  return mergeConflictCount(base, updatedAt, events) > 0
}

/**
 * 墓碑裁剪：成功后只保留最近 keep 条 remove（且只在 days 天内）。
 * 输入为全量事件（含已合并的 add/remove）；返回值只含被保留的 remove 事件。
 */
export function pruneTombstones(
  events: TagEvent[],
  keep = TAG_TOMBSTONE_KEEP,
  days = TAG_TOMBSTONE_DAYS,
): TagEvent[] {
  const tombstones: TagEvent[] = []
  for (const event of events) {
    if (event.op === 'remove') {
      tombstones.push(event)
    }
  }
  if (tombstones.length <= keep) {
    return tombstones
  }
  const cutoff = Date.now() - days * 86_400_000
  const recent = tombstones.filter((event) => Date.parse(event.ts) >= cutoff)
  recent.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
  const keptKeys = new Set<string>()
  for (const event of recent.slice(0, keep)) {
    keptKeys.add(`${event.tag}\u0000${event.ts}`)
  }
  return tombstones.filter((event) => keptKeys.has(`${event.tag}\u0000${event.ts}`))
}

/**
 * pull 重放（Memory / Idb 两实现共用，避免双份逻辑漂移）：
 * ① 先用服务端 entity 整条覆盖；② 若有 pending 标签事件，以最新服务端 tags
 * 为新基线收敛，写回 batch.baseTags 并把 txns[k].tags 换成预测值；
 * ③ 冲突标签数交给调用方发一次性非阻断提示。
 *
 * 始终只改既有 key 的 tags 字段，不新增 / 复制交易行。
 */
export function replayTagEvents(
  entity: LocalTxn,
  batch: TagEventBatch | null,
): TagReplayResult {
  const serverTags = normalizeTags(entity.tags)
  if (batch === null || batch.events.length === 0) {
    return { entity, batch, conflictCount: 0 }
  }
  const updatedAt = entity.tags_updated_at ?? ''
  const finalTags = converge(serverTags, updatedAt, batch.events)
  const conflictCount = mergeConflictCount(serverTags, updatedAt, batch.events)
  const nextBatch: TagEventBatch = {
    ...batch,
    baseTags: serverTags,
    conflictMerged: batch.conflictMerged === true || conflictCount > 0,
  }
  return {
    entity: { ...entity, tags: finalTags },
    batch: nextBatch,
    conflictCount,
  }
}
