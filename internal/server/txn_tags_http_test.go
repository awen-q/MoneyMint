package server

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"testing"

	"familyledger/internal/domain"
)

// txnTagsHTTPEnv 在通用 QA HTTP 环境上预置两个账户，专注标签端点的 HTTP 回归。
type txnTagsHTTPEnv struct {
	*qaServerEnv
	cashID int64
	foodID int64
}

func newTxnTagsHTTPEnv(t *testing.T) *txnTagsHTTPEnv {
	t.Helper()
	e := &txnTagsHTTPEnv{qaServerEnv: newQAServerEnv(t)}
	for _, spec := range []struct {
		name, typ string
		out       *int64
	}{
		{"Assets:TagCash", "Assets", &e.cashID},
		{"Expenses:TagFood", "Expenses", &e.foodID},
	} {
		st, body, raw := e.do(http.MethodPost, "/api/accounts", map[string]any{
			"name": spec.name, "type": spec.typ, "open_date": "2026-01-01",
			"commodity": "CNY", "parent_uuid": "",
		}, "1", e.token)
		if st != http.StatusCreated {
			t.Fatalf("建账户 %s 应 201，实际 %d: %s", spec.name, st, raw)
		}
		*spec.out = int64(body["id"].(float64))
	}
	return e
}

// newTxn 记一笔带初始标签的平衡交易，返回 uuid。
func (e *txnTagsHTTPEnv) newTxn(t *testing.T, desc string, tags []string) string {
	t.Helper()
	body := map[string]any{
		"date": "2026-02-01", "flag": "*", "description": desc,
		"postings": []map[string]any{
			{"account_id": e.cashID, "commodity": "CNY", "amount": "-12.50"},
			{"account_id": e.foodID, "commodity": "CNY", "amount": "12.50"},
		},
	}
	if tags != nil {
		body["tags"] = tags
	}
	st, res, raw := e.do(http.MethodPost, "/api/transactions", body, "1", e.token)
	if st != http.StatusCreated {
		t.Fatalf("create 应 201，实际 %d: %s", st, raw)
	}
	uuid, _ := res["uuid"].(string)
	if uuid == "" {
		t.Fatalf("create 响应缺 uuid: %s", raw)
	}
	return uuid
}

func (e *txnTagsHTTPEnv) putTags(t *testing.T, uuid string, body map[string]any, token string) (int, map[string]any, string) {
	t.Helper()
	if token == "" {
		token = e.token
	}
	return e.do(http.MethodPut, "/api/transactions/"+uuid+"/tags", body, "1", token)
}

func (e *txnTagsHTTPEnv) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := e.conn.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("查询 %q: %v", query, err)
	}
	return n
}

var tagTimestampRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)

