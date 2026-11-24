/**
 * 账本数据单例（批 5 / 视图收敛；批 I 起为两段加载）
 *
 * 背景：首页 / 账单 / 报表 / 资产统计 / 分类页原先各自 `onMounted` 里
 * `accountApi.list() + transactionApi.list()` 拉全量再本地过滤，同一账本在
 * 页面间来回切换会重复发请求。本 store 把这份「全量快照」收敛成单例。
 *
 * 批 I（首屏两段加载）把一次 `ensure()` 拆成两段：
 * - **首段（窗口段）**：`accountApi.list({includeClosed:true})` +
 *   `transactionApi.listPage({from:当月1日, to:当月末})`（**不传 limit**——
 *   `limit` 缺省 = 条件命中全量是冻结契约，窗口段靠 from/to 限定范围）。
 *   成功即 `loaded=true`，页面先渲染「当月窗口」；
 * - **补齐段（静默）**：首段成功后用 `requestIdleCallback` 调度（iOS 14.8 无此
 *   API，回退 `setTimeout(cb, 0)`），回调发请求前先验 epoch，全量返回后整体
 *   替换 `txns` 并置 `fullReady=true`。补齐段**静默**：失败只记 `fullError`，
 *   不写 `error`、不弹 UI。
 *
 * 对外契约：
 * - `ensure()`：未加载过才拉；并发调用共享同一个 Promise（单例请求）；
 * - `reload()`：强制重拉（保存记账 / 改账 / 删除后调）；两段照跑；
 * - `reset()`：清空快照（切账本时由内部 watch 调用）；
 * - `fullReady`：`txns` 是否为全量快照（视图据此决定「聚合骨架 / 降级口径」）；
 * - `setWindowMonth(prefix)`：声明「正在看某月」——补齐中会拉该月窗口并入快照；
 * - `hasMonthWindow(prefix)`：该月窗口是否已在本地快照；
 * - 内部 `watch(session.ledgerId)`：切账本自动 `reset()` + `ensure()`。
 *
 * 四条硬约束（勿回退）：
 * 1. 失败**不缓存** Promise：一次网络抖动清空 pending，下次 `ensure()` 可重试，
 *    否则页面会永久空着；
 * 2. 错误只写 `error`（空串表示无错），**不向组件层 throw**，组件只看 error；
 *    补齐段与独立窗口段失败**静默**（不写 error），该月不进 windowMonths，
 *    下次 `setWindowMonth` / reload 自然重试；
 * 3. 账本 id 变化时用自增 `epoch` 丢弃在途请求的回写，防止 A 账本的慢响应
 *    覆盖 B 账本的数据；**一个 epoch 覆盖两段**（窗口段与补齐段共用同一 token）；
 * 4. 窗口合并一律**按月前缀替换**：删该月旧行、插入窗口行、其余月份行保留。
 *    全量态 reload 时同样走这条路径（当月窗口先刷新、其余月份等全量回写）。
 */
import { onScopeDispose, ref, watch, type Ref } from 'vue'
import { defineStore } from 'pinia'

