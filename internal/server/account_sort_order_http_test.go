package server

// 分类排序端点的 HTTP 层回归（P0）：
//   - PATCH /api/accounts/sort-order 命中字面量路由，不被 {uuid} 吞掉；
//   - 方法限制（GET/PUT/DELETE 本端点 → 405），既有 /api/accounts/{uuid}
//     的 DELETE 仍 200、PATCH 自批 II 起归展示字段端点（空体 400，非 405）；
//   - 400 校验经统一错误结构返回；viewer 由 middleware 拦截为 403。
//
// 与 internal/handler/account_test.go 的分工：那里测 handler 契约与事务回滚，
// 这里只测「路由 + 中间件 + 对外响应」。

import (
	"net/http"
	"testing"

	"familyledger/internal/domain"
)

// newSortAccount 建一个空余额 Expenses 账户，返回 uuid。
func newSortAccount(t *testing.T, e *qaServerEnv, name string) string {
	t.Helper()
	st, body, raw := e.do(http.MethodPost, "/api/accounts", map[string]any{
		"name": name, "type": "Expenses", "open_date": "", "parent_uuid": "",
	}, "1", e.token)
	if st != http.StatusCreated {
		t.Fatalf("建账户 %s 应 201，实际 %d: %s", name, st, raw)
	}
	uuid, ok := body["uuid"].(string)
	if !ok || uuid == "" {
		t.Fatalf("响应缺 uuid: %s", raw)
	}
	return uuid
}

func patchSortOrders(e *qaServerEnv, orders []map[string]any, token string) (int, map[string]any, string) {
	return e.do(http.MethodPatch, "/api/accounts/sort-order", map[string]any{"orders": orders}, "1", token)
}

// TestAccountSortOrderHTTPContract 端点契约 + 路由优先级回归。
func TestAccountSortOrderHTTPContract(t *testing.T) {
	e := newQAServerEnv(t)
	a := newSortAccount(t, e, "Expenses:SortA")
	b := newSortAccount(t, e, "Expenses:SortB")
	c := newSortAccount(t, e, "Expenses:SortC")

	st, body, raw := patchSortOrders(e, []map[string]any{
		{"uuid": c, "sort_order": 0},
		{"uuid": b, "sort_order": 1},
		{"uuid": a, "sort_order": 2},
	}, e.token)
	if st != http.StatusOK {
		t.Fatalf("批量排序应 200，实际 %d: %s", st, raw)
	}
	if body["ok"] != true || body["updated"] != float64(3) {
		t.Fatalf("响应应为 {ok:true,updated:3}，实际 %s", raw)
	}

	// GET /api/accounts 已按 sort_order 升序返回：三个账户的相对位置必须是 C/B/A。
	st, listed, raw := e.do(http.MethodGet, "/api/accounts", nil, "1", e.token)
	if st != http.StatusOK {
		t.Fatalf("列账户应 200，实际 %d: %s", st, raw)
	}
	items, _ := listed["accounts"].([]any)
	position := map[string]int{}
	for i, item := range items {
		row, _ := item.(map[string]any)
		if uuid, ok := row["uuid"].(string); ok {
			position[uuid] = i
		}
	}
	if !(position[c] < position[b] && position[b] < position[a]) {
		t.Fatalf("列表顺序应为 %s<%s<%s，实际位置 %v", c, b, a, position)
	}

	// 校验失败：空 orders → 400，不写日志。
	st, _, raw = patchSortOrders(e, []map[string]any{}, e.token)
	if st != http.StatusBadRequest {
		t.Fatalf("空 orders 应 400，实际 %d: %s", st, raw)
	}
	var logged int
	if err := e.conn.QueryRow(`SELECT count(*) FROM sync_log WHERE entity_type='account' AND op='update'`).Scan(&logged); err != nil {
		t.Fatalf("统计 sync_log: %v", err)
	}
	if logged != 3 {
		t.Fatalf("只应有 3 条排序日志（校验失败不得写），实际 %d", logged)
	}

	// 方法限制：本端点只收 PATCH。
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		st, _, raw := e.do(method, "/api/accounts/sort-order", nil, "1", e.token)
		if st != http.StatusMethodNotAllowed {
			t.Errorf("%s /api/accounts/sort-order 应 405，实际 %d: %s", method, st, raw)
		}
	}

	// 字面量路由不得影响 /api/accounts/{uuid}：DELETE 仍成功；
	// 批 II 起 PATCH /api/accounts/{uuid} 已注册为展示字段修改——空体 {} 全 nil
	// 落 400（不再是 405），证明请求进的是新 handler 而非被 sort-order 吞掉；
	// sort-order 的 PATCH 在上方已 200（字面量恒优先，没有被 {uuid} 吞）。
	st, _, raw = e.do(http.MethodPatch, "/api/accounts/"+a, map[string]any{}, "1", e.token)
	if st != http.StatusBadRequest {
		t.Fatalf("PATCH /api/accounts/{uuid} 空体应 400（新展示字段端点全 nil 校验），实际 %d: %s", st, raw)
	}
	st, _, raw = e.do(http.MethodDelete, "/api/accounts/"+a, nil, "1", e.token)
	if st != http.StatusOK {
		t.Fatalf("DELETE /api/accounts/{uuid} 应仍 200，实际 %d: %s", st, raw)
	}
}

// TestAccountSortOrderHTTPViewerReadOnly viewer 的 PATCH 由 middleware 拦成 403。
func TestAccountSortOrderHTTPViewerReadOnly(t *testing.T) {
	e := newQAServerEnv(t)
	a := newSortAccount(t, e, "Expenses:SortViewerA")
	b := newSortAccount(t, e, "Expenses:SortViewerB")

	viewer, err := e.svc.Register("sort-viewer", "secret123", "只读")
	if err != nil {
		t.Fatalf("注册 viewer: %v", err)
	}
	if _, _, err := e.svc.AddMember(1, e.userID, "sort-viewer", domain.RoleViewer); err != nil {
		t.Fatalf("加入 viewer: %v", err)
	}

	st, body, raw := patchSortOrders(e, []map[string]any{
		{"uuid": b, "sort_order": 0},
		{"uuid": a, "sort_order": 1},
	}, viewer.Token)
	if st != http.StatusForbidden {
		t.Fatalf("viewer 排序应 403，实际 %d: %s", st, raw)
	}
	if body["error"] == nil {
		t.Fatalf("403 应带 error 文案: %s", raw)
	}
	var logged int
	if err := e.conn.QueryRow(`SELECT count(*) FROM sync_log WHERE entity_type='account' AND op='update'`).Scan(&logged); err != nil {
		t.Fatalf("统计 sync_log: %v", err)
	}
	if logged != 0 {
		t.Fatalf("viewer 被拒不得写日志，实际 %d", logged)
	}

	// 同一批 owner 可正常提交（证明 403 来自角色而非路由/校验）。
	st, _, raw = patchSortOrders(e, []map[string]any{
		{"uuid": b, "sort_order": 0},
		{"uuid": a, "sort_order": 1},
	}, e.token)
	if st != http.StatusOK {
		t.Fatalf("owner 排序应 200，实际 %d: %s", st, raw)
	}
}
