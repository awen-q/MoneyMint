package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"familyledger/internal/auth"
	"familyledger/internal/domain"
	"familyledger/internal/service"
)

// HandleListTransactions 列出交易（含分录），支持服务端筛选 + keyset 分页。
//
// 参数全部可选：from / to / kind / account / category / member / tag（可重复）/
// currency / q / limit / cursor。语义与容错口径见 service.TransactionListQuery。
//
// 响应形状（硬约束）：
//   - 未显式给 limit（或 limit=0）→ **只有 `{"transactions": [...]}` 一个键**。
//     现网有 8 处调用走全量，多一个键或默认截断都会改变它们的行为。
//   - limit>0 → 追加 total / has_more，无下一页时省略 next_cursor。
//   - with=summary → 追加 summary（分币种收支汇总，见 service.TransactionSummary）。
func (h *Handler) HandleListTransactions(w http.ResponseWriter, r *http.Request) {
	ledgerID, ok := auth.LedgerID(r.Context())
	if !ok {
		writeError(w, domain.ErrForbidden)
		return
	}
	uid, _ := auth.UserID(r.Context())
	res, err := h.svc.ListTransactionsPage(ledgerID, uid, parseTransactionListQuery(r))
	if err != nil {
		writeError(w, err)
		return
	}
	body := map[string]any{"transactions": res.Transactions}
	if res.Paged {
		body["total"] = res.Total
		body["has_more"] = res.HasMore
		if res.HasMore && res.NextCursor != "" {
			body["next_cursor"] = res.NextCursor
		}
	}
	if res.Summary != nil {
		body["summary"] = res.Summary
	}
	writeJSON(w, http.StatusOK, body)
}

// parseTransactionListQuery 从 URL query 读取筛选/分页参数。
//
// 本层只做「取字符串 + 空值容错」，不做格式校验：
// 日期形状、kind 白名单、limit 区间、游标解析都在 service 层统一处理，
// 避免校验规则散落在两层（一处改了另一处忘掉）。
//
// account / category / limit 的非法值按「忽略」处理（= 0），与契约里
// 「非法格式忽略该参数」的口径一致。
func parseTransactionListQuery(r *http.Request) service.TransactionListQuery {
	q := r.URL.Query()
	return service.TransactionListQuery{
		From:        q.Get("from"),
		To:          q.Get("to"),
		Kind:        q.Get("kind"),
		AccountID:   queryInt64(q.Get("account")),
		CategoryID:  queryInt64(q.Get("category")),
		Member:      q.Get("member"),
		Tags:        q["tag"], // 可重复：?tag=a&tag=b
		Currency:    q.Get("currency"),
		Keyword:     q.Get("q"),
		Limit:       int(queryInt64(q.Get("limit"))),
		Cursor:      q.Get("cursor"),
		WithSummary: hasWithToken(q["with"], "summary"),
	}
}

// hasWithToken 判断 ?with= 列表是否包含指定能力。
//
// 支持 `with=summary` 与逗号分隔的 `with=summary,other`（可重复键同理），
// 便于以后追加导出所需的能力位而不改既有调用方；未识别的能力位一律忽略
// （与 kind/from 的「非法值忽略」口径一致，不报错）。
func hasWithToken(values []string, want string) bool {
	for _, value := range values {
		for _, token := range strings.Split(value, ",") {
			if strings.TrimSpace(token) == want {
				return true
			}
		}
	}
	return false
}

// queryInt64 解析整数 query 参数；空串或非法值返回 0（调用方按「不筛」处理）。
// 负数在 service 层按全量 / 不筛处理，这里不做限制。
func queryInt64(raw string) int64 {
	n, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil {
		return 0
	}
	return n
}

