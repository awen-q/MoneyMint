/**
 * 资产页聚合层（B5 / T50，纯逻辑）
 *
 * 把「账户余额列表」折叠成资产页要渲染的分组结构：
 * - **主币种小计**：只累加 `commodity` 那一列，外币**单列**、绝不进小计；
 * - **关户仍列出**：`close_date` 非空的账户照样出现在列表里，只打标记 ——
 *   隐藏它会造成「钱去哪了」：历史交易还在，账户却消失了；
 * - **组顺序固定**：资产在前、负债在后，不依赖对象 key 顺序。
 *
 * 三条铁律（与 `core/search.ts` / `core/bill.ts` 同源）：
 * 1. **禁跨币种求和**：不提供任何 `total` 字段；页面要合计只能按币种分行显示；
 * 2. **符号如实**：后端余额本身带符号（负债为负），禁止 `abs` / 按类型乘系数；
 * 3. **金额一律 `core/Money`**（Decimal 定点），禁止 parseFloat / 裸算术。
 *
 * 本模块**不**计算净资产 —— 那是 `core/record.ts` 的 `computeBalanceSummary`
 * 的唯一职责（首页与资产页 hero 同源）。这里只给「分组小计」，并且有交叉断言
 * 把两边的口径钉在一起（`assets.test.ts`：「分组小计之和 === computeBalanceSummary」）。
 */
import { Money } from './Money'
import { isClosed, type SummaryAccount } from './accounts'
import { accountLabel } from './record'

/** 资产页只关心这两类账户。 */
export type AssetGroupType = 'Assets' | 'Liabilities'

/** 一行资产（一个账户的某个币种余额；多币种账户会产生多行）。 */
export interface AssetRow {
  /** 账户 id（用于点击进详情 / 关户标记的唯一性 key）。 */
  accountId: number
  /** 展示名（`display_name` 优先，回落 Beancount 全名）。 */
  label: string
  /** Beancount 全名（可核对、可与导出文件对照）。 */
  fullName: string
  /** 该行金额（**该行自身币种**的定点串，符号如实保留）。 */
  amount: string
  /** 该行币种。 */
  commodity: string
  /** 是否外币（`commodity !== 主币种`）；外币不计入组小计。 */
  isForeign: boolean
  /** 是否已关户（仍列出，仅标注）。 */
  closed: boolean
}

/** 外币小计：**按币种各算各的**，供组头「另有 $X（USD）」一句展示。 */
export interface AssetForeignSubtotal {
  commodity: string
  /** 该币种在本组内的合计（定点串，符号如实）。 */
  amount: string
}

/** 一个账户组（资产 / 负债）。 */
export interface AssetGroup {
  type: AssetGroupType
  /** 组名（资产 / 负债）。 */
  label: string
  /** 主币种小计（符号保留：负债组为负）。外币不计入。 */
  subtotal: string
  /** 主币种行（按 sort_order、id 稳定排序）。 */
  rows: AssetRow[]
  /** 外币行（自身币种展示；**不进** `subtotal`）。 */
  foreignRows: AssetRow[]
  /**
   * 外币分币种小计（按币种代码字典序，空数组表示本组没有外币）。
   *
   * 这是「另有 $X（USD）」那句的唯一数据来源：**组件不做金额加法**，
   * 与 `subtotal` 同一次遍历产出，避免两处口径漂移。
   * 仍然**不提供**跨币种合计 —— 那是错的。
   */
  foreignSubtotals: AssetForeignSubtotal[]
}

/** 整页所需的分组结构。 */
export interface AssetBreakdown {
  /** 主币种（小计与 hero 的口径）。 */
  commodity: string
  /** 恒为两组：`Assets` 在前、`Liabilities` 在后。 */
  groups: AssetGroup[]
  /** 出现过的外币币种（去重、字典序），用于「外币说明」文案。 */
  foreignCommodities: string[]
  /** 行总数（含外币行）；`0` 即「没有可展示的资产账户」。 */
  rowCount: number
  /** 关户账户数（用于「已关户仍列出」的提示）。 */
  closedCount: number
}

const GROUP_LABELS: Record<AssetGroupType, string> = {
  Assets: '资产',
  Liabilities: '负债',
}

/** 组顺序：恒为资产在前、负债在后（不依赖对象 key 顺序）。 */
const GROUP_ORDER: readonly AssetGroupType[] = ['Assets', 'Liabilities']

