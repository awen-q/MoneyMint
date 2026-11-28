<script setup lang="ts">
/**
 * P-18 同步状态（P1：只读状态页 → 可处置队列页）
 *
 * 四段信息架构按「越急越靠上」排列：
 *  ① 顶层错误横幅（网络/5xx/4xx，带原因 + 动作 + 折叠原始 code/message）
 *  ② 待推送（重试中）失败子集：琥珀色，按 next_retry_at 升序，可批量立即重试
 *  ③ 死信：红色，按失败时间倒序，可重试 / 二次确认丢弃 / 导出
 *  ④ 状态摘要行（上次同步时间、待推送、死信）
 * 页脚折叠「另有 N 条正常排队」；「本次同步结果」三数取引擎最终队列口径。
 *
 * 全选仅作用于本组；行数、徽标、摘要三处共用同一个 isRetryingPending 口径。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { syncStatusApi } from '@/api/client'
import { describeSyncError } from '@/core/sync/errorMessages'
import { isRetryingPending, type PendingEntry } from '@/core/sync/models'
import { t } from '@/i18n'
import { useSessionStore } from '@/stores/session'
import { useSyncStore } from '@/stores/sync'

const session = useSessionStore()
const sync = useSyncStore()

/** 单组超过 5 条默认折叠；重试按钮 4 秒冷却，避免连点风暴。 */
const PAGE_SIZE = 5
const RETRY_COOLDOWN_MS = 4_000

const checking = ref(false)
const online = ref<boolean | null>(null)
const serverInstanceId = ref('')
const syncBusy = ref(false)
const syncNotice = ref('')
const checkedAt = ref('')
const retrySelected = ref<number[]>([])
const deadSelected = ref<number[]>([])
const retryExpanded = ref(false)
const deadExpanded = ref(false)
const showDiscardConfirm = ref(false)
const retryCooling = ref(false)
const summaryDismissed = ref(false)
let cooldownTimer: ReturnType<typeof setTimeout> | undefined

