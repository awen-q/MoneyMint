package server

// 0.6.0 S2 币种端点与 T07 键缺失区分的 HTTP 集成测试。
// 走真实装配（路由 + 中间件 + handler + service + SQLite），不 mock。

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"familyledger/internal/handler"
)

func decodeCommodityBody(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("解析响应 %q: %v", string(raw), err)
	}
	return m
}

// TestCommodityHTTPCRUD AC-4.1 / AC-4.3 / AC-4.6：
// 列表 / 新建 / 重名 409 / 软删 / 重复删 404 / 命中软删行恢复原 uuid / viewer 403。
func TestCommodityHTTPCRUD(t *testing.T) {
	e := newAuthEnv(t, handler.DefaultAuthOptions(), corsOptions{})
	_, _, token := e.register()
	auth := map[string]string{
		"Authorization": "Bearer " + token,
		"X-Ledger-Id":   "1",
	}

	resp, raw := e.do(http.DefaultClient, http.MethodGet, "/api/commodities", nil, auth)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/commodities 期望 200，实际 %d: %s", resp.StatusCode, raw)
	}
	if _, ok := decodeCommodityBody(t, raw)["commodities"]; !ok {
		t.Fatalf("列表缺少 commodities 字段: %s", raw)
	}

	resp, raw = e.do(http.DefaultClient, http.MethodPost, "/api/commodities",
		map[string]any{"symbol": "USD", "name": "美元"}, auth)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /api/commodities 期望 201，实际 %d: %s", resp.StatusCode, raw)
	}
	created := decodeCommodityBody(t, raw)
	uuid, _ := created["uuid"].(string)
	if uuid == "" || created["precision"] != float64(2) {
		t.Fatalf("响应缺少 uuid / precision 默认 2: %s", raw)
	}
	if _, exists := created["used"]; exists {
		t.Fatalf("POST 响应应为四字段，不应带 used: %s", raw)
	}

	resp, raw = e.do(http.DefaultClient, http.MethodPost, "/api/commodities",
		map[string]any{"symbol": "USD", "name": "美元"}, auth)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("重名期望 409，实际 %d: %s", resp.StatusCode, raw)
	}
	dup := decodeCommodityBody(t, raw)
	if dup["code"] != "commodity_exists" || dup["uuid"] != uuid {
		t.Fatalf("409 应回显已有 uuid，实际 %s", raw)
	}

	resp, raw = e.do(http.DefaultClient, http.MethodDelete, "/api/commodities/"+uuid, nil, auth)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("DELETE 期望 200，实际 %d: %s", resp.StatusCode, raw)
	}
	resp, raw = e.do(http.DefaultClient, http.MethodDelete, "/api/commodities/"+uuid, nil, auth)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("重复删应幂等 404，实际 %d: %s", resp.StatusCode, raw)
	}

	// 命中软删行：恢复原行、返回原 uuid。
	resp, raw = e.do(http.DefaultClient, http.MethodPost, "/api/commodities",
		map[string]any{"symbol": "USD", "name": "美元"}, auth)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("恢复软删币种期望 201，实际 %d: %s", resp.StatusCode, raw)
	}
	if got := decodeCommodityBody(t, raw)["uuid"]; got != uuid {
		t.Fatalf("恢复必须返回原 uuid %s，实际 %v", uuid, got)
	}

	// viewer：写 403、读仍 200（middleware 权威防线）。
	if _, err := e.conn.Exec(`UPDATE ledger_members SET role='viewer' WHERE ledger_id=1`); err != nil {
		t.Fatal(err)
	}
	resp, raw = e.do(http.DefaultClient, http.MethodPost, "/api/commodities",
		map[string]any{"symbol": "EUR"}, auth)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer 写币种应 403，实际 %d: %s", resp.StatusCode, raw)
	}
	resp, raw = e.do(http.DefaultClient, http.MethodGet, "/api/commodities", nil, auth)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("viewer 读币种应 200，实际 %d: %s", resp.StatusCode, raw)
	}
}

