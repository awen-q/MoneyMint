package server

// `GET /api/accounts?include_closed=1` 的传输层兜底用例。
//
// 背景：资产页要「关户仍列出 + 显示历史余额 + 打已关闭标记」，而前端
// `accountApi.list()` 长期零参调用（从不带 `include_closed`），导致后端已经
// 返回不了关户账户、前端 `closedCount` 恒 0。前端修这个参数之前，先由本用例
// **证明后端这条路真的通**——否则前端改完不生效，第一反应会怀疑自己。
//
// 三条断言（缺一条这条链路就还是断的）：
//  1. 默认列表**不含**已关户账户；
//  2. `?include_closed=1` **含**已关户账户，**且带 `balances`**
//     （关键：资产页要显示关户账户的历史余额，只给账户不给余额，前端照样白搭）；
//  3. `close_date` 在两种情况下都正确：默认列表里不出现（omitempty），
//     include_closed 列表里非空。
//
// 注：service 层已有「默认不含 / include 才含 / close_date 正确」的等价断言
// （internal/service/service_test.go 里关户用例），本用例补的是**传输层**：
// query 参数 → handler → service → JSON 这一整条链路，以及 service 层没断言的
// `balances` 是否随关户账户一起下发。

import (
	"net/http"
	"testing"
)

// accountsByUUID 把 accounts 响应数组按 uuid 索引，方便断言存在性。
func accountsByUUID(t *testing.T, body map[string]any) map[string]map[string]any {
	t.Helper()
	raw, ok := body["accounts"].([]any)
	if !ok {
		t.Fatalf("accounts 不是数组: %#v", body["accounts"])
	}
	out := make(map[string]map[string]any, len(raw))
	for i, item := range raw {
		acc, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("accounts[%d] 不是对象: %#v", i, item)
		}
		uuid, _ := acc["uuid"].(string)
		if uuid == "" {
			t.Fatalf("accounts[%d] 缺 uuid: %#v", i, acc)
		}
		out[uuid] = acc
	}
	return out
}

