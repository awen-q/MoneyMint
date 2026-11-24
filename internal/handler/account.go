package handler

import (
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"familyledger/internal/auth"
	"familyledger/internal/domain"
	"familyledger/internal/service"
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

// HandleUpdateAccountSortOrder 批量提交分类拖拽后的排序（P0）。
// Body: {"orders":[{"uuid":"...","sort_order":0}, ...]}。
// 同一事务全成全败；每条更新写 sync_log(op=update)，供其他端 pull 重排。
// viewer 只读由 authMiddleware 统一拦截（非 GET 一律 403），handler 不重复判定。
func (h *Handler) HandleUpdateAccountSortOrder(w http.ResponseWriter, r *http.Request) {
	ledgerID, ok := auth.LedgerID(r.Context())
	if !ok {
		writeError(w, domain.ErrForbidden)
		return
	}
	var req struct {
		Orders []service.AccountSortOrderItem `json:"orders"`
	}
	if err := readJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}
	updated, err := h.svc.UpdateAccountSortOrders(ledgerID, req.Orders)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "updated": updated})
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

// HandleUpdateAccountVisual 修改账户展示字段（批 II）：Body 白名单
// {display_name?, icon?, color?}，指针区分「键缺失 = 不改」与「显式空串 = 清除」。
//
// 白名单外键出现 → 400 并列明拒绝字段（绝不静默忽略，防夹带改 name/sort_order）；
// 全 nil → 400。viewer 只读由 authMiddleware（非 GET 一律 403）兜住，不重复判定。
func (h *Handler) HandleUpdateAccountVisual(w http.ResponseWriter, r *http.Request) {
	ledgerID, ok := auth.LedgerID(r.Context())
	if !ok {
		writeError(w, domain.ErrForbidden)
		return
	}
	// 先解成 RawMessage 映射做键白名单审查，再逐键解析成 *string：
	// 这样既能列出被拒绝的字段名（DisallowUnknownFields 的英文报错做不到），
	// 又能对值类型显式报错（icon: 123 之类直接 400，不静默转义）。
	var raw map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		writeError(w, domain.Invalidf("请求体需为 JSON 对象（键：display_name / icon / color，均可选）"))
		return
	}
	allowed := map[string]bool{"display_name": true, "icon": true, "color": true}
	rejected := make([]string, 0, len(raw))
	for key := range raw {
		if !allowed[key] {
			rejected = append(rejected, key)
		}
	}
	if len(rejected) > 0 {
		sort.Strings(rejected)
		writeError(w, domain.Invalidf(
			"不支持修改字段：%s（本端点仅允许 display_name / icon / color）",
			strings.Join(rejected, "、")))
		return
	}
	req := service.AccountVisualUpdate{}
	// readString 解析单个键：键缺失返回 present=false；键存在但值非字符串 → 400。
	readString := func(key string) (string, bool, error) {
		value, present := raw[key]
		if !present {
			return "", false, nil
		}
		var s string
		if err := json.Unmarshal(value, &s); err != nil {
			return "", true, domain.Invalidf("字段 %s 的值需为字符串", key)
		}
		return s, true, nil
	}
	for _, item := range []struct {
		key string
		dst **string
	}{
		{"display_name", &req.DisplayName},
		{"icon", &req.Icon},
		{"color", &req.Color},
	} {
		value, present, err := readString(item.key)
		if err != nil {
			writeError(w, err)
			return
		}
		if present {
			*item.dst = &value
		}
	}
	updated, err := h.svc.UpdateAccountVisual(ledgerID, r.PathValue("uuid"), req)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "account": updated})
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
