<script setup lang="ts">
/**
 * 日历卡（T27 / B2）：42 格网格 + 四态 + 逐格读屏文案 + 卡头摘要。
 *
 * 三条不可动摇的口径：
 * 1. **判断全在 `core/bill.ts`，本组件只映射到 DOM**。`kind`/`text`/`incomeDot`/`ariaLabel`
 *    都是 `billCells` 的产出；组件里**不判正负、不拼金额、不排序、不 slice**。
 *    一旦在渲染层再判一次，日历格与卡头合计就会各说各话。
 * 2. **`both` 主数字仍是支出侧**（`text` 口径不动）：同日有收入时第二行另显示
 *    `incomeText`，右上角 4px 圆点仍作快速扫描标记，精确值照旧进读屏文案。
 * 3. **遮挡优先**：`masked` 为真时格子只显示遮挡符，读屏文案换成「N月D日，金额已隐藏」；
 *    收入第二行与收入圆点一起隐藏，遮挡态不泄露「这日有收入」的结构信息。
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
    /** 当日 sheet 正在展示的日（1..31）；只用于高亮，`null` 表示抽屉关闭。 */
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

/**
 * 格子的渲染态类名：补位格仍是 `padding`，遮挡态所有当月格统一降级为 `masked`。
 *
 * 遮挡时 DOM 不再出现 `both`/`income-only`/`expense-only`/`empty` 这些真实 kind，
 * 避免有人从类名（或四态配色）反推当天有无收入。这里**只作用于渲染层**：
 * `core/bill.ts` 的 `BillCell.kind` 与四态判断逻辑一律不动，卡头摘要也照旧。
 */
function cellClass(cell: CalendarDay): string {
  if (!cell.inMonth) return 'padding'
  if (props.masked) return 'masked'
  return cellKind(cell)
}

/** 格子主数字：`empty` 不显示；遮挡态统一显示遮挡符（绝不露 `-1.2k`）。 */
function cellText(cell: CalendarDay): string {
  const data = cellOf(cell.day, cell.inMonth)
  if (data === undefined || data.kind === 'empty') {
    return ''
  }
  return props.masked ? PRIVACY_MASK : data.text
}

/**
 * 同日双有格的第二行收入数字：仅 `both` 有值；遮挡态一律不显示（连圆点一起隐藏）。
 * 纯收入日的第一行已经是 `+1.8k`，不重复再摆一行。
 */
function incomeCellText(cell: CalendarDay): string {
  if (cellKind(cell) !== 'both' || props.masked) {
    return ''
  }
  const data = cellOf(cell.day, cell.inMonth)
  return data === undefined ? '' : (data.incomeText ?? '')
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
    <!-- 卡头（B-06）：左 = 卡标题，右 = 本月合计（tabular 右对齐）+ 口径说明。
         标题文案受 `BillCalendar.test.ts` 精确断言锁定（「2026 年 11 月」），
         故只对齐字号/字重与双列结构，不改字。 -->
    <header class="bill-cal__head">
      <h2 class="bill-cal__title">{{ year }} 年 {{ month }} 月</h2>
      <span class="bill-cal__head-right">
        <span class="bill-cal__sum">
          支出
          <MoneyText :amount="totals.expense" :commodity="commodity" size="sm" />
          <span aria-hidden="true">·</span>
          收入
          <MoneyText :amount="totals.income" :commodity="commodity" size="sm" />
          <span aria-hidden="true">·</span>
          记账 {{ activeDays }} 天
        </span>
        <span class="bill-cal__note">点击日期查看当日流水</span>
      </span>
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
          `cal__cell--${cellClass(cell)}`,
          { 'cal__cell--today': isToday(cell), 'cal__cell--on': isSelected(cell) },
        ]"
        :type="cell.inMonth ? 'button' : undefined"
        :aria-hidden="cell.inMonth ? undefined : 'true'"
        :aria-label="cell.inMonth ? cellLabel(cell) : undefined"
        :aria-pressed="cell.inMonth ? isSelected(cell) : undefined"
        @click="cell.inMonth ? emit('pick', cell.day) : undefined"
      >
        <span class="cal__day">{{ cell.day }}</span>
        <span v-if="!props.masked && hasIncomeDot(cell)" class="cal__dot" aria-hidden="true" />
        <span v-if="cellText(cell) !== ''" class="cal__amount">{{ cellText(cell) }}</span>
        <span
          v-if="incomeCellText(cell) !== ''"
          class="cal__amount cal__amount--income"
        >{{ incomeCellText(cell) }}</span>
      </component>
    </div>

    <!-- 操作说明（B-06 ④ / 设计 `.tap-hint`）：移动端第一次用不知道格子可点 -->
    <p class="bill-cal__hint">
      点击日期：底部弹出当日交易明细（下方整月列表不变，关掉抽屉即可继续看整月）；格内金额为简写：
      支出（红）/ 纯收入日（绿），同日有收入时第二行显示收入金额，右上角圆点仍作快速扫描标记
    </p>
  </div>
</template>

<style scoped>
/* 卡头（B-06）：设计 `.card-head` 双列 —— 基线对齐、两端拉开、下方 12px */
.bill-cal__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}

.bill-cal__title {
  margin: 0;
  color: var(--fb-ink);
  font-size: 15px;
  font-weight: 700;
}

