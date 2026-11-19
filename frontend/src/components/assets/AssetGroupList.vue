<script setup lang="ts">
/**
 * 资产分组列表（B5 / T52）：名称 · 金额 · 货币。
 *
 * 四条口径：
 * 1. **外币单列**：行金额用**该行自身币种**渲染并打币种 chip；组小计只含主币种
 *    （小计由 `core/assets.ts` 算，本组件不做任何算术 —— 跨币种求和永远是错的）。
 * 2. **负债行负号保留**：金额直接来自后端带符号余额，禁止 `abs`。
 * 3. **关户仍列出**：只打「已关户」标记，不隐藏 —— 隐藏会让用户以为钱丢了。
 * 4. 金额一律 `MoneyText`（`masked` 透传为 `privacy`），**不写 toFixed / 不拼串**；
 *    资产页的隐私遮罩失效比任何页面都严重。
 * 5. **组头有「N 个账户 · 另有 $X（USD）」**（稿 1164-1168）：账户数是**去重后的
 *    账户个数**（一个账户可能有主币种 + 外币两行，数行数会多数），外币金额来自
 *    `core/assets.ts` 的 `foreignSubtotals`，本组件只是搬上屏。
 */
import type { AssetGroup, AssetRow } from '@/core/assets'
import MoneyText from '@/components/MoneyText.vue'

withDefaults(
  defineProps<{
    /** 恒两组：资产、负债（顺序由 core 保证）。 */
    groups: AssetGroup[]
    /** 主币种（组小计的币种）。 */
    commodity: string
    /** 单独强制遮挡（未传时跟随全局隐私开关）。 */
    masked?: boolean
  }>(),
  { masked: false },
)

/**
 * 组内**账户**个数（不是行数）。
 *
 * 行粒度是「账户 × 币种」，同一账户的 CNY + USD 会出两行；直接用
 * `rows.length + foreignRows.length` 会把一个账户数成两个，用户看到
 * 「3 个账户」但列表里只有 2 个名字会以为漏了谁。
 */
function accountCount(group: AssetGroup): number {
  const seen: number[] = []
  const push = (row: AssetRow): void => {
    if (seen.indexOf(row.accountId) < 0) {
      seen.push(row.accountId)
    }
  }
  for (const row of group.rows) {
    push(row)
  }
  for (const row of group.foreignRows) {
    push(row)
  }
  return seen.length
}
</script>

<template>
  <div class="asset-groups">
    <section v-for="group in groups" :key="group.type" class="asset-group">
      <header class="asset-group__head">
        <span class="asset-group__label">{{ group.label }}</span>
        <span class="asset-group__count">
          {{ accountCount(group) }} 个账户<template v-if="group.foreignSubtotals.length > 0"><span
            v-for="fx in group.foreignSubtotals"
            :key="fx.commodity"
            class="asset-group__fx"
          > · 另有 <MoneyText :amount="fx.amount" :commodity="fx.commodity" :privacy="masked" size="sm" />（{{ fx.commodity }}）</span></template>
        </span>
        <span class="asset-group__subtotal">
          <MoneyText :amount="group.subtotal" :commodity="commodity" :privacy="masked" size="sm" />
        </span>
      </header>

      <p v-if="group.rows.length === 0 && group.foreignRows.length === 0" class="asset-group__empty">
        没有{{ group.label }}账户
      </p>

      <ul class="asset-group__rows">
        <!-- 主币种行 -->
        <li v-for="row in group.rows" :key="`${row.accountId}-${row.commodity}`" class="asset-row">
          <span class="asset-row__name">
            {{ row.label }}
            <span v-if="row.closed" class="asset-row__badge">已关户</span>
          </span>
          <span class="asset-row__amount">
            <MoneyText :amount="row.amount" :commodity="row.commodity" :privacy="masked" size="sm" />
            <span class="asset-row__code">{{ row.commodity }}</span>
          </span>
        </li>
        <!-- 外币行：自身币种展示，不计入上面那行小计 -->
        <li
          v-for="row in group.foreignRows"
          :key="`${row.accountId}-${row.commodity}`"
          class="asset-row asset-row--foreign"
        >
          <span class="asset-row__name">
            {{ row.label }}
            <span v-if="row.closed" class="asset-row__badge">已关户</span>
          </span>
          <span class="asset-row__amount">
            <MoneyText :amount="row.amount" :commodity="row.commodity" :privacy="masked" size="sm" />
            <span class="asset-row__code asset-row__code--foreign">{{ row.commodity }}</span>
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.asset-group {
  padding: 12px 0;
  border-top: 1px solid var(--fb-line);
}

.asset-group:first-child {
  border-top: none;
  padding-top: 0;
}

.asset-group__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0 8px;
}

.asset-group__label {
  flex: none;
  color: var(--fb-ink);
  font-size: 13px;
  font-weight: 600;
}

/* 「N 个账户 · 另有 $X（USD）」：占满剩余宽度，小屏可换行，不挤压小计 */
.asset-group__count {
  flex: 1;
  min-width: 0;
  color: var(--fb-sub);
  font-size: 11px;
  line-height: 1.5;
}

.asset-group__fx {
  white-space: nowrap;
}

.asset-group__subtotal {
  flex: none;
  font-variant-numeric: var(--fb-font-numeric);
}

.asset-group__empty {
  margin: 0;
  padding: 8px 0;
  color: var(--fb-sub);
  font-size: 12px;
}

.asset-group__rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.asset-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid var(--fb-line);
}

.asset-row:last-child {
  border-bottom: none;
}

.asset-row__name {
  min-width: 0;
  overflow: hidden;
  color: var(--fb-ink);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-row__amount {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  font-variant-numeric: var(--fb-font-numeric);
}

.asset-row__code {
  padding: 1px 6px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
  color: var(--fb-sub);
  font-size: 10px;
}

/* 外币 chip 用主色系，与主币种行区分（金额本身不带合计含义）。
   注意：仓内只有 `--fb-blue` / `--fb-blue-soft`，没有 `--fb-blue-ink` ——
   引用不存在的 token 会静默失效（计算值为空 → 继承父级），门禁①会拦。 */
.asset-row__code--foreign {
  background: var(--fb-blue-soft);
  color: var(--fb-blue);
}

.asset-row__badge {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
  color: var(--fb-sub);
  font-size: 10px;
}
</style>
