package server

// T60 HTTP 层回归：GET /api/transactions 的服务端筛选 + keyset 分页。
//
// 六条必测（缺一条就等于没验证）：
//  1. 无 limit → 全量，且响应体**只有 transactions 一个键**；
//  2. limit=2 → total / has_more / next_cursor，翻页拼接无交集无遗漏；
//  3. 翻页途中插入更晚日期的交易 → 第二页不得重现第一页的 id（keyset 的意义）；
//  4. kind 三支口径（分录命中 vs 整笔判定、期初不算 transfer）；
//  5. q 五路命中 + LIKE 通配符转义；
//  6. cursor 非法 → 400（不静默当第一页）。
//
// 账户一律复用建账时自动创建的默认账户（seed.DefaultAccounts），
// 避免与种子账户重名（accounts 的唯一键是 ledger_id + name）。
//
// 本文件只新增测试，不改产品代码。

import (
	"fmt"
	"net/http"
	"testing"
)

// 默认账户名（见 internal/seed/accounts.go）。
const (
	accCash       = "Assets:Cash"             // Assets，展示名「现金」
	accFood       = "Expenses:Food"           // Expenses，展示名「餐饮」
	accSalary     = "Income:Salary"           // Income，展示名「薪资」
	accEquity     = "Equity:Opening-Balances" // Equity，展示名「期初余额」
	accAlipay     = "Assets:Alipay"           // Assets，展示名「支付宝」（全名不含中文）
	accRealEstate = "Assets:RealEstate"       // Assets，展示名「房产」（全名含 ASCII token）
)

// txnListEnv 是交易列表测试环境：在 qaServerEnv 之上补账本 id 与账户名 → id 映射。
type txnListEnv struct {
	*qaServerEnv
	ledgerID string
	accounts map[string]int64
}

func newTxnListEnv(t *testing.T) *txnListEnv {
	t.Helper()
	e := &txnListEnv{qaServerEnv: newQAServerEnv(t), ledgerID: "1"}
	e.accounts = e.loadAccounts(t)
	return e
}

// loadAccounts 读取账本账户列表，建立 name → id 映射。
func (e *txnListEnv) loadAccounts(t *testing.T) map[string]int64 {
	t.Helper()
	st, body, raw := e.do(http.MethodGet, "/api/accounts", nil, e.ledgerID, e.token)
	if st != http.StatusOK {
		t.Fatalf("列出账户应 200，实际 %d: %s", st, raw)
	}
	items, ok := body["accounts"].([]any)
	if !ok {
		t.Fatalf("accounts 不是数组: %s", raw)
	}
	out := make(map[string]int64, len(items))
	for _, item := range items {
		acc, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("accounts 元素不是对象: %#v", item)
		}
		name, _ := acc["name"].(string)
		out[name] = txnQueryInt(t, acc, "id")
	}
	return out
}

// accountID 按账户名取 id，取不到直接失败（避免测试静默跑在错账户上）。
func (e *txnListEnv) accountID(t *testing.T, name string) int64 {
	t.Helper()
	id, ok := e.accounts[name]
	if !ok || id == 0 {
		t.Fatalf("默认账户 %q 不存在（种子账户清单变了？）", name)
	}
	return id
}

// addMember 注册一个成员并加入当前账本，返回其 token。
func (e *txnListEnv) addMember(t *testing.T, username, display string) string {
	t.Helper()
	msg, err := e.svc.Register(username, "secret123", display)
	if err != nil {
		t.Fatalf("注册成员 %s: %v", username, err)
	}
	if _, _, err := e.svc.AddMember(1, e.userID, username, "editor"); err != nil {
		t.Fatalf("把 %s 加入账本: %v", username, err)
	}
	return msg.Token
}

// postingEntry 构造一条 postings 载荷。
func postingEntry(accountID int64, amount string) map[string]any {
	return map[string]any{"account_id": accountID, "commodity": "CNY", "amount": amount}
}

// txn 记一笔账，返回 id。
func (e *txnListEnv) txn(t *testing.T, token, date, description string, tags []string, postings ...map[string]any) int64 {
	t.Helper()
	body := map[string]any{
		"date": date, "flag": "*", "description": description, "postings": postings,
	}
	if len(tags) > 0 {
		body["tags"] = tags
	}
	st, res, raw := e.do(http.MethodPost, "/api/transactions", body, e.ledgerID, token)
	if st != http.StatusCreated {
		t.Fatalf("记账 %q 应 201，实际 %d: %s", description, st, raw)
	}
	return txnQueryInt(t, res, "id")
}

