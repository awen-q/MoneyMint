<script setup lang="ts">
/**
 * P-10 币种管理（0.6.0 S2：只读聚合 → 可增删）
 *
 * - 上半区沿用账户余额 / 交易分录聚合（资产 / 负债 / 净资产小计）；
 * - 下半区走新增的 GET/POST /api/commodities 与 DELETE /api/commodities/{uuid}：
 *   展示 uuid / symbol / name / precision / 是否被引用 / 是否默认币种，
 *   owner / editor 可增删，viewer 隐藏全部写操作；
 * - 409 commodity_in_use 时把 accounts[] / postings / prices / is_default
 *   渲染成中文可读原因，默认币种明确提示「请先在账本设置中改默认币种」；
 * - 本版不提供 precision 修改（D-06），新增一律由后端按 2 处理。
 */
import { computed, onMounted, ref, watch } from 'vue'

import { accountApi, commodityApi, transactionApi } from '@/api/client'
import { ApiError, codeMessage } from '@/api/errors'
import type { AccountView, CommodityInUseDetails, CommodityView, TransactionView } from '@/api/types'
import { computeBalanceSummary, type SummaryAccount } from '@/core/record'
import { t } from '@/i18n'
import { useSessionStore } from '@/stores/session'
import MoneyText from '@/components/MoneyText.vue'

const session = useSessionStore()

const accounts = ref<AccountView[]>([])
const transactions = ref<TransactionView[]>([])
const commodities = ref<CommodityView[]>([])
const loading = ref(false)
const loadError = ref('')
const notice = ref('')
const actionError = ref('')
const busy = ref(false)

const newSymbol = ref('')
const newName = ref('')
const usage = ref<CommodityInUseDetails | null>(null)

const canWrite = computed(() => !session.isViewer)

const summary = computed(() =>
  computeBalanceSummary(accounts.value as SummaryAccount[], session.defaultCommodity),
)

interface CommodityRow {
  code: string
  assets: string
  liabilities: string
  netWorth: string
  accountCount: number
  txnCount: number
  isMain: boolean
}

const rows = computed<CommodityRow[]>(() => {
  const codes: string[] = []
  for (const account of accounts.value) {
    const balances = account.balances
    if (balances === undefined) {
      continue
    }
    for (const code of Object.keys(balances)) {
      if (codes.indexOf(code) < 0) {
        codes.push(code)
      }
    }
  }
  for (const txn of transactions.value) {
    for (const posting of txn.postings) {
      if (posting.commodity !== '' && codes.indexOf(posting.commodity) < 0) {
        codes.push(posting.commodity)
      }
    }
  }
  const main = summary.value.commodity
  const out: CommodityRow[] = []
  for (const code of codes) {
    const assets = summary.value.assets[code] === undefined ? '0.00' : summary.value.assets[code]
    const liabilities =
      summary.value.liabilities[code] === undefined ? '0.00' : summary.value.liabilities[code]
    const netWorth = summary.value.netWorth[code] === undefined ? '0.00' : summary.value.netWorth[code]
    let accountCount = 0
    for (const account of accounts.value) {
      const balances = account.balances
      if (balances !== undefined && balances[code] !== undefined) {
        accountCount += 1
      }
    }
    let txnCount = 0
    for (const txn of transactions.value) {
      let hit = false
      for (const posting of txn.postings) {
        if (posting.commodity === code) {
          hit = true
        }
      }
      if (hit) {
        txnCount += 1
      }
    }
    out.push({ code, assets, liabilities, netWorth, accountCount, txnCount, isMain: code === main })
  }
  // 主币种排最前，其余按字母序。
  return out.sort((a, b) => {
    if (a.isMain !== b.isMain) {
      return a.isMain ? -1 : 1
    }
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0
  })
})

/** 稳定错误码优先走集中映射，未知码回退后端中文文案。 */
function messageOf(err: unknown): string {
  if (err instanceof ApiError) {
    const mapped = err.code === undefined ? '' : codeMessage(err.code)
    return mapped !== '' ? mapped : err.message
  }
  return t('commodities.errLoad')
}

/** 把 409 的四个分项明细拼成中文可读原因（容忍旧响应缺字段）。 */
function usageText(details: CommodityInUseDetails | null): string {
  if (details === null) {
    return ''
  }
  const parts: string[] = []
  const names = details.accounts === undefined ? [] : details.accounts
  if (names.length > 0) {
    parts.push(t('commodities.usageAccounts', { n: String(names.length), name: names[0] }))
  }
  const postings = details.postings === undefined ? 0 : details.postings
  const prices = details.prices === undefined ? 0 : details.prices
  if (postings > 0) {
    parts.push(t('commodities.usagePostings', { n: String(postings) }))
  }
  if (prices > 0) {
    parts.push(t('commodities.usagePrices', { n: String(prices) }))
  }
  if (details.is_default === true) {
    parts.push(t('commodities.usageDefault'))
  }
  return parts.join(t('commodities.usageSeparator'))
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const [accountRes, txnRes, cmdRes] = await Promise.all([
      accountApi.list({ includeClosed: true }),
      transactionApi.list(),
      commodityApi.list(),
    ])
    accounts.value = Array.isArray(accountRes.accounts) ? accountRes.accounts : []
    transactions.value = Array.isArray(txnRes.transactions) ? txnRes.transactions : []
    commodities.value = Array.isArray(cmdRes.commodities) ? cmdRes.commodities : []
  } catch (err) {
    loadError.value = messageOf(err)
  } finally {
    loading.value = false
  }
}

