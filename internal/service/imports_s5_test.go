package service

// 0.6.0 S5 导入到当前账本（T11+T12）的服务层回归：
//
//   - target=current：同名账户复用（AC-6.3）、类型/币种限制冲突拦截（AC-6.3）、
//     逐笔借贷平衡校验（AC-6.5）、确定性幂等去重（AC-6.4）、批次撤销（AC-6.9）；
//   - target=new：pad 指令展开为补平交易（D-11），不再整体拒绝；
//   - 批次撤销后剩余账本再导出并过严格 bean-check（环境有 bean-check 时）。
//
// 本文件只新增测试，不改任何产品代码。

import (
	"database/sql"
	"encoding/json"
	"testing"

	"familyledger/internal/export"
	"familyledger/internal/repository"
)

// seedAccount 直接写入一个账户（仅测试用），返回 id。
func seedAccount(t *testing.T, conn *sql.DB, ledgerID int64, uuid, name, typ, openDate string) int64 {
	t.Helper()
	res, err := conn.Exec(
		`INSERT INTO accounts(ledger_id, uuid, name, type, open_date) VALUES(?, ?, ?, ?, ?)`,
		ledgerID, uuid, name, typ, openDate)
	if err != nil {
		t.Fatalf("预置账户 %s: %v", name, err)
	}
	id, _ := res.LastInsertId()
	return id
}

// seedCommodity 直接写入一个币种（仅测试用）。
func seedCommodity(t *testing.T, conn *sql.DB, ledgerID int64, uuid, symbol string, precision int) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO commodities(ledger_id, uuid, symbol, name, precision) VALUES(?, ?, ?, ?, ?)`,
		ledgerID, uuid, symbol, symbol, precision); err != nil {
		t.Fatalf("预置币种 %s: %v", symbol, err)
	}
}

// seedPreExistingTxn 给预置账户写一笔平衡的既有交易（Assets:Cash +100 / Equity:Opening-Balances -100），
// 保证撤销后复用账户仍有分录引用（AC-6.9：撤销绝不误删复用实体）。
func seedPreExistingTxn(t *testing.T, conn *sql.DB, ledgerID, owner, cashAcctID int64) {
	t.Helper()
	equityID := seedAccount(t, conn, ledgerID, "u-equity", "Equity:Opening-Balances", "Equity", "2024-01-01")
	tags, _ := json.Marshal([]string{})
	res, err := conn.Exec(
		`INSERT INTO transactions(ledger_id, uuid, date, flag, description, tags, created_by)
		 VALUES(?, 'u-pre-txn','2024-02-01','*','既有存入',?, ?)`, ledgerID, string(tags), owner)
	if err != nil {
		t.Fatalf("预置交易: %v", err)
	}
	txnID, _ := res.LastInsertId()
	for i, p := range [][3]any{
		{cashAcctID, "CNY", "100"},
		{equityID, "CNY", "-100"},
	} {
		if _, err := conn.Exec(
			`INSERT INTO postings(transaction_id, account_id, commodity, amount, position) VALUES(?, ?, ?, ?, ?)`,
			txnID, p[0], p[1], p[2], i); err != nil {
			t.Fatalf("预置分录: %v", err)
		}
	}
}

// ledgerTxnCount 统计账本内未删除交易数。
func ledgerTxnCount(t *testing.T, conn *sql.DB, ledgerID int64) int {
	t.Helper()
	var n int
	if err := conn.QueryRow(
		`SELECT count(*) FROM transactions WHERE ledger_id=? AND deleted_at IS NULL`, ledgerID).Scan(&n); err != nil {
		t.Fatalf("统计交易: %v", err)
	}
	return n
}

// TestImportCurrentReusesAccounts AC-6.3：target=current 复用既有同名账户，
// 类型 / 币种限制匹配时预检有效、执行不新建重复账户。
func TestImportCurrentReusesAccounts(t *testing.T) {
	conn := openTestDB(t)
	owner := insertUser(t, conn, "owner", false)
	ledgerID := insertLedger(t, conn, owner, "ReuseLedger")
	svc := New(repository.New(conn))
	seedAccount(t, conn, ledgerID, "u-cash", "Assets:Cash", "Assets", "2024-01-01")

	const text = `option "title" "导入"
2024-01-01 open Assets:Cash
2024-01-01 open Expenses:Food
2024-01-01 open Income:Salary
2024-02-01 * "工资"
  Assets:Cash 5000 CNY
  Income:Salary -5000 CNY
