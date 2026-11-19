<script setup lang="ts">
/**
 * 移动底栏（T23）：4 Tab + 中央 FAB，`repeat(5, 1fr)`。
 *
 * 结构照抄现网 `AppLayout`（`slice(0,2)` + FAB + `slice(2)`），因为 DOM 顺序
 * 就是视觉顺序，FAB 一定落在第 3 格——LO-14 的教训是：3 等分里塞 54px FAB
 * （`margin-top: -24px` 上溢）会把中间格文字压住，所以格子数必须是 5。
 *
 * 「更多」不是路由：点它 `emit('more')` 开弹层，**不切视图**。
 * 组件内不做 `router.push`，可用性判定统一由 AppLayout 负责（见 navItems.ts）。
 */
import { MOBILE_TABS, isItemActive, type NavItem } from './navItems'

withDefaults(
  defineProps<{
    /** 当前路由路径，用于高亮。 */
    activePath?: string
  }>(),
  {
    activePath: '/',
  },
)

const emit = defineEmits<{
  /** 点了可跳转的 Tab（是否可用由父级判定）。 */
  select: [item: NavItem]
  /** 点了中央 FAB。 */
  record: []
  /** 点了「更多」。 */
  more: []
}>()

/** 前两个格子；后两个在 FAB 之后渲染。 */
const leadingTabs: NavItem[] = MOBILE_TABS.slice(0, 2)
const trailingTabs: NavItem[] = MOBILE_TABS.slice(2)

function onTabClick(item: NavItem): void {
  if (item.to === undefined) {
    emit('more')
    return
  }
  emit('select', item)
}
</script>

<template>
  <nav class="tb" aria-label="底部导航">
    <button
      v-for="item in leadingTabs"
      :key="item.key"
      type="button"
      class="tb__tab"
      :class="{ 'tb__tab--on': isItemActive(item, activePath) }"
      :aria-current="isItemActive(item, activePath) ? 'page' : undefined"
      @click="onTabClick(item)"
    >
      <span class="tb__ico" aria-hidden="true">{{ item.icon }}</span>
      <span class="tb__label">{{ item.label }}</span>
    </button>

    <button type="button" class="tb__fab" aria-label="记一笔" @click="emit('record')">＋</button>

    <button
      v-for="item in trailingTabs"
      :key="item.key"
      type="button"
      class="tb__tab"
      :class="{ 'tb__tab--on': isItemActive(item, activePath) }"
      :aria-current="isItemActive(item, activePath) ? 'page' : undefined"
      @click="onTabClick(item)"
    >
      <span class="tb__ico" aria-hidden="true">{{ item.icon }}</span>
      <span class="tb__label">{{ item.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.tb {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 30;
  display: grid;
  /* 5 格：4 个 Tab + 中央 FAB（LO-14） */
  grid-template-columns: repeat(5, 1fr);
  align-items: center;
  height: calc(58px + env(safe-area-inset-bottom, 0px));
  padding-bottom: env(safe-area-inset-bottom, 0px);
  background: var(--fb-card);
  border-top: 1px solid var(--fb-line);
  box-shadow: var(--fb-shadow-dock);
}

.tb__tab {
  grid-row: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-height: 44px;
  padding: 8px 0 6px;
  border: none;
  background: transparent;
  color: var(--fb-sub);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.tb__tab--on {
  color: var(--fb-blue);
  font-weight: 700;
}

.tb__tab:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: -2px;
}

.tb__ico {
  font-size: 18px;
  line-height: 1;
}

.tb__label {
  line-height: 1.2;
}

/* 中央 FAB：上溢 24px，占第 3 格；44px 命中区要求已由 54px 按钮本体满足 */
.tb__fab {
  grid-column: 3;
  grid-row: 1;
  justify-self: center;
  align-self: start;
  width: 54px;
  height: 54px;
  margin-top: -24px;
  padding: 0;
  border: 4px solid var(--fb-card);
  border-radius: 50%;
  background: var(--fb-blue);
  color: var(--fb-white);
  font-family: inherit;
  font-size: 26px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 8px 20px var(--fb-shadow-accent);
  -webkit-tap-highlight-color: transparent;
}

.tb__fab:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 3px;
}

/* ≥900 隐藏底栏（PC 由侧栏承担导航），断点须写在基样式之后 */
@media (min-width: 900px) {
  .tb {
    display: none;
  }
}
</style>
