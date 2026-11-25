<script setup lang="ts">
/**
 * P-09 分类管理（批 2）：Expenses / Income 二级分类增删 + 拖拽排序
 *
 * - 分类 = 类型账户（三层 `Expenses:食品饮料:食品`），创建走 POST /api/accounts，
 *   删除走 DELETE（Beancount close，余额非 0 时 409 + balances 差额明细）；
 * - 拖拽用原生 HTML5 draggable（§14.5 #2 Must，禁止引库），排序逻辑层在
 *   core/ordering.ts；P0 起拖动后按 type 整组提交 PATCH /api/accounts/sort-order，
 *   uuid + 0-based sort_order 落库并写 sync_log，其他端 pull 后顺序一致；
 * - localStorage 只存 uuid 草稿（离线即时反馈），真相源是服务端 sort_order。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'

import { accountApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { AccountView } from '@/api/types'
import {
  balanceOf,
  buildAccountTree,
  catIcon,
  flattenAccountTree,
  groupAccountsByType,
  isClosed,
} from '@/core/accounts'
import { buildSortOrders, moveItem, sortBySortOrder } from '@/core/ordering'
import { accountLabel, accountOptionLabel, indentOptionLabel, todayString } from '@/core/record'
import { readCategoryOrder, writeCategoryOrder } from '@/core/storage'
import { t } from '@/i18n'
import { markDirty } from '@/stores/dataFreshness'
import { useSessionStore } from '@/stores/session'
import MoneyText from '@/components/MoneyText.vue'
import AccountEditSheet from '@/components/AccountEditSheet.vue'

const session = useSessionStore()

const accounts = ref<AccountView[]>([])
const loading = ref(false)
const loadError = ref('')
const notice = ref('')
const busyUuid = ref<string | null>(null)

const dragIndex = ref<number | null>(null)
const dragGroup = ref('')
/** 本地草稿：按 type 存 uuid 序列（旧 number[] 由 storage 层降级清理）。 */
const dragOrders = reactive<{ [type: string]: string[] }>({})
const sorting = ref(false)

const newType = ref<'Expenses' | 'Income'>('Expenses')
const newName = ref('')
/** owner 可选的 ASCII 账号段；留空维持 ItemN 自动生成。 */
const customAscii = ref('')
const creating = ref(false)
const deleteTarget = ref<AccountView | null>(null)

// 批 II：行操作「编辑」入口 → AccountEditSheet（展示字段在线-only；viewer 不渲染）。
const editTarget = ref<AccountView | null>(null)

function askEdit(account: AccountView): void {
  if (session.isViewer) {
    notice.value = t('categories.errViewerEdit')
    return
  }
  notice.value = ''
  editTarget.value = account
}

/** 编辑保存成功：markDirty 由 AccountEditSheet 调用；这里收敛本页列表。 */
async function onEditSaved(): Promise<void> {
  editTarget.value = null
  await load()
}

/**
 * 批 2.5 修 2b：树形渲染（parent_uuid / 冒号兜底；子随父、缩进展示）。
 * 本地拖拽 order 对同层排序依旧生效（作为 buildAccountTree 的比较器传入），
 * 服务端 sort_order 与本地 order 的合并语义不变（新增落末尾 / 删除无幽灵）。
 */
const groups = computed(() =>
  groupAccountsByType(accounts.value, ['Expenses', 'Income']).map((group) => {
    const order = dragOrders[group.type]
    let sorted = sortBySortOrder(group.items, (account) => account.sort_order)
    if (order !== undefined) {
      sorted = sortBySortOrder(sorted, (account) => {
        const index = order.indexOf(account.uuid)
        return index === -1 ? order.length + account.id : index
      })
    }
    const compare =
      order === undefined
        ? undefined
        : (a: AccountView, b: AccountView) => {
            const indexA = order.indexOf(a.uuid)
            const indexB = order.indexOf(b.uuid)
            if (indexA === -1 && indexB === -1) {
              return (a.sort_order ?? 0) - (b.sort_order ?? 0)
            }
            if (indexA === -1) {
              return 1
            }
            if (indexB === -1) {
              return -1
            }
            return indexA - indexB
          }
    return {
      type: group.type,
      label: group.label,
      rows: flattenAccountTree(buildAccountTree(sorted, compare)),
    }
  }),
)