`
	prev, err := svc.PreviewImport(ledgerID, owner, text, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("PreviewImport: %v", err)
	}
	if !prev.Valid {
		t.Fatalf("匹配账户应预检有效: %+v", prev.Conflicts)
	}
	if prev.ReuseAccounts != 1 {
		t.Fatalf("应复用 1 个账户（Assets:Cash），实际 %d", prev.ReuseAccounts)
	}
	if prev.NewAccounts != 2 {
		t.Fatalf("应新建 2 个账户，实际 %d", prev.NewAccounts)
	}

	res, err := svc.ExecuteImport(ledgerID, owner, text, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("ExecuteImport: %v", err)
	}
	if res.Mode != repository.ImportTargetCurrent {
		t.Fatalf("模式应为 current，实际 %q", res.Mode)
	}
	if res.ReusedAccounts != 1 || res.NewAccounts != 2 {
		t.Fatalf("执行应复用 1 新建 2，实际 reuse=%d new=%d", res.ReusedAccounts, res.NewAccounts)
	}
	if res.CreatedTransactions != 1 {
		t.Fatalf("应建 1 笔交易，实际 %d", res.CreatedTransactions)
	}
	if res.ImportBatchID == "" {
		t.Fatalf("应分配 import_batch_id（AC-6.6）")
	}
	// 账户总数 = 既有 1 + 新建 2 = 3：当前账本不重复建账户。
	assertLedgerCounts(t, conn, ledgerID, 3, 1, 2)
}

// TestImportCurrentAccountTypeConflict AC-6.3：同名账户类型不一致 → 预检
// account_conflict，整体拒绝（import_account_conflict）。
func TestImportCurrentAccountTypeConflict(t *testing.T) {
	conn := openTestDB(t)
	owner := insertUser(t, conn, "owner", false)
	ledgerID := insertLedger(t, conn, owner, "L")
	svc := New(repository.New(conn))
	seedAccount(t, conn, ledgerID, "u-cash", "Assets:Cash", "Liabilities", "2024-01-01")

	const text = `2024-01-01 open Assets:Cash
`
	prev, err := svc.PreviewImport(ledgerID, owner, text, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("PreviewImport: %v", err)
	}
	if prev.Valid {
		t.Fatalf("类型冲突应无效")
	}
	found := false
	for _, c := range prev.Conflicts {
		if c.Type == "account_conflict" && c.Name == "Assets:Cash" {
			found = true
		}
	}
	if !found {
		t.Fatalf("应含 Assets:Cash 的 account_conflict，实际 %+v", prev.Conflicts)
	}
	if prev.Code != "import_account_conflict" {
		t.Fatalf("code 应为 import_account_conflict，实际 %q", prev.Code)
	}
	// 执行同样拒绝。
	if _, err := svc.ExecuteImport(ledgerID, owner, text, repository.ImportTargetCurrent); err == nil {
		t.Fatalf("类型冲突执行应报错")
	}
}

// TestImportCurrentCommodityPrecisionConflict AC-6.3：币种精度不一致 → 预检
// commodity_conflict，整体拒绝。
func TestImportCurrentCommodityPrecisionConflict(t *testing.T) {
	conn := openTestDB(t)
	owner := insertUser(t, conn, "owner", false)
	ledgerID := insertLedger(t, conn, owner, "L")
	svc := New(repository.New(conn))
	seedCommodity(t, conn, ledgerID, "u-cny", "CNY", 2)

	const text = `2024-01-01 commodity CNY
  precision: 4
`
	prev, err := svc.PreviewImport(ledgerID, owner, text, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("PreviewImport: %v", err)
	}
	if prev.Valid {
		t.Fatalf("精度冲突应无效")
	}
	found := false
	for _, c := range prev.Conflicts {
		if c.Type == "commodity_conflict" && c.Name == "CNY" {
			found = true
		}
	}
	if !found {
		t.Fatalf("应含 CNY 的 commodity_conflict，实际 %+v", prev.Conflicts)
	}
}

// TestImportCurrentUnbalanced AC-6.5：逐笔逐币种借贷平衡校验，不平交易整体拒绝。
func TestImportCurrentUnbalanced(t *testing.T) {
	conn := openTestDB(t)
	owner := insertUser(t, conn, "owner", false)
	ledgerID := insertLedger(t, conn, owner, "L")
	svc := New(repository.New(conn))

	const text = `2024-01-01 open Assets:Cash
2024-01-01 open Expenses:Food
2024-02-01 * "不平"
  Assets:Cash 100 CNY
  Expenses:Food -50 CNY
