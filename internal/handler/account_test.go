package handler

// 批量排序端点 handler 契约回归（P0）：
//   - 200 {ok:true,updated:N} 且 sort_order 真落库；
//   - 空列表 / 空 uuid / 负序号 / 重复 uuid / 非本账本 uuid / 坏 JSON → 400 + 中文原因；
//   - 校验失败时整批不落库、不写 sync_log。
// viewer 只读由 server 层 middleware 覆盖（accounts_sort_order_http_test.go）。

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"familyledger/internal/auth"
	"familyledger/internal/db"
	"familyledger/internal/repository"
	"familyledger/internal/service"
)

type sortOrderHandlerEnv struct {
	h    *Handler
	conn *sql.DB
}

func newSortOrderHandlerEnv(t *testing.T) *sortOrderHandlerEnv {
	t.Helper()
	conn, err := db.Open(
		filepath.Join(t.TempDir(), "account-handler.db"),
		filepath.Join("..", "..", "schema.sql"),
	)
	if err != nil {
		t.Fatalf("打开测试库: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	for _, q := range []string{
		`INSERT INTO users(id, username, password_hash, display_name) VALUES(1,'h-sort','x','甲')`,
		`INSERT INTO ledgers(id, name, owner_id) VALUES(1,'账本A',1)`,
		`INSERT INTO ledgers(id, name, owner_id) VALUES(2,'账本B',1)`,
		`INSERT INTO accounts(id, ledger_id, uuid, name, type, open_date)
		 VALUES(1,1,'u-a','Expenses:A','Expenses','2026-01-01')`,
		`INSERT INTO accounts(id, ledger_id, uuid, name, type, open_date)
		 VALUES(2,1,'u-b','Expenses:B','Expenses','2026-01-01')`,
		`INSERT INTO accounts(id, ledger_id, uuid, name, type, open_date)
		 VALUES(3,2,'u-other','Expenses:Other','Expenses','2026-01-01')`,
	} {
		if _, err := conn.Exec(q); err != nil {
			t.Fatalf("准备数据 %q: %v", q, err)
		}
	}
	svc := service.New(repository.New(conn))
	return &sortOrderHandlerEnv{h: New(svc, nil), conn: conn}
}

// callSortOrder 直接调用 handler（账本上下文由 middleware 负责注入，这里手工注入）。
func (e *sortOrderHandlerEnv) callSortOrder(body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPatch, "/api/accounts/sort-order", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.WithLedger(req.Context(), 1, domainRoleOwner))
	rec := httptest.NewRecorder()
	e.h.HandleUpdateAccountSortOrder(rec, req)
	return rec
}

// domainRoleOwner 避免 handler 测试再依赖 domain 常量名拼写；owner / editor 均可写。
const domainRoleOwner = "owner"

func (e *sortOrderHandlerEnv) sortOf(t *testing.T, uuid string) int64 {
	t.Helper()
	var n int64
	if err := e.conn.QueryRow(`SELECT sort_order FROM accounts WHERE uuid=?`, uuid).Scan(&n); err != nil {
		t.Fatalf("读取 %s sort_order: %v", uuid, err)
	}
	return n
}

func (e *sortOrderHandlerEnv) syncCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := e.conn.QueryRow(`SELECT count(*) FROM sync_log`).Scan(&n); err != nil {
		t.Fatalf("统计 sync_log: %v", err)
	}
	return n
}

func TestHandleUpdateAccountSortOrderSuccess(t *testing.T) {
	e := newSortOrderHandlerEnv(t)
	rec := e.callSortOrder(`{"orders":[{"uuid":"u-b","sort_order":0},{"uuid":"u-a","sort_order":1}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("解析响应: %v", err)
	}
	if body["ok"] != true || body["updated"] != float64(2) {
		t.Fatalf("响应应为 {ok:true,updated:2}，实际 %s", rec.Body.String())
	}
	if got := e.sortOf(t, "u-b"); got != 0 || e.sortOf(t, "u-a") != 1 {
		t.Fatalf("落库顺序不符：u-b=%d u-a=%d", got, e.sortOf(t, "u-a"))
	}
	if n := e.syncCount(t); n != 2 {
		t.Fatalf("应写 2 条 sync_log，实际 %d", n)
	}
}

func TestHandleUpdateAccountSortOrderInvalid(t *testing.T) {
	cases := []struct {
		name, body, reason string
	}{
		{"空列表", `{"orders":[]}`, "不能为空"},
		{"缺 orders", `{}`, "不能为空"},
		{"空 uuid", `{"orders":[{"uuid":"","sort_order":0}]}`, "uuid"},
		{"负序号", `{"orders":[{"uuid":"u-a","sort_order":-1}]}`, "负数"},
		{"重复 uuid", `{"orders":[{"uuid":"u-a","sort_order":0},{"uuid":"u-a","sort_order":1}]}`, "重复"},
		{"非本账本 uuid", `{"orders":[{"uuid":"u-a","sort_order":0},{"uuid":"u-other","sort_order":1}]}`, "不属于当前账本"},
		{"坏 JSON", `{"orders":[`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newSortOrderHandlerEnv(t)
			rec := e.callSortOrder(tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("应 400，实际 %d: %s", rec.Code, rec.Body.String())
			}
			if tc.reason != "" && !strings.Contains(rec.Body.String(), tc.reason) {
				t.Fatalf("错误文案应含 %q，实际 %s", tc.reason, rec.Body.String())
			}
			if got := e.sortOf(t, "u-a"); got != 0 || e.sortOf(t, "u-b") != 0 {
				t.Fatalf("校验失败不得改库：u-a=%d u-b=%d", got, e.sortOf(t, "u-b"))
			}
			if n := e.syncCount(t); n != 0 {
				t.Fatalf("校验失败不得写 sync_log，实际 %d", n)
			}
		})
	}
}