function balanceText(account: AccountView): string {
  return balanceOf(account, session.defaultCommodity)
}

/** 父行（有子）的小计展示（自身 + 全部后代，定点、符号保留）。 */
function rowSubtotalText(row: {
  subtotal: Record<string, string>
}): string {
  const value = row.subtotal[session.defaultCommodity]
  return value === undefined ? '0.00' : value
}

function onDragStart(groupType: string, index: number, event: DragEvent): void {
  dragGroup.value = groupType
  dragIndex.value = index
  // jsdom / 部分浏览器拖放事件可能没有 dataTransfer；缺失时跳过而非抛错。
  if (event.dataTransfer !== null && event.dataTransfer !== undefined) {
    event.dataTransfer.effectAllowed = 'move'
  }
}

function onDragOver(event: DragEvent): void {
  event.preventDefault()
}

/**
 * 拖放落位：本地草稿先即时生效，再按 type 整组提交服务端（P0）。
 * 服务端全成全败 + 每条写 sync_log；提交成功用响应覆盖本地 sort_order，
 * 失败保留草稿并在 notice 说明（下次拖动 / 刷新仍可恢复为服务端真相）。
 */
async function onDrop(groupType: string, index: number): Promise<void> {
  if (session.isViewer) {
    notice.value = t('categories.errViewerSort')
    return
  }
  if (sorting.value || dragGroup.value !== groupType || dragIndex.value === null) {
    return
  }
  const from = dragIndex.value
  const group = groups.value.find((g) => g.type === groupType)
  if (group === undefined) {
    return
  }
  const next = moveItem(
    group.rows.map((row) => row.account),
    from,
    index,
  )
  // 整组 uuid 顺序 = 该 type 下全部账户（含列表里已关闭项）的新顺序。
  const uuids: string[] = []
  for (const item of next) {
    uuids.push(item.uuid)
  }
  dragOrders[groupType] = uuids
  dragIndex.value = null
  dragGroup.value = ''

  // 草稿先落本地（按账本命名空间），离线 / 同步失败时 UI 仍按拖动结果展示。
  const orderSnapshot: Record<string, string[]> = {}
  for (const key of Object.keys(dragOrders)) {
    orderSnapshot[key] = dragOrders[key].slice()
  }
  if (session.ledgerId !== null) {
    writeCategoryOrder(session.ledgerId, orderSnapshot)
  }

  const orders = buildSortOrders(next, (account) => account.uuid)
  if (orders.length === 0) {
    return
  }
  sorting.value = true
  notice.value = t('categories.sortSaving')
  try {
    const res = await accountApi.updateSortOrders({ orders })
    if (res.updated === orders.length) {
      // 响应确认条数后覆盖本地 sort_order，使九宫格 / 列表与服务端同源。
      const applied = new Map<string, number>()
      for (const item of orders) {
        applied.set(item.uuid, item.sort_order)
      }
      for (const account of accounts.value) {
        const order = applied.get(account.uuid)
        if (account.type === groupType && order !== undefined) {
          account.sort_order = order
        }
      }
      // 已确认的组不再需要草稿：否则本端旧草稿会盖掉其他端后续推送的顺序。
      delete dragOrders[groupType]
      const remaining: Record<string, string[]> = {}
      for (const key of Object.keys(dragOrders)) {
        remaining[key] = dragOrders[key].slice()
      }
      if (session.ledgerId !== null) {
        writeCategoryOrder(session.ledgerId, remaining)
      }
      notice.value = t('categories.sortSaved', { n: String(res.updated) })
      markDirty('local-write')
    } else {
      notice.value = t('categories.sortPartial', {
        n: String(res.updated),
        total: String(orders.length),
      })
    }
  } catch (err) {
    notice.value =
      err instanceof ApiError
        ? t('categories.sortSyncFailedWith', { message: err.message })
        : t('categories.sortSyncFailed')
  } finally {
    sorting.value = false
  }
}

