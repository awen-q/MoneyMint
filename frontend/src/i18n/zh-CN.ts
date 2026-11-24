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
}

/** 消息键类型：由源语言字典推导；en.ts 必须逐键给出英文（缺失即 typecheck 红）。 */
export type MessageKey = keyof typeof zhCN