// list 发起 GET /api/transactions，返回状态码与响应体。
func (e *txnListEnv) list(t *testing.T, query string) (int, map[string]any) {
	t.Helper()
	path := "/api/transactions"
	if query != "" {
		path += "?" + query
	}
	st, body, _ := e.do(http.MethodGet, path, nil, e.ledgerID, e.token)
	return st, body
}

// txnQueryInt 从响应体里读一个整数（JSON 数字统一是 float64）。
func txnQueryInt(t *testing.T, body map[string]any, key string) int64 {
	t.Helper()
	raw, ok := body[key]
	if !ok {
		t.Fatalf("响应缺少 %s 字段: %v", key, body)
	}
	f, ok := raw.(float64)
	if !ok {
		t.Fatalf("%s 字段不是数字: %#v", key, raw)
	}
	return int64(f)
}

// idsFromBody 取出 body.transactions 里的 id 序列（保持响应顺序）。
func idsFromBody(t *testing.T, body map[string]any) []int64 {
	t.Helper()
	raw, ok := body["transactions"]
	if !ok {
		t.Fatalf("响应缺少 transactions 字段: %v", body)
	}
	items, ok := raw.([]any)
	if !ok {
		t.Fatalf("transactions 不是数组: %#v", raw)
	}
	out := make([]int64, 0, len(items))
	for i, item := range items {
		m, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("transactions[%d] 不是对象: %#v", i, item)
		}
		out = append(out, txnQueryInt(t, m, "id"))
	}
	return out
}

// idSet 把 id 序列压成集合。
func idSet(ids []int64) map[int64]bool {
	out := make(map[int64]bool, len(ids))
	for _, id := range ids {
		out[id] = true
	}
	return out
}

// sameIDSet 断言实际 id 集合与期望完全一致（顺序无关）。
func sameIDSet(t *testing.T, label string, got []int64, want ...int64) {
	t.Helper()
	gotSet := idSet(got)
	wantSet := idSet(want)
	if len(gotSet) != len(wantSet) {
		t.Fatalf("%s: 命中 %d 条 %v，期望 %d 条 %v", label, len(gotSet), got, len(wantSet), want)
	}
	for id := range wantSet {
		if !gotSet[id] {
			t.Fatalf("%s: 缺少 id=%d（实际 %v）", label, id, got)
		}
	}
	for id := range gotSet {
		if !wantSet[id] {
			t.Fatalf("%s: 多出 id=%d（实际 %v）", label, id, got)
		}
	}
}

// TestTxnListNoLimitReturnsOnlyTransactionsKey 覆盖必测 1：
// 不给 limit → 全量，且响应体**只有 transactions 一个键**。
// 现网有 8 处调用走全量，多一个键就是契约破坏。
func TestTxnListNoLimitReturnsOnlyTransactionsKey(t *testing.T) {
	e := newTxnListEnv(t)
	cash := e.accountID(t, accCash)
	food := e.accountID(t, accFood)

	want := 3
	for i := 1; i <= want; i++ {
		e.txn(t, e.token, fmt.Sprintf("2026-01-%02d", i), fmt.Sprintf("第%d笔", i), nil,
			postingEntry(cash, "-10.00"), postingEntry(food, "10.00"))
	}

	st, body := e.list(t, "")
	if st != http.StatusOK {
		t.Fatalf("GET /api/transactions 应 200，实际 %d: %v", st, body)
	}
	if len(body) != 1 {
		t.Fatalf("无 limit 时响应体必须只有 transactions 一个键，实际 %d 个键: %v", len(body), body)
	}
	if _, ok := body["transactions"]; !ok {
		t.Fatalf("响应缺少 transactions: %v", body)
	}
	if got := idsFromBody(t, body); len(got) != want {
		t.Fatalf("无 limit 应返回全量 %d 条，实际 %d 条: %v", want, len(got), got)
	}

	// limit=0 与缺省等价：仍然只有 transactions 一个键、仍然是全量。
	st, body = e.list(t, "limit=0")
	if st != http.StatusOK {
		t.Fatalf("limit=0 应 200，实际 %d: %v", st, body)
	}
	if len(body) != 1 {
		t.Fatalf("limit=0 时响应体必须只有 transactions 一个键，实际 %d 个键: %v", len(body), body)
	}
	if got := idsFromBody(t, body); len(got) != want {
		t.Fatalf("limit=0 应返回全量 %d 条，实际 %d 条", want, len(got))
	}
}

