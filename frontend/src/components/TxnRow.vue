<script setup lang="ts">
/**
 * 交易行（T11）：`TxnRowView` 的唯一渲染实现，账单页 / 搜索页 / 下钻抽屉共用。
 *
 * **组件只渲染，不判定**：金额符号、徽章取舍与顺序、副行字段与文案全部在
 * `core/txnRow.ts` 的 `buildTxnRow` 里算好（那边有 18 例测试）。这里做四件事，
 * 任何一件都不许"顺手优化"：
 *
 * 1. **徽章全量渲染、按数组顺序、不排序不取首个**。一笔被冲正的转账会同时有
 *    `[已冲正, 转账]` —— 两个都对：前者说明这笔已失效，后者说明它原本是转账
 *    （否则不带符号的金额会被误读成异常）。徽章 `flex: none`，金额 `flex: 1 0 auto`
 *    右对齐，保证「两枚章 + 金额」在同一行且章不会被金额挤没。
 * 2. **金额不再 format**：`view.amount` 已是两位定点串，只交给 `MoneyText` 套
 *    符号与币种；`signed === false`（转账）时**绝不自补 `+`**。
 * 3. **副行不做 falsy 过滤**：core 已保证 `meta` 里没有空串项；bill 档只按长度
 *    降级（`slice`），**不按 kind 挑字段**，否则等于在渲染层重排一遍口径。
 * 4. **`drawer` 档默认不可点**：抽屉里的行本身在抽屉内，再包一层 button 会产生
 *    「点一行跳一次页」的嵌套语义，默认渲染 `div`。
 */
import { computed } from 'vue'

import MoneyText from './MoneyText.vue'
import type { BadgeTone, TxnRowView, TxnRowVariant } from '@/core/txnRow'

const props = withDefaults(
  defineProps<{
    /** core 层算好的行视图模型。 */
    view: TxnRowView
    /** 行档位：账单单行 / 搜索结果两行 / 抽屉不截断。 */
    variant: TxnRowVariant
    /**
     * 是否可点。不传时按档位推导：`drawer` 为 false，其余为 true。
     * 显式传值可覆盖（例如搜索结果里不可点的汇总行）。
     */
    interactive?: boolean
  }>(),
  {
    // undefined 表示「按 variant 自动」，故此处不设默认值。
    interactive: undefined,
  },
)

const emit = defineEmits<{
  /** 整行被激活（点击或键盘 Enter/Space）。 */
  open: []
}>()

/**
 * bill 档副行最多显示几项 = 3，即 core 的 bill plan 全量（分类 · 成员 · 至多 1 标签）。
 *
 * 这里**不做宽度判断**：容器是 `nowrap + ellipsis`，超长时只省略、不折行（320/375
 * 实测行高稳定 56px）。所以截断交给 CSS，`slice` 只作为「core 将来多给字段」时的
 * 上限保险，不再提前砍字段（砍到 2 会让账单页永远看不到标签）。
 */
const BILL_META_LIMIT = 3

const clickable = computed(() =>
  props.interactive === undefined ? props.variant !== 'drawer' : props.interactive,
)

/** 副行实际渲染项：bill 按长度降级，其余全量（截断交给 CSS）。 */
const metaItems = computed(() =>
  props.variant === 'bill' ? props.view.meta.slice(0, BILL_META_LIMIT) : props.view.meta,
)

function onClick(): void {
  if (!clickable.value) {
    return
  }
  emit('open')
}
</script>

