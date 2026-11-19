/**
 * ECharts option 构建层（纯函数，零 DOM、零 Vue、零 echarts 运行时）。
 *
 * 为什么单独一层：option 是「数据 → 图表」的唯一翻译口。把它抽成纯函数，
 * 就能在 node 环境 100% 断言「喂给 ECharts 的到底是什么」，
 * 不必依赖 jsdom 里画不出来的 SVG。
 *
 * 三条铁律：
 * 1. **option 内零 hex**：颜色一律来自传入的 palette（`getChartPalette(readThemeTokens())`）。
 * 2. **金额展示绝不用 `value * 100` 反算**：data 项同时携带 `amount` 定点原串，
 *    tooltip 直接取串走 `formatMoney`。浮点还原在万元级就可能差 1 分。
 * 3. **隐私遮挡在这里落地**：`masked` 为真时 Y 轴不显示数值、tooltip 输出遮罩符。
 *    任何绕过本层自拼金额的图表都是第二条泄露路径。
 */
import type { EChartsCoreOption } from 'echarts/core'

import { formatCompact, formatMoney } from '@/core/Money'
import { PRIVACY_MASK } from '@/core/privacy'

/**
 * 绘图区内边距。三处图表共用一份，禁止各写一份 —— 一旦分叉，
 * 窄屏下坐标轴与数据必然错位。
 */
export const GRID = { left: 40, right: 12, top: 16, bottom: 28 } as const

/** x 轴单标签最小占宽（px）。3 字中文名旋转后仍需约 29px。 */
export const MIN_LABEL_PX = 30

/** 图表取色入参（子集，避免 option 层耦合整个 ThemeTokens）。 */
export interface ChartColors {
  grid: string
  ink: string
  inkDeep: string
  expense: string
  income: string
}

/** 单点：`value` 只用于几何，`amount` 才是展示真相。 */
export interface LinePoint {
  value: number
  amount: string
}

export interface LineSeriesInput {
  name: string
  points: LinePoint[]
  color: string
  dashed?: boolean
}

export interface BuildLineOptionInput {
  labels: string[]
  series: LineSeriesInput[]
  colors: ChartColors
  commodity?: string
  /** 隐私遮挡：Y 轴不显示数值、tooltip 与标签输出遮罩符。 */
  masked?: boolean
  /** 绘图区宽度（px），用于计算 x 轴抽稀步长。 */
  plotWidth?: number
  /** 当前选中列；其标签永远保留。 */
  selectedIndex?: number | null
}

/**
 * x 轴标签抽稀步长。
 *
 * 端点与选中列不受步长约束（见 `buildIntervalFilter`），否则用户点中的那根柱
 * 可能没有日期标签。
 */
export function labelStride(
  count: number,
  plotWidth: number,
  minLabelPx: number = MIN_LABEL_PX,
): number {
  if (count <= 1 || plotWidth <= 0) return 1
  const slot = plotWidth / count
  if (slot <= 0) return 1
  return Math.max(1, Math.ceil(minLabelPx / slot))
}

/** 生成 ECharts `axisLabel.interval` 回调：首末与选中必留，其余按步长取模。 */
export function buildIntervalFilter(
  count: number,
  stride: number,
  selectedIndex?: number | null,
): (index: number) => boolean {
  return (index: number): boolean => {
    if (index === 0 || index === count - 1) return true
    if (selectedIndex != null && index === selectedIndex) return true
    if (stride <= 1) return true
    return index % stride === 0
  }
}

interface TooltipParam {
  axisValueLabel?: string
  axisValue?: string
  seriesName?: string
  marker?: string
  data?: LinePoint
}

/**
 * Y 轴刻度文案。
 *
 * `formatCompact` 会把小于 1 的量按整数舍入：`0.25 → '0'`、`0.5 → '1'`、`0.75 → '1'`。
 * 于是 `[0, 0.25, 0.5, 0.75, 1]` 这一组刻度会显示成 `0 / 0 / 1 / 1 / 1` ——
 * 轴上读不出量级，还会把「0.5」误读成「1」（小额账本的柱图最容易踩）。
 *
 * 所以**不能**只兜 `text === '0'`（那样 0.5/0.75 照样错），量级 < 1 必须整体绕过
 * `formatCompact` 直接走小数：默认两位，`< 0.01` 时三位（「只有几毛钱流水」的极端
 * 情形兜底；四位小数在 10px 字号下已经读不出来）。
 *
 * 刻意**不改** `Money.formatCompact`：它被日历格复用，精度口径改动会外溢到
 * 与坐标轴完全无关的地方。这里是纯展示层兜底，只影响轴标签。
 */
