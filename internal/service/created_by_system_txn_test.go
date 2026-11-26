package service

// 系统交易（冲正 / 校准 / 期初）的 created_by 回归。
//
// 背景：repository 的 txnInsert / insertTxnTx 原先没有 created_by 列，
// 于是期初 / 冲正 / 校准三类系统交易一律落 NULL。数据表现是「普通交易全有值、
// 冲正全 NULL」，且同一操作里一半有操作人一半没有（修改交易：新交易有、冲正没有）。
//
// 本文件锁两条互为边界的口径：
// 1. 由用户操作**直接触发**的系统交易（余额校准 + 它产生的冲正）必须记操作人；
// 2. 期初设置 / 重建（service 层根本没有 user 参数）保持 NULL ——
//    不许在 repo 内部从「当前会话」猜人，否则系统自动交易会被错记到
//    恰好点了按钮的人头上。

import (
	"database/sql"
	"testing"

	"familyledger/internal/repository"
)

// createdByOf 读某交易的 created_by；NULL 返回 0。
func createdByOf(t *testing.T, conn *sql.DB, txnUUID string) int64 {
	t.Helper()
	var cb sql.NullInt64
	if err := conn.QueryRow(
		`SELECT created_by FROM transactions WHERE uuid=?`, txnUUID,
	).Scan(&cb); err != nil {
		t.Fatalf("查交易 %s 的 created_by: %v", txnUUID, err)
	}
	if !cb.Valid {
		return 0
	}
	return cb.Int64
}

// TestBalanceCalibrationReversalRecordsOperator 校准产生的冲正必须带操作人。
//
// 修复前该冲正落 NULL；而同一次校准的新交易在 balance.go 里被单独 UPDATE
// 补写了 created_by（AC-3.6），形成「一次操作、一半有一半没有」。
func TestBalanceCalibrationReversalRecordsOperator(t *testing.T) {
	fx := newBalanceFixture(t)

	var operator int64
	if err := fx.conn.QueryRow(
		`SELECT owner_id FROM ledgers WHERE id=?`, fx.ledgerID,
	).Scan(&operator); err != nil {
		t.Fatalf("取账本 owner: %v", err)
	}

	if _, err := fx.svc.SetBalanceCalibration(fx.ledgerID, fx.cash.UUID, BalanceInput{
		AsOfDate: fx.d,
		Targets:  []BalanceTargetInput{{Commodity: "CNY", TargetBalance: "1000.00"}},
		UserID:   operator,
	}); err != nil {
		t.Fatalf("首次校准: %v", err)
	}
	second, err := fx.svc.SetBalanceCalibration(fx.ledgerID, fx.cash.UUID, BalanceInput{
		AsOfDate: fx.d,
		Targets:  []BalanceTargetInput{{Commodity: "CNY", TargetBalance: "1200.00"}},
		UserID:   operator,
	})
	if err != nil {
		t.Fatalf("二次校准: %v", err)
	}
	if second.ReversalUUID == "" {
		t.Fatal("二次校准应产生冲正交易")
	}

	// 新校准交易：既有行为，作为回归保护。
	if got := createdByOf(t, fx.conn, second.TransactionUUID); got != operator {
		t.Errorf("校准新交易 created_by 应为操作人 %d，实际 %d", operator, got)
	}
	// 冲正交易：本轮修复点。
	if got := createdByOf(t, fx.conn, second.ReversalUUID); got != operator {
		t.Errorf("校准冲正 created_by 应为操作人 %d，实际 %d（NULL 记为 0）", operator, got)
	}
}

// TestOpeningSystemTxnsKeepCreatedByNull 期初设置 / 重建的交易与冲正保持 NULL。
//
// 这两条路径的 service 方法（SetOpening / RebuildOpenings）没有 user 参数，
// 硬塞人需要改 handler→service→repo 三层签名，已决定单独立项；
// 在此之前「留 NULL」是事实，不能被 repo 层擅自填值。
func TestOpeningSystemTxnsKeepCreatedByNull(t *testing.T) {
	conn := openTestDB(t)
	svc := New(repository.New(conn))
	ledgerID := seedCommodityLedger(t, conn)

	cash, err := svc.CreateAccount(ledgerID, "Assets:Cash:CNY", "", "Assets", "", "CNY", "", "", "", "")
	if err != nil {
		t.Fatalf("建账户: %v", err)
	}

	// 设置 → 修改（产生期初冲正）。
	if _, err := svc.SetOpening(ledgerID, cash.UUID, OpeningInput{Amount: "100", Direction: "hold"}); err != nil {
		t.Fatalf("首次期初: %v", err)
	}
	if _, err := svc.SetOpening(ledgerID, cash.UUID, OpeningInput{Amount: "200", Direction: "hold"}); err != nil {
		t.Fatalf("改期初: %v", err)
	}
	// 期初重建：整体平移日期并重写全部有效期初。
	if _, err := svc.RebuildOpenings(ledgerID, "2026-01-01"); err != nil {
		t.Fatalf("重建期初: %v", err)
	}

	// 期初交易（opening_key 非空）及其冲正（reversal_of 指向期初交易）。
	var total, withCreator int
	if err := conn.QueryRow(
		`SELECT COUNT(*), COUNT(created_by) FROM transactions
		  WHERE ledger_id=?
		    AND (opening_key IS NOT NULL
		         OR reversal_of IN (
		              SELECT uuid FROM transactions WHERE ledger_id=? AND opening_key IS NOT NULL))`,
		ledgerID, ledgerID,
	).Scan(&total, &withCreator); err != nil {
		t.Fatalf("统计期初交易: %v", err)
	}
	if total == 0 {
		t.Fatal("应已产生期初交易，用例前提不成立")
	}
	if withCreator != 0 {
		t.Errorf("期初及其冲正的 created_by 应全为 NULL，实际 %d/%d 有值", withCreator, total)
	}
}
