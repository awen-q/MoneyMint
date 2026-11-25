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
import { t } from '@/i18n'
import { getChartPalette, readThemeTokens, themeEpoch } from '@/styles/themeTokens'
import { useLedgerDataStore } from '@/stores/ledgerData'
import { usePeriodStore } from '@/stores/period'
import { usePrivacyStore } from '@/stores/privacy'
import { useSessionStore } from '@/stores/session'
import MoneyText from '@/components/MoneyText.vue'
import StateCard from '@/components/shell/StateCard.vue'
import SkeletonBlock from '@/components/shell/SkeletonBlock.vue'
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

/**
 * 整页四态（v3.2）。
 * 批 I 两段加载：补齐段完成前 `txns` 只有「已拉窗口」的月份，拿它算「当季 / 当年」
 * 聚合会静默出**错数**（日均、占比、标签分面全错却不报错）——所以聚合计算守
 * `fullReady`，未就绪时整页走 loading 骨架（复用四态 loading 档）。
 */
const pageState = computed<'loading' | 'error' | 'empty' | 'ready'>(() => {
  if (data.error !== '' && !data.loaded) {
    return 'error'
  }
  if (!data.loaded) {
    return 'loading'
  }
  if (!data.fullReady) {
    return 'loading'
  }
  if (windowTxns.value.length === 0) {
    return 'empty'
  }
  return 'ready'
})

/**
 * 聚合骨架开关（骨架屏批）：只在「快照已装载、全量补齐未完成」时替换 StateCard 的
 * loading 文字档；首次装载（!loaded）仍走通用「正在加载…」。出现条件与旧
 * 「正在聚合数据…」文案完全一致，渲染形态换成「双环 + 排行条」骨架组合；
 * 聚合守 fullReady 的判据本身不动。
 */
const showAggregateSkeleton = computed(
  () => pageState.value === 'loading' && data.loaded && !data.fullReady,
)

const staleError = computed(() => (data.error !== '' && data.loaded ? data.error : ''))

