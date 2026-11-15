package server

// 0.6.0 S4 余额校准的 HTTP 集成测试：端点注册、预检/设置、404 稳定码、viewer 403。
// 走真实装配（路由 + 中间件 + handler + service + SQLite），不 mock。

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"familyledger/internal/handler"
)

func TestBalanceHTTPEndpoints(t *testing.T) {
	e := newAuthEnv(t, handler.DefaultAuthOptions(), corsOptions{})
	_, _, token := e.register()
	auth := map[string]string{
		"Authorization": "Bearer " + token,
		"X-Ledger-Id":   "1",
	}

	// 默认账本的 opening_date / 账户 open_date 是今日，会让 D-1 落在下界之前；
	// 前移 30 天以便「D=今日、D-1=昨日」合法。
	early := time.Now().AddDate(0, 0, -30).Format("2006-01-02")
	if _, err := e.conn.Exec(`UPDATE ledgers SET opening_date=? WHERE id=1`, early); err != nil {
		t.Fatal(err)
	}
	if _, err := e.conn.Exec(`UPDATE accounts SET open_date=? WHERE ledger_id=1`, early); err != nil {
		t.Fatal(err)
	}

	resp, raw := e.do(http.DefaultClient, http.MethodGet, "/api/accounts", nil, auth)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("列出账户: %d %s", resp.StatusCode, raw)
	}
	var list struct {
		Accounts []struct {
			UUID string `json:"uuid"`
			Type string `json:"type"`
		} `json:"accounts"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		t.Fatal(err)
	}
	cashUUID := ""
	for _, a := range list.Accounts {
		if a.Type == "Assets" {
			cashUUID = a.UUID
			break
		}
	}
	if cashUUID == "" {
		t.Fatal("默认账本应有资产账户")
	}

	d := time.Now().Format("2006-01-02")
	path := "/api/accounts/" + cashUUID + "/balance"

	// GET 预检（viewer 也可读）。
	resp, raw = e.do(http.DefaultClient, http.MethodGet, path+"?as_of_date="+d, nil, auth)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET 预检期望 200，实际 %d: %s", resp.StatusCode, raw)
	}
	var preview struct {
		AccountUUID string `json:"account_uuid"`
		AsOfDate    string `json:"as_of_date"`
		Cumulative  []struct {
			Commodity string `json:"commodity"`
			Amount    string `json:"amount"`
		} `json:"cumulative"`
		Calibration struct {
			Exists  bool `json:"exists"`
			History []struct {
				Version string `json:"version"`
			} `json:"history"`
		} `json:"calibration"`
	}
	if err := json.Unmarshal(raw, &preview); err != nil {
		t.Fatal(err)
	}
	if preview.AccountUUID != cashUUID || preview.AsOfDate != d || preview.Calibration.Exists {
		t.Fatalf("预检响应错误: %s", raw)
	}

	// POST 设置（首次创建）。
	resp, raw = e.do(http.DefaultClient, http.MethodPost, path, map[string]any{
		"as_of_date": d,
		"targets": []any{
			map[string]any{"commodity": "CNY", "target_balance": "12350.00"},
		},
	}, auth)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST 设置期望 200，实际 %d: %s", resp.StatusCode, raw)
	}
	var result struct {
		Status   string `json:"status"`
		Date     string `json:"date"`
		Version  int64  `json:"version"`
		Reversal string `json:"reversal_uuid"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if result.Status != "created" || result.Version != 1 || result.Reversal != "" {
		t.Fatalf("首次设置结果错误: %s", raw)
	}
	if result.Date != time.Now().AddDate(0, 0, -1).Format("2006-01-02") {
		t.Fatalf("落账日应为 D-1，实际 %s", result.Date)
	}

	// AC-3.6：版本历史可见操作人（created_by 由 handler 从会话注入）。
	resp, raw = e.do(http.DefaultClient, http.MethodGet, path+"?as_of_date="+d, nil, auth)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST 后预检: %d %s", resp.StatusCode, raw)
	}
	var after struct {
		Calibration struct {
			Exists  bool `json:"exists"`
			History []struct {
				Version       string `json:"version"`
				CreatedByName string `json:"created_by_name"`
			} `json:"history"`
		} `json:"calibration"`
	}
	if err := json.Unmarshal(raw, &after); err != nil {
		t.Fatal(err)
	}
	if !after.Calibration.Exists || len(after.Calibration.History) != 1 {
		t.Fatalf("校准历史应含 v1: %s", raw)
	}
	if after.Calibration.History[0].CreatedByName == "" {
		t.Fatalf("版本历史应展示操作人（AC-3.6）: %s", raw)
	}

	// 404 account_not_found。
	resp, raw = e.do(http.DefaultClient, http.MethodGet,
		"/api/accounts/no-such-uuid/balance?as_of_date="+d, nil, auth)
	if resp.StatusCode != http.StatusNotFound || !strings.Contains(string(raw), "account_not_found") {
		t.Fatalf("不存在账户应 404 account_not_found，实际 %d: %s", resp.StatusCode, raw)
	}

	// viewer：POST 403、GET 仍 200（middleware 权威防线）。
	if _, err := e.conn.Exec(`UPDATE ledger_members SET role='viewer' WHERE ledger_id=1`); err != nil {
		t.Fatal(err)
	}
	resp, raw = e.do(http.DefaultClient, http.MethodPost, path, map[string]any{
		"as_of_date": d,
		"targets": []any{
			map[string]any{"commodity": "CNY", "target_balance": "999.00"},
		},
	}, auth)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer 写校准应 403，实际 %d: %s", resp.StatusCode, raw)
	}
	resp, raw = e.do(http.DefaultClient, http.MethodGet, path+"?as_of_date="+d, nil, auth)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("viewer 读预检应 200，实际 %d: %s", resp.StatusCode, raw)
	}
}
