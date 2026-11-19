/**
 * 后端 REST 契约类型（批 0）
 *
 * 依据 `internal/server/router.go` 的 31 条路由与 `internal/handler/*`、
 * `internal/service/*`、`internal/backup` 的请求/响应字段手写，不使用生成器。
 * 约定：
 * - 金额一律为定点十进制字符串（MoneyString），禁止 number；
 * - 日期为 `YYYY-MM-DD`，时间戳为后端 JSON 序列化结果（RFC3339 / datetime 字符串）；
 * - 服务端自增 id 为 number，跨端引用一律用 uuid。
 */

/** 账本内账户类型（Beancount 五大类）。 */
export type AccountType = 'Assets' | 'Liabilities' | 'Equity' | 'Income' | 'Expenses'

/** 成员角色。 */
export type LedgerRole = 'owner' | 'editor' | 'viewer'

/** 交易标记：* 正常 / ! 待核对。 */
export type TxnFlag = '*' | '!'

/** 同步实体类型。 */
export type SyncEntityType = 'account' | 'transaction' | 'commodity' | 'price'

/** 同步操作：create / delete / close / update。 */
export type SyncOp = 'create' | 'delete' | 'close' | 'update'

/** 期初方向：持有 / 欠款。 */
export type OpeningDirection = 'hold' | 'owe'

/** 期初写入结果状态。 */
export type OpeningStatus = 'created' | 'updated' | 'cleared' | 'unchanged'

/** 定点十进制金额字符串。 */
export type MoneyString = string

/** `YYYY-MM-DD` 日期字符串。 */
export type ISODate = string

/** 后端时间字符串（datetime('now') / RFC3339）。 */
export type ISODateTime = string

/** 账本内账户 uuid。 */
export type AccountUUID = string

/** 交易 uuid。 */
export type TransactionUUID = string

/** 通用 JSON 对象。 */
export type JsonRecord = Record<string, unknown>

// ---------- 健康检查 ----------

/** GET /api/health */
export interface HealthResponse {
  status: string
  /** 库世代（迁移 014）：restore 后变化，客户端据此判断需全量重拉。 */
  instance_id?: string
}

// ---------- 认证 ----------

/** POST /api/auth/register 请求体。 */
export interface RegisterRequest {
  username: string
  password: string
  display_name?: string
}

/** POST /api/auth/login 请求体。 */
export interface LoginRequest {
  username: string
  password: string
}

/** 当前用户信息（role 为默认账本角色，可能为空串）。 */
export interface UserInfo {
  id: number
  username: string
  display_name?: string
  role: LedgerRole | ''
  is_admin: boolean
  must_change_password: boolean
}

/** 注册 / 登录成功响应。 */
export interface AuthResult {
  token: string
  user: UserInfo
}

/** GET /api/auth/me */
export interface MeResponse {
  user: UserInfo
}

/** POST /api/auth/refresh */
export interface RefreshResponse {
  token: string
}

/** POST /api/auth/change-password 请求体。 */
export interface ChangePasswordRequest {
  old_password: string
  new_password: string
}

/** POST /api/auth/change-password 响应。 */
export interface ChangePasswordResponse {
  ok: boolean
  token: string
}

/** POST /api/auth/logout 响应（注意 ok 是字符串 "true"，保持后端原样）。 */
export interface LogoutResponse {
  ok: string
}

/** 登录设备列表项（token 绝不下发，id 是可吊销的 SID 前缀）。 */
export interface SessionItem {
  id: string
  created_at: ISODateTime
  last_seen_at: ISODateTime
  expires_at: ISODateTime
  ip: string
  device: string
  current: boolean
}

/** GET /api/auth/sessions */
export interface SessionsResponse {
  sessions: SessionItem[]
}

/** DELETE /api/auth/sessions/{sid} */
export interface RevokeSessionResponse {
  ok: boolean
}

