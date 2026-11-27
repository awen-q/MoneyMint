/**
 * 类型化 fetch 客户端（批 1，E-07 / E-08 / D-7）
 *
 * 统一收口：
 * - `credentials:'include'`，Cookie 会话的写操作自动带 `X-CSRF`（后端缺该头 403）；
 * - `X-Ledger-Id` 强制注入并断言，业务端点缺失直接抛错，绝不静默回退默认账本（E-08）；
 * - 401 single-flight 刷新队列（并发只发一次 refresh，其余挂起复用结果），
 *   refresh 走裸 fetch 绕过拦截器防递归，重试一次仍失败统一登出（E-07）；
 * - 428 跳改密页；4xx 不重试 / 5xx 最多重试 3 次；fetch 失败给离线提示；
 * - 错误统一 `ApiError.fromBody` 解析；`Idempotency-Key` 透传（G-04）。
 *
 * 所有请求都用相对 `/api` 路径，禁止硬编码后端地址（E-06）。
 */
import { parseIdentityHeader, type DiffItem } from '@/core/batch3'
import { clearLegacyToken } from '@/core/storage'
import { t } from '@/i18n'
import { ApiError } from './errors'
import { API_ROUTES, isNoLedgerPath } from './routes'
import type {
  AccountCreated,
  AccountListResponse,
  AssetSeriesResponse,
  BatchSortRequest,
  BatchSortResponse,
  AddMemberRequest,
  AddMemberResponse,
  AuthResult,
  BackupItem,
  BackupListResponse,
  ChangePasswordRequest,
  ChangePasswordResponse,
  CreateAccountRequest,
  CreateLedgerRequest,
  BalancePreview,
  BalanceResult,
  SetBalanceRequest,
  CommodityCreated,
  CommodityListResponse,
  CreateCommodityRequest,
  CreateTransactionRequest,
  DeleteCommodityResponse,
  DeleteLedgerResponse,
  HealthResponse,
  IdentityCheckResult,
  ImportPreviewResult,
  ImportResult,
  ImportUndoResult,
  LedgerListResponse,
  LedgerView,
  LoginRequest,
  LogoutResponse,
  MeResponse,
  MemberListResponse,
  OkResponse,
  OpeningResult,
  OpeningView,
  PurgeResult,
  RegisterRequest,
  RegistrationSettings,
  ResetMemberPasswordRequest,
  RestorePreviewResult,
  RestoreResult,
  RevokeOtherSessionsResponse,
  RevokeSessionResponse,
  SessionsResponse,
  SetOpeningRequest,
  SetRegistrationRequest,
  SyncPullResponse,
  PushChange,
  SyncPushResponse,
  TagEditResponse,
  TagEditsResponse,
  TransactionCreated,
  TransactionListPage,
  TransactionListQuery,
  TransactionListResponse,
  TransactionUpdated,
  UpdateTagsRequest,
  TrashListResponse,
  UpdateAccountRequest,
  UpdateAccountResponse,
  UpdateLedgerRequest,
  UpdateMemberRequest,
  UpdateMemberResponse,
} from './types'

// 启动时清理旧版 localStorage token（§13 D-7 实施清单 #7）。
// core/storage 带 typeof 守卫，Node / Vitest 环境下静默降级。
clearLegacyToken()

/** 创建交易的实际响应（后端附带幂等命中标记，types.ts 的批 0 类型未含该字段）。 */
export interface TransactionCreateResult extends TransactionCreated {
  idempotent?: boolean
}

/** 单次请求的选项。 */
export interface ApiRequestOptions {
  method?: string
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  headers?: Record<string, string>
  /** 幂等键，透传为 `Idempotency-Key` 请求头（G-04）。 */
  idempotencyKey?: string
  signal?: AbortSignal
  /** 探测登录态 / 公开端点不走 401 刷新，避免无意义的 refresh 循环。 */
  skipRefresh?: boolean
  /** 内部标记：本次请求已完成一次 401 刷新重试。 */
  refreshed?: boolean
  /** 内部标记：5xx 已重试次数。 */
  retryCount?: number
  /**
   * 响应体解析方式：`json`（默认，文本 → JSON.parse）或 `blob`（二进制下载）。
   * 批 3 的导出 / 备份下载用 blob；错误响应仍按 JSON 解析以保留文案。
   */
  responseType?: 'json' | 'blob'
}

/** 带响应头的请求结果（导出不平告警需要读 `X-Ledger-Balanced` / `X-Ledger-Diffs`）。 */
export interface ApiResponseMeta<T> {
  data: T
  headers: Headers
}

/** 客户端回调（由 router 注入，避免 api 层反向依赖路由 / store）。 */
export interface ApiClientHooks {
  /** 401 刷新失败或重试仍失败：统一登出。 */
  onUnauthorized?: () => void
  /** 428「必须先改密」：跳改密页。 */
  onPasswordChangeRequired?: () => void
}

