<script setup lang="ts">
/**
 * PC 侧栏（T22）：5 项直达 + `管理 · 10` 折叠组。
 *
 * 三条刻意的取舍：
 * 1. **不加 `aria-hidden`**。现网稿里侧栏带 `aria-hidden="true"` 是个 bug——PC 上它是
 *    唯一主导航，隐藏后读屏用户会失去全部导航入口（LO-15）。这里只有 CSS 显隐
 *    （`<900px` 不显示），对辅助技术始终可读。
 * 2. **折叠组用原生 `<details>/<summary>`**：展开态由浏览器维护并自动映射成
 *    `aria-expanded`，不用自己写一套展开状态机，也不会与键盘操作打架。
 * 3. **组件不自己跳转**：只 `emit('select', item)`，由 `AppLayout` 统一判
 *    `ready`（不可点就出提示）再 `router.push`。这样「哪里判定入口可用」只有一处。
 */
import { NAV_MAIN, NAV_MANAGE, isItemActive, type NavItem } from './navItems'

withDefaults(
  defineProps<{
    /** 当前路由路径，用于高亮。由 AppLayout 传 `route.path`，组件内不读 router。 */
    activePath?: string
    /** 品牌副标题。 */
    brandSub?: string
  }>(),
  {
    activePath: '/',
    brandSub: '家庭共享账本',
  },
)

const emit = defineEmits<{
  /** 点了某个导航项（是否可用由父级判定）。 */
  select: [item: NavItem]
  /** 点了「＋ 记一笔」——PC 侧唯一的记账入口，不能丢。 */
  record: []
}>()
</script>

<template>
  <aside class="sb">
    <div class="sb__brand">
      FamBean
      <span class="sb__brand-sub">{{ brandSub }}</span>
    </div>

    <nav class="sb__nav" aria-label="主导航">
      <button
        v-for="item in NAV_MAIN"
        :key="item.key"
        type="button"
        class="sb__item"
        :class="{ 'sb__item--on': isItemActive(item, activePath) }"
        :aria-current="isItemActive(item, activePath) ? 'page' : undefined"
        @click="emit('select', item)"
      >
        <span class="sb__ico" aria-hidden="true">{{ item.icon }}</span>
        <span class="sb__label">{{ item.label }}</span>
      </button>

      <details class="sb__group">
        <summary class="sb__item sb__summary">
          <span class="sb__ico" aria-hidden="true">☰</span>
          <span class="sb__label">管理 · {{ NAV_MANAGE.length }}</span>
        </summary>
        <button
          v-for="item in NAV_MANAGE"
          :key="item.key"
          type="button"
          class="sb__item sb__item--sub"
          :class="{ 'sb__item--on': isItemActive(item, activePath) }"
          :aria-current="isItemActive(item, activePath) ? 'page' : undefined"
          @click="emit('select', item)"
        >
          <span class="sb__ico" aria-hidden="true">{{ item.icon }}</span>
          <span class="sb__label">{{ item.label }}</span>
        </button>
      </details>
    </nav>

    <button type="button" class="sb__cta" @click="emit('record')">＋ 记一笔</button>
  </aside>
</template>

<style scoped>
/* X-06：宽度对齐设计 `--sidebar-w: 232px`（原 240，窄 8px 且挤压内容区） */
.sb {
  display: none;
  width: var(--fb-sidebar-w, 232px);
  flex: 0 0 var(--fb-sidebar-w, 232px);
  flex-direction: column;
  background: var(--fb-sidebar);
  color: var(--fb-side-fg);
}

.sb__brand {
  padding: 20px;
  color: var(--fb-white);
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.sb__brand-sub {
  display: block;
  margin-top: 2px;
  color: var(--fb-side-head);
  font-size: 11px;
  font-weight: 400;
  letter-spacing: normal;
}

.sb__nav {
  flex: 1;
  overflow-y: auto;
  padding: 0 12px 8px;
}

/* 触控/点击目标 ≥44px */
.sb__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  border: none;
  border-radius: var(--fb-radius-input);
  background: transparent;
  color: var(--fb-side-fg);
  font-family: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}

/* 高亮用半透明白色的 pill：侧栏底色与 --fb-blue 都是深绿，实色底部对比不足 */
.sb__item--on {
  background: var(--fb-on-hero-pill);
  color: var(--fb-white);
  font-weight: 700;
}

.sb__item:focus-visible {
  outline: 2px solid var(--fb-white);
  outline-offset: 2px;
}

.sb__ico {
  width: 18px;
  flex: none;
  text-align: center;
  opacity: 0.85;
}

.sb__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sb__group {
  margin-top: 6px;
  border-top: 1px solid var(--fb-on-hero-pill);
  padding-top: 6px;
}

/* 去掉 summary 的默认三角，视觉与其它项对齐（展开态仍由浏览器维护） */
.sb__summary {
  list-style: none;
  cursor: pointer;
}

.sb__summary::-webkit-details-marker {
  display: none;
}

.sb__group[open] .sb__summary {
  margin-bottom: 2px;
}

.sb__item--sub {
  padding-left: 28px;
  font-size: 12.5px;
}

.sb__cta {
  margin: 12px 16px 18px;
  min-height: 44px;
  border: none;
  border-radius: var(--fb-radius-input);
  background: var(--fb-blue);
  color: var(--fb-white);
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.sb__cta:focus-visible {
  outline: 2px solid var(--fb-white);
  outline-offset: 2px;
}

/* 断点 900（LO-04：由 1024 下调，消除 769–1023 的「无侧栏 + 有底栏」空白带） */
@media (min-width: 900px) {
  .sb {
    display: flex;
  }
}
</style>
