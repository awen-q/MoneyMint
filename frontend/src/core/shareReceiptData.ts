/**
 * 小票 → 分享图的数据组装（单一口径，成功页与详情页共用）。
 *
 * 安全要点：
 * - 金额在这里就经 privacy 开关 + formatMoney 算成显示串，画布层只拿显示串；
 * - 印章一律中性「已记账」，不暴露「待同步 / 幂等命中」等内部状态；
 * - 敏感明细（bean / 完整账户 / 标签 / 精确时间）只放内容、默认开关全关，
 *   由用户在预览面板主动勾选才进画布。
 */
import { formatMoney } from './Money'
import { PRIVACY_MASK } from './privacy'
import {
  DEFAULT_EXTRAS,
  EMPTY_DETAILS,
  type ShareReceiptData,
  type ShareReceiptDetails,
} from './receiptImage'

export interface ShareSource {
  /** 原始金额（仅在本函数内用于格式化，不传给分享面板）。 */
  amount: string
  commodity: string
  kindLabel: string
  date: string
  /** 分类 / 收款方展示名（安全）。 */
  payee: string
  bean: string
  tags: string[]
  accounts: string[]
  /** 精确时间（到秒）；为空则不提供该选项内容。 */
  preciseTime: string
}

/** 把原始账目数据组装成分享面板 props；金额按隐私开关决定是否为遮挡符。 */
export function buildShareReceipt(
  source: ShareSource,
  privacyEnabled: boolean,
): { data: ShareReceiptData; details: ShareReceiptDetails } {
  const amountText = privacyEnabled
    ? PRIVACY_MASK
    : formatMoney(source.amount, source.commodity, { signed: false })

  return {
    data: {
      amountText,
      kindLabel: source.kindLabel,
      date: source.date,
      payee: source.payee,
      stamp: '已记账',
      extras: { ...DEFAULT_EXTRAS },
    },
    details: {
      accountLines: source.accounts.slice(),
      tagLine: source.tags.join(' '),
      beanLines: source.bean === '' ? [] : source.bean.split('\n'),
      preciseTime: source.preciseTime,
    },
  }
}
