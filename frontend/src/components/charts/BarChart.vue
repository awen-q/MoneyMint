<script setup lang="ts">
/**
 * 柱状图（逐日 / 分类对比）。ECharts 5.6 + SVG renderer 的薄封装。
 *
 * 与 TrendChart / DonutChart 同构，只做四件事：init → setOption → resize → dispose。
 *
 * 两个刻意的设计决策：
 * 1. **单击即下钻**，不做「二次 tap」：第一下没反应会被当成坏了。因此 option 层
 *    关掉了 tooltip（否则一次 tap 同时弹浮层又跳转）。精确查值由同页明细表承担。
 * 2. **不加绝对定位命中层**：`params.dataIndex` 就是 ECharts 给出的权威索引，
 *    叠一层 DOM 命中层只会抢走手势并把「点了哪根柱」搞错。
 */
import type { ECElementEvent } from 'echarts/core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { acquireChart, initChart, type EChartsInstance } from '@/core/charts/echarts'
import { GRID, buildBarOption, type BarDatum } from '@/core/charts/option'
import { locale } from '@/i18n'
import { getChartPalette, readThemeTokens, themeEpoch } from '@/styles/themeTokens'

import ChartFrame from './ChartFrame.vue'

const props = withDefaults(
  defineProps<{
    title: string
    /** 读屏文案：含期间与口径（由 ChartFrame 挂到 role="img" 的 aria-label）。 */
    chartLabel: string
    data: BarDatum[]
    /** 柱色：支出 / 收入由上层分段切换，故为单色。 */
    color: string
    /** 隐私遮挡：Y 轴刻度不出数值（柱形本身保留，读得出形状读不出金额）。 */
    masked?: boolean
    height?: number
    state?: 'ready' | 'loading' | 'empty' | 'error'
    emptyText?: string
    /** 类目多（逐日 30 柱）时收窄柱宽并留缝。 */
    dense?: boolean
  }>(),
  {
    masked: false,
    height: 220,
    state: 'ready',
    // 留空 → ChartFrame 回落 t('common.empty')，切语言即时跟随。
    emptyText: '',
    dense: false,
  },
)

const emit = defineEmits<{
  /** 柱子被点：给出类目序号，上层按下标回查数据。 */
  (event: 'pick', index: number): void
}>()

const el = ref<HTMLElement | null>(null)

let chart: EChartsInstance | null = null
let release: (() => void) | null = null
let observer: ResizeObserver | null = null
let rafId = 0
let disposed = false
let pending = false
let retryQueued = false
let lastWidth = 0
let lastHeight = 0

/** 统一四态类型：三个图表组件必须逐字一致（改一处就要改三处）。 */
type ChartState = 'ready' | 'loading' | 'empty' | 'error'

/**
 * 卡内错误：echarts 动态 import 失败（断网 / chunk 404）、init 失败、
 * option 构建抛错（聚合层少传 amount / 传了 NaN）都落到这里。
 *
 * 为什么必须有它：`ensureInstance` 里若没有 catch，异常只会冒到 Vue 的
 * errorHandler 打一条 console.error，而 `frameState` 仍是 `ready` ——
 * 用户看到的是一个 220px 的**空容器**，既没有图也没有文案，
 * 无法判断「这月没数据」还是「图表加载失败」。
 */
const localError = ref<string | null>(null)

/** 空数据合并进四态：上层不必自己判空，也不会画出「全为 0」的假图。 */
const frameState = computed<ChartState>(() => {
  // 页面态最权威：外部的 error / loading 不能被内部判空或内部错误覆盖。
  if (props.state !== 'ready') return props.state
  // 内部失败要盖掉「空数据」：断网绝不能被说成「暂无数据」。
  if (localError.value !== null) return 'error'
  return props.data.length === 0 ? 'empty' : 'ready'
})

/** 绘图区宽度：容器宽减左右内边距，用于计算 x 轴抽稀步长。 */
function currentPlotWidth(): number {
  const width = el.value?.clientWidth ?? 0
  return Math.max(0, width - GRID.left - GRID.right)
}

/** 整份 option 重建：色值只在 setOption 前一刻读取，切主题后不会停在旧色。 */
function applyOption(): void {
  if (chart === null) return
  const palette = getChartPalette(readThemeTokens())
  chart.setOption(
    buildBarOption({
      data: props.data,
      color: props.color,
      colors: {
        grid: palette.grid,
        ink: palette.ink,
        inkDeep: palette.inkDeep,
        expense: palette.expense,
        income: palette.income,
      },
      plotWidth: currentPlotWidth(),
      dense: props.dense,
      // 遮挡由 option 层落地（`yAxis.axisLabel.show = !masked`）。
      // 这里**不再**补第二次 setOption：隐私只能有一个出口，否则谁调一下
      // 这两行的相对顺序或改用 replaceMerge，遮挡态就会把刻度全漏出来。
      masked: props.masked,
    }),
    // notMerge：主题切换后必须清掉旧色残留。
    { notMerge: true },
  )
}

function handleClick(params: ECElementEvent): void {
  const index = params.dataIndex
  if (typeof index !== 'number' || !Number.isInteger(index)) return
  if (index < 0 || index >= props.data.length) return
  emit('pick', index)
}

/** 事件绑定只发生在新实例上，且卸载时用同一个函数引用 off 掉，避免重复绑定。 */
function bindEvents(): void {
  if (chart === null) return
  chart.on('click', handleClick)
}

function unbindEvents(): void {
  if (chart === null) return
  chart.off('click', handleClick)
}

function stopResize(): void {
  if (rafId !== 0) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
  observer?.disconnect()
  observer = null
}

