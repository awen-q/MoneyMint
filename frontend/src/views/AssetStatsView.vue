<script setup lang="ts">
/**
 * 资产统计页（B6 / T57，design.md 资产统计 / mockup `page-assetstats`）
 *
 * 结构：hero → 工具卡（返回资产 ｜ 上一年 / 年份 chip / 下一年 ｜ 币种 seg）
 * → 资产趋势（三线）→ 月度资产变化列表。
 *
 * 六条本页级决策：
 *
 * 1. **只做「按月」，不做「按日」**（老板 2026-11-19 定）：真实数据下按日要逐日重放
 *    一年 365 点 × 3 线，成本高、价值低；看年度趋势月粒度足够。**本期不提供按日 seg**
 *    —— 给一个「切了没反应」的按钮比不给更糟。
 * 2. **数据来自服务端 `/api/assets/series`**（不是 `ledgerData` 的全量快照）：
 *    序列是「按月末末值」，需要逐月重算余额，服务端一次算完最省；这也是
 *    `StatsView` 注释里写的「数据量增大后转向服务端聚合」的第一个实例。
 * 3. **必须显式传 `commodity`**：省略时服务端取账本默认币种，用户切币种后曲线不变
 *    （且不报错）。
 * 4. **`net` 不重算**：`core/assetSeries.ts` 原样搬运服务端值，页面更不碰。
 * 5. **四态沿用 v3.2**：首屏失败整页报错；已有数据后的刷新失败只出内联条。
 *    工具卡（年份 / 币种 / 返回）在 `StateCard` 之外 —— 空态不能变成死路。
 * 6. **图表实例数**：本页只挂 1 张折线（`MAX_LIVE_CHARTS = 4`，统计页是 4 张的那页）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { assetSeriesApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { AssetSeriesResponse } from '@/api/types'
import { buildAssetSeries, emptyAssetSeries, type AssetSeries } from '@/core/assetSeries'
import type { LineSeriesInput } from '@/core/charts/option'
import { getChartPalette, readThemeTokens, themeEpoch } from '@/styles/themeTokens'
import { usePeriodStore } from '@/stores/period'
import { usePrivacyStore } from '@/stores/privacy'
import MoneyText from '@/components/MoneyText.vue'
import StateCard from '@/components/shell/StateCard.vue'
import YearPicker from '@/components/shell/YearPicker.vue'
import TrendChart from '@/components/charts/TrendChart.vue'
import MonthChangeList from '@/components/assets/MonthChangeList.vue'

const router = useRouter()
const period = usePeriodStore()
const privacy = usePrivacyStore()

const yearOpen = ref(false)
const loading = ref(false)
const error = ref('')
const loaded = ref(false)
const response = ref<AssetSeriesResponse | null>(null)

const year = computed(() => period.assets.year)
const commodity = computed(() => period.commodity)

/** 派生数据：加载中 / 失败时用空序列，保持 12 个点，图表尺寸不跳。 */
const series = computed<AssetSeries>(() => {
  if (response.value === null) {
    return emptyAssetSeries(year.value, commodity.value)
  }
  return buildAssetSeries(response.value, year.value)
})

/**
 * 请求中带 `year` + **显式 `commodity`**。
 * 竞态守卫：连续切年/切币种时，只让最后一次响应落地（否则会出现「切到 2025，
 * 曲线却是 2024 的数」——页面正常、数字错）。
 */
let requestToken = 0

async function load(): Promise<void> {
  const token = requestToken + 1
  requestToken = token
  loading.value = true
  error.value = ''
  try {
    const res = await assetSeriesApi.series(year.value, commodity.value)
    if (token !== requestToken) {
      return
    }
    response.value = res
    loaded.value = true
  } catch (err) {
    if (token !== requestToken) {
      return
    }
    error.value = err instanceof ApiError ? err.message : '资产序列加载失败，请重试'
  } finally {
    if (token === requestToken) {
      loading.value = false
    }
  }
}

onMounted(() => {
  void load()
})

// 年份 / 币种变化都要重拉：服务端按 (year, commodity) 聚合，本地没有对应快照。
watch([year, commodity], () => {
  void load()
})

/** 整页四态（v3.2：error 只在「从未成功加载过」时整页报错）。 */
const pageState = computed<'loading' | 'error' | 'empty' | 'ready'>(() => {
  if (error.value !== '' && !loaded.value) {
    return 'error'
  }
  if (!loaded.value) {
    return 'loading'
  }
  if (!series.value.hasAnyValue) {
    return 'empty'
  }
  return 'ready'
})

