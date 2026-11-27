<script setup lang="ts">
/**
 * 轻量就地标签编辑器（标签原地更新 P0）——详情页与列表页共用。
 *
 * **不是 RecordSheet**：本组件只提交 `tags` + `base_tags`，绝不触碰
 * date / flag / description / postings，也不产生冲正行。整包经济事实编辑仍由
 * `stores/recordSheet.ts` 与 PATCH /api/transactions/{uuid} 独占。
 *
 * 规范化规则与服务端 `service.normalizeTags` 逐字一致：
 *   trim → 丢空 → 精确去重（大小写敏感）→ 排序（默认字典序）。
 * 服务端为权威：提交成功后用**响应回显的 tags** 更新视图，不自行拼接。
 *
 * 并发：进入编辑器时把当前 tags 快照为 `base_tags`，用户编辑只改目标 tags；
 * 409 txn_tags_conflict 时展示服务端 `current_tags` 并以其为新 base 重试。
 * 若 409 的 current_tags 已等于目标 tags，按 §3.3「结果幂等」视为成功。
 *
 * P1：离线时不再禁用。chip 增删当下写 TagEvent 到独立 tag_events store，
 * 保存统一走 reconciler（在线 PUT / 离线仅预测），规范化唯一口径在
 * `core/tagEvents/merge.ts`，本组件不再自持任何 normalizeTags 副本。
 *
 * 兼容基线（iOS 14.8 / Safari 14.1.2）：原生 <input> + 简单数组操作，
 * 不用 structuredClone / crypto.randomUUID / .at() / Object.hasOwn 等禁用 API。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { codeMessage } from '@/api/errors'
import type { TagEditResponse } from '@/api/types'
import { stableDeviceId } from '@/core/tagEvents/device'
import { normalizeTags } from '@/core/tagEvents/merge'
import { notifyOfflineSaved } from '@/core/tagEvents/notice'
import { tagMergeCoordinator } from '@/core/tagEvents/reconciler'
import type { CommitOutcome } from '@/core/tagEvents/types'
import { t } from '@/i18n'
import { markDirty } from '@/stores/dataFreshness'

const props = withDefaults(
  defineProps<{
    /** 交易 uuid（跨端不可变身份）。 */
    uuid: string
    /** 用户进入编辑器时看到的标签；同时用于初始草稿与 base_tags 快照。 */
    tags?: string[]
    /** 可选稳定设备标识（审计用，best-effort）；缺省时本组件自行生成并缓存。 */
    deviceId?: string
    /** 服务端 can_edit；false 时入口在父级已被禁用，这里再做一次防御。 */
    canEdit?: boolean
    /** 服务端 tags_updated_at，作为离线事件收敛的基线时间。 */
    tagsUpdatedAt?: string
  }>(),
  {
    tags: () => [],
    deviceId: '',
    canEdit: true,
    tagsUpdatedAt: '',
  },
)

const emit = defineEmits<{
  /** 保存成功：父级用响应回显的 tags / tags_updated_at 就地更新视图。 */
  saved: [response: TagEditResponse]
  /** 关闭编辑器（父级隐藏内联面板）。 */
  close: []
}>()

/** 用户可编辑的目标标签（进入时即规范化，后续每次增删也规范化）。 */
const draft = ref<string[]>(normalizeTags(props.tags))
/** CAS 快照：进入时看到的值；冲突后替换为服务端 current_tags。 */
const baseTags = ref<string[]>(normalizeTags(props.tags))
const input = ref('')
const saving = ref(false)
const error = ref('')
const conflict = ref<{ current: string[]; updatedAt: string } | null>(null)

/** navigator.onLine 只作提示，不作安全边界；离线也允许编辑，服务端 CAS + 权限才权威。 */
const online = ref(true)
function syncOnline(): void {
  online.value = navigator.onLine
}
onMounted(() => {
  syncOnline()
  window.addEventListener('online', syncOnline)
  window.addEventListener('offline', syncOnline)
})
onUnmounted(() => {
  window.removeEventListener('online', syncOnline)
  window.removeEventListener('offline', syncOnline)
})

/** P1：只有权限是安全边界；离线仍可编辑，navigator.onLine 仅切换提示与提交路径。 */
const disabled = computed(() => !props.canEdit)
const disabledHint = computed(() => t('tagEdit.forbidden'))

const deviceId = props.deviceId !== '' ? props.deviceId : stableDeviceId()
/** 多笔交易同时在列表展开编辑器时，input id 仍唯一（label 关联不串台）。 */
const inputId = computed(() => `tag-inline-input-${props.uuid}`)

/** 串行化 chip 事件写入：保存前必须等所有已产生的事件落库，避免预测值漏算。 */
let pendingAppend: Promise<void> = Promise.resolve()

/** chip 变更当下写事件（add / remove 墓碑），事件只进 tag_events，不进 pending。 */
function appendEvent(tag: string, op: 'add' | 'remove'): void {
  pendingAppend = pendingAppend.then(() =>
    tagMergeCoordinator.appendTagEvent(props.uuid, { tag, op }, {
      baseTags: baseTags.value,
      tagsUpdatedAt: props.tagsUpdatedAt,
      deviceId,
    }),
  )
}

