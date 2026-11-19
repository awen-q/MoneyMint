// @vitest-environment jsdom
/**
 * B7 回收站永久删除（前端）：`TrashView.vue` 的入口显隐 / 两级确认 / 手输清空 / 审计区块。
 *
 * 独立于批 2 的基线用例（`TransactionDetailView.s6.test.ts` 里的 can_restore 显隐），
 * 只覆盖 B7 新行为：
 *   ① owner 且有 can_purge → 「⋯」可见；can_purge=false → 无「⋯」但有系统标记；editor 无「⋯」；
 *   ② 「⋯」→ 菜单 → 红色二次确认（含「无法恢复」）；
 *   ③ 确认调用 `purge(uuid, '删除')`，成功后刷新列表；
 *   ④ 409 `txn_purge_not_allowed` → 固定文案且**弹层不关**；
 *   ⑤ 403 `txn_purge_forbidden` → 固定文案；
 *   ⑥ 清空入口：deletable=0 时 disabled；输入「清空」前 disabled、后 enabled；
 *      调用 `purgeTrash('删除')`；
 *   ⑦ 清空弹层三行数字（可删 / 系统保留 / 配对连带）；
 *   ⑧ 审计区块渲染；`purge_log` 缺失时整块隐藏；
 *   ⑨ busy 期间所有入口 disabled（防双击）。
 *
 * 断言只依赖渲染结果与公开 API（transactionApi.*），不触达组件内部状态。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import { ApiError } from '@/api/errors'
import type { PurgeLogEntry, PurgeSummary, TrashItemView } from '@/api/types'
import TrashView from '@/views/TrashView.vue'

const h = vi.hoisted(() => ({
  trash: vi.fn(),
  restore: vi.fn(),
  purge: vi.fn(),
  purgeTrash: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  // 与真实客户端同值：组件用它在请求体里传确认词，测试要断言这个字面量。
  PURGE_CONFIRM_WORD: '删除',
  transactionApi: {
    trash: h.trash,
    restore: h.restore,
    purge: h.purge,
    purgeTrash: h.purgeTrash,
  },
}))

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ ledgerId: 7 }),
}))

/** 一笔回收站记录（默认 owner 视角、可恢复、可永久删除）。 */
function itemFixture(overrides: Partial<TrashItemView> = {}): TrashItemView {
  return {
    uuid: 'txn-1',
    date: '2026-11-01',
    flag: '*',
    description: '已删的早餐',
    tags: [],
    deleted_at: '2026-11-02T10:00:00Z',
    created_by_name: '阿文',
    postings: [],
    can_restore: true,
    ...overrides,
  }
}

function summaryFixture(overrides: Partial<PurgeSummary> = {}): PurgeSummary {
  return { deletable: 1, system_kept: 0, paired: 0, ...overrides }
}

function logFixture(overrides: Partial<PurgeLogEntry> = {}): PurgeLogEntry {
  return {
    uuid: 'gone-1',
    description: '被永久删除的支出',
    amount_note: '-10.00 CNY / 10.00 CNY',
    was_in_trash: true,
    actor_name: '阿文',
    purged_at: '2026-11-03T09:00:00Z',
    ...overrides,
  }
}

/** 装配一次 trash() 的返回值。 */
function trashResponse(
  items: TrashItemView[],
  summary: Partial<PurgeSummary> = {},
  log: PurgeLogEntry[] = [],
): { transactions: TrashItemView[]; purge_summary: PurgeSummary; purge_log: PurgeLogEntry[] } {
  return {
    transactions: items,
    purge_summary: summaryFixture(summary),
    purge_log: log,
  }
}

/** 挂载并等待首屏数据。 */
async function mountTrash(): Promise<VueWrapper> {
  const wrapper = mount(TrashView)
  await flushPromises()
  return wrapper
}

/** 按文案找按钮（Text 精确匹配）。 */
function buttonByText(wrapper: VueWrapper, text: string) {
  return wrapper.findAll('button').find((btn) => btn.text() === text)
}