// TestTxnListLimitPagination 覆盖必测 2：
// limit=2 → 2 条 + total + has_more + next_cursor；用 next_cursor 再请求，
// 两页 id 无交集、无遗漏（拼起来等于全量前 4 条）。
func TestTxnListLimitPagination(t *testing.T) {
	e := newTxnListEnv(t)
	cash := e.accountID(t, accCash)
	food := e.accountID(t, accFood)

	made := make([]int64, 0, 5)
	for i := 1; i <= 5; i++ {
		made = append(made, e.txn(t, e.token,
			fmt.Sprintf("2026-02-%02d", i), fmt.Sprintf("第%d天", i), nil,
			postingEntry(cash, "-1.00"), postingEntry(food, "1.00")))
	}

	// 全量顺序（date DESC）：第 5 天 → 第 1 天。
	full := make([]int64, 0, len(made))
	for i := len(made) - 1; i >= 0; i-- {
		full = append(full, made[i])
	}
	if st, body := e.list(t, ""); st != http.StatusOK || len(idsFromBody(t, body)) != 5 {
		t.Fatalf("全量列表异常: %d %v", st, body)
	}

	st, page1 := e.list(t, "limit=2")
	if st != http.StatusOK {
		t.Fatalf("limit=2 应 200，实际 %d: %v", st, page1)
	}
	page1IDs := idsFromBody(t, page1)
	if len(page1IDs) != 2 {
		t.Fatalf("limit=2 应返回 2 条，实际 %d 条: %v", len(page1IDs), page1IDs)
	}
	if total := txnQueryInt(t, page1, "total"); total != 5 {
		t.Fatalf("total 应为满足筛选条件的 5，实际 %d", total)
	}
	if hasMore, ok := page1["has_more"].(bool); !ok || !hasMore {
		t.Fatalf("has_more 应为 true，实际 %v", page1["has_more"])
	}
	cursor, _ := page1["next_cursor"].(string)
	if cursor == "" {
		t.Fatalf("应有非空 next_cursor: %v", page1)
	}

	st, page2 := e.list(t, "limit=2&cursor="+cursor)
	if st != http.StatusOK {
		t.Fatalf("第二页应 200，实际 %d: %v", st, page2)
	}
	page2IDs := idsFromBody(t, page2)
	if len(page2IDs) != 2 {
		t.Fatalf("第二页应 2 条，实际 %d 条: %v", len(page2IDs), page2IDs)
	}
	if total := txnQueryInt(t, page2, "total"); total != 5 {
		t.Fatalf("第二页 total 仍应为 5，实际 %d", total)
	}

	// 无交集。
	seen := idSet(page1IDs)
	for _, id := range page2IDs {
		if seen[id] {
			t.Fatalf("第二页出现第一页已返回的 id=%d（%v / %v）", id, page1IDs, page2IDs)
		}
	}
	// 无遗漏：两页拼起来 == 全量前 4 条。
	joined := append(append([]int64{}, page1IDs...), page2IDs...)
	if len(joined) != 4 {
		t.Fatalf("两页应共 4 条，实际 %d 条: %v", len(joined), joined)
	}
	for i := 0; i < 4; i++ {
		if joined[i] != full[i] {
			t.Fatalf("拼接第 %d 条应为 id=%d，实际 id=%d（joined=%v full=%v）", i, full[i], joined[i], joined, full)
		}
	}

	// 最后一页：第二页的游标 → 1 条，has_more=false，且不给 next_cursor。
	cursor2, _ := page2["next_cursor"].(string)
	if cursor2 == "" {
		t.Fatalf("第二页应仍有 next_cursor（共 5 条，还有 1 条）: %v", page2)
	}
	st, page3 := e.list(t, "limit=2&cursor="+cursor2)
	if st != http.StatusOK {
		t.Fatalf("第三页应 200，实际 %d: %v", st, page3)
	}
	if got := idsFromBody(t, page3); len(got) != 1 || got[0] != full[4] {
		t.Fatalf("第三页应只有 id=%d，实际 %v", full[4], got)
	}
	if hasMore, ok := page3["has_more"].(bool); !ok || hasMore {
		t.Fatalf("第三页 has_more 应为 false，实际 %v", page3["has_more"])
	}
	if _, exists := page3["next_cursor"]; exists {
		t.Fatalf("无下一页时不得输出 next_cursor: %v", page3)
	}
}

