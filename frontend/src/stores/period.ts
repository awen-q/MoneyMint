/**
 * 跨页「浏览态」快照（批 5 / 视图收敛）
 *
 * 账单页、统计页、资产统计页各自维护自己的「年 / 月 / 币种 / tab」，用户在
 * A 页选的月份切到 B 页就丢，币种还可能出现「账单页看美元、统计页看人民币」
 * 的口径分裂。本 store 把这份浏览态收敛成单源：
 *
 * - `bills` 与 `stats` 的 **年 / 月相互独立**（切月只改自己那一页）；
 * - `bills` 与 `stats` 的 **commodity 共享**（`setCommodity` 同时改两处）；
 * - 切账本（`session.ledgerId` 变化）时：年 / 月 / `stats.tab` 保留，
 *   `commodity` 重置为该账本默认币种（`session.defaultCommodity`，兜底 CNY）；
 * - `resetAll()`：全部回到「当前年月 + CNY + tab='stat'」。
 *
 * 本 store 只存数字与字符串，不碰 DOM、不 import 任何组件，也不做浮点运算。
 */
import { computed, ref, watch, type Ref } from 'vue'
import { defineStore } from 'pinia'

import { useSessionStore } from '@/stores/session'

/** 统计页的两个下钻视图：按分类统计 / 按 #tag 统计。 */
export type StatsTab = 'stat' | 'tag'

/** 账单页浏览态（`month` 为 1-12，不是 `Date.getMonth()` 的 0-11）。 */
export interface BillsPeriod {
  year: number
  month: number
  commodity: string
}

/** 统计页浏览态（月份与账单页独立，币种与账单页共享）。 */
export interface StatsPeriod {
  year: number
  month: number
  commodity: string
  tab: StatsTab
}

/** 资产统计页浏览态（只按年）。 */
export interface AssetsPeriod {
  year: number
}

/** 无账本 / 账本无默认币种时的兜底币种。 */
const DEFAULT_COMMODITY = 'CNY'
/** 年份合法区间：防御 `null` / `NaN` / 负数等脏输入把日历画崩。 */
const MIN_YEAR = 1970
const MAX_YEAR = 9999

/** 当前年份（每次调用取实时值，跨年后 `resetAll()` 自然正确）。 */
function currentYear(): number {
  return new Date().getFullYear()
}

/** 当前月份（1-12）。 */
function currentMonth(): number {
  return new Date().getMonth() + 1
}

/** 年份归一：非法 / 越界回退到 `fallback`，小数截断。 */
function normalizeYear(value: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  const year = Math.trunc(value)
  if (year < MIN_YEAR) {
    return MIN_YEAR
  }
  if (year > MAX_YEAR) {
    return MAX_YEAR
  }
  return year
}

/** 月份归一：夹到 1-12，小数截断；非法回退 `fallback`。 */
function normalizeMonth(value: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  const month = Math.trunc(value)
  if (month < 1) {
    return 1
  }
  if (month > 12) {
    return 12
  }
  return month
}

/** 币种归一：空串 / 非字符串一律回退兜底币种，避免出现空币种查询。 */
function normalizeCommodity(value: string, fallback: string): string {
  if (typeof value !== 'string' || value === '') {
    return fallback
  }
  return value
}

export const usePeriodStore = defineStore('period', () => {
  const session = useSessionStore()

  const startYear = currentYear()
  const startMonth = currentMonth()
  // 初始币种取当前账本默认（无账本时 session 已兜底 CNY）。
  const startCommodity = normalizeCommodity(session.defaultCommodity, DEFAULT_COMMODITY)

  const bills: Ref<BillsPeriod> = ref<BillsPeriod>({
    year: startYear,
    month: startMonth,
    commodity: startCommodity,
  })
  const stats: Ref<StatsPeriod> = ref<StatsPeriod>({
    year: startYear,
    month: startMonth,
    commodity: startCommodity,
    tab: 'stat',
  })
  const assets: Ref<AssetsPeriod> = ref<AssetsPeriod>({ year: startYear })

  /**
   * 当前币种（**只读别名**，值恒等于 `bills.commodity` ≡ `stats.commodity`）。
   *
   * 存在的理由：非账单 / 非统计的页面（如资产页）也需要币种，但不该去读
   * `bills.commodity` 或 `stats.commodity` —— 那会让「资产页取哪个页的币种」
   * 变成每次随手的偏好。写入仍只能走 `setCommodity` / `resetCommodity`。
   */
  const commodity = computed<string>(() => bills.value.commodity)

  /** 账单页切月：只改 bills，不影响统计页。 */
  function setBillsMonth(year: number, month: number): void {
    bills.value = {
      year: normalizeYear(year, bills.value.year),
      month: normalizeMonth(month, bills.value.month),
      commodity: bills.value.commodity,
    }
  }

  /** 统计页切月：只改 stats，不影响账单页。 */
  function setStatsMonth(year: number, month: number): void {
    stats.value = {
      year: normalizeYear(year, stats.value.year),
      month: normalizeMonth(month, stats.value.month),
      commodity: stats.value.commodity,
      tab: stats.value.tab,
    }
  }

  /**
   * 切币种：bills 与 stats **同时**改（跨页币种单源的关键）。
   * 空串回退当前值，避免把空币种写进查询。
   */
  function setCommodity(commodity: string): void {
    const next = commodity === '' ? bills.value.commodity : commodity
    bills.value = { ...bills.value, commodity: next }
    stats.value = { ...stats.value, commodity: next }
  }

  /** 统计页切 tab（按分类 / 按 #tag）。 */
  function setStatsTab(tab: StatsTab): void {
    stats.value = { ...stats.value, tab: tab === 'tag' ? 'tag' : 'stat' }
  }

  /** 资产统计页切年。 */
  function setAssetsYear(year: number): void {
    assets.value = { year: normalizeYear(year, assets.value.year) }
  }

  /** 把两页币种一起改成指定默认币种（账本默认变化 / 设置页改默认时调用）。 */
  function resetCommodity(defaultCommodity: string): void {
    const next = normalizeCommodity(defaultCommodity, DEFAULT_COMMODITY)
    bills.value = { ...bills.value, commodity: next }
    stats.value = { ...stats.value, commodity: next }
  }

  /** 全部复位：当前年月 + CNY + tab='stat'。 */
  function resetAll(): void {
    const year = currentYear()
    const month = currentMonth()
    bills.value = { year, month, commodity: DEFAULT_COMMODITY }
    stats.value = { year, month, commodity: DEFAULT_COMMODITY, tab: 'stat' }
    assets.value = { year }
  }

  // 切账本：月份 / 年份 / tab 保留（用户正在看的区间不该被账本切换打断），
  // 但币种必须回到新账本的默认币种 —— 否则会把 A 账本的 USD 带到 B 账本。
  watch(
    () => session.ledgerId,
    () => {
      resetCommodity(session.defaultCommodity)
    },
  )

  return {
    bills,
    stats,
    assets,
    commodity,
    setBillsMonth,
    setStatsMonth,
    setCommodity,
    setStatsTab,
    setAssetsYear,
    resetCommodity,
    resetAll,
  }
})
