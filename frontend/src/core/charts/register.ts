/**
 * ECharts 注册表 —— **必须是静态命名导入**，这是体积门禁的关键一环。
 *
 * 为什么不能直接动态 import barrel：
 * `import('echarts/charts')` 拿到的是**命名空间对象**，rollup 无法判定调用方只用
 * 了哪几个导出，于是整个 barrel 全量保留 —— 实测 336.19 KB gzip。
 * 反过来把 `import(...)` 换成逐个 `await`、或解构后只取 `.LineChart`，产物 hash
 * 与体积完全不变（260.02 KB），**锅在 barrel 而不在解构方式**。
 *
 * 正解：本模块用静态具名导入只 `use()` 需要的成员，再由 `echarts.ts` 动态
 * `import('./register')` 懒加载本模块本身 —— 既让 rollup 能 tree-shake，
 * 又保住「echarts 不进首屏 chunk」（实测 173.78 KB）。
 *
 * 注册清单（与历史约束一致，新增成员必须重新实测体积并显式上调门禁）：
 * - 图表：Line（收支/资产趋势）、Pie（分类环图）、Bar（分类柱图）
 * - 组件：Grid（坐标系）、Tooltip（折线图 click 触发）
 * - 渲染器：**仅 SVG**。不注册 CanvasRenderer（iOS 14.8 上 8 图位图后备约 20MB）；
 *   不注册 AriaComponent（可访问性由 ChartFrame 的 role="img" + aria-label 提供）；
 *   不注册 Title / Legend（环图中心文字与折线图例都由 DOM 实现）。
 */
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { init, use } from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'

use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, SVGRenderer])

/**
 * 只透出 `init`：`echarts.ts` 的 `initChart` 是唯一调用方。
 *
 * 刻意**不** re-export `use` —— 任何调用方拿到 `use` 都能在运行时塞进
 * CanvasRenderer 之类的重型模块，把本文件辛苦压下来的体积一次性推翻。
 */
export { init }
export type { ECharts } from 'echarts/core'
