<script setup lang="ts">
/**
 * 八维筛选网格（T35）：从 / 到 / 类型 / 账户 / 分类 / 标签 / 成员（7 个控件 + 关键词在
 * `SearchBar`，合称「八维」）。
 *
 * 三条口径：
 * 1. **组件不持有筛选状态**：`filters` 受控、每次改动 `emit('change', patch)`，
 *    单一真相源在页面（并最终落到 URL），避免「组件内部一份、URL 一份」。
 * 2. **账户下拉只列资金账户、分类下拉只列分类账户，且都排除已关户**：
 *    与现网流水页一致；把已关户列进去会让人筛出一个注定为空的结果集。
 * 3. **标签/成员选项由页面从「现有交易」里收集后传入**（本组件不 fetch）：
 *    它们在服务端是自由文本，没有独立字典接口。
 */
import type { TransactionFilters } from '@/core/filters'

/** 账户下拉的最小结构（与 `AccountView` 结构兼容，便于直接传 store 数据）。 */
export interface FilterAccountOption {
  id: number
  name: string
  display_name?: string
  type: string
  close_date?: string
}

const props = withDefaults(
  defineProps<{
    /** 当前筛选（受控）。 */
    filters: TransactionFilters
    /** 全部账户；组件内部按类型 / 关户状态分流。 */
    accounts?: FilterAccountOption[]
    /** 可选标签（页面从现有交易收集）。 */
    tags?: string[]
    /** 可选成员（页面从现有交易收集）。 */
    members?: string[]
  }>(),
  {
    accounts: () => [],
    tags: () => [],
    members: () => [],
  },
)

const emit = defineEmits<{
  /** 只回传变化的那几个字段，页面合并进自己的 filters。 */
  change: [patch: Partial<TransactionFilters>]
}>()

function labelOf(account: FilterAccountOption): string {
  const display = account.display_name === undefined ? '' : account.display_name
  return display !== '' ? display : account.name
}

/** 资金账户（付款/收款方）：Assets / Liabilities，且未关户。 */
function fundAccounts(): FilterAccountOption[] {
  return props.accounts.filter(
    (account) =>
      (account.type === 'Assets' || account.type === 'Liabilities') &&
      (account.close_date ?? '') === '',
  )
}

/** 分类账户：Expenses / Income，且未关户。 */
function categoryAccounts(): FilterAccountOption[] {
  return props.accounts.filter(
    (account) =>
      (account.type === 'Expenses' || account.type === 'Income') &&
      (account.close_date ?? '') === '',
  )
}

function onDate(field: 'from' | 'to', event: Event): void {
  const target = event.target as HTMLInputElement | null
  emit('change', { [field]: target === null ? '' : target.value })
}

function onKind(event: Event): void {
  const target = event.target as HTMLSelectElement | null
  const value = target === null ? 'all' : target.value
  emit('change', { kind: value === 'expense' || value === 'income' || value === 'transfer' ? value : 'all' })
}

function onAccount(event: Event): void {
  const target = event.target as HTMLSelectElement | null
  const raw = target === null ? '' : target.value
  emit('change', { account: raw === '' ? null : Number(raw) })
}

function onCategory(event: Event): void {
  const target = event.target as HTMLSelectElement | null
  const raw = target === null ? '' : target.value
  emit('change', { category: raw === '' ? null : Number(raw) })
}

function onTag(event: Event): void {
  const target = event.target as HTMLSelectElement | null
  emit('change', { tag: target === null ? '' : target.value })
}

function onMember(event: Event): void {
  const target = event.target as HTMLSelectElement | null
  emit('change', { member: target === null ? '' : target.value })
}
</script>

<template>
  <div class="search-filters">
    <label class="search-filters__field">
      <span class="search-filters__label">从</span>
      <input
        class="search-filters__control"
        type="date"
        :value="filters.from"
        aria-label="起始日期"
        @change="onDate('from', $event)"
      />
    </label>

    <label class="search-filters__field">
      <span class="search-filters__label">到</span>
      <input
        class="search-filters__control"
        type="date"
        :value="filters.to"
        aria-label="截止日期"
        @change="onDate('to', $event)"
      />
    </label>

    <label class="search-filters__field">
      <span class="search-filters__label">类型</span>
      <select
        class="search-filters__control"
        :value="filters.kind"
        aria-label="类型筛选"
        @change="onKind"
      >
        <option value="all">全部类型</option>
        <option value="expense">支出</option>
        <option value="income">收入</option>
        <option value="transfer">转账</option>
      </select>
    </label>

    <label class="search-filters__field">
      <span class="search-filters__label">账户</span>
      <select
        class="search-filters__control"
        :value="filters.account === null ? '' : String(filters.account)"
        aria-label="账户筛选"
        @change="onAccount"
      >
        <option value="">全部账户</option>
        <option v-for="account in fundAccounts()" :key="account.id" :value="String(account.id)">
          {{ labelOf(account) }}
        </option>
      </select>
    </label>

    <label class="search-filters__field">
      <span class="search-filters__label">分类</span>
      <select
        class="search-filters__control"
        :value="filters.category === null ? '' : String(filters.category)"
        aria-label="分类筛选"
        @change="onCategory"
      >
        <option value="">全部分类</option>
        <option v-for="account in categoryAccounts()" :key="account.id" :value="String(account.id)">
          {{ labelOf(account) }}
        </option>
      </select>
    </label>

    <label class="search-filters__field">
      <span class="search-filters__label">标签</span>
      <select
        class="search-filters__control"
        :value="filters.tag"
        aria-label="标签筛选"
        @change="onTag"
      >
        <option value="">全部标签</option>
        <option v-for="tag in tags" :key="tag" :value="tag">{{ tag }}</option>
      </select>
    </label>

    <label class="search-filters__field">
      <span class="search-filters__label">成员</span>
      <select
        class="search-filters__control"
        :value="filters.member"
        aria-label="成员筛选"
        @change="onMember"
      >
        <option value="">全部成员</option>
        <option v-for="member in members" :key="member" :value="member">{{ member }}</option>
      </select>
    </label>
  </div>
</template>

<style scoped>
/* ≤768 两列，≥769 三列（T35 验收口径） */
.search-filters {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.search-filters__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.search-filters__label {
  color: var(--fb-sub);
  font-size: 11px;
}

.search-filters__control {
  width: 100%;
  min-width: 0;
  min-height: 44px;
  padding: 8px 10px;
  border: 1.5px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 13px;
}

.search-filters__control:focus {
  outline: none;
  border-color: var(--fb-blue);
}

.search-filters__control:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 1px;
}

@media (min-width: 769px) {
  .search-filters {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
