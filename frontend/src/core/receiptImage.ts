/**
 * 分享图数据：只收「显示串」，不收原始金额 / bean 源串。
 *
 * 设计前提（安全）：调用方必须先把金额经 formatMoney + 隐私开关算成
 * `amountText` 再传进来；本模块与画布层永远拿不到未遮挡的原始金额，
 * 从根上杜绝「主金额遮住了、分享图却把真值画出去」。
 */
export interface ShareReceiptData {
  /** 已格式化的金额显示串（含符号与币种；隐私遮挡时为 ••••••）。 */
  amountText: string
  /** 类型徽标：支出 EXPENSE / 收入 INCOME / 转账 TRANSFER。 */
  kindLabel: string
  /** 日期（到日，YYYY-MM-DD）。 */
  date: string
  /** 收款方 / 分类展示名（安全字段，来自可见账目而非内部科目）。 */
  payee: string
  /** 印章主文案（默认分享图用中性文案「已记账」）。 */
  stamp: string
  /** 展示给收图人的附加明细，默认全部关闭。 */
  extras: ShareReceiptExtras
}

export interface ShareReceiptExtras {
  /** 完整账户名（泄露科目体系，默认关）。 */
  accounts: boolean
  /** 标签备注（常含人名地点，默认关）。 */
  tags: boolean
  /** Beancount 片段（默认关）。 */
  bean: boolean
  /** 精确时间到秒（默认关，只到日）。 */
  preciseTime: boolean
}

/** 票面扩展内容：只有对应 extras 开关打开时才传给画布；值本身由调用方按需拼好。 */
export interface ShareReceiptDetails {
  accountLines: string[]
  tagLine: string
  beanLines: string[]
  preciseTime: string
}

export const DEFAULT_EXTRAS: ShareReceiptExtras = {
  accounts: false,
  tags: false,
  bean: false,
  preciseTime: false,
}

export const EMPTY_DETAILS: ShareReceiptDetails = {
  accountLines: [],
  tagLine: '',
  beanLines: [],
  preciseTime: '',
}

/** 分享图的票面行（已经过脱敏筛选，画布只负责排版）。 */
export interface ShareReceiptLine {
  label: string
  value: string
}

/**
 * 把分享数据整理成画布要画的行：默认只有日期 / 分类展示名两行；
 * 每个敏感字段都必须在 extras 里显式打开才会出现。
 */
export function collectShareLines(
  data: ShareReceiptData,
  details: ShareReceiptDetails,
): ShareReceiptLine[] {
  const lines: ShareReceiptLine[] = [
    { label: '日期', value: data.date },
    { label: '分类', value: data.payee },
  ]
  if (data.extras.preciseTime && details.preciseTime !== '') {
    lines.push({ label: '时间', value: details.preciseTime })
  }
  if (data.extras.tags && details.tagLine !== '') {
    lines.push({ label: '标签', value: details.tagLine })
  }
  if (data.extras.accounts) {
    for (const account of details.accountLines) {
      lines.push({ label: '账户', value: account })
    }
  }
  return lines
}
