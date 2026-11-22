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
  return '币种数据加载失败'
}

/** 把 409 的四个分项明细拼成中文可读原因（容忍旧响应缺字段）。 */
function usageText(details: CommodityInUseDetails | null): string {
  if (details === null) {
    return ''
  }
  const parts: string[] = []
  const names = details.accounts === undefined ? [] : details.accounts
  if (names.length > 0) {
    parts.push(`${names.length} 个账户设为限定币种（如 ${names[0]}）`)
  }
  const postings = details.postings === undefined ? 0 : details.postings
  const prices = details.prices === undefined ? 0 : details.prices
  if (postings > 0) {
    parts.push(`${postings} 笔交易分录`)
  }
  if (prices > 0) {
    parts.push(`${prices} 条价格`)
  }
  if (details.is_default === true) {
    parts.push('当前账本默认币种：请先在账本设置中改默认币种')
  }
  return parts.join('、')
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
    actionError.value = '请输入币种代码（如 USD，须以大写字母开头）'
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
    notice.value = `币种 ${symbol} 已添加`
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
    notice.value = `币种 ${row.symbol} 已删除（同名再次添加即可恢复）`
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
      <span class="cmd__label">币种管理 · 账本默认 {{ session.defaultCommodity }}</span>
    </header>

    <div v-if="loadError" class="fb-card cmd__state cmd__state--error">
      <p>{{ loadError }}</p>
      <button class="fb-btn-ghost" type="button" @click="load">重新加载</button>
    </div>
    <div v-else-if="loading" class="fb-card cmd__state">正在加载币种数据…</div>

    <template v-else>
      <div class="fb-card cmd__card">
        <h3 class="cmd__title">币种清单（{{ commodities.length }}）</h3>
        <p v-if="commodities.length === 0" class="cmd__empty">账本里还没有登记币种。</p>
        <div v-else class="cmd__tbl-wrap">
          <table class="cmd__table">
            <thead>
              <tr>
                <th>代码</th>
                <th>名称</th>
                <th>精度</th>
                <th>状态</th>
                <th v-if="canWrite">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in commodities" :key="row.uuid">
                <td>
                  {{ row.symbol }}
                  <span v-if="row.is_default === true" class="cmd__main">默认</span>
                </td>
                <td>{{ row.name }}</td>
                <td>{{ row.precision }}</td>
                <td>
                  <span v-if="row.used === true" class="cmd__used">被引用</span>
                  <span v-else class="cmd__free">可删除</span>
                </td>
                <td v-if="canWrite">
                  <button
                    class="fb-btn-ghost cmd__del"
                    type="button"
                    :disabled="busy"
                    @click="remove(row)"
                  >删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="canWrite" class="fb-card cmd__card">
        <h3 class="cmd__title">新增币种</h3>
        <div class="cmd__create">
          <label class="cmd__field">
            <span>币种代码（大写字母开头，如 USD）</span>
            <input v-model="newSymbol" class="fb-input" type="text" placeholder="USD" />
          </label>
          <label class="cmd__field">
            <span>名称（可选，如 美元）</span>
            <input v-model="newName" class="fb-input" type="text" placeholder="美元" />
          </label>
          <button class="fb-btn-primary" type="button" :disabled="busy" @click="submitCreate">
            {{ busy ? '处理中…' : '添加' }}
          </button>
        </div>
        <p class="cmd__hint">精度固定为 2 位（本版不提供精度修改）；同名币种若曾被删除，会恢复原记录而不是新建一条。</p>
      </div>
      <p v-else class="fb-card cmd__hint cmd__viewer">只读成员可查看币种，新增与删除需 editor / owner 权限。</p>

      <p v-if="notice" class="cmd__notice cmd__notice--ok" role="status">{{ notice }}</p>
      <p v-if="actionError" class="cmd__notice cmd__notice--err" role="alert">{{ actionError }}</p>
      <div v-if="usage !== null" class="fb-card cmd__usage" role="alert">
        <p class="cmd__usage-title">无法删除：该币种仍被引用</p>
        <p class="cmd__usage-text">{{ usageText(usage) }}</p>
      </div>

      <div class="fb-card cmd__card">
        <h3 class="cmd__title">余额聚合（只读）</h3>
        <p v-if="rows.length === 0" class="cmd__empty">账本里还没有任何币种余额。</p>
        <div v-else class="cmd__tbl-wrap">
          <table class="cmd__table">
            <thead>
              <tr>
                <th>币种</th>
                <th>总资产</th>
                <th>负债</th>
                <th>净资产</th>
                <th>账户</th>
                <th>交易</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.code">
                <td>{{ row.code }}<span v-if="row.isMain" class="cmd__main">默认</span></td>
                <td><MoneyText :amount="row.assets" :commodity="row.code" size="sm" /></td>
                <td><MoneyText :amount="row.liabilities" :commodity="row.code" size="sm" /></td>
                <td><MoneyText :amount="row.netWorth" :commodity="row.code" size="sm" /></td>
                <td>{{ row.accountCount }}</td>
                <td>{{ row.txnCount }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="cmd__hint">聚合口径来自账户余额与交易分录，与后端删除门禁的引用检查相互独立。</p>
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
