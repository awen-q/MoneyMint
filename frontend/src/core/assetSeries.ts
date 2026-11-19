/**
 * 资产统计序列适配（B6 / T55，纯逻辑）
 *
 * 输入是服务端 `GET /api/assets/series` 的响应（**恒 12 个点**），输出是直接喂给
 * 图表与月度变化列表的结构。本模块**不发请求**（请求在页面/API 层），只做形状转换
 * 与环比计算 —— 这样它可以被单测覆盖，也符合「core 层零副作用」。
 *
 * 五条口径（错一条都不会报错，只会给出看着合理的错数字）：
 * 1. **`net` 不重算**：服务端已给 `assets + liabilities`，前端再算一遍就有两份口径；
 * 2. **金额是定点字符串**：本模块只搬运与比较，不 `parseFloat` 后再格式化；
 * 3. **环比变化额**用定点减法（`Money`），**变化占比**才允许转成数字（0~1，仅绘图/文案）；
 * 4. **首月（1 月）没有上月数据**：服务端只返回当年 12 个点，跨年无从推算 ——
 *    此时环比为 `null`（展示「—」），**不要**拿 0 当前值编一个 +∞ 或 100%；
 * 5. **点数不齐时补齐**：正常恒 12 个点，但若旧/异常响应少给，按月份键补齐为 `0.00`
 *    并保持顺序 —— 缺点的线会断，而断线看上去像「那几个月没资产」。
 */
import { Money } from './Money'
import type { AssetSeriesPoint, AssetSeriesResponse } from '../api/types'

/** 一个月度点（含环比）。 */
export interface AssetSeriesMonth {
  /** `YYYY-MM` */
  month: string
  /** 展示标签（`1月` … `12月`）。 */
  label: string
  assets: string
  liabilities: string
  /** 服务端给的 `assets + liabilities`，**原样搬运**。 */
  net: string
  /** 较上月总资产的变化额（定点串）；首月为 `null`。 */
  deltaAssets: string | null
  /** 较上月的变化占比（0~1，不是百分数）；上月为 0 或缺失时为 `null`。 */
  deltaRatio: number | null
}

/** 资产统计页所需的全部派生数据。 */
export interface AssetSeries {
  commodity: string
  year: number
  /** 恒 12 项，按 1..12 月顺序。 */
  months: AssetSeriesMonth[]
  /** 图表横轴标签。 */
  labels: string[]
  /** 三条线的定点串（与 labels 等长）。 */
  assets: string[]
  liabilities: string[]
  net: string[]
  /** 12 月末（年度末）三项，供卡头摘要。 */
  yearEnd: { assets: string; liabilities: string; net: string }
  /** 是否有任何非零金额（全 0 视为空态）。 */
  hasAnyValue: boolean
}

function moneyOf(amount: string): Money {
  try {
    return Money.from(amount)
  } catch {
    return Money.zero()
  }
}

function isZero(amount: string): boolean {
  return moneyOf(amount).isDisplayZero()
}

/** 展示标签：`1月` … `12月`（月号去前导零）。 */
function labelOf(index: number): string {
  return `${index + 1}月`
}

/**
 * 把服务端响应转成图表数据。
 *
 * @param response 服务端响应（`points` 可能不足 12 个，按月份键补齐）
 * @param year 年份（用于校验月份键与展示）
 */
export function buildAssetSeries(response: AssetSeriesResponse, year: number): AssetSeries {
  const byMonth: { [key: string]: AssetSeriesPoint } = {}
  for (const point of response.points) {
    // 只接受本年度的点：跨年脏数据混进来会让横轴与「1..12 月」错位。
    if (point.month.indexOf(`${year}-`) === 0) {
      byMonth[point.month] = point
    }
  }

  const months: AssetSeriesMonth[] = []
  let hasAnyValue = false
  let previousAssets: string | null = null

  for (let index = 0; index < 12; index += 1) {
    const monthKey = `${year}-${index + 1 < 10 ? '0' : ''}${index + 1}`
    const point = byMonth[monthKey]
    const assets = point === undefined ? '0.00' : point.assets
    const liabilities = point === undefined ? '0.00' : point.liabilities
    const net = point === undefined ? '0.00' : point.net

    if (!isZero(assets) || !isZero(liabilities) || !isZero(net)) {
      hasAnyValue = true
    }

    let deltaAssets: string | null = null
    let deltaRatio: number | null = null
    if (previousAssets !== null) {
      const delta = moneyOf(assets).minus(moneyOf(previousAssets))
      deltaAssets = delta.toString()
      const base = Number(previousAssets)
      // 上月为 0 时占比没有意义（除零）——给 null，让 UI 显示「—」，不要 Infinity。
      if (Number.isFinite(base) && base !== 0) {
        deltaRatio = Number(delta.toString()) / base
      }
    }

    months.push({
      month: monthKey,
      label: labelOf(index),
      assets,
      liabilities,
      net,
      deltaAssets,
      deltaRatio,
    })
    previousAssets = assets
  }

  const last = months[months.length - 1]
  return {
    commodity: response.commodity,
    year,
    months,
    labels: months.map((item) => item.label),
    assets: months.map((item) => item.assets),
    liabilities: months.map((item) => item.liabilities),
    net: months.map((item) => item.net),
    yearEnd: {
      assets: last === undefined ? '0.00' : last.assets,
      liabilities: last === undefined ? '0.00' : last.liabilities,
      net: last === undefined ? '0.00' : last.net,
    },
    hasAnyValue,
  }
}

/**
 * 空序列（12 个 `0.00` 点）：用于「尚未加载 / 加载失败」时保持图表形状不变，
 * 避免 `labels` 为空导致图表容器高度跳变（空态闪烁）。
 */
export function emptyAssetSeries(year: number, commodity: string): AssetSeries {
  return buildAssetSeries({ commodity, points: [] }, year)
}
