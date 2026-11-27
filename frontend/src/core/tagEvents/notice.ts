/**
 * 标签合并一次性通知（P1，非阻断）。
 *
 * 模块级订阅 / 发布：reconciler 与 store 只 publish，AppLayout 的
 * TagMergeToast.vue 与详情页提示行只 subscribe。所有消息都是 `role=status`
 * 语义——不弹模态、不阻断记账、不需要用户点击确认。
 *
 * key 去重保证 「409 重试 + pull 重放」 的多条信号只提示一次；
 * 4s 自动消失由 Toast 组件负责（本模块不持有计时器）。
 */
import { t } from '@/i18n'

export interface MergeNotice {
  /** 去重键（同一批次 / 同一意图只提示一次）。 */
  key: string
  title: string
  body: string
  /** 编辑记录面板浅色提示行；空串表示该通知不落面板。 */
  noticeLine: string
  conflictCount: number
}

const listeners = new Set<(notice: MergeNotice) => void>()
const delivered = new Set<string>()

/** 发布一条非阻断提示；同 key 重复发布返回 false（不打扰用户）。 */
export function publishMergeNotice(notice: MergeNotice): boolean {
  if (delivered.has(notice.key)) {
    return false
  }
  delivered.add(notice.key)
  for (const listener of listeners) {
    listener(notice)
  }
  return true
}

/** 订阅提示；返回取消订阅函数。 */
export function subscribeMergeNotice(listener: (notice: MergeNotice) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 测试用：清空去重集合，使同一 key 可以再次提示。 */
export function resetMergeNotices(): void {
  delivered.clear()
}

/** 离线保存：一次性提示联网后自动合并。 */
export function notifyOfflineSaved(uuid: string, at = Date.now()): void {
  publishMergeNotice({
    key: `offline:${uuid}:${at}`,
    title: t('tagEdit.offlineSaved'),
    body: '',
    noticeLine: '',
    conflictCount: 0,
  })
}

/** 合并成功：conflictCount>0 时同时在编辑记录面板落一行浅色提示。 */
export function notifyMergeSuccess(key: string, conflictCount: number): void {
  publishMergeNotice({
    key: `merged:${key}`,
    title: t('tagEdit.mergeToastTitle'),
    body: t('tagEdit.mergeToastBody'),
    noticeLine:
      conflictCount > 0
        ? t('tagEdit.mergeNoticeLine', { n: String(conflictCount) })
        : '',
    conflictCount,
  })
}

/** 409×3 仍失败：保留事件，下次同步自动重试。 */
export function notifyMergeRetryLater(key: string): void {
  publishMergeNotice({
    key: `retry:${key}`,
    title: t('tagEdit.mergeRetryLater'),
    body: '',
    noticeLine: '',
    conflictCount: 0,
  })
}

/** 不可恢复错误（冲正 / 无权限 / 404）：保留事件并提示需人工处理。 */
export function notifyMergeDropped(key: string): void {
  publishMergeNotice({
    key: `dropped:${key}`,
    title: t('tagEdit.mergeDropped'),
    body: '',
    noticeLine: '',
    conflictCount: 0,
  })
}