/** 0.6.0 S2：新建分类的可选上级（未关闭的 Expenses / Income 账户）。 */
const newParentId = ref<number | null>(null)

const parentOptions = computed(() =>
  accounts.value.filter(
    (account) =>
      !isClosed(account) && (account.type === 'Expenses' || account.type === 'Income'),
  ),
)

/**
 * 上级下拉按树展开（父先子后），depth 供全角空格缩进；与 AccountForm
 * 统一口径（显示名（全名）+ 缩进）。刻意不传分类页拖拽 compare——
 * 下拉排序语义是服务端 sort_order 序，与拖拽草稿无关。
 */
const parentOptionsFlat = computed(() =>
  flattenAccountTree(buildAccountTree(parentOptions.value)),
)

/** 「无上级」动态明示结果形态：随类型切换联动（与 AccountForm 同文案口径）。 */
const noParentOptionText = computed(() =>
  t('categories.noParentOption', { type: newType.value }),
)

/** 分组标题的本地化（core GROUP_LABELS 是中文，视图内等价映射，待 core 子批收敛）。 */
function groupLabel(type: string): string {
  if (type === 'Expenses') {
    return t('categories.groupExpenses')
  }
  if (type === 'Income') {
    return t('categories.groupIncome')
  }
  return type
}

function onNewNameChange(event: Event): void {
  newName.value = (event.target as HTMLInputElement).value
}

function onNewTypeChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  newType.value = value === 'Income' ? 'Income' : 'Expenses'
}

function onNewParentChange(event: Event): void {
  const raw = (event.target as HTMLSelectElement).value
  if (raw === '' || !/^\d+$/.test(raw)) {
    newParentId.value = null
    return
  }
  const id = Number(raw)
  newParentId.value = Number.isSafeInteger(id) && id > 0 ? id : null
}

function resolveNewParent(): AccountView | null {
  if (newParentId.value === null) {
    return null
  }
  for (const account of accounts.value) {
    if (account.id === newParentId.value) {
      return account
    }
  }
  return null
}

/**
 * 0.6.0 S2：界面主要收中文显示名，name 按 seed 规则生成 ASCII 合法全名；
 * P0 起 owner 可显式给最后一段 ASCII 名，留空仍走 ItemN。
 * 合法性由服务端 ValidateAccountName 守门，这里不自行裁决。
 */