// TestTxnTagsHTTP_UpdateAuditSync 锁定 US1 全链路：
// 200 回显规范化值 → 主流水仍 1 行、uuid 不变、无冲正 → 审计可见 →
// sync_log op=update 出站 → can_edit 仍为 true → 可再次编辑。
func TestTxnTagsHTTP_UpdateAuditSync(t *testing.T) {
	e := newTxnTagsHTTPEnv(t)
	uuid := e.newTxn(t, "早餐", []string{"餐饮"})
	before := e.count(t, `SELECT count(*) FROM transactions WHERE ledger_id=1 AND deleted_at IS NULL`)

	// 乱序 + 首尾空白 + 重复元素：规范化后应为 ["周末","晚餐"]（Unicode 码点序）。
	st, res, raw := e.putTags(t, uuid, map[string]any{
		"tags":      []string{"晚餐", " 周末 ", "晚餐"},
		"base_tags": []string{"餐饮"},
		"device_id": "dev-iphone-01",
	}, "")
	if st != http.StatusOK {
		t.Fatalf("PUT /tags 应 200，实际 %d: %s", st, raw)
	}
	if res["uuid"] != uuid {
		t.Fatalf("uuid 必须不变，实际 %v", res["uuid"])
	}
	tags, ok := res["tags"].([]any)
	if !ok || len(tags) != 2 || tags[0] != "周末" || tags[1] != "晚餐" {
		t.Fatalf("回显应为服务端规范化后的 [周末 晚餐]，实际 %s", raw)
	}
	if ts, _ := res["tags_updated_at"].(string); !tagTimestampRE.MatchString(ts) {
		t.Fatalf("tags_updated_at 格式应为毫秒 UTC，实际 %q", ts)
	}
	if editID, _ := res["edit_id"].(float64); editID <= 0 {
		t.Fatalf("edit_id 应为正数审计 id，实际 %v", res["edit_id"])
	}

	// 主流水：交易总数不变、无冲正行、uuid 唯一出现一次。
	if after := e.count(t, `SELECT count(*) FROM transactions WHERE ledger_id=1 AND deleted_at IS NULL`); after != before {
		t.Fatalf("改标签后交易行数应由 %d 变为 %d（禁止新增行）", before, after)
	}
	if n := e.count(t, `SELECT count(*) FROM transactions WHERE description LIKE '冲正:%'`); n != 0 {
		t.Fatalf("不得产生冲正交易，实际 %d 条", n)
	}
	if n := e.count(t, `SELECT count(*) FROM transactions WHERE reversal_of IS NOT NULL AND reversal_of<>''`); n != 0 {
		t.Fatalf("不得产生 reversal_of 非空行，实际 %d 条", n)
	}

	// 筛选即时反映当前 tags（US2 隐式验收的同款路径）。
	st, listed, raw := e.do(http.MethodGet, "/api/transactions?tag=晚餐&tag=周末", nil, "1", e.token)
	if st != http.StatusOK {
		t.Fatalf("列表应 200: %s", raw)
	}
	arr := listed["transactions"].([]any)
	if len(arr) != 1 || arr[0].(map[string]any)["uuid"] != uuid {
		t.Fatalf("新标签筛选应命中该 uuid，实际 %s", raw)
	}
	st, listed, raw = e.do(http.MethodGet, "/api/transactions?tag=餐饮", nil, "1", e.token)
	if st != http.StatusOK || len(listed["transactions"].([]any)) != 0 {
		t.Fatalf("旧标签筛选应不再命中，实际 %s", raw)
	}

	// 二级审计：倒序一条，old→new / actor / device / ts 齐全。
	st, editsBody, raw := e.do(http.MethodGet, "/api/transactions/"+uuid+"/tag-edits", nil, "1", e.token)
	if st != http.StatusOK {
		t.Fatalf("GET tag-edits 应 200: %s", raw)
	}
	edits := editsBody["edits"].([]any)
	if len(edits) != 1 {
		t.Fatalf("应有 1 条审计，实际 %d: %s", len(edits), raw)
	}
	edit := edits[0].(map[string]any)
	if edit["action"] != "replace" || edit["actor_name"] != "QA" || edit["device_id"] != "dev-iphone-01" {
		t.Fatalf("审计归因不符: %s", raw)
	}
	if old := edit["old_tags"].([]any); len(old) != 1 || old[0] != "餐饮" {
		t.Fatalf("old_tags 不符: %s", raw)
	}
	if nw := edit["new_tags"].([]any); len(nw) != 2 || nw[0] != "周末" || nw[1] != "晚餐" {
		t.Fatalf("new_tags 不符: %s", raw)
	}
	if ts, _ := edit["ts"].(string); !tagTimestampRE.MatchString(ts) {
		t.Fatalf("审计 ts 格式不符: %q", ts)
	}

	// 出站同步：sync_log 有 transaction/update 指向原 uuid，且审计与 UPDATE 同事务落库。
	if n := e.count(t, `SELECT count(*) FROM sync_log WHERE ledger_id=1 AND entity_type='transaction' AND entity_uuid=? AND op='update'`, uuid); n < 1 {
		t.Fatalf("应写入 sync_log op=update，实际 %d 条", n)
	}
	if n := e.count(t, `SELECT count(*) FROM tag_edit_log WHERE ledger_id=1 AND entity_uuid=?`, uuid); n != 1 {
		t.Fatalf("审计应恰好 1 条，实际 %d 条", n)
	}

	// 仍可再次编辑（不打 reversed_by，can_edit 不变）。
	st, viewBody, raw := e.do(http.MethodGet, "/api/transactions", nil, "1", e.token)
	if st != http.StatusOK {
		t.Fatalf("列表应 200: %s", raw)
	}
	for _, item := range viewBody["transactions"].([]any) {
		v := item.(map[string]any)
		if v["uuid"] == uuid && v["can_edit"] != true {
			t.Fatalf("改标签后 can_edit 必须仍为 true: %s", raw)
		}
	}
	st, _, raw = e.putTags(t, uuid, map[string]any{
		"tags": []string{"夜宵"}, "base_tags": []string{"周末", "晚餐"},
	}, "")
	if st != http.StatusOK {
		t.Fatalf("第二次原地编辑应 200（可反复编辑）: %s", raw)
	}
	if n := e.count(t, `SELECT count(*) FROM tag_edit_log WHERE entity_uuid=?`, uuid); n != 2 {
		t.Fatalf("两次编辑应有 2 条审计，实际 %d", n)
	}
	if after := e.count(t, `SELECT count(*) FROM transactions WHERE ledger_id=1 AND deleted_at IS NULL`); after != before {
		t.Fatalf("再次编辑后交易行数仍应为 %d，实际 %d", before, after)
	}
}