function scheduleResize(): void {
  if (rafId !== 0) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    if (chart === null) return
    chart.resize()
    // 宽度变了，x 轴抽稀步长要重算，否则窄屏会重新重叠。
    applyOption()
  })
}

function startObserving(): void {
  const target = el.value
  if (target === null || typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver((entries) => {
    const entry = entries[0]
    if (entry === undefined) return
    const { width, height } = entry.contentRect
    if (width === lastWidth && height === lastHeight) return
    lastWidth = width
    lastHeight = height
    scheduleResize()
  })
  observer.observe(target)
}

/** 把任意抛出物折成可展示的文案（Error 取 message，其余 String 化）。 */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * watcher 路径的 option 应用入口。
 *
 * 为什么单独包一层：`buildBarOption` 在聚合层少传 `amount` / 传了 `NaN` 时会抛，
 * 而 watcher 里的异常同样只会落到 Vue errorHandler —— 卡片停在旧图或空白，
 * 一样是「静默失败」。catch 后回收实例并落到卡内 error 态。
 */
function guardedApplyOption(): void {
  try {
    applyOption()
  } catch (err) {
    teardown()
    localError.value = toMessage(err)
  }
}

/** 彻底回收实例与在册名额：`liveChartCount` 的 4 个上限会计入本图。 */
function teardown(): void {
  stopResize()
  unbindEvents()
  chart?.dispose()
  chart = null
  release?.()
  release = null
}

/**
 * await 期间状态又抖回 ready，本轮初始化已作废：下一帧补建一次。
 * 只在「确实发生过一次失效初始化」时排队，不会空转。
 */
function queueRetry(): void {
  if (retryQueued || disposed) return
  retryQueued = true
  void nextTick(() => {
    retryQueued = false
    if (disposed) return
    if (frameState.value === 'ready' && chart === null) void ensureInstance()
  })
}

async function ensureInstance(): Promise<void> {
  if (disposed || pending) return
  if (frameState.value !== 'ready') return
  if (chart !== null) return
  const target = el.value
  if (target === null) return

  pending = true
  try {
    const instance = await initChart(target)
    if (instance === null) {
      // 容器已从 DOM 摘除（initChart 内部已复检 isConnected）：交给下一次状态变化。
      return
    }
    if (disposed || frameState.value !== 'ready' || !target.isConnected) {
      instance.dispose()
      queueRetry()
      return
    }
    chart = instance
    release = acquireChart(props.title)
    lastWidth = target.clientWidth
    lastHeight = target.clientHeight
    bindEvents()
    // applyOption 必须在 try 内：option 构建抛错与 init 失败一样，都会让卡片空白。
    applyOption()
    startObserving()
  } catch (err) {
    // 断网 / chunk 404 / option 构建抛错：一律收成卡内 error 态。
    teardown()
    localError.value = toMessage(err)
    // 刻意**不** queueRetry：断网会变成无限重试，只能等页面重试或状态变化。
  } finally {
    pending = false
  }
}

onMounted(() => {
  void ensureInstance()
})

/**
 * option 输入签名。
 *
 * 为什么不用 `watch(() => [props.state, props.data, ...])`：
 * - 数组字面量每次求值都是新引用，Vue 的 `Object.is` 比较必然判定「变了」，
 *   父组件只要内联传数组（`:data="rows.map(...)"`）就会白跑一次
 *   `setOption(notMerge)`，还夹一次 `clientWidth` 强制布局；
 * - 反过来**原地**改 `data[i].amount` 不进 getter、不触发，图会静静停在旧值上。
 *
 * 用 `JSON.stringify` 全量序列化：不会像分隔符拼接那样被分类名里的 `#` / `|`
 * 撞出误判，也不会因为将来加字段而忘记同步拼进去。
 */
const optionKey = computed(() =>
  JSON.stringify([
    props.data.map((d) => [d.label, d.value, d.amount]),
    props.color,
    props.dense === true,
    props.masked === true,
  ]),
)

watch(themeEpoch, () => guardedApplyOption())

// 语言切换同样重建 option（命令式 option 不随模板重渲染自动刷新）。
watch(locale, () => guardedApplyOption())

// 顺序有意义：frameState 先建、且同为 post flush，保证「降级到空态」时先 teardown，
// 后面 optionKey 那条看到 chart === null 直接跳过，不会白跑一次 setOption。
watch(
  frameState,
  (current) => {
    if (current !== 'ready') {
      teardown()
      return
    }
    if (chart === null) {
      void ensureInstance()
      return
    }
    guardedApplyOption()
  },
  // flush: 'post'：等 slot 里的容器真正挂回 DOM 后再 init。
  { flush: 'post' },
)

watch(
  optionKey,
  () => {
    if (chart !== null) guardedApplyOption()
  },
  { flush: 'post' },
)

/**
 * 页面重试的清除时机：只有「从非 ready 重新进入 ready」才清掉内部错误。
 *
 * 为什么不跟着数据变化清：数据抖一下就把 error 抹掉再变回空白，用户会看到
 * 反复闪烁；错误必须是用户（或页面重试）显式解除的。
 */
watch(
  () => props.state,
  (now, prev) => {
    if (now === 'ready' && prev !== 'ready') localError.value = null
  },
)

onBeforeUnmount(() => {
  disposed = true
  teardown()
})
</script>

<template>
  <ChartFrame
    :title="title"
    :chart-label="chartLabel"
    :height="height"
    :state="frameState"
    :empty-text="emptyText"
  >
    <div ref="el" class="fb-bar" />
  </ChartFrame>
</template>

<style scoped>
.fb-bar {
  width: 100%;
  height: 100%;
}
</style>