// TestListAccountsIncludeClosed 是「关户账户仍可列出（含历史余额）」的后端兜底。
func TestListAccountsIncludeClosed(t *testing.T) {
	e := newQAServerEnv(t)

	// ---- 造一个已关户账户：先记两笔把余额归零（关户要求余额为 0），再关户 ----
	st, created, raw := e.do(http.MethodPost, "/api/accounts", map[string]any{
		"name": "Assets:ClosedSmoke", "type": "Assets", "open_date": "2026-01-01",
		"commodity": "CNY", "parent_uuid": "",
	}, "", e.token)
	if st != http.StatusCreated {
		t.Fatalf("建账户应 201，实际 %d: %s", st, raw)
	}
	closedID := int64(created["id"].(float64))
	closedUUID, _ := created["uuid"].(string)
	if closedUUID == "" {
		t.Fatalf("建账户响应缺 uuid: %s", raw)
	}

	// 对手方账户（种子账户）：用来造平衡交易。
	st, accountsBody, raw := e.do(http.MethodGet, "/api/accounts", nil, "", e.token)
	if st != http.StatusOK {
		t.Fatalf("列账户应 200，实际 %d: %s", st, raw)
	}
	var equityID int64
	for _, acc := range accountsByUUID(t, accountsBody) {
		if acc["name"] == "Equity:Opening-Balances" {
			equityID = int64(acc["id"].(float64))
		}
	}
	if equityID == 0 {
		t.Fatalf("种子账户 Equity:Opening-Balances 不存在")
	}

	// 存入 100 → 余额 100。
	st, _, raw = e.do(http.MethodPost, "/api/transactions", map[string]any{
		"date": "2026-02-01", "description": "存入", "flag": "*",
		"postings": []map[string]any{
			{"account_id": closedID, "commodity": "CNY", "amount": "100.00"},
			{"account_id": equityID, "commodity": "CNY", "amount": "-100.00"},
		},
	}, "", e.token)
	if st != http.StatusCreated {
		t.Fatalf("记账应 201，实际 %d: %s", st, raw)
	}
	// 全额转出 → 余额 0，可关户。
	st, _, raw = e.do(http.MethodPost, "/api/transactions", map[string]any{
		"date": "2026-02-02", "description": "清空", "flag": "*",
		"postings": []map[string]any{
			{"account_id": closedID, "commodity": "CNY", "amount": "-100.00"},
			{"account_id": equityID, "commodity": "CNY", "amount": "100.00"},
		},
	}, "", e.token)
	if st != http.StatusCreated {
		t.Fatalf("平账应 201，实际 %d: %s", st, raw)
	}
	st, body, raw := e.do(http.MethodDelete, "/api/accounts/"+closedUUID, nil, "", e.token)
	if st != http.StatusOK {
		t.Fatalf("关户应 200，实际 %d: %s", st, raw)
	}
	_ = body

	// ---- 断言 1：默认列表不含已关户账户 ----
	st, listBody, raw := e.do(http.MethodGet, "/api/accounts", nil, "", e.token)
	if st != http.StatusOK {
		t.Fatalf("默认列账户应 200，实际 %d: %s", st, raw)
	}
	def := accountsByUUID(t, listBody)
	if _, exists := def[closedUUID]; exists {
		t.Fatalf("默认列表不得包含已关户账户（%s）—— 前端 `accountApi.list()` 不带 include_closed 时拿到的就是这份", closedUUID)
	}
	// 断言 3a：默认列表里 close_date 一律为空（omitempty：缺键或空串都算通过）。
	for uuid, acc := range def {
		if closeDate, _ := acc["close_date"].(string); closeDate != "" {
			t.Fatalf("默认列表里的账户 %s 不应有 close_date（实际 %q）", uuid, closeDate)
		}
	}

	// ---- 断言 2 / 3b：include_closed=1 含已关户账户、带 balances、close_date 非空 ----
	st, incBody, raw := e.do(http.MethodGet, "/api/accounts?include_closed=1", nil, "", e.token)
	if st != http.StatusOK {
		t.Fatalf("include_closed=1 应 200，实际 %d: %s", st, raw)
	}
	inc := accountsByUUID(t, incBody)
	closed, exists := inc[closedUUID]
	if !exists {
		t.Fatalf("include_closed=1 必须包含已关户账户（%s），实际返回 %d 个账户", closedUUID, len(inc))
	}
	if closeDate, _ := closed["close_date"].(string); closeDate == "" {
		t.Fatalf("已关户账户必须带非空 close_date（前端据此打「已关闭」标记），实际 %#v", closed)
	}

	// **关键断言**：关户账户必须带 balances —— 资产页要显示它的历史余额。
	// 只返回账户不带余额时，页面会显示成没有金额的空行（看起来像 0 元，其实是不知情）。
	balances, ok := closed["balances"].(map[string]any)
	if !ok || len(balances) == 0 {
		t.Fatalf("已关户账户必须带 balances（历史余额可核对），实际 %#v", closed["balances"])
	}
	if got, _ := balances["CNY"].(string); got != "0.00" {
		t.Fatalf("该账户 CNY 余额应为定点串 \"0.00\"（先存入再清空），实际 %v", balances["CNY"])
	}

	// include_closed 是超集：未关户账户照样在，且不带 close_date。
	if len(inc) != len(def)+1 {
		t.Fatalf("include_closed 应比默认列表多恰好 1 个账户（关户那个），实际 %d vs %d", len(inc), len(def))
	}
	for uuid := range def {
		acc, stillThere := inc[uuid]
		if !stillThere {
			t.Fatalf("未关户账户 %s 在 include_closed 列表里丢了", uuid)
		}
		if closeDate, _ := acc["close_date"].(string); closeDate != "" {
			t.Fatalf("未关户账户 %s 不应有 close_date（实际 %q）", uuid, closeDate)
		}
	}

	// ---- 断言 4：`include_closed` 按**值**解析（不是「参数存在即生效」）----
	//
	// 这是本次修复的靶心：`Has()` 语义下 `?include_closed=false` 会**包含**关户账户，
	// 「我明确说了不要」被静默变成「你要了」。取值口径（见 AGENTS.md §7）：
	//
	//   缺省 / 0 / false / no / 无法识别 → 不含关户
	//   1 / true / yes / 裸写（空值）    → 含关户
	//
	// 「无法识别」选「不含」的理由：多给一次（关户账户出现在记账选账户里）用户
	// 无从察觉且可能真记上去，少给一次最多是用户多问一句。
	cases := []struct {
		query      string
		wantClosed bool
		why        string
	}{
		{"?include_closed", true, "裸写（空值）= 今天的行为，向后兼容"},
		{"?include_closed=", true, "显式空值等同裸写"},
		{"?include_closed=1", true, "真值"},
		{"?include_closed=true", true, "真值"},
		{"?include_closed=YES", true, "真值（大小写不敏感）"},
		{"?include_closed=0", false, "假值：必须不含"},
		{"?include_closed=false", false, "假值：必须不含"},
		{"?include_closed=no", false, "假值：必须不含"},
		{"?include_closed=maybe", false, "无法识别 → 宁可少给"},
	}
	for _, c := range cases {
		t.Run(c.query, func(t *testing.T) {
			st, body, raw := e.do(http.MethodGet, "/api/accounts"+c.query, nil, "", e.token)
			if st != http.StatusOK {
				t.Fatalf("%s 应 200，实际 %d: %s", c.query, st, raw)
			}
			_, exists := accountsByUUID(t, body)[closedUUID]
			if exists != c.wantClosed {
				want, got := "应", "有该账户"
				if !c.wantClosed {
					want, got = "不应", "也有该账户"
				}
				if !exists {
					got = "没有该账户"
				}
				t.Fatalf("%s: 关户账户%s被包含（%s）；实际%s", c.query, want, c.why, got)
			}
		})
	}
}