// TestTxnTagsHTTP_ErrorCodes 逐行覆盖设计 §2.1 错误码表。
func TestTxnTagsHTTP_ErrorCodes(t *testing.T) {
	e := newTxnTagsHTTPEnv(t)
	uuid := e.newTxn(t, "早餐", []string{"餐饮"})

	// 404：不存在（writeError 走 ErrNotFound，沿用既有 handler 口径）。
	st, _, raw := e.putTags(t, "no-such-uuid", map[string]any{
		"tags": []string{}, "base_tags": []string{},
	}, "")
	if st != http.StatusNotFound {
		t.Fatalf("不存在应 404，实际 %d: %s", st, raw)
	}

	// 409 txn_tags_conflict：base_tags 与当前值不一致，回带 current_tags。
	st, body, raw := e.putTags(t, uuid, map[string]any{
		"tags": []string{"X"}, "base_tags": []string{"不存在"},
	}, "")
	if st != http.StatusConflict {
		t.Fatalf("CAS 失败应 409，实际 %d: %s", st, raw)
	}
	if body["code"] != domain.CodeTxnTagsConflict {
		t.Fatalf("code 应为 %s，实际 %v", domain.CodeTxnTagsConflict, body["code"])
	}
	cur, ok := body["current_tags"].([]any)
	if !ok || len(cur) != 1 || cur[0] != "餐饮" {
		t.Fatalf("冲突响应应带 current_tags=[餐饮]，实际 %s", raw)
	}
	if _, exists := body["current_tags_updated_at"]; !exists {
		t.Fatalf("冲突响应应带 current_tags_updated_at: %s", raw)
	}

	// 400 txn_tags_invalid：超过 32 个标签。
	tooMany := make([]string, 33)
	for i := range tooMany {
		tooMany[i] = "标签" + strconv.Itoa(i) // 必须互不相同，否则规范化去重后不足 32 个
	}
	st, body, raw = e.putTags(t, uuid, map[string]any{
		"tags": tooMany, "base_tags": []string{"餐饮"},
	}, "")
	if st != http.StatusBadRequest || body["code"] != domain.CodeTxnTagsInvalid {
		t.Fatalf("超量标签应 400 txn_tags_invalid，实际 %d: %s", st, raw)
	}

	// 400 txn_tags_invalid：单个标签超过 64 字符。
	longTag := ""
	for i := 0; i < 65; i++ {
		longTag += "长"
	}
	st, body, raw = e.putTags(t, uuid, map[string]any{
		"tags": []string{longTag}, "base_tags": []string{"餐饮"},
	}, "")
	if st != http.StatusBadRequest || body["code"] != domain.CodeTxnTagsInvalid {
		t.Fatalf("超长标签应 400 txn_tags_invalid，实际 %d: %s", st, raw)
	}

	// 400 opening_via_api_only：opening 黑名单与 create 同口径。
	st, body, raw = e.putTags(t, uuid, map[string]any{
		"tags": []string{"opening"}, "base_tags": []string{"餐饮"},
	}, "")
	if st != http.StatusBadRequest || body["code"] != domain.CodeOpeningViaAPIOnly {
		t.Fatalf("opening 应 400 opening_via_api_only，实际 %d: %s", st, raw)
	}

	// 400：缺 base_tags（必填字段，readJSON 不替我们做必填校验）。
	st, body, raw = e.putTags(t, uuid, map[string]any{"tags": []string{}}, "")
	if st != http.StatusBadRequest || body["code"] != domain.CodeTxnTagsInvalid {
		t.Fatalf("缺 base_tags 应 400 txn_tags_invalid，实际 %d: %s", st, raw)
	}

	// 未知字段一律 400（readJSON DisallowUnknownFields）。
	st, _, raw = e.putTags(t, uuid, map[string]any{
		"tags": []string{}, "base_tags": []string{"餐饮"}, "unexpected": 1,
	}, "")
	if st != http.StatusBadRequest {
		t.Fatalf("未知字段应 400，实际 %d: %s", st, raw)
	}

	// 方法限定：PUT /tag-edits 与 POST /tags 都是 405，不会串到父资源。
	st, _, raw = e.do(http.MethodPut, "/api/transactions/"+uuid+"/tag-edits",
		map[string]any{}, "1", e.token)
	if st != http.StatusMethodNotAllowed {
		t.Fatalf("PUT tag-edits 应 405，实际 %d: %s", st, raw)
	}
	st, _, raw = e.do(http.MethodPost, "/api/transactions/"+uuid+"/tags",
		map[string]any{}, "1", e.token)
	if st != http.StatusMethodNotAllowed {
		t.Fatalf("POST tags 应 405，实际 %d: %s", st, raw)
	}

	// 失败路径不得留痕。
	if n := e.count(t, `SELECT count(*) FROM tag_edit_log WHERE entity_uuid=?`, uuid); n != 0 {
		t.Fatalf("所有失败请求都不应写审计，实际 %d 条", n)
	}
}

