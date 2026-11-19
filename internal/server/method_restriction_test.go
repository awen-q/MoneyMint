package server

// 5 条端点的方法限制：`/api/health`、`/api/export`、`/api/export/archive`、
// `/api/sync/pull`、`/api/sync/push`。
//
// 背景：这 5 条原先直接 `mux.HandleFunc(path, handler)`，没套 `methodSwitch`，
// handler 内也不查 `r.Method`（`auth.go:138` / `export.go` / `sync.go` 均无）。
// 于是：
//
//	curl -X DELETE /api/export      → 真的执行导出并返回 beancount 正文（200）
//	curl -X POST   /api/health      → 返回 {"status":"ok"}（200）
//
// 文档（AGENTS.md §7）与前端（client.ts）都只按 GET / POST 声明与调用，
// 所以线上不会因此出错；但「文档说 GET、实现收任意方法」与「参数存在即生效」
// 是同一类谎言——不报错，却在被误用时给出真实结果。
//
// 本用例把「方法限制」钉在传输层：别的测试只能证明「正确的方法能通」，
// 只有这里能证明「错误的方法会被拒绝」。

import (
	"net/http"
	"testing"
)

// TestNonBusinessEndpointsRejectWrongMethod 断言 5 条端点的方法限制。
func TestNonBusinessEndpointsRejectWrongMethod(t *testing.T) {
	e := newQAServerEnv(t)

	cases := []struct {
		path    string
		allowed string
		body    any
		wrong   []string
	}{
		{"/api/health", http.MethodGet, nil, []string{http.MethodPost, http.MethodDelete, http.MethodPatch}},
		{"/api/export", http.MethodGet, nil, []string{http.MethodPost, http.MethodDelete}},
		{"/api/export/archive", http.MethodGet, nil, []string{http.MethodPost, http.MethodDelete}},
		{"/api/sync/pull?since=0&client_id=method-guard", http.MethodGet, nil, []string{http.MethodPost, http.MethodDelete}},
		{"/api/sync/push", http.MethodPost, map[string]any{"client_id": "method-guard", "changes": []any{}},
			[]string{http.MethodGet, http.MethodDelete}},
	}

	for _, c := range cases {
		// 正确方法必须先能通：否则「405」可能只是因为端点坏了。
		st, _, raw := e.do(c.allowed, c.path, c.body, "", e.token)
		if st != http.StatusOK {
			t.Fatalf("%s %s 应 200（正确方法必须可用），实际 %d: %s", c.allowed, c.path, st, raw)
		}

		for _, method := range c.wrong {
			st, _, raw := e.do(method, c.path, c.body, "", e.token)
			if st != http.StatusMethodNotAllowed {
				t.Fatalf("%s %s 应 405（方法限制失效：这个请求被真的处理了），实际 %d: %s",
					method, c.path, st, raw)
			}
		}
	}
}
