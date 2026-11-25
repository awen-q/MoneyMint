<script setup lang="ts">
/**
 * 折线图（收支双线 / 资产三线共用）。ECharts 5.6 + SVG renderer 的薄封装。
 *
 * 这个文件只做四件事，其余全在纯函数层：
 * 1. 生命周期：init → setOption → resize → dispose（**唯一允许 dispose 的地方**）
 * 2. 主题跟随：watch(themeEpoch) 后整份 option 重建 + notMerge
 * 3. 尺寸治理：ResizeObserver + rAF 合并（**永不注册 window.resize**）
 * 4. 在册计数：acquireChart / release，超过 4 个在 DEV 下告警
 *
 * 明确不做：不持有 DOM id（实例归组件所有）、不在模块加载期读 CSS 变量
 * （那样切主题后颜色永远停在首次取值）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { acquireChart, initChart, type EChartsInstance } from '@/core/charts/echarts'
import { GRID, buildLineOption, type LineSeriesInput } from '@/core/charts/option'
import { locale } from '@/i18n'
import { getChartPalette, readThemeTokens, themeEpoch } from '@/styles/themeTokens'

import ChartFrame from './ChartFrame.vue'

const props = withDefaults(
  defineProps<{
    title: string
    /** 读屏文案：含期间与口径。 */
    chartLabel: string
    labels: string[]
    series: LineSeriesInput[]
    note?: string
    commodity?: string
    /** 隐私遮挡：Y 轴不出数值，tooltip 出遮罩符。 */
    masked?: boolean
    height?: number
    /** PC（≥900px）占位高度；不传沿用 `height`（设计 `.chart-h` PC 240 / 移动 220）。 */
    wideHeight?: number
    state?: 'ready' | 'loading' | 'empty' | 'error'
    emptyText?: string
  }>(),
  {
    note: '',
    commodity: 'CNY',
    masked: false,
    height: 220,
    state: 'ready',
    // 留空 → ChartFrame 回落 t('common.empty')，切语言即时跟随。
    emptyText: '',
  },
)

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
 * 用户看到的是一个 220px 的**空容器**，既没有图也没有文案。
 */
const localError = ref<string | null>(null)

/** 有数据 = 有类目轴，且至少一条线带点。 */
const hasData = computed(
  () =>
    props.labels.length > 0 && props.series.some((s) => s.points.length > 0),
)

/**
 * 空数据降级为 `empty`，与 DonutChart / BarChart 同款。
 *
 * 为什么必须做：`ChartFrame` 的槽是 `v-if="state === 'ready'"`，若空序列一路以
 * `ready` 透传，`buildLineOption` 会生成空坐标系，而图例仍由 `props.series` 派生 →
 * 用户看到「空坐标轴 + 几条图例」，比「暂无数据」更像渲染坏了。
 *
 * 判据等价于「labels 空 或 没有任何一条线带点」：
 * - `labels` 为空 → 没有类目轴，画不出东西；
 * - 所有 `points` 都为空 → 有轴无点，同样是空图。
 * 反向约束：`points` 存在但值全为 0（资产清零年 / 某月零支出）属**合法数据**，
 * 必须照常画，所以判据只看 `points.length`，绝不看值。
 */
const frameState = computed<ChartState>(() => {
  // 页面态最权威：外部的 error / loading 不能被内部判空或内部错误覆盖。
  if (props.state !== 'ready') return props.state
  // 内部失败要盖掉「空数据」：断网绝不能被说成「暂无数据」。
  if (localError.value !== null) return 'error'
  return hasData.value ? 'ready' : 'empty'
})

/** 图例由 series 直接生成，色值与线条同源。 */
const legendItems = computed(() =>
  props.series.map((s) => ({ name: s.name, color: s.color, shape: 'line' as const })),
)

/** 绘图区宽度：容器宽减左右内边距，用于计算 x 轴抽稀步长。 */
function currentPlotWidth(): number {
  const width = el.value?.clientWidth ?? 0
  return Math.max(0, width - GRID.left - GRID.right)
}