type LedgerIdProvider = () => number | null

/** 可注入的 fetch：生产用原生 fetch；单测注入 mock，避免污染 Vitest 自身的 fetch 通信。 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

const SAFE_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS']

let ledgerIdProvider: LedgerIdProvider = () => null
let hooks: ApiClientHooks = {}
let refreshTask: Promise<boolean> | null = null
let fetchImpl: FetchLike = (input, init) => fetch(input, init)

/** 注入 fetch 实现；传 null 复位为原生 fetch（仅测试 / 特殊环境使用）。 */
export function setFetchImplementation(impl: FetchLike | null): void {
  fetchImpl = impl === null ? (input, init) => fetch(input, init) : impl
}

/** 注册账本 id 提供者：让 session store 成为唯一真相源。 */
export function setLedgerIdProvider(provider: LedgerIdProvider): void {
  ledgerIdProvider = provider
}

/** 固定账本 id（测试与简单场景使用）。 */
export function setLedgerId(id: number | null): void {
  ledgerIdProvider = () => id
}

/** 当前账本 id（null 表示未选择，业务请求将被拒绝）。 */
export function getLedgerId(): number | null {
  return ledgerIdProvider()
}

/** 注入 401 / 428 的全局回调（router 在模块加载时注册一次）。 */
export function setApiClientHooks(next: ApiClientHooks): void {
  hooks = next
}

function notifyUnauthorized(): void {
  if (hooks.onUnauthorized !== undefined) {
    hooks.onUnauthorized()
  }
}

/**
 * 同一批并发 401 的登出去重（不引入永久门闩）。
 *
 * `skipRefresh` / `refreshed:true` 两类 401 不共享 refreshTask，无法借用其
 * 局部标志；这里用**随微任务自动复位**的批次窗口：同一微任务批次内只通知
 * 一次，微任务结束自动复位，下一批天然可再次通知。既满足「同一时刻并发
 * 到达的一批 401 只登出一次」，又没有「忘记复位」的路径——不会像模块级
 * 永久门闩那样在 skipRefresh 路径上锁死。
 */
let batchNotified = false
let batchResetScheduled = false

function notifyUnauthorizedInBatch(): void {
  if (!batchNotified) {
    batchNotified = true
    notifyUnauthorized()
  }
  if (!batchResetScheduled) {
    batchResetScheduled = true
    queueMicrotask(() => {
      batchNotified = false
      batchResetScheduled = false
    })
  }
}

function notifyPasswordChangeRequired(): void {
  if (hooks.onPasswordChangeRequired !== undefined) {
    hooks.onPasswordChangeRequired()
    return
  }
  // 未注入 router 时（例如单测 / 独立入口），hash 路由也能兜底跳转。
  if (typeof window !== 'undefined' && typeof window.location !== 'undefined') {
    window.location.hash = '#/change-password'
  }
}

