<script setup lang="ts">
/**
 * P-06 回收站（批 2）+ B7 永久删除
 *
 * 数据源：`GET /api/transactions/trash`（后端 M3 端点）。
 * B7 起同一响应 additive 追加两键：
 *   - `purge_summary`：{deletable, system_kept, paired}，**必须由服务端算**——
 *     冲正闭包会把「不在回收站的有效配对交易」拉进来，前端只看得见回收站那几行，
 *     自己数出来的 N 一定小于真实删除数，用户会以为丢账；
 *   - `purge_log`：最近 50 条本机永久删除审计（全体成员可见，含 viewer）。
 *
 * 权限：两个删除入口都是 **owner-only**，由服务端逐条下发 `can_purge` 控制显隐
 * （前端角色判断不是安全边界，后端会独立复核并可能返回 403）。
 *
 * 弹层一律复用 `components/shell/SelectSheet.vue`：滚动锁 / focus trap / ESC /
 * 遮罩点击都在底座里。**不要在本文件再写一套遮罩或 body 锁**——两套锁会互清
 * 内联样式，关闭后页面会跳到顶部（MoreSheet 头注释里记着这个坑）。
 */
import { computed, onMounted, ref, watch } from 'vue'

import { PURGE_CONFIRM_WORD, transactionApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { PurgeLogEntry, PurgeSummary, TrashItemView } from '@/api/types'
import SelectSheet from '@/components/shell/SelectSheet.vue'
import { formatSessionTime } from '@/core/batch3'
import { formatMoney } from '@/core/Money'
import { t } from '@/i18n'
import { markDirty } from '@/stores/dataFreshness'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()

/** 弹层状态机：none → menu → row-confirm；none → purge-all。 */
type SheetState = 'none' | 'menu' | 'row-confirm' | 'purge-all'

/**
 * 清空弹层里用户必须手输的词（与请求体的 confirm 词不是同一个概念）。
 *
 * 注意：**请求体**的确认词 `PURGE_CONFIRM_WORD`（「删除」）是后端契约常量，
 * 必须保持字面量、绝不 t() 化（en 下后端仍严等「删除」，本地化会让校验永远失败）；
 * 这里只是本弹层的解锁词，随语言切换，不发给后端。
 */
const purgeAllPhrase = computed(() => t('trash.purgeAllPhrase'))

const items = ref<TrashItemView[]>([])
const summary = ref<PurgeSummary>({ deletable: 0, system_kept: 0, paired: 0 })
const auditLog = ref<PurgeLogEntry[]>([])

const loading = ref(false)
const loadError = ref('')
const notice = ref('')

/**
 * busyUuid 只服务于「恢复中…」这行文案（恢复是唯一有进度感知的动作）；
 * busy 才是所有删除 / 恢复入口的总开关（防双击，口径与批 2 的互斥一致）。
 */
const busyUuid = ref<string | null>(null)
const busy = ref(false)

const sheet = ref<SheetState>('none')
const activeItem = ref<TrashItemView | null>(null)
const purgeAllInput = ref('')

const sorted = computed(() =>
  items.value.slice().sort((a, b) => (a.deleted_at < b.deleted_at ? 1 : -1)),
)

/**
 * 是否至少有一条「服务端说我能删」的记录（= 当前用户是否 owner 且有可删项）。
 *
 * 用于把「清空回收站」入口 + 「可永久删除 N 笔」计数**整块**收起：
 * 非 owner（editor / viewer）下服务端逐条返回 `can_purge=false`，此时若只禁用按钮
 * 而继续显示计数，等于「告诉你可删 N 笔，但不给你入口」——死路提示，比不显示更差。
 * 审计区块不受本开关影响（全体成员可见是已定口径）。
 */
const hasPurgeable = computed(() => items.value.some((item) => item.can_purge === true))

/**
 * 清空入口可用条件：有可删项 + 当前用户至少有一条 can_purge + 不在忙态。
 *
 * 第二个条件是对定稿「`deletable > 0 && !busy`」的**等价收紧**：
 * `deletable` 是数据口径（服务端按闭包算，与角色无关），editor / viewer 拿到的
 * `deletable` 也可能 > 0。若不看 `can_purge`，他们的按钮会亮着、点下去必然 403
 * （复用同一份服务端权限信号，比本地推角色更不容易与后端脱节）。
 * 对 owner 而言两者完全等价：`deletable > 0` 必然意味着回收站里至少有一条
 * `can_purge === true`（全被系统判定保留时 deletable 就是 0）。
 */
const canPurgeAll = computed(
  () => summary.value.deletable > 0 && hasPurgeable.value && !busy.value,
)

/** 手输「清空」严等解锁（不做同义词 / 模糊匹配）。 */
const purgeAllUnlocked = computed(() => purgeAllInput.value.trim() === purgeAllPhrase.value)

const sheetTitle = computed(() => {
  switch (sheet.value) {
    case 'menu':
      return t('trash.sheetTitleRow')
    case 'row-confirm':
      return t('trash.sheetTitleRowConfirm')
    case 'purge-all':
      return t('trash.sheetTitlePurgeAll')
    default:
      return ''
  }
})

function sumPostings(item: TrashItemView): string {
  // 摘要展示：逐币种拼接「符号+金额」，金额用后端定点原值。
  const parts: string[] = []
  for (const posting of item.postings) {
    parts.push(formatMoney(posting.amount, posting.commodity, { signed: true }))
  }
  return parts.join(' / ')
}

/**
 * B7 错误码 → 文案（定稿 §8.3）。
 *
 * 这五条码是后端稳定契约，前端**不要**依赖中文原文匹配；其余错误回落到
 * `err.message`（后端已把不可读的底层错误折成中文）。
 */
function mapPurgeError(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return t('trash.errGeneric')
  }
  switch (err.code) {
    case 'txn_purge_forbidden':
      return t('trash.errForbidden')
    case 'txn_purge_not_deleted':
      return t('trash.errNotDeleted')
    case 'txn_purge_not_allowed':
      return t('trash.errNotAllowed')
    case 'txn_purge_confirm_required':
      return t('trash.errConfirmRequired')
    case 'txn_not_found':
      return t('trash.errNotFound')
    default:
      return err.message
  }
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const res = await transactionApi.trash()
    items.value = Array.isArray(res.transactions) ? res.transactions : []
    // 旧后端不返回这两键：降级为「0 可删 / 无审计」，不报错、不显示入口。
    summary.value = res.purge_summary ?? { deletable: 0, system_kept: 0, paired: 0 }
    auditLog.value = Array.isArray(res.purge_log) ? res.purge_log : []
  } catch (err) {
    loadError.value = err instanceof ApiError ? err.message : t('trash.errLoad')
  } finally {
    loading.value = false
  }
}

