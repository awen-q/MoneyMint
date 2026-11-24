<script setup lang="ts">
/**
 * 账户展示字段编辑弹层（批 II）：显示名 + 图标 + 颜色，PATCH /api/accounts/{uuid}。
 *
 * 四条硬口径：
 * 1. **在线-only**：push 的账户 op=update 只认 sort_order——若误入离线队列，
 *    推送负载缺 sort_order 字段会覆盖真实排序。所以本弹层绝不调 recordOffline、
 *    绝不产生 pending：离线态保留弹层但置灰 + 固定文案「修改需联网」（AC-5.4
 *    同款，不按 navigator.onLine 隐藏入口），测试断言不产生 pending。
 * 2. **viewer 隐藏入口**：入口显隐由父级用 `session.isViewer` 守；本弹层内
 *    viewer 也禁用提交（双保险，不是唯一防线）。
 * 3. **键省略 = 不改**：提交体只带与打开时不同的键（含「改回原值」= 不发送），
 *    显式空串只出现在「从有到无」（清除）——契约语义由前端正确行使。
 * 4. 颜色用 6 位 hex 文本框 + 预览色块，**不用原生 color input**（iOS 14.8
 *    兼容基线）；错误码 `account_visual_invalid` 文案走 `codeMessage` 集中映射。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { accountApi } from '@/api/client'
import { ApiError, codeMessage } from '@/api/errors'
import type { AccountView, UpdateAccountRequest } from '@/api/types'
import { catIcon, validateIconCodePoints } from '@/core/accounts'
import { markDirty } from '@/stores/dataFreshness'
import { useSessionStore } from '@/stores/session'
import IconPicker from '@/components/IconPicker.vue'

const props = defineProps<{
  /** 要编辑的账户（打开时快照，成功后由父级 reload 收敛）。 */
  account: AccountView
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'saved'): void
}>()

const session = useSessionStore()

// 打开时快照原值：payload 只带「与原值不同」的键。
const originalDisplayName = props.account.display_name ?? ''
const originalIcon = props.account.icon ?? ''
const originalColor = props.account.color ?? ''

const displayName = ref(originalDisplayName)
const icon = ref(originalIcon)
const color = ref(originalColor)
const submitting = ref(false)
const submitError = ref('')

/** 在线状态：仅用于置灰与固定文案，不隐藏入口（AC-5.4 口径）。 */
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

