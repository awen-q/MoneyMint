<script setup lang="ts">
/**
 * 金额 / 符号口径统一组件（C-01 配套，F-1 / AC-11 / AC-12）
 *
 * - 展示口径只有两个来源：`formatMoney`（完整）与 `formatCompact`（简写），
 *   两者都在 `core/Money.ts`。**组件内不拼任何金额字符串**——否则等于造出
 *   第二套口径，日历格与列表一旦不一致就是「同一个数字两种写法」。
 * - 负号前置到币种符号之前，金额本体取绝对值；
 * - **绝不 abs() / 按账户类型乘系数**：后端返回的 Liabilities / Income
 *   余额本身为负，这里原样显示负号（§6.4 静默错账防线）；
 * - **隐私遮挡优先于一切**：`masked` 为真时只看遮挡符，`format` 不参与，
 *   否则简写档会把真实金额以 `-1.2k` 的形式漏出来。
 */
import { computed } from 'vue'

import { formatCompact, formatMoney } from '@/core/Money'
import { PRIVACY_MASK } from '@/core/privacy'
import { usePrivacyStore } from '@/stores/privacy'

const props = withDefaults(
  defineProps<{
    /** 定点十进制金额字符串（后端原始带符号值）。 */
    amount: string
    commodity?: string
    /** 正数是否显式加 `+`（零不显示符号）。 */
    signed?: boolean
    /** 单独强制遮挡；未设置时跟随全局隐私开关。 */
    privacy?: boolean
    size?: 'sm' | 'md' | 'lg'
    /**
     * 展示形态：
     * - `full`（默认）：完整金额，带币种符号与千分位，如 `-¥ 1,234.50`；
     * - `compact`：简写，**不带币种符号**，如 `-1.2k`。日历格等 8.5px 极窄场景专用。
     */
    format?: 'full' | 'compact'
  }>(),
  {
    commodity: 'CNY',
    signed: false,
    privacy: false,
    size: 'md',
    format: 'full',
  },
)

const privacyStore = usePrivacyStore()
const masked = computed(() => props.privacy || privacyStore.enabled)
const text = computed(() => {
  if (masked.value) {
    return PRIVACY_MASK
  }
  if (props.format === 'compact') {
    return formatCompact(props.amount, { signed: props.signed })
  }
  return formatMoney(props.amount, props.commodity, { signed: props.signed })
})
/** 负号判定跟着 `text` 走，所以 compact 档同样成立（`formatCompact` 也把负号前置）。 */
const negative = computed(
  () => !masked.value && text.value.charAt(0) === '-',
)
</script>

<template>
  <span
    class="money-text"
    :class="[
      `money-text--${size}`,
      { 'money-text--negative': negative, 'money-text--masked': masked },
    ]"
    :aria-label="masked ? '金额已隐藏' : text"
  >{{ text }}</span>
</template>

<style scoped>
.money-text {
  display: inline-block;
  font-variant-numeric: var(--fb-font-numeric);
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.money-text--sm {
  font-size: 13px;
  font-weight: 600;
}

.money-text--md {
  font-size: 16px;
  font-weight: 700;
}

.money-text--lg {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: -0.02em;
}

/* 负债、收入账户的负余额与负净资产：保留负号并用危险色强调。 */
.money-text--negative {
  color: var(--fb-danger);
}

.money-text--masked {
  color: var(--fb-sub);
}
</style>
