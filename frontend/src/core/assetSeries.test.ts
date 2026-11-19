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
