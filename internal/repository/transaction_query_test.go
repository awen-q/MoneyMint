package repository

// 仓储层测试：交易筛选（kind / 标签 / 关键词）+ keyset 分页 + COUNT 口径一致性。
//
// 直接用 SQL 造数据（绕开 service 的平衡校验），专注验证 SQL 语义本身；
// HTTP 层的完整契约（响应形状、400 游标等）在 internal/server 里覆盖。

import (
	"database/sql"
	"strings"
	"testing"

	"familyledger/internal/domain"
)

// txnQueryFixture 是筛选测试的最小数据集。
//
// 账户：1 现金(Assets) 2 餐饮(Expenses, 展示名「餐饮」) 3 工资(Income)
//
//	4 期初权益(Equity) 5 银行卡(Assets) 6 Assets:QFull:ZetaToken(展示名「钱包」)
//
// 交易：
//
//	t1 2026-01-01 早餐   现金 -10 / 餐饮 +10            → expense
//	t2 2026-01-02 退款   现金  +3 / 餐饮  -5 / 工资 +2   → expense + income
//	t3 2026-01-03 转账   现金 -20 / 银行卡 +20          → transfer
//	t4 2026-01-04 期初   现金+100 / 权益 -100           → 含 Equity，不是 transfer
//	t5 2026-01-05 已删   现金  -1 / 餐饮  +1            → 软删，任何筛选都不可见
type txnQueryFixture struct {
	ledgerID int64
	cashID   int64
	foodID   int64
	salaryID int64
	bankID   int64
	// id 到日期的映射，断言时用。
	txnIDs map[string]int64
}

// seedTxnQueryFixture 建立用户 / 账本 / 账户 / 交易数据集。
func seedTxnQueryFixture(t *testing.T, conn *sql.DB) txnQueryFixture {
	t.Helper()
	stmts := []string{
		`INSERT INTO users(id, username, password_hash, display_name)
		 VALUES(1,'query-owner','x','小美')`,
		`INSERT INTO ledgers(id, name, owner_id) VALUES(1,'筛选测试账本',1)`,
		`INSERT INTO accounts(id, ledger_id, uuid, name, display_name, type, open_date)
		 VALUES(1,1,'acc-cash','Assets:Cash','', 'Assets','2026-01-01')`,
		`INSERT INTO accounts(id, ledger_id, uuid, name, display_name, type, open_date)
		 VALUES(2,1,'acc-food','Expenses:Food','餐饮','Expenses','2026-01-01')`,
		`INSERT INTO accounts(id, ledger_id, uuid, name, display_name, type, open_date)
		 VALUES(3,1,'acc-salary','Income:Salary','', 'Income','2026-01-01')`,
		`INSERT INTO accounts(id, ledger_id, uuid, name, display_name, type, open_date)
		 VALUES(4,1,'acc-equity','Equity:Opening-Balances','', 'Equity','2026-01-01')`,
		`INSERT INTO accounts(id, ledger_id, uuid, name, display_name, type, open_date)
		 VALUES(5,1,'acc-bank','Assets:Bank','', 'Assets','2026-01-01')`,
		`INSERT INTO accounts(id, ledger_id, uuid, name, display_name, type, open_date)
		 VALUES(6,1,'acc-alpha','Assets:QFull:ZetaToken','钱包','Assets','2026-01-01')`,
	}
	for _, q := range stmts {
		if _, err := conn.Exec(q); err != nil {
			t.Fatalf("插入账户数据集失败: %v\nSQL: %s", err, q)
		}
	}

	f := txnQueryFixture{
		ledgerID: 1, cashID: 1, foodID: 2, salaryID: 3, bankID: 5,
		txnIDs: map[string]int64{},
	}
	f.txnIDs["breakfast"] = insertQueryTxn(t, conn, queryTxnSeed{
		date: "2026-01-01", description: "早餐", tags: `["food"]`, createdBy: 1,
		postings: []queryPosting{{f.cashID, "CNY", -10}, {f.foodID, "CNY", 10}},
	})
	f.txnIDs["refund"] = insertQueryTxn(t, conn, queryTxnSeed{
		date: "2026-01-02", description: "退款", createdBy: 1,
		postings: []queryPosting{{f.cashID, "CNY", 3}, {f.foodID, "CNY", -5}, {f.salaryID, "CNY", 2}},
	})
	f.txnIDs["transfer"] = insertQueryTxn(t, conn, queryTxnSeed{
		date: "2026-01-03", description: "转账", createdBy: 1,
		postings: []queryPosting{{f.cashID, "CNY", -20}, {f.bankID, "CNY", 20}},
	})
	f.txnIDs["opening"] = insertQueryTxn(t, conn, queryTxnSeed{
		date: "2026-01-04", description: "期初", createdBy: 1,
		postings: []queryPosting{{f.cashID, "CNY", 100}, {4, "CNY", -100}},
	})
	f.txnIDs["deleted"] = insertQueryTxn(t, conn, queryTxnSeed{
		date: "2026-01-05", description: "已删", createdBy: 1, deleted: true,
		postings: []queryPosting{{f.cashID, "CNY", -1}, {f.foodID, "CNY", 1}},
	})
	return f
}

