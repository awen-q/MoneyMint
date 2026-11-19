/**
 * `accountApi.list` 的 includeClosed 契约：
 *
 * - **默认不带 `include_closed`**：7+ 处既有调用依赖「缺省只返未关户」，
 *   一旦默认值变了，记账账户选择器就可能列出已关户账户；
 * - 只有显式 `{ includeClosed: true }` 才追加该参数（资产页 / 账户管理用）。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { accountApi, setFetchImplementation, setLedgerId } from './client'

interface Call {
  url: string
}

let calls: Call[] = []

function stub(): void {
  calls = []
  setFetchImplementation(async (url: string) => {
    calls.push({ url })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ accounts: [] }),
    } as unknown as Response
  })
}

beforeEach(() => {
  // 业务请求要求带 X-Ledger-Id，否则客户端会在发请求前就抛错
  setLedgerId(7)
  stub()
})

describe('accountApi.list：includeClosed', () => {
  it('默认不带 include_closed（缺省只返未关户）', async () => {
    await accountApi.list()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).not.toContain('include_closed')
  })

  it('显式 false 与不传等价', async () => {
    await accountApi.list({ includeClosed: false })
    expect(calls[0].url).not.toContain('include_closed')
  })

  it('显式 true 才追加 include_closed', async () => {
    await accountApi.list({ includeClosed: true })
    expect(calls[0].url).toContain('include_closed=1')
  })
})
