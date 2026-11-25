<script setup lang="ts">
/**
 * 搜索账单（B3 / T37）
 *
 * 本页的难点只有一个：**服务端 keyset 分页下的「筛选 × 乱序响应」**。
 * 四条约束一起才成立：
 *
 * 1. **两个 loading 标志**。`loading`（首屏/换筛选）与 `loadingMore`（追加）必须分开：
 *    共用一个会让「加载更多」时整张列表闪成骨架屏，用户以为刚才的结果没了。
 * 2. **游标只表达位置**。除了 `cursor`，其余筛选参数每次都要原样带上——否则
 *    「第二页按另一套条件查」这种错会以「结果重复/缺失」的形式出现，很难归因。
 * 3. **代际丢弃（`gen`）优先于 abort**。`AbortController` 只能取消还在飞行的请求，
 *    已经发出、正在解析的响应照旧会回来；只看 abort 会留下时序窗口。所以响应回来
 *    先比 `gen`，不等就整包丢掉。
 * 4. **共 N 笔取 `total`**，不是 `items.length`——分页后那是本页数量。
 *
 * 另外两条产品级约束：
 * - **空态时搜索框与筛选条必须留在 `StateCard` 之外**：空态不能让人失去出口
 *   （这条与账单页 hero/工具卡同一条理由，且有测试守着）；
 * - **CSV 走 `limit: 0` 二次全量拉取**：拿内存里那 20 行导出，用户会得到一个
 *   「看着成功、只有 20 行」的文件，可能几周后才发现。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { transactionApi } from '@/api/client'
import type { TransactionListPage, TransactionSummary, TransactionView } from '@/api/types'
import { buildCsvRowsFromTransactions, buildTransactionsCsv, downloadCsv } from '@/core/csv'
import {
  emptyFilters,
  filtersFromQuery,
  filtersToQuery,
  filtersToServerQuery,
  hasActiveFilters,
  type TransactionFilters,
} from '@/core/filters'
import { accountLabel } from '@/core/record'
import { buildTxnRow, type TxnRowView } from '@/core/txnRow'
import { t } from '@/i18n'
import { useLedgerDataStore } from '@/stores/ledgerData'
import MoneyText from '@/components/MoneyText.vue'
import SearchBar from '@/components/search/SearchBar.vue'
import SearchFilters from '@/components/search/SearchFilters.vue'
import StateCard from '@/components/shell/StateCard.vue'
import TxnRow from '@/components/TxnRow.vue'

/** 每页条数（单点常量，调大只改这一行）。 */
const PAGE_SIZE = 20

const route = useRoute()
const router = useRouter()
const data = useLedgerDataStore()

const filters = reactive<TransactionFilters>(filtersFromQuery(route.query))

const items = ref<TransactionView[]>([])
const cursor = ref<string | null>(null)
const hasMore = ref(false)
const summary = ref<TransactionSummary | null>(null)
const loading = ref(false)
const loadingMore = ref(false)
const loadError = ref('')
const notice = ref('')

/** 代际：每次筛选变化自增，响应回来先比它（见文件头第 3 条）。 */
let gen = 0
let controller: AbortController | null = null
/** 回填 URL 时抑制「变更 → 重查」，避免 URL ↔ 状态互踢成环。 */
let restoring = false

onMounted(() => {
  // 筛选项（标签 / 成员）从既有交易里收集，走账本数据单例，不额外发请求。
  void data.ensure()
  void loadFirst()
})

/** 服务端参数（**白名单唯一来源是 `filtersToServerQuery`**，这里只做类型转换）。 */
function baseQuery(): Record<string, string | number | undefined> {
  const raw = filtersToServerQuery(filters)
  const query: Record<string, string | number | undefined> = {}
  if (raw.from !== undefined) query.from = raw.from
  if (raw.to !== undefined) query.to = raw.to
  if (raw.kind !== undefined) query.kind = raw.kind
  if (raw.account !== undefined) query.account = Number(raw.account)
  if (raw.category !== undefined) query.category = Number(raw.category)
  if (raw.member !== undefined) query.member = raw.member
  if (raw.tag !== undefined) query.tag = raw.tag
  if (raw.q !== undefined) query.q = raw.q
  return query
}

/** 首屏 / 换筛选：清空游标与列表，代际 +1，abort 上一笔。 */
async function loadFirst(): Promise<void> {
  gen += 1
  const myGen = gen
  controller?.abort()
  controller = new AbortController()
  loading.value = true
  loadingMore.value = false
  loadError.value = ''
  items.value = []
  cursor.value = null
  hasMore.value = false
  summary.value = null
  try {
    const page = await transactionApi.listPage(
      // 只在首屏带 `with: 'summary'`：汇总口径是筛选全集，翻页时不必再算一遍。
      { ...baseQuery(), limit: PAGE_SIZE, with: 'summary' },
      { signal: controller.signal },
    )
    if (myGen !== gen) {
      return
    }
    applyPage(page)
  } catch (err) {
    if (myGen !== gen) {
      return
    }
    loadError.value = err instanceof Error ? err.message : t('search.errSearch')
  } finally {
    if (myGen === gen) {
      loading.value = false
    }
  }
}

