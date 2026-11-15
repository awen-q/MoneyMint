package service

import (
	"database/sql"
	"errors"
	"testing"

	"familyledger/internal/domain"
	"familyledger/internal/repository"
)

// seedDeleteLedgerLedger 直接插入一个账本及其 owner 成员行（建账必插 owner，D-03）。
func seedDeleteLedgerLedger(t *testing.T, conn *sql.DB, ownerID int64, name string) int64 {
	t.Helper()
	res, err := conn.Exec(`INSERT INTO ledgers(name, owner_id) VALUES(?, ?)`, name, ownerID)
	if err != nil {
		t.Fatalf("插入账本 %s: %v", name, err)
	}
	id, _ := res.LastInsertId()
	if _, err := conn.Exec(
		`INSERT INTO ledger_members(ledger_id, user_id, role, invited_by) VALUES(?, ?, 'owner', ?)`,
		id, ownerID, ownerID,
	); err != nil {
		t.Fatalf("插入 owner 成员行: %v", err)
	}
	return id
}

func deleteLedgerDeletedAt(t *testing.T, conn *sql.DB, ledgerID int64) string {
	t.Helper()
	var v sql.NullString
	if err := conn.QueryRow(`SELECT deleted_at FROM ledgers WHERE id=?`, ledgerID).Scan(&v); err != nil {
		t.Fatalf("读取 deleted_at: %v", err)
	}
	return v.String
}

func newLedgerDeleteService(t *testing.T) (*Service, *sql.DB, *int) {
	t.Helper()
	conn := openTestDB(t)
	svc := New(repository.New(conn))
	calls := 0
	svc.ConfigureSnapshot(func(trigger string) error {
		if trigger != "pre-ledger-delete" {
			t.Fatalf("快照 trigger 期望 pre-ledger-delete，实际 %q", trigger)
		}
		calls++
		return nil
	})
	return svc, conn, &calls
}

// TestDeleteLedgerHasMembers AC-1.2：除 owner 外仍有成员 → 409 ledger_has_members，
// body 带 member_count 与仅用户名/显示名的 members，且快照与软删都不发生。
func TestDeleteLedgerHasMembers(t *testing.T) {
	svc, conn, calls := newLedgerDeleteService(t)
	owner := insertUser(t, conn, "owner", false)
	member := insertUser(t, conn, "bob", false)
	l1 := seedDeleteLedgerLedger(t, conn, owner, "装修")
	_ = seedDeleteLedgerLedger(t, conn, owner, "家庭日常")
	if _, err := conn.Exec(
		`INSERT INTO ledger_members(ledger_id, user_id, role, invited_by) VALUES(?, ?, 'editor', ?)`,
		l1, member, owner,
	); err != nil {
		t.Fatalf("插入 editor 成员: %v", err)
	}

	err := svc.DeleteLedger(owner, l1)
	var ce *domain.CodedError
	if !errors.As(err, &ce) {
		t.Fatalf("期望 CodedError，实际 %T: %v", err, err)
	}
	if ce.Code != domain.CodeLedgerHasMembers {
		t.Fatalf("错误码期望 %s，实际 %s", domain.CodeLedgerHasMembers, ce.Code)
	}
	if !errors.Is(ce, domain.ErrConflict) {
		t.Fatal("ledger_has_members 应保留 409 语义")
	}
	details, ok := ce.Details.(map[string]any)
	if !ok {
		t.Fatalf("Details 类型错误: %T", ce.Details)
	}
	if details["member_count"] != 1 {
		t.Fatalf("member_count 期望 1，实际 %v", details["member_count"])
	}
	refs, ok := details["members"].([]LedgerMemberRef)
	if !ok || len(refs) != 1 {
		t.Fatalf("members 明细错误: %#v", details["members"])
	}
	if refs[0].Username != "bob" || refs[0].DisplayName != "bob" {
		t.Fatalf("成员明细错误: %+v", refs[0])
	}
	if *calls != 0 {
		t.Fatalf("成员门禁失败不应生成快照，实际调用 %d 次", *calls)
	}
	if got := deleteLedgerDeletedAt(t, conn, l1); got != "" {
		t.Fatalf("账本不应被软删，deleted_at=%q", got)
	}
}

