<script setup lang="ts">
/**
 * 统计账单页（B4 / T48，design.md 统计账单 / mockup `page-stats`）
 *
 * 结构：hero → 工具卡（子页 chips ｜ 周期 seg ｜ 月份组 ｜ 币种 seg）→ 子页内容。
 *
 * 六条本页级决策（都对应一条硬约束）：
 *
 * 1. **数据只走 `ledgerData.ensure()`，且拿全量快照**。`data.txns` 是不带任何
 *    分页参数的全量列表 —— 统计页要吃「当季 / 当年」的完整窗口，**一旦给请求加
 *    `limit`，`core/stats.ts` 的聚合只覆盖当前页**（日均、占比、标签分面全错），
 *    而页面会正常渲染、不报错。所以这里结构上就不传 `limit`。
 * 2. **窗口由周期 + cursor 决定**（`periodBuckets`），窗口外的交易一律不进聚合。
 *    切周期 seg **不重新请求**：全量快照已覆盖全部历史，本地重算窗口即可。若改成
 *    「切 seg 就按窗口再拉一次」，同一月份会同时存在两份来源（快照 vs 窗口响应），
 *    并发刷新时会出现「切一次 seg 数字变了」——单一数据源比省内存重要。
 *
 *    **这个取舍有上限**（留档）：当单个账本大到全量快照不可接受时，统计页要转向
 *    **服务端聚合**，`/api/assets/series`（B6）就是该模式的先例（服务端按月快照、
 *    前端只画）。届时改的是**数据来源**，不是 `core/stats.ts` 的聚合口径 ——
 *    别把这里的本地重算当成最终形态。
 * 3. **币种取 `period.commodity`**（只读别名，不读 `bills/stats.commodity`）。
 * 4. **四态沿用冻结的 v3.2**：`error` 只在「从未成功加载过」时整页报错；
 *    有旧快照的刷新失败留在 `ready`，只出一条内联条。
 * 5. **子页 chips 与工具卡都在 `StateCard` 之外**（空态不能让人失去出口：
 *    某月无交易时仍要能换月 / 换周期 / 切子页）。
 * 6. **日均只在「月」周期有意义**：`week` 用窗口内已过天数，`year` 不计算日均
 *    （按年日均没有业务含义），显式传 `applicable: false` 让组件显示「—」。
 *
 * 下钻（环图 / 排行 / 柱）本轮只 emit 到本页并切本页状态；跳「搜索账单」需要
 * 把分类 / 标签 / 日期窗口拼成 `SearchView` 的 query，等 T49 收口时一起接。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { elapsedDays } from '@/core/calendar'
import { emptyFilters, filtersToQuery } from '@/core/filters'
import { categoryShares, inBuckets, memberContributions, periodBuckets, trendSeries, trialBalanceRows, type ReportPeriod, type ReportTxn } from '@/core/reports'
import { averagePerDay, dailyRows, statsTotals, tagShares, type StatsTotals } from '@/core/stats'
import { useLedgerDataStore } from '@/stores/ledgerData'
import { usePeriodStore } from '@/stores/period'
import { usePrivacyStore } from '@/stores/privacy'
import { useSessionStore } from '@/stores/session'
import MoneyText from '@/components/MoneyText.vue'
import StateCard from '@/components/shell/StateCard.vue'
import MonthPicker from '@/components/shell/MonthPicker.vue'
import TrendChart from '@/components/charts/TrendChart.vue'
import CategoryBarCard from '@/components/stats/CategoryBarCard.vue'
import DailyTable from '@/components/stats/DailyTable.vue'
import DonutRankCard from '@/components/stats/DonutRankCard.vue'
import MemberCard from '@/components/stats/MemberCard.vue'
import PeriodSeg from '@/components/stats/PeriodSeg.vue'
import StatsMetrics from '@/components/stats/StatsMetrics.vue'
import StatsTabs from '@/components/stats/StatsTabs.vue'
import TagPanel from '@/components/stats/TagPanel.vue'
import TrialBalanceCard from '@/components/stats/TrialBalanceCard.vue'

/** 刷新失败但仍有旧快照时的内联提示（四页逐字统一）。 */
const STALE_NOTICE = '刷新失败，当前显示的是上次数据'

