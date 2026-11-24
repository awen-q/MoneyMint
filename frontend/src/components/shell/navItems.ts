/**
 * 壳层导航模型（T20）
 *
 * 三套清单各自单一来源，组件只负责渲染，不再各自抄一份：
 * - `NAV_MAIN`：五视图直达（账单 / 搜索 / 统计 / 资产 / 资产统计）；
 * - `NAV_MANAGE`：10 个管理页（v4 不改版，但入口不能丢）；
 * - `MOBILE_TABS`：移动底栏 4 项，**顺序即底栏从左到右**，中央 FAB 由
 *   `ShellTabs` 插在第 3 格（4 项 + FAB = 5 格，与现网结构一致）。
 *
 * 关于 label（i18n 阶段 0，QA 修复轮定稿）：label 是 **getter（访问时求值）**——
 * 每次读取 `item.label` 才调用 t()。早期版本是模块求值快照，但 ES import 链下
 * navItems 的求值早于 main.ts 的 initLocale()，en 持久化后刷新页面壳层仍是中文
 * （登录页已英文 → 混合语言，QA P2 缺陷）。getter 形态下：
 * - Vue 模板 `{{ item.label }}` 在渲染上下文访问 → 求值时机 = 渲染时机，且
 *   t() 读取 locale.value 被 render effect 追踪 → 切语言自动重渲染（响应式）；
 * - `item.label` 对消费方与测试仍是普通 string 属性访问，shellNav.test.ts 的
 *   既有断言（含 `['更多']` 与 label 拼串）零适配原样绿。
 * **禁止回退成模块求值快照**（`label: t(...)` 字面量）。
 *
 * 关于 `ready`：它的语义是「这个入口当前能不能点进去」，即目标路由**已经存在**
 * 于 `router/index.ts`。不变式由 `shellNav.test.ts` 守住：
 *
 *     ready === true  ⟺  router.resolve(to) 得到具名路由
 *
 * 所以 `ready === false` 的入口一律只出提示、不跳转，**永远不会点出死链**
 * （也不会被 catch-all 悄悄重定向回首页，让用户以为点错了）。B2~B6 接页面时，
 * 「新增路由」与「翻转 ready」必须落在同一个提交里（dev-plan §2 原子提交约定③）。
 */
import { t } from '@/i18n'

export interface NavItem {
  /** 稳定标识，仅用于 v-for key 与测试断言，不参与路由。 */
  key: string
  /** 展示文案（getter：访问时求值 t()，渲染上下文内随 locale 响应）。 */
  label: string
  /** 单字符图标（与现网壳层同风格，不引图标库）。 */
  icon: string
  /** 目标路径；`undefined` 表示不是一个路由（如「更多」打开弹层）。 */
  to?: string
  /** 该入口当前是否可点进（= 目标路由已存在）。见文件头不变式。 */
  ready: boolean
}

/**
 * 五视图直达（PC 侧栏顺序）。
 * 账单（`/`）已由 `BillsView` 承接（T30）；其余四项的路由由 B3~B6 陆续落地，
 * 落地前 `ready: false`。
 */
export const NAV_MAIN: NavItem[] = [
  { key: 'bills', get label() { return t('shell.nav.bills') }, icon: '⌂', to: '/', ready: true },
  { key: 'search', get label() { return t('shell.nav.search') }, icon: '🔍', to: '/search', ready: true },
  { key: 'stats', get label() { return t('shell.nav.stats') }, icon: '◔', to: '/stats', ready: true },
  { key: 'assets', get label() { return t('shell.nav.assets') }, icon: '▤', to: '/assets', ready: true },
  { key: 'asset-stats', get label() { return t('shell.nav.assetStats') }, icon: '↗', to: '/assets/stats', ready: true },
]

/**
 * 10 个管理页（`router/index.ts` 里已全部存在，故恒为 ready）。
 * 顺序 = 侧栏折叠组 / 「更多」弹层里的展示顺序。
 */
export const NAV_MANAGE: NavItem[] = [
  { key: 'trash', get label() { return t('shell.nav.trash') }, icon: '🗑', to: '/trash', ready: true },
  { key: 'accounts', get label() { return t('shell.nav.accounts') }, icon: '▤', to: '/accounts', ready: true },
  { key: 'categories', get label() { return t('shell.nav.categories') }, icon: '▥', to: '/categories', ready: true },
  { key: 'commodities', get label() { return t('shell.nav.commodities') }, icon: '💱', to: '/commodities', ready: true },
  { key: 'members', get label() { return t('shell.nav.members') }, icon: '◯', to: '/members', ready: true },
  { key: 'ledgers', get label() { return t('shell.nav.ledgers') }, icon: '▣', to: '/ledgers', ready: true },
  { key: 'sessions', get label() { return t('shell.nav.sessions') }, icon: '▢', to: '/sessions', ready: true },
  { key: 'data-safety', get label() { return t('shell.nav.dataSafety') }, icon: '⛁', to: '/data-safety', ready: true },
  { key: 'sync-status', get label() { return t('shell.nav.sync') }, icon: '↻', to: '/sync', ready: true },
  { key: 'settings', get label() { return t('shell.nav.settings') }, icon: '⚙', to: '/settings', ready: true },
]

/**
 * 移动底栏 4 项（中央 FAB 由 ShellTabs 插在第 3 格）。
 *
 * 注意第 4 项的 `to` 是 `undefined`：点它**开「更多」弹层，不切视图**
 * （D-4 已定：FAB 是唯一记账入口，「更多」不放记一笔）。
 * 底栏文案取短名（统计 / 资产），与侧栏长名（统计账单）刻意不同：
 * 底栏每格宽度只够两个字，四个字会挤成两行。
 */
export const MOBILE_TABS: NavItem[] = [
  { key: 'bills', get label() { return t('shell.nav.bills') }, icon: '⌂', to: '/', ready: true },
  { key: 'stats', get label() { return t('shell.tab.stats') }, icon: '◔', to: '/stats', ready: true },
  { key: 'assets', get label() { return t('shell.nav.assets') }, icon: '▤', to: '/assets', ready: true },
  { key: 'more', get label() { return t('shell.nav.more') }, icon: '⋯', ready: true },
]

/**
 * 判定某个导航项是否处于「当前页」。
 *
 * @param item 导航项
 * @param path 当前路由路径（`route.path`）
 * @returns 是否高亮
 *
 * 细节：
 * - `/` 只精确匹配（否则任何子页面都会把首页点亮）；
 * - 其余按「精确 或 其子路径」匹配，让 `/accounts/12` 仍高亮「账户管理」；
 * - 无 `to` 的项（更多）永不高亮。
 */
export function isItemActive(item: NavItem, path: string): boolean {
  if (item.to === undefined) {
    return false
  }
  if (item.to === '/') {
    return path === '/'
  }
  return path === item.to || path.startsWith(`${item.to}/`)
}
