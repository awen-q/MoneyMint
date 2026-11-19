package service

// T60b：GET /api/transactions?with=summary 的分币种收支汇总。
//
// 口径逐字对齐前端 frontend/src/core/search.ts 的 summaryByCommodity
// （那里有一条与 bill.monthTotals 的交叉断言钉住同一套规则）：
//   - expense = Σ(Expenses 分录)，income = Σ(−Income 分录)，均对外为正，**不取 abs**；
//   - **归零粒度是「日期 × 币种」**：先按 (date, commodity) 分桶累加，逐桶把负数
//     净额归零，再按币种合并 —— 不是「按币种累加完再归零」；
//   - 金额固定两位定点串（Money.toString → toFixed(2)）；
//   - 币种字典序、不跨币种求和。
//
// 服务端分页之后前端无法自行汇总（只能拿到当前 20 条），所以这段必须留在服务端，
// 且 WHERE 必须与列表 / total 同源（repository.transactionFilterWhere）。

import (
	"testing"
)

// summaryEnv 是汇总测试环境：真实 SQLite + 已注册 owner + 默认账户名 → id。
type summaryEnv struct {
	t        *testing.T
	svc      *Service
	uid      int64
	accounts map[string]int64
}

// newSummaryEnv 构造环境，建立默认账户的 name → id 映射。
func newSummaryEnv(t *testing.T) *summaryEnv {
	t.Helper()
	svc := newTestService(t)
	owner := registerOwner(t, svc)
	e := &summaryEnv{t: t, svc: svc, uid: owner.User.ID, accounts: map[string]int64{}}
	accounts, err := svc.ListAccounts(lid, false)
	if err != nil {
		t.Fatalf("列出账户: %v", err)
	}
	for _, a := range accounts {
		e.accounts[a.Name] = a.ID
	}
	return e
}

// acc 按账户名取 id（种子账户清单变了就直接失败，避免测试静默跑在错账户上）。
func (e *summaryEnv) acc(name string) int64 {
	e.t.Helper()
	id, ok := e.accounts[name]
	if !ok || id == 0 {
		e.t.Fatalf("默认账户 %q 不存在", name)
	}
	return id
}

// post 构造一条分录载荷。
func post(accountID int64, amount, commodity string) PostingInput {
	return PostingInput{AccountID: accountID, Commodity: commodity, Amount: amount}
}

// txn 记一笔账（平衡由 CreateTransaction 自己校验，数据不平衡会直接失败）。
func (e *summaryEnv) txn(date, description string, postings ...PostingInput) {
	e.t.Helper()
	if _, err := e.svc.CreateTransaction(lid, date, "*", description, postings, e.uid); err != nil {
		e.t.Fatalf("记账 %q 失败: %v", description, err)
	}
}

// page 调 ListTransactionsPage（隐式带 with=summary）。
func (e *summaryEnv) page(q TransactionListQuery) TransactionListResult {
	e.t.Helper()
	q.WithSummary = true
	res, err := e.svc.ListTransactionsPage(lid, e.uid, q)
	if err != nil {
		e.t.Fatalf("ListTransactionsPage(%+v) 失败: %v", q, err)
	}
	if res.Summary == nil {
		e.t.Fatalf("with=summary 时 Summary 不应为 nil")
	}
	return res
}

// row 在汇总里按币种取行，取不到直接失败。
func row(t *testing.T, summary *TransactionSummary, commodity string) CommoditySummaryView {
	t.Helper()
	for _, r := range summary.ByCommodity {
		if r.Commodity == commodity {
			return r
		}
	}
	t.Fatalf("汇总里没有币种 %s: %+v", commodity, summary.ByCommodity)
	return CommoditySummaryView{}
}

