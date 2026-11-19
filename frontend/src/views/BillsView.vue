<script setup lang="ts">
/**
 * 账单页（B2 / design.md 首页【账单】）
 *
 * 六区块顺序严格按 v4.1 稿：hero → 工具卡 → 日历卡 → 指标带 → 折线卡 → 月列表卡。
 *
 * 三条本页级别的设计决策：
 *
 * 1. **`hero` 与工具卡在 StateCard 之外**。
 *    四态卡承载「内容区」（日历 / 指标 / 折线 / 列表），但**不包 hero 与工具卡**：
 *    某月无交易时若连月份 chip 一起换成「暂无数据」，用户就没有任何入口切到别的月份，
 *    页面变成死路。同理加载失败时也必须能换月/换账本。这条与「StateCard 承载整页四态」
 *    字面不同，是为了不让 empty / error 变成死路。
 *
 * 2. **所有金额只来自 `core/bill.ts`，页面不做任何算术**。
 *    `monthTotals` / `daySeries` / `billCells` 三者同源自一份日桶，因此
 *    「日历格加起来 ≠ 卡头合计」这类缺陷在结构上不可能发生；页面若自己 reduce 一遍
 *    就等于引入第二个真相源。
 *
 * 3. **状态判据用冻结的 v3.2**（`error` 只在「从未成功加载过」时整页报错）。
 *    `ledgerData` 是 stale-while-revalidate 的：刷新失败但有旧快照时仍走 `ready`，
 *    只在顶部出一条内联提示条——否则用户正在看的报表会在后台刷新失败时整页消失。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { billCells, daySeries, monthTotals } from '@/core/bill'
import { buildMonthGrid, type CalendarDay } from '@/core/calendar'
import type { LineSeriesInput } from '@/core/charts/option'
import { PRIVACY_MASK } from '@/core/privacy'
import { buildTxnRow, type TxnRowView } from '@/core/txnRow'
import { getChartPalette, readThemeTokens, themeEpoch } from '@/styles/themeTokens'
import { useLedgerDataStore } from '@/stores/ledgerData'
import { usePeriodStore } from '@/stores/period'
import { usePrivacyStore } from '@/stores/privacy'
import { useSessionStore } from '@/stores/session'
import MoneyText from '@/components/MoneyText.vue'
import BillCalendar from '@/components/bill/BillCalendar.vue'
import BillMetrics from '@/components/bill/BillMetrics.vue'
import TxnRow from '@/components/TxnRow.vue'
import TrendChart from '@/components/charts/TrendChart.vue'
import LedgerSwitcher from '@/components/shell/LedgerSwitcher.vue'
import MonthPicker from '@/components/shell/MonthPicker.vue'
import StateCard from '@/components/shell/StateCard.vue'

/** 刷新失败但仍有旧快照时的内联提示（四页逐字统一）。 */
const STALE_NOTICE = '刷新失败，当前显示的是上次数据'

const router = useRouter()
const data = useLedgerDataStore()
const period = usePeriodStore()
const privacy = usePrivacyStore()
const session = useSessionStore()

/** 月份选择弹层 / 账本切换弹层。 */
const monthOpen = ref(false)
const ledgerOpen = ref(false)
/** 被点选的日（1..31）；`null` 表示看整月。 */
const selectedDay = ref<number | null>(null)

// 账本数据全量快照：**必须**在挂载时拉一次。
// `!loaded → loading` 的判据意味着漏调它表现为「永久骨架屏」，所以这条调用有测试守。
onMounted(() => {
  void data.ensure()
})

// 切账本时 `ledgerData` 的 `reset()` 会清空快照，本页要重新拉取并清掉选中的日。
// 用 `watch` 而不是 `session.$subscribe`：订阅需要手动退订，watch 随组件销毁自动停。
watch(
  () => session.ledgerId,
  () => {
    selectedDay.value = null
  },
)

const year = computed(() => period.bills.year)
const month = computed(() => period.bills.month)
const commodity = computed(() => period.bills.commodity)

