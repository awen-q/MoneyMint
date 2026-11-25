<script setup lang="ts">
/**
 * C-02 账户表单（批 2，新建 / 编辑期初统一组件）
 *
 * - create：类型 + **中文显示名**（name 由 ASCII 规则自动生成，C-03）+
 *   开户日（FR-03：默认 min(账本期初日期, 今日)，且不得晚于账本期初日期）+
 *   可选期初（Assets / Liabilities，金额绝对值 + 方向，FR-04/05）；
 * - opening：只编辑期初（GET 预填 → POST 设置；AC-27：修改已有期初由后端
 *   opening_key 幂等生成「冲正 + 新建」成对交易，前端容忍重试）；
 * - 0.6.0 S2：支持 `parent` 传入「＋ 增加下级」的父账户，父项预填、
 *   类型继承且置灰，提交时 `parent_uuid` 必传（根账户显式传空串）。
 * - P0 可选 ASCII 英文账号：仅 owner 可见的自定义段，留空仍走 ItemN；
 *   前置提示只提醒不拦截，合法性由服务端 ValidateAccountName 守门（400）。
 * - 409 / 校验错误集中展示，带 `balances` 差额明细表（AC-28 关户守门同款）。
 */
import { computed, onMounted, reactive, ref } from 'vue'

import { accountApi, openingApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { AccountView, OpeningDirection, OpeningView } from '@/api/types'
import { buildAccountTree, flattenAccountTree, isClosed, validateIconCodePoints } from '@/core/accounts'
import { validateOpeningForm } from '@/core/opening'
import { accountOptionLabel, indentOptionLabel, todayString } from '@/core/record'
import { t } from '@/i18n'
import { markDirty } from '@/stores/dataFreshness'
import { useSessionStore } from '@/stores/session'
import MoneyText from '@/components/MoneyText.vue'
import IconPicker from '@/components/IconPicker.vue'

const props = withDefaults(
  defineProps<{
    mode: 'create' | 'opening'
    account?: AccountView | null
    /** 「＋ 增加下级」入口预填的父账户；非空时类型继承且不可改。 */
    parent?: AccountView | null
  }>(),
  { account: null, parent: null },
)

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'saved'): void
}>()

const session = useSessionStore()

const loading = ref(false)
const submitting = ref(false)
const loadError = ref('')
const submitError = ref('')
const errorBalances = ref<Array<{ commodity: string; amount: string }>>([])
const notice = ref('')

const initialType = props.parent !== null && props.parent !== undefined
  ? props.parent.type
  : 'Assets'
const accountType = ref<'Assets' | 'Liabilities' | 'Expenses' | 'Income' | 'Equity'>(initialType)
const displayName = ref('')
/** owner 可选的 ASCII 账号段；留空维持 ItemN 自动生成。 */
const customAscii = ref('')
/** 批 II：create 可选图标；空串 = 不发键（缺省语义交给后端落 NULL）。 */
const icon = ref('')
const openDate = ref(todayString())

// 批 2.5 修 2c / 0.6.0 S2：父账户选择（create 模式，可选）。
const parentAccountId = ref<number | null>(
  props.parent !== null && props.parent !== undefined ? props.parent.id : null,
)
const knownAccounts = ref<AccountView[]>([])

const openingAmount = ref('')
const openingDirection = ref<OpeningDirection>('hold')
const openingHasExisting = ref(false)
const openingLoaded = ref(false)

/** 由外部「＋ 增加下级」入口预填父项时，父与类型都不可改。 */
const parentFixed = computed(() => props.parent !== null && props.parent !== undefined)
/** 预填态选项文案：显示名（全名），不再渲染裸 Beancount 全名。 */
const parentFixedOptionText = computed(() =>
  props.parent !== null && props.parent !== undefined ? accountOptionLabel(props.parent) : '',
)

const ledgerOpeningDate = computed(() => {
  for (const ledger of session.ledgers) {
    if (ledger.id === session.ledgerId && ledger.opening_date !== '') {
      return ledger.opening_date
    }
  }
  return todayString()
})

const isFundType = computed(
  () => accountType.value === 'Assets' || accountType.value === 'Liabilities',
)

/** 同类型、未关闭的可选父账户（批 2.5 修 2c）。 */
const parentOptions = computed(() =>
  knownAccounts.value.filter(
    (account) => account.type === accountType.value && !isClosed(account),
  ),
)

