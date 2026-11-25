<script setup lang="ts">
/**
 * 账单页（B2 / design.md 首页【账单】）
 *
 * 六区块顺序严格按 v4.1 稿：hero → 工具卡 → 日历卡 → 指标带 → 折线卡 → 月列表卡。
 *
 * 四条本页级别的设计决策：
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
 *
 * 4. **日历点日只开底部 sheet，不过滤外部列表**（老板 2026-11 决策，推翻旧
 *    「列表就地过滤」稿）：`groups` 恒定取 `monthTxns` 全月，`activeDay` 只喂
 *    日历高亮与 `DayTransactionsSheet` 的当日明细；关掉 sheet 列表一动不动。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { identityApi } from '@/api/client'
import type { IdentityCheckResult } from '@/api/types'
import { billCells, daySeries, monthTotals } from '@/core/bill'
import { buildMonthGrid, type CalendarDay } from '@/core/calendar'
import { buildLedgerHealthNotice } from '@/core/ledgerHealth'
import type { LineSeriesInput } from '@/core/charts/option'
import { buildTxnRow, type TxnRowView } from '@/core/txnRow'
import { getChartPalette, readThemeTokens, themeEpoch } from '@/styles/themeTokens'
import { useLedgerDataStore } from '@/stores/ledgerData'
import { usePeriodStore } from '@/stores/period'
import { usePrivacyStore } from '@/stores/privacy'
import { useSessionStore } from '@/stores/session'
import MoneyText from '@/components/MoneyText.vue'
import BillCalendar from '@/components/bill/BillCalendar.vue'
import BillMetrics from '@/components/bill/BillMetrics.vue'
import DayTransactionsSheet from '@/components/bill/DayTransactionsSheet.vue'
import TxnRow from '@/components/TxnRow.vue'
import TrendChart from '@/components/charts/TrendChart.vue'
import LedgerSwitcher from '@/components/shell/LedgerSwitcher.vue'
import MonthPicker from '@/components/shell/MonthPicker.vue'
import StateCard from '@/components/shell/StateCard.vue'
import SkeletonBlock from '@/components/shell/SkeletonBlock.vue'

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
/**
 * 当日 sheet 正在展示的日（1..31）；`null` 表示 sheet 关闭。
 * **只**驱动日历高亮和抽屉内容，绝不参与外部 `groups` 的过滤。
 */
const activeDay = ref<number | null>(null)

const year = computed(() => period.bills.year)
const month = computed(() => period.bills.month)
const commodity = computed(() => period.bills.commodity)