function moneyOf(amount: string): Money {
  try {
    return Money.from(amount)
  } catch {
    return Money.zero()
  }
}

/** 稳定排序：`sort_order` 升序（缺省取 0），再按 id，最后按名称。 */
function compareAccount(left: SummaryAccount, right: SummaryAccount): number {
  const leftOrder = left.sort_order === undefined ? 0 : left.sort_order
  const rightOrder = right.sort_order === undefined ? 0 : right.sort_order
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder
  }
  if (left.id !== right.id) {
    return left.id - right.id
  }
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

function isAssetGroupType(type: string): type is AssetGroupType {
  return type === 'Assets' || type === 'Liabilities'
}

/**
 * 构造资产页的分组结构。
 *
 * 行粒度是「账户 × 币种」：一个账户若同时有 CNY 与 USD 余额，会产出两行 ——
 * 主币种行进 `rows`、外币行进 `foreignRows`。这样「名称 · 金额 · 货币」三列
 * 始终自洽，也不会出现「一行里塞两个币种、小计算哪个都错」。
 *
 * 没有任何余额数据的账户仍产出一行（主币种 `0.00`）：关户或新开户账户必须可见，
 * 否则用户会以为账户丢了。
 *
 * @param accounts 当前账本全部账户（**含**关户；本模块不过滤）
 * @param commodity 主币种（页面取 `period` 的当前币种）
 */
export function buildAssetBreakdown(
  accounts: readonly SummaryAccount[],
  commodity: string,
): AssetBreakdown {
  const buckets: Record<AssetGroupType, SummaryAccount[]> = { Assets: [], Liabilities: [] }
  for (const account of accounts) {
    if (!isAssetGroupType(account.type)) {
      continue
    }
    buckets[account.type].push(account)
  }

  const groups: AssetGroup[] = []
  const foreignSeen: string[] = []
  let rowCount = 0
  let closedCount = 0

  for (const type of GROUP_ORDER) {
    const list = buckets[type].slice().sort(compareAccount)
    const rows: AssetRow[] = []
    const foreignRows: AssetRow[] = []
    /** 外币分币种累加器：币种 → 定点金额（**每个币种各算各的**）。 */
    const foreignTotals: Record<string, Money> = {}
    let subtotal = Money.zero()

    for (const account of list) {
      const closed = isClosed(account)
      if (closed) {
        closedCount += 1
      }
      const balances = account.balances === undefined ? {} : account.balances
      const codes = Object.keys(balances)
      if (codes.length === 0) {
        // 无余额数据也列出（关户 / 新开户），按主币种 0.00 展示。
        rows.push({
          accountId: account.id,
          label: accountLabel(account),
          fullName: account.name,
          amount: '0.00',
          commodity,
          isForeign: false,
          closed,
        })
        rowCount += 1
        continue
      }
      // 主币种排在最前，其余按币种代码字典序（同一账户的多币种行顺序稳定）。
      const ordered = codes.slice().sort((left, right) => {
        if (left === commodity) {
          return -1
        }
        if (right === commodity) {
          return 1
        }
        return left < right ? -1 : left > right ? 1 : 0
      })
      for (const code of ordered) {
        const amount = moneyOf(balances[code])
        const isForeign = code !== commodity
        const row: AssetRow = {
          accountId: account.id,
          label: accountLabel(account),
          fullName: account.name,
          amount: amount.toString(),
          commodity: code,
          isForeign,
          closed,
        }
        if (isForeign) {
          foreignRows.push(row)
          const previous = foreignTotals[code]
          foreignTotals[code] = previous === undefined ? amount : previous.plus(amount)
          if (foreignSeen.indexOf(code) < 0) {
            foreignSeen.push(code)
          }
        } else {
          rows.push(row)
          // 只加主币种 —— 外币绝不进小计（跨币种求和永远是错的）。
          subtotal = subtotal.plus(amount)
        }
        rowCount += 1
      }
    }

    const foreignSubtotals: AssetForeignSubtotal[] = Object.keys(foreignTotals)
      .sort()
      .map((code) => ({ commodity: code, amount: foreignTotals[code].toString() }))

    groups.push({
      type,
      label: GROUP_LABELS[type],
      subtotal: subtotal.toString(),
      rows,
      foreignRows,
      foreignSubtotals,
    })
  }

  foreignSeen.sort()

  return {
    commodity,
    groups,
    foreignCommodities: foreignSeen,
    rowCount,
    closedCount,
  }
}