// TestTxnTagsHTTP_Permissions viewer 只读审计、不可改标签；editor 只能改自己记的账。
func TestTxnTagsHTTP_Permissions(t *testing.T) {
	e := newTxnTagsHTTPEnv(t)
	uuid := e.newTxn(t, "早餐", []string{"餐饮"})

	viewer, err := e.svc.Register("tags-viewer", "secret123", "只读")
	if err != nil {
		t.Fatalf("注册 viewer: %v", err)
	}
	if _, _, err := e.svc.AddMember(1, e.userID, "tags-viewer", domain.RoleViewer); err != nil {
		t.Fatalf("加入 viewer: %v", err)
	}
	editor, err := e.svc.Register("tags-editor", "secret123", "编辑")
	if err != nil {
		t.Fatalf("注册 editor: %v", err)
	}
	if _, _, err := e.svc.AddMember(1, e.userID, "tags-editor", domain.RoleEditor); err != nil {
		t.Fatalf("加入 editor: %v", err)
	}

	// viewer 写：middleware 403（只读成员无写权限）。
	st, _, raw := e.putTags(t, uuid, map[string]any{
		"tags": []string{"X"}, "base_tags": []string{"餐饮"},
	}, viewer.Token)
	if st != http.StatusForbidden {
		t.Fatalf("viewer PUT 应 403，实际 %d: %s", st, raw)
	}
	// viewer 读审计：允许（只读、不触及经济事实）。
	st, _, raw = e.do(http.MethodGet, "/api/transactions/"+uuid+"/tag-edits", nil, "1", viewer.Token)
	if st != http.StatusOK {
		t.Fatalf("viewer GET tag-edits 应 200，实际 %d: %s", st, raw)
	}

	// editor 改他人交易：service 独立复核 → 403 txn_edit_forbidden。
	st, body, raw := e.putTags(t, uuid, map[string]any{
		"tags": []string{"X"}, "base_tags": []string{"餐饮"},
	}, editor.Token)
	if st != http.StatusForbidden {
		t.Fatalf("editor 改他人交易应 403，实际 %d: %s", st, raw)
	}
	if body["code"] != domain.CodeTxnEditForbidden {
		t.Fatalf("code 应为 txn_edit_forbidden，实际 %v", body["code"])
	}
	if n := e.count(t, `SELECT count(*) FROM tag_edit_log WHERE entity_uuid=?`, uuid); n != 0 {
		t.Fatalf("无权限请求不应写审计，实际 %d 条", n)
	}
}

