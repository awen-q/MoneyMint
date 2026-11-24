<script setup lang="ts">
/**
 * SkeletonBlock —— 骨架屏灰底圆角块（骨架屏批）。
 *
 * 纯展示组件：灰底块 + `linear-gradient` 位移动画的 shimmer 扫光
 * （`::after` 覆盖层 `translateX` 扫过，纯 CSS，Safari 14.1 可用）。
 * 色值只引用 tokens.css 的 `--fb-skeleton-*` 三 token（底色 / 扫光过渡档 /
 * 扫光高光档），亮暗主题自动适配，组件内零色值字面量。
 *
 * 用法（克制：4 个 variant 预设 + width / height 覆盖，调用处自行组合，
 * 不提供 Group 组件 —— 组合结构属于各落点页面）：
 * - `line`：列表文字条（默认，高 14px 全宽圆条）；
 * - `card`：指标小卡占位（高 64px）；
 * - `calendar`：日历等大块占位（高 300px）；
 * - `chart`：图表区占位（高 200px）。
 *
 * 无障碍：根节点 `aria-hidden`（纯装饰）；「加载中」的读屏播报由调用方的
 * `role="status"` 容器 + 视觉隐藏文案负责（见 BillsView / StatsView / StateCard）。
 */
import { computed } from 'vue'

/** 预设档位。 */
type SkeletonVariant = 'line' | 'card' | 'calendar' | 'chart'

/** 单档预设：缺省宽高 + 圆角（圆角走既有 token，块级与卡片同族）。 */
interface SkeletonPreset {
  width: string
  height: string
  radius: string
}

const props = withDefaults(
  defineProps<{
    /** 预设档位：line 文本条 / card 指标小卡 / calendar 日历大块 / chart 图表区。 */
    variant?: SkeletonVariant
    /** 覆盖预设宽度（任意 CSS 宽度值，如 '92%' / '180px'），空串 = 用预设。 */
    width?: string
    /** 覆盖预设高度（任意 CSS 高度值），空串 = 用预设。 */
    height?: string
  }>(),
  { variant: 'line', width: '', height: '' },
)

/** 预设表：尺寸贴近各落点真实内容区，v-if 切换（骨架 ↔ 真实内容）不跳动。 */
const PRESETS: Record<SkeletonVariant, SkeletonPreset> = {
  line: { width: '100%', height: '14px', radius: '7px' },
  card: { width: '100%', height: '64px', radius: 'var(--fb-radius-input)' },
  calendar: { width: '100%', height: '300px', radius: 'var(--fb-radius-card)' },
  chart: { width: '100%', height: '200px', radius: 'var(--fb-radius-card)' },
}

const preset = computed<SkeletonPreset>(() => PRESETS[props.variant])

/** 显式传入的 width / height 覆盖预设；圆角始终由档位决定（调用方不需要自定圆角）。 */
const blockStyle = computed(() => ({
  width: props.width !== '' ? props.width : preset.value.width,
  height: props.height !== '' ? props.height : preset.value.height,
  borderRadius: preset.value.radius,
}))
</script>

<template>
  <div class="skel" :class="`skel--${variant}`" :style="blockStyle" aria-hidden="true"></div>
</template>

<style scoped>
.skel {
  position: relative;
  display: block;
  overflow: hidden;
  background-color: var(--fb-skeleton-base);
}

/* shimmer：高光覆盖层从左扫到右。渐变两端用 transparent 关键字（非色值字面量），
   中段依次经过过渡档与高光档两个 token，形成「中间最亮、边缘淡出」的扫光带。 */
.skel::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-image: linear-gradient(
    100deg,
    transparent 18%,
    var(--fb-skeleton-sheen-soft) 38%,
    var(--fb-skeleton-sheen) 50%,
    var(--fb-skeleton-sheen-soft) 62%,
    transparent 82%
  );
  transform: translateX(-100%);
  animation: skel-sweep 1.4s ease-in-out infinite;
}

@keyframes skel-sweep {
  to {
    transform: translateX(100%);
  }
}

/* 动效豁免：系统开启「减弱动态效果」时停掉扫光，只留静态灰底块。 */
@media (prefers-reduced-motion: reduce) {
  .skel::after {
    display: none;
  }
}
</style>
