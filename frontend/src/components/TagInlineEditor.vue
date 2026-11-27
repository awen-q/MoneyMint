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
 * 兼容基线（iOS 14.8 / Safari 14.1.2）：原生 <input> + 简单数组操作，
 * 不用 structuredClone / crypto.randomUUID / .at() / Object.hasOwn 等禁用 API。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { transactionApi } from '@/api/client'
import { ApiError, codeMessage } from '@/api/errors'
import type { TagEditResponse } from '@/api/types'
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
  }>(),
  {
    tags: () => [],
    deviceId: '',
    canEdit: true,
  },
)

const emit = defineEmits<{
  /** 保存成功：父级用响应回显的 tags / tags_updated_at 就地更新视图。 */
  saved: [response: TagEditResponse]
  /** 关闭编辑器（父级隐藏内联面板）。 */
  close: []
}>()

/**
 * 与服务端同口径的标签规范化。
 *
 * 大小写敏感（中文标签无大小写语义，Beancount tag 本身区分大小写）；
 * 默认 `Array.prototype.sort()` 即 Unicode 码点序，与 Go `sort.Strings`
 * 对常见中英文标签一致。
 */
function normalizeTags(input: string[]): string[] {
  const out: string[] = []
  if (!Array.isArray(input)) {
    return out
  }
  for (const raw of input) {
    if (typeof raw !== 'string') {
      continue
    }
    const value = raw.trim()
    if (value === '') {
      continue
    }
    let duplicated = false
    for (const existing of out) {
      if (existing === value) {
        duplicated = true
        break
      }
    }
    if (!duplicated) {
      out.push(value)
    }
  }
  out.sort()
  return out
}

/** 宽松读取服务端平铺在错误体里的字符串数组（格式异常时按空数组处理）。 */
function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      out.push(item)
    }
  }
  return out
}

/** 两个已规范化数组是否逐项相等（用于 409 的结果幂等判定）。 */
function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

/** 本机稳定 device id（localStorage 缓存；隐私模式 / 无 localStorage 时降级）。 */
function stableDeviceId(): string {
  const key = 'fambean.tagEditDeviceId'
  try {
    if (typeof localStorage !== 'undefined') {
      const cached = localStorage.getItem(key)
      if (cached !== null && cached !== '') {
        return cached
      }
    }
  } catch {
    // 隐私模式禁用存储：本次会话内用内存值即可，不阻断审计。
  }
  const bytes = new Uint8Array(8)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  let hex = ''
  for (let i = 0; i < bytes.length; i += 1) {
    hex += (bytes[i] + 0x100).toString(16).slice(1)
  }
  const id = `web-${hex}`
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, id)
    }
  } catch {
    // 写失败不影响本次请求。
  }
  return id
}

/** 用户可编辑的目标标签（进入时即规范化，后续每次增删也规范化）。 */
const draft = ref<string[]>(normalizeTags(props.tags))
/** CAS 快照：进入时看到的值；冲突后替换为服务端 current_tags。 */
const baseTags = ref<string[]>(normalizeTags(props.tags))
const input = ref('')
const saving = ref(false)
const error = ref('')
const conflict = ref<{ current: string[]; updatedAt: string } | null>(null)

/** navigator.onLine 仅作提示与安全边界提示，服务端 CAS + 权限才是权威。 */
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

const disabled = computed(() => !props.canEdit || !online.value)
const disabledHint = computed(() =>
  !props.canEdit ? t('tagEdit.forbidden') : t('tagEdit.offlineDisabled'),
)

const deviceId = props.deviceId !== '' ? props.deviceId : stableDeviceId()
/** 多笔交易同时在列表展开编辑器时，input id 仍唯一（label 关联不串台）。 */
const inputId = computed(() => `tag-inline-input-${props.uuid}`)

function addTag(): void {
  const value = input.value.trim()
  input.value = ''
  if (value === '') {
    return
  }
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
  baseTags.value = conflict.value.current.slice()
  conflict.value = null
  void submit()
}

async function submit(): Promise<void> {
  if (saving.value || disabled.value) {
    return
  }
  saving.value = true
  error.value = ''
  const target = normalizeTags(draft.value)
  const base = baseTags.value.slice()
  try {
    const response = await transactionApi.updateTags(props.uuid, {
      tags: target,
      base_tags: base,
      device_id: deviceId,
    })
    markDirty('local-write')
    emit('saved', response)
    emit('close')
  } catch (err) {
    if (err instanceof ApiError && err.code === 'txn_tags_conflict') {
      const current = readStringArray(err.details === undefined ? undefined : err.details.current_tags)
      const updatedAt =
        err.details !== undefined && typeof err.details['current_tags_updated_at'] === 'string'
          ? (err.details['current_tags_updated_at'] as string)
          : ''
      // §3.3：重放同一请求时 current_tags 已等于目标 tags → 结果幂等，视为成功。
      if (sameTags(normalizeTags(current), target)) {
        const replayed: TagEditResponse = {
          uuid: props.uuid,
          tags: target,
          tags_updated_at: updatedAt,
          edit_id: 0,
        }
        markDirty('local-write')
        emit('saved', replayed)
        emit('close')
        return
      }
      conflict.value = { current, updatedAt }
      // 以最新值为新 base；用户点「用最新标签重试」即可直接重放。
      baseTags.value = current.slice()
      error.value = t('tagEdit.conflictHint')
    } else if (err instanceof ApiError) {
      error.value = codeMessage(err.code ?? '') || err.message || t('tagEdit.errGeneric')
    } else {
      error.value = t('tagEdit.errGeneric')
    }
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
        @click="submit"
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