function twoDigits(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 当月前缀 `YYYY-MM`：页面的月份过滤只做这一件事（聚合全部交给 core）。 */
const monthPrefix = computed(() => `${year.value}-${twoDigits(month.value)}`)

/** 当月交易（`ledgerData.txns` 是全量历史，不做周期过滤，故在此按前缀筛）。 */
const monthTxns = computed(() => data.txns.filter((txn) => txn.date.startsWith(monthPrefix.value)))

const totals = computed(() => monthTotals(monthTxns.value, commodity.value))
const series = computed(() => daySeries(monthTxns.value, year.value, month.value, commodity.value))
const cells = computed(() => billCells(monthTxns.value, year.value, month.value, commodity.value))

/** 有交易的天数（日历卡头摘要用）。 */
const activeDays = computed(() => {
  let count = 0
  for (const point of series.value) {
    if (point.count > 0) {
      count += 1
    }
  }
  return count
})

/** 日历 42 格：本月格用 `billCells`，前后月补位格由 `buildMonthGrid` 给出。 */
const grid = computed<CalendarDay[]>(() => {
  const dayTotals: Record<string, { expense: string; income: string }> = {}
  for (const point of series.value) {
    dayTotals[`${year.value}-${twoDigits(month.value)}-${twoDigits(point.day)}`] = {
      expense: point.expense,
      income: point.income,
    }
  }
  return buildMonthGrid(year.value, month.value, dayTotals)
})

function toggleDay(day: number): void {
  selectedDay.value = selectedDay.value === day ? null : day
}

/** 交易日列表：按日倒序分组；选中某日后只留该日。 */
interface DayGroup {
  date: string
  label: string
  expense: string
  income: string
  rows: TxnRowView[]
}

const groups = computed<DayGroup[]>(() => {
  const filtered =
    selectedDay.value === null
      ? monthTxns.value
      : monthTxns.value.filter((txn) => Number(txn.date.slice(8, 10)) === selectedDay.value)
  const sorted = filtered.slice().sort((left, right) => {
    if (left.date !== right.date) {
      return left.date < right.date ? 1 : -1
    }
    return right.id - left.id
  })
  const out: DayGroup[] = []
  for (const txn of sorted) {
    const day = Number(txn.date.slice(8, 10))
    const point = series.value[day - 1]
    let group = out.length > 0 ? out[out.length - 1] : undefined
    if (group === undefined || group.date !== txn.date) {
      group = {
        date: txn.date,
        label: `${month.value}月${day}日`,
        expense: point === undefined ? '0.00' : point.expense,
        income: point === undefined ? '0.00' : point.income,
        rows: [],
      }
      out.push(group)
    }
    group.rows.push(buildTxnRow(txn, data.accounts, 'bill'))
  }
  return out
})

/**
 * 日筛选行显示的笔数（稿 app.js:634「已选 11-05 · 3 笔」）。
 * 数量取自当前已过滤的分组，不重新筛一遍原始数组。
 */
const selectedCount = computed(() => {
  let count = 0
  for (const group of groups.value) {
    count += group.rows.length
  }
  return count
})

/** 图表配色跟随主题：`themeEpoch` 让夜间主题切换后重新取色。 */
const palette = computed(() => {
  void themeEpoch.value
  return getChartPalette(readThemeTokens())
})

const dayLabels = computed(() => series.value.map((point) => String(point.day)))

/**
 * 逐日双线。`value` 与 `amount` 都直接取自 `daySeries` 的定点串
 * （**不**用 `value * 100` 反算金额）：图表 tooltip 显示的金额必须与
 * 日历格、卡头合计是同一个串，否则三处会各说各话。
 *
 * 两条线都取正值：与现网报表页的双正线口径一致，避免同一笔数据在两页
 * 一正一负、用户以为方向标错了。
 */
const trendSeries = computed<LineSeriesInput[]>(() => [
  {
    name: '收入',
    color: palette.value.income,
    points: series.value.map((point) => ({ value: Number(point.income), amount: point.income })),
  },
  {
    name: '支出',
    color: palette.value.expense,
    points: series.value.map((point) => ({ value: Number(point.expense), amount: point.expense })),
  },
])

/** 整页四态（v3.2，逐字照用）。 */
const pageState = computed<'loading' | 'error' | 'empty' | 'ready'>(() => {
  if (data.error !== '' && !data.loaded) {
    return 'error'
  }
  if (!data.loaded) {
    return 'loading'
  }
  if (monthTxns.value.length === 0) {
    return 'empty'
  }
  return 'ready'
})

/** 有旧快照时的刷新失败：留在 ready，只出内联条。 */
const staleError = computed(() => (data.error !== '' && data.loaded ? data.error : ''))

/** 四态卡的说明文案（标题用 StateCard 的默认：加载失败 / 暂无数据）。 */
const cardDesc = computed(() => {
  if (pageState.value === 'error') {
    return '请检查网络后重试。'
  }
  if (pageState.value === 'empty') {
    return '当前月份没有记录。'
  }
  return ''
})

function reload(): void {
  // 重试入口只允许 `reload()`：`ensure()` 在 `loaded === true` 时短路，点了没反应。
  void data.reload()
}

function shiftMonth(delta: number): void {
  let nextMonth = month.value + delta
  let nextYear = year.value
  if (nextMonth < 1) {
    nextMonth = 12
    nextYear -= 1
  } else if (nextMonth > 12) {
    nextMonth = 1
    nextYear += 1
  }
  selectedDay.value = null
  period.setBillsMonth(nextYear, nextMonth)
}

function onMonthSelect(payload: { year: number; month: number }): void {
  monthOpen.value = false
  selectedDay.value = null
  period.setBillsMonth(payload.year, payload.month)
}

function onLedgerSelect(id: number | string): void {
  ledgerOpen.value = false
  selectedDay.value = null
  session.selectLedger(Number(id))
}

/** 现网账户里出现过的币种 + 当前币种（去重、稳定排序）。 */
const commodities = computed(() => {
  const out: string[] = []
  const push = (value: string): void => {
    if (value !== '' && out.indexOf(value) < 0) {
      out.push(value)
    }
  }
  push(commodity.value)
  for (const txn of data.txns) {
    for (const posting of txn.postings) {
      push(posting.commodity)
    }
  }
  return out
})

function setCommodity(value: string): void {
  period.setCommodity(value)
}

/**
 * 行点击 → 交易详情（与现网 TransactionsView 同一条路由与 query 键）。
 * id 取自 `TxnRowView.id`（`core/txnRow.ts` 已透出），**不要**在页面里另存一份 id。
 */
function openDetail(id: number): void {
  void router.push({ name: 'transaction-detail', query: { id: String(id) } })
}

function goSearch(): void {
  // 直连搜索页。**不要**再经过 `/transactions`：T38 起那是函数式重定向路由，
  // 走它只是多一跳，而且会让人以为这里还依赖一笔「旧流水页」的历史。
  void router.push({ name: 'search' })
}

function goStats(): void {
  // 统计账单页（B4）已上线，直连；不要经由 /reports 中转 —— 那会多一跳，
  // 且会让读者以为这里还存在一层间接。
  void router.push({ name: 'stats' })
}
</script>

<template>
  <section class="bills">
    <!-- ① hero：页名 + 当期摘要（12px 单行）。答案放首屏，避免日历卡把指标挤到第二屏 -->
    <header class="bills__hero">
      <h1 class="bills__title">账单</h1>
      <p class="bills__summary">
        <span class="bills__summary-item">
          支出
          <MoneyText :amount="totals.expense" :commodity="commodity" size="sm" />
        </span>
        <span class="bills__summary-sep" aria-hidden="true">·</span>
        <span class="bills__summary-item">
          收入
          <MoneyText :amount="totals.income" :commodity="commodity" size="sm" />
        </span>
        <span class="bills__summary-sep" aria-hidden="true">·</span>
        <span class="bills__summary-item">
          结余
          <MoneyText :amount="totals.balance" :commodity="commodity" size="sm" signed />
        </span>
      </p>
    </header>

    <!-- ② 工具卡：账本 chip ｜ 月份 chip ｜ 币种 seg ｜ 搜索 / 统计 -->
    <div class="bills__tools">
      <button type="button" class="bills__chip" @click="ledgerOpen = true">
        <span class="bills__chip-label">{{ session.ledgerName }}</span>
        <span class="bills__chip-caret" aria-hidden="true">⌄</span>
      </button>

      <span class="bills__month">
        <button type="button" class="bills__arrow" aria-label="上个月" @click="shiftMonth(-1)">‹</button>
        <button type="button" class="bills__chip bills__chip--month" @click="monthOpen = true">
          {{ year }} 年 {{ month }} 月
        </button>
        <button type="button" class="bills__arrow" aria-label="下个月" @click="shiftMonth(1)">›</button>
      </span>

      <span v-if="commodities.length > 1" class="bills__seg" role="group" aria-label="币种">
        <button
          v-for="item in commodities"
          :key="item"
          type="button"
          class="bills__seg-btn"
          :class="{ 'bills__seg-btn--on': item === commodity }"
          :aria-pressed="item === commodity"
          @click="setCommodity(item)"
        >{{ item }}</button>
      </span>

      <span class="bills__tools-end">
        <button type="button" class="bills__icon" aria-label="搜索账单" @click="goSearch">
          <span aria-hidden="true">🔍</span>
        </button>
        <button type="button" class="bills__icon" aria-label="统计账单" @click="goStats">
          <span aria-hidden="true">◔</span>
        </button>
      </span>
    </div>

    <!-- 刷新失败但有旧快照：留在 ready，只出内联提示条（组件不改，页面自己画） -->
    <p v-if="staleError !== ''" class="bills__stale" role="status">
      <span class="bills__stale-text">{{ STALE_NOTICE }}</span>
      <button type="button" class="bills__stale-btn" @click="reload">重试</button>
    </p>

    <!-- ③–⑥ 内容区四态（标题/说明用 StateCard 默认，避免 error 态被写成「账单」） -->
    <StateCard :state="pageState" :desc="cardDesc" @action="reload">
      <!-- ③ 日历卡（内容由 BillCalendar 承担，卡片外观由本页给） -->
      <section class="bills__card">
        <BillCalendar
          :year="year"
          :month="month"
          :grid="grid"
          :cells="cells"
          :totals="totals"
          :commodity="commodity"
          :active-days="activeDays"
          :selected-day="selectedDay"
          :masked="privacy.enabled"
          @pick="toggleDay"
        />
      </section>

      <!-- ④ 指标带 -->
      <BillMetrics :totals="totals" :commodity="commodity" />

      <!-- ⑤ 折线卡 -->
      <section class="bills__card bills__card--chart">
        <TrendChart
          title="每日收支"
          :chart-label="`${month} 月每日收入与支出，按自然日`"
          :labels="dayLabels"
          :series="trendSeries"
          :commodity="commodity"
          :masked="privacy.enabled"
        />
      </section>

      <!-- ⑥ 月列表卡：按日分组，行用 TxnRow bill 档 -->
      <section class="bills__card">
        <h2 class="bills__card-title">当月明细</h2>
        <!-- 日筛选行（稿 889-892）：搬到这里而不是留在日历卡里 ——
             「查看整月 ✕」清的是**这个列表**的日筛选，放在要清的东西旁边才不会让人找。 -->
        <div v-if="selectedDay !== null" class="bills__dayfilter">
          <span class="bills__dayfilter-chip">
            已选 {{ month }}-{{ twoDigits(selectedDay) }} · {{ selectedCount }} 笔
          </span>
          <button type="button" class="bills__dayfilter-clear" @click="selectedDay = null">查看整月 ✕</button>
        </div>
        <div v-for="group in groups" :key="group.date" class="bills__group">
          <div class="bills__group-head">
            <span class="bills__group-date">{{ group.label }}</span>
            <span class="bills__group-sum">
              <MoneyText :amount="group.expense" :commodity="commodity" size="sm" />
              <MoneyText :amount="group.income" :commodity="commodity" size="sm" signed />
            </span>
          </div>
          <ul class="bills__rows">
            <li v-for="row in group.rows" :key="row.id" class="bills__row">
              <TxnRow :view="row" variant="bill" @open="openDetail(row.id)" />
            </li>
          </ul>
        </div>
      </section>
    </StateCard>

    <!-- 弹层 -->
    <MonthPicker
      :open="monthOpen"
      :value="{ year: year, month: month }"
      :min-year="1970"
      :max-year="2100"
      @select="onMonthSelect"
      @close="monthOpen = false"
    />
    <LedgerSwitcher
      :open="ledgerOpen"
      :ledgers="session.ledgers"
      :current-id="session.ledgerId ?? ''"
      @select="onLedgerSelect"
      @close="ledgerOpen = false"
    />
  </section>
</template>

<style scoped>
.bills {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 8px;
}

/* ① hero */
.bills__hero {
  padding: 4px 0 2px;
}

.bills__title {
  margin: 0;
  color: var(--fb-ink-deep);
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 0.01em;
}

.bills__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px;
  margin: 4px 0 0;
  color: var(--fb-sub);
  font-size: 12px;
  line-height: 1.5;
}

