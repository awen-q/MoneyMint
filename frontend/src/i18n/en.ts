/**
 * 英文字典——i18n 阶段 0 试点初稿（工程师给出，后续批次按母语者审校顺延）。
 *
 * 类型约束 `Record<MessageKey, string>` 是防漂移第一闸门：zh-CN.ts 新增 / 删改
 * key 而本文件未同步时，vue-tsc / vitest 直接红，字典不可能悄悄发散。
 *
 * 术语对齐 Beancount：ledger = Ledger；reversal = reversal；
 * opening balance = opening balance（后两者本阶段尚未出现在试点文案中，
 * 后续批次沿用该口径）。
 */
import type { MessageKey } from './zh-CN'

export const en: Record<MessageKey, string> = {
  // 壳层：应用标题
  'shell.appTitle': 'Family Ledger',

  // 壳层导航（navItems.ts）：五视图 / 管理组 / 移动底栏短名
  'shell.nav.bills': 'Bills',
  'shell.nav.search': 'Search',
  'shell.nav.stats': 'Stats',
  'shell.nav.assets': 'Assets',
  'shell.nav.assetStats': 'Asset Stats',
  'shell.nav.trash': 'Trash',
  'shell.nav.accounts': 'Accounts',
  'shell.nav.categories': 'Categories',
  'shell.nav.commodities': 'Currencies',
  'shell.nav.members': 'Members',
  'shell.nav.ledgers': 'Ledgers',
  'shell.nav.sessions': 'Devices',
  'shell.nav.dataSafety': 'Data Safety',
  'shell.nav.sync': 'Sync',
  'shell.nav.settings': 'Settings',
  'shell.nav.more': 'More',
  'shell.tab.stats': 'Stats',

  // 通用四态默认文案（StateCard.vue）
  'common.loading': 'Loading…',
  'common.empty': 'No data yet',
  'common.error': 'Load failed',
  'common.retry': 'Retry',

  // 登录 / 注册页（LoginView.vue）
  'login.heroTagline': 'Family bookkeeping · every entry crystal clear',
  'login.username': 'Username',
  'login.displayName': 'Display name (optional)',
  'login.displayNamePlaceholder': 'e.g. Wen',
  'login.password': 'Password',
  'login.working': 'Working…',
  'login.register': 'Sign up',
  'login.login': 'Sign in',
  'login.switchToRegister': 'No account? Sign up',
  'login.switchToLogin': 'Have an account? Sign in',
  'login.hintRegistrationOpen':
    'The first registered account becomes the system administrator and creates the default ledger; later accounts need the administrator to open registration or an owner to invite you into the ledger.',
  'login.hintRegistrationClosed':
    'Registration is closed: ask the administrator to enable it in "Settings → Open registration", or have the ledger owner invite you via member management.',
  'login.noteResetPassword':
    'Forgot your password? Contact the administrator (owner) to reset it in member management.',
  'login.noteInviteOnly':
    'New accounts must be invited into a ledger by the owner before they can record transactions.',
  'login.errRegistrationClosed':
    'Registration is closed. Ask the administrator to open it in settings, or get invited by the ledger owner',
  'login.errRequired': 'Please enter a username and password',
  'login.errPasswordTooShort': 'Registration password must be at least 6 characters',
  'login.errGeneric': 'Operation failed, please try again later',
}