const lastSyncText = computed(() => {
  if (sync.lastSyncAt === 0) return t('syncP1.lastSync') + '：—'
  const d = new Date(sync.lastSyncAt)
  return `${t('syncP1.lastSync')} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
})

const statusText = computed(() => {
  switch (sync.status) {
    case 'syncing':
      return '同步中…'
    case 'ok':
      return '已同步'
    case 'offline':
      return '离线（写入已保存在本机）'
    case 'error':
      return '同步出错（数据未丢失）'
    default:
      return '待机'
  }
})

const topDescription = computed(() =>
  sync.topError === undefined
    ? null
    : describeSyncError(sync.topError.code, sync.topError.message),
)

/** 正常 pending 不进失败列表；这里与 store 徽标用同一个纯函数判定。 */
const retryItems = computed(() =>
  (sync.pendingItems ?? [])
    .filter((entry) => isRetryingPending(entry, Date.now()))
    .slice()
    .sort((a, b) => a.next_retry_at - b.next_retry_at),
)
const deadItems = computed(() =>
  (sync.deadItems ?? []).slice().sort((a, b) => {
    const ta = a.state_changed_at ?? a.created_at ?? 0
    const tb = b.state_changed_at ?? b.created_at ?? 0
    return tb - ta
  }),
)
const retryVisible = computed(() =>
  retryExpanded.value ? retryItems.value : retryItems.value.slice(0, PAGE_SIZE),
)
const deadVisible = computed(() =>
  deadExpanded.value ? deadItems.value : deadItems.value.slice(0, PAGE_SIZE),
)
const retryRest = computed(() => Math.max(0, retryItems.value.length - PAGE_SIZE))
const deadRest = computed(() => Math.max(0, deadItems.value.length - PAGE_SIZE))
const quietCount = computed(
  () => sync.quietCount ?? Math.max(0, sync.pendingCount - retryItems.value.length),
)

const summary = computed(() => sync.lastSyncSummary)
const summaryText = computed(() =>
  summary.value === undefined
    ? ''
    : t('syncP1.summary', {
        success: String(summary.value.success),
        retry: String(summary.value.retry),
        dead: String(summary.value.dead),
      }),
)

watch(
  () => summary.value?.at,
  (next, previous) => {
    if (next !== previous) summaryDismissed.value = false
  },
)

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function padTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function formatRetryTime(timestamp: number): string {
  const d = new Date(timestamp)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function codeOf(entry: PendingEntry): string {
  return entry.last_error_code ?? 'retry_scheduled'
}

function messageOf(entry: PendingEntry): string {
  return entry.last_error && entry.last_error !== '' ? entry.last_error : t('syncP1.retryScheduled')
}

function previewOf(entry: PendingEntry): string {
  const text = messageOf(entry)
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}

function labelOf(entry: PendingEntry): string {
  return entry.display_label ?? entry.change.key
}

function toggleId(list: number[], id: number): number[] {
  return list.includes(id) ? list.filter((value) => value !== id) : [...list, id]
}

function toggleRetry(id: number): void {
  retrySelected.value = toggleId(retrySelected.value, id)
}

function toggleDead(id: number): void {
  deadSelected.value = toggleId(deadSelected.value, id)
}

function toggleAllRetry(): void {
  const ids = retryItems.value.map((entry) => entry.id)
  retrySelected.value = retrySelected.value.length === ids.length ? [] : ids
}

function toggleAllDead(): void {
  const ids = deadItems.value.map((entry) => entry.id)
  deadSelected.value = deadSelected.value.length === ids.length ? [] : ids
}

function startCooldown(): void {
  if (cooldownTimer !== undefined) clearTimeout(cooldownTimer)
  retryCooling.value = true
  cooldownTimer = setTimeout(() => {
    retryCooling.value = false
    cooldownTimer = undefined
  }, RETRY_COOLDOWN_MS)
}

async function check(): Promise<void> {
  if (checking.value) return
  checking.value = true
  try {
    const health = await syncStatusApi.health()
    online.value = health.status === 'ok'
    serverInstanceId.value = health.instance_id ?? ''
    checkedAt.value = padTime(new Date())
  } catch {
    online.value = false
    serverInstanceId.value = ''
  } finally {
    checking.value = false
  }
}

async function runSync(): Promise<void> {
  if (syncBusy.value) return
  syncBusy.value = true
  syncNotice.value = ''
  try {
    const outcome = await sync.syncNow()
    syncNotice.value =
      outcome === 'ok'
        ? '同步完成'
        : outcome === 'offline'
          ? '当前离线，本地数据已保留'
          : outcome === 'skipped'
            ? '另一个标签页正在同步'
            : '同步失败，请稍后重试'
    void check()
  } finally {
    syncBusy.value = false
  }
}

async function retryEntries(ids: number[]): Promise<void> {
  const unique = [...new Set(ids)]
  if (unique.length === 0 || retryCooling.value) return
  startCooldown()
  try {
    await sync.retryPending(unique)
    retrySelected.value = retrySelected.value.filter((id) => !unique.includes(id))
    syncNotice.value = t('syncP1.queued')
  } catch {
    syncNotice.value = '重试失败，请稍后再试'
  }
}

async function reviveSelectedWith(id: number): Promise<void> {
  await sync.reviveDead([id])
  deadSelected.value = deadSelected.value.filter((value) => value !== id)
  syncNotice.value = t('syncP1.queued')
}

async function reviveSelected(): Promise<void> {
  const ids = [...deadSelected.value]
  if (ids.length === 0) return
  await sync.reviveDead(ids)
  deadSelected.value = []
  syncNotice.value = t('syncP1.queued')
}

/** 单条丢弃走同一二次确认弹窗；按钮先把选中范围收敛到这一条。 */
function askDiscardOne(id: number): void {
  deadSelected.value = [id]
  showDiscardConfirm.value = true
}

async function confirmDiscard(): Promise<void> {
  const ids = [...deadSelected.value]
  if (ids.length === 0) return
  await sync.discardDead(ids)
  deadSelected.value = []
  showDiscardConfirm.value = false
  syncNotice.value = '已丢弃所选死信条目'
}

/** 死信导出为文本：必须带完整 last_error，便于排障 / 手工补救。 */
function exportDead(items: PendingEntry[] = deadItems.value): void {
  if (items.length === 0) return
  const lines = items.map((entry) =>
    [
      `# id=${entry.id} state=${entry.state} attempts=${entry.attempts} code=${entry.last_error_code ?? ''}`,
      `label=${labelOf(entry)}`,
      `last_error=${entry.last_error ?? ''}`,
      JSON.stringify(entry.change),
    ].join('\n'),
  )
  const blob = new Blob([lines.join('\n\n')], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'fambean-dead-queue.txt'
  a.click()
  URL.revokeObjectURL(url)
}

