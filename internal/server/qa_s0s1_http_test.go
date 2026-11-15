package server

// QA 独立 HTTP 层回归（第二层质量关卡，刻意采用与工程师用例不同的构造角度）：
//
//   - 已软删账本「所有」业务端点（11 条，含 GET/POST）逐一断言 403 +
//     code=ledger_deleted，而非只测 GET /api/transactions 一条；
//   - editor 成员显式 DELETE 被拒、viewer 写拦截未被削弱、viewer 仍可读；
//   - 409 ledger_has_members 对整个响应体做「递归凭据扫描」，而非只查 3 个固定键名；
//   - GET /api/ledgers 的 additive 统计与旧字段不丢、POST/PATCH 行为不变；
//   - 快照失败（底层英文报错）时 HTTP 层用户可见 error 纯中文、数据未变。
//
// 本文件只新增测试，不改任何产品代码。

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"familyledger/internal/db"
	"familyledger/internal/handler"
	"familyledger/internal/repository"
	"familyledger/internal/service"
)

type qaServerEnv struct {
	t         *testing.T
	srv       *httptest.Server
	svc       *service.Service
	conn      *sql.DB
	token     string
	userID    int64
	snapCalls *int
	snapErr   error
}

func newQAServerEnv(t *testing.T) *qaServerEnv {
	t.Helper()
	dir := t.TempDir()
	conn, err := db.Open(filepath.Join(dir, "qa.db"), filepath.Join("..", "..", "schema.sql"))
	if err != nil {
		t.Fatalf("打开测试库: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	svc := service.New(repository.New(conn))
	calls := 0
	e := &qaServerEnv{t: t, conn: conn, svc: svc, snapCalls: &calls}
	svc.ConfigureSnapshot(func(trigger string) error {
		if trigger != "pre-ledger-delete" {
			t.Errorf("快照 trigger 期望 pre-ledger-delete，实际 %q", trigger)
		}
		(*e.snapCalls)++
		return e.snapErr
	})
	owner, err := svc.Register("qa-http-owner", "secret123", "QA")
	if err != nil {
		t.Fatalf("注册 owner: %v", err)
	}
	e.token = owner.Token
	e.userID = owner.User.ID
	h := handler.New(svc, nil)
	e.srv = httptest.NewServer(newRouter(h, svc, ""))
	t.Cleanup(e.srv.Close)
	return e
}

// do 发起带 Bearer 的请求（Bearer 豁免 CSRF）；ledgerID 为空表示不带 X-Ledger-Id。
func (e *qaServerEnv) do(method, path string, body any, ledgerID, token string) (int, map[string]any, string) {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			e.t.Fatalf("marshal body: %v", err)
		}
		rd = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, e.srv.URL+path, rd)
	if err != nil {
		e.t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if ledgerID != "" {
		req.Header.Set("X-Ledger-Id", ledgerID)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		e.t.Fatalf("read body: %v", err)
	}
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return resp.StatusCode, m, string(raw)
}

func qaServerASCIIRe() *regexp.Regexp { return regexp.MustCompile(`[A-Za-z]`) }

// qaAssertNoCredentials 递归遍历响应体，断言任何层级都不含凭据字段/值。
func qaAssertNoCredentials(t *testing.T, v any, path string) {
	t.Helper()
	banned := []string{"password", "hash", "token", "secret", "credential", "bcrypt", "pwd"}
	scan := func(s string) {
		lower := strings.ToLower(s)
		for _, b := range banned {
			if strings.Contains(lower, b) {
				t.Fatalf("响应体 %s 出现凭据字样 %q：%q", path, b, s)
			}
		}
	}
	switch x := v.(type) {
	case map[string]any:
		for k, val := range x {
			scan(k)
			qaAssertNoCredentials(t, val, path+"."+k)
		}
	case []any:
		for i, val := range x {
			qaAssertNoCredentials(t, val, path+"["+strconv.Itoa(i)+"]")
		}
	case string:
		scan(x)
	}
}

// TestQA_DeletedLedgerAllBusinessEndpoints403 AC-1.4：软删账本后，
// 所有需要账本上下文的业务端点（含写操作）一律 403 + ledger_deleted。
func TestQA_DeletedLedgerAllBusinessEndpoints403(t *testing.T) {
	e := newQAServerEnv(t)
	if _, err := e.svc.CreateLedger(e.userID, "第二账本", "CNY"); err != nil {
		t.Fatalf("建第二账本: %v", err)
	}
	st, _, raw := e.do(http.MethodDelete, "/api/ledgers/1", nil, "", e.token)
	if st != http.StatusOK {
		t.Fatalf("删除应成功，实际 %d: %s", st, raw)
	}
	if *e.snapCalls != 1 {
		t.Fatalf("应生成 1 份 pre-ledger-delete 快照，实际 %d", *e.snapCalls)
	}

	endpoints := []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/api/accounts", nil},
		{http.MethodPost, "/api/accounts", map[string]any{"name": "Assets:QA:X", "type": "Assets", "open_date": "2026-11-01", "commodity": "CNY"}},
		{http.MethodGet, "/api/transactions", nil},
		{http.MethodPost, "/api/transactions", map[string]any{"date": "2026-11-02", "description": "x", "postings": []any{}}},
		{http.MethodGet, "/api/transactions/trash", nil},
		{http.MethodGet, "/api/identity/check", nil},
		{http.MethodGet, "/api/export", nil},
		{http.MethodGet, "/api/export/archive", nil},
		{http.MethodGet, "/api/sync/pull?since=0&client_id=qa", nil},
		{http.MethodPost, "/api/sync/push", map[string]any{"client_id": "qa", "changes": []any{}}},
		{http.MethodGet, "/api/ledger/members", nil},
	}
	for _, ep := range endpoints {
		st, m, raw := e.do(ep.method, ep.path, ep.body, "1", e.token)
		if st != http.StatusForbidden {
			t.Errorf("%s %s 期望 403，实际 %d: %s", ep.method, ep.path, st, raw)
			continue
		}
		if m["code"] != "ledger_deleted" {
			t.Errorf("%s %s 错误码应为 ledger_deleted，实际 %v", ep.method, ep.path, m["code"])
		}
	}
}

