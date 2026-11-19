import { describe, expect, it } from 'vitest'

import { PRIVACY_MASK } from '@/core/privacy'

import {
  GRID,
  buildBarOption,
  buildDonutOption,
  buildIntervalFilter,
  buildLineOption,
  formatAxisTick,
  formatAxisTooltip,
  labelStride,
  type BarDatum,
  type ChartColors,
  type DonutSlice,
  type LineSeriesInput,
} from './option'

/**
 * 占位色值：故意不用 hex —— 色值单一源门禁（styles/theme.guard.test.ts）
 * 会扫描全部源码，测试文件也不豁免。option 层只做「原样透传」，
 * 用任意字符串即可，反而更能证明「没有第二处色值来源」。
 */
const COLORS: ChartColors = {
  grid: 'palette-grid',
  ink: 'palette-ink',
  inkDeep: 'palette-ink-deep',
  expense: 'palette-expense',
  income: 'palette-income',
}

function series(amounts: string[]): LineSeriesInput {
  return {
    name: '支出',
    color: COLORS.expense,
    points: amounts.map((amount) => ({ value: Number(amount), amount })),
  }
}

/** 从 option 里取出所有字符串值，用于「零 hex」断言。 */
function collectStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node)
  } else if (Array.isArray(node)) {
    node.forEach((item) => collectStrings(item, out))
  } else if (node !== null && typeof node === 'object') {
    Object.values(node as Record<string, unknown>).forEach((v) => collectStrings(v, out))
  }
  return out
}

describe('labelStride 标签抽稀', () => {
  it('槽位够宽时不抽稀', () => {
    expect(labelStride(5, 300)).toBe(1)
    expect(labelStride(11, 400)).toBe(1)
  })

  it('30 天逐日在窄屏抽稀到 1/5 量级', () => {
    // 287px 绘图区 / 30 槽 = 9.6px 槽位，30px 最小占宽 → ceil(30/9.6) = 4
    expect(labelStride(30, 287)).toBe(4)
  })

  it('退化输入不除零、不返回 0', () => {
    expect(labelStride(0, 300)).toBe(1)
    expect(labelStride(1, 300)).toBe(1)
    expect(labelStride(10, 0)).toBe(1)
    expect(labelStride(10, -5)).toBe(1)
  })
})

describe('buildIntervalFilter 端点与选中必留', () => {
  it('首末永远保留', () => {
    const keep = buildIntervalFilter(30, 5, null)
    expect(keep(0)).toBe(true)
    expect(keep(29)).toBe(true)
    expect(keep(5)).toBe(true)
    expect(keep(7)).toBe(false)
  })

  it('选中列即使不在步长上也保留', () => {
    const keep = buildIntervalFilter(30, 5, 7)
    expect(keep(7)).toBe(true)
    expect(keep(12)).toBe(false)
  })

  it('步长为 1 时全显示', () => {
    const keep = buildIntervalFilter(6, 1, null)
    expect([0, 1, 2, 3, 4, 5].every(keep)).toBe(true)
  })
})

describe('formatAxisTooltip 金额展示', () => {
  it('正常态展示定点金额，不出现浮点尾巴', () => {
    const text = formatAxisTooltip(
      [
        {
          axisValueLabel: '2026-11-14',
          seriesName: '支出',
          marker: '●',
          data: { value: 153.31, amount: '153.31' },
        },
      ],
      { commodity: 'CNY' },
    )
    expect(text).toContain('2026-11-14')
    expect(text).toContain('153.31')
    expect(text).not.toContain('153.30999')
  })

  it('遮挡态不含任何明细金额', () => {
    const text = formatAxisTooltip(
      [
        {
          axisValueLabel: '14',
          seriesName: '支出',
          marker: '●',
          data: { value: 153.31, amount: '153.31' },
        },
      ],
      { commodity: 'CNY', masked: true },
    )
    // 遮罩符只能来自 core/privacy.ts 这一处：测试再写一遍字面量，
    // PRIVACY_MASK 就不再是单一来源，改占位符时测试会红在无关的地方。
    expect(text).toContain(PRIVACY_MASK)
    expect(text).not.toMatch(/\d+\.\d{2}/)
  })

  it('缺 amount 字段时显示 —，绝不兜成 0.00', () => {
    const text = formatAxisTooltip(
      [
        {
          axisValueLabel: '14',
          seriesName: '支出',
          marker: '●',
          // 聚合层漏传 amount：数据结构里只有几何量。
          data: { value: 153.31 } as unknown as { value: number; amount: string },
        },
      ],
      { commodity: 'CNY' },
    )
    expect(text).toContain('—')
    // 关键：不能凭空造出 0.00 —— 那是最危险的一种静默错账。
    expect(text).not.toContain('0.00')
  })

  it('缺 amount 且遮挡态：遮罩符优先（有值无值都遮）', () => {
    const text = formatAxisTooltip(
      [
        {
          axisValueLabel: '14',
          seriesName: '支出',
          data: { value: 1 } as unknown as { value: number; amount: string },
        },
      ],
      { masked: true },
    )
    expect(text).toContain(PRIVACY_MASK)
    expect(text).not.toContain('—')
  })

  it('空参数返回空串，不抛错', () => {
    expect(formatAxisTooltip([])).toBe('')
  })
})