async function copyError(entry: PendingEntry): Promise<void> {
  const text = [
    `label=${labelOf(entry)}`,
    `code=${codeOf(entry)}`,
    `last_error=${messageOf(entry)}`,
    JSON.stringify(entry.change),
  ].join('\n')
  try {
    if (navigator.clipboard === undefined || typeof navigator.clipboard.writeText !== 'function') {
      throw new Error('clipboard unavailable')
    }
    await navigator.clipboard.writeText(text)
    syncNotice.value = t('syncP1.copied')
  } catch {
    syncNotice.value = t('syncP1.copyFailed')
  }
}

onMounted(() => {
  void check()
  void sync.loadQueues()
})

onBeforeUnmount(() => {
  if (cooldownTimer !== undefined) clearTimeout(cooldownTimer)
})
</script>

<template>
  <section class="syn">
    <header class="syn__hero fb-hero">
      <span class="syn__title">同步状态</span>
      <span class="syn__sub">离线队列 · 死信 · 库世代</span>
    </header>

    <div class="fb-card syn__card syn__status">
      <span class="syn__dot" :class="{ on: online === true, off: online === false }" />
      <div class="syn__status-text">
        <strong>{{ checking ? '正在检查…' : (online === true ? '服务正常' : '离线 / 服务不可达') }}</strong>
        <small>引擎状态：{{ statusText }} · {{ lastSyncText }}</small>
      </div>
      <button class="fb-btn-primary syn__btn" type="button" :disabled="syncBusy" @click="runSync">
        {{ syncBusy ? '同步中…' : '立即同步' }}
      </button>
    </div>

    <p v-if="syncNotice" class="syn__notice" role="status">{{ syncNotice }}</p>

    <!-- ① 顶层错误横幅 -->
    <div v-if="sync.topError" class="fb-card syn__card syn__top-error" role="alert" data-section="top-error">
      <strong class="syn__top-title">{{ t('syncP1.bannerTitle') }}</strong>
      <p class="syn__top-reason">{{ topDescription?.reason }}</p>
      <p v-if="topDescription?.action" class="syn__top-action">{{ topDescription.action }}</p>
      <details class="syn__details">
        <summary>{{ t('syncP1.details') }}</summary>
        <code class="syn__code">{{ sync.topError.code }}</code>
        <pre class="syn__raw">{{ sync.topError.message }}</pre>
      </details>
      <button class="fb-btn-ghost syn__btn" type="button" :disabled="syncBusy" @click="runSync">
        {{ t('syncP1.bannerAction') }}
      </button>
    </div>

    <!-- ② 待推送（重试中）失败子集 -->
    <section class="fb-card syn__card syn__retry" data-section="retry">
      <div class="syn__card-head">
        <h2>{{ t('syncP1.retryTitle', { n: String(retryItems.length) }) }}</h2>
        <label v-if="retryItems.length > 0" class="syn__select">
          <input type="checkbox" class="syn__select-all-retry" :checked="retrySelected.length === retryItems.length" @change="toggleAllRetry" />
          {{ t('syncP1.selectAll', { n: String(retryItems.length) }) }}
        </label>
      </div>
      <p class="syn__scope">{{ t('syncP1.batchScope') }}</p>
      <p v-if="retryItems.length === 0" class="syn__desc">{{ t('syncP1.retryEmpty') }}</p>
      <ul v-else class="syn__rows">
        <li v-for="entry in retryVisible" :key="entry.id" class="syn__row" data-group="retry">
          <label class="syn__check">
            <input type="checkbox" :checked="retrySelected.includes(entry.id)" @change="toggleRetry(entry.id)" />
          </label>
          <div class="syn__body">
            <div class="syn__line">
              <strong class="syn__label">{{ labelOf(entry) }}</strong>
              <span class="syn__tag syn__tag--warn">{{ entry.entity_type ?? entry.change.entity_type }}</span>
              <code class="syn__code">{{ codeOf(entry) }}</code>
            </div>
            <p class="syn__preview">{{ previewOf(entry) }}</p>
            <details class="syn__details">
              <summary>{{ t('syncP1.expand') }}</summary>
              <p class="syn__full">{{ messageOf(entry) }}</p>
            </details>
            <small class="syn__meta">
              {{ t('syncP1.retryMeta', { n: String(entry.attempts), time: formatRetryTime(entry.next_retry_at) }) }}
            </small>
            <div class="syn__row-actions">
              <button class="fb-btn-ghost syn__btn" type="button" :disabled="retryCooling" @click="retryEntries([entry.id])">
                {{ t('syncP1.retryNow') }}
              </button>
              <button class="syn__link" type="button" @click="copyError(entry)">{{ t('syncP1.copyError') }}</button>
            </div>
          </div>
        </li>
      </ul>
      <button v-if="retryRest > 0" class="syn__link syn__more" type="button" @click="retryExpanded = !retryExpanded">
        {{ retryExpanded ? t('syncP1.collapseRest') : t('syncP1.expandRest', { n: String(retryRest) }) }}
      </button>
      <div v-if="retryItems.length > 0" class="syn__buttons">
        <button
          class="fb-btn-ghost syn__btn syn__batch-retry"
          type="button"
          :disabled="retryCooling || retrySelected.length === 0"
          @click="retryEntries([...retrySelected])"
        >{{ t('syncP1.retryBatch') }}</button>
      </div>
    </section>

    <!-- ③ 死信 -->
    <section class="fb-card syn__card syn__dead" data-section="dead">
      <div class="syn__card-head">
        <h2>{{ t('syncP1.deadTitle', { n: String(deadItems.length) }) }}</h2>
        <div class="syn__head-actions">
          <button v-if="deadItems.length > 0" class="fb-btn-ghost syn__btn" type="button" @click="exportDead()">{{ t('syncP1.export') }}</button>
          <label v-if="deadItems.length > 0" class="syn__select">
            <input type="checkbox" class="syn__select-all-dead" :checked="deadSelected.length === deadItems.length" @change="toggleAllDead" />
            {{ t('syncP1.selectAll', { n: String(deadItems.length) }) }}
          </label>
        </div>
      </div>
      <p class="syn__scope">{{ t('syncP1.batchScope') }}</p>
      <p v-if="deadItems.length === 0" class="syn__desc">{{ t('syncP1.deadEmpty') }}</p>
      <ul v-else class="syn__rows">
        <li v-for="entry in deadVisible" :key="entry.id" class="syn__row" data-group="dead">
          <label class="syn__check">
            <input type="checkbox" :checked="deadSelected.includes(entry.id)" @change="toggleDead(entry.id)" />
          </label>
          <div class="syn__body">
            <div class="syn__line">
              <strong class="syn__label">{{ labelOf(entry) }}</strong>
              <span class="syn__tag syn__tag--err">{{ entry.entity_type ?? entry.change.entity_type }}</span>
              <code class="syn__code">{{ codeOf(entry) }}</code>
            </div>
            <p class="syn__preview">{{ previewOf(entry) }}</p>
            <details class="syn__details">
              <summary>{{ t('syncP1.expand') }}</summary>
              <p class="syn__full">{{ messageOf(entry) }}</p>
            </details>
            <div class="syn__row-actions">
              <button class="fb-btn-ghost syn__btn" type="button" @click="reviveSelectedWith(entry.id)">{{ t('syncP1.retryNow') }}</button>
              <button class="fb-btn-ghost syn__btn syn__btn--danger" type="button" @click="askDiscardOne(entry.id)">{{ t('syncP1.discard') }}</button>
              <button class="syn__link" type="button" @click="exportDead([entry])">{{ t('syncP1.export') }}</button>
              <button class="syn__link" type="button" @click="copyError(entry)">{{ t('syncP1.copyError') }}</button>
            </div>
          </div>
        </li>
      </ul>
      <button v-if="deadRest > 0" class="syn__link syn__more" type="button" @click="deadExpanded = !deadExpanded">
        {{ deadExpanded ? t('syncP1.collapseRest') : t('syncP1.expandRest', { n: String(deadRest) }) }}
      </button>
      <div v-if="deadItems.length > 0" class="syn__buttons">
        <button
          class="fb-btn-ghost syn__btn"
          type="button"
          :disabled="deadSelected.length === 0"
          @click="reviveSelected"
        >{{ t('syncP1.retryBatch') }}</button>
        <button
          class="fb-btn-ghost syn__btn syn__btn--danger syn__batch-discard"
          type="button"
          :disabled="deadSelected.length === 0"
          @click="showDiscardConfirm = true"
        >{{ t('syncP1.discardBatch') }}</button>
      </div>
    </section>

    <!-- ④ 状态摘要行 -->
    <section class="fb-card syn__card syn__summary" data-section="summary">
      <h2>队列摘要</h2>
      <dl class="syn__grid">
        <dt>{{ t('syncP1.lastSync') }}</dt>
        <dd>{{ lastSyncText }}</dd>
        <dt>{{ t('syncP1.pendingCount', { n: String(sync.pendingCount) }) }}</dt>
        <dd>{{ sync.pendingCount }}</dd>
        <dt>{{ t('syncP1.deadCount', { n: String(deadItems.length) }) }}</dt>
        <dd>{{ deadItems.length }}</dd>
        <dt>当前账本</dt><dd>{{ session.ledgerName }}</dd>
        <dt>本次检查</dt><dd>{{ checkedAt || '—' }}</dd>
      </dl>
      <p v-if="serverInstanceId !== ''" class="syn__desc">服务端库世代：<code>{{ serverInstanceId }}</code></p>
      <p class="syn__desc">
        服务端被「还原备份」后库世代会变化，下次同步引擎会自动清空本账本本地数据并全量重拉；
        离线期间的待推送变更会转入隔离区（上方死信列表），不会静默丢弃。
      </p>
    </section>

    <!-- 本次同步结果：三数与列表/徽标同口径，保留到下一轮同步 -->
    <div v-if="summary" class="fb-card syn__card syn__summary-bar" data-section="summary-bar">
      <strong v-if="!summaryDismissed" class="syn__summary-text">{{ summaryText }}</strong>
      <span v-else class="syn__summary-collapsed">{{ t('syncP1.summaryCollapsed') }}</span>
      <button v-if="!summaryDismissed" class="syn__link" type="button" @click="summaryDismissed = true">
        {{ t('syncP1.summaryGotIt') }}
      </button>
    </div>

    <details v-if="quietCount > 0" class="syn__card syn__quiet" data-section="quiet">
      <summary>{{ t('syncP1.quiet', { n: String(quietCount) }) }}</summary>
    </details>

    <div v-if="showDiscardConfirm" class="syn__confirm" role="dialog" aria-modal="true">
      <strong>{{ t('syncP1.discardConfirmTitle', { n: String(deadSelected.length) }) }}</strong>
      <p>{{ t('syncP1.discardConfirmBody') }}</p>
      <div class="syn__buttons">
        <button class="fb-btn-ghost syn__btn syn__btn--danger" type="button" @click="confirmDiscard">{{ t('syncP1.confirmDiscard') }}</button>
        <button class="fb-btn-ghost syn__btn" type="button" @click="showDiscardConfirm = false">{{ t('syncP1.cancel') }}</button>
      </div>
    </div>

    <div class="fb-card syn__card syn__note">
      <h2>协议与边界</h2>
      <p>账本采用 append-only 不可变交易 + 全局水位增量同步，天然几乎无冲突。</p>
      <p>
        水位只单调推进（空结果不回退）；多标签页通过存储租约选举，仅一个标签页执行同步；
        期初余额只能在线设置，不会进入离线队列。
      </p>
    </div>
  </section>
