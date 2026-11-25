<script setup lang="ts">
/**
 * MonthPicker —— 账期月份选择（报表重设计 T13）。
 *
 * 基于 SelectSheet：移动端底部 sheet、PC 居中模态，滚动锁 / 焦点陷阱 / ESC 全由底座负责。
 * 布局：顶部 `‹ 2026 年 ›`（到 minYear / maxYear 边界时对应箭头 disabled）+ 12 宫格（3 列 × 4 行）。
 *
 * 打点（has-data dot）语义：`monthsWithData` 里出现过的 `YYYY-MM` 表示该月**有数据**，
 * 格子右上角显示 4px 圆点。它只是「提示」，不参与可选性——没数据的月份照样能点，
 * 因为「本月无交易」本身也是一次有效查询。
 */
import { computed, ref, watch } from 'vue'

import { t } from '@/i18n'

import SelectSheet from './SelectSheet.vue'

const props = withDefaults(
  defineProps<{
    /** 是否打开（透传给 SelectSheet）。 */
    open: boolean
    /** 当前选中账期；不传则以今天兜底，避免调用方首帧拿到 undefined 崩掉。 */
    value?: { year: number; month: number }
    /** 可选年份下界（含）。 */
    minYear?: number
    /** 可选年份上界（含）。 */
    maxYear?: number
    /** 有数据的月份，形如 `['2026-08', '2026-09']`，用于打点。 */
    monthsWithData?: string[]
  }>(),
  {
    value: () => ({ year: new Date().getFullYear(), month: new Date().getMonth() + 1 }),
    minYear: 1970,
    maxYear: 2100,
    monthsWithData: () => [],
  },
)

const emit = defineEmits<{
  /** 请求关闭（遮罩 / 关闭按钮 / 选完月份）。 */
  close: []
  /** 选中某个月份；紧接着会 emit close，调用方无需自己收。 */
  select: [payload: { year: number; month: number }]
}>()

/** 12 个月份序号，供 v-for 使用（不引入额外工具函数）。 */
const MONTHS: number[] = []
for (let month = 1; month <= 12; month += 1) {
  MONTHS.push(month)
}

/** 把年份夹到 [minYear, maxYear]，防止调用方传越界值时箭头逻辑死锁。 */
function clampYear(year: number): number {
  if (year < props.minYear) {
    return props.minYear
  }
  if (year > props.maxYear) {
    return props.maxYear
  }
  return year
}

/** 当前浏览的年份（箭头切换的是它，不是选中值）。 */
const viewYear = ref<number>(clampYear(props.value.year))

// 每次打开都对齐到「当前选中账期所在年」，避免上次浏览位置残留。
watch(
  () => props.open,
  (open) => {
    if (open) {
      viewYear.value = clampYear(props.value.year)
    }
  },
  { immediate: true },
)

const canPrev = computed(() => viewYear.value > props.minYear)
const canNext = computed(() => viewYear.value < props.maxYear)

/** 打点键：月份补零到两位，与后端 `YYYY-MM` 口径一致。 */
function monthKey(year: number, month: number): string {
  return `${year}-${month < 10 ? `0${month}` : String(month)}`
}

function hasData(month: number): boolean {
  return props.monthsWithData.indexOf(monthKey(viewYear.value, month)) >= 0
}

function isSelected(month: number): boolean {
  return props.value.year === viewYear.value && props.value.month === month
}

/** 读屏文案带上「有数据」，让打点这个纯视觉信息也有文字等价物。 */
function cellLabel(month: number): string {
  const base = t('shell.monthCellLabel', { year: String(viewYear.value), month: String(month) })
  return hasData(month) ? base + t('shell.hasData') : base
}

function shiftYear(delta: number): void {
  const next = viewYear.value + delta
  if (next < props.minYear || next > props.maxYear) {
    return
  }
  viewYear.value = next
}

function pick(month: number): void {
  emit('select', { year: viewYear.value, month })
  emit('close')
}

function onClose(): void {
  emit('close')
}
</script>

<template>
  <SelectSheet
    :open="open"
    :title="t('shell.selectMonthTitle')"
    :dialog-label="t('shell.selectMonthDialog')"
    @close="onClose"
  >
    <div class="mp-year">
      <button
        type="button"
        class="mp-arrow"
        :disabled="!canPrev"
        :aria-label="t('shell.prevYear')"
        @click="shiftYear(-1)"
      >
        <span aria-hidden="true">‹</span>
      </button>
      <strong class="mp-year__label">{{ t('shell.yearLabel', { year: String(viewYear) }) }}</strong>
      <button
        type="button"
        class="mp-arrow"
        :disabled="!canNext"
        :aria-label="t('shell.nextYear')"
        @click="shiftYear(1)"
      >
        <span aria-hidden="true">›</span>
      </button>
    </div>

    <div class="mp-grid" role="group" :aria-label="t('shell.monthGridLabel', { year: String(viewYear) })">
      <button
        v-for="month in MONTHS"
        :key="month"
        type="button"
        class="mp-cell"
        :class="{ 'mp-cell--on': isSelected(month), 'mp-cell--has': hasData(month) }"
        :aria-pressed="isSelected(month)"
        :aria-label="cellLabel(month)"
        @click="pick(month)"
      >
        <span class="mp-cell__text">{{ t('shell.monthShort', { month: String(month) }) }}</span>
        <i v-if="hasData(month)" class="mp-cell__dot" aria-hidden="true" />
      </button>
    </div>
  </SelectSheet>
</template>

<style scoped>
.mp-year {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--fb-space-3);
  margin-bottom: var(--fb-space-3);
}

.mp-year__label {
  min-width: 84px;
  font-size: 15px;
  font-weight: 700;
  color: var(--fb-ink);
  text-align: center;
  font-variant-numeric: var(--fb-font-numeric);
}

/* 触控目标 44×44（视觉用 30×30 的圆角块呈现） */
.mp-arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.mp-arrow:disabled {
  color: var(--fb-line-strong);
  border-color: var(--fb-line);
  background: var(--fb-soft);
  cursor: not-allowed;
}

.mp-arrow:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

.mp-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--fb-space-2);
}

.mp-cell {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 10px 0;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.mp-cell--has {
  border-color: var(--fb-blue-line);
}

.mp-cell--on {
  background: var(--fb-blue-soft);
  border-color: var(--fb-blue);
  color: var(--fb-blue);
}

.mp-cell:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

.mp-cell__text {
  font-variant-numeric: var(--fb-font-numeric);
}

/* 有数据打点：纯视觉提示，读屏由 cellLabel 的「有数据」兜底 */
.mp-cell__dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--fb-blue);
}
</style>
