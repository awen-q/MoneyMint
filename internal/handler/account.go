package handler

import (
	"net/http"
	"net/url"
	"strings"

	"familyledger/internal/auth"
	"familyledger/internal/domain"
)

// HandleListAccounts 列出账户及其余额。`?include_closed` 的**取值**语义见
// includeClosedFromQuery（缺省不含已关户账户）。
func (h *Handler) HandleListAccounts(w http.ResponseWriter, r *http.Request) {
	ledgerID, ok := auth.LedgerID(r.Context())
	if !ok {
		writeError(w, domain.ErrForbidden)
		return
	}
	includeClosed := includeClosedFromQuery(r.URL.Query())
	accounts, err := h.svc.ListAccounts(ledgerID, includeClosed)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": accounts})
}

// includeClosedFromQuery 按**取值**解析 `?include_closed`（不是「参数存在即生效」）。
//
// 语义（`AGENTS.md` §7 端点表同源）：
//
//	缺省                        → false（不含已关户账户）
//	1 / true / yes（大小写不敏感）→ true
//	0 / false / no（同上）       → false
//	裸写（值为空串）              → true（向后兼容：0.6.0 起一直是「带了就含」，
//	                              别让今天唯一在用的调用方行为突变）
//	其它无法识别                  → false（**宁可少给，不要多给**）
//
// 为什么不用 `Query().Has()`：那会让 `?include_closed=false` 也**包含**关户账户，
// 「我明确说了不要」被静默变成「你要了」——调用方不会报错，只会拿到多余的行。
//
// 为什么「无法识别」选不含：多给一次（关户账户出现在记账选账户里）用户无从察觉，
// 而且真有可能记上去（保存时才 409）；少给一次最多是用户再问一句。
func includeClosedFromQuery(query url.Values) bool {
	values, present := query["include_closed"]
	if !present || len(values) == 0 {
		// 缺省不含；`?include_closed` 裸写时 Go 解析出的是 [""]（len 1），不走这里。
		return present
	}
	switch strings.ToLower(strings.TrimSpace(values[0])) {
	case "1", "true", "yes", "":
		return true
	default:
		// "0" / "false" / "no" / 其它无法识别的值
		return false
	}
}

// HandleCreateAccount 创建账户。
func (h *Handler) HandleCreateAccount(w http.ResponseWriter, r *http.Request) {
	ledgerID, ok := auth.LedgerID(r.Context())
	if !ok {
		writeError(w, domain.ErrForbidden)
		return
	}
	var req struct {
		Name        string `json:"name"`
		DisplayName string `json:"display_name"`
		Type        string `json:"type"`
		OpenDate    string `json:"open_date"`
		Commodity   string `json:"commodity"`
		Icon        string `json:"icon"`
		Color       string `json:"color"`
		ParentUUID  *string `json:"parent_uuid"`
		SubType     string  `json:"sub_type"`
	}
	if err := readJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}
	// 0.6.0 S2（D-04 / design §1 S2）：用指针区分「JSON 键缺失」与「显式空串」。
	// 显式 parent_uuid="" 才是根账户；键缺失一律 400，绝不静默降级为根。
	if req.ParentUUID == nil {
		writeError(w, domain.Invalidf(
			"缺少 parent_uuid 字段，创建根账户请显式传 parent_uuid:\"\"，增加下级请传父账户 uuid"))
		return
	}
	created, err := h.svc.CreateAccount(ledgerID, req.Name, req.DisplayName, req.Type, req.OpenDate, req.Commodity, req.Icon, req.Color, *req.ParentUUID, req.SubType)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// HandleDeleteAccount 按 uuid 关闭账户（Beancount close 语义，0.4-A 起）。
// 置 close_date，保留全部交易引用；HTTP 动词仍为 DELETE，语义从软删改为关闭。
func (h *Handler) HandleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	ledgerID, ok := auth.LedgerID(r.Context())
	if !ok {
		writeError(w, domain.ErrForbidden)
		return
	}
	if err := h.svc.DeleteAccount(ledgerID, r.PathValue("uuid")); err != nil {
		if err == domain.ErrNotFound {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "账户不存在或已关闭"})
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
