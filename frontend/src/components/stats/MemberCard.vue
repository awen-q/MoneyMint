<script setup lang="ts">
/**
 * 成员贡献折叠卡（B4 / T48b，D-3 拍板从报表页搬入统计页）。
 *
 * - 折叠态是**默认**（统计页信息密集，成员维度属次级信息）；
 * - 数据来自 `core/reports.ts` 的 `memberContributions`（按记账人聚合笔数与支出），
 *   组件不做算术；
 * - 金额走 `MoneyText`（遮挡与币种符号都在那一层）。
 */
import { ref } from 'vue'

import type { MemberContribution } from '@/core/reports'
import MoneyText from '@/components/MoneyText.vue'

withDefaults(
  defineProps<{
    members: MemberContribution[]
    commodity: string
    masked?: boolean
  }>(),
  { masked: false },
)

const open = ref(false)
</script>

<template>
  <section class="member-card">
    <button
      type="button"
      class="member-card__toggle"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="member-card__title">成员贡献</span>
      <span class="member-card__count">{{ members.length }} 人</span>
      <span class="member-card__caret" aria-hidden="true">{{ open ? '⌃' : '⌄' }}</span>
    </button>

    <div v-if="open" class="member-card__body">
      <p v-if="members.length === 0" class="member-card__empty">本月没有记录</p>
      <ul v-else class="member-card__list">
        <li v-for="member in members" :key="member.name" class="member-card__row">
          <span class="member-card__name">{{ member.name }}</span>
          <span class="member-card__meta">{{ member.count }} 笔</span>
          <span class="member-card__amount">
            <MoneyText :amount="member.amount" :commodity="commodity" :privacy="masked" size="sm" />
          </span>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.member-card {
  padding: 12px 14px;
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

.member-card__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.member-card__title {
  font-weight: 600;
}

.member-card__count {
  color: var(--fb-sub);
  font-size: 11px;
}

.member-card__caret {
  margin-left: auto;
  color: var(--fb-sub);
}

.member-card__body {
  margin-top: 8px;
}

.member-card__empty {
  margin: 0;
  color: var(--fb-sub);
  font-size: 12px;
}

.member-card__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.member-card__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid var(--fb-line);
  font-size: 12px;
}

.member-card__row:last-child {
  border-bottom: none;
}

.member-card__name {
  min-width: 0;
  overflow: hidden;
  color: var(--fb-ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.member-card__meta {
  color: var(--fb-sub);
  font-size: 11px;
}

.member-card__amount {
  margin-left: auto;
  flex: none;
  font-variant-numeric: var(--fb-font-numeric);
}
</style>