/** 追加下一页：**不带 reset**，且筛选参数原样带上。 */
async function loadMore(): Promise<void> {
  if (cursor.value === null || loadingMore.value || loading.value) {
    return
  }
  const myGen = gen
  const pageCursor = cursor.value
  loadingMore.value = true
  try {
    const page = await transactionApi.listPage({
      ...baseQuery(),
      limit: PAGE_SIZE,
      cursor: pageCursor,
    })
    if (myGen !== gen) {
      return
    }
    items.value = items.value.concat(page.transactions)
    cursor.value = page.next_cursor === undefined ? null : page.next_cursor
    hasMore.value = page.has_more === true
  } catch (err) {
    if (myGen !== gen) {
      return
    }
    loadError.value = err instanceof Error ? err.message : t('search.errMore')
  } finally {
    if (myGen === gen) {
      loadingMore.value = false
    }
  }
}

function applyPage(page: TransactionListPage): void {
  items.value = page.transactions
  cursor.value = page.next_cursor === undefined ? null : page.next_cursor
  hasMore.value = page.has_more === true
  // 汇总缺失（服务端未带 `with=summary` 或旧响应）时保持 null —— 页面整块不渲染，
  // **不要**退回 `total ?? 0` 或 `items.length`：那会显示一个错的笔数。
  summary.value = page.summary === undefined ? null : page.summary
}

/**
 * 筛选变化：同步 URL + 重查首屏。
 *
 * 注意名字：**不要**叫 `applyFilters` —— 那会与（已删除的）`core/filters.applyFilters`
 * 同名，grep 时会让人以为页面还在用本地过滤实现。
 */
function applyFiltersAndReload(): void {
  if (restoring) {
    return
  }
  void router.replace({ query: filtersToQuery({ ...filters }) })
  void loadFirst()
}

function onSearch(keyword: string): void {
  if (filters.keyword === keyword) {
    // 同一个关键词重复提交（防抖与回车撞在一起）不必重查。
    return
  }
  filters.keyword = keyword
  applyFiltersAndReload()
}

function onFilterChange(patch: Partial<TransactionFilters>): void {
  Object.assign(filters, patch)
  applyFiltersAndReload()
}

function onRemoveChip(key: string): void {
  const empty = emptyFilters()
  if (key === 'from') filters.from = empty.from
  else if (key === 'to') filters.to = empty.to
  else if (key === 'kind') filters.kind = empty.kind
  else if (key === 'account') filters.account = empty.account
  else if (key === 'category') filters.category = empty.category
  else if (key === 'member') filters.member = empty.member
  else if (key === 'tag') filters.tag = empty.tag
  else if (key === 'keyword') filters.keyword = empty.keyword
  applyFiltersAndReload()
}

function onClear(): void {
  Object.assign(filters, emptyFilters())
  applyFiltersAndReload()
}

// AC-16：浏览器前进/后退、外部链接变化时从 URL 还原。
watch(
  () => route.query,
  () => {
    restoring = true
    Object.assign(filters, filtersFromQuery(route.query))
    restoring = false
    void loadFirst()
  },
)

const rows = computed<TxnRowView[]>(() =>
  items.value.map((txn) => buildTxnRow(txn, data.accounts, 'search')),
)

/** 空态 / 错误态的说明文案（标题用 StateCard 默认）。 */
const cardDesc = computed(() => {
  if (loadError.value !== '') {
    return t('common.networkRetry')
  }
  if (items.value.length === 0 && !loading.value) {
    return hasActiveFilters(filters) ? t('search.emptyFiltered') : t('search.emptyAll')
  }
  return ''
})

const pageState = computed<'loading' | 'error' | 'empty' | 'ready'>(() => {
  if (loadError.value !== '') {
    return 'error'
  }
  if (loading.value) {
    return 'loading'
  }
  if (items.value.length === 0) {
    return 'empty'
  }
  return 'ready'
})

/**
 * 账户 / 分类 id → 展示名。
 *
 * `filters.account` / `filters.category` 只存 id（URL 里也只该有 id），但 chips 是给人看的：
 * 直接渲染 `账户 id：3` 用户读不懂（这是审计 P1）。名称一律走 `core/record.ts` 的
 * `accountLabel`（`display_name` 优先），**不在页面里再抄一份取名逻辑**。
 *
 * 查不到时**不留空**：账户被删 / 关户后不在 `data.accounts` 里，此时显示
 * `#3（已删除）`——保留 id 才能和 URL、Exporter 对照，标注「已删除」才不会让人
 * 以为筛选失效。
 */