.bills__summary-item {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
}

.bills__summary-sep {
  color: var(--fb-line-strong);
}

/* ② 工具卡 */
.bills__tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.bills__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding: 8px 12px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.bills__chip-label {
  max-width: 128px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bills__chip-caret {
  color: var(--fb-sub);
}

.bills__chip--month {
  font-variant-numeric: var(--fb-font-numeric);
  font-weight: 600;
}

.bills__month {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.bills__arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.bills__seg {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
}

.bills__seg-btn {
  min-width: 44px;
  min-height: 40px;
  padding: 6px 10px;
  border: none;
  border-radius: var(--fb-radius-pill);
  background: transparent;
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.bills__seg-btn--on {
  background: var(--fb-card);
  color: var(--fb-blue);
  font-weight: 700;
}

.bills__tools-end {
  display: inline-flex;
  margin-left: auto;
  gap: 6px;
}

.bills__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-sub);
  font-size: 16px;
  cursor: pointer;
}

.bills__chip:focus-visible,
.bills__arrow:focus-visible,
.bills__seg-btn:focus-visible,
.bills__icon:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

/* 刷新失败内联条 */
.bills__stale {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--fb-radius-input);
  background: var(--fb-warn-soft);
  color: var(--fb-warn-ink);
  font-size: 12px;
}

