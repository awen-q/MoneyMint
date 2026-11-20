/**
 * 资产序列适配回归（B6 / T55）
 *
 * 每条都对应一条「不会报错但会给出错数字」的口径：
 * - `net` 原样搬运（不重算）；
 * - 首月环比为 `null`（不编 +∞ / 100%）；
 * - 上月为 0 时占比为 `null`（不 Infinity）；
 * - 点数不齐时补齐 12 个（断线会被读成「那几个月没资产」）；
 * - 跨年脏点被丢弃（否则横轴与「1..12 月」错位）。
 */
import { describe, expect, it } from 'vitest'

import { buildAssetSeries, emptyAssetSeries } from '@/core/assetSeries'
import { Money } from '@/core/Money'
import type { AssetSeriesResponse } from '@/api/types'

function response(points: Array<{ month: string; assets: string; liabilities: string; net: string }>): AssetSeriesResponse {
  return { commodity: 'CNY', points }
}

const FULL: AssetSeriesResponse = response([
  { month: '2026-01', assets: '1000.00', liabilities: '-400.00', net: '600.00' },
  { month: '2026-02', assets: '1200.00', liabilities: '-400.00', net: '800.00' },
  { month: '2026-03', assets: '1200.00', liabilities: '-500.00', net: '700.00' },
])

describe('buildAssetSeries：形状与三条线', () => {
  it('恒 12 个点，标签为 1月..12月，缺的月份补 0.00', () => {
    const series = buildAssetSeries(FULL, 2026)
    expect(series.months).toHaveLength(12)
    expect(series.labels).toEqual([
      '1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月',
    ])
    // 缺的月份由 0.00 补齐（不是 undefined / null）
    expect(series.months[5].assets).toBe('0.00')
    expect(series.assets).toHaveLength(12)
  })

  it('三条线金额原样搬运（定点串，不 parseFloat 再格式化）', () => {
    const series = buildAssetSeries(FULL, 2026)
    expect(series.assets.slice(0, 3)).toEqual(['1000.00', '1200.00', '1200.00'])
    expect(series.liabilities.slice(0, 3)).toEqual(['-400.00', '-400.00', '-500.00'])
    // net 必须等于服务端给的值（本用例刻意让它等于和，验证「不重算」时另有反例）
    expect(series.net.slice(0, 3)).toEqual(['600.00', '800.00', '700.00'])
  })

  it('net 原样搬运：服务端给了与 assets+liabilities 不同的值时不修正（防两份口径）', () => {
    // 刻意造一个「net ≠ assets + liabilities」的响应：前端若重算就会覆盖成 800.00
    const inconsistent = response([
      { month: '2026-01', assets: '1000.00', liabilities: '-400.00', net: '999.99' },
    ])
    expect(buildAssetSeries(inconsistent, 2026).net[0]).toBe('999.99')
  })

  it('跨年脏点被丢弃', () => {
    const dirty = response([
      { month: '2026-01', assets: '10.00', liabilities: '0.00', net: '10.00' },
      { month: '2025-12', assets: '9999.00', liabilities: '0.00', net: '9999.00' },
    ])
    const series = buildAssetSeries(dirty, 2026)
    expect(series.months).toHaveLength(12)
    expect(series.assets).not.toContain('9999.00')
    expect(series.assets[0]).toBe('10.00')
  })

  it('yearEnd 取 12 月末值', () => {
    const withDecember = response([
      { month: '2026-12', assets: '2000.00', liabilities: '-900.00', net: '1100.00' },
    ])
    const series = buildAssetSeries(withDecember, 2026)
    expect(series.yearEnd).toEqual({ assets: '2000.00', liabilities: '-900.00', net: '1100.00' })
  })

  it('hasAnyValue：全 0 为 false，任一非 0（含负数负债）为 true', () => {
    expect(buildAssetSeries(response([]), 2026).hasAnyValue).toBe(false)
    const liabilitiesOnly = response([
      { month: '2026-01', assets: '0.00', liabilities: '-100.00', net: '-100.00' },
    ])
    expect(buildAssetSeries(liabilitiesOnly, 2026).hasAnyValue).toBe(true)
  })
})

describe('buildAssetSeries：环比', () => {
  it('首月无上月数据 → delta 与占比都是 null（不编 +∞ / 100%）', () => {
    const series = buildAssetSeries(FULL, 2026)
    expect(series.months[0].deltaAssets).toBeNull()
    expect(series.months[0].deltaRatio).toBeNull()
  })

  it('次月起给定点差额与占比（占比是 0~1，不是百分数）', () => {
    const series = buildAssetSeries(FULL, 2026)
    // 1000 → 1200：+200.00，占比 0.2
    expect(series.months[1].deltaAssets).toBe('200.00')
    expect(series.months[1].deltaRatio).toBeCloseTo(0.2, 10)
    // 1200 → 1200：0.00，占比 0
    expect(series.months[2].deltaAssets).toBe('0.00')
    expect(series.months[2].deltaRatio).toBe(0)
  })

  it('上月为 0 时占比为 null（除零不能变成 Infinity）', () => {
    const series = buildAssetSeries(
      response([{ month: '2026-02', assets: '500.00', liabilities: '0.00', net: '500.00' }]),
      2026,
    )
    // 1 月是补齐的 0.00（作为 2 月的上月），故 2 月占比为 null
    expect(series.months[1].deltaAssets).toBe('500.00')
    expect(series.months[1].deltaRatio).toBeNull()
    expect(String(series.months[1].deltaRatio)).not.toContain('Infinity')
  })

  it('补齐的 0.00 月份：差额为 0.00，但占比仍为 null（上月为 0 不做除法）', () => {
    const series = buildAssetSeries(response([]), 2026)
    expect(series.months[1].deltaAssets).toBe('0.00')
    // 0 当分母没有意义：这里刻意返回 null（UI 显示「—」），而不是 0 或 Infinity
    expect(series.months[1].deltaRatio).toBeNull()
  })
})

