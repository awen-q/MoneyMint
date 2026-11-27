/**
 * 标签合并策略开关（P1 默认客户端收敛）。
 *
 * - 'client'：本期实现——本地 events → converge → PUT /tags（§2.5 / §3）。
 * - 'server'：方案 C 退路——攒原始事件整批 POST 给服务端重放。
 *   本期**不实现**该逻辑，也不发批量端点请求；仅保留开关位与端点契约注释。
 *
 * 方案 C 端点契约（备查，本期不落地）：
 *   POST /api/transactions/{uuid}/tag-event-batch
 *   Body: { events: TagEvent[], base_tags: string[], device_id?: string,
 *           client_op_id: string }
 *   Resp: 200 TagEditResponse（同 PUT /tags）
 * 权限复用 computeCanEdit；幂等复用 (ledger_id, client_op_id) 唯一索引；
 * 收敛主体为服务端，前端不再自行 fold。启用前须重评 MaxOpenConns=1 下的
 * 批量重放事务。
 */
export type TagMergeStrategy = 'client' | 'server'

export const TAG_MERGE_STRATEGY: TagMergeStrategy = 'client'
