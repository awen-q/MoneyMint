<script setup lang="ts">
/**
 * 环图（支出 / 收入构成）。ECharts 5.6 + SVG renderer 的薄封装。
 *
 * 与 TrendChart 同构：生命周期只在这里落地（init → setOption → resize → dispose），
 * 几何与取色全部来自纯函数层 `@/core/charts/option`。
 *
 * 三个刻意的设计决策：
 * 1. **无 tooltip**（option 层已 `tooltip.show=false`）。200px 高的环上，浮层正好
 *    盖住中心数值，而中心数值才是用户真正在读的东西 —— 改用「中心文字随高亮变化」
 *    表达同样的信息，且省掉 TitleComponent 的注册体积。
 * 2. **中心文字走 DOM 覆盖层**，不注册 TitleComponent：字体跟随系统、能被读屏、
 *    切主题无需重建实例（颜色直接吃 CSS 变量）。
 * 3. **单击即下钻**：`params.dataIndex` 是 ECharts 给出的权威索引，不做二次 tap、
 *    不加任何绝对定位的命中层（命中层会抢走 ECharts 的手势）。
 *
 * 空数据：`slices` 为空时把四态降级为 `empty`，不建实例（画一个空环等于告诉用户
 * 「这个月没花钱」，是静默错账里最危险的一种）。
 */
import type { ECElementEvent } from 'echarts/core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { formatMoney } from '@/core/Money'
import { acquireChart, initChart, type EChartsInstance } from '@/core/charts/echarts'
import { buildDonutOption, type DonutSlice } from '@/core/charts/option'
import { PRIVACY_MASK } from '@/core/privacy'
import { readThemeTokens, themeEpoch } from '@/styles/themeTokens'

import ChartFrame from './ChartFrame.vue'

const props = withDefaults(
  defineProps<{
    title: string
    /** 读屏文案：含期间与口径（由 ChartFrame 挂到 role="img" 的 aria-label）。 */
    chartLabel: string
    slices: DonutSlice[]
    /** 中心默认标题，如「合计」。 */
    centerText?: string
    /** 中心默认金额：定点十进制原串，**禁止由 value 反算**。 */
    centerValue?: string
    /**
     * 币种（`'CNY'` / `'USD'` / …）。
     *
     * 默认空串 = 不带币种符号，与不传该 prop 的旧调用方行为完全一致（严格 additive）。
     * 页面必须把 `period.stats.commodity` 这一个值同时喂给「聚合过滤 / MoneyText /
     * 图表中心」，否则会出现「环图按美元、主金额按人民币」的口径分裂。
     */
    commodity?: string
    /** 隐私遮挡：中心金额与高亮金额都输出遮罩符。 */
    masked?: boolean
    height?: number
    state?: 'ready' | 'loading' | 'empty' | 'error'
    emptyText?: string
  }>(),
  {
    centerText: '合计',
    centerValue: '0.00',
    commodity: '',
    masked: false,
    height: 200,
    state: 'ready',
    emptyText: '暂无数据',
  },
)