const data = useLedgerDataStore()
const period = usePeriodStore()
const privacy = usePrivacyStore()
const session = useSessionStore()
const router = useRouter()

const monthOpen = ref(false)
/** 周期粒度（周 / 月 / 年）：页面级浏览态，不进 store（只有统计页用）。 */
const granularity = ref<ReportPeriod>('month')
/** 分类柱下钻的分类（null = 全部分类）。 */
const drilledCategory = ref<{ id: number | null; label: string } | null>(null)
/** 分类柱方向。 */
const barDirection = ref<'expense' | 'income'>('expense')

onMounted(() => {
  void data.ensure()
})

const year = computed(() => period.stats.year)
const month = computed(() => period.stats.month)
const tab = computed(() => period.stats.tab)
const commodity = computed(() => period.commodity)
const cursor = computed(() => new Date(year.value, month.value - 1, 1))

/** 当前周期的桶（周 = 7 天、月 = 当月逐日、年 = 12 个月）。 */
const buckets = computed(() => periodBuckets(granularity.value, cursor.value))

/** 窗口内的交易（全量快照 + 本地窗口过滤，请求层不传 limit）。 */
const windowTxns = computed<ReportTxn[]>(() => {
  const list: ReportTxn[] = []
  for (const txn of data.txns) {
    if (inBuckets(txn.date, buckets.value, granularity.value)) {
      list.push(txn)
    }
  }
  return list
})

/** 五指标的底层数据。 */
const totals = computed<StatsTotals>(() =>
  statsTotals(windowTxns.value, data.accounts, commodity.value),
)

/**
 * 日均：
 * - 月 → `elapsedDays`（往月整月、当月到今天、未来月 0）；
 * - 周 → 窗口内已过天数；
 * - 年 → 不计算（`applicable: false`，组件显示「—」）。
 */
const average = computed(() => {
  if (granularity.value === 'year') {
    return averagePerDay(totals.value, 0)
  }
  if (granularity.value === 'month') {
    return averagePerDay(totals.value, elapsedDays(year.value, month.value, new Date()))
  }
  // 周：数窗口内 <= 今天的天数
  const today = new Date()
  const todayKey = `${today.getFullYear()}-${today.getMonth() + 1 < 10 ? '0' : ''}${today.getMonth() + 1}-${today.getDate() < 10 ? '0' : ''}${today.getDate()}`
  let elapsed = 0
  for (const bucket of buckets.value) {
    if (bucket.key <= todayKey) {
      elapsed += 1
    }
  }
  return averagePerDay(totals.value, elapsed)
})

/** 趋势折线（复用 reports.trendSeries，页面不自己按桶聚合）。 */
const trend = computed(() =>
  trendSeries(windowTxns.value, data.accounts, commodity.value, buckets.value, granularity.value),
)

/** 分类占比（支出 / 收入双侧，按 account id 聚合）。 */
const expenseShares = computed(() =>
  categoryShares(windowTxns.value, data.accounts, commodity.value, 8, 'Expenses'),
)
const incomeShares = computed(() =>
  categoryShares(windowTxns.value, data.accounts, commodity.value, 8, 'Income'),
)
const expenseTotal = computed(() => totals.value.expense)
const incomeTotal = computed(() => totals.value.income)

/** 柱状卡：全部分类时用分类聚合；下钻时用该分类逐日金额。 */
const barCategories = computed(() =>
  barDirection.value === 'income' ? incomeShares.value : expenseShares.value,
)

const drillDaily = computed(() => {
  const target = drilledCategory.value
  if (target === null || target.id === null) {
    return []
  }
  const accountId = target.id
  // 只保留含该分类分录的交易，再逐日聚合（复用 incomeExpenseTotals，不自己加减）。
  const filtered = windowTxns.value.filter((txn) => {
    for (const posting of txn.postings) {
      if (posting.account_id === accountId) {
        return true
      }
    }
    return false
  })
  const table = dailyRows(filtered, data.accounts, year.value, month.value, commodity.value, new Date())
  return table.rows
})

/** 每日明细（仅「月」周期有意义：周一/年不是逐日口径）。 */
const dailyTable = computed(() =>
  dailyRows(windowTxns.value, data.accounts, year.value, month.value, commodity.value, new Date()),
)

