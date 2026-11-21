<script setup lang="ts">
/**
 * 分享图预览面板（小票成功页 / 交易详情页共用）
 *
 * 流程：本地 Canvas 生成 → 预览 → 勾选敏感项（默认全关）→ 保存相册 / 系统分享。
 * 安全底线：
 * - 只收已格式化的 amountText（隐私开关打开时就是遮挡符），组件不碰原始金额；
 * - 敏感字段（Bean 片段 / 完整账户 / 标签 / 精确时间）默认关，勾选即时重绘；
 * - 生成失败 / 无分享能力时给出明确兜底，绝不白点。
 */
import { computed, ref, watch } from 'vue'

import {
  drawShareReceipt,
  exportReceiptBlob,
  readReceiptPalette,
  receiptHeight,
  setupReceiptCanvas,
  shareReceiptFileName,
} from '@/core/receiptCanvas'
import {
  collectShareLines,
  DEFAULT_EXTRAS,
  EMPTY_DETAILS,
  type ShareReceiptData,
  type ShareReceiptDetails,
} from '@/core/receiptImage'

const props = defineProps<{
  /** 已脱敏的票面数据（金额必须是显示串）。 */
  data: ShareReceiptData
  /** 敏感字段内容；对应 extras 未勾选时不会进画布。 */
  details: ShareReceiptDetails
}>()

const emit = defineEmits<{ close: [] }>()

const extras = ref({ ...DEFAULT_EXTRAS })
const previewUrl = ref('')
const busy = ref(false)
const notice = ref('')
const noticeTone = ref<'ok' | 'err'>('ok')
const canvasRef = ref<HTMLCanvasElement | null>(null)

const EXTRA_ITEMS = [
  { key: 'preciseTime', label: '精确时间', hint: '到秒' },
  { key: 'tags', label: '标签备注', hint: '可能含人名地点' },
  { key: 'accounts', label: '完整账户名', hint: '泄露科目体系' },
  { key: 'bean', label: 'Beancount 片段', hint: '仅发信任对象' },
] as const

const activeDetails = computed<ShareReceiptDetails>(() => ({
  accountLines: extras.value.accounts ? props.details.accountLines : [],
  tagLine: extras.value.tags ? props.details.tagLine : '',
  beanLines: extras.value.bean ? props.details.beanLines : [],
  preciseTime: extras.value.preciseTime ? props.details.preciseTime : '',
}))

const activeData = computed<ShareReceiptData>(() => ({
  ...props.data,
  extras: { ...extras.value },
}))

const fileName = computed(() => shareReceiptFileName(props.data.date))

/** 任一敏感项勾选时提示一次（不是弹窗，不打断）。 */
const sensitiveOn = computed(() => Object.values(extras.value).some((v) => v))

function report(message: string, tone: 'ok' | 'err' = 'ok'): void {
  notice.value = message
  noticeTone.value = tone
}

function revoke(url: string): void {
  if (url !== '') {
    URL.revokeObjectURL(url)
  }
}

/** 生成图片：canvas 全程在本地，无网络、无后端。 */
async function generate(): Promise<Blob | null> {
  const canvas = canvasRef.value
  if (canvas === null) {
    return null
  }
  const lines = collectShareLines(activeData.value, activeDetails.value)
  const height = receiptHeight(lines, activeDetails.value)
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  const ctx = setupReceiptCanvas(canvas, height, dpr)
  if (ctx === null) {
    return null
  }
  // 作用域 token（.rs-mask, .slip）需从带类的祖先读；读不到时画布函数自带颜色名回退。
  const scope = canvas.closest('.slip') ?? canvas
  const style = typeof window === 'undefined'
    ? ({} as CSSStyleDeclaration)
    : window.getComputedStyle(scope as Element)
  drawShareReceipt(ctx, activeData.value, lines, activeDetails.value, readReceiptPalette(style))
  return exportReceiptBlob(canvas)
}

async function rebuild(): Promise<void> {
  busy.value = true
  report('')
  try {
    const blob = await generate()
    if (blob === null) {
      report('生成失败，可试试「复制文字小票」', 'err')
      return
    }
    revoke(previewUrl.value)
    previewUrl.value = URL.createObjectURL(blob)
  } finally {
    busy.value = false
  }
}

async function saveToAlbum(): Promise<void> {
  const blob = await generate()
  if (blob === null) {
    report('生成失败，可试试「复制文字小票」', 'err')
    return
  }
  // iOS 14 无 showSaveFilePicker / 写相册 API：用 <a download> 触发长按保存路径。
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName.value
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => revoke(url), 1000)
  report('已触发保存；iOS 可在弹出的图片上长按存相册')
}

async function systemShare(): Promise<void> {
  // 先判能力再生成，避免能力不足时白等 Canvas 生成（也更省电）。
  const probe: ShareData = { files: [], title: 'FamBean 记账小票' }
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
    report('当前浏览器不支持图片分享，请用「保存到相册」', 'err')
    return
  }
  const blob = await generate()
  if (blob === null) {
    report('生成失败，可试试「复制文字小票」', 'err')
    return
  }
  const file = new File([blob], fileName.value, { type: 'image/png' })
  const shareData: ShareData = { files: [file], title: 'FamBean 记账小票', text: 'FamBean 记账小票' }
  if (!navigator.canShare(shareData)) {
    report('当前浏览器不支持图片分享，请用「保存到相册」', 'err')
    return
  }
  try {
    await navigator.share(shareData)
    report('已分享')
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return
    }
    report('系统分享未完成，请用「保存到相册」', 'err')
  }
}