// queryTxnSeed 是一笔测试交易的最小输入。
type queryTxnSeed struct {
	date        string
	description string
	tags        string // JSON 数组文本；空表示 NULL
	createdBy   int64
	deleted     bool
	postings    []queryPosting
}

// queryPosting 是一条测试分录的最小输入。
type queryPosting struct {
	accountID int64
	commodity string
	amount    int
}

// insertQueryTxn 插入一笔交易及其分录，返回交易 id。
func insertQueryTxn(t *testing.T, conn *sql.DB, seed queryTxnSeed) int64 {
	t.Helper()
	var tags any
	if seed.tags != "" {
		tags = seed.tags
	}
	var deletedAt any
	if seed.deleted {
		deletedAt = "2026-02-01 00:00:00"
	}
	res, err := conn.Exec(
		`INSERT INTO transactions(ledger_id, uuid, date, flag, description, tags, created_by, deleted_at)
		 VALUES(1, ?, ?, '*', ?, ?, ?, ?)`,
		"txn-"+seed.date+"-"+seed.description, seed.date, seed.description, tags, seed.createdBy, deletedAt,
	)
	if err != nil {
		t.Fatalf("插入交易失败: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("取交易 id 失败: %v", err)
	}
	for i, p := range seed.postings {
		if _, err := conn.Exec(
			`INSERT INTO postings(transaction_id, account_id, commodity, amount, position)
			 VALUES(?, ?, ?, ?, ?)`,
			id, p.accountID, p.commodity, p.amount, i,
		); err != nil {
			t.Fatalf("插入分录失败: %v", err)
		}
	}
	return id
}

// idsOf 把交易切片压成 id 集合。
func idsOf(txns []domain.Transaction) map[int64]bool {
	out := make(map[int64]bool, len(txns))
	for _, t := range txns {
		out[t.ID] = true
	}
	return out
}

// listFiltered 用给定条件取列表（断言无错）。
func listFiltered(t *testing.T, store *Store, q TransactionQuery) []domain.Transaction {
	t.Helper()
	txns, _, err := store.ListTransactionsFiltered(q)
	if err != nil {
		t.Fatalf("ListTransactionsFiltered(%+v) 失败: %v", q, err)
	}
	return txns
}

// TestTransactionQueryKind 验证 kind 三支口径与前端 applyFilters 对齐：
//   - expense / income 是**分录命中**，退款交易同时命中两者；
//   - transfer 是整笔判定，不含 Equity（期初交易不命中）。
func TestTransactionQueryKind(t *testing.T) {
	conn := openReversalTestDB(t)
	f := seedTxnQueryFixture(t, conn)
	store := New(conn)

	cases := []struct {
		kind string
		want []string // 期望命中的 seed key
	}{
		{domain.KindExpense, []string{"breakfast", "refund"}},
		{domain.KindIncome, []string{"refund"}},
		{domain.KindTransfer, []string{"transfer"}},
	}
	for _, c := range cases {
		got := idsOf(listFiltered(t, store, TransactionQuery{LedgerID: f.ledgerID, Kind: c.kind}))
		if len(got) != len(c.want) {
			t.Fatalf("kind=%s 命中 %d 条，期望 %d 条（got=%v）", c.kind, len(got), len(c.want), got)
		}
		for _, key := range c.want {
			if !got[f.txnIDs[key]] {
				t.Fatalf("kind=%s 应命中 %s(id=%d)，实际 %v", c.kind, key, f.txnIDs[key], got)
			}
		}
	}

	// 退款交易必须同时进 expense 与 income（分录命中口径的直接后果）。
	expense := idsOf(listFiltered(t, store, TransactionQuery{LedgerID: f.ledgerID, Kind: domain.KindExpense}))
	income := idsOf(listFiltered(t, store, TransactionQuery{LedgerID: f.ledgerID, Kind: domain.KindIncome}))
	if !expense[f.txnIDs["refund"]] || !income[f.txnIDs["refund"]] {
		t.Fatalf("退款交易应同时命中 expense 与 income")
	}

	// 期初交易（含 Equity 分录）不得出现在 transfer 里。
	transfer := idsOf(listFiltered(t, store, TransactionQuery{LedgerID: f.ledgerID, Kind: domain.KindTransfer}))
	if transfer[f.txnIDs["opening"]] {
		t.Fatalf("期初交易（含 Equity）不应命中 transfer")
	}
}

// TestTransactionQueryFilters 验证时间窗 / 账户 / 标签 / 币种 / 软删隔离。
func TestTransactionQueryFilters(t *testing.T) {
	conn := openReversalTestDB(t)
	f := seedTxnQueryFixture(t, conn)
	store := New(conn)

	// 软删交易在任何筛选下都不可见。
	all := idsOf(listFiltered(t, store, TransactionQuery{LedgerID: f.ledgerID}))
	if all[f.txnIDs["deleted"]] {
		t.Fatalf("软删交易不应出现在列表里: %v", all)
	}
	if len(all) != 4 {
		t.Fatalf("未删交易应 4 条，实际 %d 条", len(all))
	}

	// 时间窗含端点。
	windowed := idsOf(listFiltered(t, store, TransactionQuery{
		LedgerID: f.ledgerID, From: "2026-01-02", To: "2026-01-03",
	}))
	if len(windowed) != 2 || !windowed[f.txnIDs["refund"]] || !windowed[f.txnIDs["transfer"]] {
		t.Fatalf("时间窗 [01-02, 01-03] 应含 refund+transfer，实际 %v", windowed)
	}

	// account 命中「该账户出现在任一分录」：期初 / 退款都含现金分录。
	byCash := idsOf(listFiltered(t, store, TransactionQuery{LedgerID: f.ledgerID, AccountID: f.cashID}))
	for _, key := range []string{"breakfast", "refund", "transfer", "opening"} {
		if !byCash[f.txnIDs[key]] {
			t.Fatalf("account=%d 应命中 %s，实际 %v", f.cashID, key, byCash)
		}
	}

	// category 与 account 同为 postings.account_id 命中。
	byFood := idsOf(listFiltered(t, store, TransactionQuery{LedgerID: f.ledgerID, CategoryID: f.foodID}))
	if len(byFood) != 2 || !byFood[f.txnIDs["breakfast"]] || !byFood[f.txnIDs["refund"]] {
		t.Fatalf("category=%d 应命中 breakfast+refund，实际 %v", f.foodID, byFood)
	}

	// tag 命中任一元素。
	byTag := idsOf(listFiltered(t, store, TransactionQuery{LedgerID: f.ledgerID, Tags: []string{"nope", "food"}}))
	if len(byTag) != 1 || !byTag[f.txnIDs["breakfast"]] {
		t.Fatalf("tag=food 应只命中 breakfast，实际 %v", byTag)
	}

	// currency 命中「存在该 commodity 的分录」（全部 CNY）。
	byCNY := listFiltered(t, store, TransactionQuery{LedgerID: f.ledgerID, Currency: "CNY"})
	if len(byCNY) != 4 {
		t.Fatalf("currency=CNY 应 4 条，实际 %d 条", len(byCNY))
	}
	if got := listFiltered(t, store, TransactionQuery{LedgerID: f.ledgerID, Currency: "USD"}); len(got) != 0 {
		t.Fatalf("currency=USD 应 0 条，实际 %d 条", len(got))
	}
}

// TestTransactionQueryKeyword 验证 q 五路匹配（备注 / 会员名 / 标签 / 账户全名 /
// 账户展示名）与 LIKE 通配符转义。
func TestTransactionQueryKeyword(t *testing.T) {
	conn := openReversalTestDB(t)
	f := seedTxnQueryFixture(t, conn)
	store := New(conn)

	cases := []struct {
		name    string
		keyword string
		wantKey string
	}{
		{"备注", "早餐", "breakfast"},
		{"会员名", "小美", "breakfast"},       // created_by=1 → users.display_name
		{"标签", "foo", "breakfast"},       // tags=["food"]
		{"账户全名", "ZetaToken", "opening"}, // 无任何交易引用该账户 → 见下方断言
		{"账户展示名", "餐饮", "breakfast"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := idsOf(listFiltered(t, store, TransactionQuery{LedgerID: f.ledgerID, Keyword: c.keyword}))
			if c.keyword == "ZetaToken" {
				// 该账户没有任何分录引用 → 不命中任何交易（账户名路只对分录账户生效）。
				if len(got) != 0 {
					t.Fatalf("q=%q 不应命中任何交易，实际 %v", c.keyword, got)
				}
				return
			}
			if !got[f.txnIDs[c.wantKey]] {
				t.Fatalf("q=%q 应命中 %s(id=%d)，实际 %v", c.keyword, c.wantKey, f.txnIDs[c.wantKey], got)
			}
		})
	}

	// 账户全名路的正向用例：给「转账」加一条 ZetaToken 分录后应被命中。
	if _, err := conn.Exec(
		`INSERT INTO postings(transaction_id, account_id, commodity, amount, position)
		 VALUES(?, 6, 'CNY', 0, 9)`, f.txnIDs["transfer"],
	); err != nil {
		t.Fatalf("补充分录失败: %v", err)
	}
	got := idsOf(listFiltered(t, store, TransactionQuery{LedgerID: f.ledgerID, Keyword: "zetatoken"}))
	if len(got) != 1 || !got[f.txnIDs["transfer"]] {
		t.Fatalf("q=zetatoken（小写）应命中 transfer，实际 %v", got)
	}

	// 转义生效：q=% 只匹配含字面 '%' 的行，不能匹配所有行。
	if rows := listFiltered(t, store, TransactionQuery{LedgerID: f.ledgerID, Keyword: "%"}); len(rows) != 0 {
		t.Fatalf("q=%% 应 0 条（转义生效），实际 %d 条", len(rows))
	}
	// 纯空白 = 无筛选（不是「匹配空」）。
	if rows := listFiltered(t, store, TransactionQuery{LedgerID: f.ledgerID, Keyword: "   "}); len(rows) != 4 {
		t.Fatalf("q=纯空白应视为无筛选（4 条），实际 %d 条", len(rows))
	}
}