describe('emptyAssetSeries', () => {
  it('12 个 0.00 点、无数据标记，用于加载中/失败时保持图形尺寸不跳', () => {
    const series = emptyAssetSeries(2026, 'CNY')
    expect(series.months).toHaveLength(12)
    expect(series.commodity).toBe('CNY')
    expect(series.hasAnyValue).toBe(false)
    for (const month of series.months) {
      expect(month.assets).toBe('0.00')
      expect(month.liabilities).toBe('0.00')
      expect(month.net).toBe('0.00')
    }
  })
})

/**
 * 稿子真实数据（原 v4.1 效果图 `ASSET_SNAP[2026]`，设计稿已随交付清退）。
 *
 * 原始表是「分」：`a` = 月末总资产（分，正），`l` = 月末负债（分，**正数存储**；
 * 端点契约里 liabilities 是**负数**，所以下面取负号）。有一个负净资产月
 * （1~11 月全部为负：房贷 40 万 > 金融资产），正好用来钉「不取 abs、负号保留」。
 *
 * 12 月：稿子表只到 11 月（模拟数据截至 2026-11-17）。真实端点的 12 月点由
 * `repository.BalancesByMonth` 逐月累计得出 —— 12 月的「次月 1 日日初」包含
 * 已发生的全部 11 月分录，所以无 12 月新分录时 12 月 ≡ 11 月。这里按同一口径
 * 补上（这也正是稿子页脚「11 月末 = 总资产 ¥315,590.00 / 负债 ¥388,550.00 /
 * 净资产 −¥72,960.00」那组数字）。
 */
const MOCK_CENTS_2026: Array<[number, number]> = [
  [27450000, 40055000], [27920000, 39935000], [28380000, 39815000],
  [28850000, 39695000], [29320000, 39575000], [29760000, 39455000],
  [30180000, 39335000], [30560000, 39215000], [30890000, 39095000],
  [31280000, 38975000], [31559000, 38855000], [31559000, 38855000],
]

/** 分 → 定点两位字符串（不带千分位：`Money` 的口径）。 */
function centsToFixed(value: number): string {
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

const REAL_2026: AssetSeriesResponse = response(
  MOCK_CENTS_2026.map(([assets, liabilities], index) => ({
    month: `2026-${String(index + 1).padStart(2, '0')}`,
    assets: centsToFixed(assets),
    liabilities: centsToFixed(-liabilities),
    net: centsToFixed(assets - liabilities),
  })),
)

describe('buildAssetSeries：稿子真实数据（2026 年，含负净资产）', () => {
  it('11 月末三项与稿子逐字一致：315590.00 / -388550.00 / -72960.00', () => {
    const series = buildAssetSeries(REAL_2026, 2026)
    const nov = series.months[10]
    expect(nov.month).toBe('2026-11')
    expect(nov.assets).toBe('315590.00')
    expect(nov.liabilities).toBe('-388550.00')
    // 稿子页脚写的「净资产 −¥72,960.00」：负号必须活到这里
    expect(nov.net).toBe('-72960.00')
  })

  it('负净资产不被 abs 掉（取绝对值会得到 72960.00 —— 那是「资产 7 万」的错信息）', () => {
    const series = buildAssetSeries(REAL_2026, 2026)
    expect(series.net[10]).not.toBe('72960.00')
    expect(series.net[10].startsWith('-')).toBe(true)
    // 负债同理：契约是负数，转正号就是把「欠 38 万」写成「有 38 万」
    expect(series.liabilities[10]).not.toBe('388550.00')
  })

  it('真实数据自洽：每个月 net 恒等于 assets + liabilities（定点相加，不经浮点）', () => {
    const series = buildAssetSeries(REAL_2026, 2026)
    for (const month of series.months) {
      const sum = Money.from(month.assets).plus(Money.from(month.liabilities))
      expect(sum.toString()).toBe(Money.from(month.net).toString())
    }
  })

  it('真实数据环比：10 月 → 11 月差额 2790.00，占比约 0.89%', () => {
    const series = buildAssetSeries(REAL_2026, 2026)
    // 31,559,000 − 31,280,000 = 279,000 分
    expect(series.months[10].deltaAssets).toBe('2790.00')
    expect(series.months[10].deltaRatio).toBeCloseTo(2790 / 312800, 10)
  })

  it('yearEnd 取 12 月（服务端口径下 = 11 月末，本年无 12 月分录）', () => {
    const series = buildAssetSeries(REAL_2026, 2026)
    expect(series.yearEnd.assets).toBe('315590.00')
    expect(series.yearEnd.liabilities).toBe('-388550.00')
    expect(series.yearEnd.net).toBe('-72960.00')
    // 有真实负值 → 不是空态（「全 0 才算空」不能把负净资产当空）
    expect(series.hasAnyValue).toBe(true)
  })
})