async function copyText(): Promise<void> {
  const lines = collectShareLines(activeData.value, activeDetails.value)
  const text = [
    `FamBean · ${activeData.value.kindLabel}`,
    `${activeData.value.amountText}`,
    ...lines.map((line) => `${line.label}：${line.value}`),
    activeData.value.stamp,
  ].join('\n')
  try {
    await navigator.clipboard.writeText(text)
    report('文字小票已复制')
  } catch {
    report('复制失败，请手动长按预览图保存', 'err')
  }
}

watch([extras, () => props.data, () => props.details], () => {
  void rebuild()
}, { deep: true, immediate: true })

defineExpose({ generate, rebuild })
</script>

<template>
  <div class="shr" role="dialog" aria-modal="true" aria-label="分享小票">
    <div class="shr__head">
      <strong>生成分享图</strong>
      <button type="button" class="shr__close" aria-label="关闭分享图" @click="emit('close')">✕</button>
    </div>

    <p class="shr__safe">默认只含金额、类型、日期和分类展示名；敏感信息需主动勾选。</p>

    <div class="shr__preview">
      <img v-if="previewUrl !== ''" :src="previewUrl" alt="小票分享图预览" />
      <p v-else class="shr__loading">{{ busy ? '正在生成预览…' : '预览生成失败' }}</p>
      <!-- 离屏画布：只做生成，不显示；放置 .slip 作用域祖先以便读取纸面色板 token -->
      <div class="shr__scope slip">
        <canvas ref="canvasRef" class="shr__canvas" aria-hidden="true"></canvas>
      </div>
    </div>

    <p v-if="sensitiveOn" class="shr__warn" role="status">已包含敏感信息，发给信任的人。</p>

    <div class="shr__options">
      <label v-for="item in EXTRA_ITEMS" :key="item.key" class="shr__option">
        <input v-model="extras[item.key]" type="checkbox" />
        <span>{{ item.label }}</span>
        <small>{{ item.hint }}</small>
      </label>
    </div>

    <p v-if="notice !== ''" class="shr__notice" :class="{ 'shr__notice--err': noticeTone === 'err' }" role="status">
      {{ notice }}
    </p>

    <div class="shr__actions">
      <button type="button" class="shr__btn" :disabled="busy" @click="copyText">复制文字小票</button>
      <button type="button" class="shr__btn" :disabled="busy" @click="systemShare">系统分享</button>
      <button type="button" class="shr__btn shr__btn--primary" :disabled="busy" @click="saveToAlbum">保存到相册</button>
    </div>
  </div>
</template>

<style scoped>
.shr { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 70; display: flex; flex-direction: column; padding: 20px 16px calc(20px + env(safe-area-inset-bottom, 0px)); background: var(--fb-bg); overflow-y: auto; }
.shr__head { display: flex; align-items: center; justify-content: space-between; }
.shr__head strong { font-size: 15px; }
.shr__close { min-width: 44px; min-height: 44px; border: none; background: transparent; color: var(--fb-ink); font-size: 18px; font-family: inherit; cursor: pointer; }
.shr__safe { margin: 8px 0 0; font-size: 11px; line-height: 1.6; color: var(--fb-sub); }
.shr__preview { display: flex; justify-content: center; margin-top: 12px; }
.shr__preview img { display: block; max-width: 100%; max-height: 52vh; object-fit: contain; }
.shr__loading { padding: 40px 20px; font-size: 12px; color: var(--fb-sub); }
.shr__scope { position: absolute; left: -9999px; top: 0; pointer-events: none; }
.shr__canvas { display: block; }
.shr__warn { margin: 10px 0 0; padding: 8px 12px; border-radius: var(--fb-radius-input); background: var(--fb-warn-soft); color: var(--fb-warn-ink); font-size: 11px; text-align: center; }
.shr__options { margin-top: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.shr__option { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border: 1px solid var(--fb-line); border-radius: var(--fb-radius-input); font-size: 12px; }
.shr__option small { margin-left: auto; font-size: 10px; color: var(--fb-sub); }
.shr__notice { margin: 10px 0 0; font-size: 11px; color: var(--fb-green-ink); }
.shr__notice--err { color: var(--fb-danger); }
.shr__actions { margin-top: auto; padding-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
.shr__btn { flex: 1; min-width: 96px; min-height: 44px; border: 1px solid var(--fb-line); border-radius: var(--fb-radius-input); background: var(--fb-paper); color: var(--fb-ink); font-family: inherit; font-size: 12px; cursor: pointer; }
.shr__btn:disabled { opacity: 0.5; cursor: default; }
.shr__btn--primary { border-color: var(--fb-blue); background: var(--fb-blue); color: var(--fb-white); }
</style>
