<script setup lang="ts">
/**
 * 日历卡（T27 / B2）：42 格网格 + 四态 + 逐格读屏文案 + 卡头摘要。
 *
 * 三条不可动摇的口径：
 * 1. **判断全在 `core/bill.ts`，本组件只映射到 DOM**。`kind`/`text`/`incomeDot`/`ariaLabel`
 *    都是 `billCells` 的产出；组件里**不判正负、不拼金额、不排序、不 slice**。
 *    一旦在渲染层再判一次，日历格与卡头合计就会各说各话。
 * 2. **`both` 只显示支出侧**（LO-01：格宽放不下两行数字），收入只体现为右上角 4px 圆点，
 *    收入金额只进读屏文案。所以这里不会出现「第二行数字」。
 * 3. **遮挡优先**：`masked` 为真时格子只显示遮挡符，读屏文案换成「N月D日，金额已隐藏」。
 *    刻意**不复用** core 的精确文案再打码 —— 那会念成「收入 金额已隐藏，支出 金额已隐藏」，
 *    既啰嗦又额外暴露「这天收支都有」。
 *
 * 卡片外观（圆角/阴影/内边距）由页面给，本组件只管内容，避免三个组件各抄一份卡片样式。
 */
import type { BillCell, BillMonthTotals } from '@/core/bill'
import type { CalendarDay } from '@/core/calendar'
import { PRIVACY_MASK } from '@/core/privacy'
import MoneyText from '@/components/MoneyText.vue'

/** 周一起始的星期表头（与 `buildMonthGrid` 的 `(getDay()+6)%7` 偏移一致）。 */
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

const props = withDefaults(
  defineProps<{
    year: number
    /** 1-12。 */
    month: number
    /** 42 格（含前后月补位），由 `buildMonthGrid` 产出。 */
    grid: CalendarDay[]
    /** 当月每日四态（长度 = 当月天数），由 `billCells` 产出。 */
    cells: BillCell[]
    /** 月合计，仅用于卡头摘要。 */
    totals: BillMonthTotals
    /** 展示币种（卡头摘要按该币种渲染金额）。 */
    commodity: string
    /** 有交易的天数（卡头摘要「记账 N 天」）。 */
    activeDays: number
    /** 被选中的日（1..31）；`null` 表示未筛选。 */
    selectedDay?: number | null
    /** 隐私遮挡。 */
    masked?: boolean
  }>(),
  {
    selectedDay: null,
    masked: false,
  },
)

const emit = defineEmits<{
  /** 点某个当月日（是否切换选中由父级决定）。 */
  pick: [day: number]
}>()

