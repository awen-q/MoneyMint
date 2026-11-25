<script setup lang="ts">
/**
 * 图标选择器（批 II）：20 个预设 emoji 宫格 + 自由输入 + 清除恢复默认。
 *
 * 三条口径：
 * 1. **校验在 core**：码位口径用 `core/accounts.ts` 的 `validateIconCodePoints`
 *    （`Array.from` 计数，与后端 Go rune 同口径）——本组件只提示不静默截断，
 *    超限值仍可被提交按钮拦截（AccountEditSheet / AccountForm 负责）。
 * 2. **空串 = 清除（恢复默认 📁）**：选择器始终对 modelValue 诚实——清除后
 *    父组件收到空串，提交时键省略 / 空串语义由调用方按契约决定。
 * 3. **不用原生 color picker / 弹窗组件**：iOS 14.8 兼容基线禁 `showModal`，
 *    宫格是纯按钮列表，自由输入是纯文本框。
 */
import { computed, ref, watch } from 'vue'

import { ACCOUNT_ICON_PRESETS, validateIconCodePoints } from '@/core/accounts'
import { t } from '@/i18n'

const props = defineProps<{
  /** 当前值（空串 = 未设置）。 */
  modelValue: string
  /** 是否禁用（viewer / 离线态）。 */
  disabled?: boolean
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
}>()

const customInput = ref(props.modelValue)

// 外部值变化（打开弹层预填 / 提交后重置）同步进输入框。
watch(
  () => props.modelValue,
  (next) => {
    customInput.value = next
  },
)

const codePointCount = computed(() => Array.from(customInput.value).length)
/** 非空且超 8 码位才提示；空串是合法的「清除」。 */
const tooLong = computed(() => customInput.value !== '' && codePointCount.value > 8)

/** 校验通过才上抛；非法输入停在输入框，由提示引导修正。 */
function commitCustom(): void {
  if (!validateIconCodePoints(customInput.value)) {
    return
  }
  emit('update:modelValue', customInput.value.trim())
}

function pickPreset(icon: string): void {
  customInput.value = icon
  emit('update:modelValue', icon)
}

function clearIcon(): void {
  customInput.value = ''
  emit('update:modelValue', '')
}
</script>

<template>
  <div class="ipick" role="group" :aria-label="t('common.iconPicker.label')">
    <div class="ipick__grid">
      <button
        v-for="preset in ACCOUNT_ICON_PRESETS"
        :key="preset"
        type="button"
        class="ipick__cell"
        :class="{ 'ipick__cell--on': modelValue === preset }"
        :disabled="disabled"
        :aria-pressed="modelValue === preset"
        :data-icon="preset"
        @click="pickPreset(preset)"
      >{{ preset }}</button>
    </div>
    <div class="ipick__custom">
      <input
        v-model="customInput"
        class="fb-input ipick__input"
        type="text"
        :placeholder="t('common.iconPicker.customPlaceholder')"
        :disabled="disabled"
        @change="commitCustom"
      />
      <span class="ipick__count" :class="{ 'ipick__count--over': tooLong }">
        {{ codePointCount }}/8
      </span>
    </div>
    <p v-if="tooLong" class="ipick__hint ipick__hint--warn" role="status">
      {{ t('common.iconPicker.tooLong') }}
    </p>
    <button type="button" class="ipick__clear" :disabled="disabled" @click="clearIcon">
      {{ t('common.iconPicker.clear') }}
    </button>
  </div>
</template>

<style scoped>
.ipick__grid {
  display: grid;
  grid-template-columns: repeat(10, 1fr);
  gap: 4px;
}

.ipick__cell {
  height: 34px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}

.ipick__cell--on {
  border-color: var(--fb-blue);
  background: var(--fb-brand-soft);
}

.ipick__cell:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ipick__custom {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.ipick__input {
  flex: 1;
  min-width: 0;
}

.ipick__count {
  flex: none;
  font-size: 11px;
  color: var(--fb-sub);
  font-variant-numeric: var(--fb-font-numeric);
}

.ipick__count--over {
  color: var(--fb-danger);
  font-weight: 600;
}

.ipick__hint {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.6;
}

.ipick__hint--warn {
  color: var(--fb-danger);
}

.ipick__clear {
  margin-top: 8px;
  border: none;
  background: transparent;
  color: var(--fb-sub);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  padding: 0;
}

.ipick__clear:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
