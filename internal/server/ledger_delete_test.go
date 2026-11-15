package server

// 0.6.0 S1 账本删除的 HTTP 层集成测试：路由 + 鉴权中间件 + handler + service +
// SQLite 全部走真实装配（备份快照用可计数回调替代，避免测试依赖磁盘快照）。
// 覆盖 AC-1.2（成员门禁）、AC-1.4 / AC-1.6（软删后 R3 回退与 403 ledger_deleted）。

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"familyledger/internal/db"
	"familyledger/internal/handler"
	"familyledger/internal/repository"
	"familyledger/internal/service"
)

type ledgerDeleteHTTPEnv struct {
	t      *testing.T
	srv    *httptest.Server
	svc    *service.Service
	conn   *sql.DB
	token  string
	userID int64
	calls  *int
}

func newLedgerDeleteHTTPEnv(t *testing.T) *ledgerDeleteHTTPEnv {
	t.Helper()
	dir := t.TempDir()
	conn, err := db.Open(filepath.Join(dir, "test.db"), filepath.Join("..", "..", "schema.sql"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { conn.Close() })

	svc := service.New(repository.New(conn))
	calls := 0
	svc.ConfigureSnapshot(func(trigger string) error {
		if trigger != "pre-ledger-delete" {
			t.Fatalf("快照 trigger 期望 pre-ledger-delete，实际 %q", trigger)
		}
		calls++
		return nil
	})
	owner, err := svc.Register("alice", "secret123", "Alice")
	if err != nil {
		t.Fatalf("register owner: %v", err)
	}
	h := handler.New(svc, nil)
	e := &ledgerDeleteHTTPEnv{
		t:      t,
		svc:    svc,
		conn:   conn,
		token:  owner.Token,
		userID: owner.User.ID,
		calls:  &calls,
	}
	e.srv = httptest.NewServer(newRouter(h, svc, ""))
	t.Cleanup(e.srv.Close)
	return e
}

// do 发起带 Bearer 的请求（Bearer 豁免 CSRF）；ledgerID 为空表示不带 X-Ledger-Id。
func (e *ledgerDeleteHTTPEnv) do(method, path string, body any, ledgerID string) (int, []byte) {
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
	req.Header.Set("Authorization", "Bearer "+e.token)
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
	return resp.StatusCode, raw
}

func decodeLedgerDeleteBody(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("解析响应体 %q: %v", string(raw), err)
	}
	return m
}

// TestDeleteLedgerHTTPLastLedger 最后一个账本禁止删除：409 last_ledger、零快照。
func TestDeleteLedgerHTTPLastLedger(t *testing.T) {
	e := newLedgerDeleteHTTPEnv(t)

	status, raw := e.do(http.MethodDelete, "/api/ledgers/1", nil, "")
	if status != http.StatusConflict {
		t.Fatalf("期望 409，实际 %d: %s", status, string(raw))
	}
	if got := decodeLedgerDeleteBody(t, raw)["code"]; got != "last_ledger" {
		t.Fatalf("错误码期望 last_ledger，实际 %v", got)
	}
	if *e.calls != 0 {
		t.Fatalf("最后账本门禁不应生成快照，实际 %d 次", *e.calls)
	}
}

// TestDeleteLedgerHTTPHasMembers 成员门禁：409 ledger_has_members，明细不暴露凭据。
func TestDeleteLedgerHTTPHasMembers(t *testing.T) {
	e := newLedgerDeleteHTTPEnv(t)
	if _, err := e.svc.Register("bob", "secret123", "Bob"); err != nil {
		t.Fatalf("register bob: %v", err)
	}
	if _, _, err := e.svc.AddMember(1, e.userID, "bob", "editor"); err != nil {
		t.Fatalf("add member: %v", err)
	}
	if _, err := e.svc.CreateLedger(e.userID, "第二个账本", "CNY"); err != nil {
		t.Fatalf("create ledger: %v", err)
	}

	status, raw := e.do(http.MethodDelete, "/api/ledgers/1", nil, "")
	if status != http.StatusConflict {
		t.Fatalf("期望 409，实际 %d: %s", status, string(raw))
	}
	body := decodeLedgerDeleteBody(t, raw)
	if body["code"] != "ledger_has_members" {
		t.Fatalf("错误码期望 ledger_has_members，实际 %v", body["code"])
	}
	if body["member_count"] != float64(1) {
		t.Fatalf("member_count 期望 1，实际 %v", body["member_count"])
	}
	members, ok := body["members"].([]any)
	if !ok || len(members) != 1 {
		t.Fatalf("members 明细错误: %#v", body["members"])
	}
	ref, ok := members[0].(map[string]any)
	if !ok {
		t.Fatalf("成员项类型错误: %#v", members[0])
	}
	if ref["username"] != "bob" {
		t.Fatalf("成员用户名错误: %#v", ref)
	}
	for _, forbidden := range []string{"password_hash", "password", "token"} {
		if _, exists := ref[forbidden]; exists {
			t.Fatalf("成员明细不应暴露 %s", forbidden)
		}
	}
	if *e.calls != 0 {
		t.Fatalf("成员门禁不应生成快照，实际 %d 次", *e.calls)
	}
}

