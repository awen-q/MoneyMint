<script setup lang="ts">
/**
 * LedgerSwitcher —— 账本切换（报表重设计 T15）。
 *
 * 基于 SelectSheet。每行 = 账本名 + 角色徽标（owner 所有者 / editor 可编辑 / viewer 只读），
 * 当前账本行右侧打对勾并禁止重复触发 select。
 *
 * 两个刻意的宽容处理：
 * 1. `id` 允许 number | string —— 后端与路由参数经常一边给数字一边给字符串，
 *    这里统一 `String()` 后比较，避免出现「明明就是当前账本却也 emit 了一次」的假切换；
 * 2. 未知角色（或没传 role）不渲染徽标，而不是渲染一个空壳或猜一个权限出来。
 */
import { computed } from 'vue'

import SelectSheet from './SelectSheet.vue'

/** 角色 → 中文徽标文案；未登记的角色不显示徽标。 */
const ROLE_LABELS: Record<string, string> = {
  owner: '所有者',
  editor: '可编辑',
  viewer: '只读',
}

const props = withDefaults(
  defineProps<{
    /** 是否打开（透传给 SelectSheet）。 */
    open: boolean
    /** 可切换的账本列表。 */
    ledgers?: Array<{ id: number | string; name: string; role?: string }>
    /** 当前账本 id。 */
    currentId?: number | string
  }>(),
  {
    ledgers: () => [],
    currentId: '',
  },
)

const emit = defineEmits<{
  /** 请求关闭（遮罩 / 关闭按钮 / 选完账本）。 */
  close: []
  /** 选中另一个账本；紧接着会 emit close。点当前账本不会触发。 */
  select: [id: number | string]
}>()

const hasLedgers = computed(() => props.ledgers.length > 0)

function isCurrent(id: number | string): boolean {
  return String(props.currentId) === String(id)
}

function roleLabel(role?: string): string {
  if (role === undefined || role === '') {
    return ''
  }
  const label = ROLE_LABELS[role]
  return label === undefined ? '' : label
}

function pick(id: number | string): void {
  // 当前账本：不重复触发，避免上层白跑一次报表重载。
  if (isCurrent(id)) {
    return
  }
  emit('select', id)
  emit('close')
}

function onClose(): void {
  emit('close')
}
</script>

<template>
  <SelectSheet
    :open="open"
    title="切换账本"
    dialog-label="切换账本"
    @close="onClose"
  >
    <p v-if="!hasLedgers" class="ls-empty">暂无账本</p>

    <ul v-else class="ls-list">
      <li v-for="ledger in ledgers" :key="ledger.id" class="ls-item">
        <button
          type="button"
          class="ls-row"
          :class="{ 'ls-row--on': isCurrent(ledger.id) }"
          :aria-current="isCurrent(ledger.id) ? 'true' : undefined"
          @click="pick(ledger.id)"
        >
          <span class="ls-row__name">{{ ledger.name }}</span>
          <span v-if="roleLabel(ledger.role) !== ''" class="ls-badge">
            {{ roleLabel(ledger.role) }}
          </span>
          <span v-if="isCurrent(ledger.id)" class="ls-check" aria-hidden="true">✓</span>
        </button>
      </li>
    </ul>
  </SelectSheet>
</template>

<style scoped>
.ls-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.ls-item + .ls-item {
  margin-top: var(--fb-space-2);
}

/* 触控目标 ≥44，整行可点 */
.ls-row {
  display: flex;
  align-items: center;
  gap: var(--fb-space-2);
  width: 100%;
  min-height: 48px;
  padding: 10px 14px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.ls-row--on {
  border-color: var(--fb-blue);
  background: var(--fb-blue-soft);
}

.ls-row:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

.ls-row__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ls-badge {
  flex: none;
  padding: 2px 8px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-soft);
  color: var(--fb-sub);
  font-size: 11px;
  line-height: 1.6;
}

.ls-check {
  flex: none;
  color: var(--fb-blue);
  font-size: 14px;
  font-weight: 700;
}

.ls-empty {
  margin: 0;
  padding: var(--fb-space-4) 0;
  color: var(--fb-sub);
  font-size: 12.5px;
  text-align: center;
}
</style>
