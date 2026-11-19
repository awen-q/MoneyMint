<script setup lang="ts">
/**
 * StateCard —— 页面级四态卡（报表重设计 T17）。
 *
 * 四个态：loading / error / empty / ready。
 *
 * **红线：error 态绝不渲染任何金额。**
 * 报表接口失败时若照常渲染 `¥0.00`，用户会读成「这个月没花钱」——
 * 这是「静默错账」里最危险的一种。所以错误分支里连 0 值兜底都不给，
 * 只留标题 / 说明 / 重试按钮，金额位整块不出现。同理，error 态也不会渲染默认插槽，
 * 调用方就算把金额节点塞进插槽也透不出来。
 *
 * 动效：loading 的三个点用 `@keyframes` 做透明度呼吸，并在
 * `prefers-reduced-motion: reduce` 下整组关掉。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 当前态。ready 时渲染默认插槽，其余三态渲染内置占位。 */
    state: 'loading' | 'error' | 'empty' | 'ready'
    /** 标题；不传时按态取默认文案（error「加载失败」/ empty「暂无数据」）。 */
    title?: string
    /** 一句话说明；不传则不渲染。 */
    desc?: string
    /** 动作按钮文案；error 态不传时默认「重试」，empty 态不传则不显示按钮。 */
    actionText?: string
    /** 动作按钮禁用（如无权限 / 正在重试）。 */
    actionDisabled?: boolean
  }>(),
  {
    title: '',
    desc: '',
    actionText: '',
    actionDisabled: false,
  },
)

const emit = defineEmits<{
  /** 点动作按钮（重试 / 记一笔）。 */
  action: []
}>()

const resolvedTitle = computed(() => {
  if (props.title !== '') {
    return props.title
  }
  if (props.state === 'error') {
    return '加载失败'
  }
  if (props.state === 'empty') {
    return '暂无数据'
  }
  return ''
})

const resolvedActionText = computed(() => {
  if (props.actionText !== '') {
    return props.actionText
  }
  return props.state === 'error' ? '重试' : ''
})

const showAction = computed(
  () => (props.state === 'error' || props.state === 'empty') && resolvedActionText.value !== '',
)

function onAction(): void {
  emit('action')
}
</script>

<template>
  <section class="sc" :class="`sc--${state}`">
    <!-- loading：一行「正在加载…」+ 三个呼吸点，不放任何占位金额 -->
    <p v-if="state === 'loading'" class="sc-loading" role="status" aria-live="polite">
      <span class="sc-loading__dots" aria-hidden="true">
        <i /><i /><i />
      </span>
      <span class="sc-loading__text">正在加载…</span>
    </p>

    <!-- error：标题 + 说明 + 重试。此处刻意没有任何金额节点，见文件头红线说明。 -->
    <div v-else-if="state === 'error'" class="sc-box" role="alert">
      <p class="sc-box__title">{{ resolvedTitle }}</p>
      <p v-if="desc !== ''" class="sc-box__desc">{{ desc }}</p>
      <button
        v-if="showAction"
        type="button"
        class="sc-btn"
        :disabled="actionDisabled"
        @click="onAction"
      >
        {{ resolvedActionText }}
      </button>
    </div>

    <!-- empty：默认「暂无数据」，动作按钮可选 -->
    <div v-else-if="state === 'empty'" class="sc-box">
      <p class="sc-box__title">{{ resolvedTitle }}</p>
      <p v-if="desc !== ''" class="sc-box__desc">{{ desc }}</p>
      <button
        v-if="showAction"
        type="button"
        class="sc-btn"
        :disabled="actionDisabled"
        @click="onAction"
      >
        {{ resolvedActionText }}
      </button>
    </div>

    <slot v-else />
  </section>
</template>

<style scoped>
.sc {
  display: block;
  width: 100%;
}

.sc-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--fb-space-2);
  margin: 0;
  padding: var(--fb-space-6) var(--fb-space-4);
  color: var(--fb-sub);
  font-size: 12.5px;
  text-align: center;
}

.sc-loading__dots {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.sc-loading__dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--fb-blue);
  animation: sc-breathe 1.2s ease-in-out infinite;
}

.sc-loading__dots i:nth-child(2) {
  animation-delay: 0.16s;
}

.sc-loading__dots i:nth-child(3) {
  animation-delay: 0.32s;
}

.sc-loading__text {
  font-variant-numeric: var(--fb-font-numeric);
}

.sc-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--fb-space-2);
  padding: var(--fb-space-6) var(--fb-space-4);
  border: 1px dashed var(--fb-line);
  border-radius: var(--fb-radius-card);
  background: var(--fb-card);
  text-align: center;
}

.sc--error .sc-box {
  border-color: var(--fb-danger);
}

.sc-box__title {
  margin: 0;
  color: var(--fb-ink);
  font-size: 14px;
  font-weight: 700;
}

.sc--error .sc-box__title {
  color: var(--fb-danger-ink);
}

.sc-box__desc {
  margin: 0;
  color: var(--fb-sub);
  font-size: 12px;
  line-height: 1.7;
}

/* 动作按钮：触控目标 ≥44 */
.sc-btn {
  min-height: 44px;
  margin-top: var(--fb-space-1);
  padding: 10px 20px;
  border: 1px solid var(--fb-blue);
  border-radius: var(--fb-radius-pill);
  background: var(--fb-blue);
  color: var(--fb-white);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.sc-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.sc-btn:focus-visible {
  outline: 2px solid var(--fb-blue);
  outline-offset: 2px;
}

@keyframes sc-breathe {
  0%,
  80%,
  100% {
    opacity: 0.25;
  }

  40% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sc-loading__dots i {
    animation: none;
    opacity: 0.6;
  }
}
</style>
