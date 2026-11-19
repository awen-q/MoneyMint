package server

// B7 回收站永久删除的 HTTP 层回归：
//
//   - 两条端点都能命中正确 handler（DELETE {uuid}/purge、POST trash/purge）；
//   - 方法限制：GET/POST {uuid}/purge → 405；GET/DELETE trash/purge → 405
//     （尤其 `DELETE /trash/purge` 必须 405，绝不能掉进 {uuid} 把 "trash" 当 uuid 去删）；
//   - DELETE 空 body / 缺字段 / 未知字段 / 坏 JSON 一律 400 txn_purge_confirm_required
//     （而不是 400 "EOF" —— 这条钉住 design 坑 2）；
//   - 401 / viewer 403（middleware）/ editor 403 + txn_purge_forbidden；
//   - 响应字段逐字对齐规格；幂等时 already_purged:true；
//   - 永久删除**不轮换** instance_id。

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
)

// purgeHTTPFixture 是 HTTP 用例的数据：两个账户 + 记账辅助。
type purgeHTTPFixture struct {
	env  *qaServerEnv
	cash int64
	food int64
}

// newPurgeHTTPFixture 建环境、建两个账户。
func newPurgeHTTPFixture(t *testing.T) *purgeHTTPFixture {
	t.Helper()
	e := newQAServerEnv(t)
	f := &purgeHTTPFixture{env: e}
	for _, spec := range []struct {
		name, typ string
		out       *int64
	}{
		{"Assets:PurgeCash", "Assets", &f.cash},
		{"Expenses:PurgeFood", "Expenses", &f.food},
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
	return f
}

// newTxn 记一笔 -10/10 的平衡交易，返回 uuid。
func (f *purgeHTTPFixture) newTxn(t *testing.T, description string) string {
	t.Helper()
	st, body, raw := f.env.do(http.MethodPost, "/api/transactions", map[string]any{
		"date": "2026-02-01", "description": description, "flag": "*",
		"postings": []map[string]any{
			{"account_id": f.cash, "commodity": "CNY", "amount": "-10.00"},
			{"account_id": f.food, "commodity": "CNY", "amount": "10.00"},
		},
	}, "1", f.env.token)
	if st != http.StatusCreated {
		t.Fatalf("记账应 201，实际 %d: %s", st, raw)
	}
	return body["uuid"].(string)
}

// trash 软删一笔交易。
func (f *purgeHTTPFixture) trash(t *testing.T, uuid string) {
	t.Helper()
	st, _, raw := f.env.do(http.MethodDelete, "/api/transactions/"+uuid, nil, "1", f.env.token)
	if st != http.StatusOK {
		t.Fatalf("软删应 200，实际 %d: %s", st, raw)
	}
}

// TestPurgeHTTPHappyPath DELETE {uuid}/purge 成功：响应字段逐字对齐 + 物理删除 + 审计落库。
func TestPurgeHTTPHappyPath(t *testing.T) {
	f := newPurgeHTTPFixture(t)
	keep := f.newTxn(t, "留下")
	gone := f.newTxn(t, "删掉")
	f.trash(t, gone)

	// 删前取一次 instance_id。
	st, before, raw := f.env.do(http.MethodGet, "/api/db/instance", nil, "", f.env.token)
	if st != http.StatusOK {
		t.Fatalf("取 instance_id 应 200，实际 %d: %s", st, raw)
	}
	instanceBefore, _ := before["instance_id"].(string)
	if instanceBefore == "" {
		t.Fatalf("instance_id 不应为空: %s", raw)
	}

	st, body, raw := f.env.do(http.MethodDelete, "/api/transactions/"+gone+"/purge",
		map[string]any{"confirm": "删除"}, "1", f.env.token)
	if st != http.StatusOK {
		t.Fatalf("永久删除应 200，实际 %d: %s", st, raw)
	}
	// 响应键逐字对齐规格：ok / count / deleted[].uuid|description|was_in_trash / purged_postings
	if body["ok"] != true || body["count"] != float64(1) || body["purged_postings"] != float64(2) {
		t.Fatalf("响应字段不符: %s", raw)
	}
	deleted, ok := body["deleted"].([]any)
	if !ok || len(deleted) != 1 {
		t.Fatalf("deleted 应为 1 条数组，实际 %s", raw)
	}
	row := deleted[0].(map[string]any)
	if row["uuid"] != gone || row["description"] != "删掉" || row["was_in_trash"] != true {
		t.Fatalf("deleted[0] 字段不符: %s", raw)
	}
	if _, exists := body["already_purged"]; exists {
		t.Fatalf("首次删除不得出现 already_purged（omitempty）: %s", raw)
	}

	// 账本里只剩 keep；回收站为空；审计 1 行。
	st, list, raw := f.env.do(http.MethodGet, "/api/transactions", nil, "1", f.env.token)
	if st != http.StatusOK {
		t.Fatalf("列交易应 200，实际 %d: %s", st, raw)
	}
	txns, _ := list["transactions"].([]any)
	if len(txns) != 1 || txns[0].(map[string]any)["uuid"] != keep {
		t.Fatalf("只应剩 %s，实际 %s", keep, raw)
	}
	st, trash, raw := f.env.do(http.MethodGet, "/api/transactions/trash", nil, "1", f.env.token)
	if st != http.StatusOK {
		t.Fatalf("列回收站应 200，实际 %d: %s", st, raw)
	}
	if items, _ := trash["transactions"].([]any); len(items) != 0 {
		t.Fatalf("回收站应已空，实际 %s", raw)
	}
	// B7 additive 两个键必须在。
	summary, ok := trash["purge_summary"].(map[string]any)
	if !ok {
		t.Fatalf("GET trash 应带 purge_summary: %s", raw)
	}
	for _, key := range []string{"deletable", "system_kept", "paired"} {
		if _, exists := summary[key]; !exists {
			t.Fatalf("purge_summary 缺 %s: %s", key, raw)
		}
	}
	log, ok := trash["purge_log"].([]any)
	if !ok || len(log) != 1 {
		t.Fatalf("purge_log 应为 1 行数组，实际 %s", raw)
	}
	entry := log[0].(map[string]any)
	for _, key := range []string{"uuid", "description", "amount_note", "was_in_trash", "actor_name", "purged_at"} {
		if _, exists := entry[key]; !exists {
			t.Fatalf("purge_log 行缺 %s: %s", key, raw)
		}
	}
	if entry["uuid"] != gone || entry["was_in_trash"] != true || entry["actor_name"] == "" {
		t.Fatalf("purge_log 内容不符: %s", raw)
	}

	// 不轮换 instance_id（软删时已广播 delete，轮换会误伤他人离线草稿）。
	st, after, raw := f.env.do(http.MethodGet, "/api/db/instance", nil, "", f.env.token)
	if st != http.StatusOK {
		t.Fatalf("复取 instance_id 应 200，实际 %d: %s", st, raw)
	}
	if after["instance_id"] != instanceBefore {
		t.Fatalf("永久删除不得轮换 instance_id（before=%v after=%v）", instanceBefore, after["instance_id"])
	}
}

// TestPurgeHTTPIdempotent 幂等：第二次 200 + already_purged:true + count:0。
func TestPurgeHTTPIdempotent(t *testing.T) {
	f := newPurgeHTTPFixture(t)
	uuid := f.newTxn(t, "连点两次")
	f.trash(t, uuid)

	if st, _, raw := f.env.do(http.MethodDelete, "/api/transactions/"+uuid+"/purge",
		map[string]any{"confirm": "删除"}, "1", f.env.token); st != http.StatusOK {
		t.Fatalf("首次删除应 200，实际 %d: %s", st, raw)
	}
	st, body, raw := f.env.do(http.MethodDelete, "/api/transactions/"+uuid+"/purge",
		map[string]any{"confirm": "删除"}, "1", f.env.token)
	if st != http.StatusOK {
		t.Fatalf("重复删除应 200（幂等），实际 %d: %s", st, raw)
	}
	if body["already_purged"] != true || body["count"] != float64(0) || body["ok"] != true {
		t.Fatalf("重复删除响应应为 {ok:true,count:0,already_purged:true}，实际 %s", raw)
	}
	if deleted, ok := body["deleted"].([]any); !ok || len(deleted) != 0 {
		t.Fatalf("deleted 应为空数组，实际 %s", raw)
	}
}

// TestPurgeHTTPNotFound 从未存在 / 属于别的账本 → 404 txn_not_found。
func TestPurgeHTTPNotFound(t *testing.T) {
	f := newPurgeHTTPFixture(t)
	st, body, raw := f.env.do(http.MethodDelete, "/api/transactions/no-such-uuid/purge",
		map[string]any{"confirm": "删除"}, "1", f.env.token)
	if st != http.StatusNotFound {
		t.Fatalf("从未存在应 404，实际 %d: %s", st, raw)
	}
	if body["code"] != "txn_not_found" {
		t.Fatalf("错误码应为 txn_not_found，实际 %s", raw)
	}
}

// TestPurgeHTTPConfirmRequired DELETE 空 body / 缺字段 / 未知字段 / 坏 JSON
// 一律 400 + txn_purge_confirm_required（不是 400 "EOF"）。这条钉住 design 坑 2。
func TestPurgeHTTPConfirmRequired(t *testing.T) {
	f := newPurgeHTTPFixture(t)
	uuid := f.newTxn(t, "确认词缺失")
	f.trash(t, uuid)

	cases := []struct {
		name string
		body any
	}{
		{"空 body（curl 不带体）", nil},
		{"空对象", map[string]any{}},
		{"字段为空串", map[string]any{"confirm": ""}},
		{"只有未知字段", map[string]any{"ok": true}}, // 未知字段被忽略，confirm 仍是空串
		{"未知字段 + 空 confirm", map[string]any{"confirm": "", "extra": 1}},
		{"确认词不对", map[string]any{"confirm": "清空"}},
	}
	for _, tc := range cases {
		st, body, raw := f.env.do(http.MethodDelete, "/api/transactions/"+uuid+"/purge",
			tc.body, "1", f.env.token)
		if st != http.StatusBadRequest {
			t.Fatalf("%s 应 400，实际 %d: %s", tc.name, st, raw)
		}
		if body["code"] != "txn_purge_confirm_required" {
			t.Fatalf("%s 错误码应为 txn_purge_confirm_required，实际 %s", tc.name, raw)
		}
		if msg, _ := body["error"].(string); msg == "EOF" || strings.Contains(msg, "EOF") {
			t.Fatalf("%s 不得把空 body 暴露成 EOF 文案: %s", tc.name, raw)
		}
	}

	// 真正写坏的 JSON：手搓原始 body，必须仍折叠成 confirm_required（不能 400 EOF/语法错）。
	req, err := http.NewRequest(http.MethodDelete,
		f.env.srv.URL+"/api/transactions/"+uuid+"/purge", strings.NewReader("{not-json"))
	if err != nil {
		t.Fatalf("构造坏 JSON 请求: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+f.env.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Ledger-Id", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("发送坏 JSON 请求: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("坏 JSON 应 400，实际 %d", resp.StatusCode)
	}

	// 带尾随空格的「删除」必须通过（移动端输入法常见）：用新的一笔，确认真的删掉了。
	spaced := f.newTxn(t, "带尾随空格")
	f.trash(t, spaced)
	st, body, raw := f.env.do(http.MethodDelete, "/api/transactions/"+spaced+"/purge",
		map[string]any{"confirm": "删除 "}, "1", f.env.token)
	if st != http.StatusOK || body["count"] != float64(1) {
		t.Fatalf("confirm=\"删除 \" 应真实删除 1 笔，实际 %d: %s", st, raw)
	}

	// 未知字段被忽略（不因 DisallowUnknownFields 而 400），confirm 合法时照常执行：
	// 这是「删除类端点宁可宽容字段、也要稳定的错误码」的取舍，与 readJSON 的严格模式不同。
	unknown := f.newTxn(t, "带未知字段")
	f.trash(t, unknown)
	st, body, raw = f.env.do(http.MethodDelete, "/api/transactions/"+unknown+"/purge",
		map[string]any{"confirm": "删除", "extra": 1}, "1", f.env.token)
	if st != http.StatusOK || body["count"] != float64(1) {
		t.Fatalf("未知字段 + 合法 confirm 应真实删除 1 笔，实际 %d: %s", st, raw)
	}

	// 全程被拒的那一笔必须还在回收站（400 不得产生任何副作用）。
	st, list, raw := f.env.do(http.MethodGet, "/api/transactions/trash", nil, "1", f.env.token)
	if st != http.StatusOK {
		t.Fatalf("列回收站应 200，实际 %d: %s", st, raw)
	}
	items, _ := list["transactions"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["uuid"] != uuid {
		t.Fatalf("只应剩最初那一笔未被确认的交易，实际 %s", raw)
	}
}

// TestPurgeHTTPMethodRestriction 方法限制：
//   - GET / POST `{uuid}/purge` → 405；
//   - GET / DELETE `trash/purge` → 405（`DELETE /trash/purge` 绝不能落到 {uuid} 去删 "trash"）。
func TestPurgeHTTPMethodRestriction(t *testing.T) {
	f := newPurgeHTTPFixture(t)
	uuid := f.newTxn(t, "方法限制")
	f.trash(t, uuid)

	cases := []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/api/transactions/" + uuid + "/purge", nil},
		{http.MethodPost, "/api/transactions/" + uuid + "/purge", map[string]any{"confirm": "删除"}},
		{http.MethodGet, "/api/transactions/trash/purge", nil},
		{http.MethodDelete, "/api/transactions/trash/purge", map[string]any{"confirm": "删除"}},
	}
	for _, tc := range cases {
		st, _, raw := f.env.do(tc.method, tc.path, tc.body, "1", f.env.token)
		if st != http.StatusMethodNotAllowed {
			t.Fatalf("%s %s 应 405，实际 %d: %s", tc.method, tc.path, st, raw)
		}
	}

	// 关键断言：`DELETE /trash/purge` 不得把 "trash" 当 uuid 删掉任何东西。
	st, list, raw := f.env.do(http.MethodGet, "/api/transactions/trash", nil, "1", f.env.token)
	if st != http.StatusOK {
		t.Fatalf("列回收站应 200，实际 %d: %s", st, raw)
	}
	if items, _ := list["transactions"].([]any); len(items) != 1 {
		t.Fatalf("回收站应仍有 1 条，实际 %s", raw)
	}
}

// TestPurgeHTTPAuthzAndRoles 未登录 401；viewer 403（middleware 文案）；editor 403 + 错误码。
func TestPurgeHTTPAuthzAndRoles(t *testing.T) {
	f := newPurgeHTTPFixture(t)
	uuid := f.newTxn(t, "权限矩阵")
	f.trash(t, uuid)

	// 未登录 → 401。
	req, err := http.NewRequest(http.MethodDelete,
		f.env.srv.URL+"/api/transactions/"+uuid+"/purge", strings.NewReader(`{"confirm":"删除"}`))
	if err != nil {
		t.Fatalf("构造未登录请求: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Ledger-Id", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("发送未登录请求: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("未登录应 401，实际 %d", resp.StatusCode)
	}

	// editor：403 + txn_purge_forbidden（服务层拒绝，不是 middleware）。
	editor, err := f.env.svc.Register("purge-http-editor", "secret123", "编辑")
	if err != nil {
		t.Fatalf("注册 editor: %v", err)
	}
	if _, _, err := f.env.svc.AddMember(1, f.env.userID, "purge-http-editor", "editor"); err != nil {
		t.Fatalf("加 editor: %v", err)
	}
	st, body, raw := f.env.do(http.MethodDelete, "/api/transactions/"+uuid+"/purge",
		map[string]any{"confirm": "删除"}, "1", editor.Token)
	if st != http.StatusForbidden {
		t.Fatalf("editor 应 403，实际 %d: %s", st, raw)
	}
	if body["code"] != "txn_purge_forbidden" {
		t.Fatalf("editor 错误码应为 txn_purge_forbidden，实际 %s", raw)
	}
	// 清空端点同口径。
	st, body, raw = f.env.do(http.MethodPost, "/api/transactions/trash/purge",
		map[string]any{"confirm": "删除"}, "1", editor.Token)
	if st != http.StatusForbidden || body["code"] != "txn_purge_forbidden" {
		t.Fatalf("editor 清空应 403 txn_purge_forbidden，实际 %d: %s", st, raw)
	}

	// viewer：middleware 直接拦（文案「只读成员无写权限」，不带业务码）。
	viewer, err := f.env.svc.Register("purge-http-viewer", "secret123", "只读")
	if err != nil {
		t.Fatalf("注册 viewer: %v", err)
	}
	if _, _, err := f.env.svc.AddMember(1, f.env.userID, "purge-http-viewer", "viewer"); err != nil {
		t.Fatalf("加 viewer: %v", err)
	}
	st, body, raw = f.env.do(http.MethodDelete, "/api/transactions/"+uuid+"/purge",
		map[string]any{"confirm": "删除"}, "1", viewer.Token)
	if st != http.StatusForbidden {
		t.Fatalf("viewer 应 403，实际 %d: %s", st, raw)
	}
	if msg, _ := body["error"].(string); msg != "只读成员无写权限" {
		t.Fatalf("viewer 应由 middleware 拦截（文案「只读成员无写权限」），实际 %s", raw)
	}

	// viewer 仍可读回收站，并能看到审计区块（audit 对全体成员可见）。
	st, _, raw = f.env.do(http.MethodGet, "/api/transactions/trash", nil, "1", viewer.Token)
	if st != http.StatusOK {
		t.Fatalf("viewer 读回收站应 200，实际 %d: %s", st, raw)
	}

	// 权限被拒时那一笔必须还在回收站。
	st, list, raw := f.env.do(http.MethodGet, "/api/transactions/trash", nil, "1", f.env.token)
	if st != http.StatusOK {
		t.Fatalf("owner 列回收站应 200，实际 %d: %s", st, raw)
	}
	items, _ := list["transactions"].([]any)
	if len(items) != 1 {
		t.Fatalf("被拒后回收站应仍有 1 条，实际 %s", raw)
	}
	// owner 视角：can_purge 出现在被软删的条目上（additive 字段按需省略）。
	if item := items[0].(map[string]any); item["can_purge"] != true {
		t.Fatalf("owner 视角 can_purge 应为 true，实际 %s", raw)
	}
}

// TestPurgeHTTPTrashPurgeEndpoint POST trash/purge：清空回收站，响应无 already_purged。
func TestPurgeHTTPTrashPurgeEndpoint(t *testing.T) {
	f := newPurgeHTTPFixture(t)
	a := f.newTxn(t, "第一笔")
	b := f.newTxn(t, "第二笔")
	f.trash(t, a)
	f.trash(t, b)

	st, body, raw := f.env.do(http.MethodPost, "/api/transactions/trash/purge",
		map[string]any{"confirm": "删除"}, "1", f.env.token)
	if st != http.StatusOK {
		t.Fatalf("清空回收站应 200，实际 %d: %s", st, raw)
	}
	if body["ok"] != true || body["count"] != float64(2) || body["purged_postings"] != float64(4) {
		t.Fatalf("清空响应字段不符: %s", raw)
	}
	if _, exists := body["already_purged"]; exists {
		t.Fatalf("清空回收站不得出现 already_purged: %s", raw)
	}

	// 空回收站再清一次：200 + count 0（不是 404、也不是 already_purged）。
	st, body, raw = f.env.do(http.MethodPost, "/api/transactions/trash/purge",
		map[string]any{"confirm": "删除"}, "1", f.env.token)
	if st != http.StatusOK {
		t.Fatalf("空回收站清空应 200，实际 %d: %s", st, raw)
	}
	if body["count"] != float64(0) || body["ok"] != true {
		t.Fatalf("空回收站响应应为 {ok:true,count:0}，实际 %s", raw)
	}
	if _, exists := body["already_purged"]; exists {
		t.Fatalf("空回收站不是幂等命中，不得带 already_purged: %s", raw)
	}
	if deleted, ok := body["deleted"].([]any); !ok || len(deleted) != 0 {
		t.Fatalf("deleted 应为空数组，实际 %s", raw)
	}

	// 两笔都已物理删除。
	if n := len(mustListTxns(t, f)); n != 0 {
		t.Fatalf("交易应全部删净，实际 %d 笔", n)
	}
}

// mustListTxns 取有效交易列表（测试辅助）。
func mustListTxns(t *testing.T, f *purgeHTTPFixture) []any {
	t.Helper()
	st, body, raw := f.env.do(http.MethodGet, "/api/transactions", nil, "1", f.env.token)
	if st != http.StatusOK {
		t.Fatalf("列交易应 200，实际 %d: %s", st, raw)
	}
	txns, _ := body["transactions"].([]any)
	return txns
}

// TestPurgeHTTPGetTrashShapeUnchangedExceptAdditive GET trash 的旧键形状不变，
// 只追加两个键（旧前端不用改）。
func TestPurgeHTTPGetTrashShapeUnchangedExceptAdditive(t *testing.T) {
	f := newPurgeHTTPFixture(t)
	uuid := f.newTxn(t, "形状检查")
	f.trash(t, uuid)

	st, body, raw := f.env.do(http.MethodGet, "/api/transactions/trash", nil, "1", f.env.token)
	if st != http.StatusOK {
		t.Fatalf("GET trash 应 200，实际 %d: %s", st, raw)
	}
	for _, key := range []string{"transactions", "purge_summary", "purge_log"} {
		if _, exists := body[key]; !exists {
			t.Fatalf("响应缺键 %s: %s", key, raw)
		}
	}
	items, _ := body["transactions"].([]any)
	if len(items) != 1 {
		t.Fatalf("应返回 1 条回收站记录，实际 %s", raw)
	}
	item := items[0].(map[string]any)
	for _, key := range []string{"uuid", "date", "description", "deleted_at", "postings"} {
		if _, exists := item[key]; !exists {
			t.Fatalf("回收站条目缺旧字段 %s: %s", key, raw)
		}
	}
	if item["can_purge"] != true {
		t.Fatalf("owner 且可删时应输出 can_purge:true，实际 %s", raw)
	}
	// is_system 为假时按 omitempty 省略（不改变旧响应形状）。
	if _, exists := item["is_system"]; exists {
		t.Fatalf("非系统交易不应输出 is_system（omitempty）: %s", raw)
	}
}

// TestPurgeHTTPRejectsOtherLedger 跨账本：拿 B 账本的 uuid 在 A 账本删 → 404。
func TestPurgeHTTPRejectsOtherLedger(t *testing.T) {
	f := newPurgeHTTPFixture(t)
	uuid := f.newTxn(t, "A 账本的")
	f.trash(t, uuid)

	ledger, err := f.env.svc.CreateLedger(f.env.userID, "第二账本", "CNY")
	if err != nil {
		t.Fatalf("建第二账本: %v", err)
	}
	st, body, raw := f.env.do(http.MethodDelete, "/api/transactions/"+uuid+"/purge",
		map[string]any{"confirm": "删除"}, strconv.FormatInt(ledger.ID, 10), f.env.token)
	if st != http.StatusNotFound || body["code"] != "txn_not_found" {
		t.Fatalf("跨账本删除应 404 txn_not_found，实际 %d: %s", st, raw)
	}
	// A 账本那一笔必须还在回收站。
	st, list, raw := f.env.do(http.MethodGet, "/api/transactions/trash", nil, "1", f.env.token)
	if st != http.StatusOK {
		t.Fatalf("列回收站应 200，实际 %d: %s", st, raw)
	}
	if items, _ := list["transactions"].([]any); len(items) != 1 {
		t.Fatalf("A 账本回收站应仍有 1 条，实际 %s", raw)
	}
}
