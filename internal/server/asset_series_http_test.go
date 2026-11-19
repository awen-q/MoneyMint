package server

// T61 传输层回归：GET /api/assets/series 的路由注册 + 响应形状。
//
// 服务层口径（月末边界 / 符号 / 关户 / 软删 / 空账本）已在
// internal/service/asset_series_test.go 覆盖；这里只钉两件只能在 HTTP 层验证的事：
//   - 路由确实注册在 /api/assets/series（写错路径时服务层测试全绿而端点 404）；
//   - 金额是 JSON **字符串**（定点两位），不是 number —— number 会被前端浮点化。

import (
	"net/http"
	"testing"
)

func TestAssetSeriesHTTP(t *testing.T) {
	e := newQAServerEnv(t)

	// 1) 正常请求（空账本）：12 个点、金额是字符串 "0.00"。
	st, body, raw := e.do(http.MethodGet, "/api/assets/series?year=2026", nil, "", e.token)
	if st != http.StatusOK {
		t.Fatalf("GET /api/assets/series 应 200（路由是否已注册？），实际 %d: %s", st, raw)
	}
	if body["commodity"] != "CNY" {
		t.Fatalf("commodity 缺省应取账本 default_commodity（CNY），实际 %v", body["commodity"])
	}
	points, ok := body["points"].([]any)
	if !ok {
		t.Fatalf("points 不是数组: %s", raw)
	}
	if len(points) != 12 {
		t.Fatalf("points 必须恒 12 个，实际 %d 个", len(points))
	}
	first, ok := points[0].(map[string]any)
	if !ok {
		t.Fatalf("points[0] 不是对象: %#v", points[0])
	}
	if first["month"] != "2026-01" {
		t.Fatalf("首个点月份应为 2026-01，实际 %v", first["month"])
	}
	for _, key := range []string{"assets", "liabilities", "net"} {
		value, isString := first[key].(string)
		if !isString {
			t.Fatalf("%s 必须序列化为字符串（不是 JSON number），实际 %#v", key, first[key])
		}
		if value != "0.00" {
			t.Fatalf("空账本 %s 应为 \"0.00\"，实际 %q", key, value)
		}
	}

	// 2) 显式指定币种：原样回显，金额仍全 0（该币种无分录）。
	st, body, raw = e.do(http.MethodGet, "/api/assets/series?year=2026&commodity=USD", nil, "", e.token)
	if st != http.StatusOK {
		t.Fatalf("commodity=USD 应 200，实际 %d: %s", st, raw)
	}
	if body["commodity"] != "USD" {
		t.Fatalf("commodity 应回显 USD，实际 %v", body["commodity"])
	}

	// 3) 参数非法 → 400（year 必填、四位）。
	for _, query := range []string{"", "?year=", "?year=26", "?year=abcd", "?year=2026-01"} {
		st, _, raw := e.do(http.MethodGet, "/api/assets/series"+query, nil, "", e.token)
		if st != http.StatusBadRequest {
			t.Fatalf("%q 应 400，实际 %d: %s", query, st, raw)
		}
	}
}
