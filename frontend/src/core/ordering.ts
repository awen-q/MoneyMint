/**
 * 拖拽排序逻辑层（P-09 分类拖拽，§14.5 #2 Must：原生 HTML5 draggable，不引库）
 *
 * P0：拖动后的 uuid 顺序经 buildSortOrders 生成 0-based 连续 sort_order，
 * 整组提交 PATCH /api/accounts/sort-order（sync_log op=update 随事务落库）。
 */

import type { AccountSortOrderItem } from '@/api/types'

/** 把 `from` 位置的项移动到 `to` 位置；返回新数组（不可变），越界 / 相同位置原样返回。 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (
    from < 0 ||
    to < 0 ||
    from >= list.length ||
    to >= list.length ||
    from === to ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to)
  ) {
    return list.slice()
  }
  const next = list.slice()
  const moved = next.splice(from, 1)
  next.splice(to, 0, moved[0])
  return next
}

/** 按 sort_order 升序稳定排序（同序号保持原相对顺序）。 */
export function sortBySortOrder<T>(
  list: readonly T[],
  getOrder: (item: T) => number,
): T[] {
  return list
    .slice()
    .map((item, index) => ({ item, index, order: getOrder(item) }))
    .sort((a, b) => {
      if (a.order !== b.order) {
        return a.order - b.order
      }
      return a.index - b.index
    })
    .map((entry) => entry.item)
}

/**
 * 按传入顺序生成批量提交用的 sort_order（0-based 连续 index）。
 * 空 uuid / 重复 uuid 跳过（后端会把空 uuid 判为 400，重复 uuid 整批回滚）。
 */
export function buildSortOrders<T>(
  ordered: readonly T[],
  getUuid: (item: T) => string,
): AccountSortOrderItem[] {
  const out: AccountSortOrderItem[] = []
  const seen = new Set<string>()
  for (const item of ordered) {
    const uuid = getUuid(item)
    if (uuid === '' || seen.has(uuid)) {
      continue
    }
    seen.add(uuid)
    out.push({ uuid, sort_order: out.length })
  }
  return out
}