const staleError = computed(() => (error.value !== '' && loaded.value ? error.value : ''))

const cardDesc = computed(() => {
  if (pageState.value === 'error') {
    return '请检查网络后重试。'
  }
  if (pageState.value === 'empty') {
    return `${year.value} 年没有资产或负债记录。`
  }
  return ''
})

function reload(): void {
  void load()
}

function shiftYear(delta: number): void {
  period.setAssetsYear(year.value + delta)
}

function onYearSelect(next: number): void {
  yearOpen.value = false
  period.setAssetsYear(next)
}

function goAssets(): void {
  void router.push({ name: 'assets' })
}

/**
 * 图表配色跟随主题（X-05）：色值一律经 `getChartPalette(readThemeTokens())` 取实色。
 *
 * **禁止**直接给 ECharts 传 `'var(--fb-*)'` 字符串 —— SVG renderer 会把颜色写进
 * `stroke` / `fill` 表现属性，`var()` 在其上的解析在 Safari 14 / iOS 14 不可靠。
 */
const palette = computed(() => {
  void themeEpoch.value
  return getChartPalette(readThemeTokens())
})

/**
 * 三条线：总资产 / 总负债 / 净资产（X-04）。
 *
 * 取色按设计稿 `assets/app.js:1212-1214`：总资产 = `--accent`（品牌墨绿）、
 * 总负债 = `--expense`（危险红）、净资产 = `--accent2`（暖金 —— 设计刻意用金色
 * 标注「答案线」）。原实现把净资产与总资产的色对调了。
 *
 * 顺序同时按设计稿图例：总资产 → 负债 → 净资产。金额与几何量同源，禁止反算。
 */
const chartSeries = computed<LineSeriesInput[]>(() => [
  {
    name: '总资产',
    color: palette.value.brand,
    points: series.value.assets.map((amount) => ({ value: Number(amount), amount })),
  },
  {
    name: '总负债',
    color: palette.value.danger,
    points: series.value.liabilities.map((amount) => ({ value: Number(amount), amount })),
  },
  {
    name: '净资产',
    color: palette.value.warn,
    points: series.value.net.map((amount) => ({ value: Number(amount), amount })),
  },
])

const currencyOptions = computed(() => {
  const out: string[] = [commodity.value]
  // 只列当前币种：本页数据按单一币种由服务端聚合，列出无数据的币种会得到全 0 曲线。
  return out
})
</script>

<template>
  <section class="astats">
    <header class="astats__hero">
      <h1 class="astats__title">资产统计</h1>
      <p class="astats__desc">年度资产 / 净资产 / 负债趋势 + 月度变化列表</p>
    </header>

    <!-- 工具卡：返回 / 年份 / 币种（都在 StateCard 之外，空态与错误态仍可操作） -->
    <section class="astats__card astats__card--tool">
      <div class="astats__tool-row">
        <button type="button" class="astats__back" @click="goAssets">‹ 返回资产</button>
        <span class="astats__year">
          <button type="button" class="astats__arrow" aria-label="上一年" @click="shiftYear(-1)">‹</button>
          <button type="button" class="astats__chip" @click="yearOpen = true">
            <span class="astats__chip-text">{{ year }} 年</span>
            <span class="astats__caret" aria-hidden="true">▾</span>
          </button>
          <button type="button" class="astats__arrow" aria-label="下一年" @click="shiftYear(1)">›</button>
        </span>
        <span v-if="currencyOptions.length > 1" class="astats__seg" role="group" aria-label="统计币种">
          <button
            v-for="code in currencyOptions"
            :key="code"
            type="button"
            class="astats__seg-btn astats__seg-btn--on"
            :aria-pressed="true"
            @click="period.setCommodity(code)"
          >{{ code }}</button>
        </span>
      </div>
      <p class="astats__note">按月口径（本期不做按日）· 金额单位 {{ commodity }} · 禁跨币种求和</p>
    </section>

    <p v-if="staleError !== ''" class="astats__stale" role="status">
      <span>刷新失败，当前显示的是上次数据</span>
      <button type="button" class="astats__stale-btn" @click="reload">重试</button>
    </p>

    <StateCard :state="pageState" :desc="cardDesc" @action="reload">
      <section class="astats__card">
        <div class="astats__card-head">
          <span class="astats__card-title">资产趋势</span>
          <span class="astats__card-note">总资产 / 负债 / 净资产 三线</span>
        </div>
        <TrendChart
          title="资产趋势"
          :chart-label="`${year} 年 1..12 月总资产、负债与净资产，${commodity} 口径`"
          :labels="series.labels"
          :series="chartSeries"
          :commodity="commodity"
          :masked="privacy.enabled"
        />
        <p class="astats__hint">
          净资产 = 总资产 + 负债（负债为负值，故相加）；12 月末：总资产
          <MoneyText :amount="series.yearEnd.assets" :commodity="commodity" :privacy="privacy.enabled" size="sm" />
          · 负债
          <MoneyText :amount="series.yearEnd.liabilities" :commodity="commodity" :privacy="privacy.enabled" size="sm" />
          · 净资产
          <MoneyText :amount="series.yearEnd.net" :commodity="commodity" :privacy="privacy.enabled" size="sm" />
        </p>
      </section>

      <section class="astats__card">
        <MonthChangeList
          :months="series.months"
          :commodity="commodity"
          :masked="privacy.enabled"
        />
      </section>
    </StateCard>

    <YearPicker
      :open="yearOpen"
      :value="year"
      :min-year="1000"
      :max-year="9998"
      @select="onYearSelect"
      @close="yearOpen = false"
    />
  </section>