async function restore(item: TrashItemView): Promise<void> {
  if (busy.value) {
    return
  }
  busy.value = true
  busyUuid.value = item.uuid
  notice.value = ''
  try {
    await transactionApi.restore(item.uuid)
    notice.value = t('trash.noticeRestored', { name: item.description })
    markDirty('local-write')
    await load()
  } catch (err) {
    notice.value =
      err instanceof ApiError
        ? t('trash.errRestoreWithMessage', { message: err.message })
        : t('trash.errRestore')
  } finally {
    busyUuid.value = null
    busy.value = false
  }
}

/** 打开行内「⋯」菜单（只有 can_purge 的行才有这个按钮）。 */
function openMenu(item: TrashItemView): void {
  if (busy.value) {
    return
  }
  activeItem.value = item
  notice.value = ''
  sheet.value = 'menu'
}

function openRowConfirm(): void {
  if (activeItem.value === null || busy.value) {
    return
  }
  sheet.value = 'row-confirm'
}

function openPurgeAll(): void {
  if (!canPurgeAll.value) {
    return
  }
  activeItem.value = null
  purgeAllInput.value = ''
  notice.value = ''
  sheet.value = 'purge-all'
}

/**
 * 关闭弹层。
 *
 * `row-confirm` 关闭时**退回菜单**而不是直接收起：用户从菜单二级进来，
 * 取消应当回到上一级（与系统 sheet 的心智一致），避免误触后要重新点一遍。
 */