// TestDeleteLedgerHTTPSuccessAndFallback 删除 id=1 后：
// 快照 1 次、列表只剩新账本、无头业务请求不再全量 403、显式指向已删账本 403 ledger_deleted。
func TestDeleteLedgerHTTPSuccessAndFallback(t *testing.T) {
	e := newLedgerDeleteHTTPEnv(t)
	second, err := e.svc.CreateLedger(e.userID, "第二个账本", "CNY")
	if err != nil {
		t.Fatalf("create ledger: %v", err)
	}

	status, raw := e.do(http.MethodDelete, "/api/ledgers/1", nil, "")
	if status != http.StatusOK {
		t.Fatalf("期望 200，实际 %d: %s", status, string(raw))
	}
	if got := decodeLedgerDeleteBody(t, raw)["ok"]; got != true {
		t.Fatalf("响应应含 ok:true，实际 %v", got)
	}
	if *e.calls != 1 {
		t.Fatalf("应生成 1 份 pre-ledger-delete 快照，实际 %d", *e.calls)
	}

	// GET /api/ledgers 不再返回已删账本。
	status, raw = e.do(http.MethodGet, "/api/ledgers", nil, "")
	if status != http.StatusOK {
		t.Fatalf("GET /api/ledgers 期望 200，实际 %d: %s", status, string(raw))
	}
	list := decodeLedgerDeleteBody(t, raw)["ledgers"].([]any)
	if len(list) != 1 {
		t.Fatalf("账本清单应只剩 1 条，实际 %d", len(list))
	}
	first := list[0].(map[string]any)
	if first["id"] != float64(second.ID) {
		t.Fatalf("剩余账本应为 %d，实际 %v", second.ID, first["id"])
	}

	// R3：不带 X-Ledger-Id 的旧客户端 / curl 不再全量 403。
	status, raw = e.do(http.MethodGet, "/api/transactions", nil, "")
	if status != http.StatusOK {
		t.Fatalf("无头业务请求应回退到最小有效账本并返回 200，实际 %d: %s", status, string(raw))
	}

	// 显式指向已删账本：403 + 稳定码 ledger_deleted。
	status, raw = e.do(http.MethodGet, "/api/transactions", nil, "1")
	if status != http.StatusForbidden {
		t.Fatalf("指向已删账本应 403，实际 %d: %s", status, string(raw))
	}
	if got := decodeLedgerDeleteBody(t, raw)["code"]; got != "ledger_deleted" {
		t.Fatalf("错误码期望 ledger_deleted，实际 %v", got)
	}
}

// TestLedgerIDFromRequestFallbackToMinActive 直接验证 R3 回退函数：
// 有合法头用之；无头时取用户所属最小有效账本，软删后自动顺延。
func TestLedgerIDFromRequestFallbackToMinActive(t *testing.T) {
	e := newLedgerDeleteHTTPEnv(t)
	second, err := e.svc.CreateLedger(e.userID, "第二个账本", "CNY")
	if err != nil {
		t.Fatalf("create ledger: %v", err)
	}

	r := httptest.NewRequest(http.MethodGet, "/api/transactions", nil)
	got, err := ledgerIDFromRequest(r, e.userID, e.svc)
	if err != nil || got != 1 {
		t.Fatalf("无头请求应回退 id=1，实际 %d（err=%v）", got, err)
	}

	withHeader := httptest.NewRequest(http.MethodGet, "/api/transactions", nil)
	withHeader.Header.Set("X-Ledger-Id", "2")
	got, err = ledgerIDFromRequest(withHeader, e.userID, e.svc)
	if err != nil || got != 2 {
		t.Fatalf("合法 X-Ledger-Id 应优先，实际 %d（err=%v）", got, err)
	}

	if _, err := e.conn.Exec(`UPDATE ledgers SET deleted_at=datetime('now') WHERE id=1`); err != nil {
		t.Fatalf("模拟软删: %v", err)
	}
	got, err = ledgerIDFromRequest(r, e.userID, e.svc)
	if err != nil || got != second.ID {
		t.Fatalf("软删 id=1 后应回退到 %d，实际 %d（err=%v）", second.ID, got, err)
	}
}
