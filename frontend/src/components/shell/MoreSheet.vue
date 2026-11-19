<script setup lang="ts">
/**
 * 移动「更多」弹层（T23a）。
 *
 * 复用 `SelectSheet`：滚动锁 / focus trap / ESC / 遮罩点击 / 44×44 命中区
 * 全在底座里，这里**不写任何自己的遮罩或 body 锁**（两套锁会互清内联样式，
 * 关闭后页面会跳到顶部——这条是踩过的坑）。
 *
 * 三段内容，段间分隔线：
 * 1. 10 个管理页（`NAV_MANAGE`，顺序与 PC 侧栏折叠组一致）；
 * 2. 修改密码；
 * 3. 退出登录（危险色，单列，避免误点）。
 *
 * **不放「记一笔」**：D-4 已定 FAB 是唯一记账入口，弹层里再来一个会让
 * 「是不是有两个记账入口」变成长期疑问。
 */
import SelectSheet from './SelectSheet.vue'
import { NAV_MANAGE, type NavItem } from './navItems'

defineProps<{
  /** 是否打开（透传给 SelectSheet）。 */
  open: boolean
}>()

const emit = defineEmits<{
  /** 请求关闭。 */
  close: []
  /** 选中某个管理项（是否可用由父级判定）。 */
  select: [item: NavItem]
  /** 修改密码。 */
  changePassword: []
  /** 退出登录。 */
  logout: []
}>()
</script>

<template>
  <SelectSheet
    :open="open"
    title="更多"
    dialog-label="更多"
    @close="emit('close')"
  >
    <section class="ms__group" aria-label="管理与工具">
      <button
        v-for="item in NAV_MANAGE"
        :key="item.key"
        type="button"
        class="ms__row"
        @click="emit('select', item)"
      >
        <span class="ms__ico" aria-hidden="true">{{ item.icon }}</span>
        <span class="ms__label">{{ item.label }}</span>
      </button>
    </section>

    <section class="ms__group" aria-label="账号">
      <button type="button" class="ms__row" @click="emit('changePassword')">
        <span class="ms__ico" aria-hidden="true">🔑</span>
        <span class="ms__label">修改密码</span>
      </button>
    </section>

    <section class="ms__group" aria-label="会话">
      <button type="button" class="ms__row ms__row--danger" @click="emit('logout')">
        <span class="ms__ico" aria-hidden="true">⏻</span>
        <span class="ms__label">退出登录</span>
      </button>
    </section>
  </SelectSheet>
</template>

<style scoped>
.ms__group + .ms__group {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--fb-line);
}

/* 每行 44px 起步，整行可点 */
.ms__row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  border: none;
  border-radius: var(--fb-radius-input);
  background: transparent;
  color: var(--fb-ink);
  font-family: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.ms__row:active {
  background: var(--fb-soft);
}

.ms__row:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: -2px;
}

.ms__ico {
  width: 18px;
  flex: none;
  text-align: center;
}

.ms__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ms__row--danger {
  color: var(--fb-danger-ink);
}
</style>