// TestTxnListPagingSurvivesLateInsert 覆盖必测 3：
// 第一页取完后插入一笔日期更晚的交易，第二页不得重现第一页的 id。
// 用 offset 分页会红（插入使整段前移，第二页重复返回第一页的最后一行）。
func TestTxnListPagingSurvivesLateInsert(t *testing.T) {
	e := newTxnListEnv(t)
	cash := e.accountID(t, accCash)
	food := e.accountID(t, accFood)

	for i := 1; i <= 5; i++ {
		e.txn(t, e.token, fmt.Sprintf("2026-04-%02d", i), fmt.Sprintf("第%d天", i), nil,
			postingEntry(cash, "-1.00"), postingEntry(food, "1.00"))
	}

	st, page1 := e.list(t, "limit=2")
	if st != http.StatusOK {
		t.Fatalf("第一页应 200，实际 %d: %v", st, page1)
	}
	page1IDs := idsFromBody(t, page1)
	if len(page1IDs) != 2 {
		t.Fatalf("第一页应 2 条，实际 %v", page1IDs)
	}
	cursor, _ := page1["next_cursor"].(string)
	if cursor == "" {
		t.Fatalf("第一页应给出 next_cursor: %v", page1)
	}

	// 翻页途中补记一笔更晚日期的交易（04-20 晚于第一页所有行）。
	lateID := e.txn(t, e.token, "2026-04-20", "迟到的补记", nil,
		postingEntry(cash, "-9.00"), postingEntry(food, "9.00"))

	st, page2 := e.list(t, "limit=2&cursor="+cursor)
	if st != http.StatusOK {
		t.Fatalf("第二页应 200，实际 %d: %v", st, page2)
	}
	page2IDs := idsFromBody(t, page2)
	seen := idSet(page1IDs)
	for _, id := range page2IDs {
		if seen[id] {
			t.Fatalf("第二页出现第一页已返回的 id=%d（第一页 %v / 第二页 %v）", id, page1IDs, page2IDs)
		}
	}
	if len(page2IDs) != 2 {
		t.Fatalf("第二页应 2 条，实际 %v", page2IDs)
	}
	// 新插入的那笔日期更晚，属于「第一页之前」，不应出现在第二页。
	if idSet(page2IDs)[lateID] {
		t.Fatalf("补记的更晚日期交易不应出现在后续页: %v", page2IDs)
	}
}

// TestTxnListKindSemantics 覆盖必测 4：kind 三支口径与前端 applyFilters 逐字对齐。
//
//	① Assets→Expenses                        → expense
//	② 退款（含 Expenses 与 Income 分录）      → expense **且** income
//	③ Assets→Assets                          → transfer
//	④ 含 Equity 的期初交易                    → 不命中 transfer（也不命中 expense/income）
func TestTxnListKindSemantics(t *testing.T) {
	e := newTxnListEnv(t)
	cash := e.accountID(t, accCash)
	alipay := e.accountID(t, accAlipay)
	food := e.accountID(t, accFood)
	salary := e.accountID(t, accSalary)
	equity := e.accountID(t, accEquity)

	expenseID := e.txn(t, e.token, "2026-05-01", "买菜", nil,
		postingEntry(cash, "-12.50"), postingEntry(food, "12.50"))
	refundID := e.txn(t, e.token, "2026-05-02", "退款", nil,
		postingEntry(cash, "3.00"), postingEntry(food, "-5.00"), postingEntry(salary, "2.00"))
	transferID := e.txn(t, e.token, "2026-05-03", "转账", nil,
		postingEntry(cash, "-20.00"), postingEntry(alipay, "20.00"))
	openingID := e.txn(t, e.token, "2026-05-04", "期初", nil,
		postingEntry(cash, "100.00"), postingEntry(equity, "-100.00"))

	st, body := e.list(t, "kind=expense")
	if st != http.StatusOK {
		t.Fatalf("kind=expense 应 200，实际 %d: %v", st, body)
	}
	sameIDSet(t, "kind=expense", idsFromBody(t, body), expenseID, refundID)

	st, body = e.list(t, "kind=income")
	if st != http.StatusOK {
		t.Fatalf("kind=income 应 200，实际 %d: %v", st, body)
	}
	sameIDSet(t, "kind=income", idsFromBody(t, body), refundID)

	st, body = e.list(t, "kind=transfer")
	if st != http.StatusOK {
		t.Fatalf("kind=transfer 应 200，实际 %d: %v", st, body)
	}
	transferIDs := idsFromBody(t, body)
	sameIDSet(t, "kind=transfer", transferIDs, transferID)
	// 期初交易（含 Equity 分录）绝不能算 transfer。
	if idSet(transferIDs)[openingID] {
		t.Fatalf("期初交易不应命中 transfer: %v", body)
	}

	// 非法 kind（含 'all'）视为不过滤。
	st, body = e.list(t, "kind=all")
	if st != http.StatusOK {
		t.Fatalf("kind=all 应 200，实际 %d: %v", st, body)
	}
	if got := idsFromBody(t, body); len(got) != 4 {
		t.Fatalf("kind=all 应返回全量 4 条，实际 %v", got)
	}
}