/** 颜色非空时的预览色块（非法 hex 不渲染，靠错误文案引导）。 */
const colorValid = computed(() => /^#[0-9A-Fa-f]{6}$/.test(color.value.trim()))

const iconValid = computed(() => validateIconCodePoints(icon.value))

/** 无任何键变化 → 提交按钮禁用（避免「点保存写一条无意义 sync_log」）。 */
const dirty = computed(
  () =>
    displayName.value.trim() !== originalDisplayName ||
    icon.value !== originalIcon ||
    color.value.trim() !== originalColor,
)

/** 离线置灰 + viewer 禁用 + 非法值拦截 + 无修改拦截。 */
const canSubmit = computed(
  () =>
    online.value &&
    !session.isViewer &&
    !submitting.value &&
    dirty.value &&
    iconValid.value &&
    (color.value.trim() === '' || colorValid.value),
)

const offlineHint = computed(() => (online.value ? '' : '修改需联网'))

function colorMessageOf(err: unknown): string {
  if (err instanceof ApiError) {
    const mapped = err.code === undefined ? '' : codeMessage(err.code)
    return mapped !== '' ? mapped : err.message
  }
  return '保存失败，请稍后重试'
}

/** 前置校验优先给可读文案；非法值不发出请求。 */
function precheck(): string {
  if (!iconValid.value) {
    return '图标需不超过 8 个字符的 emoji，请删减后重试'
  }
  const trimmedColor = color.value.trim()
  if (trimmedColor !== '' && !colorValid.value) {
    return '颜色需为 #RRGGBB 六位十六进制格式'
  }
  return ''
}

async function submit(): Promise<void> {
  if (submitting.value) {
    return
  }
  submitError.value = ''
  const precheckError = precheck()
  if (precheckError !== '') {
    submitError.value = precheckError
    return
  }
  // payload 只带变化键：键省略 = 不改（契约）；空串只在「从有到无」时显式出现。
  const body: UpdateAccountRequest = {}
  const trimmedName = displayName.value.trim()
  if (trimmedName !== originalDisplayName) {
    body.display_name = trimmedName
  }
  if (icon.value !== originalIcon) {
    body.icon = icon.value
  }
  const trimmedColor = color.value.trim()
  if (trimmedColor !== originalColor) {
    body.color = trimmedColor
  }
  submitting.value = true
  try {
    await accountApi.update(props.account.uuid, body)
    markDirty('local-write')
    emit('saved')
    emit('close')
  } catch (err) {
    submitError.value = colorMessageOf(err)
  } finally {
    submitting.value = false
  }
}

function close(): void {
  emit('close')
}

const previewIcon = computed(() => catIcon({ icon: icon.value }))
</script>

<template>
  <div class="aes-mask" @click.self="close">
    <section class="aes-panel" role="dialog" aria-modal="true" aria-label="编辑账户展示">
      <header class="aes-head">
        <h3>编辑展示 · {{ account.name }}</h3>
        <button class="aes-close" type="button" aria-label="关闭" @click="close">✕</button>
      </header>

      <div class="aes-body">
        <p v-if="offlineHint !== ''" class="aes-alert aes-alert--warn" role="status">{{ offlineHint }}</p>
        <div v-if="submitError" class="aes-alert aes-alert--error" role="alert">{{ submitError }}</div>

        <fieldset class="aes-fieldset" :disabled="!online || session.isViewer">
          <label class="aes-field">
            <span>显示名（可选，清空即恢复显示 Beancount 全名）</span>
            <input
              v-model="displayName"
              class="fb-input"
              type="text"
              placeholder="如：招商储蓄 / 早餐"
            />
          </label>

          <div class="aes-field">
            <span>图标（可选）</span>
            <IconPicker v-model="icon" :disabled="!online || session.isViewer" />
          </div>

          <label class="aes-field">
            <span>颜色（可选，#RRGGBB）</span>
            <div class="aes-color-row">
              <span
                class="aes-color-swatch"
                :style="colorValid ? { background: color.trim() } : undefined"
                aria-hidden="true"
              >{{ colorValid ? '' : '?' }}</span>
              <input
                v-model="color"
                class="fb-input aes-color-input"
                type="text"
                placeholder="#RRGGBB（清空恢复默认）"
                maxlength="7"
              />
            </div>
            <p v-if="color.trim() !== '' && !colorValid" class="aes-hint aes-hint--warn" role="status">
              颜色需为 #RRGGBB 六位十六进制格式
            </p>
          </label>

          <p class="aes-preview-line">
            预览：<span
              class="aes-preview"
              :style="colorValid ? { color: color.trim() } : undefined"
            >{{ previewIcon }}</span>
            <span>{{ displayName.trim() !== '' ? displayName.trim() : account.display_name || account.name }}</span>
          </p>
        </fieldset>
        <p class="aes-hint">展示字段不进 .beancount 导出，账目数字不受影响；其他端同步后一致。</p>
      </div>

      <div class="aes-foot">
        <button type="button" class="fb-btn-ghost" @click="close">取消</button>
        <button type="button" class="fb-btn-primary" :disabled="!canSubmit" @click="submit">
          {{ submitting ? '保存中…' : '保存' }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.aes-mask {
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

.aes-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-height: 92vh;
  background: var(--fb-card);
  border-radius: 20px 20px 0 0;
  overflow: hidden;
}

@media (min-width: 1024px) {
  .aes-mask {
    align-items: center;
  }

  .aes-panel {
    width: 440px;
    max-width: 92vw;
    max-height: 88vh;
    border-radius: 18px;
  }
}

.aes-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--fb-line);
}

.aes-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aes-close {
  border: none;
  background: transparent;
  color: var(--fb-sub);
  font-size: 16px;
  cursor: pointer;
}

.aes-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 18px 16px;
}

/* 离线 / viewer 置灰：fieldset disabled 原生禁用所有内部控件（iOS 14.8 支持）。 */
.aes-fieldset {
  border: none;
  margin: 0;
  padding: 0;
  min-width: 0;
}

.aes-fieldset:disabled {
  opacity: 0.55;
}

.aes-field {
  display: block;
  margin-top: 10px;
}

.aes-field > span {
  display: block;
  font-size: 12px;
  color: var(--fb-sub);
  margin-bottom: 6px;
}

.aes-color-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.aes-color-swatch {
  flex: none;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-soft);
  color: var(--fb-sub);
  font-size: 12px;
}

.aes-color-input {
  flex: 1;
  min-width: 0;
}

.aes-preview-line {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--fb-sub);
  display: flex;
  align-items: center;
  gap: 6px;
}

.aes-preview {
  font-size: 18px;
  line-height: 1;
}

.aes-alert {
  margin: 0 0 8px;
  padding: 8px 12px;
  border-radius: var(--fb-radius-input);
  font-size: 12px;
}

.aes-alert--warn {
  background: var(--fb-soft);
  color: var(--fb-ink);
}

.aes-alert--error {
  background: var(--fb-danger-soft);
  color: var(--fb-danger-ink);
}

.aes-hint {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--fb-sub);
}

.aes-hint--warn {
  color: var(--fb-danger);
}

.aes-foot {
  display: flex;
  gap: 10px;
  padding: 10px 18px calc(10px + env(safe-area-inset-bottom, 0px));
}

.aes-foot > button {
  flex: 1;
}
</style>
