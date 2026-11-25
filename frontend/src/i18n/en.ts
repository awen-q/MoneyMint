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

  // Shared: role labels used by admin pages (mirrors core/batch3.roleLabel values)
  'common.roleOwner': 'Owner',
  'common.roleEditor': 'Editor',
  'common.roleViewer': 'View only',
  'common.roleNone': 'Not in a ledger',

  // Settings page (SettingsView.vue, stage 2 batch 1; language row moved in stage 1)
  'settings.title': 'Settings',
  'settings.subtitle': 'Account, ledgers & data',
  'settings.notLoggedIn': 'Not signed in',
  'settings.admin': 'Administrator',
  'settings.ledgerRoleBadge': 'Ledger {role}',
  'settings.defaultAccounts': 'Default accounts',
  'settings.clearAllDefaults': 'Clear all defaults',
  'settings.readingDefaults': 'Reading default accounts…',
  'settings.notSet': 'Not set',
  'settings.defaultDeleted': '(deleted)',
  'settings.defaultHint':
    'New entries remember your last choice; if an account is deleted or closed it falls back to unselected.',
  'settings.appearance': 'Appearance',
  'settings.appearanceThemeLabel': 'Appearance theme',
  'settings.appearanceSystem': 'Follow system',
  'settings.appearanceLight': 'Light paper',
  'settings.appearanceDark': 'Night paper',
  'settings.appearanceHintCustom': 'Choose the site-wide color scheme; applies immediately',
  'settings.appearanceHintSystem': 'Following system (active: {theme})',
  'settings.ledgers': 'Ledgers',
  'settings.ledgersCurrentHint': '{name} (current)',
  'settings.members': 'Members',
  'settings.membersHintNotOwner': 'Owner only',
  'settings.sessions': 'Devices',
  'settings.sessionsHint': 'View / revoke',
  'settings.changePassword': 'Change password',
  'settings.dataSafety': 'Data safety',
  'settings.dataSafetyHint': 'Backup / export',
  'settings.reports': 'Reports',
  'settings.reportsHint': 'Trend / share',
  'settings.sync': 'Sync status',
  'settings.syncHint': 'Server watermark',
  'settings.membersOwnerOnly': 'Only the ledger owner can manage members',
  'settings.registrationOpenNotice': 'Registration opened',
  'settings.registrationClosedNotice': 'Registration closed',
  'settings.registrationToggleFailedAdmin':
    'Toggle failed (requires administrator): {message}',
  'settings.registrationToggleFailed': 'Toggle failed, please try again later',
  'settings.defaultsCleared': 'All default accounts cleared',
  'settings.registration': 'Open registration',
  'settings.registrationHint':
    'When off, the login page hides the sign-up entry; only the administrator can toggle it.',
  'settings.switching': 'Switching…',
  'settings.registrationOn': 'Open',
  'settings.registrationOff': 'Closed',
  'settings.logout': 'Sign out',

  // Signed-in devices page (SessionsView.vue)
  'sessions.title': 'Signed-in devices',
  'sessions.subtitle':
    'Revoke any device you do not recognize; the other side will need to sign in again',
  'sessions.totalDevices': '{n} devices',
  'sessions.revokeOthers': 'Sign out other devices',
  'sessions.refresh': 'Refresh',
  'sessions.revokeCurrentTitle': 'Sign out this device?',
  'sessions.revokeTitle': 'Revoke this device?',
  'sessions.revokeCurrentBody': 'You will need to sign in again; ledger data is not lost.',
  'sessions.revokeBody':
    'This device will be invalidated immediately and must sign in with its password again.',
  'sessions.cancel': 'Cancel',
  'sessions.confirm': 'Confirm',
  'sessions.retry': 'Retry',
  'sessions.loading': 'Reading signed-in devices…',
  'sessions.empty': 'No signed-in device records.',
  'sessions.currentDevice': 'Current device',
  'sessions.loginAt': 'Signed in {time}',
  'sessions.lastActiveAt': 'Last active {time}',
  'sessions.revoke': 'Revoke',
  'sessions.logoutDevice': 'Sign out',
  'sessions.errGeneric': 'Operation failed, please try again later',
  'sessions.errExpired': 'Session expired, please sign in again',
  'sessions.errLoadFailed': 'Load failed ({status}): {message}',
  'sessions.errOffline': 'Cannot reach the server; signed-in devices can only be viewed online',
  'sessions.noticeCurrentLoggedOut': 'Signed out of the current device',
  'sessions.noticeRevoked': 'This device has been revoked and must sign in with its password again',
  'sessions.errSessionInvalid': 'This session is no longer valid',
  'sessions.noticeOthersRevoked': 'Signed out of {n} other devices',
  'sessions.noticeNoOthers': 'No other devices',

  // Members page (MembersView.vue)
  'members.title': 'Members',
  'members.subtitle': 'Members join by username and must register first',
  'members.ownerOnly': 'Only the ledger owner can manage members.',
  'members.totalMembers': '{n} members',
  'members.invite': 'Invite member',
  'members.usernameLabel': 'Username (the other party must register first)',
  'members.usernamePlaceholder': 'e.g. alice',
  'members.roleLabel': 'Role',
  'members.roleViewerOption': 'View only: read access',
  'members.roleEditorOption': 'Editor: can add and edit entries',
  'members.cancel': 'Cancel',
  'members.confirmInvite': 'Confirm invite',
  'members.resetTitle': 'Reset password for "{name}"',
  'members.resetHint':
    "After success all of this member's sessions are invalidated immediately and re-login is required.",
  'members.newPasswordLabel': 'New password (at least 6 characters)',
  'members.newPasswordPlaceholder': 'At least 6 characters',
  'members.confirmReset': 'Confirm reset',
  'members.removeTitle': 'Remove member?',
  'members.removeBody':
    'After removal "{name}" can no longer access the shared ledger, but local data is kept.',
  'members.confirmRemove': 'Confirm removal',
  'members.loadFailed': 'Load failed: {message}',
  'members.reload': 'Reload',
  'members.loading': 'Loading members…',
  'members.empty': 'No members yet.',
  'members.setEditor': 'Make editor',
  'members.setViewer': 'Make view-only',
  'members.resetPassword': 'Reset password',
  'members.remove': 'Remove',
  'members.errGeneric': 'Operation failed, please try again later',
  'members.errUsernameRequired': 'Please enter a username (the other party must register first)',
  'members.noticeInvited': 'Invited "{name}"',
  'members.noticeRoleChanged': 'Changed "{name}" to {role}',
  'members.noticeRemoved': 'Removed "{name}"',
  'members.errPasswordTooShort': 'New password must be at least 6 characters',
  'members.noticeResetDone': 'Password reset; all sessions of this member are invalidated',

  // Ledgers page (LedgersView.vue)
  'ledgers.title': 'Ledgers',
  'ledgers.subtitle': "Switching ledgers reloads that ledger's data",
  'ledgers.totalLedgers': '{n} ledgers',
  'ledgers.create': 'New ledger',
  'ledgers.nameLabel': 'Ledger name (default currency CNY)',
  'ledgers.namePlaceholder': 'e.g. Household',
  'ledgers.cancel': 'Cancel',
  'ledgers.createAndSwitch': 'Create & switch',
  'ledgers.renameTitle': 'Rename ledger',
  'ledgers.newNameLabel': 'New name',
  'ledgers.save': 'Save',
  'ledgers.loadFailed': 'Load failed: {message}',
  'ledgers.reload': 'Reload',
  'ledgers.loading': 'Loading ledgers…',
  'ledgers.empty': 'No ledgers yet. Create one.',
  'ledgers.rowMeta': '{role} · opening {date} · {accounts} accounts / {txns} transactions',
  'ledgers.current': 'Current',
  'ledgers.switch': 'Switch',
  'ledgers.rename': 'Rename',
  'ledgers.delete': 'Delete',
  'ledgers.deleteBlockedTitle': '{n} members remain; remove them first',
  'ledgers.deleteTooltip': 'Delete ledger',
  'ledgers.openingTitle': 'Opening date',
  'ledgers.openingHint':
    'Current: {date}. Changing it reverses and rebuilds all opening entries; online only.',
  'ledgers.openingAdjust': 'Adjust opening date',
  'ledgers.openingConfirmTitle': 'Change opening date?',
  'ledgers.openingConfirmBody':
    'The opening date will change from {from} to {to}. {n} opening entries will be rebuilt (old opening entries reversed then regenerated). Continue?',
  'ledgers.openingDateLabel': 'New opening date (no later than {bound})',
  'ledgers.openingConfirmSubmit': 'Confirm & rebuild',
  'ledgers.deleteTitle': 'Delete ledger "{name}"?',
  'ledgers.deleteBody':
    'This ledger has {accounts} accounts and {txns} transactions, and {members} members besides you. A pre-ledger-delete consistency snapshot will be created automatically (restorable from the backup list); after deletion the ledger disappears from the list, and the session automatically switches the stale ledger id to the smallest active ledger.',
  'ledgers.deleteConfirmLabel': 'Type the ledger name "{name}" to confirm deletion',
  'ledgers.deleteConfirmSubmit': 'Confirm delete',
  'ledgers.hint':
    "Tip: switching ledgers reloads that ledger's data; offline changes not yet synced on the old ledger will be handled by the sync core in batch 5.",
  'ledgers.errGeneric': 'Operation failed, please try again later',
  'ledgers.errNameRequired': 'Please enter a ledger name',
  'ledgers.noticeCreated': 'Created "{name}" and switched to it',
  'ledgers.errNameEmpty': 'Ledger name cannot be empty',
  'ledgers.noticeRenamed': 'Ledger renamed',
  'ledgers.errHasMembers': '{n} members remain; remove them before deleting the ledger',
  'ledgers.noticeDeleted': 'Deleted "{name}"',
  'ledgers.errOpeningOnlineOnly': 'Opening date can only be changed online: {message}',
  'ledgers.errOpeningDateInvalid': 'Please choose a valid date (YYYY-MM-DD)',
  'ledgers.errOpeningTooLate': 'The opening date cannot be later than {bound}',
  'ledgers.noticeOpeningUpdated': 'Opening date changed to {date}; opening entries rebuilt',
  'ledgers.noticeSwitched': 'Switched to "{name}"; pages will reload data for the new ledger',

  // Currencies page (CommoditiesView.vue)
  'commodities.title': 'Currencies · ledger default {commodity}',
  'commodities.reload': 'Reload',
  'commodities.loading': 'Loading currency data…',
  'commodities.listTitle': 'Currencies ({n})',
  'commodities.listEmpty': 'No currencies registered in this ledger yet.',
  'commodities.colCode': 'Code',
  'commodities.colName': 'Name',
  'commodities.colPrecision': 'Precision',
  'commodities.colStatus': 'Status',
  'commodities.colActions': 'Actions',
  'commodities.default': 'Default',
  'commodities.used': 'In use',
  'commodities.free': 'Deletable',
  'commodities.delete': 'Delete',
  'commodities.createTitle': 'New currency',
  'commodities.symbolLabel': 'Currency code (start with an uppercase letter, e.g. USD)',
  'commodities.nameLabel': 'Name (optional, e.g. US Dollar)',
  'commodities.namePlaceholder': 'US Dollar',
  'commodities.working': 'Working…',
  'commodities.add': 'Add',
  'commodities.createHint':
    'Precision is fixed at 2 (this version does not support changing precision); if a same-named currency was deleted before, the original record is restored instead of creating a new one.',
  'commodities.viewerHint':
    'View-only members can see currencies; adding and deleting require editor / owner rights.',
  'commodities.inUseTitle': 'Cannot delete: this currency is still referenced',
  'commodities.summaryTitle': 'Balance summary (read-only)',
  'commodities.summaryEmpty': 'No currency balances in this ledger yet.',
  'commodities.colCommodity': 'Currency',
  'commodities.colAssets': 'Total assets',
  'commodities.colLiabilities': 'Liabilities',
  'commodities.colNetWorth': 'Net worth',
  'commodities.colAccounts': 'Accounts',
  'commodities.colTxns': 'Transactions',
  'commodities.summaryHint':
    'The summary is derived from account balances and transaction postings, independent of the backend reference check that guards deletion.',
  'commodities.errLoad': 'Failed to load currency data',
  'commodities.usageAccounts': '{n} accounts restricted to this currency (e.g. {name})',
  'commodities.usagePostings': '{n} transaction postings',
  'commodities.usagePrices': '{n} prices',
  'commodities.usageDefault':
    'This is the ledger default currency: change the default currency in ledger settings first',
  'commodities.usageSeparator': ', ',
  'commodities.errSymbolRequired':
    'Please enter a currency code (e.g. USD, must start with an uppercase letter)',
  'commodities.noticeCreated': 'Currency {symbol} added',
  'commodities.noticeRemoved':
    'Currency {symbol} deleted (adding the same name again will restore it)',

  // Accounts / categories domain shared: sheet buttons, table columns (stage 2 batch 2)
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.saving': 'Saving…',
  'common.reload': 'Reload',
  'common.edit': 'Edit',
  'common.delete': 'Delete',
  'common.commodity': 'Currency',
  'common.diff': 'Difference',

  // Icon picker (IconPicker.vue; the too-long hint is reused by the account forms)
  'common.iconPicker.label': 'Account icon selection',
  'common.iconPicker.customPlaceholder': 'Custom emoji or character (optional)',
  'common.iconPicker.tooLong':
    'The icon must be an emoji of at most 8 characters; please shorten it and try again',
  'common.iconPicker.clear': 'Clear icon (restore default 📁)',

  // Accounts page (AccountsView.vue)
  'accounts.title': 'Accounts · {name}',
  'accounts.create': '+ New account',
  'accounts.loading': 'Loading accounts…',
  'accounts.emptyGroup': 'No {label} accounts yet.',
  'accounts.childCount': '{n} sub-accounts',
  'accounts.closed': 'Closed',
  'accounts.addChild': '+ Sub-account',
  'accounts.hint':
    'Tap an account to view details, set an opening balance or close it; "+ Sub-account" adds a child under that account.',
  'accounts.groupAssets': 'Assets',
  'accounts.groupLiabilities': 'Liabilities',
  'accounts.errViewerCreate': 'View-only members cannot create accounts',
  'accounts.errViewerAddChild': 'View-only members cannot add sub-accounts',
  'accounts.errClosedAddChild': 'A closed account cannot have sub-accounts',
  'accounts.noticeSaved': 'Account saved; hierarchy refreshed',
  'accounts.errLoad': 'Failed to load accounts',

  // Account form (AccountForm.vue)
  'accounts.form.dialogCreate': 'New account',
  'accounts.form.dialogOpening': 'Opening balance',
  'accounts.form.titleAddChild': 'Add sub-account',
  'accounts.form.titleOpening': 'Opening balance · {name}',
  'accounts.form.balanceDiffLabel': 'Difference by currency (close / reversal guard):',
  'accounts.form.loadingOpening': 'Loading opening balance…',
  'accounts.form.typeLabel': 'Type',
  'accounts.form.typeInheritedSuffix': ' (inherited from parent, locked)',
  'accounts.form.typeAssets': 'Assets',
  'accounts.form.typeLiabilities': 'Liabilities',
  'accounts.form.typeExpenses': 'Expenses',
  'accounts.form.typeIncome': 'Income',
  'accounts.form.typeEquity': 'Equity',
  'accounts.form.displayNameLabel': 'Display name (Chinese, e.g. CMB Savings / Breakfast)',
  'accounts.form.displayNamePlaceholder': 'e.g. CMB Savings / Breakfast',
  'accounts.form.iconLabel': 'Icon (optional)',
  'accounts.form.nameHint':
    'The system generates a Beancount-valid English account name automatically; the Chinese name is only a display name. No need to build colon hierarchies by hand.',
  'accounts.form.asciiLabel': 'English account (optional, auto-generated if blank)',
  'accounts.form.asciiPlaceholder': 'e.g. Food / Cash (auto-generated if blank)',
  'accounts.form.asciiColonSpace': 'The English account cannot contain colons or spaces, e.g. Food',
  'accounts.form.asciiStartUpper':
    'The English account must start with an uppercase letter or digit, e.g. Food (use the display name for Chinese)',
  'accounts.form.parentLabel': 'Parent account',
  'accounts.form.parentFixedSuffix': ' (prefilled, locked)',
  'accounts.form.parentOptionalSuffix': ' (optional)',
  'accounts.form.noParentOption':
    'None · attach directly under the type root (creates {type}:NewSegment two-segment name)',
  'accounts.form.openDateLabel': 'Open date (no later than the ledger opening date {date})',
  'accounts.form.openingSection': 'Opening balance (optional)',
  'accounts.form.amountLabel': 'Amount (absolute value)',
  'accounts.form.amountPlaceholderCreate': 'e.g. 3200',
  'accounts.form.amountPlaceholderOpening': 'e.g. 12500',
  'accounts.form.directionLabel': 'Direction',
  'accounts.form.directionHold': 'Hold',
  'accounts.form.directionOwe': 'Owe',
  'accounts.form.openingHint':
    'Hold = positive, Owe = negative; the opening entry date is fixed to the ledger opening date {date}.',
  'accounts.form.notFundHint': '{type} accounts do not have an opening balance.',
  'accounts.form.openingExistingHint':
    'This account already has an opening balance; saving changes makes the backend create a reversal + new pair of entries (idempotency keys ensure repeated submits apply only once).',
  'accounts.form.openingNoneHint': 'This account has no opening balance yet.',
  'accounts.form.openingDateHint':
    'Opening entry date = ledger opening date {date}; currency {commodity}.',
  'accounts.form.errLoadOpening': 'Failed to load opening balance',
  'accounts.form.noticeZeroOpening': 'Opening balance is 0; skipping opening entry',
  'accounts.form.errViewer': 'View-only members cannot modify accounts',
  'accounts.form.errNoAccount': 'Missing account context',
  'accounts.form.errNameRequired': 'Please enter a display name for the account / category',
  'accounts.form.errOpenDateTooLate':
    'The open date ({openDate}) cannot be later than the ledger opening date ({ledgerDate})',
  'accounts.form.noticeCreated': 'Account created',
  'accounts.form.errSave': 'Save failed, please try again later',

  // Account display edit sheet (AccountEditSheet.vue)
  'accounts.edit.dialogLabel': 'Edit account display',
  'accounts.edit.title': 'Edit display · {name}',
  'accounts.edit.offlineHint': 'An internet connection is required to edit',
  'accounts.edit.displayNameLabel':
    'Display name (optional; clear to show the Beancount full name)',
  'accounts.edit.colorLabel': 'Color (optional, #RRGGBB)',
  'accounts.edit.colorPlaceholder': '#RRGGBB (clear to restore default)',
  'accounts.edit.errColorInvalid': 'The color must be a 6-digit #RRGGBB hex value',
  'accounts.edit.preview': 'Preview:',
  'accounts.edit.hint':
    'Display fields are not exported to .beancount and do not affect the numbers; other devices sync to match.',

  // Categories page (CategoriesView.vue)
  'categories.hero': 'Categories · categories are type accounts (three-level naming)',
  'categories.loading': 'Loading categories…',
  'categories.createTitle': 'New category',
  'categories.typeExpenses': 'Expenses',
  'categories.typeIncome': 'Income',
  'categories.noParentOption':
    'None · attach directly under the type root (creates {type}:NewSegment two-segment name)',
  'categories.namePlaceholder': 'Chinese display name, e.g. Breakfast',
  'categories.asciiPlaceholder': 'English account (optional), e.g. Food',
  'categories.creating': 'Creating…',
  'categories.create': 'Create',
  'categories.hint':
    'Only the Chinese display name is required; the system generates a Beancount-valid English full name automatically. Owners can optionally fill an English account (auto-generated if blank). Choosing a parent establishes an explicit parent-child relation via parent_uuid, so the hierarchy survives refresh / device switches. Drag ordering saves automatically and syncs to other devices.',
  'categories.groupHeading': '{label} ({n})',
  'categories.emptyGroup': 'No {label} yet.',
  'categories.groupExpenses': 'Expenses',
  'categories.groupIncome': 'Income',
  'categories.closed': 'Closed',
  'categories.subtotal': 'Subtotal',
  'categories.errViewerEdit': 'View-only members cannot modify accounts',
  'categories.errViewerSort': 'View-only members cannot reorder',
  'categories.sortSaving': 'Saving order…',
  'categories.sortSaved': 'Order saved ({n} items; other devices update after refresh)',
  'categories.sortPartial': 'Only {n}/{total} items updated; please refresh and verify',
  'categories.sortSyncFailedWith': 'Order draft kept on this device, but sync failed: {message}',
  'categories.sortSyncFailed':
    'Order draft kept on this device, but sync failed; please try again later',
  'categories.errNameRequired': 'Please enter a category name',
  'categories.errNameSegmentEmpty': 'Each segment of the category name cannot be empty',
  'categories.noticeCreated': 'Category "{name}" created',
  'categories.errCreate': 'Create failed, please try again later',
  'categories.errViewerDelete': 'View-only members cannot delete categories',
  'categories.noticeClosed': 'Category "{name}" closed',
  'categories.errClose': 'Close failed, please try again later',
  'categories.errLoad': 'Failed to load categories',
  'categories.closeTitle': 'Close category',
  'categories.closeBody':
    '"{name}" balance is {balance}. Closing a category uses Beancount close: a non-zero balance is rejected by the server with a difference breakdown. Continue?',
  'categories.processing': 'Working…',
  'categories.confirmClose': 'Confirm close',

  // Account detail page (AccountDetailView.vue)
  'accountDetail.back': '‹ Back',
  'accountDetail.meta': '{type} · opened {date}',
  'accountDetail.closedMeta': ' · closed ({date})',
  'accountDetail.loading': 'Loading account details…',
  'accountDetail.openingSetting': 'Opening balance setting',
  'accountDetail.balanceCalibrate': 'Balance calibration',
  'accountDetail.viewInGlobal': 'View this account in all transactions',
  'accountDetail.editVisual': 'Edit display (name / icon / color)',
  'accountDetail.closeAccount': 'Close account (Beancount close)',
  'accountDetail.closedHint': 'Closed accounts keep all historical transactions and are read-only.',
  'accountDetail.calibrateHint':
    'Basis is "as of the start of day D (end of the previous day)": the cumulative only counts transactions before D, and the balancing entry lands on D-1.',
  'accountDetail.asOfDate': 'Date D',
  'accountDetail.targetLabel': 'Target balance (may be negative)',
  'accountDetail.targetPlaceholder': 'e.g. 12350.00',
  'accountDetail.refreshPreview': 'Refresh preview',
  'accountDetail.loadingPreview': 'Loading preview…',
  'accountDetail.cumulativeLabel': 'Start-of-day cumulative by currency:',
  'accountDetail.historyLabel': 'Calibration history:',
  'accountDetail.reversed': 'Superseded (reversed by a newer version)',
  'accountDetail.active': 'Active',
  'accountDetail.diffLabel': 'Difference',
  'accountDetail.collapse': 'Collapse',
  'accountDetail.generate': 'Generate calibration entry',
  'accountDetail.confirmTitle': 'Confirm generating calibration entry',
  'accountDetail.confirmLaterWarn':
    'This will change all balances after D; make sure the target is correct.',
  'accountDetail.liabilityWarn':
    'A liability account with a positive target balance looks reversed (debts are negative here, e.g. -11398.55). Please confirm.',
  'accountDetail.liabilityConfirm': 'I confirm the target balance direction is correct',
  'accountDetail.confirmHint':
    'A regular transaction will be added (the day before {date}); the difference goes to Equity:Opening-Balances. Setting it again on the same date reverses the old calibration and creates a new version without overwriting the original transaction.',
  'accountDetail.generating': 'Generating…',
  'accountDetail.confirmGenerate': 'Confirm generate',
  'accountDetail.closeConfirmTitle': 'Confirm closing account',
  'accountDetail.closeConfirmBefore': 'This account appears in ',
  'accountDetail.closeConfirmAfter':
    ' non-deleted transactions; closing sets close_date and keeps all transaction references. Please make sure the balance is zero before continuing.',
  'accountDetail.balanceDiffLabel': 'Difference by currency:',
  'accountDetail.closing': 'Closing…',
  'accountDetail.confirmClose': 'Confirm close',
  'accountDetail.txnsTitle': 'Account transactions ({n})',
  'accountDetail.txnsEmpty': 'No transactions yet.',
  'accountDetail.runningBalance': 'Balance',
  'accountDetail.kindTransfer': 'Transfer',
  'accountDetail.kindOpening': 'Opening',
  'accountDetail.kindIncome': 'Income',
  'accountDetail.kindExpense': 'Expense',
  'accountDetail.errViewerOpening': 'View-only members cannot modify the opening balance',
  'accountDetail.errClosedOpening': 'A closed account cannot modify its opening balance',
  'accountDetail.errViewerClose': 'View-only members cannot close accounts',
  'accountDetail.errAlreadyClosed': 'This account is already closed',
  'accountDetail.noticeClosed': 'Closed "{name}"',
  'accountDetail.errClose': 'Close failed, please try again later',
  'accountDetail.noticeOpeningSaved':
    'Opening balance saved (modifying it makes the backend create a reversal + new pair of entries)',
  'accountDetail.errMissingId': 'Missing account id; open this page from the account list',
  'accountDetail.errNotFound':
    'Account not found (it may be closed or outside the current ledger)',
  'accountDetail.errLoad': 'Failed to load account details',
  'accountDetail.errBalance': 'Balance calibration failed, please try again later',
  'accountDetail.errCalibrateNotAllowed':
    'Only open asset / liability / equity accounts can calibrate balances',
  'accountDetail.errTargetInvalid':
    'Please enter a valid decimal target balance (may be negative)',
  'accountDetail.noticeCalibrated':
    'Generated calibration v{version} (old versions are only marked invalid, not deleted)',
  'accountDetail.noticeCalibratedTxn': 'Generated calibration entry (posted on {date})',

  // Data safety page (DataSafetyView.vue, stage 2 batch 3)
  'dataSafety.title': 'Data safety',
  'dataSafety.unbalancedTitle': 'Ledger is unbalanced; export blocked',
  'dataSafety.diffLabel': 'Difference: {diffs}',
  'dataSafety.noDiffDetail': '(server returned no details)',
  'dataSafety.unbalancedHint':
    'Fix the entries first so per-currency debits and credits balance and the export passes bean-check.',
  'dataSafety.exportTitle': 'Export',
  'dataSafety.exportDesc':
    'An identity check runs before export; if unbalanced, export is blocked and per-currency differences are listed.',
  'dataSafety.checking': 'Checking…',
  'dataSafety.exportBeancount': 'Export Beancount',
  'dataSafety.exportArchive': 'Export directory zip',
  'dataSafety.exportCsv': 'Export CSV',
  'dataSafety.importTitle': 'Import',
  'dataSafety.importDesc':
    'Beancount import creates a separate new ledger (never overwrites existing data); restoring a backup replaces the whole database and requires a confirmation word.',
  'dataSafety.revivalNote':
    'Restoring an old backup brings deleted data back: the backup contains transactions that had not been deleted at the time, so they reappear in the ledger and trash after restore. Permanent deletion only affects the current database and cannot be recovered from outside a backup.',
  'dataSafety.goImport': 'Import Beancount',
  'dataSafety.goRestore': 'Restore backup',
  'dataSafety.backupTitle': 'Backups',
  'dataSafety.backingUp': 'Backing up…',
  'dataSafety.loadingBackups': 'Loading backup status…',
  'dataSafety.retry': 'Retry',
  'dataSafety.noBackups': 'No backups yet. Create one now and keep a copy on another device.',
  'dataSafety.recentBackup': 'Latest backup: {time} · {count} successful · {size} used',
  'dataSafety.runBackup': 'Back up now',
  'dataSafety.downloadLatest': 'Download latest backup',
  'dataSafety.collapseList': 'Collapse list',
  'dataSafety.viewAll': 'View all ({n})',
  'dataSafety.triggerManual': 'Manual',
  'dataSafety.triggerAuto': 'Automatic',
  'dataSafety.backupMeta': '{trigger} · {size} · {time}',
  'dataSafety.backupFailed': 'Failed: {reason}',
  'dataSafety.unknownReason': 'Unknown reason',
  'dataSafety.download': 'Download',
  'dataSafety.backupHint':
    'Backups contain complete data for all ledgers; save the file to another disk.',
  'dataSafety.noticeBackupCreated': 'Backup created',
  'dataSafety.noticeDownloaded': 'Downloaded {name}',
  'dataSafety.noticeExported': 'Exported {filename}',
  'dataSafety.noticeExportedCsv': 'Exported CSV ({n} transactions)',
  'dataSafety.identityCheckFailed': 'Identity check before export failed: {message}',
  'dataSafety.exportedUnbalanced':
    'Exported, but the response header reports the ledger is unbalanced: {diffs}',
  'dataSafety.exportFailed': 'Export failed (network required): {message}',
  'dataSafety.csvExportFailed': 'CSV export failed: {message}',
  'dataSafety.errGeneric': 'Operation failed, please try again later',
  'dataSafety.errLogin': 'Session expired, please sign in again',
  'dataSafety.errForbidden': 'Administrator permission required',
  'dataSafety.errConflict': 'A backup is already running, please try again later',
  'dataSafety.errDisabled': 'Backup is disabled on the server',
  'dataSafety.errNetwork': 'Network error, please check your connection and retry',
  'dataSafety.diffSeparator': ', ',

  // Restore backup page (RestoreView.vue, stage 2 batch 3)
  'restore.title': 'Restore backup',
  'restore.subtitle': 'Restore the whole database from a .db backup',
  'restore.adminOnlyTitle': 'Only the system administrator can restore backups',
  'restore.adminOnlyBody':
    'Restoring replaces all ledger and user data. Please contact the system administrator.',
  'restore.step1Title': '① Select a backup file',
  'restore.step1Desc':
    'Supports .db backups generated by this system (including copies downloaded from other devices).',
  'restore.previewing': 'Checking…',
  'restore.startPreview': 'Start check',
  'restore.rejectTitle': 'Check failed; restore rejected',
  'restore.pickAgain': 'Choose another file',
  'restore.step2Title': '② Confirm overwrite scope',
  'restore.colContent': 'Item',
  'restore.colBackup': 'In backup',
  'restore.colCurrent': 'Current',
  'restore.compareUsers': 'Users',
  'restore.compareLedgers': 'Ledgers',
  'restore.compareAccounts': 'Accounts',
  'restore.compareTransactions': 'Transactions',
  'restore.schemaVersion': 'schema version: backup v{schema} / current v{current}',
  'restore.confirmBefore': 'Type ',
  'restore.confirmAfter': ' to unlock:',
  'restore.restoring': 'Restoring…',
  'restore.execute': 'Restore now',
  'restore.cancel': 'Cancel',
  'restore.doneTitle': 'Restore complete',
  'restore.replaced':
    'Replaced: users {users} · ledgers {ledgers} · accounts {accounts} · transactions {transactions}',
  'restore.snapshot': 'Pre-restore snapshot: {snapshot} (restore this backup again to undo)',
  'restore.instanceUpdated':
    'Database instance updated: {id}; other devices will resync automatically.',
  'restore.reloginHint': 'Please sign in again with an account from the backup',
  'restore.relogin': 'Sign in again',
  'restore.reject.not_sqlite': 'Not a valid SQLite database file',
  'restore.reject.integrity_failed': 'The backup file is corrupted and fails the integrity check',
  'restore.reject.not_our_backup': 'Missing core tables; this is not a backup from this system',
  'restore.reject.future_version':
    'The backup comes from a newer version; downgrading would drop columns',
  'restore.reject.file_too_large': 'The backup file exceeds the 512MB limit',
  'restore.reject.generic': 'The backup failed the pre-check',
  'restore.errLogin': 'Session expired, please sign in again and retry',
  'restore.errForbidden': 'Only the system administrator can restore backups',
  'restore.errUpload': 'Upload failed: make sure you selected a .db backup file',
  'restore.errServer':
    'Server-side restore failed and no data was changed; try again later or contact the administrator',
  'restore.errGeneric': 'Restore request failed, please try again later',

  // Import Beancount page (ImportView.vue, stage 2 batch 3)
  'import.title': 'Import Beancount',
  'import.heroCurrent':
    'Parsed into the current ledger: same-name accounts are reused and duplicates skipped',
  'import.heroNew': 'Parsed into a separate new ledger without overwriting existing data',
  'import.step1Title': '① Choose import target',
  'import.targetCurrent': 'Import into current ledger',
  'import.targetNew': 'Create new ledger',
  'import.targetCurrentDesc':
    'Writes into the selected ledger: same-name accounts are reused (type/currency restrictions must match), duplicate transactions are skipped by content; pad/balance unsupported.',
  'import.targetNewDesc':
    'Creates a new ledger: same-name ledgers get a numeric suffix; pad expands into balancing entries, balance becomes a post-import self-check.',
  'import.step2Title': '② Provide file content',
  'import.inputDesc':
    "Paste text or upload a .beancount file; only the syntax subset used by this system's export is supported.",
  'import.placeholder':
    'option "title" "Family ledger"\n2026-11-01 open Assets:Cash:CNY\n2026-11-02 * "Breakfast"\n  Expenses:Food:CNY -12.50 CNY\n  Assets:Cash:CNY',
  'import.fileLoaded': 'File loaded: {name}',
  'import.parsing': 'Parsing…',
  'import.parsePreview': 'Parse preview',
  'import.clear': 'Clear',
  'import.rejectTitle': 'Check failed; whole import rejected',
  'import.rejectFallback': 'The file contains unsupported syntax; the whole import was rejected',
  'import.readFileFailed': 'Failed to read the file; retry or paste the text directly',
  'import.conflictCount': '{n} conflicts with the target ledger:',
  'import.warningsTitle':
    '{n} warning(s) found (import not blocked; please verify the source file):',
  'import.padBalanceReprocess':
    'File contains pad / balance directives ({n}), recalculated against the current ledger:',
  'import.padBalanceList': 'File contains pad / balance directives ({n}):',
  'import.padRowLine': 'Line {line}',
  'import.padTag': 'Top-up (pad)',
  'import.balanceTag': 'Assertion (balance)',
  'import.padAmounts': 'target {target} · cumulative {cumulative} · diff {diff}',
  'import.padNotSupportedCurrent':
    'Current-ledger mode does not support pad/balance: expand them into regular transactions and re-import, or switch to new-ledger mode.',
  'import.rejectFooter':
    'Edit the file or switch the import target and parse again; no ledger data is produced.',
  'import.step3Title': '③ Confirm import content',
  'import.confirmNewLedger': 'A new ledger "{name}" will be created.',
  'import.confirmNewLedgerWithTitle':
    'A new ledger "{name}" will be created (source title: {title}).',
  'import.confirmCurrent':
    'Writes into the current ledger; same-name accounts are reused, duplicate transactions skipped, existing data untouched.',
  'import.duplicateWarning':
    'A ledger with the same name and the same transaction count exists; this looks like a duplicate import. Continue if it is intentional (the original ledger is not overwritten).',
  'import.importing': 'Importing…',
  'import.execute': 'Run import',
  'import.cancel': 'Cancel',
  'import.doneTitle': 'Import complete',
  'import.resultNew': 'New ledger "{name}": {accounts} new accounts · {txns} transactions.',
  'import.resultCurrent':
    'Wrote into the current ledger: {accounts} new accounts · {reused} reused accounts · {txns} new transactions.',
  'import.resultCurrentSkipped':
    'Wrote into the current ledger: {accounts} new accounts · {reused} reused accounts · {txns} new transactions · {skipped} duplicates skipped.',
  'import.batchNote':
    "Batch {id}: undo is available if the import was wrong (only this batch's new content is rolled back).",
  'import.gotoLedgers': 'Go to ledgers',
  'import.undoing': 'Undoing…',
  'import.undo': 'Undo this import',
  'import.importAnother': 'Import another',
  'import.close': 'Close',
  'import.undoResult':
    'Undone: {txns} transactions · {postings} postings · {accounts} accounts · {commodities} currencies.',
  'import.summaryNewAccounts': 'New accounts',
  'import.summaryReuseAccounts': 'Reused accounts',
  'import.summaryNewTransactions': 'New transactions',
  'import.summarySkipTransactions': 'Skipped transactions (already exist)',
  'import.summaryNewCommodities': 'New currencies',
  'import.conflict.account_conflict': 'Account conflict',
  'import.conflict.commodity_conflict': 'Currency conflict',
  'import.conflict.undeclared_account': 'Undeclared account',
  'import.conflict.unbalanced': 'Unbalanced',
  'import.conflict.pad_balance_unsupported': 'pad/balance unsupported',
  'import.conflict.generic': 'Conflict',
  'import.errorLine': 'Line {line}: {msg}',
  'import.lineRef': 'Line {line}',
  'import.conflictWhere': '{where}:',
  'import.conflictEntry': '[{label}] {where}{reason}',
  'import.errLogin': 'Session expired, please sign in again and retry',
  'import.errInvalid': 'Invalid request: make sure the file content is Beancount text',
  'import.errServer': 'Server-side import failed and no ledger was created; try again later',
  'import.errGeneric': 'Import request failed, please try again later',
}
