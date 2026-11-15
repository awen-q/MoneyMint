package service

// 0.6.0 收尾修复（QA 二轮遗留两项，老板拍板并入 v0.6.0）回归测试：
//
//   - DEF-4：批次定位改为「manifest 有行 OR 交易有行」——幂等去重后零交易的
//     空批次同样可撤销，其新建价格与 manifest 行不再残留；真不存在的批次仍 404。
//   - 注册默认账本 default_commodity 落值 'CNY'：svc.Register（含预设 owner 路径，
//     两者同走此函数）建出的默认账本该列不再为 NULL，undo 的「默认币种兜底护栏」
//     有兜底对象；CreateLedger 不带 default_commodity 同样归一化为 'CNY'。
//
// 本文件只新增测试，不改任何产品代码。

import (
	"database/sql"
	"testing"

	"familyledger/internal/repository"
)

// TestUndoEmptyBatchWithPrices QA DEF-4 回归：文件 B 的交易全部幂等去重
// （零交易入批），但其新建价格已进 manifest——撤销 B 不再 404，价格按清单删、
// manifest 行清零、removed_transactions/postings 如实为 0；文件 A 批次撤销不受影响；
// 完全不存在的批次仍 404。
func TestUndoEmptyBatchWithPrices(t *testing.T) {
	conn := openTestDB(t)
	owner := insertUser(t, conn, "owner", false)
	ledgerID := insertLedger(t, conn, owner, "EmptyBatch")
	svc := New(repository.New(conn))

	const fileA = `option "title" "A"
2024-03-01 open Expenses:Food
2024-03-01 open Assets:Cash
2024-03-01 price USD 7.20 CNY
2024-03-02 * "支出"
  Expenses:Food -10 CNY
  Assets:Cash 10 CNY
`
	const fileB = `option "title" "B"
2024-03-01 open Expenses:Food
2024-03-01 open Assets:Cash
2024-03-01 price USD 7.25 CNY
2024-03-02 * "支出"
  Expenses:Food -10 CNY
  Assets:Cash 10 CNY
`
	resA, err := svc.ExecuteImport(ledgerID, owner, fileA, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("导入文件 A: %v", err)
	}
	if resA.CreatedTransactions != 1 || resA.NewPrices != 1 {
		t.Fatalf("文件 A 应建 1 笔交易 + 1 条价格，实际 txn=%d price=%d",
			resA.CreatedTransactions, resA.NewPrices)
	}
	resB, err := svc.ExecuteImport(ledgerID, owner, fileB, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("导入文件 B: %v", err)
	}
	if resB.SkippedTransactions != 1 || resB.CreatedTransactions != 0 {
		t.Fatalf("文件 B 交易应全部去重，实际 skip=%d create=%d",
			resB.SkippedTransactions, resB.CreatedTransactions)
	}
	if resB.NewPrices != 1 {
		t.Fatalf("文件 B 应新建 1 条价格（7.25），实际 %d", resB.NewPrices)
	}

	// 撤销空批次 B：不再 404。
	undoB, err := svc.UndoImportBatch(ledgerID, owner, resB.ImportBatchID)
	if err != nil {
		t.Fatalf("空批次撤销不应返回错误（QA DEF-4 回归失败）: %v", err)
	}
	if undoB.RemovedTransactions != 0 || undoB.RemovedPostings != 0 {
		t.Fatalf("空批次 removed_transactions/postings 应如实为 0，实际 txn=%d posting=%d",
			undoB.RemovedTransactions, undoB.RemovedPostings)
	}
	if undoB.RemovedPrices != 1 {
		t.Fatalf("应按 manifest 移除 1 条本批新建价格（7.25），实际 %d", undoB.RemovedPrices)
	}
	// 价格 7.25 已删、7.20（属批次 A）保留；B 的 manifest 行已清零。
	priceCount := func(rate string) int {
		t.Helper()
		var n int
		if err := conn.QueryRow(
			`SELECT count(*) FROM prices WHERE ledger_id=? AND rate=?`, ledgerID, rate,
		).Scan(&n); err != nil {
			t.Fatalf("查价格 %s: %v", rate, err)
		}
		return n
	}
	if got := priceCount("7.25"); got != 0 {
		t.Fatalf("价格 7.25 应已随批删，实际 %d 行", got)
	}
	if got := priceCount("7.20"); got != 1 {
		t.Fatalf("批次 A 的价格 7.20 应保留，实际 %d 行", got)
	}
	var manifestLeft int
	if err := conn.QueryRow(
		`SELECT count(*) FROM import_batch_entities WHERE ledger_id=? AND batch_id=?`,
		ledgerID, resB.ImportBatchID,
	).Scan(&manifestLeft); err != nil {
		t.Fatalf("查 B manifest: %v", err)
	}
	if manifestLeft != 0 {
		t.Fatalf("空批次撤销后 manifest 行应清零，实际 %d", manifestLeft)
	}
	// 文件 A 的交易不受空批次撤销影响（仍在）。
	var aTxns int
	if err := conn.QueryRow(
		`SELECT count(*) FROM transactions WHERE ledger_id=? AND import_batch_id=? AND deleted_at IS NULL`,
		ledgerID, resA.ImportBatchID,
	).Scan(&aTxns); err != nil {
		t.Fatalf("查 A 交易: %v", err)
	}
	if aTxns != 1 {
		t.Fatalf("批次 A 交易不应受批次 B 撤销影响，实际 %d 笔", aTxns)
	}

	// 撤销批次 A 正常（既有逻辑不变）：1 笔交易 + 1 条价格。
	undoA, err := svc.UndoImportBatch(ledgerID, owner, resA.ImportBatchID)
	if err != nil {
		t.Fatalf("撤销批次 A: %v", err)
	}
	if undoA.RemovedTransactions != 1 || undoA.RemovedPrices != 1 {
		t.Fatalf("批次 A 应移除 1 笔交易 + 1 条价格，实际 txn=%d price=%d",
			undoA.RemovedTransactions, undoA.RemovedPrices)
	}

	// 完全不存在的批次（无交易也无 manifest 行）仍 404。
	if _, err := svc.UndoImportBatch(ledgerID, owner, "imp-nonexistent"); err == nil {
		t.Fatalf("不存在批次撤销应返回 import_batch_not_found")
	}
}