/* 卡头右端多件（设计 `.card-head-right`）：上=合计，下=口径说明 */
.bill-cal__head-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.bill-cal__sum {
  color: var(--fb-sub);
  font-size: 12px;
  font-variant-numeric: var(--fb-font-numeric);
  text-align: right;
}

.bill-cal__note {
  color: var(--fb-sub);
  font-size: 11px;
}

/* 设计 `.card-head--stack`（≤768）：竖排、左对齐，避免标题被挤成两行 */
@media (max-width: 768px) {
  .bill-cal__head {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
  }

  .bill-cal__head-right {
    align-items: flex-start;
    gap: 1px;
  }

  .bill-cal__sum {
    text-align: left;
  }
}

/* 格间隙 3px（B-11，设计 `.cal-grid`），周表头 11px（设计 `.cal-week`） */
.bill-cal__week,
.bill-cal__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 3px;
}

.bill-cal__week {
  margin-bottom: 4px;
}

.bill-cal__week-cell {
  color: var(--fb-sub);
  font-size: 11px;
  text-align: center;
}

/* 42 格日历格（B-02，设计 `.cal-cell`）：
   **无框 + 透明底 + 日号左对齐** —— 原来每格 1px 实线 + 卡底 + 居中，42 格变成 Excel 表格。
   46px 是单行金额的旧实测下限；同日双有要摆两行金额（15.5 + 11.5×2 + padding 6 + border 2
   ≈ 46.5），故抬到 52px，勿降到 46 切掉第二行。 */
.cal__cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-start;
  min-height: 52px;
  padding: 3px 4px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 11.5px;
  line-height: 1.35;
  text-align: left;
  overflow: hidden;
  cursor: pointer;
}

/* 补位格：不可见但仍占格（不能「不渲染」——42 格恒 6 行是版式不变量） */
.cal__cell--padding {
  visibility: hidden;
}

.cal__day {
  color: var(--fb-ink);
  font-size: 11.5px;
  font-weight: 600;
  font-variant-numeric: var(--fb-font-numeric);
}

.cal__amount {
  margin-top: 0;
  font-size: 8.5px;
  font-weight: 400;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: var(--fb-font-numeric);
}

/* 今天：设计 `.cal-cell.today`（淡绿描边 + green-soft 底）。
   放在 `--on` 之前 —— 选中态必须盖过今天，否则「我点了哪一天」看不出来。 */
.cal__cell--today {
  border-color: var(--fb-brand-line);
  background: var(--fb-green-soft);
}

/* 选中：设计 `.cal-cell.sel`（墨绿描边 + brand-soft 底 + 1px 内阴影） */
.cal__cell--on {
  border-color: var(--fb-blue);
  background: var(--fb-brand-soft);
  box-shadow: 0 0 0 1px var(--fb-blue) inset;
}

.cal__cell:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 1px;
}

/* 四态配色（B-10）：无填充格直接用设计值 `--expense` / `--income`
   （在 `--fb-card` 上实测 5.22 / 4.72，均过 AA 正文门禁）。 */
.cal__cell--expense-only .cal__amount,
.cal__cell--both .cal__amount {
  color: var(--fb-danger);
}

.cal__cell--income-only .cal__amount {
  color: var(--fb-green);
}

/* 唯一例外：今天 / 选中格有 soft 填充，`--fb-green` on `--fb-green-soft` 只有
   4.14:1 不过 AA，故在这两态里覆盖回 ink 变体（这是 ink 色存在的理由，
   不是可随手替换的等价色）。 */
.cal__cell--today.cal__cell--income-only .cal__amount,
.cal__cell--on.cal__cell--income-only .cal__amount {
  color: var(--fb-green-ink);
}

.cal__cell--today.cal__cell--expense-only .cal__amount,
.cal__cell--today.cal__cell--both .cal__amount,
.cal__cell--on.cal__cell--expense-only .cal__amount,
.cal__cell--on.cal__cell--both .cal__amount {
  color: var(--fb-danger-ink);
}

/* 双有格第二行收入：默认绿。上面的 `.cal__cell--both .cal__amount` 也会命中它，
   所以显式加一条同特异性选择器，否则第二行会被染成支出红。 */
.cal__amount--income,
.cal__cell--both .cal__amount--income {
  color: var(--fb-green);
}

/* 镜像上面的 income-only ink 覆盖：today/on 有 soft 填充，绿字要回到 ink 变体过 AA。
   `both` 格同样命中支出红的 ink 覆盖，故这里两条都列出。 */
.cal__cell--today.cal__cell--income-only .cal__amount--income,
.cal__cell--on.cal__cell--income-only .cal__amount--income,
.cal__cell--today.cal__cell--both .cal__amount--income,
.cal__cell--on.cal__cell--both .cal__amount--income {
  color: var(--fb-green-ink);
}

/* 遮挡态：格子已无四态类名，上面的四态配色与 today/on ink 覆盖全不命中，
   统一回落到中性 `--fb-sub`（与 `MoneyText` 的遮挡口径一致）。只用现有 token。 */
.cal__cell--masked .cal__amount {
  color: var(--fb-sub);
}

.cal__cell--masked .cal__amount--income {
  color: var(--fb-sub);
}

/* 收入圆点：设计 `.i-dot`（top/right 4px） */
.cal__dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--fb-green);
}

/* 底部操作说明（设计 `.tap-hint`） */
.bill-cal__hint {
  margin: 8px 0 0;
  color: var(--fb-sub);
  font-size: 11px;
  line-height: 1.7;
}
</style>