// TestTxnListKeywordFiveRoutes 覆盖必测 5：q 五路（备注 / 会员名 / 标签 /
// 账户全名 / 账户展示名）各自命中，且 LIKE 通配符已转义。
func TestTxnListKeywordFiveRoutes(t *testing.T) {
	e := newTxnListEnv(t)
	memberToken := e.addMember(t, "txn-q-lisi", "小美")

	cash := e.accountID(t, accCash)
	food := e.accountID(t, accFood)
	// Assets:RealEstate / 展示名「房产」：全名含 ASCII token，展示名不含中文 token。
	nameOnly := e.accountID(t, accRealEstate)
	// Assets:Alipay / 展示名「支付宝」：展示名含中文，全名不含。
	displayOnly := e.accountID(t, accAlipay)

	// ① 只命中备注。
	byDesc := e.txn(t, e.token, "2026-06-01", "独一无二的备注", nil,
		postingEntry(cash, "-1.00"), postingEntry(food, "1.00"))
	// ② 只命中账户全名。
	byName := e.txn(t, e.token, "2026-06-02", "第二笔", nil,
		postingEntry(cash, "-2.00"), postingEntry(nameOnly, "2.00"))
	// ③ 只命中账户展示名。
	byDisplay := e.txn(t, e.token, "2026-06-03", "第三笔", nil,
		postingEntry(cash, "-3.00"), postingEntry(displayOnly, "3.00"))
	// ④ 只命中标签。
	byTag := e.txn(t, e.token, "2026-06-04", "第四笔", []string{"野餐"},
		postingEntry(cash, "-4.00"), postingEntry(food, "4.00"))
	// ⑤ 只命中会员名（由另一个成员记账）。
	byMember := e.txn(t, memberToken, "2026-06-05", "第五笔", nil,
		postingEntry(cash, "-5.00"), postingEntry(food, "5.00"))

	cases := []struct {
		label   string
		query   string
		wantID  int64
		explain string
	}{
		{"备注", "q=独一无二的备注", byDesc, "transactions.description"},
		{"账户全名", "q=RealEstate", byName, "accounts.name"},
		{"账户展示名", "q=支付宝", byDisplay, "accounts.display_name"},
		{"标签", "q=野餐", byTag, "transactions.tags"},
		{"会员名", "q=小美", byMember, "users.display_name"},
	}
	for _, c := range cases {
		t.Run(c.label, func(t *testing.T) {
			st, body := e.list(t, c.query)
			if st != http.StatusOK {
				t.Fatalf("%s 应 200，实际 %d: %v", c.query, st, body)
			}
			sameIDSet(t, c.label+"（"+c.explain+"）", idsFromBody(t, body), c.wantID)
		})
	}

	// 转义生效：q=% 不能匹配所有行。
	st, body := e.list(t, "q=%25") // URL 编码的 '%'
	if st != http.StatusOK {
		t.Fatalf("q=%% 应 200，实际 %d: %v", st, body)
	}
	if got := idsFromBody(t, body); len(got) != 0 {
		t.Fatalf("q=%% 应 0 条（LIKE 通配符必须转义），实际 %d 条: %v", len(got), got)
	}

	// 纯空白 q 视为无筛选。
	st, body = e.list(t, "q=%20%20")
	if st != http.StatusOK {
		t.Fatalf("q=空白 应 200，实际 %d: %v", st, body)
	}
	if got := idsFromBody(t, body); len(got) != 5 {
		t.Fatalf("q=纯空白应返回全量 5 条，实际 %d 条: %v", len(got), got)
	}
}