import { accountApi, transactionApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { AccountView, TransactionListPage, TransactionView } from '@/api/types'
import { useSessionStore } from '@/stores/session'
import {
  checkAndReload,
  dirtyByLedger,
  isPageVisible,
  registerReloadHandler,
} from '@/stores/dataFreshness'

/** 加载失败的兜底文案（与现网页面口径一致；ApiError 自带文案优先）。 */
const DEFAULT_LOAD_ERROR = '账本数据加载失败，请重试'

/** 未选择账本时的提示（`ensure()` 在 `ledgerId` 为空时写入 `error`，由页面 `StateCard` 呈现）。 */
const NO_LEDGER_ERROR = '尚未选择账本'

/** 月份前缀形状：`YYYY-MM`（四位年 + 两位月）。 */
const MONTH_PREFIX_RE = /^\d{4}-\d{2}$/

/**
 * 把异常转成用户可读的中文文案。
 * 与现网页面口径一致：`ApiError` 自带后端文案优先，其余一律走中文兜底，
 * 绝不把英文 `TypeError` 之类直接甩给用户。
 */
function messageOf(err: unknown): string {
  if (err instanceof ApiError && err.message !== '') {
    return err.message
  }
  return DEFAULT_LOAD_ERROR
}

/** 设备本地自然当月前缀（构造与 `reset()` 都用它，跨年后自然正确）。 */
function naturalMonthPrefix(): string {
  const now = new Date()
  const month = now.getMonth() + 1
  return `${now.getFullYear()}-${month < 10 ? `0${month}` : String(month)}`
}

/** 月份前缀 → 该月最后一天（`YYYY-MM-DD`）：`new Date(y, m, 0)` 即次月 0 日 = 本月末。 */
function monthEndDate(prefix: string): string {
  const year = Number(prefix.slice(0, 4))
  const month = Number(prefix.slice(5, 7))
  const last = new Date(year, month, 0).getDate()
  return `${prefix}-${last < 10 ? `0${last}` : String(last)}`
}

export const useLedgerDataStore = defineStore('ledgerData', () => {
  const session = useSessionStore()

  /** 当前账本的账户全量快照。 */
  const accounts: Ref<AccountView[]> = ref<AccountView[]>([])
  /** 当前账本的交易快照（补齐完成前只有「已拉窗口」的月份，见 `fullReady`）。 */
  const txns: Ref<TransactionView[]> = ref<TransactionView[]>([])
  /** 是否正在加载（并发请求共享同一次加载；只由**首段**驱动）。 */
  const loading: Ref<boolean> = ref<boolean>(false)
  /** 错误文案，空串表示无错（**只**由首段 / 可见加载写入）。 */
  const error: Ref<string> = ref<string>('')
  /** 是否至少成功加载过一次（`ensure()` 的短路依据）。 */
  const loaded: Ref<boolean> = ref<boolean>(false)
  /** `txns` 是否已是全量快照：首段成功后 false，补齐成功 true，`reset()` 复位；**reload 不清除**。 */
  const fullReady: Ref<boolean> = ref<boolean>(false)

  // ---- 补齐段内部状态（静默：不弹 UI，不对外暴露） ----
  /** 补齐段在途标记。 */
  const fullLoading: Ref<boolean> = ref<boolean>(false)
  /** 补齐段最后一次失败的文案（仅作状态记录，不进 `error`）。 */
  const fullError: Ref<string> = ref<string>('')
  /** 窗口段关注月（reload 的首段按它拉窗口）；构造与 `reset()` 初始化为自然当月。 */
  const windowMonth: Ref<string> = ref<string>(naturalMonthPrefix())
  /** 已拉过窗口（数据在快照里）的月份集合。 */
  const windowMonths: Ref<string[]> = ref<string[]>([])

  /** 模块内单例请求：并发 `ensure()` 只发一次，settle 后清空（失败也可重试）。 */
  let pending: Promise<void> | null = null
  /** 复位代数：`reset()` / `reload()` 自增，在途请求据 token 丢弃过期回写；一个 epoch 覆盖两段。 */
  let epoch = 0
  /** 窗口请求单飞表：同月并发共享同一 Promise；epoch 变化时整表清空防旧 token 混入。 */
  const windowInflight = new Map<string, Promise<TransactionListPage | null>>()

  /** 该月窗口是否已在本地快照（全量态下任何月份都视为在）。 */
  function hasMonthWindow(prefix: string): boolean {
    if (fullReady.value) {
      return true
    }
    return windowMonths.value.indexOf(prefix) >= 0
  }

  /** 按月前缀替换：删该月旧行、插入窗口行、其余月份行保留（首段 / reload 首段共用）。 */
  function mergeMonthWindow(prefix: string, page: { transactions?: TransactionView[] }): void {
    const rows = Array.isArray(page?.transactions) ? page.transactions : []
    const kept: TransactionView[] = []
    for (const txn of txns.value) {
      if (!txn.date.startsWith(prefix)) {
        kept.push(txn)
      }
    }
    txns.value = kept.concat(rows)
  }

  /**
   * 窗口响应落地：按月前缀并入快照并登记窗口集合（幂等，可被多个调用方重复调用）。
   * `page` 为 null（请求失败 / token 过期）时不做任何事。
   */
  function applyMonthWindow(prefix: string, page: TransactionListPage | null): void {
    if (page === null) {
      return
    }
    mergeMonthWindow(prefix, page)
    if (windowMonths.value.indexOf(prefix) < 0) {
      windowMonths.value.push(prefix)
    }
  }

  /**
   * 拉某月窗口（**只取数、不落库**）。异常被收敛成 null（静默，不写 `error`）：
   * 该月不会进 `windowMonths`，下次 `setWindowMonth` / reload 自然重试。
   * token 过期同样返回 null，由调用方决定是否落地——首段必须**整体成功后**
   * 才合并窗口（若窗口腿独立成功就合并，accountList 失败时会把当月旧快照行
   * 清掉，违反 SWR「失败不动旧快照」）。
   */
  async function fetchMonthWindowRaw(prefix: string, token: number): Promise<TransactionListPage | null> {
    try {
      const page = await transactionApi.listPage({ from: `${prefix}-01`, to: monthEndDate(prefix) })
      if (token !== epoch) {
        return null
      }
      return page
    } catch {
      // 窗口段失败静默（与补齐段同口径）：不写 error、不弹 UI。
      return null
    }
  }

  /**
   * 窗口请求单飞入口：同月并发共享同一 Promise（不去重「已拉过」——reload 需要
   * 对已拉月份强制刷新，缓存命中语义只属于 `setWindowMonth`）。
   * 返回原始响应，**调用方负责落地**（首段在整体成功后合并；setWindowMonth
   * 拿到响应立即合并；双份合并是同数据幂等操作）。
   */
  function fetchMonthWindow(prefix: string, token: number): Promise<TransactionListPage | null> {
    if (session.ledgerId === null || !MONTH_PREFIX_RE.test(prefix)) {
      return Promise.resolve(null)
    }
    const inflight = windowInflight.get(prefix)
    if (inflight !== undefined) {
      return inflight
    }
    const task = fetchMonthWindowRaw(prefix, token)
    windowInflight.set(prefix, task)
    const settle = (): void => {
      // 期间若被 reload()/reset() 清表后又发起同名请求，不要误删新的。
      if (windowInflight.get(prefix) === task) {
        windowInflight.delete(prefix)
      }
    }
    void task.then(settle, settle)
    return task
  }

  /**
   * 补齐段：全量拉取后整体替换 `txns`。**永不 reject**；失败静默
   * （fullReady 保持 false，不污染 `error`），下次 reload / 置脏重新调度。
   */
  async function runFullLoad(token: number): Promise<void> {
    if (session.ledgerId === null) {
      return
    }
    fullLoading.value = true
    try {
      const res = await transactionApi.list()
      if (token !== epoch) {
        return
      }
      // 防御性解析：响应缺 transactions（如旧 mock 复位后的 undefined）时按空处理，
      // 绝不让补齐段以 unhandled rejection 收场。
      const rows = Array.isArray(res?.transactions) ? res.transactions : []
      txns.value = rows
      fullReady.value = true
    } catch (err) {
      if (token === epoch) {
        // 静默：不写 error、不弹 UI；下次 reload / 置脏会重新调度补齐段。
        fullError.value = messageOf(err)
      }
    } finally {
      if (token === epoch) {
        fullLoading.value = false
      }
    }
  }

  /** 调度补齐段：首段成功后调用。iOS 14.8 / Safari 14.1 无 `requestIdleCallback`，
   * 用 `setTimeout(cb, 0)` 兜底；**回调发请求前先验 epoch**——期间 reset()/reload()
   * 会让 token 过期，回调直接返回、不发请求。
   */
  function scheduleFullLoad(token: number): void {
    const run = (): void => {
      if (token !== epoch) {
        return
      }
      void runFullLoad(token)
    }
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run)
    } else {
      setTimeout(run, 0)
    }
  }

  /**
   * 首段（窗口段）：账户全量 + 自然当月窗口。**永不 reject**：异常全部收敛到 `error`。
   *
   * @param token 发起时的 epoch；与当前 epoch 不一致说明期间切了账本 / reload 过，
   *     本次结果直接丢弃，不写任何状态。
   */
  async function runLoad(token: number): Promise<void> {
    if (session.ledgerId === null) {
      if (token === epoch) {
        error.value = NO_LEDGER_ERROR
        loading.value = false
      }
      return
    }
    loading.value = true
    error.value = ''
    try {
      const [accountRes, windowPage] = await Promise.all([
        // **必须带 `includeClosed: true`**：这里是「账本全量原始数据」，关户账户也在
        // 其中（资产页要统计它们、历史交易要显示其名称）。
        // 过滤责任留给**需要过滤的界面**：选择器一律自己排除关户账户
        // （如 `RecordSheet` 的 `openAccounts`、`SearchFilters` 的 close_date 判断）。
        // 若这里改回默认（不含关户），资产页的 `closedCount` 会恒为 0、
        // 「含 N 个已关户账户」永远不出现——有 `ledgerData.includeClosed.test.ts` 守着。
        accountApi.list({ includeClosed: true }),
        // 首段只拉「关注月」窗口（批 I 两段加载）：**不传 limit**——`limit` 缺省 =
        // 条件命中全量是冻结契约，窗口段靠 from/to（含端点闭区间）限定范围。
        // 窗口响应只在此缓冲，**整体成功后**才按月前缀落地（见 applyMonthWindow）。
        fetchMonthWindow(windowMonth.value, token),
      ])
      if (token !== epoch) {
        return
      }
      accounts.value = Array.isArray(accountRes?.accounts) ? accountRes.accounts : []
      applyMonthWindow(windowMonth.value, windowPage)
      loaded.value = true
      // 首段成功才调度补齐段；首段失败（含窗口腿失败导致整体失败）不调度。
      scheduleFullLoad(token)
    } catch (err) {
      if (token !== epoch) {
        return
      }
      // 不 throw：组件只看 error，避免 unhandled rejection 打断渲染。
      error.value = messageOf(err)
    } finally {
      if (token === epoch) {
        loading.value = false
      }
    }
  }

  /**
   * 真正「发起一次请求」的入口：并发调用共享同一个 Promise。
   * settle 时（成功或失败）清空 `pending`，因此失败后可重试。
   */
  function startLoad(): Promise<void> {
    if (pending !== null) {
      return pending
    }
    const task = runLoad(epoch)
    pending = task
    const settle = (): void => {
      // 期间若被 reset() / reload() 换过 pending，不要误清新的请求。
      if (pending === task) {
        pending = null
      }
    }
    void task.then(settle, settle)
    return task
  }

  /**
   * 确保数据已加载：`loaded` 为真直接返回；并发调用共享同一个 Promise。
   *
   * 失败的 Promise 会在 settle 时清掉 `pending`，因此下一次调用会重新发请求
   * （不缓存失败结果，一次网络抖动不会让页面永久空着）。
   */
  function ensure(): Promise<void> {
    if (pending !== null) {
      return pending
    }
    if (loaded.value) {
      return Promise.resolve()
    }
    return startLoad()
  }

  /**
   * 声明「正在看某月」（账单页挂载 / 切月时调用）。
   *
   * - `fullReady` 后：缓存命中 noop（全量快照已覆盖任何月份）；
   * - 补齐前：该月已拉过 → noop；在途 → 共享同一请求；
   *   未拉过 → 记录关注月并发起该月窗口请求（按月前缀并入快照）。
   *
   * 关注月 `windowMonth` 无论哪条分支都会更新：reload 的首段按它拉窗口，
   * 保证「保存记账后刷新的就是用户正在看的那个月」。
   */
  function setWindowMonth(prefix: string): Promise<void> {
    if (MONTH_PREFIX_RE.test(prefix)) {
      windowMonth.value = prefix
    }
    if (fullReady.value) {
      return Promise.resolve()
    }
    if (windowMonths.value.indexOf(prefix) >= 0) {
      return Promise.resolve()
    }
    const token = epoch
    return fetchMonthWindow(prefix, token).then((page) => {
      applyMonthWindow(prefix, page)
    })
  }

  /**
   * 强制重拉（保存记账 / 改账 / 删除后调用）。
   *
   * 会作废旧的在途请求，保证最终落地的是最新一次请求的结果；两段照跑。
   * **刻意不把 `loaded` / `fullReady` 置回 false**：刷新期间页面应继续显示旧快照
   * （stale-while-revalidate），否则每保存一笔就会整页闪一次骨架屏；全量态下
   * 首段窗口按月前缀替换（当月先刷新）、其余月份行保留，等补齐段整体回写。
   * 只有 `reset()`（切账本）才清空数据并回到首次加载态。
   */
  function reload(): Promise<void> {
    epoch += 1
    pending = null
    // 清窗口单飞表：旧 token 的在途窗口请求会被 epoch 守卫丢弃，
    // 不清表会让新首段「共享」到注定被丢弃的旧 Promise，当月窗口永远合并不上。
    windowInflight.clear()
    return startLoad()
  }

  /**
   * 清空快照（切账本 / 登出时用）。
   * 同时作废在途请求并复位 loading 与两段状态，避免切换后残留上一个账本的数据或转圈。
   */
  function reset(): void {
    epoch += 1
    pending = null
    windowInflight.clear()
    accounts.value = []
    txns.value = []
    error.value = ''
    loaded.value = false
    loading.value = false
    fullReady.value = false
    fullLoading.value = false
    fullError.value = ''
    windowMonths.value = []
    windowMonth.value = naturalMonthPrefix()
  }

  // E-08：切账本自动重建快照（默认 pre flush，store 内不依赖 DOM，无需 post）。
  watch(
    () => session.ledgerId,
    () => {
      reset()
      void ensure()
    },
  )

  // 快照失效的**唯一**信号：全局脏标记（本地写 / 同步 pull / 跨 tab 统一收敛）。
  // savedEpoch / dataEpoch 已降级为变更源内部计数，不再在此处分别订阅。
  // 页面 hidden 时置脏不立即拉，等 visibilitychange / focus / afterEach 的补偿检查；
  // visible 时走 checkAndReload() 即时拉，并由消费水位保证不与补偿检查重复请求。
  // 刻意不用 immediate：首次加载仍走视图的 ensure()，避免创建 store 就多打一次 reload。
  watch(
    () => dirtyByLedger[session.ledgerId ?? 0]?.version ?? 0,
    () => {
      if (!isPageVisible()) {
        return
      }
      checkAndReload(session.ledgerId ?? 0)
    },
  )

  // 激活补偿（router.afterEach / visibilitychange / focus）只做只读检查，
  // reload 的执行入口仍单点收敛在本 store 的 reload()，故注册一个回调即可。
  const unregisterReload = registerReloadHandler(() => {
    void reload()
  })
  onScopeDispose(unregisterReload)

  return {
    accounts,
    txns,
    loading,
    error,
    loaded,
    fullReady,
    ensure,
    reload,
    reset,
    setWindowMonth,
    hasMonthWindow,
  }
})
