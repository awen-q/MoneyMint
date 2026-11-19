/**
 * 流水筛选与 query 化（AC-16：筛选状态写入 URL，刷新 / 分享可完整还原）
 *
 * **本模块只负责「存取 + 序列化」，不做本地过滤**（T38）：筛选全部下推服务端
 * （dev-plan §5.8）。原 `applyFilters` 与 `matchKeyword` 已删除 —— 它们没有生产
 * 调用者，留着会让 review 的人以为前端也在校验 kind / 关键词语义，从而跳过
 * 服务端用例。`kind` 的三支口径现由后端 `a3775df` 承载，前端只保留取值类型
 * （`FilterKind`）与序列化（`filtersToServerQuery`）。
 *
 * hash 路由下用 vue-router 的 query；本模块只依赖 `Record<string, string|string[]|undefined>`
 * 形状的 query（与 vue-router LocationQuery 兼容），core 层不引入 vue-router。
 * 所有解析都容错：非法值一律回退默认，不抛错。
 */

export type FilterKind = 'all' | 'expense' | 'income' | 'transfer'

export interface TransactionFilters {
  /** `YYYY-MM-DD` 或空串（含端点）。 */
  from: string
  to: string
  kind: FilterKind
  /** 资金 / 分类账户 id（posting 命中即算）。 */
  account: number | null
  category: number | null
  /** 记账人（created_by_name 精确匹配），空串表示全部。 */
  member: string
  /**
   * 单个标签过滤（空串表示不限）。
   *
   * **单值而非多值**：高保真稿 `page-search` 的 `#sTag` 是一个 `<select>`（单选）。
   * 多值会让 `filtersToQuery` 的返回类型变成 `Record<string, string|string[]>`、
   * 并波及 `api/client` 的 `buildUrl`（当前只做 `String(value)`），代价远大于收益。
   * 后端 `tag` 的重复键能力保留，将来真要多选时不用改后端。
   */
  tag: string
  /**
   * 关键词（备注 / 分类名 / 账户名 / 成员 / 标签，五路匹配），空串表示全部。
   *
   * **必填**（不是可选）：可选会让每个调用方都判空，而其中一定有一处不判；
   * 空值语义由 `''` 承担，与其余字段的「空串 = 不筛」保持一致。
   * 实际匹配逻辑在 `core/search.ts` 的 `matchKeyword`（本模块只负责存取与 query 化）。
   * URL 键为 `q`（与 from/to/kind/view 等短键风格一致，且会被分享链接带出去）。
   */
  keyword: string
}

/** vue-router `LocationQuery` 兼容形状（数组元素可为 null）。 */
type QueryLike = Record<string, string | null | (string | null)[] | undefined>

const KINDS: readonly string[] = ['all', 'expense', 'income', 'transfer']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function emptyFilters(): TransactionFilters {
  return {
    from: '',
    to: '',
    kind: 'all',
    account: null,
    category: null,
    member: '',
    tag: '',
    keyword: '',
  }
}

function firstQuery(value: string | null | (string | null)[] | undefined): string {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        return item
      }
    }
    return ''
  }
  return typeof value === 'string' ? value : ''
}

