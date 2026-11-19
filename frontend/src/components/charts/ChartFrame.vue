<script setup lang="ts">
/**
 * 图表外框：标题 / 注释 / DOM 图例 / 四态 / 固定高度占位。
 *
 * 三个设计决策：
 * 1. **图例走 DOM 而不是 ECharts LegendComponent** —— 少注册一个组件（省体积），
 *    且色块与线条同源（都来自 palette），不会出现「图例一个色、线另一个色」。
 * 2. **固定高度占位** —— echarts 是按需异步加载的，容器高度若由内容撑开，
 *    图到了会突然撑高（CLS 抖动）。这里用 `height` 先占位。
 * 3. **四态不可省** —— 加载失败时绝不渲染 0 值，否则断网时用户会读成
 *    「这个月没花钱」，是静默错账里最危险的一种。
 */
withDefaults(
  defineProps<{
    title: string
    /** 一句话口径说明，如「按已过 17 天」；不传则不渲染。 */
    note?: string
    /** 读屏文案：必须含期间与口径，不能只写「图表」。
     * 不用 ariaLabel 命名：它会与内置 aria-label 属性在模板里冲突，vue-tsc 会判缺失。 */
    chartLabel: string
    /** 占位高度（px）。折线 220、小图 200。 */
    height?: number
    state?: 'ready' | 'loading' | 'empty' | 'error'
    emptyText?: string
    legend?: Array<{ name: string; color: string; shape?: 'line' | 'dot' | 'rect' }>
  }>(),
  {
    note: '',
    height: 220,
    state: 'ready',
    emptyText: '暂无数据',
    legend: () => [],
  },
)
</script>

<template>
  <section class="fb-chart">
    <header class="fb-chart__head">
      <h3 class="fb-chart__title">{{ title }}</h3>
      <span v-if="note" class="fb-chart__note">{{ note }}</span>
    </header>

    <ul v-if="legend.length > 0 && state === 'ready'" class="fb-chart__legend">
      <li v-for="item in legend" :key="item.name" class="fb-chart__legend-item">
        <i
          class="fb-chart__swatch"
          :class="`fb-chart__swatch--${item.shape ?? 'line'}`"
          :style="{ background: item.color }"
          aria-hidden="true"
        />
        <span>{{ item.name }}</span>
      </li>
    </ul>

    <div
      class="fb-chart__body"
      :style="{ height: `${height}px` }"
      role="img"
      :aria-label="chartLabel"
    >
      <slot v-if="state === 'ready'" />
      <p v-else-if="state === 'loading'" class="fb-chart__state">正在加载图表…</p>
      <p v-else-if="state === 'empty'" class="fb-chart__state">{{ emptyText }}</p>
      <p v-else class="fb-chart__state fb-chart__state--error">
        图表加载失败，请稍后重试
      </p>
    </div>
  </section>
</template>

<style scoped>
.fb-chart {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fb-chart__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.fb-chart__title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--fb-ink);
}

.fb-chart__note {
  font-size: 11px;
  color: var(--fb-sub);
}

.fb-chart__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.fb-chart__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--fb-sub);
}

.fb-chart__swatch {
  display: inline-block;
  flex: none;
}

.fb-chart__swatch--line {
  width: 14px;
  height: 3px;
  border-radius: 2px;
}

.fb-chart__swatch--dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.fb-chart__swatch--rect {
  width: 10px;
  height: 10px;
  border-radius: 2px;
}

.fb-chart__body {
  position: relative;
  width: 100%;
  min-width: 0;
}

.fb-chart__state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  margin: 0;
  padding: 12px;
  border: 1px dashed var(--fb-line);
  border-radius: var(--fb-radius-input);
  font-size: 12px;
  color: var(--fb-sub);
  text-align: center;
}

.fb-chart__state--error {
  color: var(--fb-danger);
  border-color: var(--fb-danger);
}
</style>
