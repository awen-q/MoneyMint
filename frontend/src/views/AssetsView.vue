<script setup lang="ts">
/**
 * 资产页（B5 / T53，design.md 资产页 / mockup `page-assets`）
 *
 * 结构：hero → 工具行卡 → asset-hero（净资产 / 总资产 / 总负债）→ 资产列表卡。
 *
 * 五条本页级决策：
 *
 * 1. **`hero` 与 `AssetHero` 都在 `StateCard` 之外**。空态 / 错误态不能让人失去出口，
 *    也不能把「净资产」这块答案藏起来 —— 与账单页 hero + 工具卡同一条理由。
 * 2. **数据只走 `ledgerData.ensure()`**（§3：页面不自己调 `accountApi.list()`）；
 *    重试只走 `reload()`（`ensure()` 在 `loaded === true` 时短路，点了没反应）。
 * 3. **币种取 `period.commodity`**（跨页单源），不取 `session.defaultCommodity` ——
 *    否则「资产页看人民币、统计页看美元」。
 * 4. **四态判据沿用冻结的 v3.2**：`error` 只在「从未成功加载过」时整页报错；
 *    有旧快照的刷新失败留在 `ready`，只出一条内联提示条。
 * 5. **「资产统计 ›」入口这轮不放**：B6 未上线，放了就是死链
 *    （`navItems.ts` 的 `asset-stats` 也仍 `ready: false`）。
 *
 * 分组聚合全部由 `core/assets.ts` 产出，净资产由 `core/record.ts` 的
 * `computeBalanceSummary` 产出 —— 本页**不做任何算术**。
 */
import { computed, onMounted } from 'vue'

import { buildAssetBreakdown, type AssetBreakdown } from '@/core/assets'
import { computeBalanceSummary, type BalanceSummary } from '@/core/record'
import { useLedgerDataStore } from '@/stores/ledgerData'
import { usePeriodStore } from '@/stores/period'
import { usePrivacyStore } from '@/stores/privacy'
import AssetGroupList from '@/components/assets/AssetGroupList.vue'
import AssetHero from '@/components/assets/AssetHero.vue'
import StateCard from '@/components/shell/StateCard.vue'

/** 刷新失败但仍有旧快照时的内联提示（四页逐字统一）。 */
const STALE_NOTICE = '刷新失败，当前显示的是上次数据'

const data = useLedgerDataStore()
const period = usePeriodStore()
const privacy = usePrivacyStore()

// `!loaded → loading` 的判据意味着漏调它表现为「永久骨架屏」，所以这条调用有测试守。
onMounted(() => {
  void data.ensure()
})

/** 主币种：跨页单源（bills ≡ stats ≡ period.commodity）。 */
const commodity = computed(() => period.commodity)

const breakdown = computed<AssetBreakdown>(() =>
  buildAssetBreakdown(data.accounts, commodity.value),
)

/**
 * 净资产口径与首页同源：`ΣAssets + ΣLiabilities`（负债分录本身为负）。
 *
 * **`allowFallback: false`**：资产页的币种是用户显式选的（`period.commodity`），
 * 该币种没有余额数据时就该显示 0.00 —— 绝不回退到别的币种（那会「标题写 USD、
 * 数字却是 CNY」的静默改口）。首页 / 报表用账本默认币种，仍走默认回退行为。
 */
const summary = computed<BalanceSummary>(() =>
  computeBalanceSummary(data.accounts, commodity.value, { allowFallback: false }),
)

/** 外币说明（有外币账户时才出现，币种来自 core，不在页面拼）。 */
const foreignNote = computed(() => {
  const codes = breakdown.value.foreignCommodities
  if (codes.length === 0) {
    return ''
  }
  return `外币账户（${codes.join('、')}）按自身币种展示，不计入 ${breakdown.value.commodity} 合计`
})

/** 整页四态（v3.2 冻结判据）。 */
const pageState = computed<'loading' | 'error' | 'empty' | 'ready'>(() => {
  if (data.error !== '' && !data.loaded) {
    return 'error'
  }
  if (!data.loaded) {
    return 'loading'
  }
  if (breakdown.value.rowCount === 0) {
    return 'empty'
  }
  return 'ready'
})