function parseId(raw: string): number | null {
  if (raw === '' || !/^\d+$/.test(raw)) {
    return null
  }
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** 从 URL query 还原筛选；非法值回退默认（AC-16 读路径）。 */
export function filtersFromQuery(query: QueryLike): TransactionFilters {
  const filters = emptyFilters()
  const from = firstQuery(query.from)
  const to = firstQuery(query.to)
  if (DATE_RE.test(from)) {
    filters.from = from
  }
  if (DATE_RE.test(to)) {
    filters.to = to
  }
  const kind = firstQuery(query.kind)
  if (KINDS.indexOf(kind) >= 0) {
    filters.kind = kind as FilterKind
  }
  const account = parseId(firstQuery(query.account))
  if (account !== null) {
    filters.account = account
  }
  const category = parseId(firstQuery(query.category))
  if (category !== null) {
    filters.category = category
  }
  filters.member = firstQuery(query.member)
  filters.tag = firstQuery(query.tag)
  filters.keyword = firstQuery(query.q)
  return filters
}

/** 把筛选写回 query（空值省略，保证 URL 干净；AC-16 写路径）。 */
export function filtersToQuery(filters: TransactionFilters): Record<string, string> {
  const query: Record<string, string> = {}
  if (filters.from !== '') {
    query.from = filters.from
  }
  if (filters.to !== '') {
    query.to = filters.to
  }
  if (filters.kind !== 'all') {
    query.kind = filters.kind
  }
  if (filters.account !== null) {
    query.account = String(filters.account)
  }
  if (filters.category !== null) {
    query.category = String(filters.category)
  }
  if (filters.member !== '') {
    query.member = filters.member
  }
  if (filters.tag !== '') {
    query.tag = filters.tag
  }
  // 纯空白关键词不写入 URL：与 `hasActiveFilters` 的 `trim()` 判据保持一致，
  // 否则会出现「URL 里有 q、但清除筛选按钮不显示」的自相矛盾。
  if (filters.keyword.trim() !== '') {
    query.q = filters.keyword
  }
  return query
}

/**
 * 发往服务端的筛选参数**白名单**（`GET /api/transactions`，见 dev-plan §5.8）。
 *
 * 与 `filtersToQuery` 的分工：那个是**写 URL**（页面状态，含 `view` 这类 UI 键）；
 * 这个是**发请求**（只允许服务端认识的键）。两者混用会让 `?view=calendar` 之类
 * 的页面状态混进请求与缓存键，表现为「同一个请求因 UI 状态不同而被当成两次」。
 *
 * 改动此数组等于改后端契约，必须同步 `internal/handler` 的参数校验与
 * `filters.serverQuery.test.ts` 的一致性断言。
 */
export const SERVER_FILTER_KEYS: readonly string[] = [
  'from',
  'to',
  'kind',
  'account',
  'category',
  'member',
  'tag',
  'q',
  'limit',
  'cursor',
]

/** `filtersToServerQuery` 的分页/游标选项（不传即「不分页」，等价于后端 `limit` 缺省）。 */
export interface ServerQueryOptions {
  /** 每页条数；`0` 表示全量（CSV 导出用）。不传则不带该键。 */
  limit?: number
  /** keyset 游标（不透明串，**不进 URL**）。空串视为不传。 */
  cursor?: string
}

/**
 * 把筛选序列化为服务端请求参数（**白名单输出**）。
 *
 * 三条约束：
 * 1. **只输出 `SERVER_FILTER_KEYS` 里的键**。`ym` / `day` / `view` 是页面状态，
 *    发给服务端会被忽略，但会污染请求与被 fetch 缓存键误判。
 * 2. 与 `filtersToQuery` 的**取值口径逐字相同**（同样的非空判断、同样的 `q` 键），
 *    否则「URL 里看着有筛选、请求却没带」这类错会只在一个方向上暴露。
 * 3. `limit` / `cursor` 只在显式传入时出现：后端 `limit` 缺省 = 全量，
 *    前端**不得**为了「省流量」偷偷给个默认 20——那会把另外 8 处全量调用截断。
 *
 * @param filters 当前筛选
 * @param options 分页选项
 * @returns 可直接交给 `api.get(path, { query })` 的扁平对象
 */
export function filtersToServerQuery(
  filters: TransactionFilters,
  options: ServerQueryOptions = {},
): Record<string, string> {
  const query: Record<string, string> = {}
  if (filters.from !== '') {
    query.from = filters.from
  }
  if (filters.to !== '') {
    query.to = filters.to
  }
  if (filters.kind !== 'all') {
    query.kind = filters.kind
  }
  if (filters.account !== null) {
    query.account = String(filters.account)
  }
  if (filters.category !== null) {
    query.category = String(filters.category)
  }
  if (filters.member !== '') {
    query.member = filters.member
  }
  if (filters.tag !== '') {
    query.tag = filters.tag
  }
  // 纯空白关键词不发出：服务端会把它当成「有一个筛选」，与前端 `hasActiveFilters` 不一致。
  if (filters.keyword.trim() !== '') {
    query.q = filters.keyword
  }
  if (options.limit !== undefined) {
    query.limit = String(options.limit)
  }
  if (options.cursor !== undefined && options.cursor !== '') {
    query.cursor = options.cursor
  }
  return query
}

/** 是否存在生效筛选（供 UI 显示「清除筛选」）。 */
export function hasActiveFilters(filters: TransactionFilters): boolean {
  return (
    filters.from !== '' ||
    filters.to !== '' ||
    filters.kind !== 'all' ||
    filters.account !== null ||
    filters.category !== null ||
    filters.member !== '' ||
    filters.tag !== '' ||
    // 用 trim：纯空格不算「有筛选」，否则用户敲了个空格就冒出「清除筛选」按钮。
    filters.keyword.trim() !== ''
  )
}
