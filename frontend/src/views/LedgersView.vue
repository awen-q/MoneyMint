<script setup lang="ts">
/**
 * P-13 账本管理 / 切换（批 3）
 *
 * 与旧版 ledgers_screen.dart + ledger_switcher.dart 1:1：列表（当前徽章 + 角色）、
 * 新建（默认币种 CNY）、改名（owner）、切换账本、期初日期（owner 专属、
 * 二次确认、上界 = min(今日, 最早非 opening 交易)）。
 *
 * 0.6.0 S1 新增「删除账本」：仅 owner 且除 owner 外 0 成员可用，输入账本名
 * 确认词后提交；确认弹窗展示账户数 / 交易数（P1-03）。后端按序做成员门禁、
 * 禁删最后一个账本、pre-ledger-delete 一致性快照与软删；删除后
 * session.refreshLedgers() 兜底切到最小有效账本（AC-1.4 / R3）。
 *
 * 后端 PATCH /api/ledgers/{id} 的 name / default_commodity 是**非指针字段**：
 * 改名或改期初日期时必须把两者都带上，否则 name 空串会被拒、币种会被清空。
 */
import { computed, onMounted, ref } from 'vue'

import { ledgerManageApi, transactionApi } from '@/api/client'
import { ApiError, codeMessage } from '@/api/errors'
import type { LedgerView } from '@/api/types'
import { todayString } from '@/core/record'
import { t } from '@/i18n'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()

const loading = ref(false)
const busy = ref(false)
const loadError = ref('')
const notice = ref('')
const actionError = ref('')

const createOpen = ref(false)
const newName = ref('')
const renameTargetId = ref<number | null>(null)
const renameValue = ref('')

const openingOpen = ref(false)
const openingValue = ref('')
const openingCount = ref(0)
const openingBound = ref(todayString())

// ---- 0.6.0 删除账本 ----
const deleteTargetId = ref<number | null>(null)
const deleteConfirm = ref('')
const deleteTarget = computed<LedgerView | null>(() => {
  for (const ledger of session.ledgers) {
    if (ledger.id === deleteTargetId.value) {
      return ledger
    }
  }
  return null
})
// 模板只消费下面这些字符串 / 数字 computed，避免 v-if 内对可空对象做属性访问。
const deleteName = computed(() => (deleteTarget.value === null ? '' : deleteTarget.value.name))
const deleteAccountCount = computed(() =>
  deleteTarget.value === null ? 0 : statOf(deleteTarget.value.account_count),
)
const deleteTxnCount = computed(() =>
  deleteTarget.value === null ? 0 : statOf(deleteTarget.value.transaction_count),
)
const deleteMemberCount = computed(() =>
  deleteTarget.value === null ? 0 : statOf(deleteTarget.value.member_count),
)
const canSubmitDelete = computed(
  () => deleteName.value !== '' && deleteConfirm.value === deleteName.value,
)

const currentLedger = computed(() => {
  for (const ledger of session.ledgers) {
    if (ledger.id === session.ledgerId) {
      return ledger
    }
  }
  return null
})
const isOwner = computed(() => currentLedger.value !== null && currentLedger.value.role === 'owner')

/** 兼容旧响应：统计字段 0.6.0 才下发，缺失按 0 处理，不用 `??` / `.at()` 等新 API。 */
function statOf(value: number | undefined): number {
  return value === undefined ? 0 : value
}

/** 角色中文标签（值与原 core/batch3.roleLabel 逐字节一致，阶段 2 只迁视图）。 */
function roleText(role: LedgerView['role'] | ''): string {
  if (role === 'owner') {
    return t('common.roleOwner')
  }
  if (role === 'editor') {
    return t('common.roleEditor')
  }
  if (role === 'viewer') {
    return t('common.roleViewer')
  }
  return t('common.roleNone')
}

/** 稳定错误码优先走集中映射，未知码回退后端可读文案，绝不展示 HTTP 原文。 */
function messageOf(err: unknown): string {
  if (err instanceof ApiError) {
    const mapped = err.code === undefined ? '' : codeMessage(err.code)
    return mapped !== '' ? mapped : err.message
  }
  return t('ledgers.errGeneric')
}

async function reload(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    await session.refreshLedgers()
  } catch (err) {
    loadError.value = messageOf(err)
  } finally {
    loading.value = false
  }
}

async function run(action: () => Promise<unknown>, success: string): Promise<void> {
  if (busy.value) {
    return
  }
  busy.value = true
  actionError.value = ''
  notice.value = ''
  try {
    await action()
    notice.value = success
    await reload()
  } catch (err) {
    actionError.value = messageOf(err)
  } finally {
    busy.value = false
  }
}