// TestQA_EditorCannotDelete_ViewerWriteBlocked AC-1.5 / N-06：
// editor 不获删除权（后端 requireOwner），viewer 写拦截未被削弱、读仍可用。
func TestQA_EditorCannotDelete_ViewerWriteBlocked(t *testing.T) {
	e := newQAServerEnv(t)
	if _, err := e.svc.CreateLedger(e.userID, "第二账本", "CNY"); err != nil {
		t.Fatal(err)
	}
	bob, err := e.svc.Register("qa-http-bob", "secret123", "Bob")
	if err != nil {
		t.Fatalf("注册 bob: %v", err)
	}
	memberID, _, err := e.svc.AddMember(1, e.userID, "qa-http-bob", "editor")
	if err != nil {
		t.Fatalf("添加 editor: %v", err)
	}

	// editor 显式 DELETE → 403（且不是成员门禁的 409，证明是权限拦截）。
	st, m, raw := e.do(http.MethodDelete, "/api/ledgers/1", nil, "", bob.Token)
	if st != http.StatusForbidden {
		t.Fatalf("editor 删除应 403，实际 %d: %s", st, raw)
	}
	if m["code"] == "ledger_has_members" {
		t.Fatalf("editor 应被权限拦截而非成员门禁，实际 %v", m["code"])
	}

	// 改为 viewer：写一律 403，读仍 200，删除仍 403。
	if _, err := e.conn.Exec(`UPDATE ledger_members SET role='viewer' WHERE ledger_id=1 AND user_id=?`, memberID); err != nil {
		t.Fatal(err)
	}
	st, _, raw = e.do(http.MethodPost, "/api/accounts",
		map[string]any{"name": "Assets:QA:Y", "type": "Assets", "open_date": "2026-11-01", "commodity": "CNY"},
		"1", bob.Token)
	if st != http.StatusForbidden {
		t.Fatalf("viewer 写操作应被后端拦截 403，实际 %d: %s", st, raw)
	}
	st, _, raw = e.do(http.MethodGet, "/api/accounts", nil, "1", bob.Token)
	if st != http.StatusOK {
		t.Fatalf("viewer 读操作应仍可用 200，实际 %d: %s", st, raw)
	}
	st, _, raw = e.do(http.MethodDelete, "/api/ledgers/1", nil, "", bob.Token)
	if st != http.StatusForbidden {
		t.Fatalf("viewer 删除应 403，实际 %d: %s", st, raw)
	}
}

