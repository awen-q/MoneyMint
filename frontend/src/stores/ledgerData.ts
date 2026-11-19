/**
 * 账本数据单例（批 5 / 视图收敛）
 *
 * 背景：首页 / 账单 / 报表 / 资产统计 / 分类页原先各自 `onMounted` 里
 * `accountApi.list() + transactionApi.list()` 拉全量再本地过滤，同一账本在
 * 页面间来回切换会重复发请求。本 store 把这份「全量快照」收敛成单例：
 *
 * - `ensure()`：未加载过才拉；并发调用共享同一个 Promise（单例请求）；
 * - `reload()`：强制重拉（保存记账 / 改账 / 删除后调）；
 * - `reset()`：清空快照（切账本时由内部 watch 调用）；
 * - 内部 `watch(session.ledgerId)`：切账本自动 `reset()` + `ensure()`。
 *
 * 三条硬约束（勿回退）：
 * 1. 失败**不缓存** Promise：一次网络抖动清空 pending，下次 `ensure()` 可重试，
 *    否则页面会永久空着；
 * 2. 错误只写 `error`（空串表示无错），**不向组件层 throw**，组件只看 error；
 * 3. 账本 id 变化时用自增 `epoch` 丢弃在途请求的回写，防止 A 账本的慢响应
 *    覆盖 B 账本的数据。
 */
import { ref, watch, type Ref } from 'vue'
import { defineStore } from 'pinia'

import { accountApi, transactionApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { AccountView, TransactionView } from '@/api/types'
import { useSessionStore } from '@/stores/session'

/** 加载失败的兜底文案（与现网页面口径一致；ApiError 自带文案优先）。 */
const DEFAULT_LOAD_ERROR = '账本数据加载失败，请重试'

/** 未选择账本时的提示（`ensure()` 在 `ledgerId` 为空时写入 `error`，由页面 `StateCard` 呈现）。 */
const NO_LEDGER_ERROR = '尚未选择账本'

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

export const useLedgerDataStore = defineStore('ledgerData', () => {
  const session = useSessionStore()

  /** 当前账本的账户全量快照。 */
  const accounts: Ref<AccountView[]> = ref<AccountView[]>([])
  /** 当前账本的交易全量快照。 */
  const txns: Ref<TransactionView[]> = ref<TransactionView[]>([])
  /** 是否正在加载（并发请求共享同一次加载）。 */
  const loading: Ref<boolean> = ref<boolean>(false)
  /** 错误文案，空串表示无错。 */
  const error: Ref<string> = ref<string>('')
  /** 是否至少成功加载过一次（`ensure()` 的短路依据）。 */
  const loaded: Ref<boolean> = ref<boolean>(false)

  /** 模块内单例请求：并发 `ensure()` 只发一次，settle 后清空（失败也可重试）。 */
  let pending: Promise<void> | null = null
  /** 复位代数：`reset()` / `reload()` 自增，在途请求据 token 丢弃过期回写。 */
  let epoch = 0

  /**
   * 真正发起一次全量拉取。**永不 reject**：异常全部收敛到 `error`。
   *
   * @param token 发起时的 epoch；与当前 epoch 不一致说明期间切了账本，
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
      const [accountRes, transactionRes] = await Promise.all([
        // **必须带 `includeClosed: true`**：这里是「账本全量原始数据」，关户账户也在
        // 其中（资产页要统计它们、历史交易要显示其名称）。
        // 过滤责任留给**需要过滤的界面**：选择器一律自己排除关户账户
        // （如 `RecordSheet` 的 `openAccounts`、`SearchFilters` 的 close_date 判断）。
        // 若这里改回默认（不含关户），资产页的 `closedCount` 会恒为 0、
        // 「含 N 个已关户账户」永远不出现——有 `ledgerData.includeClosed.test.ts` 守着。
        accountApi.list({ includeClosed: true }),
        transactionApi.list(),
      ])
      if (token !== epoch) {
        return
      }
      accounts.value = Array.isArray(accountRes.accounts) ? accountRes.accounts : []
      txns.value = Array.isArray(transactionRes.transactions)
        ? transactionRes.transactions
        : []
      loaded.value = true
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
   * 强制重拉（保存记账 / 改账 / 删除后调用）。
   *
   * 会作废旧的在途请求，保证最终落地的是最新一次请求的结果。
   * **刻意不把 `loaded` 置回 false**：刷新期间页面应继续显示旧快照
   * （stale-while-revalidate），否则每保存一笔就会整页闪一次骨架屏；
   * 只有 `reset()`（切账本）才清空数据并回到首次加载态。
   */
  function reload(): Promise<void> {
    epoch += 1
    pending = null
    return startLoad()
  }

  /**
   * 清空快照（切账本 / 登出时用）。
   * 同时作废在途请求并复位 loading，避免切换后残留上一个账本的数据或转圈。
   */
  function reset(): void {
    epoch += 1
    pending = null
    accounts.value = []
    txns.value = []
    error.value = ''
    loaded.value = false
    loading.value = false
  }

  // E-08：切账本自动重建快照（默认 pre flush，store 内不依赖 DOM，无需 post）。
  watch(
    () => session.ledgerId,
    () => {
      reset()
      void ensure()
    },
  )

  return {
    accounts,
    txns,
    loading,
    error,
    loaded,
    ensure,
    reload,
    reset,
  }
})