// TestTransactionQueryKeysetPaging 验证 keyset 分页：
// 逐页拿完拼接后无重复、无遗漏；带 LIMIT 时 hasMore 与 next_cursor 语义正确。
func TestTransactionQueryKeysetPaging(t *testing.T) {
	conn := openReversalTestDB(t)
	f := seedTxnQueryFixture(t, conn)
	store := New(conn)

	full := listFiltered(t, store, TransactionQuery{LedgerID: f.ledgerID})
	if len(full) != 4 {
		t.Fatalf("全量应 4 条，实际 %d 条", len(full))
	}
	// 降序：2026-01-04 → 2026-01-01。
	wantOrder := []int64{f.txnIDs["opening"], f.txnIDs["transfer"], f.txnIDs["refund"], f.txnIDs["breakfast"]}
	for i, want := range wantOrder {
		if full[i].ID != want {
			t.Fatalf("第 %d 条应为 id=%d，实际 id=%d（排序必须 date DESC, id DESC）", i, want, full[i].ID)
		}
	}

	var collected []int64
	var cursor *TransactionCursor
	for page := 0; page < 10; page++ {
		txns, hasMore, err := store.ListTransactionsFiltered(TransactionQuery{
			LedgerID: f.ledgerID, Limit: 2, Cursor: cursor,
		})
		if err != nil {
			t.Fatalf("第 %d 页失败: %v", page, err)
		}
		for _, t := range txns {
			collected = append(collected, t.ID)
		}
		if !hasMore {
			break
		}
		last := txns[len(txns)-1]
		cursor = &TransactionCursor{Date: last.Date, ID: last.ID}
	}
	if len(collected) != len(wantOrder) {
		t.Fatalf("逐页拼接应 %d 条，实际 %d 条: %v", len(wantOrder), len(collected), collected)
	}
	for i, want := range wantOrder {
		if collected[i] != want {
			t.Fatalf("拼接第 %d 条应为 id=%d，实际 id=%d: %v", i, want, collected[i], collected)
		}
	}

	// 单页 limit 大于总数：hasMore=false，且不返回多余行。
	txns, hasMore, err := store.ListTransactionsFiltered(TransactionQuery{LedgerID: f.ledgerID, Limit: 50})
	if err != nil {
		t.Fatalf("单页查询失败: %v", err)
	}
	if len(txns) != 4 || hasMore {
		t.Fatalf("limit=50 应 4 条且 hasMore=false，实际 %d 条 hasMore=%v", len(txns), hasMore)
	}
}