// TestTxnTagsHTTP_ReversedPriorityAndSystemTxn 已冲正优先于角色；系统交易一律拒绝。
func TestTxnTagsHTTP_ReversedPriorityAndSystemTxn(t *testing.T) {
	e := newTxnTagsHTTPEnv(t)
	uuid := e.newTxn(t, "早餐", []string{"餐饮"})

	// 先用既有 PATCH 走冲正 + 新建（经济事实路径零改动），原交易进入已冲正态。
	st, _, raw := e.do(http.MethodPatch, "/api/transactions/"+uuid, map[string]any{
		"date": "2026-02-02", "description": "早餐（改）",
		"postings": []map[string]any{
			{"account_id": e.cashID, "commodity": "CNY", "amount": "-20.00"},
			{"account_id": e.foodID, "commodity": "CNY", "amount": "20.00"},
		},
	}, "1", e.token)
	if st != http.StatusOK {
		t.Fatalf("PATCH 应 200: %s", raw)
	}
	st, body, raw := e.putTags(t, uuid, map[string]any{
		"tags": []string{"X"}, "base_tags": []string{"餐饮"},
	}, "")
	if st != http.StatusConflict || body["code"] != domain.CodeTxnAlreadyReversed {
		t.Fatalf("已冲正交易应 409 txn_already_reversed，实际 %d: %s", st, raw)
	}

	// 系统交易（期初）：用身份列标记后标签端必须拒绝。
	systemUUID := e.newTxn(t, "期初标记", []string{})
	if _, err := e.conn.Exec(
		`UPDATE transactions SET opening_account_uuid='sys-acc' WHERE uuid=?`, systemUUID,
	); err != nil {
		t.Fatalf("标记系统交易: %v", err)
	}
	st, body, raw = e.putTags(t, systemUUID, map[string]any{
		"tags": []string{"X"}, "base_tags": []string{},
	}, "")
	if st != http.StatusConflict || body["code"] != domain.CodeTxnNotEditable {
		t.Fatalf("系统交易应 409 txn_not_editable，实际 %d: %s", st, raw)
	}
	if n := e.count(t, `SELECT count(*) FROM tag_edit_log WHERE entity_uuid IN (?, ?)`, uuid, systemUUID); n != 0 {
		t.Fatalf("拒绝路径不应写审计，实际 %d 条", n)
	}
}