export function formatAxisTick(value: number): string {
  if (value !== 0 && Math.abs(value) < 1) {
    return Math.abs(value) < 0.01 ? value.toFixed(3) : value.toFixed(2)
  }
  return formatCompact(String(value))
}

/** tooltip 内容：标题一行 + 每个系列一行，金额一律走定点串。 */
export function formatAxisTooltip(
  params: unknown,
  options: { commodity?: string; masked?: boolean } = {},
): string {
  const list = (Array.isArray(params) ? params : [params]) as TooltipParam[]
  if (list.length === 0) return ''

  const head = list[0].axisValueLabel ?? list[0].axisValue ?? ''
  const rows = list.map((item) => {
    const marker = item.marker ?? ''
    const name = item.seriesName ?? ''
    const amount = item.data?.amount

    let text: string
    if (options.masked) {
      // 遮挡态优先：有值也一律遮。
      text = PRIVACY_MASK
    } else if (amount === undefined) {
      // 明确「无数据」，**不是**零。
      // 兜成 '0.00' 会在聚合层漏传 amount 时凭空造出一个假金额，
      // 是本文件最不能接受的一种「静默错账」。
      if (import.meta.env.DEV) {
        console.warn('[chart] series 缺少 amount 字段：', name)
      }
      text = '—'
    } else {
      text = formatMoney(amount, options.commodity ?? '')
    }

    return `${marker}${name}　${text}`
  })

  return [head, ...rows].filter((line) => line !== '').join('<br/>')
}

/** 折线图 option（收支双线 / 资产三线共用）。 */export function buildLineOption(input: BuildLineOptionInput): EChartsCoreOption {
  const { labels, series, colors, commodity, masked = false } = input
  const count = labels.length
  const width = input.plotWidth ?? 0
  const stride = labelStride(count, width)
  const keepLabel = buildIntervalFilter(count, stride, input.selectedIndex)

  return {
    animation: false,
    grid: { ...GRID },
    tooltip: {
      // 触摸设备上必须显式 click：默认 'mousemove|click' 会让一次 tap
      // 同时走两条链，tooltip 闪两次。
      trigger: 'axis',
      triggerOn: 'click',
      confine: true,
      backgroundColor: colors.inkDeep,
      borderWidth: 0,
      textStyle: { color: colors.grid, fontSize: 12 },
      formatter: (params: unknown) =>
        formatAxisTooltip(params, { commodity, masked }),
    },
    xAxis: {
      type: 'category',
      data: labels,
      boundaryGap: false,
      axisLine: { lineStyle: { color: colors.grid } },
      axisTick: { show: false },
      axisLabel: {
        color: colors.ink,
        fontSize: 10,
        interval: keepLabel,
        hideOverlap: true,
      },
    },
    yAxis: {
      type: 'value',
      splitNumber: 4,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: colors.grid, type: 'dashed' } },
      axisLabel: {
        // 遮挡态隐藏刻度数值：保留趋势形状，不泄露任何金额。
        show: !masked,
        color: colors.ink,
        fontSize: 10,
        formatter: formatAxisTick,
      },
    },
    series: series.map((s) => ({
      type: 'line' as const,
      name: s.name,
      data: s.points.map((p) => ({ value: p.value, amount: p.amount })),
      showSymbol: false,
      smooth: false,
      lineStyle: {
        width: 2,
        color: s.color,
        type: s.dashed ? ('dashed' as const) : ('solid' as const),
      },
      itemStyle: { color: s.color },
      emphasis: { disabled: true },
    })),
  }
}

/** 环图扇区。 */
export interface DonutSlice {
  name: string
  /** 仅用于几何：决定扇区角度。 */
  value: number
  /** 金额定点原串：中心文字与下钻展示用它，**禁止由 value 反算**。 */
  amount: string
  color: string
}