const emit = defineEmits<{
  /** 扇区被点：给出序号，同时把该扇区数据一并带出，上层不必再按下标回查。 */
  (event: 'pick', index: number, slice: DonutSlice): void
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

/** 当前高亮扇区序号；null 表示未悬停，中心回落到默认文案。 */
const hoverIndex = ref<number | null>(null)

/** 统一四态类型：三个图表组件必须逐字一致（改一处就要改三处）。 */
type ChartState = 'ready' | 'loading' | 'empty' | 'error'

/**
 * 卡内错误：echarts 动态 import 失败（断网 / chunk 404）、init 失败、
 * option 构建抛错（聚合层少传 amount / 传了 NaN）都落到这里。
 *
 * 为什么必须有它：`ensureInstance` 里若没有 catch，异常只会冒到 Vue 的
 * errorHandler 打一条 console.error，而 `frameState` 仍是 `ready` ——
 * 用户看到的是一个 200px 的**空容器**，既没有环也没有文案。
 */
const localError = ref<string | null>(null)

/** 空数据合并进四态：上层不必自己判空，也不会画出空环。 */
const frameState = computed<ChartState>(() => {
  // 页面态最权威：外部的 error / loading 不能被内部判空或内部错误覆盖。
  if (props.state !== 'ready') return props.state
  // 内部失败要盖掉「空数据」：断网绝不能被说成「暂无数据」。
  if (localError.value !== null) return 'error'
  return props.slices.length === 0 ? 'empty' : 'ready'
})

/** 当前悬停的扇区；越界 / 未悬停一律 null（防止热更新期间下标失配）。 */
const hoveredSlice = computed<DonutSlice | null>(() => {
  const index = hoverIndex.value
  if (index === null) return null
  if (index < 0 || index >= props.slices.length) return null
  return props.slices[index] ?? null
})

/** 占比分母：只用于读数，不参与任何金额计算。 */
const totalValue = computed(() =>
  props.slices.reduce((sum, slice) => {
    const value = Number(slice.value)
    return Number.isFinite(value) ? sum + value : sum
  }, 0),
)

const centerLabel = computed(() => hoveredSlice.value?.name ?? props.centerText)

/** 中心金额：优先高亮扇区的定点原串，绝不从 `value` 浮点反算。 */
const centerAmount = computed(() => hoveredSlice.value?.amount ?? props.centerValue)

const centerDisplay = computed(() =>
  props.masked ? PRIVACY_MASK : formatMoney(centerAmount.value, props.commodity),
)

/** 高亮时补一行占比；遮挡态不隐藏它 —— 百分比不是金额，遮了反而看不出结构。 */
const centerShare = computed(() => {
  const slice = hoveredSlice.value
  if (slice === null) return ''
  const total = totalValue.value
  if (!(total > 0)) return ''
  const value = Number(slice.value)
  if (!Number.isFinite(value)) return ''
  return `${((value / total) * 100).toFixed(1)}%`
})

/**
 * 中心文字盒尺寸。
 *
 * 环内孔直径约等于 `0.58 × min(宽, 高)`，而高度由 `props.height` 固定，
 * 因此用高度换算出方形盒就能保证文字不压到环带上（CSS 无法对容器两轴取 min）。
 */
const centerBox = computed(() => {
  const size = Math.max(0, Math.round(props.height * 0.56))
  return { width: `${size}px`, height: `${size}px` }
})

/** 整份 option 重建：色值只在 setOption 前一刻读取，切主题后不会停在旧色。 */
function applyOption(): void {
  if (chart === null) return
  const tokens = readThemeTokens()
  chart.setOption(
    // 遮挡由 option 层落地：masked 时 data 项不带 amount，
    // ECharts 数据里不留任何金额原串（中心文字的遮罩由本组件的 DOM 层负责）。
    buildDonutOption({
      slices: props.slices,
      paper: tokens.card,
      masked: props.masked,
    }),
    // notMerge：主题切换后必须清掉旧色残留。
    { notMerge: true },
  )
}

function handleClick(params: ECElementEvent): void {
  const index = params.dataIndex
  if (typeof index !== 'number' || !Number.isInteger(index)) return
  if (index < 0 || index >= props.slices.length) return
  const slice = props.slices[index]
  if (slice === undefined) return
  emit('pick', index, slice)
}

function handleOver(params: ECElementEvent): void {
  const index = params.dataIndex
  if (typeof index !== 'number' || !Number.isInteger(index)) return
  if (index < 0 || index >= props.slices.length) return
  hoverIndex.value = index
}

function handleOut(): void {
  hoverIndex.value = null
}

/** 事件绑定只发生在新实例上，且卸载时用同一个函数引用 off 掉，避免重复绑定。 */
function bindEvents(): void {
  if (chart === null) return
  chart.on('click', handleClick)
  chart.on('mouseover', handleOver)
  chart.on('mouseout', handleOut)
}

function unbindEvents(): void {
  if (chart === null) return
  chart.off('click', handleClick)
  chart.off('mouseover', handleOver)
  chart.off('mouseout', handleOut)
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
    // 环图半径按百分比算，resize 后无需重算 option。
    chart?.resize()
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
 * 为什么单独包一层：`buildDonutOption` 在聚合层少传 `amount` / 传了 `NaN` 时会抛，
 * 而 watcher 里的异常同样只会落到 Vue errorHandler —— 卡片停在旧环或空白，
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
  hoverIndex.value = null
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
    hoverIndex.value = null
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
 * 为什么不用 `watch(() => [props.state, props.slices])`：
 * - 数组字面量每次求值都是新引用，Vue 的 `Object.is` 比较必然判定「变了」，
 *   父组件只要内联传数组（`:slices="rows.map(...)"`）就会白跑一次
 *   `setOption(notMerge)`；
 * - 反过来**原地**改 `slices[i].amount` 不进 getter、不触发，环图会停在旧值上。
 *
 * 用 `JSON.stringify` 全量序列化：不会像分隔符拼接那样被分类名里的 `#` / `|`
 * 撞出误判，也不会因为将来加字段而忘记同步拼进去。`masked` 也必须在签名里 ——
 * 它现在会影响 option（遮挡态 data 不带 amount）。
 */
const optionKey = computed(() =>
  JSON.stringify([
    props.slices.map((s) => [s.name, s.value, s.amount, s.color]),
    props.masked === true,
  ]),
)

watch(themeEpoch, () => guardedApplyOption())

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
    // 数据变了，旧的高亮下标可能已失配，先归位再重画。
    hoverIndex.value = null
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
    <div class="fb-donut">
      <div ref="el" class="fb-donut__canvas" />
      <!-- 中心覆盖层：纯展示，pointer-events:none，命中与手势全部交给 ECharts。 -->
      <div class="fb-donut__center" :style="centerBox" aria-hidden="true">
        <span class="fb-donut__label">{{ centerLabel }}</span>
        <strong class="fb-donut__value">{{ centerDisplay }}</strong>
        <span v-if="centerShare" class="fb-donut__share">{{ centerShare }}</span>
      </div>
    </div>
  </ChartFrame>
</template>

<style scoped>
.fb-donut {
  position: relative;
  width: 100%;
  height: 100%;
}

.fb-donut__canvas {
  width: 100%;
  height: 100%;
}

.fb-donut__center {
  position: absolute;
  top: 50%;
  left: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  transform: translate(-50%, -50%);
  /* 关键：绝不吞掉手势，否则扇区点不中。 */
  pointer-events: none;
  text-align: center;
}

.fb-donut__label {
  font-size: 11px;
  line-height: 1.2;
  color: var(--fb-sub);
}

.fb-donut__value {
  font-size: 14px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--fb-ink);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.fb-donut__share {
  font-size: 10px;
  line-height: 1.2;
  color: var(--fb-sub);
  font-variant-numeric: tabular-nums;
}
</style>