function submitCreate(): void {
  const name = newName.value.trim()
  if (name === '') {
    actionError.value = t('ledgers.errNameRequired')
    return
  }
  void run(async () => {
    const created = await ledgerManageApi.create({ name, default_commodity: 'CNY' })
    await session.refreshLedgers()
    session.selectLedger(created.id)
    createOpen.value = false
    newName.value = ''
  }, t('ledgers.noticeCreated', { name }))
}

function openRename(id: number, name: string): void {
  renameTargetId.value = id
  renameValue.value = name
  actionError.value = ''
}

function submitRename(): void {
  const id = renameTargetId.value
  if (id === null) {
    return
  }
  const name = renameValue.value.trim()
  if (name === '') {
    actionError.value = t('ledgers.errNameEmpty')
    return
  }
  let targetName = name
  let commodity = 'CNY'
  for (const ledger of session.ledgers) {
    if (ledger.id === id) {
      commodity = ledger.default_commodity || 'CNY'
      targetName = name
    }
  }
  void run(async () => {
    await ledgerManageApi.update(id, { name: targetName, default_commodity: commodity })
    renameTargetId.value = null
  }, t('ledgers.noticeRenamed'))
}

/** 打开删除确认：owner 且除 owner 外无其他成员才可用（AC-1.2）。 */
function openDelete(ledger: LedgerView): void {
  actionError.value = ''
  notice.value = ''
  if (ledger.role !== 'owner') {
    return
  }
  const others = statOf(ledger.member_count)
  if (others > 0) {
    actionError.value = t('ledgers.errHasMembers', { n: String(others) })
    return
  }
  deleteTargetId.value = ledger.id
  deleteConfirm.value = ''
}

function closeDelete(): void {
  deleteTargetId.value = null
  deleteConfirm.value = ''
}

/** 确认词必须与账本名完全一致才提交；后端另有成员 / 最后账本 / 快照门禁。 */
function submitDelete(): void {
  const id = deleteTargetId.value
  const name = deleteName.value
  if (id === null || !canSubmitDelete.value) {
    return
  }
  void run(async () => {
    await ledgerManageApi.remove(id)
    closeDelete()
    // run 内的 reload() 会刷新清单；若删的是当前账本，
    // session.refreshLedgers() 兜底切到最小有效账本（AC-1.4）。
  }, t('ledgers.noticeDeleted', { name }))
}

async function openOpening(): Promise<void> {
  actionError.value = ''
  notice.value = ''
  openingValue.value = currentLedger.value === null ? todayString() : currentLedger.value.opening_date
  // 上界 = min(今日, 最早一笔非 opening 交易日期)；同时统计将被重建的期初笔数。
  let bound = todayString()
  let count = 0
  try {
    const res = await transactionApi.list()
    const txns = Array.isArray(res.transactions) ? res.transactions : []
    let earliest = ''
    for (const txn of txns) {
      const tags = txn.tags === undefined ? [] : txn.tags
      if (tags.indexOf('opening') >= 0) {
        count += 1
        continue
      }
      if (earliest === '' || txn.date < earliest) {
        earliest = txn.date
      }
    }
    if (earliest !== '' && earliest < bound) {
      bound = earliest
    }
  } catch (err) {
    actionError.value = t('ledgers.errOpeningOnlineOnly', { message: messageOf(err) })
    return
  }
  openingBound.value = bound
  openingCount.value = count
  openingOpen.value = true
}

function submitOpening(): void {
  const id = session.ledgerId
  const ledger = currentLedger.value
  if (id === null || ledger === null) {
    return
  }
  const value = openingValue.value
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    actionError.value = t('ledgers.errOpeningDateInvalid')
    return
  }
  if (value > openingBound.value) {
    actionError.value = t('ledgers.errOpeningTooLate', { bound: openingBound.value })
    return
  }
  void run(async () => {
    await ledgerManageApi.update(id, {
      name: ledger.name,
      default_commodity: ledger.default_commodity || 'CNY',
      opening_date: value,
    })
    openingOpen.value = false
  }, t('ledgers.noticeOpeningUpdated', { date: value }))
}

function switchTo(id: number, name: string): void {
  if (id === session.ledgerId) {
    return
  }
  session.selectLedger(id)
  notice.value = t('ledgers.noticeSwitched', { name })
  actionError.value = ''
}

onMounted(() => { void reload() })
</script>

