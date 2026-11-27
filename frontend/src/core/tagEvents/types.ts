/**
 * 标签离线合并（P1）公共类型出口。
 *
 * 权威定义在 `@/core/sync/models.ts`（与 SyncStore 同层，避免循环依赖）；
 * 本模块只做 re-export，保证业务侧只有一个 import 入口，绝不出现第二套类型。
 */
export type { TagEvent, TagEventBatch } from '@/core/sync/models'

/** 用户对标签的原子意图（写事件前的输入形态）。 */
export interface TagIntent {
  tag: string
  op: 'add' | 'remove'
}

/** 追加事件时的上下文（批次首次创建需要基线 / 设备号）。 */
export interface AppendTagEventOptions {
  ledgerId?: number
  baseTags?: string[]
  tagsUpdatedAt?: string
  deviceId?: string
}

/** 提交选项：交互式提交只 PUT 一次并把 409 交还编辑器；重连 flush 最多 3 次。 */
export interface CommitBatchOptions extends AppendTagEventOptions {
  tagsUpdatedAt?: string
  deviceId?: string
  maxAttempts?: number
  /** P0「用最新标签重试」：保留用户原目标值，仅换 CAS 基线。 */
  targetTags?: string[]
  /** 重连 flush 路径发一次性 toast；编辑器交互路径已有内联提示，不发。 */
  notifyOnError?: boolean
}

/** 提交结果（区分成功 / 冲突 / 不可恢复错误，全部非阻断）。 */
export type CommitOutcome =
  | { status: 'saved'; response: import('@/api/types').TagEditResponse }
  | { status: 'conflict'; current: string[]; updatedAt: string }
  | { status: 'error'; code: string; message: string }