function buildUrl(path: string, query?: ApiRequestOptions['query']): string {
  if (query === undefined) {
    return path
  }
  const parts: string[] = []
  const keys = Object.keys(query)
  for (const key of keys) {
    const value = query[key]
    if (value === undefined) {
      continue
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return parts.length > 0 ? `${path}?${parts.join('&')}` : path
}

function buildHeaders(
  path: string,
  method: string,
  options: ApiRequestOptions,
): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  // FormData（M2 恢复的 multipart 上传）交给浏览器自动生成带 boundary 的
  // Content-Type；JSON 体仍显式声明。
  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  // D-7：Cookie 会话的非 GET/HEAD/OPTIONS 写操作必须带 X-CSRF。
  if (SAFE_METHODS.indexOf(method) < 0) {
    headers['X-CSRF'] = '1'
  }
  // E-08：业务端点强制注入并断言，缺失即抛错，绝不回退默认账本 id=1。
  if (!isNoLedgerPath(path)) {
    const ledgerId = ledgerIdProvider()
    if (ledgerId === null || ledgerId <= 0) {
      throw new ApiError(0, '尚未选择账本，业务请求缺少 X-Ledger-Id', {
        code: 'ledger_id_required',
      })
    }
    headers['X-Ledger-Id'] = String(ledgerId)
  }
  if (options.idempotencyKey !== undefined && options.idempotencyKey !== '') {
    headers['Idempotency-Key'] = options.idempotencyKey
  }
  const extra = options.headers
  if (extra !== undefined) {
    const keys = Object.keys(extra)
    for (const key of keys) {
      headers[key] = extra[key]
    }
  }
  return headers
}

async function readBody(
  res: Response,
  responseType: 'json' | 'blob',
  ok: boolean,
): Promise<unknown> {
  // 错误响应即使声明 blob 也按 JSON 文本解析，保证 ApiError.fromBody 拿得到文案。
  if (responseType === 'blob' && ok) {
    try {
      return await res.blob()
    } catch {
      return undefined
    }
  }
  let text = ''
  try {
    text = await res.text()
  } catch {
    return undefined
  }
  if (text === '') {
    return undefined
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/**
 * 裸 fetch 刷新：绕过 request 拦截器，避免 401 → refresh → 401 递归。
 * refresh 本身是 POST，Cookie 会话同样需要 X-CSRF（后端 middleware 实测）。
 */
async function rawRefresh(): Promise<boolean> {
  try {
    const res = await fetchImpl(API_ROUTES.refresh, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json', 'X-CSRF': '1' },
    })
    return res.ok === true
  } catch {
    return false
  }
}

/**
 * single-flight：并发 401 只创建一个 refresh 任务，其余请求挂起复用同一结果。
 *
 * 「统一登出」的去重门闩是本轮 refreshTask 的**局部闭包变量**，不设模块级
 * 全局状态：同一批挂起请求共享它、只通知一次；不同批（不同 refreshTask）
 * 天然互不干扰，因此不需要任何复位点，也不会出现「不创建 refreshTask 的
 * 401 路径把全局门闩永久锁死」。不走 refreshSession 的独立请求（skipRefresh
 * 探测端点 / refreshed:true 重试）由 401 分支按微任务批次去重通知。
 *
 * 双回调仍负责清空 refreshTask 并返回 ok / false，原语义不变。
 */
function refreshSession(): Promise<boolean> {
  if (refreshTask === null) {
    let notified = false
    const notifyOnce = (): void => {
      if (notified) {
        return
      }
      notified = true
      notifyUnauthorized()
    }
    const task = rawRefresh()
    refreshTask = task.then(
      (ok) => {
        refreshTask = null
        if (!ok) {
          notifyOnce()
        }
        return ok
      },
      () => {
        refreshTask = null
        notifyOnce()
        return false
      },
    )
  }
  return refreshTask
}

/**
 * 生成 UUID v4 形态的一次性幂等键。
 * 禁用 `crypto.randomUUID`（Safari 14.1 不支持，§14.7 API 扫描清单），
 * 改用 `getRandomValues` 并以 Math.random 兜底。
 */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16)
  const cryptoObj: Crypto | undefined =
    typeof crypto === 'undefined' ? undefined : crypto
  if (cryptoObj !== undefined && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex: string[] = []
  for (let i = 0; i < bytes.length; i += 1) {
    hex.push((bytes[i] + 0x100).toString(16).slice(1))
  }
  return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`
}

/**
 * 发起一次 API 请求并返回响应头。
 *
 * 批 3 新增：导出 / 备份下载既要二进制体，也要 `X-Ledger-*` 响应头做不平告警。
 * 401 刷新、428、4xx 不重试 / 5xx 最多 3 次等边界与 `request` 完全共用。
 *
 * @throws ApiError 4xx / 5xx / 网络失败 / 缺少账本上下文。
 */
export async function requestWithMeta<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<ApiResponseMeta<T>> {
  const method = (options.method === undefined ? 'GET' : options.method).toUpperCase()
  // buildHeaders 会同步断言 X-Ledger-Id；缺失时不发出任何请求。
  const headers = buildHeaders(path, method, options)
  const init: RequestInit = {
    method,
    credentials: 'include',
    headers,
  }
  if (options.body !== undefined) {
    init.body = options.body instanceof FormData ? options.body : JSON.stringify(options.body)
  }
  if (options.signal !== undefined) {
    init.signal = options.signal
  }

  let res: Response
  try {
    res = await fetchImpl(buildUrl(path, options.query), init)
  } catch (cause) {
    throw new ApiError(0, t('apiErrors.network_error'), {
      code: 'network_error',
      details: { cause: String(cause) },
    })
  }

  const responseType = options.responseType === 'blob' ? 'blob' : 'json'
  const body = await readBody(res, responseType, res.ok)

  if (res.status === 401) {
    if (options.skipRefresh === true || options.refreshed === true) {
      // 不进刷新队列的独立请求（自服务探测 / 已重试过一次仍 401）：
      // 同一微任务批次内并发到达时只通知一次，跨批自动复位、不锁死。
      notifyUnauthorizedInBatch()
      throw ApiError.fromBody(401, body)
    }
    const ok = await refreshSession()
    if (!ok) {
      // 登出已由该 refreshTask 的失败分支统一触发；挂起请求只 reject。
      throw ApiError.fromBody(401, body)
    }
    // Cookie 轮换后旧 token 立即失效，重试会自动携带新 Cookie。
    return requestWithMeta<T>(path, { ...options, refreshed: true })
  }

  if (res.status === 428) {
    notifyPasswordChangeRequired()
    throw ApiError.fromBody(428, body)
  }

  if (!res.ok) {
    const retryCount = options.retryCount === undefined ? 0 : options.retryCount
    if (res.status >= 500 && retryCount < 3) {
      return requestWithMeta<T>(path, { ...options, retryCount: retryCount + 1 })
    }
    throw ApiError.fromBody(res.status, body)
  }

  if (res.status === 204 || body === undefined) {
    return { data: undefined as T, headers: res.headers }
  }
  return { data: body as T, headers: res.headers }
}

/** 发起一次 API 请求（只取响应体，批 0~2.5 的既有调用零改动）。 */
export async function request<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  return (await requestWithMeta<T>(path, options)).data
}

/** 常用方法的薄封装。 */
export const api = {
  get<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'GET' })
  },
  post<T>(path: string, body?: unknown, options: ApiRequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'POST', body })
  },
  put<T>(path: string, body?: unknown, options: ApiRequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'PUT', body })
  },
  patch<T>(path: string, body?: unknown, options: ApiRequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'PATCH', body })
  },
  delete<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    return request<T>(path, { ...options, method: 'DELETE' })
  },
}

/**
 * 资产序列端点（B6 / T61）：年度资产 / 负债 / 净资产月末末值。
 *
 * **必须显式传 `commodity`**：省略时服务端取账本默认币种，用户切币种后曲线会不变
 * （且不报错）。返回恒 12 个点，金额是定点字符串 —— 前端直接显示，不要 parseFloat。
 */
export const assetSeriesApi = {
  series(year: number, commodity: string): Promise<AssetSeriesResponse> {
    return api.get<AssetSeriesResponse>(API_ROUTES.assetsSeries, {
      query: { year, commodity },
    })
  },
}

/** 认证端点（公开 / 自服务，均在 X-Ledger-Id 例外清单内）。 */
export const authApi = {
  login(body: LoginRequest): Promise<AuthResult> {
    return api.post<AuthResult>(API_ROUTES.login, body, { skipRefresh: true })
  },
  register(body: RegisterRequest): Promise<AuthResult> {
    return api.post<AuthResult>(API_ROUTES.register, body, { skipRefresh: true })
  },
  me(): Promise<MeResponse> {
    return api.get<MeResponse>(API_ROUTES.me, { skipRefresh: true })
  },
  logout(): Promise<LogoutResponse> {
    return api.post<LogoutResponse>(API_ROUTES.logout, undefined, { skipRefresh: true })
  },
  changePassword(body: ChangePasswordRequest): Promise<ChangePasswordResponse> {
    return api.post<ChangePasswordResponse>(API_ROUTES.changePassword, body, {
      skipRefresh: true,
    })
  },
}

/** 账本清单端点（例外清单，不带账本上下文）。 */
export const ledgerApi = {
  list(): Promise<LedgerListResponse> {
    return api.get<LedgerListResponse>(API_ROUTES.ledgers)
  },
}

/**
 * 把 `/api/accounts/{uuid}` 里的 `{key}` 占位符替换为实际值
 * （encodeURIComponent，防注入路径段）。替换后的路径仍由 request 统一
 * 注入 X-CSRF / X-Ledger-Id 并断言。
 */
export function formatApiPath(
  template: string,
  params: Record<string, string>,
): string {
  let out = template
  const keys = Object.keys(params)
  for (const key of keys) {
    out = out.split(`{${key}}`).join(encodeURIComponent(params[key]))
  }
  return out
}

/** 账户端点（业务端点，必须携带 X-Ledger-Id）。 */
export const accountApi = {
  /**
   * 账户列表。
   *
   * **`includeClosed` 默认 `false`**：后端缺省只返未关户账户，7+ 处既有调用
   * （记账账户选择器、账户管理、分类/币种/设置页等）都依赖这个语义，
   * 不存在「顺手把它改成 true」的余地——**记账时选到已关户账户**是这条改动
   * 最坏的后果。
   *
   * 需要看到关户账户的只有「资产页 / 账户管理」这类需要完整视图的场景，
   * 目前由 `ledgerData` 显式传 `true`（store 只给全量原始数据，过滤留页面）。
   *
   * @param opts.includeClosed 是否包含已关户账户
   */
  list(opts: { includeClosed?: boolean } = {}): Promise<AccountListResponse> {
    if (opts.includeClosed !== true) {
      return api.get<AccountListResponse>(API_ROUTES.accounts)
    }
    return api.get<AccountListResponse>(API_ROUTES.accounts, {
      query: { include_closed: '1' },
    })
  },
  create(body: CreateAccountRequest): Promise<AccountCreated> {
    return api.post<AccountCreated>(API_ROUTES.accounts, body)
  },
  /**
   * 批量提交分类排序（P0）。Body 按 type 分组整组提交 uuid + 0-based sort_order；
   * 后端单事务全成全败，每条写 sync_log(op=update) 供其他端 pull 重排。
   * 需 X-Ledger-Id（本路径不在豁免清单，request 统一注入并断言）。
   */
  updateSortOrders(body: BatchSortRequest): Promise<BatchSortResponse> {
    return api.patch<BatchSortResponse>(API_ROUTES.accountSortOrder, body)
  },
  /**
   * 修改账户展示字段（批 II）：PATCH /api/accounts/{uuid}，白名单
   * {display_name?, icon?, color?}，键省略 = 不改、空串 = 清除。
   * **在线-only**：push 的账户 op=update 只认 sort_order，误入离线队列会
   * 覆盖真实排序 —— 调用方必须先判在线态，绝不入队。
   */
  update(accountUuid: string, body: UpdateAccountRequest): Promise<UpdateAccountResponse> {
    return api.patch<UpdateAccountResponse>(
      formatApiPath(API_ROUTES.accountByUuid, { uuid: accountUuid }),
      body,
    )
  },
  /** 关闭账户（Beancount close 语义；余额非 0 时 409 + balances 差额明细）。 */
  close(accountUuid: string): Promise<OkResponse> {
    return api.delete<OkResponse>(formatApiPath(API_ROUTES.accountByUuid, { uuid: accountUuid }))
  },
}

/** 币种端点（0.6.0 S2；业务端点，必须携带 X-Ledger-Id）。 */
export const commodityApi = {
  list(): Promise<CommodityListResponse> {
    return api.get<CommodityListResponse>(API_ROUTES.commodities)
  },
  create(body: CreateCommodityRequest): Promise<CommodityCreated> {
    return api.post<CommodityCreated>(API_ROUTES.commodities, body)
  },
  /** 软删币种；被引用时后端返回 409 commodity_in_use + 分项明细。 */
  remove(uuid: string): Promise<DeleteCommodityResponse> {
    return api.delete<DeleteCommodityResponse>(
      formatApiPath(API_ROUTES.commodityByUuid, { uuid }),
    )
  },
}

/** 期初余额端点（GET 查询 / POST 设置；冲正 + 新建由后端 opening_key 幂等保证）。 */
export const openingApi = {
  get(accountUuid: string): Promise<OpeningView> {
    return api.get<OpeningView>(formatApiPath(API_ROUTES.accountOpening, { uuid: accountUuid }))
  },
  set(accountUuid: string, body: SetOpeningRequest): Promise<OpeningResult> {
    return api.post<OpeningResult>(
      formatApiPath(API_ROUTES.accountOpening, { uuid: accountUuid }),
      body,
    )
  },
}

/** 余额校准端点（0.6.0 S4；业务端点，必须携带 X-Ledger-Id）。 */
export const balanceApi = {
  /** 预检：截至 D 日初累计 + 既有校准 + 版本历史（viewer 可读）。 */
  preview(accountUuid: string, asOfDate: string): Promise<BalancePreview> {
    return api.get<BalancePreview>(
      formatApiPath(API_ROUTES.accountBalance, { uuid: accountUuid }),
      { query: { as_of_date: asOfDate } },
    )
  },
  /** 设置 / 修正校准（冲正旧 + 新建，单事务）。 */
  set(accountUuid: string, body: SetBalanceRequest): Promise<BalanceResult> {
    return api.post<BalanceResult>(
      formatApiPath(API_ROUTES.accountBalance, { uuid: accountUuid }),
      body,
    )
  },
}

/**
 * B7：两条永久删除端点共用的确认词。
 *
 * 服务端只认这一个值（`strings.TrimSpace(confirm) === '删除'`，不做同义词匹配），
 * 所以它是一个**契约常量**而不是 UI 文案：UI 层「清空回收站」让用户手输「清空」，
 * 校验通过后仍然传本词。改这里必须同时改后端 `service.purgeConfirmWord`。
 */
export const PURGE_CONFIRM_WORD = '删除'

/** 交易端点（业务端点；创建时透传 Idempotency-Key）。 */
export const transactionApi = {
  /**
   * 全量列表（**零参**）。
   *
   * 签名故意保持零参：现网 7 处调用（账户详情 / 币种 / 数据安全 / 账本 / 报表 /
   * 交易详情 / 流水）都依赖「缺省 = 全量」这个语义。要分页请用 `listPage`——
   * 给它加可选参数会让「不小心传了 limit」变成一次静默的截断。
   */
  list(): Promise<TransactionListResponse> {
    return api.get<TransactionListResponse>(API_ROUTES.transactions)
  },
  /**
   * 分页 / 带筛选的列表（dev-plan §5.8）。
   *
   * - 不传 `limit` 即全量（与 `list()` 等价，但可带筛选）；
   * - `limit: 0` 也是全量，供 CSV 导出二次拉取；
   * - `cursor` 只表达「从哪里继续」，筛选条件必须每次都原样带上。
   *
   * @param query 筛选 + 分页参数
   * @param options `signal` 用于筛选变化时取消在飞请求（**仍要看代际丢弃**：
   *     abort 存在时序窗口，可能已经回包）
   */
  listPage(
    query: TransactionListQuery,
    options: { signal?: AbortSignal } = {},
  ): Promise<TransactionListPage> {
    const flat: Record<string, string | number | undefined> = {}
    if (query.from !== undefined) flat.from = query.from
    if (query.to !== undefined) flat.to = query.to
    if (query.kind !== undefined) flat.kind = query.kind
    if (query.account !== undefined) flat.account = query.account
    if (query.category !== undefined) flat.category = query.category
    if (query.member !== undefined) flat.member = query.member
    if (query.tag !== undefined) flat.tag = query.tag
    if (query.q !== undefined) flat.q = query.q
    if (query.limit !== undefined) flat.limit = query.limit
    if (query.cursor !== undefined && query.cursor !== '') flat.cursor = query.cursor
    if (query.with !== undefined) flat.with = query.with
    return api.get<TransactionListPage>(API_ROUTES.transactions, {
      query: flat,
      signal: options.signal,
    })
  },
  create(
    body: CreateTransactionRequest,
    idempotencyKey: string,
  ): Promise<TransactionCreateResult> {
    return api.post<TransactionCreateResult>(API_ROUTES.transactions, body, {
      idempotencyKey,
    })
  },
  /** 回收站列表（软删交易，按删除时间倒序）。 */
  trash(): Promise<TrashListResponse> {
    return api.get<TrashListResponse>(API_ROUTES.transactionsTrash)
  },
  /** 软删交易（可从回收站恢复）。 */
  remove(transactionUuid: string): Promise<OkResponse> {
    return api.delete<OkResponse>(
      formatApiPath(API_ROUTES.transactionByUuid, { uuid: transactionUuid }),
    )
  },
  /** 从回收站恢复。 */
  restore(transactionUuid: string): Promise<OkResponse> {
    return api.post<OkResponse>(
      formatApiPath(API_ROUTES.transactionRestore, { uuid: transactionUuid }),
    )
  },
  /**
   * 修改交易（0.6.0 S6）：PATCH，服务端「冲正 + 新建」三步事务，绝不原地改。
   * 仅在线调用（离线编辑会被 409 / 网络失败兜底），载荷与 create 镜像
   * （account_id 引用，禁 uuid/created_by/ledger_id 字段）。
   * 已冲正 409 txn_already_reversed；期初/校准/冲正 409 txn_not_editable；
   * viewer/非本人 403 txn_edit_forbidden。
   */
  update(transactionUuid: string, body: CreateTransactionRequest): Promise<TransactionUpdated> {
    return api.patch<TransactionUpdated>(
      formatApiPath(API_ROUTES.transactionByUuid, { uuid: transactionUuid }),
      body,
    )
  },
  /**
   * 标签原地更新（注解层，P0）：PUT /api/transactions/{uuid}/tags。
   *
   * **与上面的 `update` 物理隔离**：本方法只改 tags 一列，uuid 不变、不产生冲正行，
   * 返回体回显服务端规范化后的最终 tags（前端以回显为准，不再自行拼）。
   *
   * `base_tags` 做 CAS：冲突时服务端 409 `txn_tags_conflict`，响应带
   * `current_tags` / `current_tags_updated_at`（由 ApiError.details 承载）；
   * 调用方须展示最新值并允许以新 base 重试。其余码沿用统一错误通道。
   *
   * 业务端点：X-CSRF / X-Ledger-Id 由 `request` 统一注入并断言。
   */
  updateTags(transactionUuid: string, body: UpdateTagsRequest): Promise<TagEditResponse> {
    return api.put<TagEditResponse>(
      formatApiPath(API_ROUTES.transactionTags, { uuid: transactionUuid }),
      body,
    )
  },
  /**
   * 二级「编辑记录」（P0）：GET /api/transactions/{uuid}/tag-edits。
   *
   * 只读审计，viewer 亦可调用；服务端倒序限 50 条。不进主流水 / 搜索 / 导出，
   * 只由详情页折叠面板按需拉取。
   */
  listTagEdits(transactionUuid: string): Promise<TagEditsResponse> {
    return api.get<TagEditsResponse>(
      formatApiPath(API_ROUTES.transactionTagEdits, { uuid: transactionUuid }),
    )
  },
  /**
   * 永久删除单笔（B7，仅 owner，**物理删除、不可恢复**）。
   *
   * `DELETE` 带 body：`ApiRequestOptions.body` 会被 `requestWithMeta` 统一
   * `JSON.stringify`，`buildHeaders` 照常补 `Content-Type` / `X-CSRF` / `X-Ledger-Id`
   * （后端缺 confirm 回 400 txn_purge_confirm_required）。
   */
  purge(transactionUuid: string, confirm: string = PURGE_CONFIRM_WORD): Promise<PurgeResult> {
    return api.delete<PurgeResult>(
      formatApiPath(API_ROUTES.transactionPurge, { uuid: transactionUuid }),
      { body: { confirm } },
    )
  },
  /**
   * 清空回收站（B7，仅 owner）。
   *
   * UI 让用户手输「清空」，这里映射成服务端唯一认的确认词 `confirm: '删除'`——
   * 服务端不做同义词匹配，确认机制一旦宽容就等于没有。
   */
  purgeTrash(confirm: string = PURGE_CONFIRM_WORD): Promise<PurgeResult> {
    return api.post<PurgeResult>(API_ROUTES.transactionsTrashPurge, { confirm })
  },
}

// ---------- 批 3：管理与设置页端点（全部复用既有 31 端点，无新增后端接口） ----------

/** 成员管理（仅 owner；路径在 X-Ledger-Id 作用域内，客户端自动注入）。 */
export const memberApi = {
  list(): Promise<MemberListResponse> {
    return api.get<MemberListResponse>(API_ROUTES.ledgerMembers)
  },
  add(body: AddMemberRequest): Promise<AddMemberResponse> {
    return api.post<AddMemberResponse>(API_ROUTES.ledgerMembers, body)
  },
  updateRole(userID: number, body: UpdateMemberRequest): Promise<UpdateMemberResponse> {
    return api.post<UpdateMemberResponse>(
      formatApiPath(API_ROUTES.ledgerMember, { userID: String(userID) }),
      body,
    )
  },
  remove(userID: number): Promise<OkResponse> {
    return api.delete<OkResponse>(
      formatApiPath(API_ROUTES.ledgerMember, { userID: String(userID) }),
    )
  },
  resetPassword(userID: number, body: ResetMemberPasswordRequest): Promise<OkResponse> {
    return api.post<OkResponse>(
      formatApiPath(API_ROUTES.ledgerMemberResetPassword, { userID: String(userID) }),
      body,
    )
  },
}

/** 账本管理（例外清单，不带 X-Ledger-Id）。 */
export const ledgerManageApi = {
  create(body: CreateLedgerRequest): Promise<LedgerView> {
    return api.post<LedgerView>(API_ROUTES.ledgers, body)
  },
  update(id: number, body: UpdateLedgerRequest): Promise<LedgerView> {
    return api.patch<LedgerView>(formatApiPath(API_ROUTES.ledgerById, { id: String(id) }), body)
  },
  /** 软删账本（0.6.0 S1，仅 owner；成员门禁 / 最后账本 / 删除前快照由后端按序保证）。 */
  remove(id: number): Promise<DeleteLedgerResponse> {
    return api.delete<DeleteLedgerResponse>(formatApiPath(API_ROUTES.ledgerById, { id: String(id) }))
  },
}

/** 注册开关（GET 公开 / POST 仅系统管理员）。 */
export const settingsApi = {
  registration(): Promise<RegistrationSettings> {
    // 登录页也会调用；skipRefresh 避免未登录时触发无意义的 401 刷新。
    return api.get<RegistrationSettings>(API_ROUTES.settingsRegistration, { skipRefresh: true })
  },
  setRegistration(body: SetRegistrationRequest): Promise<RegistrationSettings> {
    return api.post<RegistrationSettings>(API_ROUTES.settingsRegistration, body)
  },
}

/** 登录设备（自服务端点）。 */
export const sessionApi = {
  list(): Promise<SessionsResponse> {
    return api.get<SessionsResponse>(API_ROUTES.sessions)
  },
  revoke(sid: string): Promise<RevokeSessionResponse> {
    return api.delete<RevokeSessionResponse>(
      formatApiPath(API_ROUTES.sessionBySid, { sid }),
    )
  },
  revokeOthers(): Promise<RevokeOtherSessionsResponse> {
    return api.post<RevokeOtherSessionsResponse>(API_ROUTES.sessionsRevokeOthers)
  },
}

/** 备份（全库级，仅系统管理员；不带账本上下文）。 */
export const backupApi = {
  list(): Promise<BackupListResponse> {
    return api.get<BackupListResponse>(API_ROUTES.backupList)
  },
  run(): Promise<BackupItem> {
    return api.post<BackupItem>(API_ROUTES.backupRun)
  },
  async download(name: string): Promise<Blob> {
    const res = await requestWithMeta<Blob>(API_ROUTES.backupDownload, {
      method: 'GET',
      query: { name },
      responseType: 'blob',
    })
    return res.data
  },
}

/**
 * M2-b 恢复（全库级，仅系统管理员；不带账本上下文）。
 *
 * preview 只读预检不改动数据；execute 需要二次确认词 `RESTORE`，
 * 服务端会自动生成 pre-restore 快照并重写库世代（instance_id）。
 * 文件走 multipart/form-data（服务端限制 512MB，落临时文件用完即删）。
 */
export const restoreApi = {
  preview(file: File): Promise<RestorePreviewResult> {
    const form = new FormData()
    form.append('file', file)
    return request<RestorePreviewResult>(API_ROUTES.backupRestorePreview, {
      method: 'POST',
      body: form,
    })
  },
  execute(file: File, confirm: string): Promise<RestoreResult> {
    const form = new FormData()
    form.append('file', file)
    form.append('confirm', confirm)
    return request<RestoreResult>(API_ROUTES.backupRestore, {
      method: 'POST',
      body: form,
    })
  },
}

/**
 * 0.6.0 S5 导入（Beancount → 当前账本 / 新建账本）。
 *
 * 自 S5 起导入与其他业务端点一致：必须带 X-Ledger-Id（routes.ts 已把
 * /api/import 移出 NO_LEDGER_PATHS）。target=current 写入当前账本（同名账户
 * 复用 + 幂等去重）；target=new 沿用既有新建账本路径并支持 pad/balance 展开。
 * undo 按批次标识仅回滚本批新建实体与本批交易。
 */
export const importApi = {
  preview(text: string, target: string): Promise<ImportPreviewResult> {
    return api.post<ImportPreviewResult>(API_ROUTES.importBeancountPreview, { text }, {
      query: { target },
    })
  },
  execute(text: string, target: string): Promise<ImportResult> {
    return api.post<ImportResult>(API_ROUTES.importBeancount, { text }, {
      query: { target },
    })
  },
  undo(batchId: string): Promise<ImportUndoResult> {
    return api.post<ImportUndoResult>(API_ROUTES.importBeancountUndo, undefined, {
      query: { batch_id: batchId },
    })
  },
}

/** 导出结果（含服务端响应头里的恒等式告警）。 */
export interface ExportFileResult {
  blob: Blob
  /** 缺头按 true 处理，兼容旧服务端。 */
  balanced: boolean
  diffs: DiffItem[]
}

async function fetchExport(path: string): Promise<ExportFileResult> {
  const res = await requestWithMeta<Blob>(path, { method: 'GET', responseType: 'blob' })
  const balancedHeader = res.headers.get('X-Ledger-Balanced')
  const diffsHeader = res.headers.get('X-Ledger-Diffs')
  return {
    blob: res.data,
    balanced: balancedHeader !== 'false',
    diffs: parseIdentityHeader(diffsHeader === null ? '' : diffsHeader),
  }
}

/** 导出（业务端点，需 X-Ledger-Id）。 */
export const exportApi = {
  beancount(): Promise<ExportFileResult> {
    return fetchExport(API_ROUTES.export)
  },
  archive(): Promise<ExportFileResult> {
    return fetchExport(API_ROUTES.exportArchive)
  },
}

/** 恒等式检查（导出前的前置校验，§14.5 #3 要求不平即阻断）。 */
export const identityApi = {
  check(): Promise<IdentityCheckResult> {
    return api.get<IdentityCheckResult>(API_ROUTES.identityCheck)
  },
}

/**
 * 同步状态页：只读连通性。
 *
 * ⚠️ **刻意不提供 `pull` 探测水位**：服务端 `SyncPull` 的 `checkpoint` 是
 * 「本次返回变更的最大 seq」，且会按 `client_id` 写回 `sync_checkpoints`。
 * 用 since=0 探测既会拉全量数据、又会篡改该设备的服务端水位（静默副作用）。
 * 真实的 pull/push 只由 SyncEngine（core/sync）发起。
 */
export const syncStatusApi = {
  health(): Promise<HealthResponse> {
    return api.get<HealthResponse>(API_ROUTES.health, { skipRefresh: true })
  },
}

/** 同步端点（业务端点，需 X-Ledger-Id；仅供 core/sync 引擎调用）。 */
export const syncApi = {
  pull(since: number, clientId: string): Promise<SyncPullResponse> {
    return api.get<SyncPullResponse>(API_ROUTES.syncPull, {
      query: { since, client_id: clientId },
    })
  },
  push(clientId: string, since: number, changes: PushChange[]): Promise<SyncPushResponse> {
    return api.post<SyncPushResponse>(API_ROUTES.syncPush, {
      client_id: clientId,
      since,
      changes,
    })
  },
}