function twoDigits(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 当月前缀 `YYYY-MM`：页面的月份过滤只做这一件事（聚合全部交给 core）。 */
const monthPrefix = computed(() => `${year.value}-${twoDigits(month.value)}`)

// 账本数据全量快照：**必须**在挂载时拉一次。
// 批 I 两段加载：先声明「正在看当月」（补齐中会立即拉当月窗口，与首段的
// 自然当月窗口单飞共享，不会发两笔请求），再 `ensure()` 走两段装载。
// `!loaded → loading` 的判据意味着漏调它表现为「永久骨架屏」，所以这条调用有测试守。
onMounted(() => {
  void data.setWindowMonth(monthPrefix.value)
  void data.ensure()
  void loadHealth()
})

// 切账本时 `ledgerData` 的 `reset()` 会清空快照，本页要重新拉取并关掉当日 sheet。
// 用 `watch` 而不是 `session.$subscribe`：订阅需要手动退订，watch 随组件销毁自动停。
watch(
  () => session.ledgerId,
  () => {
    activeDay.value = null
    // reset() 后窗口集合已清空、store 只会重拉「自然当月」窗口；
    // 用户切账本前停留的月份要由这里重新声明，否则当月永远停在聚合等待态。
    void data.setWindowMonth(monthPrefix.value)
    // 恒等式检查按当前账本计算，切账本必须重取，否则会把旧账本的健康结论显示在新账本上。
    void loadHealth()
  },
)

// 切月：把新月份声明成窗口关注月（补齐中拉该月窗口；全量态为缓存命中 noop）。
watch(monthPrefix, (prefix) => {
  void data.setWindowMonth(prefix)
})

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

/** 点日历某天：打开底部 sheet；外部列表不受影响（连选中态都不参与过滤）。 */
function openDay(day: number): void {
  activeDay.value = day
}

/**
 * 交易日列表：**恒定整月全量**，按日倒序分组。
 * `activeDay` 不在这里出现，是「外部列表不变」这条产品决策的结构性保证——
 * 想给列表加日过滤，得先在本函数里重新引入被删掉的状态，code review 一眼可见。
 */
interface DayGroup {
  date: string
  label: string
  expense: string
  income: string
  rows: TxnRowView[]
}

const groups = computed<DayGroup[]>(() => {
  const sorted = monthTxns.value.slice().sort((left, right) => {
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
 * 当日 sheet 的交易：唯一一处按 `activeDay` 过滤的地方，且只喂抽屉。
 * 与 `groups` 共用 `monthTxns` 这一个真相源，抽屉里看到的和外列表里同一天的行
 * 来自同一批数据，不会各算各的。
 */
const dayTxns = computed(() => {
  const day = activeDay.value
  if (day === null) {
    return []
  }
  return monthTxns.value.filter((txn) => Number(txn.date.slice(8, 10)) === day)
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
 *
 * 取色（B-08 ③）：收入 = `income`（成功绿）、支出 = `danger`（危险红）。
 * **不能**用 `palette.expense` —— 那是旧报表口径，映射到 `--fb-blue`（墨绿），
 * 会让「支出」画成绿色，与全站「支出=红」的语义冲突（设计图例：收入绿 / 支出红）。
 */
const trendSeries = computed<LineSeriesInput[]>(() => [
  {
    name: '收入',
    color: palette.value.income,
    points: series.value.map((point) => ({ value: Number(point.income), amount: point.income })),
  },
  {
    name: '支出',
    color: palette.value.danger,
    points: series.value.map((point) => ({ value: Number(point.expense), amount: point.expense })),
  },
])

/**
 * 当月窗口是否还在聚合（批 I 两段加载守卫）：
 * `fullReady`（全量快照就绪）或该月窗口已并入快照之前都算「聚合中」。
 * 必须先于 empty 判定，否则补齐期间会把「当月无记录」误报给用户。
 */
const monthPending = computed(() => !data.fullReady && !data.hasMonthWindow(monthPrefix.value))

/** 整页四态（v3.2，逐字照用）；monthPending 时先判 loading（防误判「当月无记录」）。 */
const pageState = computed<'loading' | 'error' | 'empty' | 'ready'>(() => {
  if (data.error !== '' && !data.loaded) {
    return 'error'
  }
  if (!data.loaded) {
    return 'loading'
  }
  if (monthPending.value) {
    return 'loading'
  }
  if (monthTxns.value.length === 0) {
    return 'empty'
  }
  return 'ready'
})

/**
 * 聚合骨架开关（骨架屏批）：只在「有快照但当月窗口未到」时替换 StateCard 的
 * loading 文字档 —— 首次装载（!loaded）仍是通用「正在加载…」文字态，两个等待
 * 阶段视觉可区分。出现条件与旧「正在聚合当月数据…」文案完全一致，只是渲染
 * 形态换成「日历 + 指标 + 列表条」骨架组合；monthPending 判据本身不动。
 */
const showMonthSkeleton = computed(
  () => pageState.value === 'loading' && data.loaded && monthPending.value,
)

/** 有旧快照时的刷新失败：留在 ready，只出内联条。 */
const staleError = computed(() => (data.error !== '' && data.loaded ? data.error : ''))

// ---------- P1-3：banner 上的账本健康图标 ----------
// 数据源只有 GET /api/identity/check（按币种的分录借贷恒等式，实时计算）。
// 不声称 bean-check 通过，也不把 balance_key 的日初校准混进来；口径小字搬到
// 图标的 title / 读屏名里，详情仍跳设置的数据安全页。
const health = ref<IdentityCheckResult | null>(null)
const healthFailed = ref(false)
const healthNotice = computed(() => buildLedgerHealthNotice(health.value, healthFailed.value))

/** 图标本身只是语义标记，真实结论走 aria-label / title（不靠颜色单独传意）。 */
const HEALTH_GLYPHS: Record<string, string> = {
  ok: '✓',
  unbalanced: '⚠',
  unknown: '·',
}

const healthGlyph = computed(() => HEALTH_GLYPHS[healthNotice.value.tone] ?? '·')

/** 结论文案已有的结尾标点不重复补；省略号也算一句话的收尾。 */
function withPeriod(text: string): string {
  return /[。！？….!?]$/.test(text) ? text : `${text}。`
}

/**
 * 悬停 / 读屏都能看到：结论 + 口径 + 「去设置看详情」。
 * `healthNotice.text` 本身已含「分录借贷恒等式检查」前缀，故不再重复加；
 * 两句话之间用句号隔开，避免「…借贷平衡本检查按币种…」黏成一串。
 */
const healthHint = computed(
  () =>
    `${withPeriod(healthNotice.value.text)}${healthNotice.value.detail}详情请到设置的数据安全页查看。`,
)

async function loadHealth(): Promise<void> {
  try {
    const result = await identityApi.check()
    health.value = result
    healthFailed.value = false
  } catch {
    health.value = null
    healthFailed.value = true
  }
}

function goDataSafety(): void {
  void router.push({ name: 'data-safety' })
}

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
  activeDay.value = null
  period.setBillsMonth(nextYear, nextMonth)
}

function onMonthSelect(payload: { year: number; month: number }): void {
  monthOpen.value = false
  activeDay.value = null
  period.setBillsMonth(payload.year, payload.month)
}

function onLedgerSelect(id: number | string): void {
  ledgerOpen.value = false
  activeDay.value = null
  session.selectLedger(Number(id))
}

/**
 * 币种下拉（批 I 两段加载降级口径）：
 * - `fullReady`（全量态）：现行口径不变——当前币种优先，其余按全量 postings 首次出现序；
 * - 补齐态：全量不可用，退化为 **账户 balances 键集合 ∪ 当月窗口 postings 币种 ∪ 当前币种**。
 *   去重、选中币种优先、其余按首次出现序；用数组 + indexOf 去重，
 *   **禁依赖 Set 迭代序**（兼容基线与确定性双重要求）。
 */
const commodities = computed(() => {
  const out: string[] = []
  const push = (value: string): void => {
    if (value !== '' && out.indexOf(value) < 0) {
      out.push(value)
    }
  }
  push(commodity.value)
  if (data.fullReady) {
    for (const txn of data.txns) {
      for (const posting of txn.postings) {
        push(posting.commodity)
      }
    }
    return out
  }
  for (const account of data.accounts) {
    const balances = account.balances
    if (balances !== undefined) {
      for (const key of Object.keys(balances)) {
        push(key)
      }
    }
  }
  for (const txn of monthTxns.value) {
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
    <!-- ① hero：页名 + 健康图标。说明性小标题已按老板要求删掉；
         恒等式检查结论收进标题行右侧的按钮，点/回车跳设置的数据安全页看明细。
         这里**不**重复「支出 / 收入 / 结余」三个金额 —— 它们在下方 BillMetrics。 -->
    <header class="bills__hero">
      <h1 class="bills__title">账单</h1>
      <button
        type="button"
        class="bills__health-icon"
        :class="`bills__health-icon--${healthNotice.tone}`"
        data-testid="ledger-health-icon"
        :aria-label="healthHint"
        :title="healthHint"
        @click="goDataSafety"
      >
        <span aria-hidden="true">{{ healthGlyph }}</span>
      </button>
    </header>

    <!-- ② 工具卡（B-01）：一张白卡承载两行工具，与下方日历卡同为「卡」，不再夹心。
         行1 = 账本 chip + spacer + 月份组；行2 = 币种 seg + spacer + 搜索 / 统计图标。 -->
    <div class="bills__tools">
      <div class="bills__tools-row">
        <button type="button" class="bills__chip" @click="ledgerOpen = true">
          <span class="bills__chip-label">{{ session.ledgerName }}</span>
          <span class="bills__chip-caret" aria-hidden="true">⌄</span>
        </button>

        <span class="bills__spacer"></span>

        <span class="bills__month">
          <button type="button" class="bills__arrow" aria-label="上个月" @click="shiftMonth(-1)">‹</button>
          <button type="button" class="bills__chip bills__chip--month" @click="monthOpen = true">
            {{ year }} 年 {{ month }} 月
          </button>
          <button type="button" class="bills__arrow" aria-label="下个月" @click="shiftMonth(1)">›</button>
        </span>
      </div>

      <div class="bills__tools-row">
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

        <span class="bills__spacer"></span>

        <span class="bills__tools-end">
          <button type="button" class="bills__icon" aria-label="搜索账单" @click="goSearch">
            <span aria-hidden="true">🔍</span>
          </button>
          <button type="button" class="bills__icon" aria-label="统计账单" @click="goStats">
            <span aria-hidden="true">◔</span>
          </button>
        </span>
      </div>
    </div>

    <!-- 刷新失败但有旧快照：留在 ready，只出内联提示条（组件不改，页面自己画） -->
    <p v-if="staleError !== ''" class="bills__stale" role="status">
      <span class="bills__stale-text">{{ STALE_NOTICE }}</span>
      <button type="button" class="bills__stale-btn" @click="reload">重试</button>
    </p>

    <!-- ③–⑥ 内容区四态（标题/说明用 StateCard 默认，避免 error 态被写成「账单」）。
         monthPending 等待期换「日历 + 指标 + 列表条」骨架组合（骨架屏批）：判据
         monthPending 不动，sr 文案保留原「正在聚合当月数据…」的读屏播报。 -->
    <div v-if="showMonthSkeleton" class="bills__skel" role="status" aria-live="polite">
      <span class="bills__skel-sr">正在聚合当月数据…</span>
      <section class="bills__card">
        <SkeletonBlock variant="calendar" />
      </section>
      <div class="bills__skel-metrics">
        <SkeletonBlock v-for="i in 4" :key="i" variant="card" />
      </div>
      <section class="bills__card">
        <div class="bills__skel-rows">
          <SkeletonBlock variant="line" width="92%" />
          <SkeletonBlock variant="line" width="76%" />
          <SkeletonBlock variant="line" width="84%" />
          <SkeletonBlock variant="line" width="68%" />
        </div>
      </section>
    </div>
    <StateCard v-else :state="pageState" :desc="cardDesc" @action="reload">
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
          :selected-day="activeDay"
          :masked="privacy.enabled"
          @pick="openDay"
        />
      </section>

      <!-- ④ 指标带 -->
      <BillMetrics :totals="totals" :commodity="commodity" />

      <!-- ⑤ 折线卡（B-08）：标题与口径文案照设计稿 `.card-title` / `.card-note`；
           PC 高度 240（设计 `.chart-h`，移动 220） -->
      <section class="bills__card bills__card--chart">
        <TrendChart
          title="当月收支趋势"
          note="每日收入 / 支出折线"
          :chart-label="`${month} 月每日收入与支出，按自然日`"
          :labels="dayLabels"
          :series="trendSeries"
          :commodity="commodity"
          :masked="privacy.enabled"
          :height="220"
          :wide-height="240"
        />
      </section>

      <!-- ⑥ 月列表卡：按日分组，行用 TxnRow bill 档 -->
      <section class="bills__card">
        <div class="bills__card-head">
          <h2 class="bills__card-title">当月明细</h2>
          <span class="bills__card-note">日期 · 类型 · 金额 · 备注</span>
        </div>
        <!-- 外部列表恒为整月全量；当日明细只在下面的底部 sheet 里看。 -->
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
    <DayTransactionsSheet
      :open="activeDay !== null"
      :month="month"
      :day="activeDay"
      :txns="dayTxns"
      :accounts="data.accounts"
      @close="activeDay = null"
      @open-detail="openDetail"
    />
  </section>
</template>

<style scoped>
.bills {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-bottom: 8px;
}

/* ① hero（B-03）：标题 21/700 `--fb-ink-deep`；健康图标贴标题行右侧，
   不占独立一行，也不再渲染占位的说明性小标题。 */
.bills__hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 0 2px;
}

.bills__title {
  margin: 0;
  color: var(--fb-ink-deep);
  font-size: 21px;
  font-weight: 700;
  letter-spacing: 0.01em;
}

/* 恒等式检查图标：三种 tone 只换语义色与字形，结论本身在 title / aria-label 里。 */
.bills__health-icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 18px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
}

.bills__health-icon--ok {
  border-color: var(--fb-brand-line);
  background: var(--fb-green-soft);
  color: var(--fb-green-ink);
}

.bills__health-icon--unbalanced {
  border-color: var(--fb-danger);
  background: var(--fb-danger-soft);
  color: var(--fb-danger-ink);
}

.bills__health-icon:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

/* ② 工具卡（B-01）：设计与下方日历卡同为 `.card`，缺了容器这四件控件会直接浮在
   纸底，形成「有卡 / 无卡」夹心。行内两段用 `.bills__spacer` 撑开左右。 */
.bills__tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 16px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

.bills__tools-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  flex: 1 1 100%;
}

.bills__spacer {
  flex: 1;
}

/* chip（B-05）：设计 13px/600、min-height 36、padding 7px 12px。
   视觉收小但命中区不缩 —— `::after` 四向外扩 4px 补回 44px 触控目标。 */
.bills__chip {
  position: relative;
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
  cursor: pointer;
}

.bills__chip::after {
  content: '';
  position: absolute;
  top: -4px;
  right: -4px;
  bottom: -4px;
  left: -4px;
}

.bills__chip-label {
  max-width: 128px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bills__chip-caret {
  color: var(--fb-sub);
  font-size: 10px;
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

/* 方向按钮（B-05）：收成设计 `.icon-btn` 规格 36×36 / 描边 / 品牌绿 */
.bills__arrow {
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

/* 币种 seg（B-05）：选中态是「实心墨绿 + 米白字」，不是「白底 + 绿字」（原实现反色） */
.bills__seg {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
}

.bills__seg-btn {
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

.bills__seg-btn--on {
  background: var(--fb-blue);
  color: var(--fb-white);
  font-weight: 600;
}

.bills__tools-end {
  display: inline-flex;
  gap: 6px;
}

/* 图标按钮（B-05）：36×36 / 品牌绿（原 44×44 次要色） */
.bills__icon {
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
  font-size: 16px;
  cursor: pointer;
}

@media (max-width: 768px) {
  .bills__tools {
    padding: 14px;
  }
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

/* 卡片通用。内衬 14px 与统计页 `.stats__card`、资产页 `.assets__card`、
   资产统计 `.astats__card` 一致 —— 横向左边界已统一，内衬再差 2px，
   切页时会看出卡片「胖瘦」不同。 */
.bills__card {
  padding: 14px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

/* 卡头（B-09）：设计 `.card-head` —— 标题 15/700 在左，字段说明 11px 在右 */
.bills__card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}

.bills__card-title {
  margin: 0;
  color: var(--fb-ink);
  font-size: 15px;
  font-weight: 700;
}

.bills__card-note {
  flex: none;
  color: var(--fb-sub);
  font-size: 11px;
}

/* ⑥ 列表（整月全量；当日交易在 DayTransactionsSheet 里看，不再有日筛选行） */
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

/* 聚合骨架（骨架屏批）：三段结构贴近真实内容区（日历大块 / 4 指标小卡 / 列表条），
   数据到达后 v-if 切换不产生布局跳动；指标栅格与 BillMetrics 同构（900 断点 2→4 列）。 */
.bills__skel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.bills__skel-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  /* 与 BillMetrics 的固定 gap 一致：骨架 → 真实卡片不跳动 */
  gap: 12px;
}

.bills__skel-rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 读屏专用（视觉隐藏）：骨架是纯装饰块，原「正在聚合当月数据…」文案继续喂给 aria-live。 */
.bills__skel-sr {
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

@media (min-width: 900px) {
  .bills__skel-metrics {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
</style>
