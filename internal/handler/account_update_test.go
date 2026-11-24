package handler

// 展示字段修改端点 handler 契约回归（批 II）：
//   - 200 {ok:true, account:{uuid, display_name, icon, color}} 且三列真落库；
//   - 白名单外键出现 → 400 且文案列明拒绝字段（防夹带改 name/sort_order）；
//   - 全 nil → 400；键缺失 = 不改现值（display_name 不被静默清空）；
//   - 非本账本 uuid → 404 account_not_found；
//   - 值类型非字符串 → 400。
// viewer 只读由 server 层 middleware 覆盖（account_visual_http_test.go）。

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"familyledger/internal/auth"
)

// callVisualOn 经一个最小 ServeMux 调用 handler：r.PathValue 依赖 mux 的模式
// 匹配注入，直调 handler 拿不到 uuid。方法限定在 handler 之外（middleware /
// router 职责），这里只挂 PATCH。
func (e *sortOrderHandlerEnv) callVisualOn(uuid, body string) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	mux.HandleFunc("PATCH /api/accounts/{uuid}", e.h.HandleUpdateAccountVisual)
	req := httptest.NewRequest(http.MethodPatch, "/api/accounts/"+uuid, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(auth.WithLedger(req.Context(), 1, domainRoleOwner))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// callVisual 默认对 u-a 调用（多数用例不需要跨 uuid）。
func (e *sortOrderHandlerEnv) callVisual(body string) *httptest.ResponseRecorder {
	return e.callVisualOn("u-a", body)
}

func (e *sortOrderHandlerEnv) visualOf(t *testing.T) (string, string, string, string) {
	t.Helper()
	var name string
	var displayName, icon, color sql.NullString
	if err := e.conn.QueryRow(
		`SELECT name, display_name, icon, color FROM accounts WHERE uuid='u-a'`,
	).Scan(&name, &displayName, &icon, &color); err != nil {
		t.Fatalf("读回账户: %v", err)
	}
	return name, displayName.String, icon.String, color.String
}

func TestHandleUpdateAccountVisualSuccess(t *testing.T) {
	e := newSortOrderHandlerEnv(t)
	rec := e.callVisual(`{"display_name":"餐饮分类","icon":"🍖","color":"#1F7A4D"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Ok      bool `json:"ok"`
		Account struct {
			UUID        string `json:"uuid"`
			DisplayName string `json:"display_name"`
			Icon        string `json:"icon"`
			Color       string `json:"color"`
		} `json:"account"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("解析响应: %v", err)
	}
	if !body.Ok || body.Account.UUID != "u-a" {
		t.Fatalf("响应应为 {ok:true, account:{uuid:u-a,...}}，实际 %s", rec.Body.String())
	}
	if body.Account.DisplayName != "餐饮分类" || body.Account.Icon != "🍖" || body.Account.Color != "#1F7A4D" {
		t.Fatalf("最小回显不符：%+v", body.Account)
	}
	name, displayName, icon, color := e.visualOf(t)
	if name != "Expenses:A" || displayName != "餐饮分类" || icon != "🍖" || color != "#1F7A4D" {
		t.Fatalf("落库不符：name=%s disp=%s icon=%s color=%s", name, displayName, icon, color)
	}
	var logged int
	if err := e.conn.QueryRow(
		`SELECT count(*) FROM sync_log WHERE ledger_id=1 AND entity_type='account' AND op='update'`,
	).Scan(&logged); err != nil {
		t.Fatalf("统计 sync_log: %v", err)
	}
	if logged != 1 {
		t.Fatalf("应写恰 1 条 op=update 日志，实际 %d", logged)
	}
}

func TestHandleUpdateAccountVisualInvalid(t *testing.T) {
	cases := []struct {
		name, body, reason string
	}{
		{"全 nil（空对象）", `{}`, "至少提供一个字段"},
		{"白名单外键 name", `{"name":"Expenses:Hacked"}`, "name"},
		{"白名单外键 sort_order", `{"sort_order":9}`, "sort_order"},
		{"白名单外键混合", `{"icon":"🍖","parent_uuid":"x"}`, "parent_uuid"},
		{"icon 超长", `{"icon":"123456789"}`, "account_visual_invalid"},
		{"color 非法", `{"color":"blue"}`, "account_visual_invalid"},
		{"值非字符串", `{"icon":123}`, "字符串"},
		{"坏 JSON", `{"icon":`, "JSON"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newSortOrderHandlerEnv(t)
			rec := e.callVisual(tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("应 400，实际 %d: %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.reason) {
				t.Fatalf("错误文案应含 %q，实际 %s", tc.reason, rec.Body.String())
			}
			// 拒绝字段必须出现在文案里（列明拒绝，不静默忽略）。
			if tc.name == "白名单外键 name" || tc.name == "白名单外键 sort_order" || tc.name == "白名单外键混合" {
				if !strings.Contains(rec.Body.String(), "不支持修改字段") {
					t.Fatalf("白名单外键应列明拒绝字段，实际 %s", rec.Body.String())
				}
			}
			_, displayName, icon, color := e.visualOf(t)
			if displayName != "" || icon != "" || color != "" {
				t.Fatalf("校验失败不得改库：disp=%s icon=%s color=%s", displayName, icon, color)
			}
		})
	}
}

func TestHandleUpdateAccountVisualMissingKeyPreserves(t *testing.T) {
	e := newSortOrderHandlerEnv(t)
	// 预置 icon；只改 display_name —— 键缺失的 icon 必须保持现值（三列全量 UPDATE 的回填）。
	if rec := e.callVisual(`{"icon":"🏦","color":"#112233"}`); rec.Code != http.StatusOK {
		t.Fatalf("预置: %d %s", rec.Code, rec.Body.String())
	}
	rec := e.callVisual(`{"display_name":"银行A"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
	_, displayName, icon, color := e.visualOf(t)
	if displayName != "银行A" || icon != "🏦" || color != "#112233" {
		t.Fatalf("键缺失字段应回填现值：disp=%s icon=%s color=%s", displayName, icon, color)
	}
}

func TestHandleUpdateAccountVisualForeignUUID404(t *testing.T) {
	e := newSortOrderHandlerEnv(t)
	rec := e.callVisualOn("u-other", `{"icon":"🏦"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("跨账本 uuid 应 404，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "account_not_found") {
		t.Fatalf("404 应带稳定码 account_not_found，实际 %s", rec.Body.String())
	}
	var logged int
	if err := e.conn.QueryRow(`SELECT count(*) FROM sync_log`).Scan(&logged); err != nil {
		t.Fatalf("统计 sync_log: %v", err)
	}
	if logged != 0 {
		t.Fatalf("404 路径不得写 sync_log，实际 %d", logged)
	}
}