/**
 * 父下拉按树展开（父先子后、同层按 sort_order），depth 供全角空格缩进——
 * 只渲染平铺全名时用户看不出层级。孤儿语义（写死口径）：父已关户被过滤后，
 * 其未关户子账户在树里成为根（depth 0）——展示不缩进但仍是合法父候选
 * （后端只要求父存在 / 同 type / 未关户）。
 */
const parentOptionsFlat = computed(() =>
  flattenAccountTree(buildAccountTree(parentOptions.value)),
)

/** 「无」选项动态明示结果形态：随类型切换联动，避免「二级 / 三级」语义漂移。 */
const noParentOptionText = computed(() =>
  t('accounts.form.noParentOption', { type: accountType.value }),
)

function resolveParent(): AccountView | null {
  if (parentFixed.value) {
    return props.parent === undefined || props.parent === null ? null : props.parent
  }
  if (parentAccountId.value === null) {
    return null
  }
  for (const account of knownAccounts.value) {
    if (account.id === parentAccountId.value) {
      return account
    }
  }
  return null
}

/**
 * 按 seed 命名约定生成 Beancount 合法的 ASCII 全名（C-03 / AC-2.3）。
 * 界面主要收中文 display_name；owner 可显式给最后一段 ASCII 名，
 * 留空仍用 `父全名:ItemN` / `类型:ItemN` 并避开已有账户名。
 * 自定义值不在此做合法性裁决——服务端 ValidateAccountName 是权威。
 */
function makeAsciiName(parent: AccountView | null, type: string, customAscii: string = ''): string {
  const base = parent !== null ? parent.name : type
  const custom = customAscii.trim()
  if (custom !== '') {
    return `${base}:${custom}`
  }
  const used = new Set<string>()
  for (const account of knownAccounts.value) {
    used.add(account.name)
  }
  let n = 1
  let candidate = `${base}:Item${n}`
  while (used.has(candidate)) {
    n += 1
    candidate = `${base}:Item${n}`
  }
  return candidate
}

/**
 * 自定义 ASCII 段的前置提示（只提示不阻断提交）：与服务端同口径——
 * 段内不能有冒号/空白，第二段须以大写字母或数字开头。填了不合规则仍会
 * 提交，由服务端返回 400 account_name_invalid + 中文原因。
 */
const customAsciiHint = computed(() => {
  const value = customAscii.value.trim()
  if (value === '') {
    return ''
  }
  if (value.indexOf(':') >= 0 || /\s/.test(value)) {
    return t('accounts.form.asciiColonSpace')
  }
  if (!/^[A-Z0-9]/.test(value)) {
    return t('accounts.form.asciiStartUpper')
  }
  return ''
})

function onParentChange(event: Event): void {
  const raw = (event.target as HTMLSelectElement).value
  if (raw === '' || !/^\d+$/.test(raw)) {
    parentAccountId.value = null
    return
  }
  const id = Number(raw)
  parentAccountId.value = Number.isSafeInteger(id) && id > 0 ? id : null
}

async function loadKnownAccounts(): Promise<void> {
  try {
    // 避重集合必须含已关户账户：后端重名判定覆盖关户行（自动命名可落
    // 409 account_name_exists）；父下拉渲染侧由 parentOptions 的 isClosed
    // 过滤兜底，关户项不会回流进下拉。
    const res = await accountApi.list({ includeClosed: true })
    knownAccounts.value = Array.isArray(res.accounts) ? res.accounts : []
  } catch {
    // 父下拉为增强项，加载失败不阻断新建。
    knownAccounts.value = []
  }
}

/** FR-03：新建账户开户日默认 min(账本期初日期, 今日)，且不得晚于账本期初日期。 */
function defaultOpenDate(): string {
  return ledgerOpeningDate.value < todayString() ? ledgerOpeningDate.value : todayString()
}

function switchType(next: typeof accountType.value): void {
  if (parentFixed.value) {
    return
  }
  accountType.value = next
  openingDirection.value = next === 'Liabilities' ? 'owe' : 'hold'
  parentAccountId.value = null
}

function onOpenDateChange(event: Event): void {
  openDate.value = (event.target as HTMLInputElement).value
}

function onOpeningAmountChange(event: Event): void {
  openingAmount.value = (event.target as HTMLInputElement).value
}

function onDirectionChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  openingDirection.value = value === 'owe' ? 'owe' : 'hold'
}

