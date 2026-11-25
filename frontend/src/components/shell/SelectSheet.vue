<script lang="ts">
/**
 * 模块级滚动锁：同一文件内所有 SelectSheet 实例共享。
 *
 * 用「深度计数」而不是布尔值：调用方有可能叠放两个弹层（如账本切换里再开月份选择），
 * 若用布尔值，内层先关闭就会把背景解冻，外层还开着但背景已能惯性滚动的经典 bug。
 * 放在普通 <script> 块里才能拿到模块作用域；<script setup> 内的顶层声明是每实例一份。
 */
let scrollLockDepth = 0
let scrollLockY = 0
</script>

<script setup lang="ts">
/**
 * SelectSheet —— 弹层底座（报表重设计 T12）。
 *
 * 形态：
 * - 移动端（< 900px）：底部 sheet，`transform: translateY` 进场，顶部 36×4 拖拽手柄（纯视觉）；
 * - PC（≥ 900px）：居中模态，宽 420、`max-height: 80vh`（内容更矮时由内容决定高度，
 *   即 `min(80vh, 内容高)`，CSS 里 max-height 天然满足该语义）。
 *
 * 滚动锁：**必须用 `position: fixed` + `top: -scrollY`**。只写 `overflow: hidden` 在 Safari 14
 * 上不可靠——背景仍可被惯性滚动 / 露白，关闭后位置还会漂移。这里记录打开瞬间的 scrollY，
 * 关闭时 `scrollTo(0, y)` 精确还原（误差为 0），并清掉全部内联样式。
 *
 * 无障碍：`role="dialog"` + `aria-modal="true"` + `aria-label`（同 RecordSheet 的写法）；
 * 打开时焦点移入面板内第一个可聚焦元素，Tab 在面板内循环，ESC / 点遮罩关闭，
 * 关闭后焦点归还打开前的 `document.activeElement`（触发按钮）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import { t } from '@/i18n'

/** 可聚焦元素选择器：排除 disabled 与 tabindex="-1"（面板自身）。 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

const props = withDefaults(
  defineProps<{
    /** 是否打开。false 时不渲染任何 DOM（而不是 display:none），避免读屏扫到隐藏弹层。 */
    open: boolean
    /** 面板标题，同时作为 aria-label 的兜底。 */
    title: string
    /**
     * 读屏文案覆盖项（如「选择账期月份」）。
     * 不能命名为 ariaLabel：那是内置属性名，在模板里会与 `aria-label` 撞车，vue-tsc 判缺失。
     */
    dialogLabel?: string
  }>(),
  {
    dialogLabel: '',
  },
)

const emit = defineEmits<{
  /** 请求关闭：ESC / 点遮罩 / 点关闭按钮统一走这里，由调用方决定是否真的收起。 */
  close: []
}>()

const panelRef = ref<HTMLElement | null>(null)
const dialogLabelText = computed(() =>
  props.dialogLabel !== '' ? props.dialogLabel : props.title,
)

/** 打开前的焦点元素，关闭后归还。 */
let returnFocusEl: HTMLElement | null = null
/** 本实例当前是否处于「已激活」状态（幂等保护，避免重复加/减锁）。 */
let activated = false

/** 锁背景滚动：fixed + 负 top 顶住原位，视觉上页面不动但不可滚。 */
function lockScroll(): void {
  if (scrollLockDepth === 0) {
    scrollLockY = window.scrollY || window.pageYOffset || 0
    const { body } = document
    body.style.position = 'fixed'
    body.style.top = `${-scrollLockY}px`
    body.style.left = '0'
    body.style.right = '0'
    body.style.width = '100%'
    body.style.overflow = 'hidden'
  }
  scrollLockDepth += 1
}

/** 解锁并按打开前的 scrollY 精确还原（误差必须为 0）。 */
function unlockScroll(): void {
  if (scrollLockDepth === 0) {
    return
  }
  scrollLockDepth -= 1
  if (scrollLockDepth > 0) {
    return
  }
  const { body } = document
  body.style.position = ''
  body.style.top = ''
  body.style.left = ''
  body.style.right = ''
  body.style.width = ''
  body.style.overflow = ''
  const restoreY = scrollLockY
  scrollLockY = 0
  window.scrollTo(0, restoreY)
}

/** 面板内当前可聚焦元素列表（DOM 顺序）。 */
function focusables(): HTMLElement[] {
  const root = panelRef.value
  if (root === null) {
    return []
  }
  const result: HTMLElement[] = []
  root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR).forEach((node) => {
    if (node.getAttribute('aria-hidden') === 'true') {
      return
    }
    if (node.hasAttribute('disabled')) {
      return
    }
    if (node.getAttribute('type') === 'hidden') {
      return
    }
    result.push(node)
  })
  return result
}