function addTag(): void {
  const value = input.value.trim()
  input.value = ''
  if (value === '') {
    return
  }
  appendEvent(value, 'add')
  draft.value = normalizeTags(draft.value.concat([value]))
  error.value = ''
}

function removeTag(tag: string): void {
  const next: string[] = []
  for (const item of draft.value) {
    if (item !== tag) {
      next.push(item)
    }
  }
  if (next.length === draft.value.length) {
    return
  }
  appendEvent(tag, 'remove')
  draft.value = next
  error.value = ''
}

/** 把服务端 current_tags 并入当前草稿（用户可先合并再决定目标值）。 */
function mergeLatest(): void {
  if (conflict.value === null) {
    return
  }
  draft.value = normalizeTags(draft.value.concat(conflict.value.current))
  conflict.value = null
  error.value = ''
}

/** 以服务端 current_tags 为新 base，原目标 tags 不变，重放一次。 */
function retryWithLatest(): void {
  if (conflict.value === null || saving.value) {
    return
  }
  const current = conflict.value.current.slice()
  baseTags.value = current
  conflict.value = null
  void submit(draft.value.slice(), current)
}

/**
 * 保存：在线走 reconciler 的 PUT；离线只落事件 + 预测回显（edit_id=0）。
 * `baseOverride` 供 P0「用最新标签重试」复用：目标 tags 不变，只换 CAS 基线。
 */
async function submit(targetOverride?: string[], baseOverride?: string[]): Promise<void> {
  if (saving.value || disabled.value) {
    return
  }
  saving.value = true
  error.value = ''
  // 用户可能在事件写入完成前就点保存；先等队列落库，再做收敛 / PUT。
  await pendingAppend
  const target = normalizeTags(targetOverride ?? draft.value)
  const base = baseOverride ?? baseTags.value.slice()
  try {
    if (!online.value) {
      const predicted = await tagMergeCoordinator.predictTags(props.uuid, {
        baseTags: base,
        tagsUpdatedAt: props.tagsUpdatedAt,
      })
      const offlineResponse: TagEditResponse = {
        uuid: props.uuid,
        tags: predicted,
        tags_updated_at: props.tagsUpdatedAt,
        edit_id: 0,
      }
      markDirty('local-write')
      notifyOfflineSaved(props.uuid)
      emit('saved', offlineResponse)
      emit('close')
      return
    }

    const outcome: CommitOutcome = await tagMergeCoordinator.commitBatch(props.uuid, {
      baseTags: base,
      tagsUpdatedAt: props.tagsUpdatedAt,
      deviceId,
      targetTags: target,
      maxAttempts: 1,
    })
    if (outcome.status === 'saved') {
      markDirty('local-write')
      emit('saved', outcome.response)
      emit('close')
      return
    }
    if (outcome.status === 'conflict') {
      conflict.value = { current: outcome.current, updatedAt: outcome.updatedAt }
      baseTags.value = outcome.current.slice()
      error.value = t('tagEdit.conflictHint')
      return
    }
    error.value = codeMessage(outcome.code) || outcome.message || t('tagEdit.errGeneric')
  } finally {
    saving.value = false
  }
}

function cancel(): void {
  emit('close')
}
</script>

