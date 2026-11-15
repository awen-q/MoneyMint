/**
 * M2 API 客户端契约：multipart 上传（恢复）与 JSON 文本体（导入）。
 *
 * 关键点：FormData 不得被 JSON.stringify，也不得手动设置 Content-Type
 * （浏览器需要自动生成带 boundary 的头）；导入走 JSON {"text"} + ?target=；
 * 0.6.0 S5 起导入不再在例外清单内：必须带 X-Ledger-Id（restore / db 仍豁免）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  importApi,
  restoreApi,
  setFetchImplementation,
  setLedgerId,
  type FetchLike,
} from './client'

interface FetchCall {
  url: string
  init: RequestInit
}

function makeResponse(status = 200, body: unknown = {}): Response {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (): string | null => null,
    },
    text: async () => text,
    blob: async () => new Blob([text]),
  } as unknown as Response
}

let calls: FetchCall[] = []

beforeEach(() => {
  setFetchImplementation(null)
  setLedgerId(null) // restore 在例外清单内；若误注入会因缺账本上下文抛错，正好当断言用
  calls = []
})

afterEach(() => {
  setFetchImplementation(null)
})

function install(): void {
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return makeResponse()
  }
  setFetchImplementation(impl)
}

describe('M2-G：restoreApi multipart 契约', () => {
  it('preview：body 是 FormData（含 file 字段），未注入 X-Ledger-Id，未手写 Content-Type', async () => {
    install()
    const file = new File(['sqlite'], 'backup.db')
    const p = restoreApi.preview(file)
    // requestWithMeta 在首个 await 前同步执行：fetch 已被调用、头已构建。
    expect(calls.length).toBe(1)
    await p

    const { url, init } = calls[0]
    expect(url).toBe('/api/backup/restore/preview')
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.body as FormData).get('file')).toBeInstanceOf(File)
    const headers = init.headers as unknown as Record<string, string>
    expect(headers['X-CSRF']).toBe('1')
    expect(headers['Content-Type']).toBeUndefined()
    expect(headers['X-Ledger-Id']).toBeUndefined()
  })

  it('execute：FormData 同时携带 file 与 confirm 确认词', async () => {
    install()
    const file = new File(['sqlite'], 'backup.db')
    const p = restoreApi.execute(file, 'RESTORE')
    expect(calls.length).toBe(1)
    await p

    const { init } = calls[0]
    expect(init.body).toBeInstanceOf(FormData)
    const form = init.body as FormData
    expect(form.get('confirm')).toBe('RESTORE')
    expect(form.get('file')).toBeInstanceOf(File)
  })
})

describe('M2-G：importApi JSON 契约（0.6.0 S5）', () => {
  it('preview/execute：JSON {"text"} + ?target=，强制注入 X-Ledger-Id', async () => {
    install()
    setLedgerId(7)
    const p1 = importApi.preview('option "title" "x"', 'current')
    expect(calls.length).toBe(1)
    await p1

    expect(calls[0].url).toBe('/api/import/beancount/preview?target=current')
    expect(calls[0].init.body).toBe(JSON.stringify({ text: 'option "title" "x"' }))
    expect((calls[0].init.headers as unknown as Record<string, string>)['X-Ledger-Id']).toBe('7')

    await importApi.execute('2026-01-01 open Assets:Cash', 'new')
    expect(calls[1].url).toBe('/api/import/beancount?target=new')
    expect(calls[1].init.body).toBe(JSON.stringify({ text: '2026-01-01 open Assets:Cash' }))
    expect((calls[1].init.headers as unknown as Record<string, string>)['X-Ledger-Id']).toBe('7')
  })

  it('undo：?batch_id= 携带批次标识，同样注入 X-Ledger-Id', async () => {
    install()
    setLedgerId(7)
    await importApi.undo('imp-abc')
    expect(calls[0].url).toBe('/api/import/beancount/undo?batch_id=imp-abc')
    expect((calls[0].init.headers as unknown as Record<string, string>)['X-Ledger-Id']).toBe('7')
  })

  it('缺账本上下文直接抛错，绝不静默回退（E-08）', async () => {
    install()
    setLedgerId(null)
    await expect(importApi.preview('x', 'current')).rejects.toMatchObject({ code: 'ledger_id_required' })
    expect(calls.length).toBe(0)
  })
})
