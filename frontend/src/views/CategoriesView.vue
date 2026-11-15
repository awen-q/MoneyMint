<script setup lang="ts">
/**
 * P-09 分类管理（批 2）：Expenses / Income 二级分类增删 + 拖拽排序
 *
 * - 分类 = 类型账户（三层 `Expenses:食品饮料:食品`），创建走 POST /api/accounts，
 *   删除走 DELETE（Beancount close，余额非 0 时 409 + balances 差额明细）；
 * - 拖拽用原生 HTML5 draggable（§14.5 #2 Must，禁止引库），排序逻辑层在
 *   core/ordering.ts；⚠️ 后端 `UpdateAccountSortOrder` 尚未暴露 REST 端点，
 *   本期排序为会话内生效（不持久化），见交付说明的已知遗留。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'

import { accountApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { AccountView } from '@/api/types'
import {
  balanceOf,
  buildAccountTree,
  flattenAccountTree,
  groupAccountsByType,
  isClosed,
} from '@/core/accounts'
import { moveItem, sortBySortOrder } from '@/core/ordering'
import { accountLabel, todayString } from '@/core/record'
import { readCategoryOrder, writeCategoryOrder } from '@/core/storage'
import { useSessionStore } from '@/stores/session'
import MoneyText from '@/components/MoneyText.vue'

const session = useSessionStore()

const accounts = ref<AccountView[]>([])
const loading = ref(false)
const loadError = ref('')
const notice = ref('')
const busyUuid = ref<string | null>(null)

const dragIndex = ref<number | null>(null)
const dragGroup = ref('')
const dragOrders = reactive<{ [type: string]: number[] }>({})

const newType = ref<'Expenses' | 'Income'>('Expenses')
const newName = ref('')
const creating = ref(false)
const deleteTarget = ref<AccountView | null>(null)

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
        const index = order.indexOf(account.id)
        return index === -1 ? order.length + account.id : index
      })
    }
    const compare =
      order === undefined
        ? undefined
        : (a: AccountView, b: AccountView) => {
            const indexA = order.indexOf(a.id)
            const indexB = order.indexOf(b.id)
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
  if (event.dataTransfer !== null) {
    event.dataTransfer.effectAllowed = 'move'
  }
}

function onDragOver(event: DragEvent): void {
  event.preventDefault()
}

function onDrop(groupType: string, index: number): void {
  if (dragGroup.value !== groupType || dragIndex.value === null) {
    return
  }
  const from = dragIndex.value
  if (from === null) {
    return
  }
  const group = groups.value.find((g) => g.type === groupType)
  if (group === undefined) {
    return
  }
  const next = moveItem(
    group.rows.map((row) => row.account),
    from,
    index,
  )
  const ids: number[] = []
  for (const item of next) {
    ids.push(item.id)
  }
  dragOrders[groupType] = ids
  dragIndex.value = null
  dragGroup.value = ''
  // §14.5 #2：顺序写回本地（按账本命名空间），刷新后保持。
  const orderSnapshot: Record<string, number[]> = {}
  for (const key of Object.keys(dragOrders)) {
    orderSnapshot[key] = dragOrders[key].slice()
  }
  if (session.ledgerId !== null) {
    writeCategoryOrder(session.ledgerId, orderSnapshot)
  }
  notice.value = '排序已保存（本设备生效；后端排序端点开放后可与多端同步）'
}

/** 0.6.0 S2：新建分类的可选上级（未关闭的 Expenses / Income 账户）。 */
const newParentId = ref<number | null>(null)

const parentOptions = computed(() =>
  accounts.value.filter(
    (account) =>
      !isClosed(account) && (account.type === 'Expenses' || account.type === 'Income'),
  ),
)

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
 * 0.6.0 S2：界面只收中文显示名，name 按 seed 规则生成 ASCII 合法全名，
 * 避免落库后才报 Invalid account name（C-03）。
 */
