<script setup lang="ts">
/**
 * P-07 账户列表（批 2）：按 Assets / Liabilities 分组 + 余额小计
 * （口径与首页 balanceAccounts 一致：Σ 后端带符号余额，负债组为负）。
 *
 * 0.6.0 S2：账户行新增「＋ 增加下级」入口，打开 AccountForm 并预填父账户，
 * 提交后 parent_uuid 落库、树形层级刷新不退化（AC-2.1 / AC-2.5）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { accountApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { AccountView } from '@/api/types'
import { balanceOf, buildAccountTree, flattenAccountTree, groupAccountsByType, isClosed } from '@/core/accounts'
import { accountLabel } from '@/core/record'
import { t } from '@/i18n'
import { usePrivacyStore } from '@/stores/privacy'
import { useSessionStore } from '@/stores/session'
import MoneyText from '@/components/MoneyText.vue'
import AccountForm from '@/components/AccountForm.vue'

const router = useRouter()
const session = useSessionStore()
const privacy = usePrivacyStore()

const accounts = ref<AccountView[]>([])
const loading = ref(false)
const loadError = ref('')
const notice = ref('')

/** 0.6.0 S2：本地挂载新建 / 增加下级表单；parent 非空即「增加下级」。 */
const showForm = ref(false)
const formParent = ref<AccountView | null>(null)

/** 批 2.5 修 2b：层级树渲染（parent_uuid 优先 / 冒号兜底；父行小计含子聚合）。 */
const groups = computed(() =>
  groupAccountsByType(accounts.value, ['Assets', 'Liabilities']).map((group) => ({
    type: group.type,
    label: group.label,
    subtotal: group.subtotal,
    rows: flattenAccountTree(buildAccountTree(group.items)),
  })),
)

function subtotalOf(group: { subtotal: Record<string, string> }): string {
  const value = group.subtotal[session.defaultCommodity]
  return value === undefined ? '0.00' : value
}

/** 分组标题的本地化（core GROUP_LABELS 是中文，视图内等价映射，待 core 子批收敛）。 */
function groupLabel(type: string): string {
  if (type === 'Assets') {
    return t('accounts.groupAssets')
  }
  if (type === 'Liabilities') {
    return t('accounts.groupLiabilities')
  }
  return type
}

/** 父行（有子）显示聚合小计；叶子行显示自身余额。 */
function rowBalanceText(row: {
  account: AccountView
  childCount: number
  subtotal: Record<string, string>
}): string {
  if (privacy.enabled) {
    return '••••'
  }
  if (row.childCount > 0) {
    const value = row.subtotal[session.defaultCommodity]
    return value === undefined ? '0.00' : value
  }
  return balanceOf(row.account, session.defaultCommodity)
}

function openDetail(account: AccountView): void {
  void router.push({ name: 'account-detail', params: { id: String(account.id) } })
}

function openCreate(): void {
  if (session.isViewer) {
    notice.value = t('accounts.errViewerCreate')
    return
  }
  notice.value = ''
  formParent.value = null
  showForm.value = true
}

/** 0.6.0 S2：账户行「＋ 增加下级」，父项预填、类型继承且置灰。 */
function openAddChild(account: AccountView): void {
  if (session.isViewer) {
    notice.value = t('accounts.errViewerAddChild')
    return
  }
  if (isClosed(account)) {
    notice.value = t('accounts.errClosedAddChild')
    return
  }
  notice.value = ''
  formParent.value = account
  showForm.value = true
}

function closeForm(): void {
  showForm.value = false
  formParent.value = null
}

function onFormSaved(): void {
  closeForm()
  notice.value = t('accounts.noticeSaved')
  void load()
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const res = await accountApi.list({ includeClosed: true })
    accounts.value = Array.isArray(res.accounts) ? res.accounts : []
  } catch (err) {
    loadError.value = err instanceof ApiError ? err.message : t('accounts.errLoad')
  } finally {
    loading.value = false
  }
}