/** POST /api/auth/sessions/revoke-others */
export interface RevokeOtherSessionsResponse {
  ok: boolean
  revoked: number
}

// ---------- 账本 ----------

/** 账本视图（含当前用户角色与期初日期）。 */
export interface LedgerView {
  id: number
  name: string
  default_commodity?: string
  opening_date: ISODate
  role: LedgerRole
  /** 0.6.0 行级统计（可选 + 容忍旧响应）；member_count 为除 owner 外的成员数。 */
  member_count?: number
  account_count?: number
  transaction_count?: number
}

/** DELETE /api/ledgers/{id} 成功响应。 */
export interface DeleteLedgerResponse {
  ok: boolean
}

/** 409 ledger_has_members 的成员明细（仅用户名 / 显示名，不含任何凭据）。 */
export interface LedgerMemberRef {
  username: string
  display_name: string
}

/** 409 ledger_has_members 的响应明细（由 ApiError.details 承载）。 */
export interface LedgerHasMembersDetails {
  member_count?: number
  members?: LedgerMemberRef[]
}

/** GET /api/ledgers */
export interface LedgerListResponse {
  ledgers: LedgerView[]
}

/** POST /api/ledgers 请求体。 */
export interface CreateLedgerRequest {
  name: string
  default_commodity?: string
}

/** PATCH /api/ledgers/{id} 请求体；字段缺省表示不修改。 */
export interface UpdateLedgerRequest {
  name?: string
  default_commodity?: string
  opening_date?: ISODate
}

// ---------- 账户 ----------

/** 账户列表项（含按币种余额）。 */
export interface AccountView {
  id: number
  name: string
  display_name?: string
  /** 账户 uuid（批 2 起列表响应已透出；期初编辑 / 关户 / 删除依赖）。 */
  uuid: string
  type: AccountType
  open_date: ISODate
  close_date?: ISODate
  commodity_restriction?: string
  icon?: string
  color?: string
  parent_uuid?: AccountUUID
  sub_type?: string
  sort_order: number
  balances?: Record<string, MoneyString>
}

/** 创建账户响应。 */
export interface AccountCreated {
  id: number
  uuid: AccountUUID
  name: string
  display_name?: string
  type: AccountType
  open_date: ISODate
  icon?: string
  color?: string
  parent_uuid?: AccountUUID
  sub_type?: string
}

/** GET /api/accounts */
export interface AccountListResponse {
  accounts: AccountView[]
}

/** POST /api/accounts 请求体。 */
export interface CreateAccountRequest {
  name: string
  display_name?: string
  type: AccountType
  open_date: ISODate
  commodity?: string
  icon?: string
  color?: string
  parent_uuid?: AccountUUID
  sub_type?: string
}

/** DELETE /api/accounts/{uuid}（Beancount close 语义）。 */
export interface OkResponse {
  ok: boolean
}

// ---------- 币种（0.6.0 S2）----------

/** 币种行（GET /api/commodities）。 */
export interface CommodityView {
  uuid: string
  symbol: string
  name: string
  precision: number
  /** 可选 + 容忍旧响应；消费处一律 `=== true` 判真。 */
  used?: boolean
  is_default?: boolean
}

/** GET /api/commodities 响应。 */
export interface CommodityListResponse {
  commodities: CommodityView[]
}

/** POST /api/commodities 请求体；precision 缺省由后端按 2 处理。 */
export interface CreateCommodityRequest {
  symbol: string
  name?: string
  precision?: number
}

/** POST /api/commodities 响应。 */
export interface CommodityCreated {
  uuid: string
  symbol: string
  name: string
  precision: number
}

/** DELETE /api/commodities/{uuid} 响应。 */
export interface DeleteCommodityResponse {
  ok: boolean
}

/** 409 commodity_in_use 的响应明细（由 ApiError.details 承载）。 */
export interface CommodityInUseDetails {
  accounts?: string[]
  postings?: number
  prices?: number
  is_default?: boolean
}

