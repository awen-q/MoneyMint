<script setup lang="ts">
/**
 * 账单日历点日的当日交易抽屉（老板 2026-11 决策）。
 *
 * - 只负责**展示**：交易由父级按日筛好后传进来（`txns`），本组件不再按日期
 *   过滤一遍，也不碰外部列表；外部整月列表恒定的保证在 `BillsView.groups`。
 * - 行用 `TxnRow` 的 `drawer` 档：副行不截断（日期 / 类型 / 分类 / 账户 /
 *   全部标签 / 成员都能看到）。`drawer` 档默认不可点，但这里没有嵌套按钮，
 *   显式 `interactive` 打开整行激活，沿用列表的详情跳转。
 * - 遮罩 / ESC / 关闭按钮 / body 滚动锁 / focus trap 全部复用 `SelectSheet`，
 *   本组件不自建第二套锁（两套锁互清样式会导致关闭后页面跳顶）。
 * - 金额走 `MoneyText`，隐私遮罩沿用 privacy store，组件不读真值。
 */
import { computed } from 'vue'

import type { AccountView, TransactionView } from '@/api/types'
import { buildTxnRow } from '@/core/txnRow'
import TxnRow from '@/components/TxnRow.vue'
import SelectSheet from '@/components/shell/SelectSheet.vue'

const props = defineProps<{
  /** 是否打开（父级用 `activeDay !== null` 推导）。 */
  open: boolean
  /** 月份（1..12），标题用。 */
  month: number
  /** 当前日（1..31）；`null` 表示关闭。 */
  day: number | null
  /** 当日交易（父级已按日筛好）。 */
  txns: TransactionView[]
  /** 账户清单，供 `buildTxnRow` 判定类型与展示名。 */
  accounts: AccountView[]
}>()

const emit = defineEmits<{
  /** 遮罩 / ESC / 关闭按钮统一请求关闭。 */
  close: []
  /** 行被激活，父级沿用 openDetail 跳交易详情。 */
  'open-detail': [id: number]
}>()

/** 抽屉内的行视图模型：同批数据、drawer 档（不截断、标签全量）。 */
const rows = computed(() =>
  props.txns
    .slice()
    .sort((left, right) => right.id - left.id)
    .map((txn) => buildTxnRow(txn, props.accounts, 'drawer')),
)

const title = computed(() =>
  props.day === null
    ? '当日交易'
    : `${props.month}月${props.day}日 · ${rows.value.length} 笔`,
)
</script>

<template>
  <SelectSheet
    :open="open"
    :title="title"
    dialog-label="当日交易明细"
    data-testid="day-transactions-sheet"
    @close="emit('close')"
  >
    <p v-if="rows.length === 0" class="daytx__empty" role="status">当日无交易</p>
    <ul v-else class="daytx__list">
      <li v-for="row in rows" :key="row.id" class="daytx__item">
        <TxnRow
          :view="row"
          variant="drawer"
          :interactive="true"
          @open="emit('open-detail', row.id)"
        />
      </li>
    </ul>
  </SelectSheet>
</template>

<style scoped>
.daytx__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.daytx__item + .daytx__item {
  border-top: 1px solid var(--fb-line);
}

.daytx__empty {
  margin: 0;
  padding: 24px 0;
  color: var(--fb-sub);
  font-size: 13px;
  text-align: center;
}
</style>