</template>

<style scoped>
.syn { padding-bottom: 20px; }
.syn__hero { padding: calc(20px + env(safe-area-inset-top, 0px)) 20px 20px; border-radius: 0 0 24px 24px; }
.syn__title { display: block; font-size: 16px; font-weight: 700; }
.syn__sub { display: block; margin-top: 4px; font-size: 12px; color: var(--fb-on-hero-muted); }
.syn__card { margin-top: 14px; padding: 14px 16px; }
.syn__card h2 { margin: 0 0 10px; font-size: 14px; }
.syn__card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.syn__head-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.syn__status { display: flex; align-items: center; gap: 12px; }
.syn__dot { width: 12px; height: 12px; border-radius: 50%; background: var(--fb-line); flex-shrink: 0; }
.syn__dot.on { background: var(--fb-green); }
.syn__dot.off { background: var(--fb-danger); }
.syn__status-text { flex: 1; min-width: 0; }
.syn__status-text strong { display: block; font-size: 14px; }
.syn__status-text small { font-size: 11px; color: var(--fb-sub); }
.syn__btn { padding: 6px 12px; font-size: 12px; white-space: nowrap; }
.syn__btn--danger { color: var(--fb-danger); border-color: var(--fb-danger); }
.syn__notice { margin: 10px 0 0; padding: 8px 12px; border-radius: var(--fb-radius-input); font-size: 12px; background: var(--fb-green-soft); color: var(--fb-green-ink); }