// TestTransactionSummaryTotalMatchesFullList 覆盖必测 1：
// summary.total 必须等于「同条件不带 limit 的列表长度」——这是汇总与列表同源的可验证证据。
func TestTransactionSummaryTotalMatchesFullList(t *testing.T) {
	e := newSummaryEnv(t)
	cash := e.acc("Assets:Cash")
	food := e.acc("Expenses:Food")

	for i := 1; i <= 5; i++ {
		e.txn("2026-02-0"+string(rune('0'+i)), "第"+string(rune('0'+i))+"笔",
			post(food, "10.00", "CNY"), post(cash, "-10.00", "CNY"))
	}

	full := e.page(TransactionListQuery{})
	if len(full.Transactions) != 5 {
		t.Fatalf("全量列表应 5 条，实际 %d 条", len(full.Transactions))
	}
	if full.Summary.Total != len(full.Transactions) {
		t.Fatalf("summary.total(%d) 必须等于不带 limit 的列表长度(%d)",
			full.Summary.Total, len(full.Transactions))
	}

	// 带 limit 时：列表被截断，但 summary.total 仍是满足筛选条件的总笔数。
	paged := e.page(TransactionListQuery{Limit: 2})
	if len(paged.Transactions) != 2 {
		t.Fatalf("limit=2 应 2 条，实际 %d 条", len(paged.Transactions))
	}
	if paged.Summary.Total != 5 {
		t.Fatalf("limit=2 时 summary.total 仍应为 5（不是当前页条数），实际 %d", paged.Summary.Total)
	}
	if got := row(t, paged.Summary, "CNY"); got.Expense != "50.00" {
		t.Fatalf("汇总必须覆盖全部 5 条（expense 50.00），实际 %s —— 只统计当前页就是错的", got.Expense)
	}
}

// TestTransactionSummaryAbsentByDefault 覆盖必测 2（服务层半边）：
// 不请求汇总时 Summary 必须为 nil —— handler 据此不输出 summary 键，
// 7 处全量调用一个字都不能变。HTTP 层的 len(m)==1 断言在
// internal/server/txn_list_query_test.go 的 TestTxnListWithSummaryResponse。
func TestTransactionSummaryAbsentByDefault(t *testing.T) {
	e := newSummaryEnv(t)
	cash := e.acc("Assets:Cash")
	food := e.acc("Expenses:Food")
	e.txn("2026-03-01", "买菜", post(food, "12.00", "CNY"), post(cash, "-12.00", "CNY"))

	res, err := e.svc.ListTransactionsPage(lid, e.uid, TransactionListQuery{})
	if err != nil {
		t.Fatalf("ListTransactionsPage: %v", err)
	}
	if res.Summary != nil {
		t.Fatalf("未请求 with=summary 时 Summary 必须为 nil，实际 %+v", res.Summary)
	}
	if res.Total != 0 {
		t.Fatalf("未分页且未请求汇总时不应计算 total，实际 %d", res.Total)
	}

	// with=summary 时才出现。
	res, err = e.svc.ListTransactionsPage(lid, e.uid, TransactionListQuery{WithSummary: true})
	if err != nil {
		t.Fatalf("ListTransactionsPage(with summary): %v", err)
	}
	if res.Summary == nil || len(res.Summary.ByCommodity) != 1 {
		t.Fatalf("with=summary 应返回 1 行汇总，实际 %+v", res.Summary)
	}
}

// TestTransactionSummaryDecimalPrecision 覆盖必测 3：
// 0.10 + 0.20 必须正好是 "0.30"。用 SQL SUM() 会得到 0.30000000000000004，
// 这条用例就是用来钉住「禁止 SUM(amount)、必须 big.Rat 累加」的。
func TestTransactionSummaryDecimalPrecision(t *testing.T) {
	e := newSummaryEnv(t)
	cash := e.acc("Assets:Cash")
	food := e.acc("Expenses:Food")

	e.txn("2026-04-01", "一毛", post(food, "0.10", "CNY"), post(cash, "-0.10", "CNY"))
	e.txn("2026-04-02", "两毛", post(food, "0.20", "CNY"), post(cash, "-0.20", "CNY"))

	summary := e.page(TransactionListQuery{}).Summary
	got := row(t, summary, "CNY")
	if got.Expense != "0.30" {
		t.Fatalf("0.10 + 0.20 必须精确等于 0.30（big.Rat 累加），实际 %q", got.Expense)
	}
	if got.Income != "0.00" {
		t.Fatalf("无收入分录时 income 应为 0.00，实际 %q", got.Income)
	}

	// 三位小数录入：0.005 也应精确（两位输出按四舍五入）—— 0.30 + 0.005 = 0.305 → 0.31。
	e.txn("2026-04-03", "半分", post(food, "0.005", "CNY"), post(cash, "-0.005", "CNY"))
	got = row(t, e.page(TransactionListQuery{}).Summary, "CNY")
	if got.Expense != "0.31" {
		t.Fatalf("0.305 应按四舍五入输出 0.31，实际 %q", got.Expense)
	}
}

