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
  flattenAccountTree,
  groupAccountsByType,
  isClosed,
} from '@/core/accounts'
import { buildSortOrders, moveItem, sortBySortOrder } from '@/core/ordering'
import { accountLabel, accountOptionLabel, indentOptionLabel, todayString } from '@/core/record'
import { readCategoryOrder, writeCategoryOrder } from '@/core/storage'
import { markDirty } from '@/stores/dataFreshness'
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
/** 本地草稿：按 type 存 uuid 序列（旧 number[] 由 storage 层降级清理）。 */
const dragOrders = reactive<{ [type: string]: string[] }>({})
const sorting = ref(false)

const newType = ref<'Expenses' | 'Income'>('Expenses')
const newName = ref('')
/** owner 可选的 ASCII 账号段；留空维持 ItemN 自动生成。 */
const customAscii = ref('')
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
    notice.value = '只读成员不能调整排序'
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
  notice.value = '正在保存排序…'
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
      notice.value = `排序已保存（${res.updated} 项，其他端刷新后同步）`
      markDirty('local-write')
    } else {
      notice.value = `排序仅更新 ${res.updated}/${orders.length} 项，请刷新后核对`
    }
  } catch (err) {
    notice.value =
      err instanceof ApiError
        ? `排序草稿已存本设备，但同步失败：${err.message}`
        : '排序草稿已存本设备，但同步失败，请稍后重试'
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
const noParentOptionText = computed(
  () => `无 · 直接挂在类型根下（生成 ${newType.value}:新段 两段全名）`,
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
    return '英文账号不能包含冒号或空格，例如 Food'
  }
  if (!/^[A-Z0-9]/.test(value)) {
    return '英文账号需以大写字母或数字开头，例如 Food（中文请填显示名）'
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
      name: makeAsciiCategoryName(parent, type, customAscii.value),
      display_name: label.split(':').join(' · '),
      type,
      open_date: ledgerOpeningDate < todayString() ? ledgerOpeningDate : todayString(),
      parent_uuid: parent !== null ? parent.uuid : '',
    })
    newName.value = ''
    newParentId.value = null
    customAscii.value = ''
    notice.value = `分类「${label}」已创建`
    markDirty('local-write')
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
    markDirty('local-write')
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
    const res = await accountApi.list({ includeClosed: true })
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
            <option value="">{{ noParentOptionText }}</option>
            <!-- 单行排版：避免 Vue 模板空白 condense 产生前导空格，干扰缩进前缀断言 -->
            <option v-for="opt in parentOptionsFlat" :key="opt.account.id" :value="String(opt.account.id)">{{ indentOptionLabel(accountOptionLabel(opt.account), opt.depth) }}</option>
          </select>
          <input
            class="fb-input cats__name"
            :value="newName"
            placeholder="中文显示名，如：早餐"
            @change="onNewNameChange"
          />
          <input
            v-if="session.isOwner"
            class="fb-input cats__ascii"
            v-model="customAscii"
            placeholder="英文账号（可选），如 Food"
          />
          <button type="button" class="fb-btn-primary cats__submit" :disabled="creating || session.isViewer" @click="createCategory">
            {{ creating ? '创建中…' : '创建' }}
          </button>
        </div>
        <p class="cats__hint">
          只填中文显示名即可，系统自动生成 Beancount 合法的英文全名；owner 可另填可选英文账号（留空仍自动生成）。
          选中上级会通过 parent_uuid 建立显式父子关系，刷新 / 换端后层级不退化。拖拽行排序会自动保存并同步到其他端。
        </p>
        <p v-if="session.isOwner && customAsciiHint" class="cats__hint cats__hint--warn" role="status">{{ customAsciiHint }}</p>
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

.cats__ascii {
  flex: 0 0 132px;
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
