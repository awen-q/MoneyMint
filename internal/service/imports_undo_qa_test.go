package service

// QA 第一轮回归缺陷修复验证（DEF-1/DEF-2/DEF-3，迁移 016 manifest 方案）：
//
//   - DEF-1【高危】undo 越界硬删：撤销改为按 import_batch_entities 清单精确删，
//     既有种子账户 / 默认币种绝不误删，被后续批次复用的账户保留；
//   - DEF-2【中】价格重复插行 + undo 永不清理：价格幂等（命中跳过）+ manifest 删；
//   - DEF-3【低】软删币种并发恢复竞态：输掉竞态回落 409 commodity_exists，无 404。
//
// 本文件只新增测试与测试辅助，不改任何产品代码。

import (
	"database/sql"
	"errors"
	"sync"
	"testing"

	"familyledger/internal/domain"
	"familyledger/internal/repository"
)

// seedLedgerWithDefault 建一个带默认币种的账本 + owner 成员（仅测试用）。
func seedLedgerWithDefault(t *testing.T, conn *sql.DB, owner int64, name, defaultCommodity string) int64 {
	t.Helper()
	res, err := conn.Exec(
		`INSERT INTO ledgers(name, owner_id, default_commodity) VALUES(?, ?, ?)`,
		name, owner, defaultCommodity)
	if err != nil {
		t.Fatalf("建账本: %v", err)
	}
	id, _ := res.LastInsertId()
	if _, err := conn.Exec(
		`INSERT INTO ledger_members(ledger_id, user_id, role, invited_by) VALUES(?, ?, 'owner', ?)`,
		id, owner, owner); err != nil {
		t.Fatalf("建账本成员: %v", err)
	}
	return id
}

// syncLogDeleteCount 统计某实体 uuid 的 sync_log op=delete 行数（QA DEF-1 断言用）。
func syncLogDeleteCount(t *testing.T, conn *sql.DB, entityUUID string) int {
	t.Helper()
	var n int
	if err := conn.QueryRow(
		`SELECT count(*) FROM sync_log WHERE entity_uuid=? AND op='delete'`, entityUUID,
	).Scan(&n); err != nil {
		t.Fatalf("统计 sync_log delete: %v", err)
	}
	return n
}

