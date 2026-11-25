/**
 * 源语言字典（简体中文）——i18n 阶段 0 试点。
 *
 * 规则：
 * - **flat 单层对象**，键形如 'shell.appTitle'，禁止嵌套；
 * - 本阶段只收录三个试点文件（LoginView.vue / navItems.ts / StateCard.vue）
 *   实际用到的 key，value **从既有源码逐字节复制**（含全角标点、空格、
 *   省略号——严禁顺手润色，否则 shellNav.test.ts / StateCard.test.ts /
 *   LoginView.batch3.test.ts 的既有断言会红）；
 * - 新增 key 顺延追加，en.ts 用 Record<MessageKey, string> 强制同步补齐英文；
 * - en 缺 key 时 t() 回退到本字典，仍缺才返回 key 本身。
 */
export const zhCN = {
  // 壳层：应用标题（index.html 的 <title> 兜底文案；document.title 由 setLocale/initLocale 接管）
  'shell.appTitle': '家庭记账',

  // 壳层导航（navItems.ts）：五视图 / 管理组 / 移动底栏短名
  'shell.nav.bills': '账单',
  'shell.nav.search': '搜索账单',
  'shell.nav.stats': '统计账单',
  'shell.nav.assets': '资产',
  'shell.nav.assetStats': '资产统计',
  'shell.nav.trash': '回收站',
  'shell.nav.accounts': '账户管理',
  'shell.nav.categories': '分类管理',
  'shell.nav.commodities': '币种管理',
  'shell.nav.members': '成员管理',
  'shell.nav.ledgers': '账本管理',
  'shell.nav.sessions': '登录设备',
  'shell.nav.dataSafety': '数据安全',
  'shell.nav.sync': '同步状态',
  'shell.nav.settings': '设置',
  'shell.nav.more': '更多',
  'shell.tab.stats': '统计',

  // 通用四态默认文案（StateCard.vue）
  'common.loading': '正在加载…',
  'common.empty': '暂无数据',
  'common.error': '加载失败',
  'common.retry': '重试',

  // 登录 / 注册页（LoginView.vue）
  'login.heroTagline': '家庭记账 · 每一笔都清清楚楚',
  'login.username': '用户名',
  'login.displayName': '显示名（可选）',
  'login.displayNamePlaceholder': '如 阿文',
  'login.password': '密码',
  'login.working': '处理中…',
  'login.register': '注 册',
  'login.login': '登 录',
  'login.switchToRegister': '没有账号？注册',
  'login.switchToLogin': '已有账号？返回登录',
  'login.hintRegistrationOpen':
    '首个注册的账号自动成为系统管理员并创建默认账本；之后的账号需管理员开放注册或由 owner 邀请加入账本。',
  'login.hintRegistrationClosed':
    '注册已关闭：请由管理员在「设置 → 开放注册」中开启，或由账本 owner 通过成员管理邀请你加入。',
  'login.noteResetPassword': '忘记密码？请联系管理员（owner）在成员管理中重置。',
  'login.noteInviteOnly': '新账号需由 owner 邀请加入账本后才能记账。',
  'login.errRegistrationClosed': '注册已关闭，请联系管理员在设置中开放，或由 owner 邀请加入',
  'login.errRequired': '请输入用户名和密码',
  'login.errPasswordTooShort': '注册密码至少 6 位',
  'login.errGeneric': '操作失败，请稍后重试',

  // 壳层：顶栏（ShellHead）/ 账本行 / 隐私 / 更多
  'shell.currentLedger': '当前账本：{name}',
  'shell.currentLedgerWithUser': '当前账本：{name} · {user}',
  'shell.showAmount': '显示金额',
  'shell.hideAmount': '隐藏金额',
  'shell.moreActions': '更多操作',

  // 壳层：移动底栏（ShellTabs）/ PC 侧栏（ShellSidebar）
  'shell.bottomNav': '底部导航',
  'shell.mainNav': '主导航',
  'shell.record': '记一笔',
  'shell.brandSub': '家庭共享账本',
  'shell.manageGroup': '管理 · {count}',
  'shell.prerelease': '预览版',

  // 壳层：更多弹层（MoreSheet）
  'shell.manageAndTools': '管理与工具',
  'shell.accountSection': '账号',
  'shell.changePassword': '修改密码',
  'shell.sessionSection': '会话',
  'shell.logout': '退出登录',

  // 壳层：账本切换（LedgerSwitcher）
  'shell.switchLedger': '切换账本',
  'shell.noLedgers': '暂无账本',
  'shell.roleOwner': '所有者',
  'shell.roleEditor': '可编辑',
  'shell.roleViewer': '只读',

  // 壳层：同步徽标（SyncBadge）
  'shell.syncPendingFailed': '待同步 {pending} · 失败 {dead}',
  'shell.syncFailed': '同步失败 {dead}',
  'shell.syncPending': '待同步 {pending}',
  'shell.offline': '离线',
  'shell.syncStatusLabel': '同步状态：{label}',

  // 壳层：月份 / 年份选择（MonthPicker / YearPicker / SelectSheet）
  'shell.selectMonthTitle': '选择月份',
  'shell.selectMonthDialog': '选择账期月份',
  'shell.prevYear': '上一年',
  'shell.nextYear': '下一年',
  'shell.yearLabel': '{year} 年',
  'shell.yearCellLabel': '{year} 年',
  'shell.monthGridLabel': '{year} 年月份',
  'shell.monthCellLabel': '{year} 年 {month} 月',
  'shell.hasData': '，有数据',
  'shell.monthShort': '{month}月',
  'shell.selectYearTitle': '选择年份',
  'shell.selectYearDialog': '选择账期年份',
  'shell.prevYearPage': '上一页年份',
  'shell.nextYearPage': '下一页年份',
  'shell.yearGrid': '年份',
  'shell.closeDialog': '关闭{title}',

  // 壳层：AppLayout 提示与 PWA 更新横幅
  'shell.navPending': '{label}将在后续批次开放',
  'shell.viewerCannotRecord': '只读成员不能记账',
  'shell.needsInvite': '请先等待 owner 邀请加入账本',
  'shell.updateAvailable': '有新版本可用',
  'shell.updateNow': '立即更新',

  // 设置页：语言切换入口（阶段 1；本页其余文案阶段 2 迁移）
  'settings.language': '语言 / Language',
  'settings.languageDialog': '选择语言',

  // API 错误码文案（阶段 1）：errors.ts 的 CODE_MESSAGES 迁入，key = apiErrors.<稳定码>，
  // value 逐字节复制，严禁润色（errors.qa.test.ts 既有断言依赖原文）。
  // ---- 0.6.0 账本删除（S1）----
  'apiErrors.ledger_has_members': '还有其他成员未移除，请先在成员管理中移除后再删除账本',
  'apiErrors.last_ledger': '这是最后一个有效账本，不能删除',
  'apiErrors.ledger_deleted': '该账本已删除，请切换到其他账本',
  // ---- 0.6.0 账户 / 币种（S2）----
  'apiErrors.account_name_invalid': '账户名不符合 Beancount 格式要求，请检查根类别与首段命名',
  'apiErrors.account_name_exists': '该账户名已被占用，请换一个名称',
  'apiErrors.parent_not_found': '父账户不存在或属于其他账本',
  'apiErrors.parent_type_mismatch': '父账户类型与子账户不匹配',
  // ---- 批 II 账户展示字段（PATCH / create 共用）----
  'apiErrors.account_visual_invalid': '图标需不超过 8 个字符的 emoji，颜色需为 #RRGGBB 格式',
  'apiErrors.commodity_exists': '该币种已存在',
  'apiErrors.commodity_in_use': '该币种已被账户、交易或价格引用，不能删除',
  // ---- 0.6.0 余额校准（S4）----
  'apiErrors.balance_date_invalid':
    '指定日期不合法或超出允许范围，须不早于 max(账户开户日, 账本期初日期) 且不晚于今日',
  'apiErrors.balance_date_too_early':
    '指定日期过早，无法在 max(账户开户日, 账本期初日期) 之后生成补平分录',
  'apiErrors.opening_equity_closed': '期初余额权益账户已关闭，无法生成校准分录，请先恢复该账户',
  // ---- 0.6.0 交易修改（S6）----
  'apiErrors.txn_edit_forbidden': '只能修改自己记的账，或由账本 owner 修改',
  'apiErrors.txn_not_editable': '期初 / 冲正 / 校准交易不能修改',
  'apiErrors.txn_already_reversed': '该交易已被冲正，请修改最新版本',
  // ---- 0.6.0 导入（S5）----
  'apiErrors.import_pad_balance_unsupported':
    '文件含 pad / balance 指令，请展开成普通交易后重导，或改用新建账本模式',
  'apiErrors.import_unbalanced': '导入交易存在借贷不平，请检查预检列出的行号',
  'apiErrors.import_account_conflict': '同名账户类型或币种限制冲突，无法复用',
  'apiErrors.import_batch_not_found': '未找到该导入批次，无法撤销',
  // ---- 0.5.1 及更早的既有在线码（同源镜像，避免页面各自硬编码）----
  'apiErrors.account_not_found': '账户不存在',
  'apiErrors.account_closed': '账户已关闭，不能记账',
  'apiErrors.account_balance_not_zero': '账户余额不为 0，请先转出',
  'apiErrors.account_open_date_after_ledger': '开户日期不能晚于账本期初日期',
  'apiErrors.opening_conflict': '期初余额冲突，请刷新后重试',
  'apiErrors.opening_via_api_only': '期初余额请在在线端设置',
  'apiErrors.opening_amount_invalid': '期初金额不合法',
  'apiErrors.opening_direction_invalid': '期初方向不合法',
  'apiErrors.opening_commodity_mismatch': '期初币种与账户限定币种不一致',
  'apiErrors.opening_account_not_openable': '该账户不能设置期初余额',
  'apiErrors.opening_date_mismatch': '期初日期与账本设置不一致',
  'apiErrors.ledger_opening_date_invalid': '期初日期需为 YYYY-MM-DD 且不晚于今日',
  'apiErrors.ledger_opening_date_after_first_txn': '期初日期不能晚于账本最早交易',
  'apiErrors.idempotency_key_deleted': '该请求的交易已被删除，请重新提交',
  'apiErrors.idempotency_payload_mismatch': '同一请求标识对应了不同内容，请重新提交',
  'apiErrors.csrf_required': '缺少 CSRF 头，请刷新页面后重试',
  // ---- 客户端本地错误（client.ts 网络失败提示）----
  'apiErrors.network_error': '网络连接失败，请检查网络后重试',
}

/** 消息键类型：由源语言字典推导；en.ts 必须逐键给出英文（缺失即 typecheck 红）。 */
export type MessageKey = keyof typeof zhCN