`
	prev, err := svc.PreviewImport(ledgerID, owner, text, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("PreviewImport: %v", err)
	}
	if prev.Valid {
		t.Fatalf("借贷不平应无效")
	}
	found := false
	for _, c := range prev.Conflicts {
		if c.Type == "unbalanced" {
			found = true
		}
	}
	if !found {
		t.Fatalf("应含 unbalanced 冲突，实际 %+v", prev.Conflicts)
	}
	if _, err := svc.ExecuteImport(ledgerID, owner, text, repository.ImportTargetCurrent); err == nil {
		t.Fatalf("不平交易执行应报错")
	}
	// 拒绝后不得留下任何数据（单一大事务，AC-6.10）。
	assertLedgerCounts(t, conn, ledgerID, 0, 0, 0)
}

// TestImportCurrentIdempotentDedup AC-6.4：确定性 client_request_id 幂等去重，
// 重复导入同一份文本全部跳过（修复 inserted bug：绝不拿 txnID=0 写分录）。
func TestImportCurrentIdempotentDedup(t *testing.T) {
	conn := openTestDB(t)
	owner := insertUser(t, conn, "owner", false)
	ledgerID := insertLedger(t, conn, owner, "L")
	svc := New(repository.New(conn))

	const text = `option "title" "导入"
2024-01-01 open Assets:Cash
2024-01-01 open Expenses:Food
2024-02-01 * "支出"
  Assets:Cash 100 CNY
  Expenses:Food -100 CNY
`
	r1, err := svc.ExecuteImport(ledgerID, owner, text, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("首次导入: %v", err)
	}
	if r1.CreatedTransactions != 1 {
		t.Fatalf("首次应建 1 笔，实际 %d", r1.CreatedTransactions)
	}
	before := ledgerTxnCount(t, conn, ledgerID)

	r2, err := svc.ExecuteImport(ledgerID, owner, text, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("重复导入: %v", err)
	}
	if r2.SkippedTransactions != 1 || r2.CreatedTransactions != 0 {
		t.Fatalf("重复导入应跳过 1、新建 0，实际 skip=%d create=%d", r2.SkippedTransactions, r2.CreatedTransactions)
	}
	after := ledgerTxnCount(t, conn, ledgerID)
	if before != after {
		t.Fatalf("重复导入后交易数应不变: before=%d after=%d", before, after)
	}
	// 分录数也不变（无 txnID=0 的孤儿分录）。
	assertLedgerCounts(t, conn, ledgerID, 2, 1, 2)
}

// TestImportCurrentUndo AC-6.9：撤销只回滚本批（交易 + 新建账户 + 孤儿价格/币种），
// 复用的既有账户及其既有交易原样保留；撤销后剩余账本可再导出并通过严格 bean-check。
func TestImportCurrentUndo(t *testing.T) {
	conn := openTestDB(t)
	owner := insertUser(t, conn, "owner", false)
	ledgerID := insertLedger(t, conn, owner, "UndoLedger")
	svc := New(repository.New(conn))

	cashID := seedAccount(t, conn, ledgerID, "u-cash", "Assets:Cash", "Assets", "2024-01-01")
	seedPreExistingTxn(t, conn, ledgerID, owner, cashID)
	seedCommodity(t, conn, ledgerID, "u-cny", "CNY", 2)

	const text = `option "title" "导入"
2024-03-01 open Assets:Cash
2024-03-01 open Expenses:Food
2024-03-01 price USD 7.2 CNY
2024-03-02 * "导入支出"
  Assets:Cash 80 CNY
  Expenses:Food -80 CNY
