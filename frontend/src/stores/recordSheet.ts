/**
 * 记一笔面板的跨视图开关（C-01 单组件、单实例）
 *
 * 首页与布局都要打开同一个 RecordSheet，用 store 收敛状态，避免各自挂载
 * 多个实例重复加载账户；保存成功后用 savedEpoch 通知首页刷新余额与流水。
 * 0.6.0 S6：新增编辑态（openEdit）——RecordSheet 复用同一表单对既有交易
 * 做「冲正 + 新建」修改；editingTxn 非空即编辑态，关闭时清空。
 */
import { ref } from 'vue'
import { defineStore } from 'pinia'

import type { TransactionCreateResult } from '@/api/client'
import type { TransactionView } from '@/api/types'

export const useRecordSheetStore = defineStore('recordSheet', () => {
  const isOpen = ref(false)
  const savedEpoch = ref(0)
  const lastSaved = ref<TransactionCreateResult | null>(null)
  /** 非空 = 编辑态（修改该交易；0.6.0 S6）。新建入口 open() 会清空。 */
  const editingTxn = ref<TransactionView | null>(null)

  function open(): void {
    editingTxn.value = null
    isOpen.value = true
  }

  /** 打开编辑态（修改既有交易）；传入列表透出的交易视图（含 uuid/can_edit）。 */
  function openEdit(txn: TransactionView): void {
    editingTxn.value = txn
    isOpen.value = true
  }

  function close(): void {
    isOpen.value = false
    editingTxn.value = null
  }

  function notifySaved(result: TransactionCreateResult): void {
    lastSaved.value = result
    // 纯计数器（非金额运算），供首页 watch 后重新加载数据。
    savedEpoch.value = savedEpoch.value + 1
  }

  /** 编辑保存成功：不产生新建结果，仅推进 savedEpoch 让列表/详情刷新。 */
  function notifyChanged(): void {
    savedEpoch.value = savedEpoch.value + 1
  }

  return {
    isOpen,
    savedEpoch,
    lastSaved,
    editingTxn,
    open,
    openEdit,
    close,
    notifySaved,
    notifyChanged,
  }
})