// TestUndoKeepsSeedEntities QA DEF-1 回归：种子账户（无分录）与默认币种在撤销时
// 原样保留——撤销只删本批新建实体，绝不全账本扫描误删；既有实体不写 sync_log
// op=delete（不向其他端扩散删除事件）。
func TestUndoKeepsSeedEntities(t *testing.T) {
	conn := openTestDB(t)
	owner := insertUser(t, conn, "owner", false)
	// 带默认币种 CNY 的账本（QA 复现场景：无期初余额）。
	ledgerID := seedLedgerWithDefault(t, conn, owner, "SeedLedger", "CNY")
	svc := New(repository.New(conn))

	// 预置「种子账户」若干，全部无分录（正是旧孤儿扫描会误删的形态），
	// 另预置默认币种 CNY。
	seedUUIDs := []string{}
	for _, name := range []string{"Assets:Bank", "Assets:Wallet", "Liabilities:Card", "Expenses:Daily"} {
		u := "seed-" + name
		seedUUIDs = append(seedUUIDs, u)
		seedAccount(t, conn, ledgerID, u, name, "Assets", "2024-01-01")
	}
	seedCommodity(t, conn, ledgerID, "seed-CNY", "CNY", 2)

	const text = `option "title" "导入"
2024-03-01 open Assets:Bank
2024-03-01 open Expenses:Food
2024-03-01 price USD 7.2 CNY
2024-03-02 * "导入支出"
  Assets:Bank 80 CNY
  Expenses:Food -80 CNY
`
	res, err := svc.ExecuteImport(ledgerID, owner, text, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("ExecuteImport: %v", err)
	}

	undo, err := svc.UndoImportBatch(ledgerID, owner, res.ImportBatchID)
	if err != nil {
		t.Fatalf("UndoImportBatch: %v", err)
	}
	// 只删本批新建：1 个账户（Expenses:Food）+ 0 个既有币种（USD 由价格 ensure
	// 新建并随批删，见 removed 计数之外的币种断言）。
	if undo.RemovedAccounts != 1 {
		t.Fatalf("只应移除 1 个本批新建账户（Expenses:Food），实际 %d", undo.RemovedAccounts)
	}
	if undo.RemovedTransactions != 1 || undo.RemovedPostings != 2 {
		t.Fatalf("应移除 1 笔交易 2 条分录，实际 txn=%d posting=%d",
			undo.RemovedTransactions, undo.RemovedPostings)
	}
	// 币种只删本批新建的 USD（随价格建）；既有 CNY（含默认币种兜底）不删。
	if undo.RemovedCommodities != 1 {
		t.Fatalf("应只移除本批新建币种 USD（1 个），实际 %d", undo.RemovedCommodities)
	}

	// 种子账户全部原样保留。
	for _, u := range seedUUIDs {
		var n int
		if err := conn.QueryRow(
			`SELECT count(*) FROM accounts WHERE ledger_id=? AND uuid=?`, ledgerID, u,
		).Scan(&n); err != nil {
			t.Fatalf("查种子账户 %s: %v", u, err)
		}
		if n != 1 {
			t.Fatalf("种子账户 %s 被误删（QA DEF-1 回归失败）", u)
		}
		// 且不写 sync_log op=delete（删除事件不得扩散到其他端）。
		if c := syncLogDeleteCount(t, conn, u); c != 0 {
			t.Fatalf("种子账户 %s 出现 %d 条 sync_log op=delete（应恒为 0）", u, c)
		}
	}
	// 默认币种 CNY 保留 + 无 delete 事件。
	var cny int
	if err := conn.QueryRow(
		`SELECT count(*) FROM commodities WHERE ledger_id=? AND symbol='CNY'`, ledgerID,
	).Scan(&cny); err != nil {
		t.Fatalf("查 CNY: %v", err)
	}
	if cny != 1 {
		t.Fatalf("默认币种 CNY 被误删（QA DEF-1 回归失败）")
	}
	if c := syncLogDeleteCount(t, conn, "seed-CNY"); c != 0 {
		t.Fatalf("默认币种出现 sync_log op=delete（应恒为 0）")
	}
	// 本批新建的 Expenses:Food 已删；USD 币种随价格一并删（均为本批新建）。
	var food int
	if err := conn.QueryRow(
		`SELECT count(*) FROM accounts WHERE ledger_id=? AND name='Expenses:Food'`, ledgerID,
	).Scan(&food); err != nil {
		t.Fatalf("查 Food: %v", err)
	}
	if food != 0 {
		t.Fatalf("本批新建账户 Expenses:Food 应已删")
	}
	var usd int
	if err := conn.QueryRow(
		`SELECT count(*) FROM commodities WHERE ledger_id=? AND symbol='USD'`, ledgerID,
	).Scan(&usd); err != nil {
		t.Fatalf("查 USD: %v", err)
	}
	if usd != 0 {
		t.Fatalf("本批新建币种 USD 应已随批删")
	}
}