// TestTransactionQueryKeysetSurvivesLateInsert 验证「翻页途中补记更晚日期」不会
// 让第二页重复返回第一页的行 —— offset 分页在这种场景会红，这正是用 keyset 的原因。
func TestTransactionQueryKeysetSurvivesLateInsert(t *testing.T) {
	conn := openReversalTestDB(t)
	f := seedTxnQueryFixture(t, conn)
	store := New(conn)

	page1, hasMore, err := store.ListTransactionsFiltered(TransactionQuery{LedgerID: f.ledgerID, Limit: 2})
	if err != nil {
		t.Fatalf("第一页失败: %v", err)
	}
	if !hasMore || len(page1) != 2 {
		t.Fatalf("第一页应 2 条且 hasMore=true，实际 %d 条 hasMore=%v", len(page1), hasMore)
	}
	seen := idsOf(page1)

	// 翻页途中补记一笔「更晚日期」的交易（比第一页所有行都晚）。
	insertQueryTxn(t, conn, queryTxnSeed{
		date: "2026-03-01", description: "迟到的补记", createdBy: 1,
		postings: []queryPosting{{f.cashID, "CNY", -7}, {f.foodID, "CNY", 7}},
	})

	last := page1[len(page1)-1]
	page2, _, err := store.ListTransactionsFiltered(TransactionQuery{
		LedgerID: f.ledgerID, Limit: 2,
		Cursor: &TransactionCursor{Date: last.Date, ID: last.ID},
	})
	if err != nil {
		t.Fatalf("第二页失败: %v", err)
	}
	for _, got := range page2 {
		if seen[got.ID] {
			t.Fatalf("第二页出现第一页已返回的 id=%d（offset 分页的典型重复行）", got.ID)
		}
	}
	if len(page2) != 2 {
		t.Fatalf("第二页应 2 条，实际 %d 条", len(page2))
	}
}