function makeAsciiCategoryName(
  parent: AccountView | null,
  type: string,
  customAscii: string = '',
): string {
  const base = parent !== null ? parent.name : type
  const custom = customAscii.trim()
  if (custom !== '') {
    return `${base}:${custom}`
  }
  const used = new Set<string>()
  for (const account of accounts.value) {
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
 * 段内不能有冒号/空白，须以大写字母或数字开头；不合法仍会提交，
 * 由服务端返回 400 account_name_invalid + 中文原因。
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

/** 创建分类：同样传 parent_uuid（与 AccountForm 统一，AC-2.5）。 */
async function createCategory(): Promise<void> {
  if (creating.value) {
    return
  }
  notice.value = ''
  const label = newName.value.trim()
  if (label === '') {
    notice.value = t('categories.errNameRequired')
    return
  }
  if (label.split(':').some((part) => part.trim() === '')) {
    notice.value = t('categories.errNameSegmentEmpty')
    return
  }
  const parent = resolveNewParent()
  // 选中上级时类型继承父项，避免父子类型不一致被后端 409 拒绝。
  const type = parent !== null ? parent.type : newType.value
  creating.value = true
  try {
    const ledgerOpeningDate = ledgerOpening()
    await accountApi.create({
      name: makeAsciiCategoryName(parent, type, customAscii.value),
      display_name: label.split(':').join(' · '),
      type,
      open_date: ledgerOpeningDate < todayString() ? ledgerOpeningDate : todayString(),
      parent_uuid: parent !== null ? parent.uuid : '',
    })
    newName.value = ''
    newParentId.value = null
    customAscii.value = ''
    notice.value = t('categories.noticeCreated', { name: label })
    markDirty('local-write')
    await load()
  } catch (err) {
    notice.value = err instanceof ApiError ? err.message : t('categories.errCreate')
  } finally {
    creating.value = false
  }
}

function ledgerOpening(): string {
  for (const ledger of session.ledgers) {
    if (ledger.id === session.ledgerId && ledger.opening_date !== '') {
      return ledger.opening_date
    }
  }
  return todayString()
}

function askDelete(account: AccountView): void {
  if (session.isViewer) {
    notice.value = t('categories.errViewerDelete')
    return
  }
  notice.value = ''
  deleteTarget.value = account
}

/** 删除分类 = Beancount close；分类账户余额通常非 0，409 时渲染差额明细。 */
async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value
  if (target === null || busyUuid.value !== null) {
    return
  }
  busyUuid.value = target.uuid
  try {
    await accountApi.close(target.uuid)
    notice.value = t('categories.noticeClosed', { name: accountLabel(target) })
    deleteTarget.value = null
    markDirty('local-write')
    await load()
  } catch (err) {
    notice.value = err instanceof ApiError ? `${err.message}` : t('categories.errClose')
  } finally {
    busyUuid.value = null
  }
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const res = await accountApi.list({ includeClosed: true })
    accounts.value = Array.isArray(res.accounts) ? res.accounts : []
    // §14.5 #2：恢复本地持久化的拖拽顺序（按账本命名空间）。
    if (session.ledgerId !== null) {
      Object.assign(dragOrders, readCategoryOrder(session.ledgerId))
    }
  } catch (err) {
    loadError.value = err instanceof ApiError ? err.message : t('categories.errLoad')
  } finally {
    loading.value = false
  }
}