beforeEach(() => {
  vi.clearAllMocks()
  // SelectSheet 关闭时会 window.scrollTo 还原滚动位置；jsdom 里是空实现且会打印
  // "Not implemented" 噪音，按 SelectSheet.test.ts 的先例替换成 spy。
  Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true, configurable: true })
  h.trash.mockResolvedValue(trashResponse([itemFixture()]))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('B7-A：永久删除入口显隐（服务端 can_purge 为准）', () => {
  it('owner 且 can_purge=true：行尾「⋯」可见，恢复按钮是实心主按钮', async () => {
    h.trash.mockResolvedValue(trashResponse([itemFixture({ can_purge: true })]))
    const wrapper = await mountTrash()

    expect(wrapper.find('[aria-label="更多操作"]').exists()).toBe(true)
    // 规格：恢复按钮由 ghost 改实心主按钮，其余属性不动。
    const restoreBtn = buttonByText(wrapper, '恢复')
    expect(restoreBtn).toBeTruthy()
    expect(restoreBtn?.classes()).toContain('fb-btn-primary')
    wrapper.unmount()
  })

  it('can_purge=false（系统交易）：无「⋯」，但有系统交易标记', async () => {
    h.trash.mockResolvedValue(
      trashResponse([itemFixture({ can_purge: false, is_system: true })], {
        deletable: 0,
        system_kept: 1,
      }),
    )
    const wrapper = await mountTrash()

    expect(wrapper.find('[aria-label="更多操作"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('系统交易 · 不可永久删除')
    wrapper.unmount()
  })

  it('editor（can_purge=false 且非系统）：无「⋯」，也无系统标记', async () => {
    h.trash.mockResolvedValue(
      trashResponse([itemFixture({ can_purge: false, is_system: false })]),
    )
    const wrapper = await mountTrash()

    expect(wrapper.find('[aria-label="更多操作"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('系统交易')
    wrapper.unmount()
  })
})

describe('B7-B：两级确认（菜单 → 红色二次确认）', () => {
  it('「⋯」打开菜单，点「永久删除」进入二次确认且文案含「无法恢复」', async () => {
    h.trash.mockResolvedValue(trashResponse([itemFixture({ can_purge: true })]))
    const wrapper = await mountTrash()

    await wrapper.find('[aria-label="更多操作"]').trigger('click')
    const menuEntry = buttonByText(wrapper, '永久删除')
    expect(menuEntry).toBeTruthy()

    await menuEntry!.trigger('click')
    expect(wrapper.text()).toContain('无法恢复')
    expect(buttonByText(wrapper, '确认永久删除')).toBeTruthy()
    // 二次确认是危险按钮（用全局 --fb-danger，不新建色值）。
    expect(buttonByText(wrapper, '确认永久删除')?.classes()).toContain(
      'trash__sheet-row--danger',
    )
    wrapper.unmount()
  })

  it('有 pair_uuid 时追加「将同时删除冲正配对交易」', async () => {
    h.trash.mockResolvedValue(
      trashResponse([itemFixture({ can_purge: true, pair_uuid: 'rev-1' })]),
    )
    const wrapper = await mountTrash()

    await wrapper.find('[aria-label="更多操作"]').trigger('click')
    await buttonByText(wrapper, '永久删除')!.trigger('click')

    expect(wrapper.text()).toContain('将同时删除冲正配对交易')
    wrapper.unmount()
  })

  it('二次确认取消退回菜单（不直接关闭）', async () => {
    h.trash.mockResolvedValue(trashResponse([itemFixture({ can_purge: true })]))
    const wrapper = await mountTrash()

    await wrapper.find('[aria-label="更多操作"]').trigger('click')
    await buttonByText(wrapper, '永久删除')!.trigger('click')
    await buttonByText(wrapper, '取消')!.trigger('click')

    // 还在菜单一级：仍有「永久删除」入口，且已离开二次确认。
    expect(buttonByText(wrapper, '确认永久删除')).toBeFalsy()
    expect(buttonByText(wrapper, '永久删除')).toBeTruthy()
    wrapper.unmount()
  })
})

describe('B7-C：确认删除的调用形态与成功路径', () => {
  it('确认后调用 purge(uuid, "删除")，成功后刷新列表并提示删除笔数', async () => {
    h.trash.mockResolvedValue(trashResponse([itemFixture({ can_purge: true })]))
    h.purge.mockResolvedValue({
      ok: true,
      count: 1,
      deleted: [{ uuid: 'txn-1', description: '已删的早餐', was_in_trash: true }],
      purged_postings: 2,
    })
    const wrapper = await mountTrash()
    const callsBefore = h.trash.mock.calls.length

    await wrapper.find('[aria-label="更多操作"]').trigger('click')
    await buttonByText(wrapper, '永久删除')!.trigger('click')
    // 删除成功后重新加载：让第二次返回空列表。
    h.trash.mockResolvedValue(trashResponse([]))
    await buttonByText(wrapper, '确认永久删除')!.trigger('click')
    await flushPromises()

    expect(h.purge).toHaveBeenCalledTimes(1)
    expect(h.purge).toHaveBeenCalledWith('txn-1', '删除')
    expect(h.trash.mock.calls.length).toBe(callsBefore + 1)
    expect(wrapper.text()).toContain('已永久删除 1 笔')
    expect(wrapper.text()).toContain('回收站是空的。')
    wrapper.unmount()
  })

  it('already_purged=true 视为成功，提示「这笔交易已被永久删除」', async () => {
    h.trash.mockResolvedValue(trashResponse([itemFixture({ can_purge: true })]))
    h.purge.mockResolvedValue({
      ok: true,
      count: 0,
      deleted: [],
      purged_postings: 0,
      already_purged: true,
    })
    const wrapper = await mountTrash()

    await wrapper.find('[aria-label="更多操作"]').trigger('click')
    await buttonByText(wrapper, '永久删除')!.trigger('click')
    await buttonByText(wrapper, '确认永久删除')!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('这笔交易已被永久删除')
    // 幂等命中不是失败：不出现「失败」字样。
    expect(wrapper.text()).not.toContain('失败')
    wrapper.unmount()
  })
})

describe('B7-D：错误码映射（弹层不关，用户要看到原因）', () => {
  it('409 txn_purge_not_allowed → 固定文案，弹层保持打开', async () => {
    h.trash.mockResolvedValue(trashResponse([itemFixture({ can_purge: true })]))
    h.purge.mockRejectedValue(
      new ApiError(409, '系统生成的交易（期初 / 校准 / 导入批次）不能永久删除', {
        code: 'txn_purge_not_allowed',
      }),
    )
    const wrapper = await mountTrash()

    await wrapper.find('[aria-label="更多操作"]').trigger('click')
    await buttonByText(wrapper, '永久删除')!.trigger('click')
    await buttonByText(wrapper, '确认永久删除')!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('系统生成的交易（期初 / 校准 / 导入批次）不能永久删除')
    // 弹层没关：二次确认按钮仍在，用户可以退回去。
    expect(buttonByText(wrapper, '确认永久删除')).toBeTruthy()
    wrapper.unmount()
  })

  it('403 txn_purge_forbidden → 固定文案「只有账本 owner 可以永久删除」', async () => {
    h.trash.mockResolvedValue(trashResponse([itemFixture({ can_purge: true })]))
    h.purge.mockRejectedValue(
      new ApiError(403, '只有账本 owner 可以永久删除', { code: 'txn_purge_forbidden' }),
    )
    const wrapper = await mountTrash()

    await wrapper.find('[aria-label="更多操作"]').trigger('click')
    await buttonByText(wrapper, '永久删除')!.trigger('click')
    await buttonByText(wrapper, '确认永久删除')!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('只有账本 owner 可以永久删除')
    wrapper.unmount()
  })
})

describe('B7-E：清空回收站（手输「清空」解锁）', () => {
  it('editor（全部 can_purge=false，但 deletable>0）：入口与可删计数都**不渲染**，点不出弹层', async () => {
    // deletable 是数据口径（服务端按闭包算，与角色无关），editor 也可能 >0：
    //   - 只看 deletable → 按钮亮着、点下去必然 403（死路）；
    //   - 只禁用按钮、继续显示计数 → 「告诉你可删 N 笔但不给你入口」，仍是死路提示。
    // 所以入口与计数整块按 hasPurgeable 收起。这里两条都钉住。
    h.trash.mockResolvedValue(
      trashResponse([itemFixture({ can_purge: false })], { deletable: 2 }),
    )
    const wrapper = await mountTrash()

    expect(buttonByText(wrapper, '清空回收站')).toBeFalsy()
    // 用页脚容器断言而不是文本子串："可永久删除" 是 "不可永久删除" 的子串，容易假绿。
    expect(wrapper.find('.trash__footer').exists()).toBe(false)
    expect(wrapper.find('#trash-purge-confirm').exists()).toBe(false)
    wrapper.unmount()
  })

  it('owner 但全部被系统保留（can_purge=false 且 deletable=0）：入口与计数同样不渲染', async () => {
    h.trash.mockResolvedValue(
      trashResponse([itemFixture({ can_purge: false, is_system: true })], {
        deletable: 0,
        system_kept: 1,
      }),
    )
    const wrapper = await mountTrash()

    expect(buttonByText(wrapper, '清空回收站')).toBeFalsy()
    expect(wrapper.find('.trash__footer').exists()).toBe(false)
    expect(wrapper.text()).toContain('系统交易 · 不可永久删除')
    wrapper.unmount()
  })

  it('审计区块与清空入口互不影响：非 owner 仍能看到「永久删除记录」', async () => {
    h.trash.mockResolvedValue(
      trashResponse([itemFixture({ can_purge: false })], { deletable: 2 }, [logFixture()]),
    )
    const wrapper = await mountTrash()

    expect(buttonByText(wrapper, '清空回收站')).toBeFalsy()
    expect(wrapper.text()).toContain('永久删除记录')
    expect(wrapper.text()).toContain('被永久删除的支出')
    wrapper.unmount()
  })

  it('输入「清空」前后确认按钮 disabled/enabled，确认后调用 purgeTrash("删除")', async () => {
    h.trash.mockResolvedValue(trashResponse([itemFixture({ can_purge: true })]))
    h.purgeTrash.mockResolvedValue({
      ok: true,
      count: 1,
      deleted: [{ uuid: 'txn-1', description: '已删的早餐', was_in_trash: true }],
      purged_postings: 2,
    })
    const wrapper = await mountTrash()

    await buttonByText(wrapper, '清空回收站')!.trigger('click')
    const confirmBtn = () => buttonByText(wrapper, '确认清空')
    expect(confirmBtn()!.attributes('disabled')).toBeDefined()

    // 近似词不解锁（严等，不做同义词）。
    await wrapper.find('#trash-purge-confirm').setValue('清')
    expect(confirmBtn()!.attributes('disabled')).toBeDefined()
    await wrapper.find('#trash-purge-confirm').setValue('清空')
    expect(confirmBtn()!.attributes('disabled')).toBeUndefined()

    h.trash.mockResolvedValue(trashResponse([]))
    await confirmBtn()!.trigger('click')
    await flushPromises()

    expect(h.purgeTrash).toHaveBeenCalledTimes(1)
    expect(h.purgeTrash).toHaveBeenCalledWith('删除')
    expect(wrapper.text()).toContain('已永久删除 1 笔')
    wrapper.unmount()
  })

  it('清空弹层固定两行数字，paired>0 时追加第三行', async () => {
    h.trash.mockResolvedValue(
      trashResponse([itemFixture({ can_purge: true, pair_uuid: 'rev-1' })], {
        deletable: 2,
        system_kept: 1,
        paired: 1,
      }),
    )
    const wrapper = await mountTrash()

    await buttonByText(wrapper, '清空回收站')!.trigger('click')
    const text = wrapper.text()
    expect(text).toContain('可永久删除 2 笔')
    // 文案必须精确到「及其冲正配对」：system_kept 是**连通分量**口径，
    // 系统交易若带冲正配对，配对的那笔普通交易也被算进这个数。
    // 只说「N 笔系统交易将保留」会让用户以为数字里全是系统交易。
    expect(text).toContain('1 笔将保留（系统交易及其冲正配对）')
    expect(text).not.toContain('笔系统交易将保留')
    expect(text).toContain('其中 1 笔为冲正配对（不在回收站），将一并删除')
    wrapper.unmount()
  })

  it('paired=0 时不出现第三行（不显示无意义的 0 笔）', async () => {
    h.trash.mockResolvedValue(
      trashResponse([itemFixture({ can_purge: true })], { deletable: 1, system_kept: 0, paired: 0 }),
    )
    const wrapper = await mountTrash()

    await buttonByText(wrapper, '清空回收站')!.trigger('click')
    expect(wrapper.text()).not.toContain('为冲正配对')
    wrapper.unmount()
  })
})

describe('B7-F：审计区块「永久删除记录」', () => {
  it('purge_log 非空时渲染标题与行（时间 · 操作人 · 金额）', async () => {
    h.trash.mockResolvedValue(
      trashResponse([itemFixture()], {}, [
        logFixture(),
        logFixture({ uuid: 'gone-2', description: '第二笔', actor_name: '' }),
      ]),
    )
    const wrapper = await mountTrash()

    expect(wrapper.text()).toContain('永久删除记录')
    expect(wrapper.text()).toContain('被永久删除的支出')
    expect(wrapper.text()).toContain('-10.00 CNY / 10.00 CNY')
    expect(wrapper.text()).toContain('阿文')
    // 操作人已注销时回落「未知成员」，不留空档。
    expect(wrapper.text()).toContain('未知成员')
    wrapper.unmount()
  })

  it('purge_log 缺失（旧后端）时整块隐藏，不报错', async () => {
    h.trash.mockResolvedValue({
      transactions: [itemFixture()],
      // 故意不给 purge_summary / purge_log：旧后端的响应形状。
    })
    const wrapper = await mountTrash()

    expect(wrapper.text()).not.toContain('永久删除记录')
    // 旧后端既无 purge_summary 也无 can_purge → 没有「我能删」的信号，入口与计数整块不渲染。
    expect(wrapper.find('.trash__footer').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('B7-G：busy 期间所有入口 disabled（防双击）', () => {
  it('删除请求在飞时，⋯ / 恢复 / 清空 / 确认全部 disabled，回包后恢复', async () => {
    h.trash.mockResolvedValue(trashResponse([itemFixture({ can_purge: true })]))
    let resolvePurge: (value: unknown) => void = () => {}
    h.purge.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePurge = resolve
        }),
    )
    const wrapper = await mountTrash()

    await wrapper.find('[aria-label="更多操作"]').trigger('click')
    await buttonByText(wrapper, '永久删除')!.trigger('click')
    await buttonByText(wrapper, '确认永久删除')!.trigger('click')
    await flushPromises()

    // 弹层内的确认按钮自己变成「删除中…」且 disabled（连点两次不会发第二个请求）。
    expect(buttonByText(wrapper, '删除中…')?.attributes('disabled')).toBeDefined()
    // 行内入口同时被禁用（用户在弹层开着时也不能从背后再点一次）。
    expect(wrapper.find('[aria-label="更多操作"]').attributes('disabled')).toBeDefined()
    expect(buttonByText(wrapper, '恢复')?.attributes('disabled')).toBeDefined()
    expect(buttonByText(wrapper, '清空回收站')!.attributes('disabled')).toBeDefined()

    resolvePurge({ ok: true, count: 1, deleted: [], purged_postings: 2 })
    await flushPromises()

    // 回包后撤销 busy：入口重新可用（列表已刷新，故用重载后的按钮断言）。
    expect(h.purge).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

describe('B7-H：DataSafety 的「备份会让删除复活」提示两处逐字一致', () => {
  /**
   * 定稿 §8.4：这句话必须同时出现在「数据备份」卡片（仅 isAdmin）与「导入」卡片
   * （无门槛，普通成员也看得到），且**两处逐字一致**——同一件事两种说法最容易被
   * 当成谣言。用源码文本断言（同 moneyTabular.test.ts 的先例），比挂载整个
   * DataSafetyView 去比 textContent 更稳，也避开它的一大堆 backupApi mock。
   */
  // 用**渲染后**的形态（模板里换行 + 缩进会被压成一个空格），这才是用户看到的字。
  const SENTENCE =
    '恢复旧备份会让已删除的数据复活：备份文件里包含当时尚未删除的交易， ' +
    '还原后这些交易会重新出现在账本与回收站里。永久删除只作用于当前库，无法从备份外恢复。'

  /** 把连续空白（含换行 + 模板缩进）压成单空格，等价于浏览器渲染后的文本。 */
  function collapse(text: string): string {
    return text.replace(/\s+/g, ' ')
  }

  it('两处（导入卡片 + 数据备份卡片）都写了同一段文案', () => {
    // jsdom 环境下 import.meta.url 不是 file://（vite 用 http 代理模块），
    // 因此按 vitest 的 cwd（frontend/）取源文件，而不是 URL 相对定位。
    const source = collapse(
      readFileSync(resolve(process.cwd(), 'src/views/DataSafetyView.vue'), 'utf8'),
    )
    const occurrences = source.split(collapse(SENTENCE)).length - 1
    expect(occurrences).toBe(2)
    // 覆盖率护栏：不能被顺手挪进 isAdmin 分支后只剩一处。
    expect(source).toContain('永久删除只作用于当前库')
  })
})
