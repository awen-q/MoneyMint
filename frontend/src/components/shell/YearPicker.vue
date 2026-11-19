<script setup lang="ts">
/**
 * YearPicker —— 年份选择（报表重设计 T14）。
 *
 * 基于 SelectSheet，布局与 MonthPicker 同类：顶部 `‹ 起 – 止 ›` + 年份网格。
 *
 * 一处有意偏离原型：原型的标题位只写了一个年份（`‹ 2026 ›`），但年份网格是按
 * **12 年一页**翻的，单个数字会被读成「当前选中 2026」，与下面高亮的格子对不上。
 * 这里标题位显示本页的年份区间（`2026 – 2037`），箭头翻页语义与原型一致：
 * 到底（第一页 / 最后一页）时对应箭头 `disabled`。
 */
import { computed, ref, watch } from 'vue'

import SelectSheet from './SelectSheet.vue'

/** 每页年份数（3 列 × 4 行）。 */
const PAGE_SIZE = 12

const props = withDefaults(
  defineProps<{
    /** 是否打开（透传给 SelectSheet）。 */
    open: boolean
    /** 当前选中年份；不传则以今年兜底。 */
    value?: number
    /** 可选年份下界（含）。 */
    minYear?: number
    /** 可选年份上界（含）。 */
    maxYear?: number
  }>(),
  {
    value: () => new Date().getFullYear(),
    minYear: 1970,
    maxYear: 2100,
  },
)

const emit = defineEmits<{
  /** 请求关闭（遮罩 / 关闭按钮 / 选完年份）。 */
  close: []
  /** 选中某个年份；紧接着会 emit close。 */
  select: [year: number]
}>()

/** 把年份夹到 [minYear, maxYear]。 */
function clampYear(year: number): number {
  if (year < props.minYear) {
    return props.minYear
  }
  if (year > props.maxYear) {
    return props.maxYear
  }
  return year
}

/**
 * 把年份对齐到页首：以 minYear 为锚点切页，保证翻页序列稳定
 * （不随 value 变化而抖动，也不会出现某一页只差一年就重复的情况）。
 */
function alignPage(year: number): number {
  const offset = year - props.minYear
  if (offset <= 0) {
    return props.minYear
  }
  return props.minYear + Math.floor(offset / PAGE_SIZE) * PAGE_SIZE
}

/** 当前页的起始年。 */
const pageStart = ref<number>(alignPage(clampYear(props.value)))

watch(
  () => props.open,
  (open) => {
    if (open) {
      pageStart.value = alignPage(clampYear(props.value))
    }
  },
  { immediate: true },
)

/** 本页实际渲染的年份：最后一页可能不足 12 个，超出 maxYear 的一律不渲染。 */
const visibleYears = computed(() => {
  const years: number[] = []
  for (let index = 0; index < PAGE_SIZE; index += 1) {
    const year = pageStart.value + index
    if (year <= props.maxYear) {
      years.push(year)
    }
  }
  return years
})

const canPrev = computed(() => pageStart.value > props.minYear)
const canNext = computed(() => pageStart.value + PAGE_SIZE <= props.maxYear)

const rangeLabel = computed(() => {
  const years = visibleYears.value
  if (years.length === 0) {
    return String(pageStart.value)
  }
  const first = years[0] as number
  const last = years[years.length - 1] as number
  return first === last ? String(first) : `${first} – ${last}`
})

function isSelected(year: number): boolean {
  return props.value === year
}

function shiftPage(delta: number): void {
  const next = pageStart.value + delta * PAGE_SIZE
  if (next < props.minYear) {
    return
  }
  if (next > props.maxYear) {
    return
  }
  pageStart.value = next
}

function pick(year: number): void {
  emit('select', year)
  emit('close')
}

function onClose(): void {
  emit('close')
}
</script>

<template>
  <SelectSheet
    :open="open"
    title="选择年份"
    dialog-label="选择账期年份"
    @close="onClose"
  >
    <div class="yp-year">
      <button
        type="button"
        class="yp-arrow"
        :disabled="!canPrev"
        aria-label="上一页年份"
        @click="shiftPage(-1)"
      >
        <span aria-hidden="true">‹</span>
      </button>
      <strong class="yp-year__label">{{ rangeLabel }}</strong>
      <button
        type="button"
        class="yp-arrow"
        :disabled="!canNext"
        aria-label="下一页年份"
        @click="shiftPage(1)"
      >
        <span aria-hidden="true">›</span>
      </button>
    </div>

    <div class="yp-grid" role="group" aria-label="年份">
      <button
        v-for="year in visibleYears"
        :key="year"
        type="button"
        class="yp-cell"
        :class="{ 'yp-cell--on': isSelected(year) }"
        :aria-pressed="isSelected(year)"
        :aria-label="`${year} 年`"
        @click="pick(year)"
      >
        <span class="yp-cell__text">{{ year }}</span>
      </button>
    </div>
  </SelectSheet>
</template>

<style scoped>
.yp-year {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--fb-space-3);
  margin-bottom: var(--fb-space-3);
}

.yp-year__label {
  min-width: 108px;
  font-size: 15px;
  font-weight: 700;
  color: var(--fb-ink);
  text-align: center;
  font-variant-numeric: var(--fb-font-numeric);
}

/* 触控目标 44×44 */
.yp-arrow {
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

.yp-arrow:disabled {
  color: var(--fb-line-strong);
  border-color: var(--fb-line);
  background: var(--fb-soft);
  cursor: not-allowed;
}

.yp-arrow:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

.yp-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--fb-space-2);
}

.yp-cell {
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

.yp-cell--on {
  background: var(--fb-blue-soft);
  border-color: var(--fb-blue);
  color: var(--fb-blue);
}

.yp-cell:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

.yp-cell__text {
  font-variant-numeric: var(--fb-font-numeric);
}
</style>