<template>
  <component
    :is="clickable ? 'button' : 'div'"
    class="txn-row"
    :class="`txn-row--${variant}`"
    :type="clickable ? 'button' : undefined"
    @click="onClick"
  >
    <span class="txn-row__body">
      <!-- 第一行：徽章（全量、按序、不换行）+ 主文案 + 金额 -->
      <span class="txn-row__top">
        <span v-if="view.badges.length > 0" class="txn-row__badges">
          <span
            v-for="(badge, index) in view.badges"
            :key="`${badge.tone}-${index}`"
            class="txn-row__badge"
            :class="`txn-row__badge--${badge.tone}`"
          >{{ badge.label }}</span>
        </span>
        <span class="txn-row__title">{{ view.title }}</span>
        <span class="txn-row__amount">
          <!-- 币种一律用 `view.commodity`（代表分录自身的币种），**不要**回退成
               账本主币种：跨币种账本里那会把「这笔是 $12」标成「¥12」。
               core 允许它为空串（空 postings / 旧响应），此时 MoneyText 渲染
               不带符号的裸金额——与现网 TransactionsView 行的行为一致。 -->
          <MoneyText
            :amount="view.amount"
            :commodity="view.commodity"
            :signed="view.signed"
            size="sm"
          />
        </span>
      </span>

      <!-- 第二行：副行（bill 单行 ellipsis / search 两行 clamp / drawer 不截断） -->
      <span
        v-if="metaItems.length > 0"
        class="txn-row__meta"
        :class="`txn-row__meta--${variant}`"
      >
        <template v-for="(item, index) in metaItems" :key="`${item.kind}-${index}`">
          <span v-if="index > 0" class="txn-row__sep" aria-hidden="true">·</span>
          <span class="txn-row__meta-item">{{ item.text }}</span>
        </template>
      </span>
    </span>

    <span v-if="clickable" class="txn-row__arrow" aria-hidden="true">›</span>

    <!--
      可访问名后缀（视觉隐藏、仍进可访问树）。
      **不要**改成 aria-label：一旦有 aria-label，它会覆盖子树内容的名称计算，
      金额/徽章/副行全部读不到；而在 aria-label 里拼金额又必须自己做遮挡判断，
      否则隐私开关下页面是 ••••••、读屏却念出真值（AC-11 失效），且会再造一份
      formatMoney。让名称由内容构成，三个问题同时消失。
      也不要用 display:none / visibility:hidden —— 那会把这段文字从可访问树里删掉。
    -->
    <span v-if="clickable" class="txn-row__a11y">查看详情</span>
  </component>
</template>

<style scoped>
.txn-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 2px;
  border: none;
  background: transparent;
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
}

/* 可点时才是按钮外观；不可点时 div 不应有指针/悬停暗示 */
button.txn-row {
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.txn-row--bill {
  min-height: 56px;
}

.txn-row--search {
  min-height: 64px;
}

.txn-row--drawer {
  min-height: 48px;
}

button.txn-row:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

.txn-row__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.txn-row__top {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

/* 徽章不参与收缩：金额再长也不能把章挤掉 */
.txn-row__badges {
  display: inline-flex;
  flex: none;
  gap: 4px;
}

.txn-row__badge {
  flex: none;
  padding: 1px 7px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
  color: var(--fb-sub);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.6;
  white-space: nowrap;
}

/* 已冲正沿用现网警示配色（与 TransactionsView 的 .txn__badge--reversed 一致） */
.txn-row__badge--reversal {
  background: var(--fb-warn-soft);
  color: var(--fb-warn-ink);
}

.txn-row__badge--transfer {
  background: var(--fb-blue-soft);
  color: var(--fb-blue);
}

.txn-row__badge--opening {
  background: var(--fb-green-soft);
  color: var(--fb-green-ink);
}

.txn-row__badge--neutral {
  background: var(--fb-soft);
  color: var(--fb-sub);
}

.txn-row__title {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 金额吃掉剩余空间并右对齐：保证「徽章 + 金额」同一行、金额永远贴右 */
.txn-row__amount {
  flex: 1 0 auto;
  color: var(--fb-ink);
  font-variant-numeric: var(--fb-font-numeric);
  text-align: right;
  white-space: nowrap;
}

.txn-row__meta {
  min-width: 0;
  color: var(--fb-sub);
  font-size: 11px;
  line-height: 1.5;
}

/* bill：单行 nowrap + ellipsis，375px 下不折行 */
.txn-row__meta--bill {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* search：两行 clamp */
.txn-row__meta--search {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

/* drawer：不截断，允许换行 */
.txn-row__meta--drawer {
  white-space: normal;
  overflow-wrap: anywhere;
}

.txn-row__sep {
  margin: 0 4px;
  color: var(--fb-line-strong);
}

.txn-row__arrow {
  flex: none;
  color: var(--fb-line-strong);
  font-size: 16px;
  line-height: 1;
}

button.txn-row:hover .txn-row__arrow,
button.txn-row:focus-visible .txn-row__arrow {
  color: var(--fb-blue);
}

/*
 * 视觉隐藏但保留在可访问树里（Safari 14 安全的老写法）。
 * 不用 clip-path: inset(50%)（新推荐，但老 Safari 行为不一致），
 * 也不用 display:none / visibility:hidden（会把它从可访问树删除）。
 */
.txn-row__a11y {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