// ---------- 余额校准（0.6.0 S4）----------

/** 按币种的金额（预检累计 / 历史差额）。 */
export interface BalanceAmount {
  commodity: string
  amount: string
}

/** 既有校准的目标余额（带符号）。 */
export interface BalanceTargetAmount {
  commodity: string
  signed_amount: string
}

/** 校准版本历史项（v1/v2、操作人、时间、差额原因）。 */
export interface BalanceHistoryItem {
  version: string
  transaction_uuid: string
  created_at?: string
  created_by_name?: string
  reversed: boolean
  entries?: BalanceAmount[]
}

/** GET 预检中的既有校准信息；字段可选以容忍旧响应。 */
export interface BalanceCalibrationView {
  exists: boolean
  date?: string
  version?: number
  targets?: BalanceTargetAmount[]
  transaction_uuid?: string
  history?: BalanceHistoryItem[]
}

/** GET /api/accounts/{uuid}/balance?as_of_date=D 响应。 */
export interface BalancePreview {
  account_uuid: string
  as_of_date: string
  cumulative: BalanceAmount[]
  calibration: BalanceCalibrationView
}

/** POST 请求的单币种目标余额（带符号定点十进制字符串）。 */
export interface BalanceTargetRequest {
  commodity: string
  target_balance: string
}

/** POST /api/accounts/{uuid}/balance 请求体。 */
export interface SetBalanceRequest {
  as_of_date: string
  targets: BalanceTargetRequest[]
}

/** 本次补记的按币种差额。 */
export interface BalanceEntry {
  commodity: string
  diff: string
}

/** POST 响应。 */
export interface BalanceResult {
  status: 'created' | 'updated'
  account_uuid: string
  transaction_uuid: string
  reversal_uuid?: string
  version: number
  date: string
  entries: BalanceEntry[]
}

// ---------- 期初 ----------

/** GET /api/accounts/{uuid}/opening */
export interface OpeningView {
  has_opening: boolean
  account_uuid: AccountUUID
  amount?: MoneyString
  direction?: OpeningDirection
  signed_amount?: MoneyString
  commodity?: string
  version?: number
  date?: ISODate
  transaction_uuid?: TransactionUUID
}

/** POST /api/accounts/{uuid}/opening 请求体（amount 为非负绝对值）。 */
export interface SetOpeningRequest {
  amount: MoneyString
  direction: OpeningDirection
  commodity?: string
  date?: ISODate
}

/** POST /api/accounts/{uuid}/opening 响应。 */
export interface OpeningResult {
  status: OpeningStatus
  account_uuid: AccountUUID
  transaction_uuid?: TransactionUUID
  reversal_uuid?: TransactionUUID
  version: number
  signed_amount: MoneyString
  commodity: string
  date: ISODate
}

// ---------- 恒等式检查 ----------

/** 某币种的恒等式差额。 */
export interface IdentityDiff {
  commodity: string
  sum: MoneyString
}

/** GET /api/identity/check */
export interface IdentityCheckResult {
  balanced: boolean
  diffs: IdentityDiff[]
  posting_count: number
  checked_at: ISODateTime
  duration_ms: number
}

// ---------- 交易 ----------

/** 交易列表中的分录。 */
export interface PostingView {
  account_id: number
  account: string
  commodity: string
  amount: MoneyString
}

/** 交易列表项。 */
export interface TransactionView {
  id: number
  /** 交易 uuid（批 2 起列表响应已透出；软删依赖）。 */
  uuid: string
  date: ISODate
  flag: TxnFlag
  description: string
  created_by_name: string
  /** 标签（迁移 005 起后端已持久化；报表 #tag 下钻用，旧响应可能缺失）。 */
  tags?: string[]
  postings: PostingView[]
  /** 非空 = 已被冲正（失效原交易；0.6.0 S6，徽章数据源）。 */
  reversed_by?: string
  /** 非空 = 本身是冲正交易（0.6.0 S6）。 */
  reversal_of?: string
  /** 服务端按请求用户计算的编辑许可（0.6.0 S6 AC-5.2；false 时省略）。 */
  can_edit?: boolean
}

