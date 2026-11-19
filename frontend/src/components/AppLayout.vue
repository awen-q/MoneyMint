<script setup lang="ts">
/**
 * L-01 单布局（3 个 Dart shell → 1 个组件）
 *
 * 本批（B1 / T24）把壳层拆成四个专责组件，`AppLayout` 只留「装配 + 全局判定」：
 * - `ShellHead`   顶栏（品牌 + 账本行 + 待同步 / 隐私 / 更多）
 * - `ShellSidebar` PC 侧栏（5 项直达 + `管理 · 10` 折叠组 + 记一笔 CTA）
 * - `ShellTabs`   移动底栏（4 Tab + 中央 FAB）
 * - `MoreSheet`   移动「更多」弹层（10 管理项 + 改密 + 退出）
 *
 * 三条不变式：
 * 1. **导航可用性只在这里判定**：子组件只 `emit('select', item)`，`ready === false`
 *    的入口统一出提示、不跳转（`navItems.ts` 有「ready ⟺ 路由存在」的测试守门），
 *    因此任何批次都不会点出死链。
 * 2. **`RecordSheet` 仍是全局单实例**：PC CTA 与移动 FAB 都走同一个 `openRecord()`，
 *    一路进同一个 `sheet.open()`，不允许出现第二条记账入口。
 * 3. **路由零改动**：`router/index.ts` 一个字符都没动，本批只改呈现。
 *
 * 断点：900px（LO-04，由 1024 下调）——≥900 出侧栏、隐底栏；<900 反之。
 * 底部留白 94px = 底栏 58（X-07 对齐设计 `--tabbar-h`）+ FAB 上溢 24 + 12 间隙。
 * `content` 与 `notice` 两处必须同步，否则末卡会被 FAB 压住（LO-03 的复发点）。
 */
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { registerServiceWorker } from '@/core/pwa'
import { useSessionStore } from '@/stores/session'
import { useSyncStore } from '@/stores/sync'
import { useRecordSheetStore } from '@/stores/recordSheet'
import RecordSheet from './RecordSheet.vue'
import MoreSheet from './shell/MoreSheet.vue'
import ShellHead from './shell/ShellHead.vue'
import ShellSidebar from './shell/ShellSidebar.vue'
import ShellTabs from './shell/ShellTabs.vue'
import type { NavItem } from './shell/navItems'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const sheet = useRecordSheetStore()
const sync = useSyncStore()
const notice = ref('')

/** 移动「更多」弹层（底栏「更多」与顶栏「⋯」共用同一个）*/
const moreOpen = ref(false)

// 批 5：同步内核随登录布局启动（自动同步 + 状态订阅）；
// PWA 更新提示：新版本就绪时出横幅，用户确认才刷新（不得打断录入，AC-35）。
const updateReady = ref(false)
let pwaHandle: { confirmUpdate: () => void } | null = null

onMounted(() => {
  void sync.bootstrap()
  pwaHandle = registerServiceWorker(() => {
    updateReady.value = true
  })
})

function applyUpdate(): void {
  if (pwaHandle !== null) {
    pwaHandle.confirmUpdate()
  }
}

/** 导航入口点击：未上线的入口只提示，不跳转（永不死链）。 */
function onSelect(item: NavItem): void {
  if (item.to === undefined || !item.ready) {
    notice.value = `${item.label}将在后续批次开放`
    return
  }
  notice.value = ''
  void router.push(item.to)
}

/** 弹层内选中：先关弹层再导航，避免弹层压在目标页上。 */
function onSelectFromSheet(item: NavItem): void {
  moreOpen.value = false
  onSelect(item)
}

function openMore(): void {
  moreOpen.value = true
}

function closeMore(): void {
  moreOpen.value = false
}

function openRecord(): void {
  if (session.isViewer) {
    notice.value = '只读成员不能记账'
    return
  }
  if (session.needsInvite) {
    notice.value = '请先等待 owner 邀请加入账本'
    return
  }
  notice.value = ''
  sheet.open()
}