export interface BuildDonutOptionInput {
  slices: DonutSlice[]
  /** 扇区间隙色，一般传纸面 `--fb-card`；不传则无间隙。 */
  paper?: string
  /**
   * 隐私遮挡。
   *
   * 为真时 data 项**不带 `amount` 字段**（而不是填遮罩符）：塞一串 `••••••`
   * 进 ECharts 数据，将来谁写个 formatter 就会把遮罩符当金额去格式化，
   * 比漏更怪。中心文字由组件 DOM 层负责显示 `PRIVACY_MASK`。
   */
  masked?: boolean
}

/**
 * 环图 option。
 *
 * **刻意不配 tooltip**：200px 高的环上，浮层正好盖住中心数值，而中心数值
 * 才是用户真正在读的东西。改用「中心文字随高亮变化」表达同样信息
 * （由组件的 DOM 覆盖层实现，顺带省掉 TitleComponent）。
 */
export function buildDonutOption(input: BuildDonutOptionInput): EChartsCoreOption {
  const { slices, paper, masked = false } = input
  return {
    animation: false,
    tooltip: { show: false },
    series: [
      {
        type: 'pie',
        radius: ['58%', '82%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: false,
        label: { show: false },
        labelLine: { show: false },
        itemStyle: paper === undefined ? {} : { borderWidth: 2, borderColor: paper },
        emphasis: { scale: true, scaleSize: 4 },
        data: slices.map((slice) => {
          const base = {
            value: slice.value,
            name: slice.name,
            itemStyle: { color: slice.color },
          }
          // 遮挡态不带 amount：ECharts 数据里不留任何金额原串。
          return masked ? base : { ...base, amount: slice.amount }
        }),
      },
    ],
  }
}

/** 柱状图的一根柱。 */
export interface BarDatum {
  label: string
  /** 仅用于几何：柱高。 */
  value: number
  /** 金额定点原串。 */
  amount: string
}

export interface BuildBarOptionInput {
  data: BarDatum[]
  /** 柱色（支出 / 收入由 seg 切换，故单色）。 */
  color: string
  colors: ChartColors
  plotWidth?: number
  selectedIndex?: number | null
  /** 类目多（逐日 30 柱）时收窄柱宽并留缝，避免糊成一条灰带。 */
  dense?: boolean
  /**
   * 隐私遮挡：Y 轴不显示刻度数值。
   *
   * 与 `buildLineOption` 同款口径（`show: !masked`），不是换成占位符：
   * 占位符会让 `***` 与真实数字混排，轴宽来回跳；整块隐藏则轴宽天然稳定。
   * 柱形本身保留 —— 读得出形状、读不出金额。
   */
  masked?: boolean
}

/**
 * 柱状图 option。
 *
 * **单击即下钻**，不做「二次 tap」：第一下没反应会被当成坏了（老板原话）。
 * 因此 tooltip 关闭 —— 否则一次 tap 会同时弹浮层又跳转。精确查值由同页
 * 「每日收支明细表」承担，图表只做概览入口。
 */
export function buildBarOption(input: BuildBarOptionInput): EChartsCoreOption {
  const { data, color, colors, dense = false, masked = false } = input
  const count = data.length
  const width = input.plotWidth ?? 0
  const stride = labelStride(count, width)
  const keepLabel = buildIntervalFilter(count, stride, input.selectedIndex)

  return {
    animation: false,
    grid: { ...GRID },
    tooltip: { show: false },
    xAxis: {
      type: 'category',
      data: data.map((d) => d.label),
      axisLine: { lineStyle: { color: colors.grid } },
      axisTick: { show: false },
      axisLabel: {
        color: colors.ink,
        fontSize: 10,
        interval: keepLabel,
        hideOverlap: true,
      },
    },
    yAxis: {
      type: 'value',
      splitNumber: 4,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: colors.grid, type: 'dashed' } },
      axisLabel: {
        // 遮挡态隐藏刻度数值：保留柱形，不泄露任何金额。
        show: !masked,
        color: colors.ink,
        fontSize: 10,
        formatter: formatAxisTick,
      },
    },
    series: [
      {
        type: 'bar',
        data: data.map((d) => ({ value: d.value, amount: d.amount })),
        barMaxWidth: dense ? 6 : 22,
        barCategoryGap: dense ? '40%' : '30%',
        itemStyle: { color, borderRadius: [3, 3, 0, 0] },
        emphasis: { disabled: true },
      },
    ],
  }
}
