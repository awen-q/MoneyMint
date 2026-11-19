// @vitest-environment jsdom
/**
 * 导航模型回归（T20）：
 * - 三套清单条数（5 / 10 / 4）与 key、to 唯一性；
 * - 10 个管理项的路由名与 `router/index.ts` 的 `name` 逐条对应（防手抄错）；
 * - **不变式**：`ready === true` ⟺ `router.resolve(to)` 得到具名路由。
 *   这条是「不会点出死链」的唯一保证，也是 B2~B6 新增路由时必须同步翻
 *   `ready` 的机器检查点；
 * - `isItemActive` 的高亮口径（`/` 只精确、子路径跟随、无 to 不高亮）。
 */
import { describe, expect, it } from 'vitest'

import router from '@/router'

import { MOBILE_TABS, NAV_MAIN, NAV_MANAGE, isItemActive, type NavItem } from './navItems'

/** `resolve` 出来的目标是不是一个真实页面（而不是 catch-all 兜底）。 */
function resolvesToNamedRoute(to: string): boolean {
  const resolved = router.resolve(to)
  return typeof resolved.name === 'string' && resolved.name !== ''
}

const ALL_LISTS: Array<{ name: string; items: NavItem[] }> = [
  { name: 'NAV_MAIN', items: NAV_MAIN },
  { name: 'NAV_MANAGE', items: NAV_MANAGE },
  { name: 'MOBILE_TABS', items: MOBILE_TABS },
]

describe('navItems：清单结构', () => {
  it('条数为 5 / 10 / 4', () => {
    expect(NAV_MAIN).toHaveLength(5)
    expect(NAV_MANAGE).toHaveLength(10)
    expect(MOBILE_TABS).toHaveLength(4)
  })

  it('每套清单内 key 唯一，跨清单 key 也不重复（避免 v-for key 撞车）', () => {
    for (const list of ALL_LISTS) {
      const keys = list.items.map((item) => item.key)
      expect(new Set(keys).size).toBe(keys.length)
    }
    // 底栏与侧栏共用同一批 key（bills/stats/assets），这是有意的复用；
    // 这里只断言「同一套清单内」唯一，跨清单的重复项只有这三个共享 key。
    const mainKeys = NAV_MAIN.map((item) => item.key)
    const tabKeys = MOBILE_TABS.map((item) => item.key)
    const shared = tabKeys.filter((key) => mainKeys.indexOf(key) >= 0)
    expect(shared.sort()).toEqual(['assets', 'bills', 'stats'])
  })

  it('每套清单内 to 唯一；底栏的目标是五视图的子集', () => {
    for (const list of [NAV_MAIN, NAV_MANAGE]) {
      const targets = list
        .map((item) => item.to)
        .filter((to): to is string => to !== undefined)
      expect(new Set(targets).size).toBe(targets.length)
    }
    const mainTargets = NAV_MAIN.map((item) => item.to)
    for (const tab of MOBILE_TABS) {
      if (tab.to === undefined) {
        continue
      }
      // 底栏只复用五视图的路径（同一页面在两处出现是设计：侧栏长名、底栏短名）
      expect(mainTargets).toContain(tab.to)
    }
  })

  it('所有 to 以 / 开头且不含路由参数', () => {
    const targets = ALL_LISTS.flatMap((list) =>
      list.items.map((item) => item.to).filter((to): to is string => to !== undefined),
    )
    expect(targets.length).toBeGreaterThan(0)
    for (const to of targets) {
      expect(to.startsWith('/')).toBe(true)
      expect(to.includes(':')).toBe(false)
    }
  })

  it('只有「更多」一个入口没有 to（它是弹层，不是路由）', () => {
    const withoutTarget = ALL_LISTS.flatMap((list) =>
      list.items.filter((item) => item.to === undefined).map((item) => item.label),
    )
    expect(withoutTarget).toEqual(['更多'])
  })
})