const tags = computed(() => tagShares(windowTxns.value, data.accounts, commodity.value))
const members = computed(() => memberContributions(windowTxns.value, data.accounts, commodity.value))
const trial = computed(() => trialBalanceRows(data.accounts, commodity.value))

/** 整页四态（v3.2）。 */
const pageState = computed<'loading' | 'error' | 'empty' | 'ready'>(() => {
  if (data.error !== '' && !data.loaded) {
    return 'error'
  }
  if (!data.loaded) {
    return 'loading'
  }
  if (windowTxns.value.length === 0) {
    return 'empty'
  }
  return 'ready'
})

const staleError = computed(() => (data.error !== '' && data.loaded ? data.error : ''))

const cardDesc = computed(() => {
  if (pageState.value === 'error') {
    return '请检查网络后重试。'
  }
  if (pageState.value === 'empty') {
    return granularity.value === 'month'
      ? '当前月份没有记录。'
      : '当前周期没有记录。'
  }
  return ''
})

function reload(): void {
  // 重试入口只能是 reload()：ensure() 在 loaded === true 时短路。
  void data.reload()
}

function setTab(next: 'stat' | 'tag'): void {
  period.setStatsTab(next)
}

function setPeriod(next: ReportPeriod): void {
  granularity.value = next
  drilledCategory.value = null
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
  drilledCategory.value = null
  period.setStatsMonth(nextYear, nextMonth)
}

function onMonthSelect(payload: { year: number; month: number }): void {
  monthOpen.value = false
  drilledCategory.value = null
  period.setStatsMonth(payload.year, payload.month)
}

function onDrillCategory(categoryId: number | null): void {
  if (categoryId === null) {
    drilledCategory.value = null
    return
  }
  const found = barCategories.value.find((item) => item.id === categoryId)
  drilledCategory.value = { id: categoryId, label: found === undefined ? '分类' : found.label }
}

/**
 * 当前窗口的日期范围（用于把「下钻」翻译成搜索页的 `from` / `to`）。
 *
 * 桶的 key 形状由 `periodBuckets` 决定：周/月是 `YYYY-MM-DD`，年是 `YYYY-MM`。
 * 年周期不能直接把 `YYYY-MM` 塞进 `from`（`filtersFromQuery` 用 `DATE_RE` 校验，
 * 非法值会被静默丢弃 —— 那就变成「跳过去但没筛」，比不跳更糟），所以年单独展开成
 * 年初/年末两个完整日期。
 */
const drillRange = computed<{ from: string; to: string }>(() => {
  if (granularity.value === 'year') {
    return { from: `${year.value}-01-01`, to: `${year.value}-12-31` }
  }
  const first = buckets.value[0]
  const last = buckets.value[buckets.value.length - 1]
  if (first === undefined || last === undefined) {
    return { from: '', to: '' }
  }
  return { from: first.key, to: last.key }
})

/**
 * 标签行 / 标签环图下钻 → 搜索账单页（审计 P4：原来 `@drill="() => undefined"`，
 * 整块可点、cursor 是 pointer，但点了什么都不发生，用户会以为页面卡了）。
 *
 * 口径与稿 1081「点行可下钻该标签当月流水」一致：**当前窗口 + 该标签**。
 * 已知边界：「未打标签」桶（`UNTAGGED_LABEL`）在服务端没有对应筛选语义
 * （`tag` 空串表示「不限」，不是「必须无标签」），跳过去会得到 0 条并显示
 * 「没有符合条件的结果」——**这是可见的反馈，不是死点击**，所以照样跳；
 * 真要支持它需要服务端新增 `tag=none` 语义，不在本轮。
 */
function onTagDrill(tag: string): void {
  const range = drillRange.value
  void router.push({
    name: 'search',
    query: filtersToQuery({ ...emptyFilters(), tag, from: range.from, to: range.to }),
  })
}

/** 折线序列：金额与几何量同源（value 由定点串派生，禁止另算一遍）。 */
const trendSeriesInput = computed(() => [
  { name: '收入', color: 'var(--fb-green)', points: trend.value.income.map((amount) => ({ value: Number(amount), amount })) },
  { name: '支出', color: 'var(--fb-danger)', points: trend.value.expense.map((amount) => ({ value: Number(amount), amount })) },
])