// TestRegisterFirstLedgerDefaultCommodity QA 回归：首个注册用户（svc.Register，
// 预设 owner 路径 server.go 同走此函数）建出的默认账本 default_commodity='CNY'，
// 不再为 NULL——undo 的「默认币种兜底护栏」有兜底对象。
func TestRegisterFirstLedgerDefaultCommodity(t *testing.T) {
	conn := openTestDB(t)
	svc := New(repository.New(conn))

	if _, err := svc.Register("alice", "secret123", "Alice"); err != nil {
		t.Fatalf("注册首用户: %v", err)
	}
	var def sql.NullString
	if err := conn.QueryRow(
		`SELECT default_commodity FROM ledgers WHERE name='家庭账本'`,
	).Scan(&def); err != nil {
		t.Fatalf("查默认账本: %v", err)
	}
	if !def.Valid || def.String != "CNY" {
		t.Fatalf("注册默认账本 default_commodity 应为 'CNY'（QA 回归失败），实际 %v", def)
	}
	// 二号用户只建账号，不建账本（不产生第二个 NULL 账本）。
	if _, err := svc.Register("bob", "secret123", ""); err != nil {
		t.Fatalf("注册后续用户: %v", err)
	}
	var ledgers int
	if err := conn.QueryRow(`SELECT count(*) FROM ledgers`).Scan(&ledgers); err != nil {
		t.Fatalf("统计账本: %v", err)
	}
	if ledgers != 1 {
		t.Fatalf("后续注册不应新建账本，实际 %d 本", ledgers)
	}
}

// TestCreateLedgerDefaultsCommodity QA 回归：API 直调 CreateLedger 不带
// default_commodity（空串）时归一化为 'CNY'，不再产生 NULL 账本。
func TestCreateLedgerDefaultsCommodity(t *testing.T) {
	conn := openTestDB(t)
	owner := insertUser(t, conn, "owner", false)
	svc := New(repository.New(conn))

	// 先注册占掉首账本位（否则 CreateLedger 建的是首账本）。
	if _, err := svc.Register("seed", "secret123", ""); err != nil {
		t.Fatalf("预置首用户: %v", err)
	}

	view, err := svc.CreateLedger(owner, "直调账本", "")
	if err != nil {
		t.Fatalf("CreateLedger 不带默认币种: %v", err)
	}
	var def sql.NullString
	if err := conn.QueryRow(
		`SELECT default_commodity FROM ledgers WHERE id=?`, view.ID,
	).Scan(&def); err != nil {
		t.Fatalf("查账本: %v", err)
	}
	if !def.Valid || def.String != "CNY" {
		t.Fatalf("空 default_commodity 应归一化为 'CNY'（QA 回归失败），实际 %v", def)
	}
	if view.DefaultCommodity != "CNY" {
		t.Fatalf("返回视图的 DefaultCommodity 应为归一化后的 'CNY'，实际 %q", view.DefaultCommodity)
	}

	// 显式传入的值不被覆盖。
	view2, err := svc.CreateLedger(owner, "USD 账本", "USD")
	if err != nil {
		t.Fatalf("CreateLedger 显式 USD: %v", err)
	}
	var def2 string
	if err := conn.QueryRow(
		`SELECT default_commodity FROM ledgers WHERE id=?`, view2.ID,
	).Scan(&def2); err != nil {
		t.Fatalf("查账本 2: %v", err)
	}
	if def2 != "USD" {
		t.Fatalf("显式 default_commodity 应原样落库，实际 %q", def2)
	}
}