describe('formatAxisTick 小额刻度', () => {
  it('小于 1 的刻度不塌成一排 0', () => {
    // [0, 0.25, 0.5, 0.75, 1] 若直接走 formatCompact 会变成 0/0/0/0/1。
    expect([0, 0.25, 0.5, 0.75, 1].map(formatAxisTick)).toEqual([
      '0',
      '0.25',
      '0.50',
      '0.75',
      '1',
    ])
  })

  it('不同刻度值的文案互不相同（防止轴上一排同样的字）', () => {
    const texts = [0, 0.25, 0.5, 0.75, 1].map(formatAxisTick)
    expect(new Set(texts).size).toBeGreaterThanOrEqual(3)
  })

  it('极小量级退到三位小数，量级足够时仍用简写', () => {
    expect(formatAxisTick(0.004)).toBe('0.004')
    expect(formatAxisTick(0.5)).toBe('0.50')
    expect(formatAxisTick(1200)).toBe('1.2k')
    expect(formatAxisTick(12000)).toBe('1.2w')
  })

  it('负的小额刻度保留符号', () => {
    expect(formatAxisTick(-0.5)).toBe('-0.50')
  })
})

describe('buildLineOption', () => {
  it('金额走 data.amount，不从 value 反算', () => {
    const option = buildLineOption({
      labels: ['1', '2'],
      series: [series(['0.07', '12345.67'])],
      colors: COLORS,
      commodity: 'CNY',
    })
    const data = (option.series as Array<{ data: Array<{ value: number; amount: string }> }>)[0]
      .data
    expect(data[0].amount).toBe('0.07')
    expect(data[1].amount).toBe('12345.67')
  })

  it('遮挡态：Y 轴刻度隐藏，但趋势线仍渲染', () => {
    const option = buildLineOption({
      labels: ['1', '2'],
      series: [series(['1.00', '2.00'])],
      colors: COLORS,
      masked: true,
    })
    const yAxis = option.yAxis as { axisLabel: { show: boolean } }
    expect(yAxis.axisLabel.show).toBe(false)
    expect((option.series as unknown[]).length).toBe(1)
  })

  it('非遮挡态显示 Y 轴刻度，且用 formatCompact 缩写', () => {
    const option = buildLineOption({
      labels: ['1'],
      series: [series(['100.00'])],
      colors: COLORS,
    })
    const yAxis = option.yAxis as {
      axisLabel: { show: boolean; formatter: (v: number) => string }
    }
    expect(yAxis.axisLabel.show).toBe(true)
    expect(yAxis.axisLabel.formatter(12000)).toBe('1.2w')
    expect(yAxis.axisLabel.formatter(1200)).toBe('1.2k')
  })

  it('tooltip 在触摸端用 click 触发，且 confine 防越界', () => {
    const option = buildLineOption({
      labels: ['1'],
      series: [series(['1.00'])],
      colors: COLORS,
    })
    const tooltip = option.tooltip as { triggerOn: string; confine: boolean; trigger: string }
    expect(tooltip.trigger).toBe('axis')
    expect(tooltip.triggerOn).toBe('click')
    expect(tooltip.confine).toBe(true)
  })

  it('grid 与本文件 GRID 单点常量一致', () => {
    const option = buildLineOption({
      labels: ['1'],
      series: [series(['1.00'])],
      colors: COLORS,
    })
    expect(option.grid).toEqual({ ...GRID })
  })

  it('option 内除传入色值外不出现任何 hex 字面量', () => {
    const option = buildLineOption({
      labels: ['1', '2'],
      series: [series(['1.00', '2.00'])],
      colors: COLORS,
      commodity: 'CNY',
    })
    const allowed = new Set(Object.values(COLORS))
    const hexes = collectStrings(option).filter((s) => /^#[0-9a-fA-F]{3,8}$/.test(s))
    expect(hexes.every((hex) => allowed.has(hex))).toBe(true)
  })

  it('空系列不抛错', () => {
    const option = buildLineOption({ labels: [], series: [], colors: COLORS })
    expect(option.series).toEqual([])
  })
})

/* ------------------------------------------------------------------------- *
 * 环图 / 柱图：断言口径与折线保持完全一致 ——
 * 金额只认 `data[i].amount` 定点原串、tooltip 一律关闭、色值只做原样透传。
 * ------------------------------------------------------------------------- */

/** 占位纸面色：同样不写 hex，用来证明 option 层没有第二处色值来源。 */
const PAPER = 'palette-paper'

function donutSlices(count: number): DonutSlice[] {
  const slices: DonutSlice[] = []
  for (let i = 0; i < count; i += 1) {
    slices.push({
      name: `分类-${i}`,
      value: i + 1,
      amount: `${i + 1}.00`,
      color: `palette-pie-${i}`,
    })
  }
  return slices
}

interface DonutSeriesShape {
  type: string
  itemStyle: { borderWidth?: number; borderColor?: string }
  data: Array<{
    name: string
    value: number
    amount: string
    itemStyle: { color: string }
  }>
}

/** 取出环图唯一的一条 series（形状断言集中在这里，其余用例只读字段）。 */
function firstDonutSeries(option: unknown): DonutSeriesShape {
  const holder = option as { series?: DonutSeriesShape[] }
  const first = holder.series?.[0]
  if (first === undefined) {
    throw new Error('环图 option 缺少 series[0]')
  }
  return first
}

describe('buildDonutOption', () => {
  it('空 slices 不抛错，仍是单条空 series', () => {
    const option = buildDonutOption({ slices: [] })
    const series = firstDonutSeries(option)
    expect(series.type).toBe('pie')
    expect(series.data).toEqual([])
  })

  it('空 slices 且 paper + masked 同时给：结构仍合法', () => {
    // B4 双环卡的「空月份」边界：组件层会降级 empty，但 option 必须结构合法。
    const series = firstDonutSeries(
      buildDonutOption({ slices: [], paper: PAPER, masked: true }),
    )
    expect(series.data).toEqual([])
    expect(series.itemStyle.borderColor).toBe(PAPER)
  })

  it('单扇区：几何、名称、色值、金额全部原样透传', () => {
    const slices = donutSlices(1)
    const option = buildDonutOption({ slices })
    const data = firstDonutSeries(option).data
    expect(data.length).toBe(1)
    expect(data[0].name).toBe('分类-0')
    expect(data[0].value).toBe(1)
    expect(data[0].amount).toBe('1.00')
    expect(data[0].itemStyle.color).toBe('palette-pie-0')
  })

  it('10 扇区：data[i].amount 原样保留，不从 value 反算', () => {
    const slices = donutSlices(10)
    const option = buildDonutOption({ slices })
    const data = firstDonutSeries(option).data
    expect(data.length).toBe(10)
    for (let i = 0; i < slices.length; i += 1) {
      expect(data[i].amount).toBe(slices[i].amount)
    }
    // 定点串必须逐字保留：`value` 只负责几何，反算会在万元级差 1 分。
    expect(data[9].amount).toBe('10.00')
  })

  it('tooltip 关闭（中心数值由 DOM 覆盖层承担，浮层会盖住它）', () => {
    const option = buildDonutOption({ slices: donutSlices(3) })
    const tooltip = option.tooltip as { show: boolean }
    expect(tooltip.show).toBe(false)
  })

  it('paper 传入时作为扇区间隙色，不传则不带 borderColor', () => {
    const withPaper = firstDonutSeries(
      buildDonutOption({ slices: donutSlices(3), paper: PAPER }),
    )
    expect(withPaper.itemStyle.borderColor).toBe(PAPER)
    expect(withPaper.itemStyle.borderWidth).toBe(2)

    const withoutPaper = firstDonutSeries(buildDonutOption({ slices: donutSlices(3) }))
    expect(withoutPaper.itemStyle.borderColor).toBeUndefined()
  })

  it('遮挡态：data 项不带 amount 字段（不是填遮罩符）', () => {
    const slices = donutSlices(3)
    const data = firstDonutSeries(buildDonutOption({ slices, masked: true })).data
    for (const item of data) {
      // 关键：字段**不存在**，而不是 '••••••' —— 否则将来谁写 formatter
      // 就会把遮罩符当金额去格式化。
      expect('amount' in item).toBe(false)
      // 几何量与名称仍需保留，否则扇区画不出来、点不出名字。
      expect(typeof item.value).toBe('number')
      expect(item.name.length).toBeGreaterThan(0)
    }
  })

  it('非遮挡态仍带 amount（展示真相不能丢）', () => {
    const data = firstDonutSeries(buildDonutOption({ slices: donutSlices(2) })).data
    expect(data[0].amount).toBe('1.00')
  })
})

/**
 * 柱图 fixture。
 *
 * ⚠️ `value` 必须由 `amount` 派生（`value = Number(amount)`），不能另写一个数：
 * 早先这里写成 `value: i + 0.5` 配 `amount: '${i + 1}.50'`，两者本来就不同口径
 * （i=0 时 0.5 vs 1.50），于是所有结构断言都不可能发现 value/amount 被互换。
 */
function barData(count: number): BarDatum[] {
  const data: BarDatum[] = []
  for (let i = 0; i < count; i += 1) {
    const amount = `${i + 1}.50`
    data.push({
      label: `12-${i + 1}`,
      value: Number(amount),
      amount,
    })
  }
  return data
}

interface BarSeriesShape {
  barMaxWidth: number
  barCategoryGap: string
  itemStyle: { color: string; borderRadius: number[] }
  data: Array<{ value: number; amount: string }>
}

function firstBarSeries(option: unknown): BarSeriesShape {
  const holder = option as { series?: BarSeriesShape[] }
  const first = holder.series?.[0]
  if (first === undefined) {
    throw new Error('柱图 option 缺少 series[0]')
  }
  return first
}

describe('buildBarOption', () => {
  it('dense=true 时柱宽收窄且留缝', () => {
    const series = firstBarSeries(
      buildBarOption({ data: barData(30), color: 'palette-bar', colors: COLORS, dense: true }),
    )
    expect(series.barMaxWidth).toBe(6)
    expect(series.barCategoryGap).toBe('40%')
  })

  it('dense=false（含不传）时柱宽 22', () => {
    const explicit = firstBarSeries(
      buildBarOption({ data: barData(7), color: 'palette-bar', colors: COLORS, dense: false }),
    )
    expect(explicit.barMaxWidth).toBe(22)
    expect(explicit.barCategoryGap).toBe('30%')

    const implicit = firstBarSeries(
      buildBarOption({ data: barData(7), color: 'palette-bar', colors: COLORS }),
    )
    expect(implicit.barMaxWidth).toBe(22)
  })

  it('tooltip 关闭（一次 tap 只做下钻，不弹浮层）', () => {
    const option = buildBarOption({
      data: barData(7),
      color: 'palette-bar',
      colors: COLORS,
    })
    const tooltip = option.tooltip as { show: boolean }
    expect(tooltip.show).toBe(false)
  })

  it('30 类目抽稀后首末标签必留，且与 buildIntervalFilter 行为逐项一致', () => {
    const data = barData(30)
    const plotWidth = 287
    const option = buildBarOption({
      data,
      color: 'palette-bar',
      colors: COLORS,
      plotWidth,
    })
    const xAxis = option.xAxis as { axisLabel: { interval: (index: number) => boolean } }
    const keep = xAxis.axisLabel.interval

    // 端点必留：末位 29 若只按模运算（29 % 4）会被抽掉，这里能证明端点规则生效。
    expect(keep(0)).toBe(true)
    expect(keep(29)).toBe(true)
    expect(keep(7)).toBe(false)

    const expected = buildIntervalFilter(30, labelStride(30, plotWidth), null)
    for (let i = 0; i < data.length; i += 1) {
      expect(keep(i)).toBe(expected(i))
    }
  })

  it('borderRadius 只圆上两角', () => {
    const series = firstBarSeries(
      buildBarOption({ data: barData(3), color: 'palette-bar', colors: COLORS }),
    )
    expect(series.itemStyle.borderRadius).toEqual([3, 3, 0, 0])
    expect(series.itemStyle.color).toBe('palette-bar')
  })

  it('data[i].amount 原样保留，不从 value 反算', () => {
    const data = barData(4)
    const option = buildBarOption({
      data,
      color: 'palette-bar',
      colors: COLORS,
    })
    const series = firstBarSeries(option).data
    for (let i = 0; i < data.length; i += 1) {
      expect(series[i].amount).toBe(data[i].amount)
    }
    expect(series[3].amount).toBe('4.50')
  })

  it('遮挡态：Y 轴刻度整块隐藏（与折线同款 show: !masked）', () => {
    const masked = buildBarOption({
      data: barData(7),
      color: 'palette-bar',
      colors: COLORS,
      masked: true,
    })
    const maskedAxis = masked.yAxis as { axisLabel: { show: boolean } }
    expect(maskedAxis.axisLabel.show).toBe(false)

    const open = buildBarOption({
      data: barData(7),
      color: 'palette-bar',
      colors: COLORS,
    })
    const openAxis = open.yAxis as { axisLabel: { show: boolean } }
    expect(openAxis.axisLabel.show).toBe(true)
  })

  it('遮挡态仍保留柱形几何（读得出形状，读不出金额）', () => {
    const data = barData(5)
    const series = firstBarSeries(
      buildBarOption({
        data,
        color: 'palette-bar',
        colors: COLORS,
        masked: true,
      }),
    )
    expect(series.data.length).toBe(5)
    expect(series.barMaxWidth).toBe(22)
  })

  it('空 data：结构仍合法（空类目轴 + 空 series，不抛错）', () => {
    // B4 统计页的「空月份」会真的走到这条：上下钻切换时某一侧可能没有数据，
    // 组件层已把它降级为 empty 不建实例，但 option 作为纯函数仍必须结构合法。
    const option = buildBarOption({
      data: [],
      color: 'palette-bar',
      colors: COLORS,
      plotWidth: 287,
    })
    const xAxis = option.xAxis as {
      data: string[]
      axisLabel: { interval: (index: number) => boolean }
    }
    expect(xAxis.data).toEqual([])
    expect(firstBarSeries(option).data).toEqual([])
    // 空类目下抽稀回调被调用时不能抛（ECharts 会以 0 试探一次）。
    expect(() => xAxis.axisLabel.interval(0)).not.toThrow()
  })

  it('空 data + 遮挡态：三态开关同时成立也不抛错', () => {
    const series = firstBarSeries(
      buildBarOption({
        data: [],
        color: 'palette-bar',
        colors: COLORS,
        masked: true,
        dense: true,
      }),
    )
    expect(series.data).toEqual([])
    expect(series.barMaxWidth).toBe(6)
  })
})

/**
 * 勾稽：`value`（几何量）与 `amount`（展示真相）必须同口径。
 *
 * 为什么单列：34 条结构断言全绿也发现不了「两者互换」—— 例如
 * `value: i + 0.5` 配 `amount: '${i + 1}.50'`，谁都测不出来。
 * 真实数据里 `value = Number(amount)`，一旦漂移就是「柱高与金额不符」的静默错账。
 */
describe('value 与 amount 同口径勾稽', () => {
  it('柱图：每个 datum 的 value 等于其 amount 的数值', () => {
    const rows: BarDatum[] = Array.from({ length: 30 }, (_, i) => ({
      label: `11-${i + 1}`,
      value: Number(`${i + 1}.50`),
      amount: `${i + 1}.50`,
    }))
    const series = firstBarSeries(
      buildBarOption({ data: rows, color: 'palette-bar', colors: COLORS }),
    )
    series.data.forEach((d) => {
      expect(d.value).toBe(Number(d.amount))
    })
  })

  it('折线：每个点的 value 与 amount 同口径（元），且金额是两位定点串', () => {
    const amounts = ['0.07', '12345.67', '1000.00']
    const option = buildLineOption({
      labels: ['a', 'b', 'c'],
      series: [
        {
          name: '支出',
          color: COLORS.expense,
          points: amounts.map((amount) => ({ value: Number(amount), amount })),
        },
      ],
      colors: COLORS,
    })
    const data = (option.series as Array<{ data: Array<{ value: number; amount: string }> }>)[0]
      .data
    data.forEach((d) => {
      expect(d.amount).toMatch(/^-?\d+\.\d{2}$/)
      // 分/元混用（例如把 12345.67 元塞成 1234567 分）会在这里立刻炸。
      expect(d.value).toBe(Number(d.amount))
    })
  })

  it('点集 amount 求和等于数据源总额', () => {
    const amounts = ['12.34', '0.66', '1000.00']
    const option = buildLineOption({
      labels: ['a', 'b', 'c'],
      series: [series(amounts)],
      colors: COLORS,
    })
    const data = (option.series as Array<{ data: Array<{ amount: string }> }>)[0].data
    const sum = data.reduce((acc, d) => acc + Number(d.amount), 0)
    expect(sum).toBeCloseTo(1013.0, 2)
  })
})