function twoDigits(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * 今天（本地时区）的 `YYYY-MM-DD`。
 *
 * **每次调用都取一次**，不在 setup 里存常量：桌面端标签页可能跨零点不关，
 * 存下来的值第二天就会把昨天标成「今天」。
 */
function todayKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`
}

/** 该格是不是今天（稿 370 `.cal-cell.today` / app.js:584）。补位格永不命中。 */
function isToday(cell: CalendarDay): boolean {
  if (!cell.inMonth) {
    return false
  }
  return `${props.year}-${twoDigits(props.month)}-${twoDigits(cell.day)}` === todayKey()
}

/** 取某天的四态数据；补位格与越界一律 `undefined`。 */
function cellOf(day: number, inMonth: boolean): BillCell | undefined {
  if (!inMonth) {
    return undefined
  }
  return props.cells[day - 1]
}

function cellKind(cell: CalendarDay): string {
  const data = cellOf(cell.day, cell.inMonth)
  return data === undefined ? 'empty' : data.kind
}

/** 格子主数字：`empty` 不显示；遮挡态统一显示遮挡符（绝不露 `-1.2k`）。 */
function cellText(cell: CalendarDay): string {
  const data = cellOf(cell.day, cell.inMonth)
  if (data === undefined || data.kind === 'empty') {
    return ''
  }
  return props.masked ? PRIVACY_MASK : data.text
}

function hasIncomeDot(cell: CalendarDay): boolean {
  const data = cellOf(cell.day, cell.inMonth)
  return data !== undefined && data.incomeDot
}

/**
 * 逐格读屏文案：未遮挡沿用 core 的精确文案，遮挡换中性文案（见文件头第 3 条）。
 * 今天在末尾补「，今天」（稿 app.js:592 同口径）—— 视觉上的高亮对读屏不可见。
 */
function cellLabel(cell: CalendarDay): string {
  if (!cell.inMonth) {
    return ''
  }
  const suffix = isToday(cell) ? '，今天' : ''
  if (props.masked) {
    return `${props.month}月${cell.day}日，金额已隐藏${suffix}`
  }
  const data = cellOf(cell.day, cell.inMonth)
  return data === undefined ? `${props.month}月${cell.day}日${suffix}` : `${data.ariaLabel}${suffix}`
}

function isSelected(cell: CalendarDay): boolean {
  return cell.inMonth && props.selectedDay === cell.day
}
</script>

<template>
  <div class="bill-cal">
    <header class="bill-cal__head">
      <h2 class="bill-cal__title">{{ year }} 年 {{ month }} 月</h2>
      <p class="bill-cal__sub">
        支出
        <MoneyText :amount="totals.expense" :commodity="commodity" size="sm" />
        <span aria-hidden="true">·</span>
        收入
        <MoneyText :amount="totals.income" :commodity="commodity" size="sm" />
        <span aria-hidden="true">·</span>
        记账 {{ activeDays }} 天
      </p>
    </header>

    <div class="bill-cal__week" aria-hidden="true">
      <span v-for="label in WEEKDAYS" :key="label" class="bill-cal__week-cell">{{ label }}</span>
    </div>

    <div class="bill-cal__grid">
      <component
        :is="cell.inMonth ? 'button' : 'div'"
        v-for="cell in grid"
        :key="cell.key"
        class="cal__cell"
        :class="[
          `cal__cell--${cell.inMonth ? cellKind(cell) : 'padding'}`,
          { 'cal__cell--today': isToday(cell), 'cal__cell--on': isSelected(cell) },
        ]"
        :type="cell.inMonth ? 'button' : undefined"
        :aria-hidden="cell.inMonth ? undefined : 'true'"
        :aria-label="cell.inMonth ? cellLabel(cell) : undefined"
        :aria-pressed="cell.inMonth ? isSelected(cell) : undefined"
        @click="cell.inMonth ? emit('pick', cell.day) : undefined"
      >
        <span class="cal__day">{{ cell.day }}</span>
        <span v-if="hasIncomeDot(cell)" class="cal__dot" aria-hidden="true" />
        <span v-if="cellText(cell) !== ''" class="cal__amount">{{ cellText(cell) }}</span>
      </component>
    </div>
  </div>
</template>

<style scoped>
.bill-cal__head {
  margin-bottom: 8px;
}

.bill-cal__title {
  margin: 0;
  color: var(--fb-ink-deep);
  font-size: 14px;
  font-weight: 700;
}

.bill-cal__sub {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px;
  margin: 3px 0 0;
  color: var(--fb-sub);
  font-size: 12px;
  line-height: 1.5;
}

.bill-cal__week,
.bill-cal__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}

.bill-cal__week {
  margin-bottom: 4px;
}

.bill-cal__week-cell {
  color: var(--fb-sub);
  font-size: 10px;
  text-align: center;
}

/* 46px 格高：LO-01 的实测结论（低于此值简写金额放不下） */
.cal__cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  min-height: 46px;
  padding: 3px 2px 4px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 10px;
  line-height: 1.2;
  overflow: hidden;
  cursor: pointer;
}

.cal__cell--padding {
  border-color: transparent;
  color: var(--fb-sub);
  cursor: default;
}

/* 今天：稿 370 `.cal-cell.today`（brand-line 边 + green-soft 底）。
   放在 `--on` 之前 —— 选中态必须盖过今天，否则「我点了哪一天」看不出来。 */
.cal__cell--today {
  border-color: var(--fb-green);
  background: var(--fb-green-soft);
}

.cal__cell--on {
  border-color: var(--fb-blue);
  background: var(--fb-blue-soft);
}

.cal__cell:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 1px;
}

.cal__day {
  font-variant-numeric: var(--fb-font-numeric);
  font-size: 10px;
}

.cal__amount {
  margin-top: 2px;
  font-size: 9px;
  font-weight: 600;
  white-space: nowrap;
  font-variant-numeric: var(--fb-font-numeric);
}

/* 四态配色：支出红、收入绿；soft 底上的正文用 ink 版才达 AA */
.cal__cell--expense-only .cal__amount,
.cal__cell--both .cal__amount {
  color: var(--fb-danger-ink);
}

.cal__cell--income-only .cal__amount {
  color: var(--fb-green-ink);
}

.cal__dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--fb-green);
}
</style>