/** 月份组标签（周周期时显示周区间，避免「点着上/下月却在看周」的错位）。 */
const rangeLabel = computed(() => {
  if (granularity.value === 'year') {
    return `${year.value} 年`
  }
  if (granularity.value === 'week') {
    const first = buckets.value[0]
    const last = buckets.value[buckets.value.length - 1]
    return `${first === undefined ? '' : first.key} ~ ${last === undefined ? '' : last.key}`
  }
  return `${year.value} 年 ${month.value} 月`
})

/** 当月天数（Date 溢出法：下个月第 0 天 = 本月最后一天），避免模板里写算术。 */
const days = computed(() => new Date(year.value, month.value, 0).getDate())

const currencyOptions = computed(() => {
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
</script>

<template>
  <section class="stats">
    <header class="stats__hero">
      <h1 class="stats__title">统计账单</h1>
      <p class="stats__desc">月度聚合分析：统计信息 / 趋势 / 分类圆环 / 分类柱状 / 每日明细 + 标签维度</p>
    </header>

    <!-- 工具卡：子页 chips ｜ 周期 seg ｜ 月份组 ｜ 币种 seg（都在 StateCard 之外） -->
    <section class="stats__card stats__card--tool">
      <div class="stats__tool-row">
        <StatsTabs :tab="tab" @select="setTab" />
        <PeriodSeg :period="granularity" @select="setPeriod" />
        <span class="stats__month">
          <button type="button" class="stats__arrow" aria-label="上一期" @click="shiftMonth(-1)">‹</button>
          <button type="button" class="stats__chip" @click="monthOpen = true">{{ rangeLabel }}</button>
          <button type="button" class="stats__arrow" aria-label="下一期" @click="shiftMonth(1)">›</button>
        </span>
      </div>
      <div class="stats__tool-row">
        <span class="stats__spacer"></span>
        <span v-if="currencyOptions.length > 1" class="stats__seg" role="group" aria-label="统计币种">
          <button
            v-for="code in currencyOptions"
            :key="code"
            type="button"
            class="stats__seg-btn"
            :class="{ 'stats__seg-btn--on': code === commodity }"
            :aria-pressed="code === commodity"
            @click="period.setCommodity(code)"
          >{{ code }}</button>
        </span>
      </div>
      <p class="stats__note">
        币种口径见下方各项（禁跨币种求和）· 当前 {{ commodity }} · {{ days }} 天/月
      </p>
    </section>

    <p v-if="staleError !== ''" class="stats__stale" role="status">
      <span class="stats__stale-text">{{ STALE_NOTICE }}</span>
      <button type="button" class="stats__stale-btn" @click="reload">重试</button>
    </p>

    <StateCard :state="pageState" :desc="cardDesc" @action="reload">
      <!-- 子页互斥依赖「无 Transition」：加 in-out 过渡会让两面板共存，
           图表实例峰值 4→6（超过 liveCount 的 MAX_LIVE_CHARTS=4），见 liveCount.ts。
           要加动画就先给 DonutRankCard / TagPanel 里其中一张环图加条件挂载。 -->
      <!-- 子页【统计】 -->
      <div v-if="tab === 'stat'" class="stats__panel">
        <StatsMetrics
          :totals="totals"
          :average="average"
          :commodity="commodity"
          :is-current-month="granularity === 'month'"
          :masked="privacy.enabled"
        />

        <!-- 卡头**不在这里画**：`ChartFrame` 的 `<h3>` 是全站图表的统一标题位置。
             之前这里再包一层 `.stats__card-title` 会让「收支趋势」渲染两遍（审计 P3）。
             说明文字走 `ChartFrame` 的 `note`。 -->
        <section class="stats__card">
          <TrendChart
            title="收支趋势"
            :note="`按${granularity === 'year' ? '月' : '日'}收入 / 支出`"
            :chart-label="`${rangeLabel} 收入与支出趋势，${commodity} 口径`"
            :labels="trend.labels"
            :series="trendSeriesInput"
            :commodity="commodity"
            :masked="privacy.enabled"
          />
        </section>

        <section class="stats__card">
          <DonutRankCard
            :expense="expenseShares"
            :income="incomeShares"
            :expense-total="expenseTotal"
            :income-total="incomeTotal"
            :commodity="commodity"
            :masked="privacy.enabled"
            @drill="onDrillCategory"
          />
        </section>

        <section class="stats__card">
          <CategoryBarCard
            :categories="barCategories"
            :drill-daily="drillDaily"
            :direction="barDirection"
            :drilled-id="drilledCategory === null ? null : drilledCategory.id"
            :drilled-label="drilledCategory === null ? '' : drilledCategory.label"
            :commodity="commodity"
            :masked="privacy.enabled"
            @select-direction="(next) => (barDirection = next)"
            @drill="onDrillCategory"
          />
        </section>

        <!-- 每日明细只在「月」周期出现：周 / 年不是逐日口径 -->
        <section v-if="granularity === 'month'" class="stats__card">
          <DailyTable :table="dailyTable" :commodity="commodity" :masked="privacy.enabled" />
        </section>
        <p v-else class="stats__hint">
          每日明细按自然日列出，切到「月」周期查看。
        </p>

        <MemberCard :members="members" :commodity="commodity" :masked="privacy.enabled" />
        <TrialBalanceCard :rows="trial" :commodity="commodity" :masked="privacy.enabled" />
      </div>

      <!-- 子页【标签】 -->
      <div v-else class="stats__panel">
        <TagPanel :shares="tags" :commodity="commodity" :masked="privacy.enabled" @drill="onTagDrill" />
      </div>
    </StateCard>

    <MonthPicker
      :open="monthOpen"
      :value="{ year: year, month: month }"
      :min-year="1970"
      :max-year="2100"
      @select="onMonthSelect"
      @close="monthOpen = false"
    />

    <!-- 空态也要能换账本：与账单页一致的账本名提示（不可点时只是文字） -->
    <p class="stats__footer">账本：{{ session.ledgerName }} · 统计口径 {{ commodity }}</p>
  </section>
</template>

<style scoped>
.stats {
  padding-bottom: 20px;
}

.stats__hero {
  padding: calc(16px + env(safe-area-inset-top, 0px)) 16px 10px;
}

.stats__title {
  margin: 0;
  color: var(--fb-ink);
  font-size: 20px;
  font-weight: 700;
}

.stats__desc {
  margin: 6px 0 0;
  color: var(--fb-sub);
  font-size: 12px;
}

.stats__card {
  margin: 10px 16px 0;
  padding: 14px;
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

.stats__card--tool {
  padding: 10px 14px;
}

.stats__tool-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.stats__tool-row + .stats__tool-row {
  margin-top: 6px;
}

.stats__spacer {
  flex: 1;
}

.stats__month {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

.stats__arrow,
.stats__chip {
  border: none;
  background: transparent;
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.stats__chip {
  padding: 4px 8px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
  font-variant-numeric: var(--fb-font-numeric);
}

.stats__seg {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
}

.stats__seg-btn {
  padding: 3px 10px;
  border: none;
  border-radius: var(--fb-radius-pill);
  background: transparent;
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}

.stats__seg-btn--on {
  background: var(--fb-card);
  color: var(--fb-ink);
  font-weight: 600;
}

.stats__note,
.stats__hint {
  margin: 8px 0 0;
  color: var(--fb-sub);
  font-size: 11px;
  line-height: 1.5;
}

.stats__hint {
  margin: 10px 16px 0;
}

.stats__stale {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 10px 16px 0;
  padding: 8px 12px;
  border-radius: var(--fb-radius-card);
  background: var(--fb-danger-soft);
  color: var(--fb-danger-ink);
  font-size: 12px;
}

.stats__stale-btn {
  flex: none;
  border: none;
  background: transparent;
  color: var(--fb-danger-ink);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: underline;
}

.stats__footer {
  margin: 12px 16px 0;
  color: var(--fb-sub);
  font-size: 11px;
}

/* 指标带与其它卡之间的间距（StatsMetrics 自带卡片外观） */
.stats__panel > .stats-metrics {
  margin: 10px 16px 0;
}
</style>