// TestCountMatchesFilteredList 验证 total 与列表口径一致：CountTransactionsFiltered
// 与 ListTransactionsFiltered 共用 transactionFilterWhere，任何组合筛选下都必须相等。
func TestCountMatchesFilteredList(t *testing.T) {
	conn := openReversalTestDB(t)
	f := seedTxnQueryFixture(t, conn)
	store := New(conn)

	queries := []TransactionQuery{
		{LedgerID: f.ledgerID},
		{LedgerID: f.ledgerID, Kind: domain.KindExpense},
		{LedgerID: f.ledgerID, Kind: domain.KindTransfer},
		{LedgerID: f.ledgerID, From: "2026-01-02", To: "2026-01-03"},
		{LedgerID: f.ledgerID, AccountID: f.cashID, Keyword: "退款"},
		{LedgerID: f.ledgerID, Tags: []string{"food"}, Currency: "CNY"},
	}
	for _, q := range queries {
		list := listFiltered(t, store, q)
		n, err := store.CountTransactionsFiltered(q)
		if err != nil {
			t.Fatalf("CountTransactionsFiltered(%+v) 失败: %v", q, err)
		}
		if n != len(list) {
			t.Fatalf("count=%d 与列表 %d 条不一致（q=%+v）", n, len(list), q)
		}
	}
}

