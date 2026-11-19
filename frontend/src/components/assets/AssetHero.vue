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
/*
 * 净资产总计卡（A-01）：全页唯一「深色块」，设计 `.asset-hero` ——
 * 深墨绿渐变 + 米白字 + 无描边。原实现是浅纸卡 + 墨字，整页视觉重心消失。
 *
 * 米白字取 `--fb-white`：浅纸主题下它就是纸白 `--fb-card` 的值；夜纸主题下该变量
 * 本会变成深色卡面，
 * 但 `tokens.css` 的语义补偿块已把 `.asset-hero` 列入
 * `[data-theme='night'] … { --fb-white: var(--fb-ink) }`，故两套主题都得到
 * 「深底上的浅字」，组件内零主题分支。
 */
.asset-hero {
  padding: 20px;
  border: none;
  border-radius: var(--fb-radius-card);
  background: var(--fb-hero-gradient);
  color: var(--fb-white);
  box-shadow: none;
}

.asset-hero__label {
  margin: 0;
  color: var(--fb-on-hero-muted);
  font-size: 11.5px;
}

.asset-hero__net {
  margin-top: 4px;
  color: var(--fb-white);
}

/*
 * 净资产字号 34px / 800（稿 532 `.hh-net`）。
 *
 * `MoneyText size="lg"` 是 30px，而**小票** `ReceiptSlip` 也吃 lg 档 —— 为资产页
 * 一处去改共享档位会连带改小票，所以在这里局部覆盖（与 `ReceiptSlip` /
 * `AccountDetailView` 已有的 `:deep(.money-text)` 用法一致）。
 *
 * 负净资产同样用米白：设计 `.hh-net.neg` 取 `--warn-soft`，但夜纸下
 * `--fb-warn-soft` 是深褐（`--fb-warn-soft` 在 night 块是一个很暗的暖褐），
 * 压在深绿渐变上不可读；而「为负」这件事
 * 已由下方 `neg-note` 明确说明。宁可少一处色相，也不要一个看不见的答案。
 */
.asset-hero__net :deep(.money-text) {
  color: var(--fb-white);
  font-size: 34px;
  font-weight: 800;
}

/* 隐私遮挡符：`.money-text--masked` 默认取 `--fb-sub`（深灰），
   在深底上几乎不可见 —— 这里给深底专用覆盖值（遮罩本身不能失效）。 */
.asset-hero__net :deep(.money-text--masked) {
  color: var(--fb-on-hero-muted);
}

/* 负净资产说明：用 on-hero 次要色（原 `--fb-danger-ink` 在深底上 1.9:1 不可读） */
.asset-hero__neg-note {
  margin: 6px 0 0;
  color: var(--fb-on-hero-muted);
  font-size: 11px;
  line-height: 1.5;
}

/* 分隔线（A-01 ②）：设计 `.hh-row` 有 1px `--on-hero-pill` 上半边，
   原来只有 margin-top，两块内容糊在一起。 */
.asset-hero__row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--fb-on-hero-pill);
}

.asset-hero__metric {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: var(--fb-white);
}

.asset-hero__metric > span {
  color: var(--fb-on-hero-muted);
  font-size: 11px;
}

/* 总资产 / 总负债数值 17px / 700（设计 `.hh-metric strong`，原 13px） */
.asset-hero__metric :deep(.money-text) {
  color: var(--fb-white);
  font-size: 17px;
  font-weight: 700;
}

.asset-hero__metric :deep(.money-text--masked) {
  color: var(--fb-on-hero-muted);
}

.asset-hero__vline {
  width: 1px;
  height: 34px;
  background: var(--fb-on-hero-pill);
}

/* 外币说明（设计 `.usd-note`）：暖金软底 chip，不是灰字 */
.asset-hero__note {
  margin: 10px 0 0;
  padding: 5px 10px;
  border-radius: 6px;
  background: var(--fb-warn-soft);
  color: var(--fb-warn-ink);
  font-size: 11.5px;
  line-height: 1.5;
}
</style>