<template>
  <section class="ldg">
    <header class="ldg__hero fb-hero">
      <span class="ldg__title">{{ t('ledgers.title') }}</span>
      <span class="ldg__sub">{{ t('ledgers.subtitle') }}</span>
    </header>

    <div class="fb-card ldg__toolbar">
      <span class="fb-muted">{{ t('ledgers.totalLedgers', { n: String(session.ledgers.length) }) }}</span>
      <button class="fb-btn-primary ldg__btn" type="button" :disabled="busy" @click="createOpen = true">{{ t('ledgers.create') }}</button>
    </div>

    <p v-if="notice" class="ldg__notice ldg__notice--ok" role="status">{{ notice }}</p>
    <p v-if="actionError" class="ldg__notice ldg__notice--err" role="alert">{{ actionError }}</p>

    <div v-if="createOpen" class="fb-card ldg__panel">
      <h2>{{ t('ledgers.create') }}</h2>
      <label class="ldg__field">
        <span>{{ t('ledgers.nameLabel') }}</span>
        <input v-model="newName" class="fb-input" type="text" :placeholder="t('ledgers.namePlaceholder')" />
      </label>
      <div class="ldg__actions">
        <button class="fb-btn-ghost" type="button" @click="createOpen = false">{{ t('ledgers.cancel') }}</button>
        <button class="fb-btn-primary" type="button" :disabled="busy" @click="submitCreate">{{ t('ledgers.createAndSwitch') }}</button>
      </div>
    </div>

    <div v-if="renameTargetId !== null" class="fb-card ldg__panel">
      <h2>{{ t('ledgers.renameTitle') }}</h2>
      <label class="ldg__field">
        <span>{{ t('ledgers.newNameLabel') }}</span>
        <input v-model="renameValue" class="fb-input" type="text" />
      </label>
      <div class="ldg__actions">
        <button class="fb-btn-ghost" type="button" @click="renameTargetId = null">{{ t('ledgers.cancel') }}</button>
        <button class="fb-btn-primary" type="button" :disabled="busy" @click="submitRename">{{ t('ledgers.save') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="fb-card ldg__state ldg__state--err">
      <p>{{ t('ledgers.loadFailed', { message: loadError }) }}</p>
      <button class="fb-btn-ghost" type="button" @click="reload">{{ t('ledgers.reload') }}</button>
    </div>
    <div v-else-if="loading" class="fb-card ldg__state">{{ t('ledgers.loading') }}</div>
    <div v-else-if="session.ledgers.length === 0" class="fb-card ldg__state">{{ t('ledgers.empty') }}</div>
    <div v-else class="fb-card ldg__list">
      <div v-for="ledger in session.ledgers" :key="ledger.id" class="ldg__row">
        <span class="ldg__icon">▤</span>
        <span class="ldg__name">
          {{ ledger.name }}
          <small>
            {{ t('ledgers.rowMeta', {
              role: roleText(ledger.role),
              date: ledger.opening_date,
              accounts: String(statOf(ledger.account_count)),
              txns: String(statOf(ledger.transaction_count)),
            }) }}
          </small>
          <em v-if="ledger.id === session.ledgerId" class="ldg__current">{{ t('ledgers.current') }}</em>
        </span>
        <button
          v-if="ledger.id !== session.ledgerId"
          class="fb-btn-ghost ldg__btn"
          type="button"
          @click="switchTo(ledger.id, ledger.name)"
        >{{ t('ledgers.switch') }}</button>
        <button
          v-if="ledger.role === 'owner'"
          class="fb-btn-ghost ldg__btn"
          type="button"
          :disabled="busy"
          @click="openRename(ledger.id, ledger.name)"
        >{{ t('ledgers.rename') }}</button>
        <button
          v-if="ledger.role === 'owner'"
          class="fb-btn-ghost ldg__btn ldg__btn--danger"
          type="button"
          :disabled="busy || statOf(ledger.member_count) > 0"
          :title="statOf(ledger.member_count) > 0 ? t('ledgers.deleteBlockedTitle', { n: String(statOf(ledger.member_count)) }) : t('ledgers.deleteTooltip')"
          @click="openDelete(ledger)"
        >{{ t('ledgers.delete') }}</button>
      </div>
    </div>

    <div v-if="isOwner && currentLedger" class="fb-card ldg__panel ldg__opening">
      <h2>{{ t('ledgers.openingTitle') }}</h2>
      <p class="fb-muted">{{ t('ledgers.openingHint', { date: currentLedger.opening_date }) }}</p>
      <button class="fb-btn-ghost" type="button" :disabled="busy" @click="openOpening">{{ t('ledgers.openingAdjust') }}</button>
    </div>

    <div v-if="openingOpen" class="fb-card ldg__panel ldg__panel--danger">
      <h2>{{ t('ledgers.openingConfirmTitle') }}</h2>
      <p>
        {{ t('ledgers.openingConfirmBody', {
          from: currentLedger ? currentLedger.opening_date : '—',
          to: openingValue,
          n: String(openingCount),
        }) }}
      </p>
      <label class="ldg__field">
        <span>{{ t('ledgers.openingDateLabel', { bound: openingBound }) }}</span>
        <input v-model="openingValue" class="fb-input" type="date" :max="openingBound" />
      </label>
      <div class="ldg__actions">
        <button class="fb-btn-ghost" type="button" @click="openingOpen = false">{{ t('ledgers.cancel') }}</button>
        <button class="fb-btn-primary" type="button" :disabled="busy" @click="submitOpening">{{ t('ledgers.openingConfirmSubmit') }}</button>
      </div>
    </div>

    <div v-if="deleteTargetId !== null" class="fb-card ldg__panel ldg__panel--danger">
      <h2>{{ t('ledgers.deleteTitle', { name: deleteName }) }}</h2>
      <p>
        {{ t('ledgers.deleteBody', {
          accounts: String(deleteAccountCount),
          txns: String(deleteTxnCount),
          members: String(deleteMemberCount),
        }) }}
      </p>
      <label class="ldg__field">
        <span>{{ t('ledgers.deleteConfirmLabel', { name: deleteName }) }}</span>
        <input v-model="deleteConfirm" class="fb-input" type="text" :placeholder="deleteName" />
      </label>
      <div class="ldg__actions">
        <button class="fb-btn-ghost" type="button" @click="closeDelete">{{ t('ledgers.cancel') }}</button>
        <button
          class="fb-btn-primary"
          type="button"
          :disabled="busy || !canSubmitDelete"
          @click="submitDelete"
        >{{ t('ledgers.deleteConfirmSubmit') }}</button>
      </div>
    </div>

    <p class="ldg__hint">{{ t('ledgers.hint') }}</p>
  </section>
</template>

<style scoped>
.ldg { padding-bottom: 20px; }
.ldg__hero { padding: calc(20px + env(safe-area-inset-top, 0px)) 20px 20px; border-radius: 0 0 24px 24px; }
.ldg__title { display: block; font-size: 16px; font-weight: 700; }
.ldg__sub { display: block; margin-top: 4px; font-size: 12px; color: var(--fb-on-hero-muted); }
.ldg__toolbar { margin-top: 14px; padding: 12px 14px; display: flex; align-items: center; justify-content: space-between; font-size: 12px; }
.ldg__btn { padding: 6px 12px; font-size: 12px; }
.ldg__btn--danger { color: var(--fb-danger); }
.ldg__notice { margin: 10px 0 0; padding: 8px 12px; border-radius: var(--fb-radius-input); font-size: 12px; }
.ldg__notice--ok { background: var(--fb-green-soft); color: var(--fb-green-ink); }
.ldg__notice--err { background: var(--fb-danger-soft); color: var(--fb-danger-ink); }
.ldg__panel { margin-top: 12px; padding: 14px 16px; }
.ldg__panel h2 { margin: 0 0 10px; font-size: 14px; }
/* 确认弹窗里的期初日期与账户 / 交易 / 成员笔数按等宽对齐。 */
.ldg__panel p { margin: 0 0 10px; font-size: 12px; font-variant-numeric: var(--fb-font-numeric); }
.ldg__panel--danger { border: 1px solid var(--fb-warn); }
.ldg__field { display: block; margin-bottom: 10px; font-size: 12px; color: var(--fb-sub); }
.ldg__field span { display: block; margin-bottom: 4px; }
.ldg__field .fb-input { width: 100%; max-width: 260px; }
.ldg__actions { display: flex; justify-content: flex-end; gap: 8px; }
.ldg__list { margin-top: 12px; padding: 6px 14px; }
.ldg__row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--fb-line); flex-wrap: wrap; }
.ldg__row:last-child { border-bottom: none; }
.ldg__icon { font-size: 18px; color: var(--fb-blue); }
.ldg__name { flex: 1; min-width: 130px; font-size: 13px; }
.ldg__name small { display: block; font-size: 11px; color: var(--fb-sub); font-variant-numeric: var(--fb-font-numeric); }
.ldg__current { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: var(--fb-radius-pill); background: var(--fb-green-soft); color: var(--fb-green-ink); font-size: 10px; font-style: normal; }
.ldg__opening { margin-top: 14px; }
.ldg__state { margin-top: 14px; padding: 28px 16px; text-align: center; font-size: 13px; color: var(--fb-sub); }
.ldg__state--err { color: var(--fb-danger); }
.ldg__state p { margin: 0 0 12px; }
.ldg__hint { margin: 14px 4px 0; font-size: 11px; color: var(--fb-sub); line-height: 1.7; }
</style>
