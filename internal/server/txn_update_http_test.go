package server

// AC-5.3 / AC-5.6 HTTP 层回归：PATCH /api/transactions/{uuid}（0.6.0 S6 修改交易）。
//
// 服务端独立校验（不经 handler 直调 service 的矩阵在 service 层覆盖）；
// 这里验证 PATCH 路由形态、响应三 uuid、重试命中已冲正 → 409 txn_already_reversed。

import (
	"net/http"
	"testing"
)

func TestTxnUpdateHTTP(t *testing.T) {
	e := newQAServerEnv(t)

	// 建账户（S2 契约：必须显式 parent_uuid）。
	st, acc, raw := e.do(http.MethodPost, "/api/accounts", map[string]any{
		"name": "Assets:S6Cash", "type": "Assets", "open_date": "2026-01-01",
		"commodity": "CNY", "parent_uuid": "",
	}, "", e.token)
	if st != http.StatusCreated {
		t.Fatalf("建账户应 201，实际 %d: %s", st, raw)
	}
	cashID := int64(acc["id"].(float64))

	// 建第二账户（对手方）。
	st, acc2, raw := e.do(http.MethodPost, "/api/accounts", map[string]any{
		"name": "Expenses:S6Food", "type": "Expenses", "open_date": "2026-01-01",
		"commodity": "CNY", "parent_uuid": "",
	}, "", e.token)
	if st != http.StatusCreated {
		t.Fatalf("建对手方账户应 201，实际 %d: %s", st, raw)
	}
	foodID := int64(acc2["id"].(float64))

	// 记一笔（在线 create）。
	st, txn, raw := e.do(http.MethodPost, "/api/transactions", map[string]any{
		"date": "2026-02-01", "description": "早餐", "flag": "*",
		"postings": []map[string]any{
			{"account_id": cashID, "commodity": "CNY", "amount": "-12.50"},
			{"account_id": foodID, "commodity": "CNY", "amount": "12.50"},
		},
	}, "", e.token)
	if st != http.StatusCreated {
		t.Fatalf("create 应 201，实际 %d: %s", st, raw)
	}
	txnUUID, _ := txn["uuid"].(string)

	// PATCH 修改：响应 {original_uuid, reversal_uuid, new_uuid}，无 version。
	st, res, raw := e.do(http.MethodPatch, "/api/transactions/"+txnUUID, map[string]any{
		"date": "2026-02-02", "description": "早餐（改）",
		"postings": []map[string]any{
			{"account_id": cashID, "commodity": "CNY", "amount": "-20.00"},
			{"account_id": foodID, "commodity": "CNY", "amount": "20.00"},
		},
	}, "", e.token)
	if st != http.StatusOK {
		t.Fatalf("PATCH 应 200，实际 %d: %s", st, raw)
	}
	if res["original_uuid"] != txnUUID {
		t.Fatalf("original_uuid 应回显原 uuid: %v", res)
	}
	for _, k := range []string{"reversal_uuid", "new_uuid"} {
		if v, _ := res[k].(string); v == "" {
			t.Fatalf("响应应含非空 %s: %v", k, res)
		}
	}
	if _, exists := res["version"]; exists {
		t.Fatalf("响应不得含 version 字段（D-15 无版本链）: %v", res)
	}

	// 重试对同一原交易 PATCH → 409 txn_already_reversed（幂等兜底）。
	st, res2, raw := e.do(http.MethodPatch, "/api/transactions/"+txnUUID, map[string]any{
		"date": "2026-02-02", "description": "重试",
		"postings": []map[string]any{
			{"account_id": cashID, "commodity": "CNY", "amount": "-30.00"},
			{"account_id": foodID, "commodity": "CNY", "amount": "30.00"},
		},
	}, "", e.token)
	if st != http.StatusConflict {
		t.Fatalf("重试 PATCH 应 409，实际 %d: %s", st, raw)
	}
	if code, _ := res2["code"].(string); code != "txn_already_reversed" {
		t.Fatalf("code 应为 txn_already_reversed，实际 %v", res2)
	}

	// 不存在的 uuid → 404。
	st, _, raw = e.do(http.MethodPatch, "/api/transactions/no-such-uuid", map[string]any{
		"date": "2026-02-02", "description": "x",
		"postings": []map[string]any{
			{"account_id": cashID, "commodity": "CNY", "amount": "-1.00"},
			{"account_id": foodID, "commodity": "CNY", "amount": "1.00"},
		},
	}, "", e.token)
	if st != http.StatusNotFound {
		t.Fatalf("不存在 uuid 应 404，实际 %d: %s", st, raw)
	}
}