function applyOption(): void {
  if (!chart) return
  const palette = getChartPalette(readThemeTokens())
  chart.setOption(
    buildLineOption({
      labels: props.labels,
      series: props.series,
      colors: {
        grid: palette.grid,
        ink: palette.ink,
        inkDeep: palette.inkDeep,
        expense: palette.expense,
        income: palette.income,
      },
      commodity: props.commodity,
      masked: props.masked,
      plotWidth: currentPlotWidth(),
    }),
    // notMerge：主题切换后必须清掉旧色残留，否则会留下一半旧色一半新色。
    { notMerge: true },
  )
}

function scheduleResize(): void {
  if (rafId !== 0) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    if (!chart) return
    chart.resize()
    // 宽度变了，x 轴抽稀步长要重算，否则窄屏会重新重叠。
    applyOption()
  })
}

function startObserving(): void {
  if (!el.value || typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver((entries) => {
    const entry = entries[0]
    if (!entry) return
    const { width, height } = entry.contentRect
    if (width === lastWidth && height === lastHeight) return
    lastWidth = width
    lastHeight = height
    scheduleResize()
  })
  observer.observe(el.value)
}

/** 把任意抛出物折成可展示的文案（Error 取 message，其余 String 化）。 */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * watcher 路径的 option 应用入口。
 *
 * 为什么单独包一层：`buildLineOption` 在聚合层少传 `amount` / 传了 `NaN` 时会抛，
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

function stopResize(): void {
  if (rafId !== 0) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
  observer?.disconnect()
  observer = null
}

/** 回收实例与在册名额：`liveChartCount` 的 4 个上限会计入本图。 */
function teardown(): void {
  stopResize()
  chart?.dispose()
  chart = null
  release?.()
  release = null
}

/**
 * await 期间 frameState 又抖回 ready，本轮初始化已作废：下一帧补建一次。
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

/**
 * 建实例的唯一入口。
 *
 * 为什么不能只放在 `onMounted`：`ChartFrame` 的槽是 `v-if="state === 'ready'"`，
 * 空态 / 错误态下 `el` 为 null 且 `<div ref="el">` 会被卸载；数据回来后槽重新挂载，
 * 但组件本身没有重新 mount，`onMounted` 不会再跑 —— 于是「先空态后 ready」永远画不出图。
 * 因此这里做成可重入的：`onMounted` 与 `watch(frameState)` 都调它。
 */
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
      // await 期间组件已卸载或已切到空态：不能把实例留在游离节点上。
      instance.dispose()
      queueRetry()
      return
    }
    chart = instance
    release = acquireChart(props.title)
    lastWidth = target.clientWidth
    lastHeight = target.clientHeight
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
 * 为什么不用 `watch(() => [props.labels, props.series, ...])`：
 * - 数组字面量每次求值都是新引用，Vue 的 `Object.is` 比较必然判定「变了」，
 *   父组件只要内联传数组（`:series="rows.map(...)"`）就会白跑一次
 *   `setOption(notMerge)`，还夹一次 `clientWidth` 强制布局；
 * - 反过来**原地**改 `series[0].points[0].amount` 不进 getter、不触发，
 *   图会静静停在旧值上 —— 这是更难发现的一半。
 *
 * 用 `JSON.stringify` 全量序列化：既不会像分隔符拼接那样被分类名里的
 * `#` / `|` 撞出误判，也不会因为将来加字段而忘记同步拼进去。
 * 体量上按 31 点 × 3 线算完全无感。
 */
const optionKey = computed(() =>
  JSON.stringify([
    props.labels,
    props.series.map((s) => [
      s.name,
      s.color,
      s.dashed === true,
      s.points.map((p) => [p.value, p.amount]),
    ]),
    props.masked === true,
    props.commodity,
  ]),
)

watch(themeEpoch, () => guardedApplyOption())

/**
 * 语言切换也重绘：系列名等 option 文本由父级用 t() 构造（命令式 option 不会因
 * 模板重渲染自动刷新），这里与 themeEpoch 同款显式重建整份 option。
 */
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
  // flush: 'post'：等 ChartFrame 的槽真正挂回 DOM、`el` 重建之后再 init。
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
    :note="note"
    :chart-label="chartLabel"
    :height="height"
    :wide-height="wideHeight"
    :state="frameState"
    :empty-text="emptyText"
    :legend="legendItems"
  >
    <div ref="el" class="fb-trend" />
  </ChartFrame>
</template>

<style scoped>
.fb-trend {
  width: 100%;
  height: 100%;
}
</style>