async function logout(): Promise<void> {
  moreOpen.value = false
  await session.logout()
  await router.replace({ name: 'login' })
}

function goChangePassword(): void {
  moreOpen.value = false
  void router.push({ name: 'change-password' })
}
</script>

<template>
  <div class="layout">
    <!-- PC 侧栏（≥900）：5 项直达 + 管理 · 10 折叠组 + 记一笔 CTA -->
    <ShellSidebar :active-path="route.path" @select="onSelect" @record="openRecord" />

    <!-- 主区 -->
    <div class="layout__main">
      <div v-if="updateReady" class="layout__update" role="status">
        <span>有新版本可用</span>
        <button class="fb-btn-primary layout__update-btn" type="button" @click="applyUpdate">立即更新</button>
      </div>

      <!-- 顶栏：品牌 + 账本行 + 待同步 / 隐私 / 更多（页名不放这里，见 LO-16） -->
      <ShellHead @more="openMore" />

      <main class="layout__content">
        <slot />
      </main>

      <p v-if="notice" class="layout__notice" role="status">{{ notice }}</p>
    </div>

    <!-- 移动底栏（<900）：4 Tab + 中央 FAB -->
    <ShellTabs
      :active-path="route.path"
      @select="onSelect"
      @record="openRecord"
      @more="openMore"
    />

    <!-- 移动「更多」弹层：10 管理项 + 改密 + 退出（不含记一笔） -->
    <MoreSheet
      :open="moreOpen"
      @close="closeMore"
      @select="onSelectFromSheet"
      @change-password="goChangePassword"
      @logout="logout"
    />

    <!-- C-01 单实例：PC 弹窗 / 移动 Sheet / 全屏由同一组件按断点收敛 -->
    <RecordSheet v-if="sheet.isOpen" @close="sheet.close()" />
  </div>
</template>

<style scoped>
.layout {
  min-height: 100vh;
  display: flex;
  background: var(--fb-bg);
  color: var(--fb-ink);
  /* 记一笔全屏浮层的滚动链隔离：根布局不参与回弹，避免与 .rs-body 抢滚动。
     z-index 层级：底栏 30 < 提示 40 < 记一笔浮层 60，全屏态不会被底栏遮挡。 */
  overscroll-behavior: none;
}

/* ---------- 主区 ---------- */
.layout__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.layout__update {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 12px 16px 0;
  padding: 10px 14px;
  border-radius: var(--fb-radius-input);
  background: var(--fb-warn-soft);
  color: var(--fb-warn-ink);
  font-size: 12px;
}

.layout__update-btn {
  flex-shrink: 0;
  padding: 4px 12px;
  font-size: 12px;
}

/* 底部留白 = 底栏 58 + FAB 上溢 24 + 间隙 12 = 94（LO-03 复发点，别只改一处） */
.layout__content {
  flex: 1;
  padding: 16px;
  padding-bottom: calc(94px + env(safe-area-inset-bottom, 0px));
}

.layout__notice {
  position: fixed;
  left: 50%;
  bottom: calc(94px + env(safe-area-inset-bottom, 0px));
  z-index: 40;
  margin: 0;
  padding: 8px 14px;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-sidebar);
  color: var(--fb-white);
  font-size: 12px;
  transform: translateX(-50%);
}

/* ---------- 断点 900（LO-04：由 1024 下调，消除 769–1023 的空白带） ---------- */
@media (min-width: 900px) {
  /* X-02：PC 内边距对齐设计 `.page`（`26px 28px`）。移动端保持 16px ——
     四页视图内部已把自带横向 margin 归零，标题与卡片左边界因此对齐。 */
  .layout__content {
    padding: 26px 28px;
    padding-bottom: 24px;
  }

  /* X-08：内容最大宽对齐设计 `--max: 1080px`（原 1180，PC 上指标带与图表过长） */
  .layout__content > * {
    max-width: 1080px;
    margin-left: auto;
    margin-right: auto;
  }

  /* PC 无底栏，提示条贴底即可 */
  .layout__notice {
    bottom: 24px;
  }
}
</style>