function closeSheet(): void {
  if (sheet.value === 'row-confirm' && !busy.value) {
    sheet.value = 'menu'
    return
  }
  if (busy.value) {
    return
  }
  sheet.value = 'none'
  activeItem.value = null
  purgeAllInput.value = ''
}

/** 单笔永久删除。 */
async function confirmPurgeRow(): Promise<void> {
  const item = activeItem.value
  if (item === null || busy.value) {
    return
  }
  busy.value = true
  try {
    const res = await transactionApi.purge(item.uuid, PURGE_CONFIRM_WORD)
    notice.value =
      res.already_purged === true
        ? t('trash.noticeAlreadyPurged')
        : t('trash.noticePurgedCount', { n: String(res.count) })
    sheet.value = 'none'
    activeItem.value = null
    markDirty('local-write')
    await load()
  } catch (err) {
    // 失败时**不关弹层**：用户需要看到原因（如「系统生成的交易不能永久删除」）
    // 并据此决定是否刷新页面。错误码映射见 mapPurgeError。
    notice.value = mapPurgeError(err)
  } finally {
    busy.value = false
  }
}

/** 清空回收站。 */
async function confirmPurgeAll(): Promise<void> {
  if (!purgeAllUnlocked.value || busy.value) {
    return
  }
  busy.value = true
  try {
    const res = await transactionApi.purgeTrash(PURGE_CONFIRM_WORD)
    // 清空只会命中「空回收站 = 正常结果」，不带 already_purged；
    // summary.system_kept > 0 时先说清保留了多少笔，避免用户以为没删干净。
    const kept = summary.value.system_kept
    notice.value =
      kept > 0
        ? t('trash.noticePurgedWithKept', { n: String(res.count), kept: String(kept) })
        : t('trash.noticePurgedCount', { n: String(res.count) })
    sheet.value = 'none'
    purgeAllInput.value = ''
    markDirty('local-write')
    await load()
  } catch (err) {
    notice.value = mapPurgeError(err)
  } finally {
    busy.value = false
  }
}