function clearErrors(): void {
  submitError.value = ''
  errorBalances.value = []
  notice.value = ''
}

async function loadOpening(): Promise<void> {
  if (props.account === null) {
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const view: OpeningView = await openingApi.get(props.account.uuid)
    openingHasExisting.value = view.has_opening === true
    if (view.has_opening && typeof view.amount === 'string') {
      openingAmount.value = view.amount
    }
    if (view.direction === 'hold' || view.direction === 'owe') {
      openingDirection.value = view.direction
    }
    openingLoaded.value = true
  } catch (err) {
    loadError.value = err instanceof ApiError ? err.message : t('accounts.form.errLoadOpening')
  } finally {
    loading.value = false
  }
}

async function submitOpening(accountUuid: string, commodity: string): Promise<void> {
  const validation = validateOpeningForm({
    amount: openingAmount.value,
    direction: openingDirection.value,
    accountType: isFundType.value ? accountType.value : '',
    accountOpenDate: props.account === null ? openDate.value : (props.account.open_date ?? ''),
    ledgerOpeningDate: ledgerOpeningDate.value,
  })
  if (!validation.ok || validation.absAmount === null) {
    submitError.value = validation.errors.join('；')
    return
  }
  if (validation.absAmount === '0.00') {
    notice.value = t('accounts.form.noticeZeroOpening')
    return
  }
  await openingApi.set(accountUuid, {
    amount: validation.absAmount,
    direction: openingDirection.value,
    commodity,
    date: ledgerOpeningDate.value,
  })
  // 修改期初会由后端生成成对交易：账户快照与交易快照都需要失效。
  markDirty('local-write')
}

async function submit(): Promise<void> {
  if (submitting.value) {
    return
  }
  clearErrors()
  if (session.isViewer) {
    submitError.value = t('accounts.form.errViewer')
    return
  }
  submitting.value = true
  try {
    if (props.mode === 'opening') {
      if (props.account === null || props.account.uuid === undefined) {
        submitError.value = t('accounts.form.errNoAccount')
        return
      }
      await submitOpening(props.account.uuid, resolveCommodity(props.account))
    } else {
      const label = displayName.value.trim()
      if (label === '') {
        submitError.value = t('accounts.form.errNameRequired')
        return
      }
      if (openDate.value > ledgerOpeningDate.value) {
        submitError.value = t('accounts.form.errOpenDateTooLate', {
          openDate: openDate.value,
          ledgerDate: ledgerOpeningDate.value,
        })
        return
      }
      const parent = resolveParent()
      const fullName = makeAsciiName(parent, accountType.value, customAscii.value)
      // 批 II：图标非空才发键（缺省不发键 → 后端落 NULL）；码位校验同后端口径。
      const selectedIcon = icon.value.trim()
      if (selectedIcon !== '' && !validateIconCodePoints(selectedIcon)) {
        submitError.value = t('common.iconPicker.tooLong')
        return
      }
      const created = await accountApi.create({
        name: fullName,
        display_name: label,
        type: accountType.value,
        open_date: openDate.value,
        // 0.6.0 S2：显式空串表示根账户（JSON 键缺失会被后端 400 拒绝）。
        parent_uuid: parent !== null ? parent.uuid : '',
        ...(selectedIcon !== '' ? { icon: selectedIcon } : {}),
      })
      markDirty('local-write')
      if (isFundType.value && openingAmount.value.trim() !== '') {
        await submitOpening(created.uuid, resolveCommodity(created as unknown as AccountView))
      } else {
        notice.value = t('accounts.form.noticeCreated')
      }
    }
    emit('saved')
    emit('close')
  } catch (err) {
    submitError.value = err instanceof ApiError ? err.message : t('accounts.form.errSave')
    if (err instanceof ApiError && err.balances !== undefined) {
      errorBalances.value = err.balances
    }
  } finally {
    submitting.value = false
  }
}

function resolveCommodity(account: AccountView | null): string {
  if (account === null) {
    return session.defaultCommodity
  }
  if (account.commodity_restriction !== undefined && account.commodity_restriction !== '') {
    return account.commodity_restriction
  }
  return session.defaultCommodity
}

function close(): void {
  emit('close')
}

onMounted(() => {
  if (props.mode === 'create') {
    openDate.value = defaultOpenDate()
    void loadKnownAccounts()
  } else {
    void loadOpening()
  }
})
</script>

