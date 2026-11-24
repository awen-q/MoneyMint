package server

// 展示字段修改端点 HTTP 层回归（批 II）：
//   - PATCH /api/accounts/{uuid} 命中新 handler：200 回显、非法 400、viewer 403；
//   - 路由回归：PATCH /api/accounts/sort-order 字面量恒优先（不被 {uuid} 吞），
//     反向 PATCH /api/accounts/{uuid} 也进展示字段端点而非 405；
//   - 方法限制：GET / PUT 本端点 → 405（DELETE 归关户）。

import (
	"net/http"
	"strings"
	"testing"

	"familyledger/internal/domain"
)

func patchVisual(e *qaServerEnv, uuid string, body map[string]any, token string) (int, map[string]any, string) {
	return e.do(http.MethodPatch, "/api/accounts/"+uuid, body, "1", token)
}

// newVisualAccount 建一个可改展示字段的账户，返回 uuid。
func newVisualAccount(t *testing.T, e *qaServerEnv, name string) string {
	t.Helper()
	st, body, raw := e.do(http.MethodPost, "/api/accounts", map[string]any{
		"name": name, "type": "Assets", "open_date": "", "parent_uuid": "",
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

func TestAccountVisualHTTPContract(t *testing.T) {
	e := newQAServerEnv(t)
	uuid := newVisualAccount(t, e, "Assets:VisualBank")

	st, body, raw := patchVisual(e, uuid, map[string]any{
		"display_name": "招商储蓄", "icon": "🏦", "color": "#1F7A4D",
	}, e.token)
	if st != http.StatusOK {
		t.Fatalf("PATCH 应 200，实际 %d: %s", st, raw)
	}
	account, _ := body["account"].(map[string]any)
	if body["ok"] != true || account == nil {
		t.Fatalf("响应应为 {ok:true, account:{...}}，实际 %s", raw)
	}
	if account["uuid"] != uuid || account["display_name"] != "招商储蓄" ||
		account["icon"] != "🏦" || account["color"] != "#1F7A4D" {
		t.Fatalf("回显不符：%s", raw)
	}

	// 非法 icon：400 + 稳定码。
	st, body, raw = patchVisual(e, uuid, map[string]any{"icon": strings.Repeat("🍖", 9)}, e.token)
	if st != http.StatusBadRequest {
		t.Fatalf("9 码点 icon 应 400，实际 %d: %s", st, raw)
	}
	if body["code"] != domain.CodeAccountVisualInvalid {
		t.Fatalf("应带稳定码 account_visual_invalid，实际 %s", raw)
	}

	// 白名单外键：400 且列明字段。
	st, _, raw = patchVisual(e, uuid, map[string]any{"name": "Expenses:Hacked", "icon": "🏦"}, e.token)
	if st != http.StatusBadRequest {
		t.Fatalf("白名单外键应 400，实际 %d: %s", st, raw)
	}
	if !strings.Contains(raw, "name") || !strings.Contains(raw, "不支持修改字段") {
		t.Fatalf("400 文案应列明拒绝字段 name，实际 %s", raw)
	}

	// 全 nil：400。
	st, _, raw = patchVisual(e, uuid, map[string]any{}, e.token)
	if st != http.StatusBadRequest {
		t.Fatalf("空体应 400，实际 %d: %s", st, raw)
	}

	// 方法限制：GET/PUT → 405（本端点只收 PATCH / DELETE）。
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		st, _, raw = e.do(method, "/api/accounts/"+uuid, nil, "1", e.token)
		if st != http.StatusMethodNotAllowed {
			t.Errorf("%s /api/accounts/{uuid} 应 405，实际 %d: %s", method, st, raw)
		}
	}
}

// TestAccountVisualRouteRegression 路由回归（批 II 注册 PATCH 后的双向不吞）：
// sort-order 字面量恒优先；{uuid} 的 PATCH 进展示字段端点；DELETE 关户不受影响。
func TestAccountVisualRouteRegression(t *testing.T) {
	e := newQAServerEnv(t)
	a := newSortAccount(t, e, "Expenses:RouteA")
	b := newSortAccount(t, e, "Expenses:RouteB")

	// PATCH sort-order 仍命中字面量端点（updated=N 语义，而非展示字段的 account 回显）。
	st, body, raw := patchSortOrders(e, []map[string]any{
		{"uuid": b, "sort_order": 0},
		{"uuid": a, "sort_order": 1},
	}, e.token)
	if st != http.StatusOK {
		t.Fatalf("sort-order PATCH 应 200，实际 %d: %s", st, raw)
	}
	if body["ok"] != true || body["updated"] != float64(2) {
		t.Fatalf("sort-order 响应应保留 {ok,updated} 语义（未被 {uuid} 吞），实际 %s", raw)
	}
	if _, hasAccount := body["account"]; hasAccount {
		t.Fatalf("sort-order 响应不得出现展示字段端点的 account 键，实际 %s", raw)
	}

	// PATCH /api/accounts/{uuid} 进展示字段端点（200 回显，而非 405 / updated 语义）。
	st, body, raw = patchVisual(e, a, map[string]any{"icon": "🏦"}, e.token)
	if st != http.StatusOK {
		t.Fatalf("{uuid} PATCH 应 200，实际 %d: %s", st, raw)
	}
	if _, hasUpdated := body["updated"]; hasUpdated {
		t.Fatalf("{uuid} PATCH 响应不得出现 sort-order 端点的 updated 键，实际 %s", raw)
	}

	// DELETE 关户语义不受 PATCH 注册影响。
	st, _, raw = e.do(http.MethodDelete, "/api/accounts/"+b, nil, "1", e.token)
	if st != http.StatusOK {
		t.Fatalf("DELETE /api/accounts/{uuid} 应仍 200，实际 %d: %s", st, raw)
	}
}

// TestAccountVisualHTTPViewerReadOnly viewer 的 PATCH 由 middleware 拦成 403。
func TestAccountVisualHTTPViewerReadOnly(t *testing.T) {
	e := newQAServerEnv(t)
	uuid := newVisualAccount(t, e, "Assets:VisualViewer")

	viewer, err := e.svc.Register("visual-viewer", "secret123", "只读")
	if err != nil {
		t.Fatalf("注册 viewer: %v", err)
	}
	if _, _, err := e.svc.AddMember(1, e.userID, "visual-viewer", domain.RoleViewer); err != nil {
		t.Fatalf("加入 viewer: %v", err)
	}

	st, body, raw := patchVisual(e, uuid, map[string]any{"icon": "🏦"}, viewer.Token)
	if st != http.StatusForbidden {
		t.Fatalf("viewer PATCH 应 403，实际 %d: %s", st, raw)
	}
	if body["error"] == nil {
		t.Fatalf("403 应带 error 文案: %s", raw)
	}
	var logged int
	if err := e.conn.QueryRow(
		`SELECT count(*) FROM sync_log WHERE entity_type='account' AND op='update'`,
	).Scan(&logged); err != nil {
		t.Fatalf("统计 sync_log: %v", err)
	}
	if logged != 0 {
		t.Fatalf("viewer 被拒不得写日志，实际 %d", logged)
	}
}