// TestTxnTagsHTTP_DeleteAndReAdd 覆盖 US2：删标签后筛选消失、可无冲正加回。
func TestTxnTagsHTTP_DeleteAndReAdd(t *testing.T) {
	e := newTxnTagsHTTPEnv(t)
	uuid := e.newTxn(t, "早餐", []string{"餐饮"})
	before := e.count(t, `SELECT count(*) FROM transactions WHERE ledger_id=1 AND deleted_at IS NULL`)

	// 删除：tags=[]、base_tags=[餐饮]。
	st, res, raw := e.putTags(t, uuid, map[string]any{
		"tags": []string{}, "base_tags": []string{"餐饮"},
	}, "")
	if st != http.StatusOK {
		t.Fatalf("清空标签应 200: %s", raw)
	}
	if tags := res["tags"].([]any); len(tags) != 0 {
		t.Fatalf("清空后回显应为 []，实际 %s", raw)
	}
	st, listed, raw := e.do(http.MethodGet, "/api/transactions?tag=餐饮", nil, "1", e.token)
	if st != http.StatusOK || len(listed["transactions"].([]any)) != 0 {
		t.Fatalf("删标签后筛选不应命中，实际 %s", raw)
	}
	st, editsBody, raw := e.do(http.MethodGet, "/api/transactions/"+uuid+"/tag-edits", nil, "1", e.token)
	if st != http.StatusOK {
		t.Fatalf("GET tag-edits 应 200: %s", raw)
	}
	edit := editsBody["edits"].([]any)[0].(map[string]any)
	if old := edit["old_tags"].([]any); len(old) != 1 || old[0] != "餐饮" {
		t.Fatalf("删除审计 old_tags 不符: %s", raw)
	}
	if nw := edit["new_tags"].([]any); len(nw) != 0 {
		t.Fatalf("删除审计 new_tags 应为 []: %s", raw)
	}

	// 加回：tags=[餐饮]、base_tags=[]，无需冲正。
	st, _, raw = e.putTags(t, uuid, map[string]any{
		"tags": []string{"餐饮"}, "base_tags": []string{},
	}, "")
	if st != http.StatusOK {
		t.Fatalf("加回标签应 200: %s", raw)
	}
	st, listed, raw = e.do(http.MethodGet, "/api/transactions?tag=餐饮", nil, "1", e.token)
	if st != http.StatusOK || len(listed["transactions"].([]any)) != 1 {
		t.Fatalf("加回后筛选应再次命中，实际 %s", raw)
	}
	if after := e.count(t, `SELECT count(*) FROM transactions WHERE ledger_id=1 AND deleted_at IS NULL`); after != before {
		t.Fatalf("删/加标签不得改变交易行数（%d → %d）", before, after)
	}
	if n := e.count(t, `SELECT count(*) FROM transactions WHERE description LIKE '冲正:%'`); n != 0 {
		t.Fatalf("不得产生冲正行，实际 %d", n)
	}
}

// TestTxnTagsHTTP_ForgedPushRejected 离线端不能通过 sync/push 夹带 tags 改服务端账核。
func TestTxnTagsHTTP_ForgedPushRejected(t *testing.T) {
	e := newTxnTagsHTTPEnv(t)
	uuid := e.newTxn(t, "早餐", []string{"餐饮"})

	entity, err := json.Marshal(map[string]any{
		"uuid": uuid, "reversed_by": "fake-reversal", "tags": []string{"伪造"},
	})
	if err != nil {
		t.Fatalf("marshal push entity: %v", err)
	}
	st, body, raw := e.do(http.MethodPost, "/api/sync/push", map[string]any{
		"client_id": "forged-device",
		"changes": []map[string]any{{
			"entity_type": domain.EntityTransaction,
			"op":          domain.OpUpdate,
			"entity":      json.RawMessage(entity),
		}},
	}, "1", e.token)
	if st != http.StatusOK {
		t.Fatalf("sync/push 请求本身应 200（逐条裁决）: %s", raw)
	}
	results, ok := body["results"].([]any)
	if !ok || len(results) != 1 {
		t.Fatalf("push 应逐条返回 1 个结果: %s", raw)
	}
	result := results[0].(map[string]any)
	if result["status"] != "error" || result["accepted"] != false {
		t.Fatalf("夹带 tags 的 transaction update 必须被拒: %s", raw)
	}

	// 服务端 tags 未被改写，reversed_by 未被伪造打上。
	var tags, reversedBy string
	if err := e.conn.QueryRow(
		`SELECT COALESCE(tags,''), COALESCE(reversed_by,'') FROM transactions WHERE uuid=?`, uuid,
	).Scan(&tags, &reversedBy); err != nil {
		t.Fatalf("读取标签: %v", err)
	}
	if tags != `["餐饮"]` || reversedBy != "" {
		t.Fatalf("伪造 push 不得改动服务端 tags/reversed_by，实际 tags=%s reversed_by=%s", tags, reversedBy)
	}
	if n := e.count(t, `SELECT count(*) FROM tag_edit_log WHERE entity_uuid=?`, uuid); n != 0 {
		t.Fatalf("伪造 push 不应写审计，实际 %d 条", n)
	}
}