function labelOfAccountId(id: number): string {
  for (const account of data.accounts) {
    if (account.id === id) {
      return accountLabel(account)
    }
  }
  return t('search.deletedAccount', { id: String(id) })
}

/** 已选条件 chips（`key` 用于单独移除）。 */
const chips = computed<Array<{ key: string; label: string }>>(() => {
  const out: Array<{ key: string; label: string }> = []
  if (filters.keyword.trim() !== '') {
    out.push({ key: 'keyword', label: t('search.chipKeyword', { value: filters.keyword }) })
  }
  if (filters.from !== '' || filters.to !== '') {
    const anyDate = t('search.anyDate')
    out.push({
      key: 'from',
      label: t('search.chipDate', {
        from: filters.from === '' ? anyDate : filters.from,
        to: filters.to === '' ? anyDate : filters.to,
      }),
    })
  }
  if (filters.kind !== 'all') {
    const map: Record<string, string> = {
      expense: t('common.expense'),
      income: t('common.income'),
      transfer: t('core.txnRow.kindTransfer'),
    }
    out.push({ key: 'kind', label: t('search.chipKind', { value: map[filters.kind] ?? filters.kind }) })
  }
  if (filters.account !== null) {
    out.push({ key: 'account', label: t('search.chipAccount', { value: labelOfAccountId(filters.account) }) })
  }
  if (filters.category !== null) {
    out.push({ key: 'category', label: t('search.chipCategory', { value: labelOfAccountId(filters.category) }) })
  }
  if (filters.tag !== '') out.push({ key: 'tag', label: t('search.chipTag', { value: filters.tag }) })
  if (filters.member !== '') out.push({ key: 'member', label: t('search.chipMember', { value: filters.member }) })
  return out
})

/** 标签选项：从既有交易里收集去重（服务端没有标签字典接口）。 */
const tagOptions = computed(() => {
  const out: string[] = []
  for (const txn of data.txns) {
    const tags = txn.tags === undefined ? [] : txn.tags
    for (const tag of tags) {
      if (tag !== '' && out.indexOf(tag) < 0) {
        out.push(tag)
      }
    }
  }
  return out.sort()
})

/** 成员选项：同上。 */
const memberOptions = computed(() => {
  const out: string[] = []
  for (const txn of data.txns) {
    if (txn.created_by_name !== '' && out.indexOf(txn.created_by_name) < 0) {
      out.push(txn.created_by_name)
    }
  }
  return out.sort()
})

/**
 * 标签 / 成员选项（批 I 两段加载守卫）：
 * 这两个全集来自 `data.txns` 全量快照；补齐完成前只有「已拉窗口」的月份，
 * 拿半集当全集会让用户以为「没有别的标签可选」。守 `fullReady`：
 * 补齐中先给基础项（空选项），补齐完成后恢复现行全集。执行与 CSV 不受影响
 * （它们走服务端 listPage，不依赖本地快照）。
 */
const filterTags = computed<string[]>(() => (data.fullReady ? tagOptions.value : []))
const filterMembers = computed<string[]>(() => (data.fullReady ? memberOptions.value : []))

function goBills(): void {
  void router.push({ name: 'bills' })
}

function openDetail(id: number): void {
  void router.push({ name: 'transaction-detail', query: { id: String(id) } })
}

/**
 * CSV 导出：**必须 `limit: 0` 二次全量拉取**，不复用分页状态。
 * 用内存里已加载的 20 行导出会得到「看着成功、只有 20 行」的文件。
 */
async function exportCsv(): Promise<void> {
  notice.value = ''
  try {
    const page = await transactionApi.listPage({ ...baseQuery(), limit: 0 })
    const rows = buildCsvRowsFromTransactions(page.transactions, data.accounts)
    downloadCsv('family-ledger-search.csv', buildTransactionsCsv(rows))
    notice.value = t('search.csvDone', { count: String(page.transactions.length) })
  } catch (err) {
    notice.value = err instanceof Error ? err.message : t('search.csvFailed')
  }
}
</script>