// TestTxnListTagsExposedInFullResponse 覆盖 HTTP 真实链路的 tags 透出契约：
// 带标签交易必须在 GET /api/transactions 的 transactions 数组里带 tags，
// 否则前端 P0-1 原生语法片段的 tags 行会静默变空（mock 测试发现不了）。
func TestTxnListTagsExposedInFullResponse(t *testing.T) {
	e := newTxnListEnv(t)
	cash := e.accountID(t, accCash)
	food := e.accountID(t, accFood)

	wantTags := []string{"早餐", "家庭"}
	taggedID := e.txn(t, e.token, "2026-07-01", "带标签的早餐", wantTags,
		postingEntry(cash, "-18.00"), postingEntry(food, "18.00"))

	st, body := e.list(t, "")
	if st != http.StatusOK {
		t.Fatalf("GET /api/transactions 应 200，实际 %d: %v", st, body)
	}
	items, ok := body["transactions"].([]any)
	if !ok {
		t.Fatalf("transactions 不是数组: %#v", body["transactions"])
	}

	var found map[string]any
	for i, item := range items {
		m, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("transactions[%d] 不是对象: %#v", i, item)
		}
		if txnQueryInt(t, m, "id") == taggedID {
			found = m
			break
		}
	}
	if found == nil {
		t.Fatalf("全量列表未找到新记的交易 id=%d: %v", taggedID, idsFromBody(t, body))
	}

	raw, ok := found["tags"]
	if !ok {
		t.Fatalf("交易 id=%d 的列表项缺少 tags 字段（前端原生语法片段会静默变空）: %v", taggedID, found)
	}
	got, ok := raw.([]any)
	if !ok {
		t.Fatalf("交易 id=%d 的 tags 不是数组: %#v", taggedID, raw)
	}
	if len(got) != len(wantTags) {
		t.Fatalf("交易 id=%d 的 tags 有 %d 项，期望 %d 项: %#v", taggedID, len(got), len(wantTags), got)
	}
	for i, want := range wantTags {
		actual, ok := got[i].(string)
		if !ok || actual != want {
			t.Fatalf("交易 id=%d 的 tags[%d] = %#v，期望 %q", taggedID, i, got[i], want)
		}
	}

	// 无标签交易仍按 omitempty 缺省，与前端 `tags?` optional 契约一致。
	e.txn(t, e.token, "2026-07-02", "无标签交易", nil,
		postingEntry(cash, "-2.00"), postingEntry(food, "2.00"))
	st, body = e.list(t, "")
	if st != http.StatusOK {
		t.Fatalf("GET /api/transactions 应 200，实际 %d: %v", st, body)
	}
	for _, item := range body["transactions"].([]any) {
		m := item.(map[string]any)
		if txnQueryInt(t, m, "id") != taggedID {
			if _, exists := m["tags"]; exists {
				t.Fatalf("无标签交易不应带 tags 键（omitempty 契约）: %v", m)
			}
		}
	}
}

// TestTxnListCursorInvalid 覆盖必测 6：非法 cursor → 400，不静默当第一页。
//
// 三个样本分别覆盖：非 base64、base64 但缺分隔符、base64 且分隔符在但 id 非数字。
func TestTxnListCursorInvalid(t *testing.T) {
	e := newTxnListEnv(t)
	cash := e.accountID(t, accCash)
	food := e.accountID(t, accFood)
	e.txn(t, e.token, "2026-07-01", "买水", nil,
		postingEntry(cash, "-1.00"), postingEntry(food, "1.00"))

	cases := []struct {
		label  string
		cursor string
	}{
		{"非 base64", "notbase64"},
		{"缺分隔符", "bm90LWEtY3Vyc29y"},   // "not-a-cursor"
		{"id 非数字", "MjAyNi0wMS0wMXx4"}, // "2026-01-01|x"
	}
	for _, c := range cases {
		t.Run(c.label, func(t *testing.T) {
			st, body := e.list(t, "limit=1&cursor="+c.cursor)
			if st != http.StatusBadRequest {
				t.Fatalf("cursor=%q 应 400，实际 %d: %v", c.cursor, st, body)
			}
		})
	}
}

