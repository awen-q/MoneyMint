<script setup lang="ts">
/**
 * 「关于 FamBean」卡片（设置页内，移动端与 PC 共用）。
 *
 * 展示版本 + 构建号 + 构建日期，并支持一键复制整段文本给家人报 bug；
 * 预发布号打轻量角标，不弹窗、不横幅，不打扰日常记账。
 * 数据全部来自构建期常量，离线可读。
 */
import { ref } from 'vue'

import {
  APP_VERSION,
  isPrerelease,
  shortVersion,
  versionCopyText,
  type VersionInfo,
} from '@/core/appVersion'

const props = withDefaults(defineProps<{ info?: VersionInfo }>(), {
  info: () => APP_VERSION,
})

const copied = ref(false)
const failed = ref(false)

async function copy(): Promise<void> {
  copied.value = false
  failed.value = false
  try {
    await navigator.clipboard.writeText(versionCopyText(props.info))
    copied.value = true
  } catch {
    // HTTP / 未授权环境没有 clipboard 权限：给出可操作的提示，不静默失败。
    failed.value = true
  }
}
</script>

<template>
  <div class="av">
    <div class="av__head">
      <strong>关于 FamBean</strong>
      <em v-if="isPrerelease(info.version)" class="av__badge">预览版</em>
    </div>

    <p class="av__version">{{ shortVersion(info) }}</p>

    <dl class="av__meta">
      <dt>构建号</dt>
      <dd>{{ info.buildHash }}</dd>
      <dt>构建日期</dt>
      <dd>{{ info.buildDate }}</dd>
    </dl>

    <button class="av__copy" type="button" @click="copy">
      {{ copied ? '已复制' : '复制版本信息' }}
    </button>
    <p v-if="failed" class="av__failed" role="alert">复制失败，请手动选择上方文本</p>
  </div>
</template>

<style scoped>
.av__head { display: flex; align-items: center; gap: 8px; }
.av__head strong { font-size: 13px; }
.av__badge { padding: 3px 9px; border-radius: var(--fb-radius-pill); background: var(--fb-warn-soft); color: var(--fb-warn-ink); font-size: 11px; font-style: normal; }
.av__version { margin: 10px 0 0; font-size: 18px; font-weight: 700; font-variant-numeric: var(--fb-font-numeric); }
.av__meta { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 8px 0 0; font-size: 12px; font-variant-numeric: var(--fb-font-numeric); }
.av__meta dt { color: var(--fb-sub); }
.av__meta dd { margin: 0; text-align: right; }
.av__copy { margin-top: 10px; padding: 7px 12px; border: none; border-radius: var(--fb-radius-input); background: var(--fb-blue-soft); color: var(--fb-blue); font-family: inherit; font-size: 12px; cursor: pointer; }
.av__copy:focus-visible { outline: 2px solid var(--fb-blue); outline-offset: 2px; }
.av__failed { margin: 8px 0 0; font-size: 11px; color: var(--fb-danger); }
</style>