describe('navItems：路由名逐个核对（防手抄错）', () => {
  it('10 个管理项的路由名与 router/index.ts 一一对应', () => {
    const expected = [
      'trash',
      'accounts',
      'categories',
      'commodities',
      'members',
      'ledgers',
      'sessions',
      'data-safety',
      'sync',
      'settings',
    ]
    const actual = NAV_MANAGE.map((item) => router.resolve(item.to ?? '/').name)
    expect(actual).toEqual(expected)
  })

  it('账单指向 / 且该路径已被路由承接', () => {
    const bills = NAV_MAIN[0]
    expect(bills.to).toBe('/')
    expect(resolvesToNamedRoute('/')).toBe(true)
  })

  it('T30：/ 由账单页承接，navItems 的账单入口指向它', async () => {
    const bills = await import('@/views/BillsView.vue')
    const resolved = router.resolve('/')
    expect(resolved.name).toBe('bills')
    // 比 name 更硬：直接断言组件身份，防止「名字改了但组件还是旧页」
    expect(resolved.matched[0]?.components?.default).toBe(bills.default)
    expect(NAV_MAIN[0].to).toBe('/')
    expect(NAV_MAIN[0].ready).toBe(true)
  })

  it('10 个管理项每条都命中唯一一条路由记录且带组件（点进去不会 404）', () => {
    for (const item of NAV_MANAGE) {
      const resolved = router.resolve(item.to ?? '/')
      expect(resolved.matched).toHaveLength(1)
      const record = resolved.matched[0]
      // catch-all 的 redirect 记录没有 components；真实页面必须有默认组件
      expect(record?.components).toBeTruthy()
      expect(record?.components?.default).toBeTruthy()
    }
  })
})

describe('navItems：ready ⟺ 路由存在（不变式）', () => {
  it('ready 与路由可解析性必须同真同假', () => {
    for (const list of ALL_LISTS) {
      for (const item of list.items) {
        if (item.to === undefined) {
          // 「更多」不是路由，开弹层，必须可点
          expect(item.ready).toBe(true)
          continue
        }
        expect({
          label: `${list.name}/${item.label}`,
          ready: item.ready,
        }).toEqual({
          label: `${list.name}/${item.label}`,
          ready: resolvesToNamedRoute(item.to),
        })
      }
    }
  })

  it('B3/B4/B6 的其余视图路由当前确实还不存在（落地时本条会红，届时同步翻 ready）', () => {
    // B5 已落地：`/assets` 已从 pending 移出，改为下方正向断言。
    const pending = ['/search', '/stats', '/assets/stats']
    for (const path of pending) {
      expect(resolvesToNamedRoute(path)).toBe(false)
    }
  })

  it('B5 已落地：/assets 解析到命名路由 assets，且两处导航项都已 ready', () => {
    expect(resolvesToNamedRoute('/assets')).toBe(true)
    expect(router.resolve('/assets').name).toBe('assets')
    const items = NAV_MAIN.filter((item) => item.to === '/assets')
    expect(items.length).toBe(1)
    expect(items[0].ready).toBe(true)
    const tabs = MOBILE_TABS.filter((item) => item.to === '/assets')
    expect(tabs.length).toBe(1)
    expect(tabs[0].ready).toBe(true)
  })
})

describe('navItems：isItemActive 高亮口径', () => {
  const home = NAV_MAIN[0]
  const accounts = NAV_MANAGE[1]
  const more = MOBILE_TABS[3]

  it('/ 只精确匹配，子页面不点亮首页', () => {
    expect(isItemActive(home, '/')).toBe(true)
    expect(isItemActive(home, '/settings')).toBe(false)
    expect(isItemActive(home, '/accounts/12')).toBe(false)
  })

  it('子路径仍高亮父入口', () => {
    expect(isItemActive(accounts, '/accounts')).toBe(true)
    expect(isItemActive(accounts, '/accounts/12')).toBe(true)
    expect(isItemActive(accounts, '/accounts-backup')).toBe(false)
  })

  it('无 to 的项永不高亮', () => {
    expect(isItemActive(more, '/')).toBe(false)
    expect(isItemActive(more, '/more')).toBe(false)
  })
})