// TestTxnListOtherFilterParams 是参数接线的守门用例：from / to / account /
// category / member / tag / currency 的 URL 键名与 SQL 谓词一一对上。
//
// 这些参数单看 SQL 都对，最易出错的地方恰恰是 handler 里的键名抄错
// （例如把 category 读成 account），只有走 HTTP 才能暴露。
func TestTxnListOtherFilterParams(t *testing.T) {
	e := newTxnListEnv(t)
	memberToken := e.addMember(t, "txn-filter-lisi", "小美")
	cash := e.accountID(t, accCash)
	food := e.accountID(t, accFood)
	alipay := e.accountID(t, accAlipay)

	early := e.txn(t, e.token, "2026-08-01", "月初", []string{"必要"}, // expense
		postingEntry(cash, "-10.00"), postingEntry(food, "10.00"))
	mid := e.txn(t, e.token, "2026-08-10", "月中", nil, // expense
		postingEntry(cash, "-20.00"), postingEntry(food, "20.00"))
	late := e.txn(t, memberToken, "2026-08-20", "月末", nil, // transfer（无 Expenses/Income）
		postingEntry(cash, "-30.00"), postingEntry(alipay, "30.00"))

	cases := []struct {
		label string
		query string
		want  []int64
	}{
		{"from 含端点", "from=2026-08-10", []int64{late, mid}},
		{"to 含端点", "to=2026-08-10", []int64{mid, early}},
		{"from+to 闭区间", "from=2026-08-05&to=2026-08-15", []int64{mid}},
		{"account 分录命中", "account=" + itoa64(cash), []int64{late, mid, early}},
		{"category 分录命中", "category=" + itoa64(food), []int64{mid, early}},
		{"member 子串", "member=" + "小美", []int64{late}},
		{"tag 重复参数", "tag=不存在&tag=必要", []int64{early}},
		{"currency 命中", "currency=CNY", []int64{late, mid, early}},
		{"currency 未命中", "currency=USD", nil},
		{"非法 from 被忽略", "from=2026-8-1", []int64{late, mid, early}},
		{"非法 to 被忽略", "to=not-a-date", []int64{late, mid, early}},
		{"非法 kind 被忽略", "kind=lunch", []int64{late, mid, early}},
	}
	for _, c := range cases {
		t.Run(c.label, func(t *testing.T) {
			st, body := e.list(t, c.query)
			if st != http.StatusOK {
				t.Fatalf("%s 应 200，实际 %d: %v", c.query, st, body)
			}
			got := idsFromBody(t, body)
			if len(got) != len(c.want) {
				t.Fatalf("%s: 命中 %d 条 %v，期望 %d 条 %v", c.query, len(got), got, len(c.want), c.want)
			}
			sameIDSet(t, c.query, got, c.want...)
		})
	}

	// total 必须是「满足筛选条件的笔数」，不是全量笔数。
	st, body := e.list(t, "limit=5&kind=expense")
	if st != http.StatusOK {
		t.Fatalf("limit+kind 应 200，实际 %d: %v", st, body)
	}
	if total := txnQueryInt(t, body, "total"); total != 2 {
		t.Fatalf("kind=expense 的 total 应为 2，实际 %d（total 必须跟随筛选条件）", total)
	}
	if hasMore, ok := body["has_more"].(bool); !ok || hasMore {
		t.Fatalf("limit=5 覆盖 2 条结果时 has_more 应为 false，实际 %v", body["has_more"])
	}

	// 非法 limit（非数字 / 负数）按缺省处理 → 全量且响应只有 transactions 一个键。
	for _, q := range []string{"limit=abc", "limit=-1"} {
		st, body := e.list(t, q)
		if st != http.StatusOK {
			t.Fatalf("%s 应 200，实际 %d: %v", q, st, body)
		}
		if len(body) != 1 {
			t.Fatalf("%s 应按「未分页」响应（只有 transactions 一个键），实际 %v", q, body)
		}
	}
}