// TestUndoKeepsAccountReusedByLaterBatch QA DEF-1 回归：本批新建的账户被后续批次
// 按 name 复用后，撤销前批时该账户必须保留、复用方的交易不受影响。
func TestUndoKeepsAccountReusedByLaterBatch(t *testing.T) {
	conn := openTestDB(t)
	owner := insertUser(t, conn, "owner", false)
	ledgerID := insertLedger(t, conn, owner, "ReuseUndo")
	svc := New(repository.New(conn))

	const batchA = `option "title" "A"
2024-03-01 open Expenses:Food
2024-03-01 open Assets:Cash
2024-03-02 * "A 支出"
  Expenses:Food -30 CNY
  Assets:Cash 30 CNY
`
	const batchB = `option "title" "B"
2024-03-03 open Expenses:Food
2024-03-03 open Assets:Cash
2024-03-04 * "B 支出"
  Expenses:Food -50 CNY
  Assets:Cash 50 CNY
`
	resA, err := svc.ExecuteImport(ledgerID, owner, batchA, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("批次 A 导入: %v", err)
	}
	resB, err := svc.ExecuteImport(ledgerID, owner, batchB, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("批次 B 导入: %v", err)
	}
	if resB.ReusedAccounts != 2 {
		t.Fatalf("批次 B 应复用 Expenses:Food 与 Assets:Cash，实际 reuse=%d", resB.ReusedAccounts)
	}

	// 撤销前批 A：其新建账户 Expenses:Food 已被 B 复用 → 保留（removed_accounts=0）。
	undoA, err := svc.UndoImportBatch(ledgerID, owner, resA.ImportBatchID)
	if err != nil {
		t.Fatalf("撤销批次 A: %v", err)
	}
	if undoA.RemovedAccounts != 0 {
		t.Fatalf("被复用的账户应保留，removed_accounts 应为 0，实际 %d", undoA.RemovedAccounts)
	}
	if undoA.RemovedTransactions != 1 {
		t.Fatalf("批次 A 应移除自己的 1 笔交易，实际 %d", undoA.RemovedTransactions)
	}

	// Expenses:Food 仍在；批次 B 的交易完好（1 笔、分录 2 条）；批次 A 的交易已删。
	var food int
	if err := conn.QueryRow(
		`SELECT count(*) FROM accounts WHERE ledger_id=? AND name='Expenses:Food'`, ledgerID,
	).Scan(&food); err != nil {
		t.Fatalf("查 Food: %v", err)
	}
	if food != 1 {
		t.Fatalf("被复用的 Expenses:Food 应保留，实际 %d 个", food)
	}
	var bTxns int
	if err := conn.QueryRow(
		`SELECT count(*) FROM transactions WHERE ledger_id=? AND import_batch_id=? AND deleted_at IS NULL`,
		ledgerID, resB.ImportBatchID,
	).Scan(&bTxns); err != nil {
		t.Fatalf("查批次 B 交易: %v", err)
	}
	if bTxns != 1 {
		t.Fatalf("批次 B 交易不应受批次 A 撤销影响，实际 %d 笔", bTxns)
	}
	var foodPostings int
	if err := conn.QueryRow(
		`SELECT count(*) FROM postings p
		 JOIN transactions t ON t.id=p.transaction_id
		 JOIN accounts a ON a.id=p.account_id
		 WHERE t.ledger_id=? AND a.name='Expenses:Food' AND t.import_batch_id=?`,
		ledgerID, resB.ImportBatchID,
	).Scan(&foodPostings); err != nil {
		t.Fatalf("查复用方分录: %v", err)
	}
	if foodPostings != 1 {
		t.Fatalf("复用方在 Expenses:Food 上的分录应完好（1 条），实际 %d", foodPostings)
	}
}

// TestPriceImportIdempotentAndUndoCounts QA DEF-2 回归：同一文件重复导入 3 次
// prices 行数不变；undo 后 removed_prices 等于该批实际新建数。
func TestPriceImportIdempotentAndUndoCounts(t *testing.T) {
	conn := openTestDB(t)
	owner := insertUser(t, conn, "owner", false)
	ledgerID := insertLedger(t, conn, owner, "PriceIdem")
	svc := New(repository.New(conn))

	const text = `option "title" "价格幂等"
2024-03-01 open Expenses:Food
2024-03-01 open Assets:Cash
2024-03-01 price USD 7.2 CNY
2024-03-01 price EUR 7.8 CNY
2024-03-02 * "支出"
  Expenses:Food -10 CNY
  Assets:Cash 10 CNY
`
	priceRows := func() int {
		t.Helper()
		var n int
		if err := conn.QueryRow(
			`SELECT count(*) FROM prices WHERE ledger_id=?`, ledgerID).Scan(&n); err != nil {
			t.Fatalf("统计价格: %v", err)
		}
		return n
	}

	r1, err := svc.ExecuteImport(ledgerID, owner, text, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("首次导入: %v", err)
	}
	if r1.NewPrices != 2 {
		t.Fatalf("首次导入应新建 2 条价格，实际 %d", r1.NewPrices)
	}
	if got := priceRows(); got != 2 {
		t.Fatalf("首次导入后价格应为 2 行，实际 %d", got)
	}

	r2, err := svc.ExecuteImport(ledgerID, owner, text, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("第二次导入: %v", err)
	}
	r3, err := svc.ExecuteImport(ledgerID, owner, text, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("第三次导入: %v", err)
	}
	if r2.NewPrices != 0 || r3.NewPrices != 0 {
		t.Fatalf("重复导入不应再插价格行，实际 r2=%d r3=%d", r2.NewPrices, r3.NewPrices)
	}
	if got := priceRows(); got != 2 {
		t.Fatalf("重复导入 3 次后价格应仍为 2 行（QA DEF-2 回归），实际 %d", got)
	}

	// 撤销第一批：removed_prices = 该批实建数（2）；第二/三批无新建价格，撤销为 0。
	undo1, err := svc.UndoImportBatch(ledgerID, owner, r1.ImportBatchID)
	if err != nil {
		t.Fatalf("撤销第一批: %v", err)
	}
	if undo1.RemovedPrices != 2 {
		t.Fatalf("removed_prices 应等于本批实建数 2，实际 %d", undo1.RemovedPrices)
	}
	if got := priceRows(); got != 0 {
		t.Fatalf("撤销第一批后价格应清零，实际 %d", got)
	}
	for _, r := range []*ImportResult{r2, r3} {
		// 后续批次全部命中幂等去重（0 笔交易入批）：批次身份锚定在
		// transactions.import_batch_id 上，无交易的批次撤销返回 404——既有语义，
		// 保持不变（其 manifest 价格行也为空，无可删实体）。
		if _, err := svc.UndoImportBatch(ledgerID, owner, r.ImportBatchID); err == nil {
			t.Fatalf("无交易批次的撤销应返回 import_batch_not_found")
		}
	}
}