// TestTransactionSummaryAcrossCommodities 覆盖必测 4：
// 跨币种绝不合并 —— CNY 与 USD 各一行，不出现第三行、也不出现合计。
func TestTransactionSummaryAcrossCommodities(t *testing.T) {
	e := newSummaryEnv(t)
	cash := e.acc("Assets:Cash")
	food := e.acc("Expenses:Food")
	salary := e.acc("Income:Salary")

	e.txn("2026-05-01", "人民币支出",
		post(food, "100.00", "CNY"), post(cash, "-100.00", "CNY"))
	e.txn("2026-05-02", "美元支出",
		post(food, "50.00", "USD"), post(cash, "-50.00", "USD"))
	e.txn("2026-05-03", "美元收入",
		post(cash, "20.00", "USD"), post(salary, "-20.00", "USD"))

	summary := e.page(TransactionListQuery{}).Summary
	if len(summary.ByCommodity) != 2 {
		t.Fatalf("跨币种应恰好 2 行，实际 %d 行: %+v", len(summary.ByCommodity), summary.ByCommodity)
	}
	// 字典序：CNY < USD。
	if summary.ByCommodity[0].Commodity != "CNY" || summary.ByCommodity[1].Commodity != "USD" {
		t.Fatalf("by_commodity 必须按币种字典序排序，实际 %+v", summary.ByCommodity)
	}
	cny := row(t, summary, "CNY")
	if cny.Expense != "100.00" || cny.Income != "0.00" {
		t.Fatalf("CNY 汇总应为 expense=100.00 income=0.00，实际 %+v", cny)
	}
	usd := row(t, summary, "USD")
	if usd.Expense != "50.00" || usd.Income != "20.00" {
		t.Fatalf("USD 汇总应为 expense=50.00 income=20.00，实际 %+v", usd)
	}
	if summary.Total != 3 {
		t.Fatalf("total 应是笔数 3（不是金额），实际 %d", summary.Total)
	}
}

// TestTransactionSummaryNegativeNetClampedPerDay 覆盖必测 5：
// 负数净额的归零粒度是「日期 × 币种」，逐桶归零后再合并。
//
// 观察到的前端行为（core/search.ts summaryByCommodity，用例
// 「退款（负 Expenses）不产生负 expense」+「与 bill.monthTotals 同口径」）：
//   - 同日「支出 100 + 退款 30」→ 桶内净 70 → 展示 70.00（不是 100 + 0）；
//   - 纯退款日「支出 -50」→ 桶内净 -50 → **归零为 0**（不是 -50 也不是丢弃）；
//   - 最后按币种把「已归零的桶」相加。
//
// 本用例的期望值 70.00 恰好区分三种实现：
//   - 逐桶归零（正确）           → 70 + 0 = 70.00
//   - 按币种累加后归零（错误）    → max(100 - 30 - 50, 0) = 20.00
//   - 完全不归零（错误）          → 20.00 或负数
func TestTransactionSummaryNegativeNetClampedPerDay(t *testing.T) {
	e := newSummaryEnv(t)
	cash := e.acc("Assets:Cash")
	food := e.acc("Expenses:Food")
	salary := e.acc("Income:Salary")

	// 11-10：支出 100，同日退款 30 → 当日桶净 70。
	e.txn("2026-11-10", "支出100", post(food, "100.00", "CNY"), post(cash, "-100.00", "CNY"))
	e.txn("2026-11-10", "同日退款30", post(food, "-30.00", "CNY"), post(cash, "30.00", "CNY"))
	// 11-12：纯退款日 → 当日桶净 -50 → 归零。
	e.txn("2026-11-12", "纯退款50", post(food, "-50.00", "CNY"), post(cash, "50.00", "CNY"))
	// 11-13：收入侧异常（Income 分录为正）→ 当日收入桶净 -5 → 归零。
	e.txn("2026-11-13", "异常收入", post(cash, "-5.00", "CNY"), post(salary, "5.00", "CNY"))

	summary := e.page(TransactionListQuery{}).Summary
	cny := row(t, summary, "CNY")
	if cny.Expense != "70.00" {
		t.Fatalf("逐桶归零后 expense 应为 70.00（20.00 = 按币种累加后归零的错误实现），实际 %q", cny.Expense)
	}
	if cny.Income != "0.00" {
		t.Fatalf("负数净额收入应归零为 0.00，实际 %q", cny.Income)
	}
	if summary.Total != 4 {
		t.Fatalf("total 应为 4 笔，实际 %d", summary.Total)
	}
}