watch(
  () => session.ledgerId,
  () => {
    items.value = []
    summary.value = { deletable: 0, system_kept: 0, paired: 0 }
    auditLog.value = []
    sheet.value = 'none'
    activeItem.value = null
    void load()
  },
)

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="trash">
    <header class="trash__hero fb-hero">
      <span class="trash__label">{{ t('trash.heroLabel', { n: String(items.length) }) }}</span>
    </header>

    <div v-if="loadError" class="fb-card trash__state trash__state--error">
      <p>{{ loadError }}</p>
      <button class="fb-btn-ghost" type="button" @click="load">{{ t('trash.retry') }}</button>
    </div>
    <div v-else-if="loading" class="fb-card trash__state">{{ t('trash.loading') }}</div>

    <div v-else class="fb-card trash__card">
      <p v-if="notice" class="trash__notice" role="status">{{ notice }}</p>
      <p v-if="sorted.length === 0" class="trash__empty">{{ t('trash.empty') }}</p>
      <ul v-else class="trash__list">
        <li v-for="item in sorted" :key="item.uuid" class="trash__row">
          <span class="trash__info">
            <span class="trash__desc">{{ item.description }}</span>
            <!-- 删除时间是服务端 UTC 串：必须经 formatSessionTime 转本地，否则凌晨删除会显示成前一天。 -->
            <span class="trash__meta">{{ t('trash.rowMeta', { date: item.date, deletedAt: formatSessionTime(item.deleted_at ?? ''), member: item.created_by_name }) }}</span>
            <span class="trash__meta trash__postings">{{ sumPostings(item) }}</span>
            <!-- 系统交易没有永久删除入口，但必须说明「为什么没有」。 -->
            <span v-if="item.is_system === true" class="trash__sys">{{ t('trash.systemKeptRow') }}</span>
          </span>
          <!-- 0.6.0 S6 AC-5.8：恢复按钮按服务端 can_restore 显隐（viewer 仍可查看回收站）。 -->
          <button
            v-if="item.can_restore === true"
            type="button"
            class="fb-btn-primary trash__restore"
            :disabled="busy"
            @click="restore(item)"
          >{{ busyUuid === item.uuid ? t('trash.restoring') : t('trash.restore') }}</button>
          <span v-else class="trash__norestore">{{ t('trash.norestore') }}</span>
          <!-- B7：永久删除入口（owner-only，服务端逐条判定）。 -->
          <button
            v-if="item.can_purge === true"
            type="button"
            class="fb-btn-ghost trash__more"
            :aria-label="t('trash.moreActions')"
            :disabled="busy"
            @click="openMenu(item)"
          >⋯</button>
        </li>
      </ul>

      <!-- 清空入口 + 可删计数整块按 hasPurgeable 收口：非 owner 不渲染入口也不渲染计数
           （避免「告诉你可删 N 笔但不给你入口」的死路提示）；审计区块不在此开关内。 -->
      <div v-if="hasPurgeable" class="trash__footer">
        <button
          type="button"
          class="fb-btn-ghost trash__purge-all"
          :disabled="!canPurgeAll"
          @click="openPurgeAll"
        >{{ t('trash.purgeAll') }}</button>
        <span v-if="summary.deletable > 0" class="trash__meta">
          {{ t('trash.deletableCount', { n: String(summary.deletable) }) }}
        </span>
      </div>

      <!-- 本机审计（不参与同步）：全体成员可见，含 viewer。 -->
      <section v-if="auditLog.length > 0" class="trash__audit">
        <h2 class="trash__audit-title">{{ t('trash.auditTitle') }}</h2>
        <ul class="trash__audit-list">
          <li v-for="row in auditLog" :key="`${row.purged_at}-${row.uuid}`" class="trash__audit-row">
            <span class="trash__audit-desc">{{ row.description }}</span>
            <span class="trash__meta">
              {{ t('trash.auditMeta', { time: formatSessionTime(row.purged_at), actor: row.actor_name || t('trash.unknownActor'), amount: row.amount_note }) }}
            </span>
          </li>
        </ul>
      </section>
    </div>

    <SelectSheet
      :open="sheet !== 'none'"
      :title="sheetTitle"
      :dialog-label="t('trash.dialogLabel')"
      @close="closeSheet"
    >
      <!-- 一级：行内菜单 -->
      <div v-if="sheet === 'menu'" class="trash__sheet-rows">
        <p class="trash__sheet-desc">「{{ activeItem?.description }}」</p>
        <button type="button" class="trash__sheet-row trash__sheet-row--danger" @click="openRowConfirm">
          {{ t('trash.menuPurge') }}
        </button>
      </div>

      <!-- 二级：单笔永久删除确认 -->
      <div v-else-if="sheet === 'row-confirm'" class="trash__sheet-rows">
        <p class="trash__sheet-desc">
          {{ t('trash.rowConfirmPrefix', { name: activeItem?.description || '' }) }}<strong>{{ t('trash.irreversible') }}</strong>{{ t('trash.rowConfirmSuffix') }}
        </p>
        <p v-if="activeItem?.pair_uuid" class="trash__sheet-warn">
          {{ t('trash.pairWarning') }}
        </p>
        <button
          type="button"
          class="trash__sheet-row trash__sheet-row--danger"
          :disabled="busy"
          @click="confirmPurgeRow"
        >{{ busy ? t('trash.deleting') : t('trash.confirmPurgeRow') }}</button>
        <button type="button" class="trash__sheet-row" :disabled="busy" @click="closeSheet">
          {{ t('trash.cancel') }}
        </button>
      </div>

      <!-- 二级：清空回收站（手输「清空」解锁） -->
      <div v-else-if="sheet === 'purge-all'" class="trash__sheet-rows">
        <p class="trash__sheet-desc">
          <strong>{{ t('trash.irreversible') }}</strong>{{ t('trash.purgeAllIntro') }}
        </p>
        <ul class="trash__sheet-stats">
          <li>{{ t('trash.deletableCount', { n: String(summary.deletable) }) }}</li>
          <li>{{ t('trash.systemKept', { n: String(summary.system_kept) }) }}</li>
          <li v-if="summary.paired > 0">
            {{ t('trash.pairedNote', { n: String(summary.paired) }) }}
          </li>
        </ul>
        <label class="trash__sheet-label" for="trash-purge-confirm">
          {{ t('trash.typeToConfirm', { word: purgeAllPhrase }) }}
        </label>
        <input
          id="trash-purge-confirm"
          v-model="purgeAllInput"
          class="fb-input"
          type="text"
          autocomplete="off"
          :disabled="busy"
        >
        <button
          type="button"
          class="trash__sheet-row trash__sheet-row--danger"
          :disabled="!purgeAllUnlocked || busy"
          @click="confirmPurgeAll"
        >{{ busy ? t('trash.purging') : t('trash.confirmPurgeAll') }}</button>
        <button type="button" class="trash__sheet-row" :disabled="busy" @click="closeSheet">
          {{ t('trash.cancel') }}
        </button>
      </div>
    </SelectSheet>
  </section>