/** GET /api/transactions */
export interface TransactionListResponse {
  transactions: TransactionView[]
}

/**
 * `GET /api/transactions` 的查询参数（dev-plan §5.8 冻结契约）。
 *
 * **`limit` 缺省 = 全量**：不传就返回该账本全部交易（现网 7 处调用依赖这个语义）。
 * 传 `limit: 0` 同样是全量，专供 CSV 导出。只有显式传 1..200 才是分页。
 */
export interface TransactionListQuery {
  from?: string
  to?: string
  kind?: string
  account?: number
  category?: number
  member?: string
  tag?: string
  q?: string
  limit?: number
  /** keyset 游标（不透明串，不进 URL）。 */
  cursor?: string
  /** `summary` 让服务端附带全量汇总，供搜索页汇总卡使用。 */
  with?: 'summary'
}

/** `with=summary` 时按币种给出的一行汇总（金额为定点串，**禁跨币种求和**）。 */
export interface TransactionSummaryCommodity {
  commodity: string
  /** 收入合计，正数，定点串。 */
  income: string
  /** 支出合计，正数，定点串。 */
  expense: string
}

/** `with=summary` 时的筛选**全集**汇总（与翻到第几页无关，服务端保证）。 */
export interface TransactionSummary {
  /** 全量命中笔数（「共 N 笔」的唯一来源）。 */
  total: number
  /** 按币种分行；跨币种不合并。 */
  by_commodity: TransactionSummaryCommodity[]
}

/**
 * 分页响应。
 *
 * 三个元字段**全部可选**且是故意的：服务端在不带 `limit`（全量）时不返回它们，
 * TS 因此强迫每个消费者处理「没有 total / 没有下一页」的可能——
 * 这比把它们标成必填、再各处 `?? 0` 兜底更难写错。
 */
export interface TransactionListPage {
  transactions: TransactionView[]
  /** 全量命中条数（分页时才有）；「共 N 笔」必须用它，不能用本页行数。 */
  total?: number
  has_more?: boolean
  next_cursor?: string
  /** 仅当请求带 `with=summary` 时返回；缺失时页面**整块不渲染**汇总（不要显示 0）。 */
  summary?: TransactionSummary
}

/** POST /api/transactions 请求体（在线记账必须用 account_id）。 */
export interface CreateTransactionRequest {
  date: ISODate
  flag?: TxnFlag
  description: string
  tags?: string[]
  postings: Array<{
    account_id: number
    commodity: string
    amount: MoneyString
  }>
}

/** POST /api/transactions 响应。 */
export interface TransactionCreated {
  id: number
  uuid: TransactionUUID
  date: ISODate
  postings: number
}

/** PATCH /api/transactions/{uuid} 响应（0.6.0 S6：修改 = 冲正 + 新建；无 version）。 */
export interface TransactionUpdated {
  original_uuid: TransactionUUID
  reversal_uuid: TransactionUUID
  new_uuid: TransactionUUID
}

/** 回收站分录视图（account 为 Beancount 全名，account_display 为展示名）。 */
export interface TrashPostingView {
  account: string
  account_display: string
  commodity: string
  amount: MoneyString
}

/** 回收站条目。 */
export interface TrashItemView {
  uuid: TransactionUUID
  date: ISODate
  flag: TxnFlag
  description: string
  tags: string[]
  deleted_at: ISODateTime
  created_by_name: string
  postings: TrashPostingView[]
  /** 服务端按请求用户角色计算（viewer false；0.6.0 S6 AC-5.8，false 时省略）。 */
  can_restore?: boolean
}