<template>
  <section class="search">
    <!-- 移动端二级页返回条（稿 `page-search` 的 back-bar only-mobile）：≤899 显示，PC 隐藏。
         用 router.push 而不是 history.back()：用户可能是直接打开分享链接进来，
         back() 会把他退出应用。 -->
    <div class="search__back">
      <button type="button" class="search__back-btn" @click="goBills">{{ t('search.backToBills') }}</button>
    </div>

    <header class="search__hero">
      <h1 class="search__title">{{ t('shell.nav.search') }}</h1>
    </header>

    <!-- 搜索卡在四态之外：空态不能让人失去出口（改到 StateCard 里，用例会红） -->
    <section class="search__card">
      <SearchBar
        :keyword="filters.keyword"
        :chips="chips"
        @search="onSearch"
        @remove-chip="onRemoveChip"
        @clear="onClear"
      >
        <SearchFilters
          :filters="filters"
          :accounts="data.accounts"
          :tags="filterTags"
          :members="filterMembers"
          @change="onFilterChange"
        />
      </SearchBar>
    </section>

    <!-- 汇总卡（T36）：口径是**筛选全集**，与翻到第几页无关；summary 缺失时整块不渲染。
         `aria-live="polite"`（稿 938）让读屏用户在换筛选后听到新的笔数，而不是
         自己再跑去翻列表。 -->
    <section v-if="summary !== null" class="search__summary" :aria-label="t('search.summaryLabel')" aria-live="polite">
      <!-- 笔数不是金额，隐私遮挡时**不遮**（用户仍需要知道筛出了多少笔） -->
      <p class="search__summary-total">{{ t('search.total', { total: String(summary.total) }) }}</p>
      <ul class="search__summary-list">
        <li
          v-for="row in summary.by_commodity"
          :key="row.commodity"
          class="search__summary-row"
        >
          <span class="search__summary-chip">{{ row.commodity }}</span>
          <span class="search__summary-label">{{ t('common.income') }}</span>
          <MoneyText :amount="row.income" :commodity="row.commodity" size="sm" />
          <span class="search__summary-label">{{ t('common.expense') }}</span>
          <MoneyText :amount="row.expense" :commodity="row.commodity" size="sm" />
        </li>
      </ul>
    </section>

    <p v-if="notice" class="search__notice" role="status">{{ notice }}</p>

    <StateCard :state="pageState" :desc="cardDesc" @action="loadFirst">
      <section class="search__result">
        <header class="search__result-head">
          <span class="search__result-title">{{ t('search.results') }}</span>
          <span class="search__result-actions">
            <button type="button" class="search__export" @click="exportCsv">{{ t('search.exportCsv') }}</button>
          </span>
        </header>

        <ul class="search__rows">
          <li v-for="row in rows" :key="row.id" class="search__row">
            <TxnRow :view="row" variant="search" @open="openDetail(row.id)" />
          </li>
        </ul>

        <div v-if="hasMore" class="search__more">
          <button
            type="button"
            class="search__more-btn"
            :disabled="loadingMore"
            @click="loadMore"
          >{{ loadingMore ? t('common.loading') : t('search.loadMore') }}</button>
        </div>
      </section>
    </StateCard>
  </section>
</template>

<style scoped>
.search {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.search__back {
  display: flex;
}

.search__back-btn {
  min-height: 44px;
  padding: 8px 12px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-card);
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.search__back-btn:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

/* PC 无移动端返回条（稿：only-mobile） */
@media (min-width: 900px) {
  .search__back {
    display: none;
  }
}

.search__hero {
  padding: 4px 0 2px;
}

.search__title {
  margin: 0;
  color: var(--fb-ink-deep);
  font-size: 20px;
  font-weight: 800;
}

.search__card {
  padding: 12px;
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

.search__summary {
  padding: 12px;
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

.search__summary-total {
  margin: 0 0 6px;
  color: var(--fb-ink-deep);
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: var(--fb-font-numeric);
}

.search__summary-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.search__summary-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  color: var(--fb-sub);
  font-size: 12px;
}

.search__summary-chip {
  padding: 1px 8px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
  color: var(--fb-sub);
  font-size: 11px;
  font-weight: 600;
}

.search__summary-label {
  color: var(--fb-sub);
}

.search__notice {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--fb-radius-input);
  background: var(--fb-soft);
  color: var(--fb-sub);
  font-size: 12px;
}

.search__result {
  padding: 12px;
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

.search__result-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--fb-line);
}

.search__result-title {
  color: var(--fb-ink-deep);
  font-size: 14px;
  font-weight: 700;
}

.search__result-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.search__export {
  min-height: 32px;
  padding: 4px 10px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-card);
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.search__rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

.search__row + .search__row {
  border-top: 1px solid var(--fb-line);
}

.search__more {
  display: flex;
  justify-content: center;
  padding-top: 10px;
}

.search__more-btn {
  min-height: 44px;
  padding: 8px 20px;
  border: 1px solid var(--fb-blue);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-card);
  color: var(--fb-blue);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.search__more-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.search__export:focus-visible,
.search__more-btn:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}
</style>