</template>

<style scoped>
.trash {
  padding-bottom: 20px;
}

.trash__hero {
  padding: calc(20px + env(safe-area-inset-top, 0px)) 20px 20px;
  border-radius: 0 0 24px 24px;
}

.trash__label {
  font-size: 15px;
  font-weight: 700;
}

.trash__card {
  margin-top: 14px;
  padding: 14px 16px;
}

.trash__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--fb-line);
}

.trash__row:last-child {
  border-bottom: none;
}

.trash__info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.trash__desc {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash__meta {
  font-size: 11px;
  color: var(--fb-sub);
  font-variant-numeric: var(--fb-font-numeric);
}

.trash__postings {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash__sys {
  font-size: 11px;
  color: var(--fb-sub);
}

.trash__norestore {
  font-size: 11px;
  color: var(--fb-sub);
  flex-shrink: 0;
}

.trash__restore {
  flex-shrink: 0;
}

.trash__more {
  flex-shrink: 0;
  min-width: 40px;
  padding: 10px 8px;
}

.trash__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--fb-line);
}

.trash__purge-all {
  flex-shrink: 0;
}

.trash__audit {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--fb-line);
}

.trash__audit-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 700;
}

.trash__audit-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.trash__audit-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 0;
}

.trash__audit-desc {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash__sheet-rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.trash__sheet-desc {
  margin: 0;
  font-size: 13px;
  color: var(--fb-ink);
}

.trash__sheet-warn {
  margin: 0;
  font-size: 12px;
  color: var(--fb-danger-ink);
}

.trash__sheet-stats {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--fb-sub);
  font-variant-numeric: var(--fb-font-numeric);
}

.trash__sheet-label {
  font-size: 12px;
  color: var(--fb-sub);
}

.trash__sheet-row {
  min-height: 44px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}

.trash__sheet-row:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.trash__sheet-row--danger {
  border: none;
  background: var(--fb-danger);
  color: var(--fb-white);
}

.trash__empty {
  margin: 0;
  padding: 16px 0;
  text-align: center;
  font-size: 12px;
  color: var(--fb-sub);
}

.trash__notice {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--fb-blue);
}

.trash__state {
  margin-top: 14px;
  padding: 20px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--fb-sub);
}

.trash__state--error {
  color: var(--fb-danger);
}

.trash__state p {
  margin: 0 0 12px;
}
</style>
