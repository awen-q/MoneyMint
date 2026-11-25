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

  // Shell: header (ShellHead) / ledger line / privacy / more
  'shell.currentLedger': 'Ledger: {name}',
  'shell.currentLedgerWithUser': 'Ledger: {name} · {user}',
  'shell.showAmount': 'Show amounts',
  'shell.hideAmount': 'Hide amounts',
  'shell.moreActions': 'More actions',

  // Shell: mobile tab bar (ShellTabs) / PC sidebar (ShellSidebar)
  'shell.bottomNav': 'Bottom navigation',
  'shell.mainNav': 'Main navigation',
  'shell.record': 'New entry',
  'shell.brandSub': 'Shared family ledger',
  'shell.manageGroup': 'Manage · {count}',
  'shell.prerelease': 'Preview',

  // Shell: more sheet (MoreSheet)
  'shell.manageAndTools': 'Manage & tools',
  'shell.accountSection': 'Account',
  'shell.changePassword': 'Change password',
  'shell.sessionSection': 'Session',
  'shell.logout': 'Sign out',

  // Shell: ledger switcher (LedgerSwitcher)
  'shell.switchLedger': 'Switch ledger',
  'shell.noLedgers': 'No ledgers yet',
  'shell.roleOwner': 'Owner',
  'shell.roleEditor': 'Editor',
  'shell.roleViewer': 'View only',

  // Shell: sync badge (SyncBadge)
  'shell.syncPendingFailed': 'Pending {pending} · Failed {dead}',
  'shell.syncFailed': 'Failed {dead}',
  'shell.syncPending': 'Pending {pending}',
  'shell.offline': 'Offline',
  'shell.syncStatusLabel': 'Sync status: {label}',

  // Shell: month / year pickers (MonthPicker / YearPicker / SelectSheet)
  'shell.selectMonthTitle': 'Select month',
  'shell.selectMonthDialog': 'Select billing month',
  'shell.prevYear': 'Previous year',
  'shell.nextYear': 'Next year',
  'shell.yearLabel': '{year}',
  'shell.yearCellLabel': 'Year {year}',
  'shell.monthGridLabel': 'Months of {year}',
  'shell.monthCellLabel': '{year} month {month}',
  'shell.hasData': ', has data',
  'shell.monthShort': 'M{month}',
  'shell.selectYearTitle': 'Select year',
  'shell.selectYearDialog': 'Select billing year',
  'shell.prevYearPage': 'Previous years',
  'shell.nextYearPage': 'Next years',
  'shell.yearGrid': 'Years',
  'shell.closeDialog': 'Close {title}',

  // Shell: AppLayout notices and PWA update banner
  'shell.navPending': '{label} will be available in a later release',
  'shell.viewerCannotRecord': 'View-only members cannot record entries',
  'shell.needsInvite': 'Please wait for the owner to invite you into a ledger',
  'shell.updateAvailable': 'A new version is available',
  'shell.updateNow': 'Update now',

  // Settings: language switch entry (stage 1; the rest of this page moves in stage 2)
  'settings.language': 'Language / 语言',
  'settings.languageDialog': 'Choose a language',

  // API error code messages (stage 1): mirrors CODE_MESSAGES in errors.ts, key = apiErrors.<code>
  // ---- 0.6.0 ledger deletion (S1) ----
  'apiErrors.ledger_has_members':
    'There are still other members; remove them in member management before deleting the ledger',
  'apiErrors.last_ledger': 'This is the last active ledger and cannot be deleted',
  'apiErrors.ledger_deleted': 'This ledger has been deleted; please switch to another ledger',
  // ---- 0.6.0 accounts / commodities (S2) ----
  'apiErrors.account_name_invalid':
    'The account name does not follow Beancount conventions; check the root category and first segment',
  'apiErrors.account_name_exists': 'This account name is already taken; please choose another',
  'apiErrors.parent_not_found': 'The parent account does not exist or belongs to another ledger',
  'apiErrors.parent_type_mismatch': 'The parent account type does not match the child account',
  // ---- Batch II account display fields (PATCH / create shared) ----
  'apiErrors.account_visual_invalid':
    'The icon must be an emoji of at most 8 characters, and the color must be in #RRGGBB format',
  'apiErrors.commodity_exists': 'This currency already exists',
  'apiErrors.commodity_in_use':
    'This currency is referenced by accounts, transactions or prices and cannot be deleted',
  // ---- 0.6.0 balance calibration (S4) ----
  'apiErrors.balance_date_invalid':
    'The date is invalid or out of range; it must be no earlier than max(account open date, ledger opening date) and no later than today',
  'apiErrors.balance_date_too_early':
    'The date is too early to generate a calibration posting after max(account open date, ledger opening date)',
  'apiErrors.opening_equity_closed':
    'The opening balance equity account is closed; restore it before generating calibration postings',
  // ---- 0.6.0 transaction editing (S6) ----
  'apiErrors.txn_edit_forbidden':
    'You can only edit your own entries, or the ledger owner can edit them',
  'apiErrors.txn_not_editable':
    'Opening balance / reversal / calibration entries cannot be edited',
  'apiErrors.txn_already_reversed': 'This entry has been reversed; please edit the latest version',
  // ---- 0.6.0 import (S5) ----
  'apiErrors.import_pad_balance_unsupported':
    'The file contains pad / balance directives; expand them into regular transactions and re-import, or use new-ledger mode',
  'apiErrors.import_unbalanced':
    'The imported transactions are unbalanced; check the line numbers listed in the preview',
  'apiErrors.import_account_conflict':
    'An account with the same name has a conflicting type or currency restriction and cannot be reused',
  'apiErrors.import_batch_not_found': 'Import batch not found; cannot undo',
  // ---- Existing online codes (0.5.1 and earlier) ----
  'apiErrors.account_not_found': 'Account not found',
  'apiErrors.account_closed': 'The account is closed and cannot be used for recording',
  'apiErrors.account_balance_not_zero': 'The account balance is not zero; transfer it out first',
  'apiErrors.account_open_date_after_ledger':
    'The open date cannot be later than the ledger opening date',
  'apiErrors.opening_conflict': 'Opening balance conflict; refresh and try again',
  'apiErrors.opening_via_api_only': 'Please set the opening balance from the online client',
  'apiErrors.opening_amount_invalid': 'Invalid opening amount',
  'apiErrors.opening_direction_invalid': 'Invalid opening direction',
  'apiErrors.opening_commodity_mismatch':
    'The opening currency does not match the account currency restriction',
  'apiErrors.opening_account_not_openable': 'This account cannot have an opening balance',
  'apiErrors.opening_date_mismatch': 'The opening date does not match the ledger setting',
  'apiErrors.ledger_opening_date_invalid':
    'The opening date must be in YYYY-MM-DD and no later than today',
  'apiErrors.ledger_opening_date_after_first_txn':
    'The opening date cannot be later than the earliest transaction in the ledger',
  'apiErrors.idempotency_key_deleted':
    'The transaction for this request has been deleted; please resubmit',
  'apiErrors.idempotency_payload_mismatch':
    'The same request ID maps to different content; please resubmit',
  'apiErrors.csrf_required': 'Missing CSRF header; please refresh the page and try again',
  // ---- Client-side local error (client.ts network failure notice) ----
  'apiErrors.network_error':
    'Network connection failed; check your connection and try again',
}
