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
 */
import type { AssetGroup } from '@/core/assets'
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
</script>

<template>
  <div class="asset-groups">
    <section v-for="group in groups" :key="group.type" class="asset-group">
      <header class="asset-group__head">
        <span class="asset-group__label">{{ group.label }}</span>
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
  color: var(--fb-ink);
  font-size: 13px;
  font-weight: 600;
}

.asset-group__subtotal {
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