/** 有旧快照时的刷新失败：留在 ready，只出内联条。 */
const staleError = computed(() => (data.error !== '' && data.loaded ? data.error : ''))

/**
 * 空态与错误态**文案不同**：一个说「没有任何资产 / 负债账户」，
 * 一个说「加载失败」—— 把两者混成一句会把故障伪装成结论。
 */
const cardDesc = computed(() => {
  if (pageState.value === 'error') {
    return '请检查网络后重试。'
  }
  if (pageState.value === 'empty') {
    return `还没有资产或负债账户，请由账本所有者先在账户管理里创建（当前 ${commodity.value} 口径）。`
  }
  return ''
})

function reload(): void {
  void data.reload()
}

/** 关户提示：列出但标注，避免「钱去哪了」。 */
const closedNote = computed(() => {
  const count = breakdown.value.closedCount
  if (count === 0) {
    return ''
  }
  return `含 ${count} 个已关户账户（仍列出，历史余额可核对）`
})
</script>

<template>
  <section class="assets">
    <!-- ① hero：页名 + 一句话说明 -->
    <header class="assets__hero">
      <h1 class="assets__title">资产</h1>
      <p class="assets__desc">存量全景：净资产 / 总资产 / 总负债 + 资产列表</p>
    </header>

    <!-- ② 工具行卡：本轮只有标题（「资产统计 ›」入口等 B6 上线再加，避免死链） -->
    <section class="assets__card assets__card--tool">
      <h2 class="assets__card-title">资产总览</h2>
    </section>

    <!-- 刷新失败但有旧快照：留在 ready，只出内联提示条 -->
    <p v-if="staleError !== ''" class="assets__stale" role="status">
      <span class="assets__stale-text">{{ STALE_NOTICE }}</span>
      <button type="button" class="assets__stale-btn" @click="reload">重试</button>
    </p>

    <!-- ③ 净资产总计：四态之外（空态也不能把这块答案藏起来） -->
    <AssetHero :summary="summary" :commodity="commodity" :note="foreignNote" />

    <!-- ④ 资产列表：四态承载内容区 -->
    <section class="assets__card">
      <div class="assets__card-head">
        <h2 class="assets__card-title">资产列表</h2>
        <span class="assets__card-note">名称 · 金额 · 货币</span>
      </div>
      <StateCard :state="pageState" :desc="cardDesc" @action="reload">
        <AssetGroupList
          :groups="breakdown.groups"
          :commodity="breakdown.commodity"
          :masked="privacy.enabled"
        />
        <p v-if="closedNote !== ''" class="assets__hint">{{ closedNote }}</p>
        <p class="assets__hint">
          外币账户按自身币种展示并打币种 chip，不计入 {{ breakdown.commodity }} 合计；负债行负号保留
        </p>
      </StateCard>
    </section>

  </section>
</template>

<style scoped>
.assets {
  padding-bottom: 20px;
}

.assets__hero {
  padding: calc(16px + env(safe-area-inset-top, 0px)) 16px 10px;
}

.assets__title {
  margin: 0;
  color: var(--fb-ink);
  font-size: 20px;
  font-weight: 700;
}

.assets__desc {
  margin: 6px 0 0;
  color: var(--fb-sub);
  font-size: 12px;
}

.assets__card {
  margin: 10px 16px 0;
  padding: 14px;
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

.assets__card--tool {
  padding: 10px 14px;
}

.assets__card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.assets__card-title {
  margin: 0;
  color: var(--fb-ink);
  font-size: 13px;
  font-weight: 600;
}

.assets__card-note {
  color: var(--fb-sub);
  font-size: 11px;
}

.assets__stale {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 10px 16px 0;
  padding: 8px 12px;
  border-radius: var(--fb-radius-card);
  background: var(--fb-danger-soft);
  color: var(--fb-danger-ink);
  font-size: 12px;
}

.assets__stale-btn {
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

.assets__hint {
  margin: 10px 0 0;
  color: var(--fb-sub);
  font-size: 11px;
  line-height: 1.5;
}

</style>