/** GET /api/transactions/trash */
export interface TrashListResponse {
  transactions: TrashItemView[]
}

/** POST /api/transactions/{uuid}/restore */
export interface RestoreTransactionResponse {
  ok: boolean
}

// ---------- 成员 ----------

/** 成员列表项。 */
export interface MemberView {
  user_id: number
  username: string
  display_name: string
  role: LedgerRole
}

/** GET /api/ledger/members */
export interface MemberListResponse {
  members: MemberView[]
}

/** POST /api/ledger/members 请求体。 */
export interface AddMemberRequest {
  username: string
  role: LedgerRole
}

/** POST /api/ledger/members 响应。 */
export interface AddMemberResponse {
  ok: boolean
  user_id: number
  role: LedgerRole
}

/** POST /api/ledger/members/{userID} 请求体。 */
export interface UpdateMemberRequest {
  role: LedgerRole
}

/** POST /api/ledger/members/{userID} 响应。 */
export interface UpdateMemberResponse {
  ok: boolean
  user_id: number
  role: LedgerRole
}

/** POST /api/ledger/members/{userID}/reset-password 请求体。 */
export interface ResetMemberPasswordRequest {
  new_password: string
}

// ---------- 导出 ----------

/**
 * GET /api/export：`text/plain` 附件（family.beancount）。
 * 前端以 Blob/文本处理，不在此定义结构化响应。
 */
export type ExportResult = Blob

/** GET /api/export/archive：`application/zip` 附件。 */
export type ExportArchiveResult = Blob

// ---------- 同步 ----------

/** 某币种余额差额（关闭账户校验 / push 失败明细）。 */
export interface BalanceDiff {
  commodity: string
  amount: MoneyString
}

/** pull 返回的一条变更。 */
export interface SyncChange {
  seq: number
  entity_type: SyncEntityType
  op: SyncOp
  entity: JsonRecord
}

/** GET /api/sync/pull 查询参数。 */
export interface SyncPullQuery {
  since: number
  client_id: string
}

/** GET /api/sync/pull 响应。 */
export interface SyncPullResponse {
  /** 库世代（迁移 014）：与本地记录不一致时清空该账本实体并全量 pull。 */
  instance_id?: string
  checkpoint: number
  changes: SyncChange[]
}

/** push 请求中的一条变更。 */
export interface PushChange {
  entity_type: SyncEntityType
  op: SyncOp
  entity: JsonRecord
}

/** POST /api/sync/push 请求体。 */
export interface SyncPushRequest {
  client_id: string
  since: number
  changes: PushChange[]
}

/** push 中单条变更的处理结果。 */
export interface PushResult {
  index: number
  entity_type: SyncEntityType
  uuid?: string
  status: string
  accepted: boolean
  server_uuid?: string
  error?: string
  code?: string
  balances?: BalanceDiff[]
}

/** POST /api/sync/push 响应。 */
export interface SyncPushResponse {
  /** 库世代（迁移 014）：语义同 SyncPullResponse.instance_id。 */
  instance_id?: string
  checkpoint: number
  accepted: number
  results: PushResult[]
}

// ---------- 备份（全库级，仅系统管理员） ----------

/** 备份记录中的恒等式告警。 */
export interface BackupIdentityWarning {
  ledger_id: number
  diffs: IdentityDiff[]
}

/** 备份清单项（manifest.json 的磁盘格式，也是 API 返回结构）。 */
export interface BackupItem {
  name: string
  bean_files?: string[]
  size: number
  sha256: string
  trigger: 'auto' | 'manual'
  created_at: ISODateTime
  duration_ms: number
  stats?: Record<string, number>
  identity_warnings?: BackupIdentityWarning[]
  /** 非空表示该次备份失败（失败记录保留在清单里）。 */
  error?: string
}

/** GET /api/backup/list */
export interface BackupListResponse {
  items: BackupItem[]
}