function makeAsciiCategoryName(parent: AccountView | null, type: string): string {
  const base = parent !== null ? parent.name : type
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

/** 创建分类：同样传 parent_uuid（与 AccountForm 统一，AC-2.5）。 */
async function createCategory(): Promise<void> {
  if (creating.value) {
    return
  }
  notice.value = ''
  const label = newName.value.trim()
  if (label === '') {
    notice.value = '请输入分类名称'
    return
  }
  if (label.split(':').some((part) => part.trim() === '')) {
    notice.value = '分类名称的每一段都不能为空'
    return
  }
  const parent = resolveNewParent()
  // 选中上级时类型继承父项，避免父子类型不一致被后端 409 拒绝。
  const type = parent !== null ? parent.type : newType.value
  creating.value = true
  try {
    const ledgerOpeningDate = ledgerOpening()
    await accountApi.create({
      name: makeAsciiCategoryName(parent, type),
      display_name: label.split(':').join(' · '),
      type,
      open_date: ledgerOpeningDate < todayString() ? ledgerOpeningDate : todayString(),
      parent_uuid: parent !== null ? parent.uuid : '',
    })
    newName.value = ''
    newParentId.value = null
    notice.value = `分类「${label}」已创建`
    await load()
  } catch (err) {
    notice.value = err instanceof ApiError ? err.message : '创建失败，请稍后重试'
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
    notice.value = '只读成员不能删除分类'
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
    notice.value = `分类「${accountLabel(target)}」已关闭`
    deleteTarget.value = null
    await load()
  } catch (err) {
    notice.value = err instanceof ApiError ? `${err.message}` : '关闭失败，请稍后重试'
  } finally {
    busyUuid.value = null
  }
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const res = await accountApi.list()
    accounts.value = Array.isArray(res.accounts) ? res.accounts : []
    // §14.5 #2：恢复本地持久化的拖拽顺序（按账本命名空间）。
    if (session.ledgerId !== null) {
      Object.assign(dragOrders, readCategoryOrder(session.ledgerId))
    }
  } catch (err) {
    loadError.value = err instanceof ApiError ? err.message : '分类加载失败'
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
      <span class="cats__label">分类管理 · 分类即类型账户（三层命名）</span>
    </header>

    <div v-if="loadError" class="fb-card cats__state cats__state--error">
      <p>{{ loadError }}</p>
      <button class="fb-btn-ghost" type="button" @click="load">重新加载</button>
    </div>
    <div v-else-if="loading" class="fb-card cats__state">正在加载分类…</div>

    <template v-else>
      <div class="fb-card cats__card">
        <h3>新建分类</h3>
        <div class="cats__create">
          <select
            class="fb-input cats__type"
            :value="newType"
            :disabled="newParentId !== null"
            @change="onNewTypeChange"
          >
            <option value="Expenses">支出分类</option>
            <option value="Income">收入分类</option>
          </select>
          <select
            class="fb-input cats__type"
            :value="newParentId === null ? '' : String(newParentId)"
            @change="onNewParentChange"
          >
            <option value="">无上级（挂在类型根下）</option>
            <option v-for="option in parentOptions" :key="option.id" :value="String(option.id)">
              {{ accountLabel(option) }}
            </option>
          </select>
          <input
            class="fb-input cats__name"
            :value="newName"
            placeholder="中文显示名，如：早餐"
            @change="onNewNameChange"
          />
          <button type="button" class="fb-btn-primary cats__submit" :disabled="creating || session.isViewer" @click="createCategory">
            {{ creating ? '创建中…' : '创建' }}
          </button>
        </div>
        <p class="cats__hint">
          只填中文显示名，系统自动生成 Beancount 合法的英文全名；选中上级会通过
          parent_uuid 建立显式父子关系，刷新 / 换端后层级不退化。拖拽行可排序（会话内生效）。
        </p>
      </div>

      <div v-for="group in groups" :key="group.type" class="fb-card cats__card">
        <h3>{{ group.label }}（{{ group.rows.length }}）</h3>
        <p v-if="group.rows.length === 0" class="cats__empty">暂无{{ group.label }}。</p>
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
            <span class="cats__info">
              <span class="cats__name">
                {{ accountLabel(row.account) }}
                <span v-if="isClosed(row.account)" class="cats__closed">已关闭</span>
              </span>
              <span class="cats__meta">
                {{ row.account.name }} · {{ balanceText(row.account) }}
                <template v-if="row.childCount > 0"> · 小计 {{ rowSubtotalText(row) }}</template>
              </span>
            </span>
            <button
              type="button"
              class="cats__delete"
              :disabled="busyUuid !== null || session.isViewer"
              @click="askDelete(row.account)"
            >删除</button>
          </li>
        </ul>
      </div>

      <p v-if="notice" class="cats__notice" role="status">{{ notice }}</p>

      <div v-if="deleteTarget !== null" class="cats__mask" @click.self="deleteTarget = null">
        <div class="cats__confirm">
          <h3>关闭分类</h3>
          <p class="cats__warn">
            「{{ accountLabel(deleteTarget) }}」余额为
            {{ balanceText(deleteTarget) }}。分类关闭走 Beancount close：
            余额非 0 会被服务端拒绝并返回差额明细；确认继续？
          </p>
          <div class="cats__confirm-actions">
            <button type="button" class="fb-btn-ghost" @click="deleteTarget = null">取消</button>
            <button type="button" class="fb-btn-primary" :disabled="busyUuid !== null" @click="confirmDelete">
              {{ busyUuid !== null ? '处理中…' : '确认关闭' }}
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

.cats__create {
  display: flex;
  gap: 8px;
}

.cats__type {
  flex: 0 0 110px;
}

.cats__name {
  flex: 1;
  min-width: 0;
}

.cats__submit {
  flex: 0 0 auto;
}

.cats__hint {
  margin: 10px 0 0;
  font-size: 11px;
  color: var(--fb-sub);
  line-height: 1.7;
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
  background: rgba(20, 28, 48, 0.45);
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
  box-shadow: 0 10px 30px rgba(23, 32, 68, 0.2);
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