// TestTransactionFilterWherePlaceholderBalance 断言 WHERE 片段的占位符数量与
// 参数数量始终一致 —— 这是动态拼接最容易出错的地方（少/多一个 arg 会让
// 整个查询报错或参数错位，且只在带该筛选时才暴露）。
func TestTransactionFilterWherePlaceholderBalance(t *testing.T) {
	queries := []TransactionQuery{
		{LedgerID: 1},
		{
			LedgerID: 1, From: "2026-01-01", To: "2026-12-31",
			Kind: domain.KindTransfer, AccountID: 1, CategoryID: 2,
			Member: "小美", Tags: []string{"a", "b", "c"}, Currency: "CNY",
			Keyword: "早餐",
		},
		{LedgerID: 1, Kind: domain.KindExpense, Tags: []string{"x"}, Keyword: "k"},
	}
	for _, q := range queries {
		where, args := transactionFilterWhere(q)
		if got, want := strings.Count(where, "?"), len(args); got != want {
			t.Fatalf("占位符 %d 个但参数 %d 个（q=%+v）\nSQL: %s", got, want, q, where)
		}
		// 用户输入不得出现在 SQL 文本里（只允许 '?' 占位符）。
		for _, forbidden := range []string{"小美", "早餐", "CNY", "a", "b"} {
			if forbidden != "" && strings.Contains(where, "'"+forbidden+"'") {
				t.Fatalf("SQL 片段里出现了用户输入 %q: %s", forbidden, where)
			}
		}
	}
}

// TestPostingAmountsFiltered 验证汇总取数：与列表共用同一 WHERE、软删隔离、
// 且金额以**原样十进制串**返回（不是 REAL / 不是 SUM 结果）。
func TestPostingAmountsFiltered(t *testing.T) {
	conn := openReversalTestDB(t)
	f := seedTxnQueryFixture(t, conn)
	store := New(conn)

	all, err := store.PostingAmountsFiltered(TransactionQuery{LedgerID: f.ledgerID})
	if err != nil {
		t.Fatalf("PostingAmountsFiltered 失败: %v", err)
	}
	// 4 笔未删交易的分录数：2 + 3 + 2 + 2 = 9（已删那笔的 2 条不得出现）。
	if len(all) != 9 {
		t.Fatalf("应有 9 条分录（软删交易的分录必须排除），实际 %d 条: %+v", len(all), all)
	}
	for _, p := range all {
		if p.Date == "2026-01-05" {
			t.Fatalf("软删交易的分录不得进入汇总: %+v", p)
		}
		if p.Commodity == "" || p.AccountType == "" || p.Amount == "" {
			t.Fatalf("分录取数缺字段: %+v", p)
		}
	}

	// 与列表 / COUNT 同源：kind=expense 只取 breakfast + refund 的分录（2 + 3 = 5）。
	expense, err := store.PostingAmountsFiltered(TransactionQuery{
		LedgerID: f.ledgerID, Kind: domain.KindExpense,
	})
	if err != nil {
		t.Fatalf("PostingAmountsFiltered(kind=expense) 失败: %v", err)
	}
	if len(expense) != 5 {
		t.Fatalf("kind=expense 应 5 条分录，实际 %d 条", len(expense))
	}

	// 小数金额必须原样返回：0.1 / 0.2 不能被 REAL 化成 0.1000000000000000055。
	insertQueryTxn(t, conn, queryTxnSeed{
		date: "2026-01-06", description: "精度", createdBy: 1,
		postings: []queryPosting{{f.cashID, "CNY", 0}, {f.foodID, "CNY", 0}},
	})
	if _, err := conn.Exec(
		`UPDATE postings SET amount=CAST(? AS NUMERIC) WHERE transaction_id=
		   (SELECT id FROM transactions WHERE date='2026-01-06') AND account_id=?`,
		"0.10", f.cashID,
	); err != nil {
		t.Fatalf("改写金额失败: %v", err)
	}
	rows, err := store.PostingAmountsFiltered(TransactionQuery{LedgerID: f.ledgerID, Keyword: "精度"})
	if err != nil {
		t.Fatalf("PostingAmountsFiltered(q=精度) 失败: %v", err)
	}
	found := false
	for _, p := range rows {
		if p.AccountType != domain.TypeAssets {
			continue
		}
		// amount 是 NUMERIC 亲和性，0.10 落库变 REAL；CAST(... AS TEXT) 取到的是
		// **最短往返十进制** "0.1"（不是 "0.10"）。作为**十进制串**它是精确的，
		// big.Rat 解析成 1/10 毫无误差 —— 错的是 SUM()，不是字符串。
		if p.Amount != "0.1" {
			t.Fatalf("金额应以最短往返十进制串返回（供 big.Rat 精确累加），实际 %q", p.Amount)
		}
		found = true
	}
	if !found {
		t.Fatalf("未取到精度用例的资金分录: %+v", rows)
	}
}
