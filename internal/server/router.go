package server

import (
	"net/http"

	"familyledger/internal/handler"
	"familyledger/internal/service"
)

// newRouter 注册所有路由并包裹中间件。路由路径与 HTTP 方法保持不变，
// 确保前端与既有冒烟脚本无需改动。
//
// webRoot 为前端构建产物目录；非空且存在时，未匹配的路径交由静态托管处理
// （含 SPA 回退），实现「一个进程 + 一个端口」开箱可用。
//
// corsCfg 可选（不传 = 仅同源）：组合根按 LEDGER_CORS_ORIGINS 解析后传入；
// 既有测试的 newRouter(h, svc, "") 调用无需改动。
func newRouter(h *handler.Handler, svc *service.Service, webRoot string, corsCfg ...corsOptions) http.Handler {
	var corsOpt corsOptions
	if len(corsCfg) > 0 {
		corsOpt = corsCfg[0]
	}
	mux := http.NewServeMux()

	// 健康检查：**只允许 GET**。不套 methodSwitch 时任意方法（含 DELETE）都会
	// 执行并返回 200——「文档说 GET、实现收任意」与「参数存在即生效」同属一类
	// 不报错的谎言（T62 审计 D1）。
	mux.HandleFunc("/api/health", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet: h.HandleHealth,
	}))

	// 认证端点（公开：register/login；其余自校验）
	mux.HandleFunc("/api/auth/register", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPost: h.HandleRegister,
	}))
	mux.HandleFunc("/api/auth/login", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPost: h.HandleLogin,
	}))
	mux.HandleFunc("/api/auth/logout", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPost: h.HandleLogout,
	}))
	mux.HandleFunc("/api/auth/me", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet: h.HandleMe,
	}))
	mux.HandleFunc("/api/auth/refresh", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPost: h.HandleRefresh,
	}))
	mux.HandleFunc("/api/auth/change-password", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPost: h.HandleChangePassword,
	}))

	// 登录设备（M3）：列出 / 吊销单个 / 退出其他设备
	mux.HandleFunc("/api/auth/sessions", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet: h.HandleListSessions,
	}))
	mux.HandleFunc("/api/auth/sessions/revoke-others", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPost: h.HandleRevokeOtherSessions,
	}))
	mux.HandleFunc("/api/auth/sessions/{sid}", methodSwitch(map[string]http.HandlerFunc{
		http.MethodDelete: h.HandleRevokeSession,
	}))

	// 业务端点
	mux.HandleFunc("/api/accounts", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet:  h.HandleListAccounts,
		http.MethodPost: h.HandleCreateAccount,
	}))
	// 分类拖拽排序批量提交（P0）：字面量路径比 `/api/accounts/{uuid}` 更具体，
	// Go 1.22 ServeMux 优先命中本条（注册顺序无关）；批 II 起 `/api/accounts/{uuid}`
	// 也注册了 PATCH（展示字段修改），两者不冲突——字面量更具体恒胜出
	// （详见 accounts_sort_order_http_test.go / account_visual_http_test.go 的路由回归）。
	mux.HandleFunc("/api/accounts/sort-order", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPatch: h.HandleUpdateAccountSortOrder,
	}))
	mux.HandleFunc("/api/accounts/{uuid}/opening", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet:  h.HandleGetOpening,
		http.MethodPost: h.HandleSetOpening,
	}))
	// 余额校准（0.6.0 S4：GET 预检 viewer 可读 / POST 非 viewer）。
	mux.HandleFunc("/api/accounts/{uuid}/balance", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet:  h.HandleGetBalance,
		http.MethodPost: h.HandleSetBalance,
	}))
	// 批 II：PATCH = 修改展示字段（display_name / icon / color 白名单），
	// 与既有 DELETE（Beancount close）同路径不同方法；viewer 由 middleware 403。
	mux.HandleFunc("/api/accounts/{uuid}", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPatch:  h.HandleUpdateAccountVisual,
		http.MethodDelete: h.HandleDeleteAccount,
	}))
	// 币种管理（0.6.0 S2：GET/POST 列表与新建；DELETE 软删）。
	mux.HandleFunc("/api/commodities", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet:  h.HandleListCommodities,
		http.MethodPost: h.HandleCreateCommodity,
	}))
	mux.HandleFunc("/api/commodities/{uuid}", methodSwitch(map[string]http.HandlerFunc{
		http.MethodDelete: h.HandleDeleteCommodity,
	}))
	// 恒等式检查（只读）：首页余额校验提示。
	mux.HandleFunc("/api/identity/check", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet: h.HandleIdentityCheck,
	}))
	// 资产统计（B6）：年度资产 / 负债 / 净资产月度序列（只读，viewer 可读）。
	// 金额由服务端聚合（big.Rat 定点），前端不再重放全部交易。
	mux.HandleFunc("/api/assets/series", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet: h.HandleAssetSeries,
	}))
	mux.HandleFunc("/api/transactions", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet:  h.HandleListTransactions,
		http.MethodPost: h.HandleCreateTransaction,
	}))
	// 交易回收站（M3）：列表 + 恢复。字面量路径比 {uuid} 更具体，ServeMux 优先匹配。
	// B7 起该 GET 的响应追加 purge_summary / purge_log（不新开端点）。
	mux.HandleFunc("/api/transactions/trash", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet: h.HandleListTrash,
	}))
	// B7 永久删除（当时路径 41→43 条；P0 分类排序端点顺延为第 44 条）。
	// 模式优先级：`/api/transactions/trash/purge` 是字面量，比 `/api/transactions/{uuid}/purge`
	// 更具体，Go 1.22+ ServeMux 选更具体者（注册顺序无关，也不会 panic）；
	// 因此 `DELETE /api/transactions/trash/purge` 会命中字面量模式 → 405，
	// 不会掉进 {uuid}/purge 把 "trash" 当 uuid 去删。
	mux.HandleFunc("/api/transactions/trash/purge", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPost: h.HandlePurgeTrash,
	}))
	mux.HandleFunc("/api/transactions/{uuid}/purge", methodSwitch(map[string]http.HandlerFunc{
		http.MethodDelete: h.HandlePurgeTransaction,
	}))
	mux.HandleFunc("/api/transactions/{uuid}/restore", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPost: h.HandleRestoreTransaction,
	}))
	// 标签原地更新（注解层）：字面后缀 /tags 与 /tag-edits 比 /api/transactions/{uuid}
	// 更具体，Go 1.22 ServeMux 优先命中，不会掉进 PATCH 的经济事实冲正路径。
	mux.HandleFunc("/api/transactions/{uuid}/tags", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPut: h.HandleUpdateTransactionTags,
	}))
	mux.HandleFunc("/api/transactions/{uuid}/tag-edits", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet: h.HandleListTagEdits,
	}))
	mux.HandleFunc("/api/transactions/{uuid}", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPatch:  h.HandleUpdateTransaction, // 0.6.0 S6：修改 = 冲正 + 新建
		http.MethodDelete: h.HandleDeleteTransaction,
	}))

	// 账本管理（多账本 P1-C：列表/创建/设置）
	mux.HandleFunc("/api/ledgers", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet:  h.HandleListLedgers,
		http.MethodPost: h.HandleCreateLedger,
	}))
	mux.HandleFunc("/api/ledgers/{id}", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPatch:  h.HandleUpdateLedger,
		http.MethodDelete: h.HandleDeleteLedger,
	}))

	// 成员管理
	mux.HandleFunc("/api/ledger/members", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet:  h.HandleListMembers,
		http.MethodPost: h.HandleAddMember,
	}))
	mux.HandleFunc("/api/ledger/members/{userID}", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPost:   h.HandleUpdateMember,
		http.MethodDelete: h.HandleRemoveMember,
	}))
	mux.HandleFunc("/api/ledger/members/{userID}/reset-password", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPost: h.HandleResetMemberPassword,
	}))

	// 数据库世代（库标识）：已登录用户可读；restore 成功后由业务层重写。
	mux.HandleFunc("/api/db/instance", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet: h.HandleDBInstance,
	}))

	// 导出与同步：**方法限定**（T62 审计 D1）。原先这四条直接注册，handler 又不查
	// `r.Method`，于是 `DELETE /api/export` 会真的执行导出、`GET /api/sync/push`
	// 会进到 handler 里去解 body（返回 400 EOF 而不是 405）。
	mux.HandleFunc("/api/export", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet: h.HandleExport,
	}))
	mux.HandleFunc("/api/export/archive", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet: h.HandleExportArchive,
	}))
	mux.HandleFunc("/api/sync/pull", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet: h.HandleSyncPull,
	}))
	mux.HandleFunc("/api/sync/push", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPost: h.HandleSyncPush,
	}))

	// 备份（全库级操作，仅系统管理员；权限校验在 handler 内完成）
	mux.HandleFunc("/api/backup/list", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet: h.HandleBackupList,
	}))
	mux.HandleFunc("/api/backup/download", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet: h.HandleBackupDownload,
	}))
	mux.HandleFunc("/api/backup/run", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPost: h.HandleBackupRun,
	}))
	// 还原（全库级，仅系统管理员）：预检（只读）+ 执行（需二次确认词）
	mux.HandleFunc("/api/backup/restore/preview", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPost: h.HandleBackupRestorePreview,
	}))
	mux.HandleFunc("/api/backup/restore", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPost: h.HandleBackupRestore,
	}))

	// 导入（Beancount → 当前账本 / 新建账本）：自 S5 起与其他业务端点一致，
	// 需带 X-Ledger-Id（缺失回退该用户所属最小有效账本），由 middleware 校验
	// 账本成员身份与 viewer 只读。target 经 ?target=current|new 指定（默认 current）。
	// 预检（只读）+ 执行 + 批次撤销；支持 JSON {"text"} 或 multipart file 两种提交形态。
	mux.HandleFunc("/api/import/beancount/preview", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPost: h.HandleImportPreview,
	}))
	mux.HandleFunc("/api/import/beancount", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPost: h.HandleImport,
	}))
	// 批次撤销（0.6.0 S5）：?batch_id= 指定要回滚的导入批次，仅删本批新建实体与本批交易。
	mux.HandleFunc("/api/import/beancount/undo", methodSwitch(map[string]http.HandlerFunc{
		http.MethodPost: h.HandleImportUndo,
	}))

	// 注册开关（B-4）：GET 公开 / POST 仅系统管理员
	mux.HandleFunc("/api/settings/registration", methodSwitch(map[string]http.HandlerFunc{
		http.MethodGet:  h.HandleGetRegistration,
		http.MethodPost: h.HandleSetRegistration,
	}))

	// 前端静态资源与 SPA 回退（兜底路由，必须最后注册）。
	// ServeMux 按最长前缀匹配，所有 /api/ 精确路由优先于此。
	mux.HandleFunc("/", spaHandler(webRoot))

	// cors 必须包在最外层：浏览器对带 Authorization / X-Ledger-Id 等自定义头的
	// 请求会先发 OPTIONS 预检，预检请求没有 token，若先经过 authMiddleware 会被 401
	// 拦截（到不了 cors 的 OPTIONS 处理），导致浏览器拒绝发真实请求、前端表现为「无响应」。
	// requestContextMiddleware 紧随 cors 之后：生成 request_id 并包住写头，
	// 这样鉴权中间件的 401/403 与 handler 的 4xx/5xx 都能被记录。
	return cors(corsOpt, requestContextMiddleware(authMiddleware(h, svc, mux)))
}

// methodSwitch 按 HTTP 方法分发到对应 handler。
func methodSwitch(table map[string]http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h, ok := table[r.Method]; ok {
			h(w, r)
			return
		}
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