.syn__top-error { border-left: 4px solid var(--fb-danger); background: var(--fb-danger-soft, var(--fb-soft)); }
.syn__top-title { display: block; color: var(--fb-danger); font-size: 14px; }
.syn__top-reason { margin: 8px 0 0; font-size: 13px; font-weight: 600; line-height: 1.6; }
.syn__top-action { margin: 4px 0 8px; font-size: 12px; color: var(--fb-sub); line-height: 1.6; }
.syn__retry { border-left: 4px solid var(--fb-warn); }
.syn__dead { border-left: 4px solid var(--fb-danger); }
.syn__scope { margin: 0 0 8px; font-size: 11px; color: var(--fb-sub); }
.syn__select { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--fb-sub); cursor: pointer; }

.syn__rows { list-style: none; margin: 0 0 10px; padding: 0; }
.syn__row { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--fb-line); }
.syn__row:last-child { border-bottom: none; }
.syn__check { flex-shrink: 0; padding-top: 2px; }
.syn__body { min-width: 0; flex: 1; }
.syn__line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.syn__label { font-size: 13px; overflow-wrap: anywhere; }
.syn__tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--fb-soft); color: var(--fb-sub); }
.syn__tag--warn { background: var(--fb-warn-soft, var(--fb-soft)); color: var(--fb-warn); }
.syn__tag--err { background: var(--fb-soft); color: var(--fb-danger); }
.syn__code { font-size: 10px; color: var(--fb-sub); background: var(--fb-soft); padding: 1px 4px; border-radius: 4px; overflow-wrap: anywhere; }
.syn__preview { margin: 6px 0 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.syn__full { margin: 4px 0 0; font-size: 12px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.syn__meta { display: block; margin-top: 6px; font-size: 11px; color: var(--fb-sub); }
.syn__row-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.syn__details { margin-top: 4px; font-size: 11px; color: var(--fb-sub); }
.syn__details summary { cursor: pointer; }
.syn__raw { margin: 4px 0 0; font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; }
.syn__link { border: none; background: none; padding: 0; font-size: 11px; color: var(--fb-link, var(--fb-sub)); text-decoration: underline; cursor: pointer; }
.syn__more { margin-bottom: 8px; }
.syn__buttons { display: flex; gap: 8px; flex-wrap: wrap; }
.syn__grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin: 0 0 8px; font-size: 12px; }
.syn__grid dt { color: var(--fb-sub); }
.syn__grid dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
.syn__desc { margin: 8px 0 0; font-size: 11px; color: var(--fb-sub); line-height: 1.8; overflow-wrap: anywhere; }
.syn__summary-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.syn__summary-text { font-size: 13px; }
.syn__summary-collapsed { font-size: 11px; color: var(--fb-sub); }
.syn__quiet { margin-top: 14px; font-size: 11px; color: var(--fb-sub); cursor: pointer; }
.syn__confirm { margin-top: 14px; padding: 14px 16px; border: 1px solid var(--fb-danger); border-radius: var(--fb-radius-input); background: var(--fb-card); }
.syn__confirm strong { font-size: 13px; }
.syn__confirm p { margin: 6px 0 10px; font-size: 11px; color: var(--fb-danger); line-height: 1.7; }
.syn__note p { margin: 0 0 8px; font-size: 11px; color: var(--fb-sub); line-height: 1.8; }

/* PC：卡片行改为表格化三列；移动端保持单列卡片。 */
@media (min-width: 768px) {
  .syn__row { align-items: center; }
  .syn__body { display: grid; grid-template-columns: minmax(160px, 1fr) minmax(200px, 2fr) auto; align-items: center; column-gap: 12px; }
  .syn__line { grid-column: 1; }
  .syn__preview, .syn__details { grid-column: 2; }
  .syn__meta, .syn__row-actions { grid-column: 3; }
  .syn__row-actions { justify-content: flex-end; }
}
</style>