/** GET /api/backup/download 查询参数。 */
export interface BackupDownloadQuery {
  name: string
}

// ---------- 设置 ----------

/** 注册开关（GET 公开 / POST 仅系统管理员）。 */
export interface RegistrationSettings {
  enabled: boolean
}

/** POST /api/settings/registration 请求体。 */
export interface SetRegistrationRequest {
  enabled: boolean
}

// ---------- M2：恢复与导入（批 4） ----------

/** 恢复预检 / 执行结果里的核心表行数统计。 */
export interface RestoreStats {
  users: number
  ledgers: number
  accounts: number
  transactions: number
}

/** POST /api/backup/restore/preview（只读预检；Valid=false 时看 reason / error）。 */
export interface RestorePreviewResult {
  source: string
  valid: boolean
  backup: RestoreStats
  current: RestoreStats
  schema_version: number
  current_version: number
  warnings: string[]
  /** 预检未通过的概括原因（人类可读）。 */
  error?: string
  /** 机器可读拒绝原因码：not_sqlite / integrity_failed / not_our_backup / future_version / file_too_large。 */
  reason?: string
}

/** POST /api/backup/restore（执行结果；snapshot 可再还原回去）。 */
export interface RestoreResult {
  source: string
  replaced: RestoreStats
  snapshot?: string
  new_instance_id: string
  warnings: string[]
}

/** Beancount 解析错误（行号 + 原因，一次收集全部）。 */
export interface BeancountParseError {
  line: number
  msg: string
}

/** 导入预检冲突（0.6.0 S5：逐行号与原因）。 */
export interface ImportConflict {
  line: number
  /** account_conflict | commodity_conflict | undeclared_account | unbalanced | pad_balance_unsupported */
  type: string
  name: string
  reason: string
}

/** 导入预检中 pad/balance 指令的结构化呈现（含按当前账本重算的差额）。 */
export interface ImportPadBalancePreview {
  line: number
  /** pad | balance */
  type: string
  account: string
  target_amount: string
  cumulative: string
  diff: string
}

/** 导入预检警告（只提示、不阻断导入，不进 conflicts；如负债正余额疑似符号填反）。 */
export interface ImportWarning {
  line: number
  account: string
  message: string
}

/** POST /api/import/beancount/preview（只读解析预检，0.6.0 S5 支持 target=current|new）。 */
export interface ImportPreviewResult {
  valid: boolean
  title: string
  /** current（导入到当前账本）| new（新建账本）。 */
  target: string
  /** target=new 时实际将使用的账本名（同名自动加序号）。 */
  ledger_name: string
  new_accounts: number
  reuse_accounts: number
  new_transactions: number
  skip_transactions: number
  new_commodities: number
  pad_balance: ImportPadBalancePreview[]
  conflicts: ImportConflict[]
  /** 非阻断性警告（additive；负债正余额疑似符号方向填反等），仅提示不阻断。 */
  warnings?: ImportWarning[]
  /** 冲突汇总稳定码（如 import_account_conflict / import_pad_balance_unsupported）。 */
  code?: string
  /** target=new 时疑似重复导入（同名账本 + 相同交易数）：仅提示，不阻断。 */
  duplicate: boolean
  errors?: BeancountParseError[]
  error?: string
}

/** POST /api/import/beancount（执行结果，current / new 两种模式共用）。 */
export interface ImportResult {
  /** current | new */
  mode: string
  ledger_id: number
  ledger_name: string
  /** 本次导入批次标识（撤销入口据此定位）。 */
  import_batch_id: string
  created_transactions: number
  skipped_transactions: number
  reused_accounts: number
  new_accounts: number
  new_commodities: number
}

/** POST /api/import/beancount/undo（0.6.0 S5 批次撤销结果）。 */
export interface ImportUndoResult {
  removed_transactions: number
  removed_postings: number
  removed_prices: number
  removed_accounts: number
  removed_commodities: number
}