watch(
  () => session.ledgerId,
  () => {
    accounts.value = []
    void load()
  },
)

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="accts">
    <header class="accts__hero fb-hero">
      <div class="accts__hero-top">
        <span class="accts__label">{{ t('accounts.title', { name: session.ledgerName }) }}</span>
        <button type="button" class="accts__create" @click="openCreate">{{ t('accounts.create') }}</button>
      </div>
    </header>

    <div v-if="loadError" class="fb-card accts__state accts__state--error">
      <p>{{ loadError }}</p>
      <button class="fb-btn-ghost" type="button" @click="load">{{ t('common.reload') }}</button>
    </div>
    <div v-else-if="loading" class="fb-card accts__state">{{ t('accounts.loading') }}</div>

    <template v-else>
      <div v-for="group in groups" :key="group.type" class="fb-card accts__card">
        <div class="accts__head">
          <h3>{{ groupLabel(group.type) }}</h3>
          <MoneyText :amount="subtotalOf(group)" :commodity="session.defaultCommodity" size="sm" />
        </div>
        <p v-if="group.rows.length === 0" class="accts__empty">{{ t('accounts.emptyGroup', { label: groupLabel(group.type) }) }}</p>
        <ul v-else class="accts__list">
          <li
            v-for="row in group.rows"
            :key="row.account.id"
            class="accts__row"
            :style="{ paddingLeft: row.depth * 16 + 'px' }"
          >
            <button type="button" class="accts__row-main" @click="openDetail(row.account)">
              <span class="accts__name">
                {{ accountLabel(row.account) }}
                <span v-if="row.childCount > 0" class="accts__closed">{{ t('accounts.childCount', { n: String(row.childCount) }) }}</span>
                <span v-if="isClosed(row.account)" class="accts__closed">{{ t('accounts.closed') }}</span>
              </span>
              <span class="accts__meta">{{ row.account.type }} · {{ row.account.open_date }} · {{ rowBalanceText(row) }}</span>
            </button>
            <button
              v-if="!session.isViewer && !isClosed(row.account)"
              type="button"
              class="fb-btn-ghost accts__child"
              @click="openAddChild(row.account)"
            >{{ t('accounts.addChild') }}</button>
          </li>
        </ul>
      </div>

      <p class="accts__hint fb-muted">{{ t('accounts.hint') }}</p>
      <p v-if="notice" class="accts__notice" role="status">{{ notice }}</p>
    </template>

    <AccountForm
      v-if="showForm"
      mode="create"
      :parent="formParent"
      @close="closeForm"
      @saved="onFormSaved"
    />
  </section>
</template>

<style scoped>
.accts {
  padding-bottom: 20px;
}

.accts__hero {
  padding: calc(20px + env(safe-area-inset-top, 0px)) 20px 20px;
  border-radius: 0 0 24px 24px;
}

.accts__hero-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.accts__label {
  font-size: 15px;
  font-weight: 700;
}

.accts__create {
  border: none;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-on-hero-pill);
  color: var(--fb-white);
  padding: 6px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.accts__card {
  margin-top: 14px;
  padding: 14px 16px;
}

.accts__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.accts__head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

/* 清除 ul 浏览器默认边距与列表样式，行缩进统一由 li 的 inline padding-left 控制 */
.accts__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.accts__row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--fb-line);
}

.accts__row:last-child {
  border-bottom: none;
}

.accts__row-main {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  padding: 0;
  text-align: left;
  font-family: inherit;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.accts__child {
  padding: 4px 10px;
  font-size: 11px;
  white-space: nowrap;
}

.accts__name {
  font-size: 13px;
  font-weight: 500;
  color: var(--fb-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.accts__closed {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
  color: var(--fb-sub);
  font-size: 10px;
}

.accts__meta {
  font-size: 11px;
  color: var(--fb-sub);
  font-variant-numeric: var(--fb-font-numeric);
}

.accts__empty {
  margin: 0;
  padding: 12px 0;
  text-align: center;
  font-size: 12px;
  color: var(--fb-sub);
}

.accts__hint {
  margin: 14px 0 0;
  font-size: 11px;
  text-align: center;
}

.accts__notice {
  margin: 10px 0 0;
  text-align: center;
  font-size: 12px;
  color: var(--fb-blue);
}
</style>