// HandleCreateTransaction 创建交易（postings 用 account_id 引用）。
func (h *Handler) HandleCreateTransaction(w http.ResponseWriter, r *http.Request) {
	ledgerID, ok := auth.LedgerID(r.Context())
	if !ok {
		writeError(w, domain.ErrForbidden)
		return
	}
	var req struct {
		Date        string   `json:"date"`
		Flag        string   `json:"flag"`
		Description string   `json:"description"`
		Tags        []string `json:"tags"`
		// ClientRequestID 是客户端幂等键（可选）。为兼容旧前端，缺省即关闭幂等。
		// 与 Idempotency-Key 头同时存在时以头为准（头是标准位置，body 是历史兼容）。
		ClientRequestID string `json:"client_request_id"`
		Postings        []struct {
			AccountID int64  `json:"account_id"`
			Commodity string `json:"commodity"`
			Amount    string `json:"amount"`
		} `json:"postings"`
	}
	if err := readJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}
	postings := make([]service.PostingInput, 0, len(req.Postings))
	for _, p := range req.Postings {
		postings = append(postings, service.PostingInput{
			AccountID: p.AccountID,
			Commodity: p.Commodity,
			Amount:    p.Amount,
		})
	}
	var createdBy int64
	if uid, ok := auth.UserID(r.Context()); ok {
		createdBy = uid
	}
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if idempotencyKey == "" {
		idempotencyKey = req.ClientRequestID
	}
	created, err := h.svc.CreateTransactionIdempotent(
		ledgerID, idempotencyKey, req.Date, req.Flag, req.Description, postings, createdBy, req.Tags...)
	if err != nil {
		writeError(w, err)
		return
	}
	// 新建 → 201；幂等命中 → 200（响应体结构不变，附 "idempotent": true）。
	status := http.StatusCreated
	if created.Idempotent {
		status = http.StatusOK
	}
	writeJSON(w, status, created)
}

// HandleUpdateTransaction 修改交易（0.6.0 S6，PATCH）：修改 = 冲正 + 新建，绝不原地改。
//
// 载荷与在线 create 镜像：{date, flag, description, tags, postings}（postings 用
// account_id）。响应 {original_uuid, reversal_uuid, new_uuid}（无 version——D-15
// 砍掉版本链）。判定与权限在 service 层独立校验（AC-5.3）：
// 已冲正 409 txn_already_reversed、期初/校准/冲正 409 txn_not_editable、
// viewer/非本人 403 txn_edit_forbidden。
func (h *Handler) HandleUpdateTransaction(w http.ResponseWriter, r *http.Request) {
	ledgerID, ok := auth.LedgerID(r.Context())
	if !ok {
		writeError(w, domain.ErrForbidden)
		return
	}
	uid, ok := auth.UserID(r.Context())
	if !ok {
		writeError(w, domain.ErrUnauthorized)
		return
	}
	var req struct {
		Date        string   `json:"date"`
		Flag        string   `json:"flag"`
		Description string   `json:"description"`
		Tags        []string `json:"tags"`
		Postings    []struct {
			AccountID int64  `json:"account_id"`
			Commodity string `json:"commodity"`
			Amount    string `json:"amount"`
		} `json:"postings"`
	}
	if err := readJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}
	postings := make([]service.PostingInput, 0, len(req.Postings))
	for _, p := range req.Postings {
		postings = append(postings, service.PostingInput{
			AccountID: p.AccountID,
			Commodity: p.Commodity,
			Amount:    p.Amount,
		})
	}
	res, err := h.svc.UpdateTransaction(ledgerID, uid, r.PathValue("uuid"), service.TxnUpdateInput{
		Date:        req.Date,
		Flag:        req.Flag,
		Description: req.Description,
		Tags:        req.Tags,
		Postings:    postings,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// HandleListTrash 列出回收站内的交易（已软删，按删除时间倒序）。
//
// B7 additive：响应除 `transactions` 外追加两个键——
//   - `purge_summary`：{deletable, system_kept, paired}，页脚「N 笔可删」与确认弹层的数字来源；
//   - `purge_log`：最近 50 条本机永久删除审计（全体成员可见）。
//
// 两条都挂在既有 GET 上（不新开端点）：端点总数被规格钉在 43，且回收站页本来
// 就要拉列表，一次往返取回三样且三者同源（同一份闭包 / 同一次裁决）。
func (h *Handler) HandleListTrash(w http.ResponseWriter, r *http.Request) {
	ledgerID, ok := auth.LedgerID(r.Context())
	if !ok {
		writeError(w, domain.ErrForbidden)
		return
	}
	uid, _ := auth.UserID(r.Context())
	overview, err := h.svc.TrashOverview(ledgerID, uid)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"transactions":  overview.Items,
		"purge_summary": overview.Summary,
		"purge_log":     overview.Log,
	})
}

