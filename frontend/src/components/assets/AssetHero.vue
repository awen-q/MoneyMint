<script setup lang="ts">
/**
 * 资产总计卡（B5 / T51）：净资产 / 总资产 / 总负债。
 *
 * 三条口径（都不可「优化」）：
 *
 * 1. **金额只来自 `core/record.ts` 的 `computeBalanceSummary`**（页面把整份结果传进来）。
 *    组件内**不做任何 Σ** —— 净资产口径是 `ΣAssets + ΣLiabilities`（后端余额本身带符号，
 *    负债为负），首页与资产页必须同源，否则「净资产去哪了」会变成两个数字。
 * 2. **负净资产保留负号**，不 `abs`、不隐藏，并给一句解释性文案（v4.1 的 `hh-neg-note`）。
 *    净资产为负是真实信息（房贷高于金融资产），抹掉它就是骗用户。
 * 3. 金额一律走 `MoneyText`（币种符号 / 千分位 / 隐私遮挡都在那里），本组件不拼串。
 */
import { computed } from 'vue'

import { Money } from '@/core/Money'
import type { BalanceSummary } from '@/core/record'
import MoneyText from '@/components/MoneyText.vue'

const props = defineProps<{
  /** `computeBalanceSummary(accounts, commodity, { allowFallback: false })` 的结果（金额唯一真相源）。 */
  summary: BalanceSummary
  /**
   * 展示币种：**由页面传 `period.commodity`**（用户显式选择的那个），
   * 不读 `summary.commodity` —— 让「hero / 分组列表 / 全局币种选择」三处
   * 结构上同源，而不是依赖 `allowFallback: false` 这一条配置来保证相等。
   */
  commodity: string
  /** 单独强制遮挡（未传时跟随全局隐私开关）。 */
  masked?: boolean
  /** 可选补充说明（如外币账户不计入合计的提示）。 */
  note?: string
}>()

/** 净资产是否为负（用 `Money` 判符号，不 parseFloat 定点串）。 */
const netNegative = computed(() => {
  try {
    return Money.from(props.summary.netWorthTotal).isNegative()
  } catch {
    return false
  }
})
</script>

<template>
  <section class="asset-hero" aria-label="资产总计">
    <p class="asset-hero__label">
      净资产 · ΣAssets + ΣLiabilities（{{ commodity }} 口径）
    </p>
    <div class="asset-hero__net">
      <MoneyText
        :amount="summary.netWorthTotal"
        :commodity="commodity"
        :privacy="masked === true"
        size="lg"
      />
    </div>
    <!-- 负净资产：如实保留负号，并解释为什么是负的（不隐藏、不 abs） -->
    <p v-if="netNegative" class="asset-hero__neg-note">
      净资产为负：负债（房贷）高于金融资产，负号如实保留（不 abs、不隐藏）
    </p>
    <div class="asset-hero__row">
      <div class="asset-hero__metric">
        <span>总资产</span>
        <MoneyText
          :amount="summary.assetTotal"
          :commodity="commodity"
          :privacy="masked === true"
          size="sm"
        />
      </div>
      <div class="asset-hero__vline" aria-hidden="true"></div>
      <div class="asset-hero__metric">
        <span>总负债</span>
        <MoneyText
          :amount="summary.liabilityTotal"
          :commodity="commodity"
          :privacy="masked === true"
          size="sm"
        />
      </div>
    </div>
    <p v-if="note !== undefined && note !== ''" class="asset-hero__note">{{ note }}</p>
  </section>
</template>

<style scoped>
.asset-hero {
  padding: 16px;
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

.asset-hero__label {
  margin: 0;
  color: var(--fb-sub);
  font-size: 11px;
}

.asset-hero__net {
  margin-top: 6px;
  color: var(--fb-ink);
}

/*
 * 净资产字号 34px（稿 532 `.hh-net`）。
 *
 * `MoneyText size="lg"` 是 30px，而**小票** `ReceiptSlip` 也吃 lg 档 —— 为资产页
 * 一处去改共享档位会连带改小票，所以在这里局部覆盖（与 `ReceiptSlip` /
 * `AccountDetailView` 已有的 `:deep(.money-text)` 用法一致）。
 *
 * 负号配色不用管：`MoneyText` 的 `.money-text--negative` 已把负金额染成
 * `--fb-danger`，净资产为负时数字本身就是刺眼的（审计 A-4 实测已满足）。
 */
.asset-hero__net :deep(.money-text) {
  font-size: 34px;
}

/* 负净资产用危险色的 ink 档（soft 底上达 AA），但**只改颜色不改数字** */
.asset-hero__neg-note {
  margin: 6px 0 0;
  color: var(--fb-danger-ink);
  font-size: 11px;
  line-height: 1.5;
}

.asset-hero__row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 14px;
}

.asset-hero__metric {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--fb-ink);
}

.asset-hero__metric > span {
  color: var(--fb-sub);
  font-size: 11px;
}

.asset-hero__vline {
  width: 1px;
  height: 30px;
  background: var(--fb-line);
}

.asset-hero__note {
  margin: 12px 0 0;
  color: var(--fb-sub);
  font-size: 11px;
  line-height: 1.5;
}
</style>