</template>

<style scoped>
.astats {
  padding-bottom: 20px;
}

/* X-02：横向内边距归零（水平留白统一由 `.layout__content` 给） */
.astats__hero {
  padding: 0 0 10px;
}

.astats__title {
  margin: 0;
  color: var(--fb-ink-deep);
  font-size: 21px;
  font-weight: 700;
}

.astats__desc {
  margin: 4px 0 0;
  color: var(--fb-sub);
  font-size: 13px;
}

.astats__card {
  margin: 14px 0 0;
  padding: 14px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

.astats__card--tool {
  padding: 16px;
}

.astats__tool-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

/* 返回资产（AS-01 ①）：设计 `.back-chip` —— brand-soft 底 + brand-line 描边胶囊。
   原实现是无框蓝字，看不出可点。 */
.astats__back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border: 1px solid var(--fb-brand-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-brand-soft);
  color: var(--fb-blue);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

/* 年份方向按钮（AS-01 ②）：设计 `.icon-btn` 36×36 描边方按钮 */
.astats__arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-blue);
  font-family: inherit;
  font-size: 16px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
}

.astats__year {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

/* 年份 chip（AS-01 ③）：描边白底胶囊 + ▾ */
.astats__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 7px 12px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: var(--fb-font-numeric);
  cursor: pointer;
}

.astats__caret {
  color: var(--fb-sub);
  font-size: 10px;
}

.astats__back:focus-visible,
.astats__arrow:focus-visible,
.astats__chip:focus-visible,
.astats__seg-btn:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

/* 币种 seg（AS-01 ④）：容器描边 + 选中「实心墨绿 + 米白字」 */
.astats__seg {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
}

.astats__seg-btn {
  min-height: 30px;
  padding: 6px 14px;
  border: none;
  border-radius: var(--fb-radius-pill);
  background: transparent;
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.astats__seg-btn--on {
  background: var(--fb-blue);
  color: var(--fb-white);
  font-weight: 600;
}

.astats__note,
.astats__hint {
  margin: 8px 0 0;
  color: var(--fb-sub);
  font-size: 11px;
  line-height: 1.6;
}

/* X-02：刷新失败条不再自带横向外边距 */
.astats__stale {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 14px 0 0;
  padding: 8px 12px;
  border-radius: var(--fb-radius-card);
  background: var(--fb-danger-soft);
  color: var(--fb-danger-ink);
  font-size: 12px;
}

.astats__stale-btn {
  flex: none;
  border: none;
  background: transparent;
  color: var(--fb-danger-ink);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: underline;
}

.astats__card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

/* 卡头标题（AS-03）：统一 15/700 `--fb-ink` */
.astats__card-title {
  color: var(--fb-ink);
  font-size: 15px;
  font-weight: 700;
}

.astats__card-note {
  color: var(--fb-sub);
  font-size: 11px;
}

@media (max-width: 768px) {
  .astats__card--tool {
    padding: 14px;
  }
}

/**
 * 稿 `page-assetstats` 的返回是 `.back-chip only-mobile`：≥900px 隐藏。
 *
 * 理由不是「PC 不需要返回」，而是 PC 有侧栏「资产」入口 —— 两个入口同时出现时，
 * 「返回资产」会被读成「退出当前账本/页面层级」的语义（与壳层返回键混淆）。
 * 断点与壳层一致（`AppLayout.vue` / `ShellTabs.vue` 都是 900px）。
 */
@media (min-width: 900px) {
  .astats__back {
    display: none;
  }
}
</style>