// TestRestoreCommodityRaceReturnsConflict QA DEF-3 回归：8 线程并发恢复同一软删
// 币种——恰 1 个成功（201 语义），其余全部 409 commodity_exists，绝无裸 404。
func TestRestoreCommodityRaceReturnsConflict(t *testing.T) {
	conn := openTestDB(t)
	owner := insertUser(t, conn, "owner", false)
	ledgerID := insertLedger(t, conn, owner, "RaceLedger")
	svc := New(repository.New(conn))

	// 先建后软删，制造「恢复」入口。
	if _, err := svc.CreateCommodity(ledgerID, "GOLD", "黄金", 2); err != nil {
		t.Fatalf("预置币种: %v", err)
	}
	byUUID, err := svc.repo.CommoditySymbolExists(ledgerID, "GOLD")
	if err != nil {
		t.Fatalf("查 uuid: %v", err)
	}
	deleted, err := svc.repo.SoftDeleteCommodity(ledgerID, byUUID)
	if err != nil || !deleted {
		t.Fatalf("预置软删: deleted=%v err=%v", deleted, err)
	}

	const workers = 8
	type outcome struct {
		ok   bool
		code string // CodedError 的 code；非 CodedError 记 "<raw>"
		err  error
	}
	results := make([]outcome, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			_, err := svc.CreateCommodity(ledgerID, "GOLD", "黄金并发", 2)
			if err == nil {
				results[idx] = outcome{ok: true}
				return
			}
			var ce *domain.CodedError
			if errors.As(err, &ce) {
				results[idx] = outcome{code: ce.Code}
			} else {
				results[idx] = outcome{code: "<raw>", err: err}
			}
		}(i)
	}
	wg.Wait()

	success, conflict, raw404 := 0, 0, 0
	for _, r := range results {
		switch {
		case r.ok:
			success++
		case r.code == domain.CodeCommodityExists:
			conflict++
		default:
			raw404++
			if r.err != nil {
				t.Logf("意外错误: %v", r.err)
			}
		}
	}
	if success != 1 {
		t.Fatalf("并发恢复应恰 1 个成功，实际 %d", success)
	}
	if conflict != workers-1 {
		t.Fatalf("其余应全部 409 commodity_exists，实际 %d（期望 %d）", conflict, workers-1)
	}
	if raw404 != 0 {
		t.Fatalf("并发恢复不得出现 404 / 裸错误（QA DEF-3 回归失败），实际 %d", raw404)
	}

	// 收尾：GOLD 恰 1 行且为活跃态（并发无数据损坏）。
	var active int
	if err := conn.QueryRow(
		`SELECT count(*) FROM commodities WHERE ledger_id=? AND symbol='GOLD' AND deleted_at IS NULL`,
		ledgerID,
	).Scan(&active); err != nil {
		t.Fatalf("查 GOLD: %v", err)
	}
	if active != 1 {
		t.Fatalf("并发后 GOLD 活跃行应恰 1 行，实际 %d", active)
	}
}
