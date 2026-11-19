<script setup lang="ts">
/**
 * 顶栏（T21）：品牌 + 账本行 + 三小件（待同步 / 隐私 / 更多）。
 *
 * - **不放页名**（LO-16）：v4.1 稿里页名由各页 hero 承担，顶栏再放一次会和
 *   页面标题重复，移动端首屏出现两个同名标题。
 * - **移动端**是深绿 hero 底 + 白字（`--fb-hero-gradient`）；**≥900px** 退化为
 *   一条浅色窄条（账本行 + 三小件）——PC 侧栏已有品牌，但没有这条就没有
 *   同步徽标 / 隐私开关 / 改密退出的入口，功能会缺一块。
 * - 「⋯」不自己实现菜单：与底栏「更多」打开**同一个** `MoreSheet`，
 *   避免两套菜单（改密 / 退出各写一遍，文案一定漂移）。
 * - 隐私按钮带 `aria-pressed` + 随状态变化的 `aria-label`（读屏能听出当前是
 *   「隐藏金额」还是「显示金额」，只有字面图标的话读屏用户无从判断）。
 */
import { computed } from 'vue'

import { usePrivacyStore } from '@/stores/privacy'
import { useSessionStore } from '@/stores/session'
import SyncBadge from '@/components/SyncBadge.vue'

const emit = defineEmits<{
  /** 点了「⋯」：由父级打开 MoreSheet（与「更多」Tab 同一个弹层）。 */
  more: []
}>()

const session = useSessionStore()
const privacy = usePrivacyStore()

/** 账本行：账本名 +（有则）当前用户名，与现网顶栏信息量一致。 */
const ledgerLine = computed(() => {
  const name = session.ledgerName
  const user = session.user
  if (user === null) {
    return `当前账本：${name}`
  }
  const who = user.display_name !== '' ? user.display_name : user.username
  return who === '' ? `当前账本：${name}` : `当前账本：${name} · ${who}`
})

const privacyLabel = computed(() => (privacy.enabled ? '显示金额' : '隐藏金额'))

function togglePrivacy(): void {
  privacy.toggle()
}
</script>

<template>
  <header class="hd">
    <div class="hd__row">
      <span class="hd__brand">FamBean</span>
      <span class="hd__tools">
        <SyncBadge />
        <button
          type="button"
          class="hd__icon"
          :aria-pressed="privacy.enabled"
          :aria-label="privacyLabel"
          @click="togglePrivacy"
        >
          <span class="hd__icon-box" aria-hidden="true">{{ privacy.enabled ? '🙈' : '👁' }}</span>
        </button>
        <button type="button" class="hd__icon" aria-label="更多操作" @click="emit('more')">
          <span class="hd__icon-box" aria-hidden="true">⋯</span>
        </button>
      </span>
    </div>
    <p class="hd__ledger">{{ ledgerLine }}</p>
  </header>
</template>

<style scoped>
.hd {
  position: sticky;
  top: 0;
  z-index: 20;
  padding: 12px 16px;
  padding-top: max(12px, env(safe-area-inset-top, 0px));
  background: var(--fb-hero-gradient);
  color: var(--fb-white);
  box-shadow: var(--fb-shadow-header);
}

.hd__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.hd__brand {
  min-width: 0;
  overflow: hidden;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hd__tools {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
}

/* 命中区 44×44，视觉 30×30（用 padding 撑开，不改按钮外观） */
.hd__icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 7px;
  border: none;
  background: transparent;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.hd__icon-box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--fb-on-hero-pill);
  border-radius: var(--fb-radius-input);
  background: var(--fb-on-hero-pill);
  color: var(--fb-white);
  font-size: 14px;
  line-height: 1;
}

.hd__icon:focus-visible {
  outline: 2px solid var(--fb-white);
  outline-offset: 2px;
}

.hd__ledger {
  margin: 4px 0 0;
  color: var(--fb-on-hero-muted);
  font-size: 11px;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ≥900：侧栏已承担品牌与导航，顶栏退化为浅色窄条，只留账本行与三小件 */
@media (min-width: 900px) {
  .hd {
    position: static;
    min-height: 60px;
    padding: 8px 24px;
    background: var(--fb-card);
    color: var(--fb-ink);
    box-shadow: none;
    border-bottom: 1px solid var(--fb-line);
  }

  .hd__brand {
    display: none;
  }

  /* 品牌已由侧栏承担，PC 顶栏只留「账本行 + 三小件」，避免同一品牌出现两次 */
  .hd__tools {
    margin-left: auto;
  }

  .hd__ledger {
    margin-top: 2px;
    color: var(--fb-sub);
  }

  .hd__icon-box {
    border-color: var(--fb-line);
    background: var(--fb-card);
    color: var(--fb-sub);
  }

  .hd__icon:focus-visible {
    outline-color: var(--fb-blue);
  }
}
</style>