<template>
  <div class="af-mask" @click.self="close">
    <section class="af-panel" role="dialog" aria-modal="true" :aria-label="mode === 'create' ? t('accounts.form.dialogCreate') : t('accounts.form.dialogOpening')">
      <header class="af-head">
        <h3>{{ mode === 'create' ? (parentFixed ? t('accounts.form.titleAddChild') : t('accounts.form.dialogCreate')) : t('accounts.form.titleOpening', { name: account !== null ? account.name : '' }) }}</h3>
        <button class="af-close" type="button" :aria-label="t('common.close')" @click="close">✕</button>
      </header>

      <div v-if="loadError" class="af-alert af-alert--error">{{ loadError }}</div>
      <div v-if="submitError" class="af-alert af-alert--error" role="alert">{{ submitError }}</div>
      <div v-if="notice" class="af-alert af-alert--ok">{{ notice }}</div>

      <div v-if="errorBalances.length > 0" class="af-balances">
        <p class="af-balances__label">{{ t('accounts.form.balanceDiffLabel') }}</p>
        <table>
          <thead><tr><th>{{ t('common.commodity') }}</th><th>{{ t('common.diff') }}</th></tr></thead>
          <tbody>
            <tr v-for="diff in errorBalances" :key="diff.commodity">
              <td>{{ diff.commodity }}</td>
              <td><MoneyText :amount="diff.amount" :commodity="diff.commodity" size="sm" /></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="loading" class="af-body af-muted">{{ t('accounts.form.loadingOpening') }}</div>

      <div v-else class="af-body">
        <template v-if="mode === 'create'">
          <label class="af-field">
            <span>{{ t('accounts.form.typeLabel') }}{{ parentFixed ? t('accounts.form.typeInheritedSuffix') : '' }}</span>
            <select class="fb-input" :disabled="parentFixed" :value="accountType" @change="switchType(($event.target as HTMLSelectElement).value as typeof accountType)">
              <option value="Assets">{{ t('accounts.form.typeAssets') }}</option>
              <option value="Liabilities">{{ t('accounts.form.typeLiabilities') }}</option>
              <option value="Expenses">{{ t('accounts.form.typeExpenses') }}</option>
              <option value="Income">{{ t('accounts.form.typeIncome') }}</option>
              <option value="Equity">{{ t('accounts.form.typeEquity') }}</option>
            </select>
          </label>
          <label class="af-field">
            <span>{{ t('accounts.form.displayNameLabel') }}</span>
            <input class="fb-input" v-model="displayName" :placeholder="t('accounts.form.displayNamePlaceholder')" />
          </label>
          <div class="af-field">
            <span>{{ t('accounts.form.iconLabel') }}</span>
            <IconPicker v-model="icon" />
          </div>
          <p class="af-hint">{{ t('accounts.form.nameHint') }}</p>
          <label v-if="session.isOwner" class="af-field">
            <span>{{ t('accounts.form.asciiLabel') }}</span>
            <input class="fb-input af-ascii" v-model="customAscii" :placeholder="t('accounts.form.asciiPlaceholder')" />
          </label>
          <p v-if="session.isOwner && customAsciiHint" class="af-hint af-hint--warn" role="status">{{ customAsciiHint }}</p>
          <label class="af-field">
            <span>{{ t('accounts.form.parentLabel') }}{{ parentFixed ? t('accounts.form.parentFixedSuffix') : t('accounts.form.parentOptionalSuffix') }}</span>
            <select
              class="fb-input"
              :disabled="parentFixed"
              :value="parentAccountId === null ? '' : String(parentAccountId)"
              @change="onParentChange"
            >
              <option v-if="parentFixed" :value="String(parentAccountId)">{{ parentFixedOptionText }}</option>
              <option v-if="!parentFixed" value="">{{ noParentOptionText }}</option>
              <!-- 单行排版：Vue 模板空白 condense 会在多行插值外产生前导空格，干扰缩进前缀断言 -->
              <template v-if="!parentFixed">
                <option v-for="opt in parentOptionsFlat" :key="opt.account.id" :value="String(opt.account.id)">{{ indentOptionLabel(accountOptionLabel(opt.account), opt.depth) }}</option>
              </template>
            </select>
          </label>
          <label class="af-field">
            <span>{{ t('accounts.form.openDateLabel', { date: ledgerOpeningDate }) }}</span>
            <input class="fb-input" type="date" :value="openDate" @change="onOpenDateChange" />
          </label>

          <template v-if="isFundType">
            <div class="af-section">{{ t('accounts.form.openingSection') }}</div>
            <div class="af-row">
              <label class="af-field">
                <span>{{ t('accounts.form.amountLabel') }}</span>
                <input class="fb-input" :value="openingAmount" @change="onOpeningAmountChange" :placeholder="t('accounts.form.amountPlaceholderCreate')" />
              </label>
              <label class="af-field">
                <span>{{ t('accounts.form.directionLabel') }}</span>
                <select class="fb-input" :value="openingDirection" @change="onDirectionChange">
                  <option value="hold">{{ t('accounts.form.directionHold') }}</option>
                  <option value="owe">{{ t('accounts.form.directionOwe') }}</option>
                </select>
              </label>
            </div>
            <p class="af-hint">{{ t('accounts.form.openingHint', { date: ledgerOpeningDate }) }}</p>
          </template>
          <p v-else class="af-hint">{{ t('accounts.form.notFundHint', { type: accountType }) }}</p>
        </template>

        <template v-else>
          <p class="af-hint" v-if="openingHasExisting">{{ t('accounts.form.openingExistingHint') }}</p>
          <p class="af-hint" v-else>{{ t('accounts.form.openingNoneHint') }}</p>
          <div class="af-row">
            <label class="af-field">
              <span>{{ t('accounts.form.amountLabel') }}</span>
              <input class="fb-input" :value="openingAmount" @change="onOpeningAmountChange" :placeholder="t('accounts.form.amountPlaceholderOpening')" />
            </label>
            <label class="af-field">
              <span>{{ t('accounts.form.directionLabel') }}</span>
              <select class="fb-input" :value="openingDirection" @change="onDirectionChange">
                <option value="hold">{{ t('accounts.form.directionHold') }}</option>
                <option value="owe">{{ t('accounts.form.directionOwe') }}</option>
              </select>
            </label>
          </div>
          <p class="af-hint">{{ t('accounts.form.openingDateHint', { date: ledgerOpeningDate, commodity: resolveCommodity(account) }) }}</p>
        </template>
      </div>

      <div class="af-foot">
        <button type="button" class="fb-btn-ghost" @click="close">{{ t('common.cancel') }}</button>
        <button type="button" class="fb-btn-primary" :disabled="submitting || loading" @click="submit">
          {{ submitting ? t('common.saving') : t('common.save') }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.af-mask {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: var(--fb-overlay-scrim);
  z-index: 60;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.af-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-height: 92vh;
  background: var(--fb-card);
  border-radius: 20px 20px 0 0;
  overflow: hidden;
}

@media (min-width: 1024px) {
  .af-mask {
    align-items: center;
  }

  .af-panel {
    width: 440px;
    max-width: 92vw;
    max-height: 88vh;
    border-radius: 18px;
  }
}

.af-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--fb-line);
}