// TestTransactionSummaryRespectsFilters 覆盖必测 6：
// with=summary 与筛选组合时，汇总只统计命中的交易（与列表 / total 同源）。
func TestTransactionSummaryRespectsFilters(t *testing.T) {
	e := newSummaryEnv(t)
	cash := e.acc("Assets:Cash")
	alipay := e.acc("Assets:Alipay")
	food := e.acc("Expenses:Food")
	salary := e.acc("Income:Salary")

	e.txn("2026-06-01", "买菜", post(food, "10.00", "CNY"), post(cash, "-10.00", "CNY"))   // expense
	e.txn("2026-06-02", "工资", post(cash, "20.00", "CNY"), post(salary, "-20.00", "CNY"))  // income
	e.txn("2026-06-03", "美元转账", post(cash, "-7.00", "USD"), post(alipay, "7.00", "USD")) // transfer

	// 无筛选：USD 只出现在转账里 → 仍要有一行（金额全 0），与前端 counts 口径一致。
	all := e.page(TransactionListQuery{}).Summary
	if len(all.ByCommodity) != 2 {
		t.Fatalf("无筛选应 2 行（CNY / USD），实际 %+v", all.ByCommodity)
	}
	if usd := row(t, all, "USD"); usd.Expense != "0.00" || usd.Income != "0.00" {
		t.Fatalf("只有转账的币种应出现且金额全 0，实际 %+v", usd)
	}
	if all.Total != 3 {
		t.Fatalf("无筛选 total 应为 3，实际 %d", all.Total)
	}

	// kind=expense：只统计那一笔支出，USD（转账）整行消失。
	filtered := e.page(TransactionListQuery{Kind: "expense"}).Summary
	if filtered.Total != 1 {
		t.Fatalf("kind=expense 的 summary.total 应为 1，实际 %d", filtered.Total)
	}
	if len(filtered.ByCommodity) != 1 {
		t.Fatalf("kind=expense 应只剩 CNY 一行（USD 转账被筛掉），实际 %+v", filtered.ByCommodity)
	}
	cny := row(t, filtered, "CNY")
	if cny.Expense != "10.00" || cny.Income != "0.00" {
		t.Fatalf("kind=expense 汇总应只含支出 10.00，实际 %+v", cny)
	}

	// keyword 筛选同样下推到汇总（q=工资 只命中收入那笔）。
	byKeyword := e.page(TransactionListQuery{Keyword: "工资"}).Summary
	if byKeyword.Total != 1 {
		t.Fatalf("q=工资 的 summary.total 应为 1，实际 %d", byKeyword.Total)
	}
	if got := row(t, byKeyword, "CNY"); got.Income != "20.00" || got.Expense != "0.00" {
		t.Fatalf("q=工资 汇总应只含收入 20.00，实际 %+v", got)
	}
}