/** ESC 关闭 + Tab 焦点循环（在 document 上捕获，焦点在遮罩/面板上都生效）。 */
function onKeydown(event: KeyboardEvent): void {
  if (!activated) {
    return
  }
  if (event.key === 'Escape' || event.key === 'Esc') {
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key !== 'Tab') {
    return
  }
  const root = panelRef.value
  if (root === null) {
    return
  }
  const items = focusables()
  if (items.length === 0) {
    // 没有任何可聚焦元素时把焦点钉在面板上，别让它跑到背景页面。
    event.preventDefault()
    root.focus()
    return
  }
  const first = items[0] as HTMLElement
  const last = items[items.length - 1] as HTMLElement
  const active = document.activeElement as HTMLElement | null
  const inside = active !== null && root.contains(active)
  if (event.shiftKey) {
    if (!inside || active === first) {
      event.preventDefault()
      last.focus()
    }
    return
  }
  if (!inside || active === last) {
    event.preventDefault()
    first.focus()
  }
}

/** 打开：记录焦点 → 锁滚动 → 挂键盘监听 → 焦点移入面板。 */
function activate(): void {
  if (activated) {
    return
  }
  activated = true
  const active = document.activeElement
  returnFocusEl = active instanceof HTMLElement ? active : null
  lockScroll()
  document.addEventListener('keydown', onKeydown, true)
  void nextTick(() => {
    if (!activated) {
      return
    }
    const items = focusables()
    if (items.length > 0) {
      ;(items[0] as HTMLElement).focus()
      return
    }
    panelRef.value?.focus()
  })
}

/** 关闭：摘监听 → 解锁滚动 → 焦点归还触发元素。 */
function deactivate(): void {
  if (!activated) {
    return
  }
  activated = false
  document.removeEventListener('keydown', onKeydown, true)
  unlockScroll()
  const target = returnFocusEl
  returnFocusEl = null
  if (target !== null && document.contains(target)) {
    target.focus()
  }
}

function requestClose(): void {
  emit('close')
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      activate()
      return
    }
    deactivate()
  },
  { immediate: true },
)

// 未走正常关闭流程就被卸载（如父级 v-if 整块销毁）时也要解锁，否则背景永久冻住。
onBeforeUnmount(() => {
  deactivate()
})
</script>

<template>
  <div v-if="open" class="ss-mask" @click.self="requestClose">
    <section
      ref="panelRef"
      class="ss-panel"
      role="dialog"
      aria-modal="true"
      :aria-label="dialogLabelText"
      tabindex="-1"
    >
      <!-- 拖拽手柄：纯视觉（未实现手势拖拽），故对读屏隐藏 -->
      <div class="ss-handle" aria-hidden="true" />

      <header class="ss-head">
        <h2 class="ss-title">{{ title }}</h2>
        <button
          type="button"
          class="ss-close"
          :aria-label="t('shell.closeDialog', { title })"
          @click="requestClose"
        >
          <span class="ss-close__icon" aria-hidden="true">✕</span>
        </button>
      </header>

      <div class="ss-body">
        <slot />
      </div>

      <footer v-if="$slots.footer" class="ss-foot">
        <slot name="footer" />
      </footer>
    </section>
  </div>
</template>

<style scoped>
.ss-mask {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 92;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: var(--fb-mask);
  animation: ss-fade 0.18s ease-out both;
}

.ss-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  /* 移动端底部 sheet：最大 80vh，内容更矮时由内容决定高度 */
  max-height: 80vh;
  background: var(--fb-card);
  border-radius: var(--fb-radius-card) var(--fb-radius-card) 0 0;
  box-shadow: var(--fb-shadow-panel);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  animation: ss-rise 0.22s ease-out both;
}

.ss-panel:focus {
  outline: none;
}

.ss-handle {
  flex: none;
  width: 36px;
  height: 4px;
  margin: 8px auto 0;
  border-radius: var(--fb-radius-pill);
  background: var(--fb-line-strong);
}

.ss-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--fb-space-2);
  padding: var(--fb-space-3) var(--fb-space-4);
  border-bottom: 1px solid var(--fb-line);
}

.ss-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--fb-ink-deep);
}

/* 视觉 30×30，命中区 44×44：用 padding 撑开而不是放大按钮本身 */
.ss-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin: -7px -7px -7px 0;
  padding: 7px;
  border: none;
  background: transparent;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.ss-close__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--fb-line);
  border-radius: var(--fb-radius-input);
  background: var(--fb-card);
  color: var(--fb-sub);
  font-size: 14px;
  line-height: 1;
}

.ss-close:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

.ss-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--fb-space-3) var(--fb-space-4) var(--fb-space-5);
  -webkit-overflow-scrolling: touch;
}

.ss-foot {
  flex: none;
  padding: var(--fb-space-3) var(--fb-space-4);
  border-top: 1px solid var(--fb-line);
}

@keyframes ss-fade {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

@keyframes ss-rise {
  from {
    transform: translateY(100%);
  }

  to {
    transform: translateY(0);
  }
}

@keyframes ss-pop {
  from {
    opacity: 0;
    transform: translateY(8px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* PC：居中模态，宽 420、最大高 80vh */
@media (min-width: 900px) {
  .ss-mask {
    align-items: center;
  }

  .ss-panel {
    width: 420px;
    max-width: calc(100vw - 32px);
    border-radius: var(--fb-radius-card);
    padding-bottom: 0;
    animation-name: ss-pop;
  }

  .ss-handle {
    display: none;
  }
}

/* 尊重系统「减少动态效果」：只去掉动效，布局与层级不变 */
@media (prefers-reduced-motion: reduce) {
  .ss-mask,
  .ss-panel {
    animation: none;
  }
}
</style>