// TestDeleteLedgerLastLedger AC-1.6：最后一个有效账本禁止删除。
func TestDeleteLedgerLastLedger(t *testing.T) {
	svc, conn, calls := newLedgerDeleteService(t)
	owner := insertUser(t, conn, "owner", false)
	l1 := seedDeleteLedgerLedger(t, conn, owner, "唯一账本")

	err := svc.DeleteLedger(owner, l1)
	var ce *domain.CodedError
	if !errors.As(err, &ce) || ce.Code != domain.CodeLastLedger {
		t.Fatalf("期望 409 last_ledger，实际 %v", err)
	}
	if !errors.Is(ce, domain.ErrConflict) {
		t.Fatal("last_ledger 应保留 409 语义")
	}
	if *calls != 0 {
		t.Fatalf("最后账本门禁失败不应生成快照，实际调用 %d 次", *calls)
	}
	if got := deleteLedgerDeletedAt(t, conn, l1); got != "" {
		t.Fatalf("账本不应被软删，deleted_at=%q", got)
	}
}

// TestDeleteLedgerSnapshotFailureKeepsData AC-1.3：快照失败不动任何数据。
func TestDeleteLedgerSnapshotFailureKeepsData(t *testing.T) {
	conn := openTestDB(t)
	svc := New(repository.New(conn))
	svc.ConfigureSnapshot(func(trigger string) error {
		return errors.New("模拟备份失败")
	})
	owner := insertUser(t, conn, "owner", false)
	l1 := seedDeleteLedgerLedger(t, conn, owner, "装修")
	_ = seedDeleteLedgerLedger(t, conn, owner, "家庭日常")

	if err := svc.DeleteLedger(owner, l1); err == nil {
		t.Fatal("快照失败时应返回错误")
	}
	if got := deleteLedgerDeletedAt(t, conn, l1); got != "" {
		t.Fatalf("快照失败不应软删账本，deleted_at=%q", got)
	}
	ledgers, err := svc.ListLedgers(owner)
	if err != nil {
		t.Fatal(err)
	}
	if len(ledgers) != 2 {
		t.Fatalf("账本清单应保持 2 条，实际 %d", len(ledgers))
	}
}

// TestDeleteLedgerNoSnapshotConfigured 未注入快照实现时明确拒绝，不静默跳过。
func TestDeleteLedgerNoSnapshotConfigured(t *testing.T) {
	conn := openTestDB(t)
	svc := New(repository.New(conn))
	owner := insertUser(t, conn, "owner", false)
	l1 := seedDeleteLedgerLedger(t, conn, owner, "装修")
	_ = seedDeleteLedgerLedger(t, conn, owner, "家庭日常")

	if err := svc.DeleteLedger(owner, l1); err == nil {
		t.Fatal("未注入快照实现时应拒绝删除")
	}
	if got := deleteLedgerDeletedAt(t, conn, l1); got != "" {
		t.Fatalf("账本不应被软删，deleted_at=%q", got)
	}
}