const cardDesc = computed(() => {
  if (pageState.value === 'error') {
    return t('common.networkRetry')
  }
  if (pageState.value === 'empty') {
    return granularity.value === 'month'
      ? t('common.emptyCurrentMonth')
      : t('stats.emptyPeriod')
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
  drilledCategory.value = {
    id: categoryId,
    label: found === undefined ? t('stats.categoryFallback') : found.label,
  }
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
 * 已知边界：「未打标签」桶（`untaggedLabel()`）在服务端没有对应筛选语义
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

/**
 * 图表配色跟随主题（X-05）。
 *
 * **禁止**把 `'var(--fb-green)'` 这类字符串直接交给 ECharts：SVG renderer 会把颜色
 * 写进 `stroke` / `fill` **表现属性**，`var()` 在其上的解析在 Safari 14 / iOS 14
 * 基线不可靠（可能退化成默认黑或透明）。设计稿 `charts.js:18-33` 也是先取实色再传。
 * 这里与 `BillsView` / `DonutRankCard` 走同一条路径：`getChartPalette(readThemeTokens())`。
 */
const palette = computed(() => {
  void themeEpoch.value
  return getChartPalette(readThemeTokens())
})

/** 折线序列：金额与几何量同源（value 由定点串派生，禁止另算一遍）。 */
const trendSeriesInput = computed(() => [
  {
    name: t('common.income'),
    color: palette.value.income,
    points: trend.value.income.map((amount) => ({ value: Number(amount), amount })),
  },
  {
    name: t('common.expense'),
    color: palette.value.danger,
    points: trend.value.expense.map((amount) => ({ value: Number(amount), amount })),
  },
])

/** 月份组标签（周周期时显示周区间，避免「点着上/下月却在看周」的错位）。 */
const rangeLabel = computed(() => {
  if (granularity.value === 'year') {
    return t('core.reports.yearLabel', { year: String(year.value) })
  }
  if (granularity.value === 'week') {
    const first = buckets.value[0]
    const last = buckets.value[buckets.value.length - 1]
    return `${first === undefined ? '' : first.key} ~ ${last === undefined ? '' : last.key}`
  }
  return t('core.reports.monthLabel', {
    year: String(year.value),
    month: String(month.value),
  })
})

/**
 * 工具卡说明行按设计稿改为**操作提示**（S-12），不再展示「当前 CNY · N 天/月」——
 * 因此原先派生天数的 computed 一并移除：留一个无人使用的计算只会让读者
 * 以为还有第二处「天数口径」。
 */

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
      <h1 class="stats__title">{{ t('shell.nav.stats') }}</h1>
    </header>

    <!-- 工具卡（S-01 / S-05）：第一行 = 子页 chips + spacer + 月份组；
         第二行 = 周期 seg + spacer + 币种 seg。
         设计稿第一行只有 chips + 月份组（`mockup:963-975`）。周/月/年 seg 是
         `layout-scope D-3` 的拍板产物**不能删**，但从第一行挪到第二行左端 ——
         否则窄屏必然换行，把「不可拆」的月份组挤下去。 -->
    <section class="stats__card stats__card--tool">
      <div class="stats__tool-row">
        <StatsTabs :tab="tab" @select="setTab" />
        <span class="stats__spacer"></span>
        <span class="stats__month">
          <button type="button" class="stats__arrow" :aria-label="t('stats.prevPeriod')" @click="shiftMonth(-1)">‹</button>
          <button type="button" class="stats__chip" @click="monthOpen = true">
            <span class="stats__chip-text">{{ rangeLabel }}</span>
            <span class="stats__caret" aria-hidden="true">▾</span>
          </button>
          <button type="button" class="stats__arrow" :aria-label="t('stats.nextPeriod')" @click="shiftMonth(1)">›</button>
        </span>
      </div>
      <div class="stats__tool-row">
        <PeriodSeg :period="granularity" @select="setPeriod" />
        <span class="stats__spacer"></span>
        <span v-if="currencyOptions.length > 1" class="stats__seg" role="group" :aria-label="t('stats.currencyGroup')">
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
      <p class="stats__note">{{ t('stats.toolNote') }}</p>
    </section>

    <p v-if="staleError !== ''" class="stats__stale" role="status">
      <span class="stats__stale-text">{{ t('common.staleNotice') }}</span>
      <button type="button" class="stats__stale-btn" @click="reload">{{ t('common.retry') }}</button>
    </p>

    <!-- 聚合骨架（骨架屏批）：补齐等待期先渲染「双环 + 排行」骨架，补齐完成即换回。
         判据（fullReady）不动；sr 文案保留「正在聚合数据…」的读屏播报。 -->
    <div v-if="showAggregateSkeleton" class="stats__skel" role="status" aria-live="polite">
      <span class="stats__skel-sr">{{ t('stats.aggregating') }}</span>
      <section class="stats__card">
        <div class="stats__skel-donuts">
          <SkeletonBlock variant="chart" height="150px" />
          <SkeletonBlock variant="chart" height="150px" />
        </div>
      </section>
      <section class="stats__card">
        <div class="stats__skel-rows">
          <SkeletonBlock variant="line" width="88%" />
          <SkeletonBlock variant="line" width="72%" />
          <SkeletonBlock variant="line" width="80%" />
          <SkeletonBlock variant="line" width="64%" />
        </div>
      </section>
    </div>
    <StateCard v-else :state="pageState" :desc="cardDesc" @action="reload">
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
            :title="t('stats.trendTitle')"
            :note="granularity === 'year' ? t('stats.trendNoteMonth') : t('stats.trendNoteDay')"
            :chart-label="t('stats.trendChartLabel', { range: rangeLabel, commodity })"
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
        <p v-else class="stats__hint">{{ t('stats.dailyHint') }}</p>

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
    <p class="stats__footer">{{ t('stats.footer', { name: session.ledgerName, commodity }) }}</p>
  </section>
</template>

<style scoped>
.stats {
  padding-bottom: 20px;
}

/* X-02：横向内边距归零 —— 水平留白只由 `.layout__content` 一处给，
   否则「layout 16 + 视图 16」= 32px，与账单页的 16px 对不齐。 */
.stats__hero {
  padding: 0 0 10px;
}

/* S-11：设计 `.hero h1` 21/700 `--ink-deep`、`.hero p` 13px / margin-top 4px */
.stats__title {
  margin: 0;
  color: var(--fb-ink-deep);
  font-size: 21px;
  font-weight: 700;
}

.stats__card {
  margin: 14px 0 0;
  padding: 14px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

.stats__card--tool {
  padding: 16px;
}

.stats__tool-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.stats__tool-row + .stats__tool-row {
  margin-top: 10px;
}

.stats__spacer {
  flex: 1;
}

.stats__month {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* S-01：方向按钮是设计 `.icon-btn` —— 36×36 描边方按钮 + 品牌绿
   （原实现退化成两个无框纯文字箭头，看得见但看不出可点） */
.stats__arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-blue);
  font-family: inherit;
  font-size: 16px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
}

/* S-01：年月 chip 是描边白底胶囊（带 ▾），不是 soft 底无框文字 */
.stats__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 7px 12px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: var(--fb-font-numeric);
  cursor: pointer;
}

.stats__caret {
  color: var(--fb-sub);
  font-size: 10px;
}

.stats__arrow:focus-visible,
.stats__chip:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

/* S-03：币种 seg —— 容器描边，选中态「实心墨绿 + 米白字」（原实现反色） */
.stats__seg {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
}

.stats__seg-btn {
  min-height: 30px;
  padding: 6px 14px;
  border: none;
  border-radius: var(--fb-radius-pill);
  background: transparent;
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.stats__seg-btn--on {
  background: var(--fb-blue);
  color: var(--fb-white);
  font-weight: 600;
}

.stats__seg-btn:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

.stats__note,
.stats__hint {
  margin: 8px 0 0;
  color: var(--fb-sub);
  font-size: 11px;
  line-height: 1.5;
}

/* X-02：说明/提示条不再自带横向外边距 */
.stats__hint {
  margin: 14px 0 0;
}

/* S-12：设计 `.tool-note` 在 ≤768 隐藏（省首屏高度） */
@media (max-width: 768px) {
  .stats__note {
    display: none;
  }
}

.stats__stale {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 14px 0 0;
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
  margin: 14px 0 0;
  color: var(--fb-sub);
  font-size: 11px;
}

/* 指标带与其它卡之间的间距（StatsMetrics 自带卡片外观；X-02 归零横向边距） */
.stats__panel > .stats-metrics {
  margin: 14px 0 0;
}

/*
 * 成员贡献 / 试算平衡两卡（S-09）：补齐纵向节奏。
 *
 * 这两个组件的根节点**本身没有 margin**（它们是可复用卡片，不该带外部间距），
 * 而 `.stats__panel` 只是普通 block、没有 gap —— 于是两卡与上方明细卡严丝合缝贴住。
 * 加了描边后这个 0 间距会读成「一张卡里的两块」，所以在这里补 14px，
 * 与其余卡片保持同一节奏。不改组件内部、也不改它们的折叠/无障碍行为。
 */
.stats__panel > .member-card,
.stats__panel > .trial-card {
  margin: 14px 0 0;
}

/* 聚合骨架（骨架屏批）：双环两块 + 排行条，结构贴近补齐完成后的真实卡片；
   sr 文案保留「正在聚合数据…」的读屏播报。 */
.stats__skel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.stats__skel-donuts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.stats__skel-rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.stats__skel-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
</style>