`
	res, err := svc.ExecuteImport(ledgerID, owner, text, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("ExecuteImport: %v", err)
	}
	if res.ImportBatchID == "" {
		t.Fatalf("应分配 import_batch_id")
	}
	if res.ReusedAccounts != 1 || res.NewAccounts != 1 {
		t.Fatalf("应复用 1 新建 1，实际 reuse=%d new=%d", res.ReusedAccounts, res.NewAccounts)
	}
	// 撤销前：账户 3（Cash + Equity + Food），交易 2（既有 + 导入），分录 4。
	assertLedgerCounts(t, conn, ledgerID, 3, 2, 4)

	undo, err := svc.UndoImportBatch(ledgerID, owner, res.ImportBatchID)
	if err != nil {
		t.Fatalf("UndoImportBatch: %v", err)
	}
	if undo.RemovedTransactions != 1 {
		t.Fatalf("应移除 1 笔导入交易，实际 %d", undo.RemovedTransactions)
	}
	if undo.RemovedPostings != 2 {
		t.Fatalf("应移除 2 条分录，实际 %d", undo.RemovedPostings)
	}
	if undo.RemovedAccounts != 1 {
		t.Fatalf("应移除 1 个新建账户（Expenses:Food），实际 %d", undo.RemovedAccounts)
	}
	if undo.RemovedPrices != 1 {
		t.Fatalf("应移除 1 条孤儿价格（USD），实际 %d", undo.RemovedPrices)
	}
	// 撤销后：账户回到 2（复用的 Cash + 既有 Equity），交易回到 1，分录回到 2。
	assertLedgerCounts(t, conn, ledgerID, 2, 1, 2)

	// 复用的 Assets:Cash 必须保留；新建的 Expenses:Food 必须已删。
	for name, want := range map[string]int{"Assets:Cash": 1, "Expenses:Food": 0} {
		var n int
		if err := conn.QueryRow(
			`SELECT count(*) FROM accounts WHERE ledger_id=? AND name=?`, ledgerID, name).Scan(&n); err != nil {
			t.Fatalf("查账户 %s: %v", name, err)
		}
		if n != want {
			t.Fatalf("撤销后 %s 数量应为 %d，实际 %d", name, want, n)
		}
	}
	// 既有的 CNY 币种保留（仍被分录引用），孤儿 USD 币种一并删除。
	var usdCnt int
	if err := conn.QueryRow(
		`SELECT count(*) FROM commodities WHERE ledger_id=? AND symbol='USD'`, ledgerID).Scan(&usdCnt); err != nil {
		t.Fatalf("查 USD: %v", err)
	}
	if usdCnt != 0 {
		t.Fatalf("撤销后孤儿 USD 币种应已删除，实际 %d", usdCnt)
	}

	// 撤销后剩余账本可再导出并过严格 bean-check（环境有 bean-check 时）。
	outText, err := export.ExportLedger(conn, ledgerID)
	if err != nil {
		t.Fatalf("撤销后再导出: %v", err)
	}
	if cmd := beanCheckCmd(t, writeTemp(t, "undo-*.beancount", outText)); cmd != nil {
		if out, berr := cmd.CombinedOutput(); berr != nil {
			t.Fatalf("撤销后 bean-check 失败: %v\n%s", berr, string(out))
		}
	} else {
		t.Logf("环境未安装 bean-check，跳过撤销后校验")
	}
}

// TestImportUndoBatchNotFound AC-6.9：撤销不存在的批次返回 404（import_batch_not_found）。
func TestImportUndoBatchNotFound(t *testing.T) {
	conn := openTestDB(t)
	owner := insertUser(t, conn, "owner", false)
	ledgerID := insertLedger(t, conn, owner, "L")
	svc := New(repository.New(conn))

	if _, err := svc.UndoImportBatch(ledgerID, owner, "imp-nonexistent"); err == nil {
		t.Fatalf("撤销不存在批次应返回错误")
	}
	if _, err := svc.UndoImportBatch(ledgerID, owner, ""); err == nil {
		t.Fatalf("空 batch_id 应返回错误")
	}
}

// TestImportNewPadExpands D-11：target=new 的 pad 指令展开为补平交易（不再整体拒绝），
// 补平后账户余额归零。
func TestImportNewPadExpands(t *testing.T) {
	conn := openTestDB(t)
	owner := insertUser(t, conn, "owner", false)
	ledgerID := insertLedger(t, conn, owner, "L")
	svc := New(repository.New(conn))

	const text = `option "title" "PadNew"
2024-01-01 open Assets:Cash
2024-01-01 open Equity:Opening-Balances
2024-01-15 * "存入"
  Assets:Cash 500 CNY
  Equity:Opening-Balances -500 CNY
2024-03-01 pad Assets:Cash Equity:Opening
`
	prev, err := svc.PreviewImport(ledgerID, owner, text, repository.ImportTargetNew)
	if err != nil {
		t.Fatalf("PreviewImport: %v", err)
	}
	if !prev.Valid {
		t.Fatalf("new 模式含 pad 应有效: %+v", prev.Conflicts)
	}
	res, err := svc.ExecuteImport(ledgerID, owner, text, repository.ImportTargetNew)
	if err != nil {
		t.Fatalf("ExecuteImport: %v", err)
	}
	// 1 笔正常交易 + 1 笔 pad 补平交易。
	if res.CreatedTransactions != 2 {
		t.Fatalf("new+pad 应建 2 笔交易（存入 + 补平），实际 %d", res.CreatedTransactions)
	}
	assertLedgerCounts(t, conn, res.LedgerID, 2, 2, 4)
	// 补平后 Assets:Cash 余额为 0（500 + (-500)）。
	var cashID int64
	if err := conn.QueryRow(
		`SELECT id FROM accounts WHERE ledger_id=? AND name='Assets:Cash'`, res.LedgerID).Scan(&cashID); err != nil {
		t.Fatalf("查 Cash: %v", err)
	}
	var bal string
	if err := conn.QueryRow(
		`SELECT CAST(COALESCE(SUM(CAST(p.amount AS NUMERIC)),0) AS TEXT) FROM postings p
		 JOIN transactions t ON t.id=p.transaction_id
		 WHERE p.account_id=? AND t.deleted_at IS NULL`, cashID).Scan(&bal); err != nil {
		t.Fatalf("查余额: %v", err)
	}
	if bal != "0" {
		t.Fatalf("pad 补平后 Assets:Cash 余额应为 0，实际 %s", bal)
	}
}