// TestQA_HasMembersNoCredentialsRecursive AC-1.2：409 明细与计数同源、
// 整个响应体递归扫描不暴露任何凭据。
func TestQA_HasMembersNoCredentialsRecursive(t *testing.T) {
	e := newQAServerEnv(t)
	if _, err := e.svc.CreateLedger(e.userID, "第二账本", "CNY"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Register("qa-http-bob2", "secret123", "Bob"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.svc.AddMember(1, e.userID, "qa-http-bob2", "editor"); err != nil {
		t.Fatal(err)
	}

	st, m, raw := e.do(http.MethodDelete, "/api/ledgers/1", nil, "", e.token)
	if st != http.StatusConflict || m["code"] != "ledger_has_members" {
		t.Fatalf("期望 409 ledger_has_members，实际 %d: %s", st, raw)
	}
	if m["member_count"] != float64(1) {
		t.Fatalf("member_count 期望 1，实际 %v", m["member_count"])
	}
	members, ok := m["members"].([]any)
	if !ok || len(members) != 1 {
		t.Fatalf("members 明细应与计数同源（1 条），实际 %#v", m["members"])
	}
	ref, ok := members[0].(map[string]any)
	if !ok {
		t.Fatalf("成员项类型错误: %#v", members[0])
	}
	// 恰好只有 username / display_name 两个键，不多不少。
	if len(ref) != 2 || ref["username"] != "qa-http-bob2" || ref["display_name"] == nil {
		t.Fatalf("成员明细应仅含 username/display_name，实际 %#v", ref)
	}
	// 对整个响应体（含 error 文案、嵌套 members）做递归凭据扫描。
	qaAssertNoCredentials(t, m, "body")
	for _, leak := range []string{"password_hash", "password", "token", "bcrypt"} {
		if strings.Contains(strings.ToLower(raw), leak) {
			t.Fatalf("原始响应体泄漏 %q: %s", leak, raw)
		}
	}
	if *e.snapCalls != 0 {
		t.Fatalf("成员门禁失败不应生成快照，实际 %d 次", *e.snapCalls)
	}
}

// TestQA_ListLedgersAdditiveAndPostPatchUnchanged P1-03 / AC-1.1：
// 统计字段 additive、旧字段不丢；POST / PATCH 行为不变（含重名 409、空名 400）。
func TestQA_ListLedgersAdditiveAndPostPatchUnchanged(t *testing.T) {
	e := newQAServerEnv(t)
	st, m, raw := e.do(http.MethodGet, "/api/ledgers", nil, "", e.token)
	if st != http.StatusOK {
		t.Fatalf("GET /api/ledgers 期望 200，实际 %d: %s", st, raw)
	}
	list, ok := m["ledgers"].([]any)
	if !ok || len(list) != 1 {
		t.Fatalf("应返回 1 个账本，实际 %#v", m["ledgers"])
	}
	first := list[0].(map[string]any)
	for _, key := range []string{"id", "name", "opening_date", "role",
		"member_count", "account_count", "transaction_count"} {
		if _, exists := first[key]; !exists {
			t.Fatalf("GET /api/ledgers 缺少字段 %s（additive 应保留旧字段并追加统计）", key)
		}
	}
	if first["role"] != "owner" {
		t.Fatalf("role 应为 owner，实际 %v", first["role"])
	}

	// POST 新建 → 201，旧字段齐全。
	st, m, raw = e.do(http.MethodPost, "/api/ledgers",
		map[string]any{"name": "第三账本", "default_commodity": "CNY"}, "", e.token)
	if st != http.StatusCreated {
		t.Fatalf("POST /api/ledgers 期望 201，实际 %d: %s", st, raw)
	}
	if m["role"] != "owner" || m["opening_date"] == "" || m["name"] != "第三账本" {
		t.Fatalf("新建响应字段异常: %#v", m)
	}
	id := int64(m["id"].(float64))

	// 重名 → 被拒绝（非 2xx + 可读原因）。
	// 注意：PRD AC-1.1 期望 409，但 HEAD 基线与工作区的 CreateLedger 均直接
	// 返回原始 SQL 错误（未转 domain.ErrConflict），实际为 400。本批明确
	// 「POST/PATCH 行为不变」，故此处只断言「被拒绝且可读」，不硬性要求 409；
	// 该历史偏差作为观察项写入 QA 报告，不作为本批缺陷。
	st, m2, raw2 := e.do(http.MethodPost, "/api/ledgers",
		map[string]any{"name": "第三账本", "default_commodity": "CNY"}, "", e.token)
	if st < http.StatusBadRequest || st >= 500 {
		t.Fatalf("重名应被拒绝，实际 %d: %s", st, raw2)
	}
	if errText, _ := m2["error"].(string); errText == "" {
		t.Fatalf("重名应给出可读原因，实际 %s", raw2)
	}
	// 空名 → 400。
	st, _, _ = e.do(http.MethodPost, "/api/ledgers",
		map[string]any{"name": "", "default_commodity": "CNY"}, "", e.token)
	if st != http.StatusBadRequest {
		t.Fatalf("空名应 400，实际 %d", st)
	}

	// PATCH 改名 → 200，默认币种不丢。
	st, m, raw = e.do(http.MethodPatch, "/api/ledgers/"+strconv.FormatInt(id, 10),
		map[string]any{"name": "改名后", "default_commodity": "CNY"}, "", e.token)
	if st != http.StatusOK {
		t.Fatalf("PATCH 期望 200，实际 %d: %s", st, raw)
	}
	if m["name"] != "改名后" || m["default_commodity"] != "CNY" {
		t.Fatalf("PATCH 后字段异常: %#v", m)
	}
}

// TestQA_SnapshotFailureHTTPChineseOnly AC-1.3：底层英文报错只进日志，
// HTTP 响应体的 error 必须纯中文，且账本数据一行未变。
func TestQA_SnapshotFailureHTTPChineseOnly(t *testing.T) {
	e := newQAServerEnv(t)
	if _, err := e.svc.CreateLedger(e.userID, "第二账本", "CNY"); err != nil {
		t.Fatal(err)
	}
	e.snapErr = errors.New("SQLITE_CANTOPEN: unable to open database file (14)")

	st, m, raw := e.do(http.MethodDelete, "/api/ledgers/1", nil, "", e.token)
	if st != http.StatusBadRequest {
		t.Fatalf("快照失败期望 400，实际 %d: %s", st, raw)
	}
	msg, _ := m["error"].(string)
	if msg == "" {
		t.Fatalf("响应缺少 error 字段: %s", raw)
	}
	if qaServerASCIIRe().MatchString(msg) {
		t.Fatalf("用户可见 error 必须纯中文，不得含英文原文，实际 %q", msg)
	}
	for _, leak := range []string{"SQLITE", "unable", "database", "VACUUM", "14"} {
		if strings.Contains(msg, leak) {
			t.Fatalf("error 泄漏底层英文/错误号 %q: %q", leak, msg)
		}
	}
	if !strings.Contains(msg, "快照") || !strings.Contains(msg, "未删除") {
		t.Fatalf("文案应说明快照失败且账本未删除，实际 %q", msg)
	}
	// 数据未变：列表仍 2 条，deleted_at 仍为空。
	st, m, _ = e.do(http.MethodGet, "/api/ledgers", nil, "", e.token)
	if st != http.StatusOK || len(m["ledgers"].([]any)) != 2 {
		t.Fatalf("快照失败不得删账本，实际 status=%d list=%#v", st, m["ledgers"])
	}
	var deleted string
	if err := e.conn.QueryRow(`SELECT COALESCE(deleted_at,'') FROM ledgers WHERE id=1`).Scan(&deleted); err != nil {
		t.Fatal(err)
	}
	if deleted != "" {
		t.Fatalf("deleted_at 应仍为空，实际 %q", deleted)
	}
}