// HandlePurgeTransaction 永久删除单笔：DELETE /api/transactions/{uuid}/purge
//
// Body `{confirm:"删除"}`；响应 `{ok,count,deleted:[{uuid,description,was_in_trash}],
// purged_postings, already_purged?}`。仅 owner；物理删除不可恢复。
func (h *Handler) HandlePurgeTransaction(w http.ResponseWriter, r *http.Request) {
	ledgerID, userID, ok := purgeContext(w, r)
	if !ok {
		return
	}
	res, err := h.svc.PurgeTransaction(ledgerID, userID, r.PathValue("uuid"), readPurgeConfirm(r))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// HandlePurgeTrash 清空回收站：POST /api/transactions/trash/purge
//
// Body `{confirm:"删除"}`（前端让用户手输「清空」后映射成本词）；响应结构同上，
// 但**不带** already_purged（空回收站是正常结果，不是幂等命中）。
func (h *Handler) HandlePurgeTrash(w http.ResponseWriter, r *http.Request) {
	ledgerID, userID, ok := purgeContext(w, r)
	if !ok {
		return
	}
	res, err := h.svc.PurgeTrash(ledgerID, userID, readPurgeConfirm(r))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// readPurgeConfirm 解码永久删除的确认体。
//
// 刻意**不复用 readJSON**：它对空 body 返回 io.EOF、对未知字段返回 json 错误，
// 两者都会被 writeError 映射成 400 + 文案 "EOF" / "json: unknown field ..."，
// 前端拿不到稳定码，无法提示「请重新确认」。
//
// 这里把「空 body / 字段缺失 / 未知字段 / 非法 JSON」一律折叠成空串，
// 由 service 统一返回 400 txn_purge_confirm_required。
// 取舍：确实会吞掉「JSON 写坏了」这类诊断信息，但可行动的错误码比 EOF 有用。
func readPurgeConfirm(r *http.Request) string {
	var req struct {
		Confirm string `json:"confirm"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return ""
	}
	return req.Confirm
}

// purgeContext 取账本 + 用户上下文（两条永久删除端点共用）。
// 缺失账本上下文 → 403；缺失用户 → 401（与既有 handler 同款口径）。
func purgeContext(w http.ResponseWriter, r *http.Request) (ledgerID, userID int64, ok bool) {
	ledgerID, hasLedger := auth.LedgerID(r.Context())
	if !hasLedger {
		writeError(w, domain.ErrForbidden)
		return 0, 0, false
	}
	userID, hasUser := auth.UserID(r.Context())
	if !hasUser {
		writeError(w, domain.ErrUnauthorized)
		return 0, 0, false
	}
	return ledgerID, userID, true
}

// HandleRestoreTransaction 从回收站恢复一笔交易。
func (h *Handler) HandleRestoreTransaction(w http.ResponseWriter, r *http.Request) {
	ledgerID, ok := auth.LedgerID(r.Context())
	if !ok {
		writeError(w, domain.ErrForbidden)
		return
	}
	uid, _ := auth.UserID(r.Context())
	if err := h.svc.RestoreTransaction(ledgerID, uid, r.PathValue("uuid")); err != nil {
		if err == domain.ErrNotFound {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "交易不存在或未被删除"})
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// HandleDeleteTransaction 按 uuid 软删一笔交易。
func (h *Handler) HandleDeleteTransaction(w http.ResponseWriter, r *http.Request) {
	ledgerID, ok := auth.LedgerID(r.Context())
	if !ok {
		writeError(w, domain.ErrForbidden)
		return
	}
	uid, _ := auth.UserID(r.Context())
	if err := h.svc.DeleteTransaction(ledgerID, uid, r.PathValue("uuid")); err != nil {
		if err == domain.ErrNotFound {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "交易不存在或已删除"})
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