// TestCommodityInUseAndExport AC-4.2 / AC-4.4：
// 被引用删除的 409 分项明细、软删币种不导出。
func TestCommodityInUseAndExport(t *testing.T) {
	e := newAuthEnv(t, handler.DefaultAuthOptions(), corsOptions{})
	_, _, token := e.register()
	auth := map[string]string{
		"Authorization": "Bearer " + token,
		"X-Ledger-Id":   "1",
	}

	// 让 GBP 成为账本默认币种（PATCH 已交付）。
	resp, raw := e.do(http.DefaultClient, http.MethodPatch, "/api/ledgers/1",
		map[string]any{"name": "默认币种测试", "default_commodity": "GBP"}, auth)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("设置默认币种: %d %s", resp.StatusCode, raw)
	}
	resp, raw = e.do(http.DefaultClient, http.MethodPost, "/api/commodities",
		map[string]any{"symbol": "GBP", "name": "英镑"}, auth)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("创建 GBP: %d %s", resp.StatusCode, raw)
	}
	gbp := decodeCommodityBody(t, raw)
	gbpUUID, _ := gbp["uuid"].(string)

	resp, raw = e.do(http.DefaultClient, http.MethodDelete, "/api/commodities/"+gbpUUID, nil, auth)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("默认币种删除期望 409，实际 %d: %s", resp.StatusCode, raw)
	}
	body := decodeCommodityBody(t, raw)
	if body["code"] != "commodity_in_use" || body["is_default"] != true {
		t.Fatalf("409 明细错误: %s", raw)
	}
	if !strings.Contains(string(raw), "请先在账本设置中改默认币种") {
		t.Fatalf("应提示先改默认币种: %s", raw)
	}

	// 改回默认币种后删除成功；导出不得再出现 GBP。
	resp, raw = e.do(http.DefaultClient, http.MethodPatch, "/api/ledgers/1",
		map[string]any{"name": "默认币种测试", "default_commodity": "CNY"}, auth)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("改回默认币种: %d %s", resp.StatusCode, raw)
	}
	resp, raw = e.do(http.DefaultClient, http.MethodDelete, "/api/commodities/"+gbpUUID, nil, auth)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("零引用删除: %d %s", resp.StatusCode, raw)
	}
	resp, raw = e.do(http.DefaultClient, http.MethodGet, "/api/export", nil, auth)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("导出: %d %s", resp.StatusCode, raw)
	}
	if strings.Contains(string(raw), "GBP") {
		t.Fatalf("软删币种不得导出: %s", raw)
	}
}

// TestAccountParentUUIDKeyRequired T07 键缺失区分：
// 缺 parent_uuid → 400 中文原因；显式空串 → 根账户创建成功。
func TestAccountParentUUIDKeyRequired(t *testing.T) {
	e := newAuthEnv(t, handler.DefaultAuthOptions(), corsOptions{})
	_, _, token := e.register()
	auth := map[string]string{
		"Authorization": "Bearer " + token,
		"X-Ledger-Id":   "1",
	}

	resp, raw := e.do(http.DefaultClient, http.MethodPost, "/api/accounts",
		map[string]any{"name": "Assets:KeyMissing", "type": "Assets", "commodity": "CNY"}, auth)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("缺 parent_uuid 应 400，实际 %d: %s", resp.StatusCode, raw)
	}
	if !strings.Contains(string(raw), "parent_uuid") {
		t.Fatalf("400 应给可读原因: %s", raw)
	}

	resp, raw = e.do(http.DefaultClient, http.MethodPost, "/api/accounts",
		map[string]any{
			"name": "Assets:KeyExplicitRoot", "type": "Assets", "commodity": "CNY",
			"parent_uuid": "",
		}, auth)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("显式 parent_uuid=\"\" 应 201，实际 %d: %s", resp.StatusCode, raw)
	}
}