.bills__stale-btn {
  flex: none;
  min-height: 32px;
  padding: 4px 12px;
  border: 1px solid var(--fb-warn-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-card);
  color: var(--fb-warn-ink);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

/* 卡片通用 */
.bills__card {
  padding: 12px;
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

.bills__card-title {
  margin: 0;
  color: var(--fb-ink-deep);
  font-size: 14px;
  font-weight: 700;
}

/* ⑥ 列表：日筛选行（稿 889-892 的 .day-filter-row / .ts-chip / .ts-clear） */
.bills__dayfilter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.bills__dayfilter-chip {
  padding: 3px 10px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-blue-soft);
  color: var(--fb-blue);
  font-size: 11px;
  font-variant-numeric: var(--fb-font-numeric);
}

.bills__dayfilter-clear {
  min-height: 32px;
  padding: 4px 10px;
  border: none;
  border-radius: var(--fb-radius-pill);
  background: transparent;
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 11px;
  text-decoration: underline;
  cursor: pointer;
}

.bills__dayfilter-clear:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 1px;
}

/* ⑥ 列表 */
.bills__group + .bills__group {
  margin-top: 10px;
}

.bills__group-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 0 2px;
  color: var(--fb-sub);
  font-size: 11px;
  font-variant-numeric: var(--fb-font-numeric);
}

.bills__group-sum {
  display: inline-flex;
  gap: 8px;
}

.bills__rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

.bills__row + .bills__row {
  border-top: 1px solid var(--fb-line);
}

@media (min-width: 900px) {
  .bills__card {
    padding: 16px;
  }
}
</style>
