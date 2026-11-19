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
import { formatMoney } from '@/core/Money'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()

/** 弹层状态机：none → menu → row-confirm；none → purge-all。 */
type SheetState = 'none' | 'menu' | 'row-confirm' | 'purge-all'

/** 清空弹层里用户必须手输的词（与请求体的 confirm 词不是同一个概念）。 */
const PURGE_ALL_PHRASE = '清空'

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
  () =>
    summary.value.deletable > 0 &&
    items.value.some((item) => item.can_purge === true) &&
    !busy.value,
)

/** 手输「清空」严等解锁（不做同义词 / 模糊匹配）。 */
const purgeAllUnlocked = computed(() => purgeAllInput.value.trim() === PURGE_ALL_PHRASE)

const sheetTitle = computed(() => {
  switch (sheet.value) {
    case 'menu':
      return '这笔交易'
    case 'row-confirm':
      return '永久删除'
    case 'purge-all':
      return '清空回收站'
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
    return '操作失败，请稍后重试'
  }
  switch (err.code) {
    case 'txn_purge_forbidden':
      return '只有账本 owner 可以永久删除'
    case 'txn_purge_not_deleted':
      return '这笔交易已不在回收站，请刷新后重试'
    case 'txn_purge_not_allowed':
      return '系统生成的交易（期初 / 校准 / 导入批次）不能永久删除'
    case 'txn_purge_confirm_required':
      return '请重新确认后再试'
    case 'txn_not_found':
      return '交易不存在（可能已被删除）'
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
    loadError.value = err instanceof ApiError ? err.message : '回收站加载失败'
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
    notice.value = `已恢复「${item.description}」`
    await load()
  } catch (err) {
    notice.value = err instanceof ApiError ? `恢复失败：${err.message}` : '恢复失败，请稍后重试'
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
        ? '这笔交易已被永久删除'
        : `已永久删除 ${res.count} 笔`
    sheet.value = 'none'
    activeItem.value = null
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
        ? `已永久删除 ${res.count} 笔，另有 ${kept} 笔系统交易已保留`
        : `已永久删除 ${res.count} 笔`
    sheet.value = 'none'
    purgeAllInput.value = ''
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
      <span class="trash__label">回收站 · 已删除 {{ items.length }} 笔</span>
    </header>

    <div v-if="loadError" class="fb-card trash__state trash__state--error">
      <p>{{ loadError }}</p>
      <button class="fb-btn-ghost" type="button" @click="load">重新加载</button>
    </div>
    <div v-else-if="loading" class="fb-card trash__state">正在加载回收站…</div>

    <div v-else class="fb-card trash__card">
      <p v-if="notice" class="trash__notice" role="status">{{ notice }}</p>
      <p v-if="sorted.length === 0" class="trash__empty">回收站是空的。</p>
      <ul v-else class="trash__list">
        <li v-for="item in sorted" :key="item.uuid" class="trash__row">
          <span class="trash__info">
            <span class="trash__desc">{{ item.description }}</span>
            <span class="trash__meta">{{ item.date }} · 删除于 {{ item.deleted_at }} · {{ item.created_by_name }}</span>
            <span class="trash__meta trash__postings">{{ sumPostings(item) }}</span>
            <!-- 系统交易没有永久删除入口，但必须说明「为什么没有」。 -->
            <span v-if="item.is_system === true" class="trash__sys">系统交易 · 不可永久删除</span>
          </span>
          <!-- 0.6.0 S6 AC-5.8：恢复按钮按服务端 can_restore 显隐（viewer 仍可查看回收站）。 -->
          <button
            v-if="item.can_restore === true"
            type="button"
            class="fb-btn-primary trash__restore"
            :disabled="busy"
            @click="restore(item)"
          >{{ busyUuid === item.uuid ? '恢复中…' : '恢复' }}</button>
          <span v-else class="trash__norestore">只读成员不能恢复</span>
          <!-- B7：永久删除入口（owner-only，服务端逐条判定）。 -->
          <button
            v-if="item.can_purge === true"
            type="button"
            class="fb-btn-ghost trash__more"
            aria-label="更多操作"
            :disabled="busy"
            @click="openMenu(item)"
          >⋯</button>
        </li>
      </ul>

      <div class="trash__footer">
        <button
          type="button"
          class="fb-btn-ghost trash__purge-all"
          :disabled="!canPurgeAll"
          @click="openPurgeAll"
        >清空回收站</button>
        <span v-if="summary.deletable > 0" class="trash__meta">
          可永久删除 {{ summary.deletable }} 笔
        </span>
      </div>

      <!-- 本机审计（不参与同步）：全体成员可见，含 viewer。 -->
      <section v-if="auditLog.length > 0" class="trash__audit">
        <h2 class="trash__audit-title">永久删除记录</h2>
        <ul class="trash__audit-list">
          <li v-for="row in auditLog" :key="`${row.purged_at}-${row.uuid}`" class="trash__audit-row">
            <span class="trash__audit-desc">{{ row.description }}</span>
            <span class="trash__meta">
              {{ row.purged_at }} · {{ row.actor_name || '未知成员' }} · {{ row.amount_note }}
            </span>
          </li>
        </ul>
      </section>
    </div>

    <SelectSheet
      :open="sheet !== 'none'"
      :title="sheetTitle"
      dialog-label="回收站操作"
      @close="closeSheet"
    >
      <!-- 一级：行内菜单 -->
      <div v-if="sheet === 'menu'" class="trash__sheet-rows">
        <p class="trash__sheet-desc">「{{ activeItem?.description }}」</p>
        <button type="button" class="trash__sheet-row trash__sheet-row--danger" @click="openRowConfirm">
          永久删除
        </button>
      </div>

      <!-- 二级：单笔永久删除确认 -->
      <div v-else-if="sheet === 'row-confirm'" class="trash__sheet-rows">
        <p class="trash__sheet-desc">
          「{{ activeItem?.description }}」将被永久删除，<strong>无法恢复</strong>。
        </p>
        <p v-if="activeItem?.pair_uuid" class="trash__sheet-warn">
          将同时删除冲正配对交易（这笔交易被修改过，只删一半会让账本不再平衡）。
        </p>
        <button
          type="button"
          class="trash__sheet-row trash__sheet-row--danger"
          :disabled="busy"
          @click="confirmPurgeRow"
        >{{ busy ? '删除中…' : '确认永久删除' }}</button>
        <button type="button" class="trash__sheet-row" :disabled="busy" @click="closeSheet">
          取消
        </button>
      </div>

      <!-- 二级：清空回收站（手输「清空」解锁） -->
      <div v-else-if="sheet === 'purge-all'" class="trash__sheet-rows">
        <p class="trash__sheet-desc">
          <strong>无法恢复</strong>。请先确认下面三行数字：
        </p>
        <ul class="trash__sheet-stats">
          <li>可永久删除 {{ summary.deletable }} 笔</li>
          <li>{{ summary.system_kept }} 笔系统交易将保留</li>
          <li v-if="summary.paired > 0">
            其中 {{ summary.paired }} 笔为冲正配对（不在回收站），将一并删除
          </li>
        </ul>
        <label class="trash__sheet-label" for="trash-purge-confirm">
          请输入「{{ PURGE_ALL_PHRASE }}」以确认
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
        >{{ busy ? '清空中…' : '确认清空' }}</button>
        <button type="button" class="trash__sheet-row" :disabled="busy" @click="closeSheet">
          取消
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
