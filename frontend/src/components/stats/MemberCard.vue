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
      <!-- EXT-01 ⑤：卡底口径说明（设计 `.tbl-note` 原语），说明「按记账人聚合」 -->
      <p class="member-card__note">按记账人聚合 · {{ commodity }} 口径</p>
    </div>
  </section>
</template>

<style scoped>
.member-card {
  padding: 16px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  box-shadow: var(--fb-shadow-card);
}

/* 折叠条按设计 `.card-head` 语法（EXT-01 ②）：基线对齐、两端拉开、下方 12px。
   **不加 position: sticky / fixed** —— `statsCards.test.ts` 有护栏，且它只是普通卡片。
   `margin-left:auto` 只留在 caret 上：若给 `__count` 也加 auto，两个 auto 会平分
   空隙，计数会被推到标题与折叠符之间。 */
.member-card__toggle {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  margin-bottom: 12px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

/* 键盘焦点环（EXT-01 ③ / 设计 `:693` 的既定交互语）：折叠触发器必读 */
.member-card__toggle:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

.member-card__title {
  color: var(--fb-ink);
  font-size: 15px;
  font-weight: 700;
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
  margin-top: 0;
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

/* 行密度与资产页 `.asset-li` 对齐（EXT-01 ④）：9px 4px / 13px */
.member-card__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 4px;
  border-bottom: 1px solid var(--fb-line);
  color: var(--fb-ink);
  font-size: 13px;
}

.member-card__row:last-child {
  border-bottom: none;
}

.member-card__name {
  min-width: 0;
  overflow: hidden;
  color: var(--fb-ink);
  font-weight: 500;
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
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: var(--fb-font-numeric);
  text-align: right;
}

/* 卡底口径说明（设计 `.tbl-note` 原语） */
.member-card__note {
  margin: 8px 0 0;
  color: var(--fb-sub);
  font-size: 11px;
  line-height: 1.5;
}

@media (max-width: 768px) {
  .member-card {
    padding: 14px;
  }
}
</style>