// TestDeleteLedgerSoftDeleteAndQueryFilters AC-1.4 / AC-1.6：
// 成功软删后列表不再返回、RoleOf 为空、最小有效账本回退生效、重复删返回 ledger_deleted。
func TestDeleteLedgerSoftDeleteAndQueryFilters(t *testing.T) {
	svc, conn, calls := newLedgerDeleteService(t)
	owner := insertUser(t, conn, "owner", false)
	l1 := seedDeleteLedgerLedger(t, conn, owner, "装修")
	l2 := seedDeleteLedgerLedger(t, conn, owner, "家庭日常")

	if err := svc.DeleteLedger(owner, l1); err != nil {
		t.Fatalf("删除账本: %v", err)
	}
	if *calls != 1 {
		t.Fatalf("应生成 1 份 pre-ledger-delete 快照，实际 %d", *calls)
	}
	if got := deleteLedgerDeletedAt(t, conn, l1); got == "" {
		t.Fatal("账本应被软删（deleted_at 非空）")
	}

	deleted, err := svc.LedgerDeleted(l1)
	if err != nil || !deleted {
		t.Fatalf("LedgerDeleted 应为 true，实际 deleted=%v err=%v", deleted, err)
	}
	role, err := svc.LedgerRole(owner, l1)
	if err != nil {
		t.Fatal(err)
	}
	if role != "" {
		t.Fatalf("软删账本 RoleOf 应为空，实际 %q", role)
	}
	minID, err := svc.MinActiveLedgerID(owner)
	if err != nil || minID != l2 {
		t.Fatalf("最小有效账本应回退到 %d，实际 %d（err=%v）", l2, minID, err)
	}
	ledgers, err := svc.ListLedgers(owner)
	if err != nil {
		t.Fatal(err)
	}
	if len(ledgers) != 1 || ledgers[0].ID != l2 {
		t.Fatalf("列表应只剩账本 %d，实际 %+v", l2, ledgers)
	}

	err = svc.DeleteLedger(owner, l1)
	var ce *domain.CodedError
	if !errors.As(err, &ce) || ce.Code != domain.CodeLedgerDeleted {
		t.Fatalf("重复删除应返回 ledger_deleted，实际 %v", err)
	}
	if !errors.Is(ce, domain.ErrForbidden) {
		t.Fatal("ledger_deleted 应保留 403 语义")
	}
	if *calls != 1 {
		t.Fatalf("重复删除不应再生成快照，实际调用 %d 次", *calls)
	}
}

// TestDeleteLedgerRequiresOwner AC-1.5：非 owner 删除一律 403。
func TestDeleteLedgerRequiresOwner(t *testing.T) {
	svc, conn, calls := newLedgerDeleteService(t)
	owner := insertUser(t, conn, "owner", false)
	other := insertUser(t, conn, "other", false)
	l1 := seedDeleteLedgerLedger(t, conn, owner, "装修")
	_ = seedDeleteLedgerLedger(t, conn, owner, "家庭日常")

	if err := svc.DeleteLedger(other, l1); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("非 owner 删除应 403，实际 %v", err)
	}
	if *calls != 0 {
		t.Fatalf("越权删除不应生成快照，实际调用 %d 次", *calls)
	}
	if got := deleteLedgerDeletedAt(t, conn, l1); got != "" {
		t.Fatalf("账本不应被软删，deleted_at=%q", got)
	}
}

// TestListLedgersStats P1-03：行级统计（除 owner 外成员数 / 有效账户数 / 有效交易数）。
func TestListLedgersStats(t *testing.T) {
	conn := openTestDB(t)
	svc := New(repository.New(conn))
	owner := insertUser(t, conn, "owner", false)
	member := insertUser(t, conn, "bob", false)
	l1 := seedDeleteLedgerLedger(t, conn, owner, "装修")

	if _, err := conn.Exec(
		`INSERT INTO ledger_members(ledger_id, user_id, role, invited_by) VALUES(?, ?, 'viewer', ?)`,
		l1, member, owner,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO accounts(ledger_id, uuid, name, type, open_date)
		 VALUES(?, 'acc-1', 'Assets:Cash', 'Assets', '2026-01-01')`, l1,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO transactions(ledger_id, uuid, date, flag, description)
		 VALUES(?, 'txn-1', '2026-01-02', '*', '测试')`, l1,
	); err != nil {
		t.Fatal(err)
	}

	ledgers, err := svc.ListLedgers(owner)
	if err != nil {
		t.Fatal(err)
	}
	if len(ledgers) != 1 {
		t.Fatalf("应返回 1 个账本，实际 %d", len(ledgers))
	}
	if ledgers[0].MemberCount != 1 || ledgers[0].AccountCount != 1 || ledgers[0].TransactionCount != 1 {
		t.Fatalf("统计错误: member=%d account=%d txn=%d",
			ledgers[0].MemberCount, ledgers[0].AccountCount, ledgers[0].TransactionCount)
	}
	if ledgers[0].Role != domain.RoleOwner {
		t.Fatalf("role 应为 owner，实际 %q", ledgers[0].Role)
	}
}