// itoa64 把 int64 转成十进制字符串（URL 参数用）。
func itoa64(n int64) string { return fmt.Sprintf("%d", n) }

// TestTxnListWithSummaryResponse 是 with=summary 的传输层契约：
//   - 不带 with → 响应体**只有 transactions 一个键**（铁律，7 处全量调用零变化）；
//   - with=summary → 追加 summary，且 summary.total == 列表长度（同源证据）；
//   - 与 limit 组合时 summary 与 total/has_more 并存；
//   - 未识别的 with 值被忽略（不报错、不加键）。
func TestTxnListWithSummaryResponse(t *testing.T) {
	e := newTxnListEnv(t)
	cash := e.accountID(t, accCash)
	food := e.accountID(t, accFood)
	salary := e.accountID(t, accSalary)

	e.txn(t, e.token, "2026-09-01", "买菜", nil,
		postingEntry(food, "10.10"), postingEntry(cash, "-10.10"))
	e.txn(t, e.token, "2026-09-02", "工资", nil,
		postingEntry(cash, "20.20"), postingEntry(salary, "-20.20"))

	// 1) 不带 with：只有一个键。
	st, body := e.list(t, "")
	if st != http.StatusOK {
		t.Fatalf("GET 应 200，实际 %d: %v", st, body)
	}
	if len(body) != 1 {
		t.Fatalf("不带 with 时响应体必须只有 transactions 一个键，实际 %+v", body)
	}

	// 2) with=summary（不带 limit）：transactions + summary。
	st, body = e.list(t, "with=summary")
	if st != http.StatusOK {
		t.Fatalf("with=summary 应 200，实际 %d: %v", st, body)
	}
	if len(body) != 2 {
		t.Fatalf("with=summary 且不分页时应恰好 2 个键，实际 %+v", body)
	}
	summary, ok := body["summary"].(map[string]any)
	if !ok {
		t.Fatalf("summary 不是对象: %+v", body["summary"])
	}
	listLen := len(idsFromBody(t, body))
	if got := txnQueryInt(t, summary, "total"); got != int64(listLen) {
		t.Fatalf("summary.total(%d) 必须等于同条件列表长度(%d)", got, listLen)
	}
	rows, ok := summary["by_commodity"].([]any)
	if !ok || len(rows) != 1 {
		t.Fatalf("by_commodity 应为 1 行: %+v", summary["by_commodity"])
	}
	row, ok := rows[0].(map[string]any)
	if !ok {
		t.Fatalf("by_commodity[0] 不是对象: %#v", rows[0])
	}
	if row["commodity"] != "CNY" || row["expense"] != "10.10" || row["income"] != "20.20" {
		t.Fatalf("CNY 汇总应为 expense=10.10 income=20.20，实际 %+v", row)
	}
	// 金额必须是**字符串**（定点串），不是 JSON 数字 —— 浮点数会丢精度。
	if _, isString := row["expense"].(string); !isString {
		t.Fatalf("expense 必须序列化为字符串，实际 %#v", row["expense"])
	}

	// 3) 与 limit 组合：transactions / total / has_more / summary 并存。
	st, body = e.list(t, "with=summary&limit=1")
	if st != http.StatusOK {
		t.Fatalf("with=summary&limit=1 应 200，实际 %d: %v", st, body)
	}
	for _, key := range []string{"transactions", "total", "has_more", "summary"} {
		if _, exists := body[key]; !exists {
			t.Fatalf("with=summary&limit=1 缺少 %s 键: %+v", key, body)
		}
	}
	if got := len(idsFromBody(t, body)); got != 1 {
		t.Fatalf("limit=1 应 1 条，实际 %d 条", got)
	}
	pagedSummary, _ := body["summary"].(map[string]any)
	if got := txnQueryInt(t, pagedSummary, "total"); got != 2 {
		t.Fatalf("limit=1 时 summary.total 仍应为 2（全量笔数），实际 %d", got)
	}

	// 4) 未识别的 with 值：忽略，响应形状与不带 with 完全一致。
	for _, q := range []string{"with=other", "with=", "with=summary2"} {
		st, body = e.list(t, q)
		if st != http.StatusOK {
			t.Fatalf("%s 应 200，实际 %d: %v", q, st, body)
		}
		if len(body) != 1 {
			t.Fatalf("%s 应被忽略（只有 transactions 一个键），实际 %+v", q, body)
		}
	}
}