<template>
  <section class="tag-inline" data-testid="tag-inline-editor" :aria-label="t('tagEdit.title')">
    <div class="tag-inline__head">
      <strong class="tag-inline__title">{{ t('tagEdit.title') }}</strong>
      <button type="button" class="tag-inline__close" :aria-label="t('tagEdit.cancel')" @click="cancel">×</button>
    </div>

    <p class="tag-inline__hint">{{ t('tagEdit.hint') }}</p>
    <p v-if="disabled" class="tag-inline__disabled" role="status">{{ disabledHint }}</p>
    <p v-else-if="!online" class="tag-inline__offline" role="status" data-testid="tag-offline-hint">
      {{ t('tagEdit.offlineSaved') }}
    </p>

    <div class="tag-inline__row">
      <span class="tag-inline__label">{{ t('tagEdit.currentLabel') }}</span>
      <div class="tag-inline__chips">
        <span
          v-for="tag in draft"
          :key="tag"
          class="tag-inline__chip"
        >
          {{ tag }}
          <button
            type="button"
            class="tag-inline__chip-remove"
            :disabled="disabled || saving"
            :aria-label="t('tagEdit.remove', { tag })"
            @click="removeTag(tag)"
          >×</button>
        </span>
        <span v-if="draft.length === 0" class="tag-inline__empty">{{ t('tagEdit.empty') }}</span>
      </div>
    </div>

    <div class="tag-inline__row">
      <label class="tag-inline__label" :for="inputId">{{ t('tagEdit.inputLabel') }}</label>
      <div class="tag-inline__add">
        <input
          :id="inputId"
          v-model="input"
          class="tag-inline__input"
          type="text"
          maxlength="64"
          :placeholder="t('tagEdit.inputPlaceholder')"
          :disabled="disabled || saving"
          @keydown.enter.prevent="addTag"
        />
        <button
          type="button"
          class="tag-inline__add-btn"
          :disabled="disabled || saving || input.trim() === ''"
          @click="addTag"
        >{{ t('tagEdit.add') }}</button>
      </div>
    </div>

    <!-- 409 冲突面板：只在主流水之外展示服务端 current_tags，绝不写回交易行。 -->
    <div v-if="conflict !== null" class="tag-inline__conflict" data-testid="tag-conflict">
      <p class="tag-inline__conflict-title">{{ t('tagEdit.conflictTitle') }}</p>
      <p class="tag-inline__conflict-current">{{ t('tagEdit.conflictCurrent') }}</p>
      <div class="tag-inline__chips">
        <span v-for="tag in conflict.current" :key="tag" class="tag-inline__chip tag-inline__chip--muted">{{ tag }}</span>
        <span v-if="conflict.current.length === 0" class="tag-inline__empty">{{ t('tagEdit.empty') }}</span>
      </div>
      <div class="tag-inline__conflict-actions">
        <button type="button" class="tag-inline__ghost" :disabled="saving" @click="mergeLatest">
          {{ t('tagEdit.mergeLatest') }}
        </button>
        <button type="button" class="tag-inline__primary" :disabled="saving || disabled" @click="retryWithLatest">
          {{ t('tagEdit.retryWithLatest') }}
        </button>
      </div>
    </div>

    <p v-if="error !== ''" class="tag-inline__error" role="alert">{{ error }}</p>

    <div class="tag-inline__actions">
      <button type="button" class="tag-inline__ghost" @click="cancel">{{ t('tagEdit.cancel') }}</button>
      <button
        type="button"
        class="tag-inline__primary"
        data-testid="tag-save"
        :disabled="disabled || saving"
        @click="submit()"
      >{{ saving ? t('tagEdit.saving') : t('tagEdit.save') }}</button>
    </div>
  </section>
</template>

<style scoped>
.tag-inline {
  width: 100%;
  max-width: 340px;
  margin: 12px auto 0;
  padding: 12px 14px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
}

.tag-inline__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tag-inline__title {
  font-size: 13px;
}

.tag-inline__close {
  border: none;
  background: none;
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.tag-inline__hint,
.tag-inline__disabled,
.tag-inline__offline,
.tag-inline__error {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.7;
}

.tag-inline__hint {
  color: var(--fb-sub);
}

.tag-inline__disabled {
  color: var(--fb-warn);
}

/* 离线提示是浅色非阻断信息，与红色 role=alert 的 error / conflict 区分。 */
.tag-inline__offline {
  color: var(--fb-sub);
}

.tag-inline__error {
  color: var(--fb-danger);
}

.tag-inline__row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
}

.tag-inline__label {
  color: var(--fb-sub);
  font-size: 11px;
}

.tag-inline__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag-inline__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--fb-blue-line);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-blue-soft);
  color: var(--fb-blue);
  font-size: 11.5px;
}

.tag-inline__chip--muted {
  border-color: var(--fb-line);
  background: var(--fb-soft);
  color: var(--fb-sub);
}

.tag-inline__chip-remove {
  border: none;
  background: none;
  color: inherit;
  font-family: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.tag-inline__chip-remove:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.tag-inline__empty {
  color: var(--fb-sub);
  font-size: 11px;
}

.tag-inline__add {
  display: flex;
  gap: 8px;
}

.tag-inline__input {
  flex: 1;
  min-width: 0;
  height: 38px;
  padding: 0 10px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 13px;
}

.tag-inline__add-btn,
.tag-inline__ghost,
.tag-inline__primary {
  height: 38px;
  padding: 0 12px;
  border-radius: var(--fb-radius-input);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.tag-inline__add-btn {
  border: 1px solid var(--fb-blue-line);
  background: var(--fb-card);
  color: var(--fb-blue);
}

.tag-inline__ghost {
  border: 1px solid var(--fb-line);
  background: var(--fb-card);
  color: var(--fb-sub);
}

.tag-inline__primary {
  border: none;
  background: var(--fb-blue);
  color: var(--fb-white);
}

.tag-inline__add-btn:disabled,
.tag-inline__ghost:disabled,
.tag-inline__primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.tag-inline__conflict {
  margin-top: 12px;
  padding: 10px;
  border: 1px solid var(--fb-warn);
  border-radius: var(--fb-radius-input);
  background: var(--fb-warn-soft);
}

.tag-inline__conflict-title {
  margin: 0;
  color: var(--fb-warn-ink);
  font-size: 12px;
  font-weight: 600;
}

.tag-inline__conflict-current {
  margin: 8px 0 6px;
  color: var(--fb-sub);
  font-size: 11px;
}

.tag-inline__conflict-actions,
.tag-inline__actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.tag-inline__conflict-actions > button,
.tag-inline__actions > button {
  flex: 1;
}
</style>