watch(
  () => session.ledgerId,
  () => {
    accounts.value = []
    for (const key of Object.keys(dragOrders)) {
      delete dragOrders[key]
    }
    if (session.ledgerId !== null) {
      Object.assign(dragOrders, readCategoryOrder(session.ledgerId))
    }
    void load()
  },
)

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="cats">
    <header class="cats__hero fb-hero">
      <span class="cats__label">{{ t('categories.hero') }}</span>
    </header>

    <div v-if="loadError" class="fb-card cats__state cats__state--error">
      <p>{{ loadError }}</p>
      <button class="fb-btn-ghost" type="button" @click="load">{{ t('common.reload') }}</button>
    </div>
    <div v-else-if="loading" class="fb-card cats__state">{{ t('categories.loading') }}</div>

    <template v-else>
      <div class="fb-card cats__card">
        <h3>{{ t('categories.createTitle') }}</h3>
        <div class="cats__create">
          <select
            class="fb-input cats__type"
            :value="newType"
            :disabled="newParentId !== null"
            @change="onNewTypeChange"
          >
            <option value="Expenses">{{ t('categories.typeExpenses') }}</option>
            <option value="Income">{{ t('categories.typeIncome') }}</option>
          </select>
          <select
            class="fb-input cats__type"
            :value="newParentId === null ? '' : String(newParentId)"
            @change="onNewParentChange"
          >
            <option value="">{{ noParentOptionText }}</option>
            <!-- 单行排版：避免 Vue 模板空白 condense 产生前导空格，干扰缩进前缀断言 -->
            <option v-for="opt in parentOptionsFlat" :key="opt.account.id" :value="String(opt.account.id)">{{ indentOptionLabel(accountOptionLabel(opt.account), opt.depth) }}</option>
          </select>
          <input
            class="fb-input cats__name"
            :value="newName"
            :placeholder="t('categories.namePlaceholder')"
            @change="onNewNameChange"
          />
          <input
            v-if="session.isOwner"
            class="fb-input cats__ascii"
            v-model="customAscii"
            :placeholder="t('categories.asciiPlaceholder')"
          />
          <button type="button" class="fb-btn-primary cats__submit" :disabled="creating || session.isViewer" @click="createCategory">
            {{ creating ? t('categories.creating') : t('categories.create') }}
          </button>
        </div>
        <p class="cats__hint">
          {{ t('categories.hint') }}
        </p>
        <p v-if="session.isOwner && customAsciiHint" class="cats__hint cats__hint--warn" role="status">{{ customAsciiHint }}</p>
      </div>

      <div v-for="group in groups" :key="group.type" class="fb-card cats__card">
        <h3>{{ t('categories.groupHeading', { label: groupLabel(group.type), n: String(group.rows.length) }) }}</h3>
        <p v-if="group.rows.length === 0" class="cats__empty">{{ t('categories.emptyGroup', { label: groupLabel(group.type) }) }}</p>
        <ul v-else class="cats__list">
          <li
            v-for="(row, index) in group.rows"
            :key="row.account.id"
            class="cats__row"
            draggable="true"
            :style="{ paddingLeft: row.depth * 14 + 'px' }"
            @dragstart="onDragStart(group.type, index, $event)"
            @dragover="onDragOver"
            @drop="onDrop(group.type, index)"
          >
            <span class="cats__drag" aria-hidden="true">⋮⋮</span>
            <span
              class="cats__icon"
              :style="row.account.color ? { color: row.account.color } : undefined"
              aria-hidden="true"
            >{{ catIcon(row.account) }}</span>
            <span class="cats__info">
              <span class="cats__name">
                {{ accountLabel(row.account) }}
                <span v-if="isClosed(row.account)" class="cats__closed">{{ t('categories.closed') }}</span>
              </span>
              <span class="cats__meta">
                {{ row.account.name }} · {{ balanceText(row.account) }}
                <template v-if="row.childCount > 0"> · {{ t('categories.subtotal') }} {{ rowSubtotalText(row) }}</template>
              </span>
            </span>
            <button
              v-if="!session.isViewer"
              type="button"
              class="cats__edit"
              :disabled="busyUuid !== null"
              @click="askEdit(row.account)"
            >{{ t('common.edit') }}</button>
            <button
              type="button"
              class="cats__delete"
              :disabled="busyUuid !== null || session.isViewer"
              @click="askDelete(row.account)"
            >{{ t('common.delete') }}</button>
          </li>
        </ul>
      </div>

      <p v-if="notice" class="cats__notice" role="status">{{ notice }}</p>

      <AccountEditSheet
        v-if="editTarget !== null"
        :account="editTarget"
        @close="editTarget = null"
        @saved="onEditSaved"
      />

      <div v-if="deleteTarget !== null" class="cats__mask" @click.self="deleteTarget = null">
        <div class="cats__confirm">
          <h3>{{ t('categories.closeTitle') }}</h3>
          <p class="cats__warn">{{ t('categories.closeBody', { name: accountLabel(deleteTarget), balance: balanceText(deleteTarget) }) }}</p>
          <div class="cats__confirm-actions">
            <button type="button" class="fb-btn-ghost" @click="deleteTarget = null">{{ t('common.cancel') }}</button>
            <button type="button" class="fb-btn-primary" :disabled="busyUuid !== null" @click="confirmDelete">
              {{ busyUuid !== null ? t('categories.processing') : t('categories.confirmClose') }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.cats {
  padding-bottom: 20px;
}

.cats__hero {
  padding: calc(20px + env(safe-area-inset-top, 0px)) 20px 20px;
  border-radius: 0 0 24px 24px;
}

.cats__label {
  font-size: 15px;
  font-weight: 700;
}

.cats__card {
  margin-top: 14px;
  padding: 14px 16px;
}

.cats__card h3 {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
}

/* 新建分类表单：移动端用两列网格（窄屏 375 下固定 flex-basis 之和 + gap
   会超过卡片可用宽度，造成横向溢出）；≥900 恢复原来的单行 flex。
   所有控件统一 min-width: 0，避免 input/select 的 UA 默认最小宽把网格撑破。 */
.cats__create {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.cats__create .cats__type,
.cats__create .cats__name,
.cats__create .cats__ascii {
  width: 100%;
  min-width: 0;
}

.cats__create .cats__name,
.cats__create .cats__ascii {
  grid-column: 1 / -1;
}

.cats__submit {
  grid-column: 1 / -1;
  min-width: 0;
}

@media (min-width: 900px) {
  .cats__create {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
  }

  .cats__type {
    flex: 0 0 110px;
  }

  .cats__create .cats__name {
    flex: 1 1 180px;
  }

  .cats__ascii {
    flex: 0 0 132px;
  }

  .cats__submit {
    flex: 0 0 auto;
  }
}

.cats__hint {
  margin: 10px 0 0;
  font-size: 11px;
  color: var(--fb-sub);
  line-height: 1.7;
}

.cats__hint--warn {
  color: var(--fb-danger);
}

/* 清除 ul 浏览器默认边距与列表样式，行缩进统一由 li 的 inline padding-left 控制 */
.cats__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.cats__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px solid var(--fb-line);
  cursor: grab;
}

.cats__row:last-child {
  border-bottom: none;
}

.cats__drag {
  color: var(--fb-sub);
  font-size: 12px;
  letter-spacing: -2px;
  flex-shrink: 0;
}

/* 批 II 行首图标：预设色优先（icon 用账户 color 染色，缺省墨色）。 */
.cats__icon {
  flex-shrink: 0;
  font-size: 16px;
  line-height: 1;
}

.cats__info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.cats__name {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cats__closed {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
  color: var(--fb-sub);
  font-size: 10px;
}

.cats__meta {
  font-size: 11px;
  color: var(--fb-sub);
  font-variant-numeric: var(--fb-font-numeric);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cats__edit {
  flex-shrink: 0;
  border: 1px solid var(--fb-line);
  background: var(--fb-card);
  color: var(--fb-blue);
  border-radius: var(--fb-radius-input);
  padding: 6px 10px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.cats__edit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cats__delete {
  flex-shrink: 0;
  border: 1px solid var(--fb-line);
  background: var(--fb-card);
  color: var(--fb-danger);
  border-radius: var(--fb-radius-input);
  padding: 6px 10px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.cats__delete:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cats__empty {
  margin: 0;
  padding: 12px 0;
  text-align: center;
  font-size: 12px;
  color: var(--fb-sub);
}

.cats__notice {
  margin: 14px 0 0;
  text-align: center;
  font-size: 12px;
  color: var(--fb-blue);
}

.cats__mask {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: var(--fb-overlay-scrim);
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
}

.cats__confirm {
  width: 340px;
  max-width: 92vw;
  background: var(--fb-card);
  border-radius: 18px;
  padding: 18px;
  box-shadow: 0 10px 30px var(--fb-shadow-pop);
}

.cats__confirm h3 {
  margin: 0 0 8px;
  font-size: 15px;
}

.cats__warn {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--fb-ink);
  font-variant-numeric: var(--fb-font-numeric);
}

.cats__confirm-actions {
  display: flex;
  gap: 10px;
}

.cats__confirm-actions > button {
  flex: 1;
}

.cats__state {
  margin-top: 14px;
  padding: 20px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--fb-sub);
}

.cats__state--error {
  color: var(--fb-danger);
}

.cats__state p {
  margin: 0 0 12px;
}
</style>