async function submitCreate(): Promise<void> {
  if (busy.value || !canWrite.value) {
    return
  }
  const symbol = newSymbol.value.trim()
  if (symbol === '') {
    actionError.value = t('commodities.errSymbolRequired')
    return
  }
  busy.value = true
  actionError.value = ''
  notice.value = ''
  usage.value = null
  try {
    await commodityApi.create({ symbol, name: newName.value.trim() })
    newSymbol.value = ''
    newName.value = ''
    notice.value = t('commodities.noticeCreated', { symbol })
    await load()
  } catch (err) {
    actionError.value = messageOf(err)
  } finally {
    busy.value = false
  }
}

async function remove(row: CommodityView): Promise<void> {
  if (busy.value || !canWrite.value) {
    return
  }
  busy.value = true
  actionError.value = ''
  notice.value = ''
  usage.value = null
  try {
    await commodityApi.remove(row.uuid)
    notice.value = t('commodities.noticeRemoved', { symbol: row.symbol })
    await load()
  } catch (err) {
    actionError.value = messageOf(err)
    if (err instanceof ApiError && err.details !== undefined) {
      usage.value = err.details as unknown as CommodityInUseDetails
    }
  } finally {
    busy.value = false
  }
}

watch(
  () => session.ledgerId,
  () => {
    accounts.value = []
    transactions.value = []
    commodities.value = []
    void load()
  },
)

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="cmd">
    <header class="cmd__hero fb-hero">
      <span class="cmd__label">{{ t('commodities.title', { commodity: session.defaultCommodity }) }}</span>
    </header>

    <div v-if="loadError" class="fb-card cmd__state cmd__state--error">
      <p>{{ loadError }}</p>
      <button class="fb-btn-ghost" type="button" @click="load">{{ t('commodities.reload') }}</button>
    </div>
    <div v-else-if="loading" class="fb-card cmd__state">{{ t('commodities.loading') }}</div>

    <template v-else>
      <div class="fb-card cmd__card">
        <h3 class="cmd__title">{{ t('commodities.listTitle', { n: String(commodities.length) }) }}</h3>
        <p v-if="commodities.length === 0" class="cmd__empty">{{ t('commodities.listEmpty') }}</p>
        <div v-else class="cmd__tbl-wrap">
          <table class="cmd__table">
            <thead>
              <tr>
                <th>{{ t('commodities.colCode') }}</th>
                <th>{{ t('commodities.colName') }}</th>
                <th>{{ t('commodities.colPrecision') }}</th>
                <th>{{ t('commodities.colStatus') }}</th>
                <th v-if="canWrite">{{ t('commodities.colActions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in commodities" :key="row.uuid">
                <td>
                  {{ row.symbol }}
                  <span v-if="row.is_default === true" class="cmd__main">{{ t('commodities.default') }}</span>
                </td>
                <td>{{ row.name }}</td>
                <td>{{ row.precision }}</td>
                <td>
                  <span v-if="row.used === true" class="cmd__used">{{ t('commodities.used') }}</span>
                  <span v-else class="cmd__free">{{ t('commodities.free') }}</span>
                </td>
                <td v-if="canWrite">
                  <button
                    class="fb-btn-ghost cmd__del"
                    type="button"
                    :disabled="busy"
                    @click="remove(row)"
                  >{{ t('commodities.delete') }}</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="canWrite" class="fb-card cmd__card">
        <h3 class="cmd__title">{{ t('commodities.createTitle') }}</h3>
        <div class="cmd__create">
          <label class="cmd__field">
            <span>{{ t('commodities.symbolLabel') }}</span>
            <input v-model="newSymbol" class="fb-input" type="text" placeholder="USD" />
          </label>
          <label class="cmd__field">
            <span>{{ t('commodities.nameLabel') }}</span>
            <input v-model="newName" class="fb-input" type="text" :placeholder="t('commodities.namePlaceholder')" />
          </label>
          <button class="fb-btn-primary" type="button" :disabled="busy" @click="submitCreate">
            {{ busy ? t('commodities.working') : t('commodities.add') }}
          </button>
        </div>
        <p class="cmd__hint">{{ t('commodities.createHint') }}</p>
      </div>
      <p v-else class="fb-card cmd__hint cmd__viewer">{{ t('commodities.viewerHint') }}</p>

      <p v-if="notice" class="cmd__notice cmd__notice--ok" role="status">{{ notice }}</p>
      <p v-if="actionError" class="cmd__notice cmd__notice--err" role="alert">{{ actionError }}</p>
      <div v-if="usage !== null" class="fb-card cmd__usage" role="alert">
        <p class="cmd__usage-title">{{ t('commodities.inUseTitle') }}</p>
        <p class="cmd__usage-text">{{ usageText(usage) }}</p>
      </div>

      <div class="fb-card cmd__card">
        <h3 class="cmd__title">{{ t('commodities.summaryTitle') }}</h3>
        <p v-if="rows.length === 0" class="cmd__empty">{{ t('commodities.summaryEmpty') }}</p>
        <div v-else class="cmd__tbl-wrap">
          <table class="cmd__table">
            <thead>
              <tr>
                <th>{{ t('commodities.colCommodity') }}</th>
                <th>{{ t('commodities.colAssets') }}</th>
                <th>{{ t('commodities.colLiabilities') }}</th>
                <th>{{ t('commodities.colNetWorth') }}</th>
                <th>{{ t('commodities.colAccounts') }}</th>
                <th>{{ t('commodities.colTxns') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.code">
                <td>{{ row.code }}<span v-if="row.isMain" class="cmd__main">{{ t('commodities.default') }}</span></td>
                <td><MoneyText :amount="row.assets" :commodity="row.code" size="sm" /></td>
                <td><MoneyText :amount="row.liabilities" :commodity="row.code" size="sm" /></td>
                <td><MoneyText :amount="row.netWorth" :commodity="row.code" size="sm" /></td>
                <td>{{ row.accountCount }}</td>
                <td>{{ row.txnCount }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="cmd__hint">{{ t('commodities.summaryHint') }}</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.cmd {
  padding-bottom: 20px;
}

.cmd__hero {
  padding: calc(20px + env(safe-area-inset-top, 0px)) 20px 20px;
  border-radius: 0 0 24px 24px;
}

.cmd__label {
  font-size: 15px;
  font-weight: 700;
}

.cmd__card {
  margin-top: 14px;
  padding: 14px 16px;
}

.cmd__title {
  margin: 0 0 10px;
  font-size: 14px;
}

/* 金额列（MoneyText）在移动端必然超出卡片宽度：容器横向滚动，
   表格保住最小可用宽度不被压缩（与 PostingPreview 的滚动容器同约定）。 */
.cmd__tbl-wrap {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.cmd__table {
  width: 100%;
  min-width: 420px;
  border-collapse: collapse;
  font-size: 12px;
  /* 账户数 / 交易数数字列与 MoneyText 金额列同口径。 */
  font-variant-numeric: var(--fb-font-numeric);
}

.cmd__table th,
.cmd__table td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid var(--fb-line);
  white-space: nowrap;
}

.cmd__table th {
  font-size: 11px;
  color: var(--fb-sub);
  font-weight: 600;
}

.cmd__main {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-blue-soft);
  color: var(--fb-blue);
  font-size: 10px;
}

.cmd__used {
  color: var(--fb-warn);
  font-size: 11px;
}

.cmd__free {
  color: var(--fb-green);
  font-size: 11px;
}

.cmd__del {
  padding: 4px 10px;
  font-size: 11px;
  color: var(--fb-danger);
}

.cmd__create {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
}

.cmd__field {
  flex: 1;
  min-width: 130px;
  font-size: 12px;
  color: var(--fb-sub);
}

.cmd__field span {
  display: block;
  margin-bottom: 4px;
}

.cmd__field .fb-input {
  width: 100%;
}

.cmd__empty {
  margin: 0;
  padding: 16px 0;
  text-align: center;
  font-size: 12px;
  color: var(--fb-sub);
}

.cmd__hint {
  margin: 12px 0 0;
  font-size: 11px;
  color: var(--fb-sub);
  line-height: 1.7;
}

.cmd__viewer {
  padding: 12px 16px;
}

.cmd__notice {
  margin: 10px 4px 0;
  padding: 8px 12px;
  border-radius: var(--fb-radius-input);
  font-size: 12px;
}

.cmd__notice--ok {
  background: var(--fb-green-soft);
  color: var(--fb-green-ink);
}

.cmd__notice--err {
  background: var(--fb-danger-soft);
  color: var(--fb-danger-ink);
}

.cmd__usage {
  margin-top: 10px;
  padding: 12px 16px;
  border: 1px solid var(--fb-warn);
}

.cmd__usage-title {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fb-danger);
}

.cmd__usage-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--fb-sub);
}

.cmd__state {
  margin-top: 14px;
  padding: 20px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--fb-sub);
}

.cmd__state--error {
  color: var(--fb-danger);
}

.cmd__state p {
  margin: 0 0 12px;
}
</style>