.af-head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.af-close {
  border: none;
  background: transparent;
  color: var(--fb-sub);
  font-size: 16px;
  cursor: pointer;
}

.af-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 18px 16px;
}

.af-field {
  display: block;
  margin-top: 10px;
}

.af-field > span {
  display: block;
  font-size: 12px;
  color: var(--fb-sub);
  margin-bottom: 6px;
}

.af-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.af-section {
  margin-top: 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fb-ink);
}

.af-hint {
  margin: 10px 0 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--fb-sub);
}

.af-hint--warn {
  color: var(--fb-danger);
}

.af-alert {
  margin: 8px 18px 0;
  padding: 8px 12px;
  border-radius: var(--fb-radius-input);
  font-size: 12px;
}

.af-alert--error {
  background: var(--fb-danger-soft);
  color: var(--fb-danger-ink);
}

.af-alert--ok {
  background: var(--fb-green-soft);
  color: var(--fb-green-ink);
}

.af-balances {
  margin: 8px 18px 0;
  padding: 10px 12px;
  border-radius: var(--fb-radius-input);
  background: var(--fb-danger-soft);
}

.af-balances__label {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--fb-danger-ink);
  font-weight: 600;
}

.af-balances table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.af-balances th,
.af-balances td {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid var(--fb-line);
}

.af-foot {
  display: flex;
  gap: 10px;
  padding: 10px 18px calc(10px + env(safe-area-inset-bottom, 0px));
}

.af-foot > button {
  flex: 1;
}
</style>
