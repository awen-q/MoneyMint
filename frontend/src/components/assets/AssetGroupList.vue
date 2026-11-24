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
import { catIcon } from '@/core/accounts'
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
        <!-- 主币种行：币种 chip 紧跟名称之后（设计 `.a-name` 内含 `.cur-chip`，A-04） -->
        <li v-for="row in group.rows" :key="`${row.accountId}-${row.commodity}`" class="asset-row">
          <span class="asset-row__name">
            <span class="asset-row__icon" aria-hidden="true">{{ catIcon(row) }}</span>
            {{ row.label }}
            <span v-if="row.closed" class="asset-row__badge">已关户</span>
            <span class="asset-row__code">{{ row.commodity }}</span>
          </span>
          <span class="asset-row__amount">
            <MoneyText :amount="row.amount" :commodity="row.commodity" :privacy="masked" size="sm" />
          </span>
        </li>
        <!-- 外币行：自身币种展示，不计入上面那行小计 -->
        <li
          v-for="row in group.foreignRows"
          :key="`${row.accountId}-${row.commodity}`"
          class="asset-row asset-row--foreign"
        >
          <span class="asset-row__name">
            <span class="asset-row__icon" aria-hidden="true">{{ catIcon(row) }}</span>
            {{ row.label }}
            <span v-if="row.closed" class="asset-row__badge">已关户</span>
            <span class="asset-row__code asset-row__code--foreign">{{ row.commodity }}</span>
          </span>
          <span class="asset-row__amount">
            <MoneyText :amount="row.amount" :commodity="row.commodity" :privacy="masked" size="sm" />
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
/* A-05：组间**不再画 border-top** —— 分组感由组头的 `--soft` 填充条 + margin 提供。
   「线 + 色块」双重分隔会让最后一组在卡底多出一条孤线。 */
.asset-group {
  padding: 0;
}

/* 组头（A-03）：设计 `.acct-head` —— 一条 `--soft` 填充的圆角横条，
   视觉上把「资产」「负债」两块分开。原来是同一行无底色文字，两组黏在一起。 */
.asset-group__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-radius: var(--fb-radius-input);
  background: var(--fb-soft);
  margin: 10px 0 2px;
}

.asset-group:first-child .asset-group__head {
  margin-top: 0;
}

.asset-group__label {
  flex: none;
  color: var(--fb-ink);
  font-size: 13px;
  font-weight: 700;
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

/* 组小计 13/700 右对齐 tabular（设计 `.g-sum`） */
.asset-group__subtotal {
  flex: none;
  margin-left: auto;
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: var(--fb-font-numeric);
  white-space: nowrap;
}

.asset-group__empty {
  margin: 0;
  padding: 8px 4px;
  color: var(--fb-sub);
  font-size: 12px;
}

.asset-group__rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

/* 资产行（A-04）：设计 `.asset-li` —— padding 9px 4px（左右各 4px，与组头对齐） */
.asset-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 4px;
  border-bottom: 1px solid var(--fb-line);
}

.asset-row:last-child {
  border-bottom: none;
}

/* 名称 13px / 500（设计 `.a-name`，原 400） */
.asset-row__name {
  min-width: 0;
  overflow: hidden;
  color: var(--fb-ink);
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 批 II 行首图标：与分类页同一 catIcon 单一来源（缺省兜底 📁）。 */
.asset-row__icon {
  display: inline-block;
  margin-right: 4px;
  font-size: 13px;
  line-height: 1;
}

.asset-row__amount {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  font-variant-numeric: var(--fb-font-numeric);
}

/* 币种 chip（A-04）：设计 `.cur-chip` —— brand-soft 底 + brand-line 描边 + 3px 方角，
   紧跟名称之后；不是原来「soft 底 pill 且落在金额右侧」。 */
.asset-row__code {
  padding: 0 4px;
  border: 1px solid var(--fb-brand-line);
  border-radius: 3px;
  background: var(--fb-brand-soft);
  color: var(--fb-blue);
  font-size: 9.5px;
  font-weight: 600;
  vertical-align: 1px;
}

/* 外币 chip 保持品牌色（与设计一致：外币不另配色，靠金额本身区分口径） */
.asset-row__code--foreign {
  background: var(--fb-brand-soft);
  color: var(--fb-blue);
}

.asset-row__badge {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
  color: var(--fb-sub);
  font-size: 10px;
  font-weight: 400;
}
</style>
