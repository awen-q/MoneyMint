/**
 * 标签原地更新 P0 —— API 契约用例。
 *
 * 对齐 system_design.md §2.1 / §2.2：
 * - PUT /api/transactions/{uuid}/tags 的 URL / 方法 / X-Ledger-Id / X-CSRF / body；
 * - 200 响应逐字段回显，前端以回显 tags 为准；
 * - 409 txn_tags_conflict 的 current_tags / current_tags_updated_at 落在 ApiError.details；
 * - 400 txn_tags_invalid、403 txn_edit_forbidden 等统一走 ApiError.code；
 * - GET /api/transactions/{uuid}/tag-edits 只读审计（viewer 可读，仍属业务端点）。
 *
 * 硬边界：本端点与整包 PATCH /api/transactions/{uuid} 物理隔离，
 * 用例断言 PATCH 路径一次都没被碰到。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from './errors'
import { API_ROUTES } from './routes'
import {
  setFetchImplementation,
  setLedgerId,
  transactionApi,
} from './client'

interface FetchCall {
  url: string
  init: RequestInit
  body: unknown
}

let calls: FetchCall[] = []
let status = 200
let payload: unknown = {}

function makeResponse(code: number, body: unknown): Response {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    ok: code >= 200 && code < 300,
    status: code,
    headers: new Headers(),
    text: async () => text,
  } as unknown as Response
}

/** 统一把 rejected Promise 收窄成 ApiError，避免 `.catch` 回归联合类型。 */
async function expectApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof ApiError) {
      return err
    }
    throw err
  }
  throw new Error('expected an ApiError rejection, but the promise resolved')
}

function stub(): void {
  calls = []
  status = 200
  payload = {}
  setFetchImplementation(async (url: string, init: RequestInit) => {
    const raw = init.body
    let body: unknown = undefined
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw) as unknown
      } catch {
        body = raw
      }
    }
    calls.push({ url, init, body })
    return makeResponse(status, payload)
  })
}

beforeEach(() => {
  setLedgerId(7)
  stub()
})

afterEach(() => {
  setFetchImplementation(null)
  vi.unstubAllGlobals()
})

const UUID = 'txn-0001'
const EDIT_RESPONSE = {
  uuid: UUID,
  tags: ['餐饮', '周末'],
  tags_updated_at: '2026-11-27T09:31:12.345Z',
  edit_id: 42,
}

describe('transactionApi.updateTags：PUT /api/transactions/{uuid}/tags', () => {
  it('路径、方法、X-CSRF、X-Ledger-Id 与请求体逐字段对齐契约', async () => {
    payload = EDIT_RESPONSE
    const result = await transactionApi.updateTags(UUID, {
      tags: ['餐饮', '周末'],
      base_tags: ['餐饮'],
      device_id: 'dev-iphone-01',
    })

    expect(result).toEqual(EDIT_RESPONSE)
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call.url).toBe(`/api/transactions/${UUID}/tags`)
    expect(call.init.method).toBe('PUT')
    const headers = call.init.headers as Record<string, string>
    expect(headers['X-CSRF']).toBe('1')
    expect(headers['X-Ledger-Id']).toBe('7')
    expect(headers['Content-Type']).toBe('application/json')
    expect(call.body).toEqual({
      tags: ['餐饮', '周末'],
      base_tags: ['餐饮'],
      device_id: 'dev-iphone-01',
    })
    // 绝不误调经济事实的整包 PATCH 端点。
    expect(call.url).not.toContain(API_ROUTES.transactionByUuid)
  })

  it('device_id 可选：缺省时不发明键，tags 可为 []（清空）', async () => {
    payload = { ...EDIT_RESPONSE, tags: [] }
    const result = await transactionApi.updateTags(UUID, { tags: [], base_tags: ['餐饮'] })

    expect(result.tags).toEqual([])
    expect(calls[0].body).toEqual({ tags: [], base_tags: ['餐饮'] })
    expect(JSON.stringify(calls[0].body)).not.toContain('device_id')
  })

  it('409 txn_tags_conflict：code 与 current_tags / current_tags_updated_at 落到 details', async () => {
    status = 409
    payload = {
      error: '标签已被他人更新',
      code: 'txn_tags_conflict',
      current_tags: ['餐饮', '孩子'],
      current_tags_updated_at: '2026-11-27T10:00:00.000Z',
    }

    const err = await expectApiError(
      transactionApi.updateTags(UUID, { tags: ['餐饮'], base_tags: ['旧'] }),
    )
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(409)
    expect(err.code).toBe('txn_tags_conflict')
    expect(err.details?.current_tags).toEqual(['餐饮', '孩子'])
    expect(err.details?.current_tags_updated_at).toBe('2026-11-27T10:00:00.000Z')
  })

  it('400 txn_tags_invalid / 403 txn_edit_forbidden 保持统一错误通道', async () => {
    status = 400
    payload = { error: '标签不合法', code: 'txn_tags_invalid' }
    const invalid = await expectApiError(
      transactionApi.updateTags(UUID, { tags: ['x'.repeat(65)], base_tags: [] }),
    )
    expect(invalid.code).toBe('txn_tags_invalid')
    expect(invalid.status).toBe(400)

    status = 403
    payload = { error: '无权修改', code: 'txn_edit_forbidden' }
    const forbidden = await expectApiError(
      transactionApi.updateTags(UUID, { tags: [], base_tags: [] }),
    )
    expect(forbidden.code).toBe('txn_edit_forbidden')
    expect(forbidden.status).toBe(403)
  })

  it('缺少账本 id 时零 fetch 直接抛 ledger_id_required', async () => {
    setLedgerId(null)
    await expect(
      transactionApi.updateTags(UUID, { tags: [], base_tags: [] }),
    ).rejects.toMatchObject({ code: 'ledger_id_required', status: 0 })
    expect(calls).toHaveLength(0)
  })
})

describe('transactionApi.listTagEdits：GET /api/transactions/{uuid}/tag-edits', () => {
  it('路径 / 方法 / 账本头对齐，响应 edits 逐条透出', async () => {
    payload = {
      edits: [
        {
          id: 42,
          action: 'replace',
          old_tags: ['餐饮'],
          new_tags: ['餐饮', '周末'],
          actor_id: 7,
          actor_name: '张伟',
          device_id: 'dev-iphone-01',
          ts: '2026-11-27T09:31:12.345Z',
        },
      ],
    }

    const result = await transactionApi.listTagEdits(UUID)
    expect(result.edits).toHaveLength(1)
    expect(result.edits[0]).toMatchObject({
      id: 42,
      action: 'replace',
      old_tags: ['餐饮'],
      new_tags: ['餐饮', '周末'],
      actor_id: 7,
      actor_name: '张伟',
      device_id: 'dev-iphone-01',
      ts: '2026-11-27T09:31:12.345Z',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`/api/transactions/${UUID}/tag-edits`)
    expect(calls[0].init.method).toBe('GET')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['X-Ledger-Id']).toBe('7')
    // GET 是安全方法，不带 X-CSRF。
    expect(headers['X-CSRF']).toBeUndefined()
  })

  it('viewer 可读（只读端点）：404 也走统一 ApiError', async () => {
    status = 404
    payload = { error: '交易不存在', code: 'txn_not_found' }
    await expect(transactionApi.listTagEdits(UUID)).rejects.toMatchObject({
      status: 404,
      code: 'txn_not_found',
    })
  })
})
