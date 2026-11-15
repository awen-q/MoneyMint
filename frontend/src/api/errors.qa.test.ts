/**
 * QA 独立回归：稳定错误码字典与前端文案映射（设计 §5.1 / §5.2 / E 部分）。
 *
 * 与工程师用例不同：19 个稳定码清单直接抄自 docs/0.5.2-design.md §5.1
 * （权威口径），**不读取被测源码自己列出的清单**，避免「自己证明自己」；
 * 同时独立断言文案中文、未知码回退、DEAD_CODES 不混入在线错误码、
 * ApiError 不把 HTTP 原文甩给用户。
 */
import { describe, expect, it } from 'vitest'

import { ApiError, codeMessage } from './errors'
import { DEAD_CODES } from '@/core/sync/models'
import type { LocalTxn } from '@/core/sync/models'

/** 设计 §5.1 稳定错误码字典：0.6.0 新增 19 个（逐字抄录，不来自被测代码）。 */
const STABLE_CODES_060: readonly string[] = [
  'ledger_has_members',
  'last_ledger',
  'ledger_deleted',
  'account_name_invalid',
  'account_name_exists',
  'parent_not_found',
  'parent_type_mismatch',
  'commodity_exists',
  'commodity_in_use',
  'balance_date_invalid',
  'balance_date_too_early',
  'opening_equity_closed',
  'txn_edit_forbidden',
  'txn_not_editable',
  'txn_already_reversed',
  'import_pad_balance_unsupported',
  'import_unbalanced',
  'import_account_conflict',
  'import_batch_not_found',
]

/** 0.5.1 及更早的既有在线码，也必须在同一张表里（同源镜像，不硬编码到各页面）。 */
const LEGACY_ONLINE_CODES: readonly string[] = [
  'account_not_found',
  'account_closed',
  'account_balance_not_zero',
  'account_open_date_after_ledger',
  'opening_conflict',
  'opening_via_api_only',
  'opening_amount_invalid',
  'opening_direction_invalid',
  'opening_commodity_mismatch',
  'opening_account_not_openable',
  'opening_date_mismatch',
  'ledger_opening_date_invalid',
  'ledger_opening_date_after_first_txn',
  'idempotency_key_deleted',
  'idempotency_payload_mismatch',
  'csrf_required',
]

const CJK = /[一-鿿]/

describe('E：19 个稳定错误码与 codeMessage() 逐一对齐', () => {
  it('清单恰为 19 个，且每个都有非空中文文案', () => {
    expect(STABLE_CODES_060.length).toBe(19)
    for (const code of STABLE_CODES_060) {
      const msg = codeMessage(code)
      expect(msg, `缺少 ${code} 的映射`).not.toBe('')
      expect(CJK.test(msg), `${code} 文案应为中文，实际 ${msg}`).toBe(true)
    }
  })

  it('既有在线码也在同一张表，无遗漏、无拼写错', () => {
    for (const code of LEGACY_ONLINE_CODES) {
      expect(codeMessage(code), `缺少既有码 ${code}`).not.toBe('')
    }
  })

  it('未知码返回空串，调用方回退 ApiError.message（不把 code 当文案展示）', () => {
    expect(codeMessage('no_such_code_qa')).toBe('')
    expect(codeMessage('')).toBe('')
    const err = ApiError.fromBody(500, { error: '后端可读原因', code: 'no_such_code_qa' })
    expect(err.message).toBe('后端可读原因')
    expect(err.code).toBe('no_such_code_qa')
  })

  it('ApiError 不把 HTTP 500 原文/英文报错当作文案抛出', () => {
    const fallback = ApiError.fromBody(500, {})
    expect(fallback.message).toBe('HTTP 500')
    expect(codeMessage(fallback.code ?? '')).toBe('')
  })

  it('在线错误码未混入 DEAD_CODES（它们不产生于 sync/push 路径）', () => {
    const onlineOnly = [
      'txn_already_reversed',
      'txn_edit_forbidden',
      'txn_not_editable',
      'opening_equity_closed',
      'ledger_has_members',
      'last_ledger',
      'ledger_deleted',
      'import_pad_balance_unsupported',
      'import_unbalanced',
      'import_account_conflict',
      'import_batch_not_found',
    ]
    for (const code of onlineOnly) {
      expect(DEAD_CODES.includes(code), `${code} 不应进入 DEAD_CODES`).toBe(false)
    }
  })

  it('删除类错误走 codeMessage 映射得到可读中文，而非裸码', () => {
    expect(codeMessage('ledger_has_members')).toContain('成员')
    expect(codeMessage('last_ledger')).toContain('不能删除')
    expect(codeMessage('ledger_deleted')).toContain('已删除')
  })
})

describe('A-02：LocalTxn.reversed_by? 存在且不影响既有字段', () => {
  it('可选字段可缺省、可携带，既有字段保持原样', () => {
    const base: LocalTxn = {
      uuid: 'txn-qa-1',
      date: '2026-11-01',
      flag: '*',
      description: '早餐',
      tags: ['food'],
      postings: [{ account_uuid: 'acc-1', commodity: 'CNY', amount: '-1.00' }],
    }
    expect(base.reversed_by).toBeUndefined()
    const marked: LocalTxn = { ...base, reversed_by: 'rev-qa-1' }
    expect(marked.reversed_by).toBe('rev-qa-1')
    expect(marked.description).toBe('早餐')
    expect(marked.tags).toEqual(['food'])
    expect(marked.postings.length).toBe(1)
  })
})
