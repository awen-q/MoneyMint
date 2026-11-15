package repository

import (
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"familyledger/internal/db"
	"familyledger/internal/domain"
)

// openReversalTestDB 打开一份临时库（含全部迁移），供冲正内核单测使用。
// 全程 t.TempDir()，不触碰 data/ledger.db。
func openReversalTestDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := db.Open(
		filepath.Join(t.TempDir(), "test.db"),
		filepath.Join("..", "..", "schema.sql"),
	)
	if err != nil {
		t.Fatalf("打开测试库: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// seedReversalFixture 建立用户 / 账本 / 两个账户的最小数据集，返回账本与账户 id。
func seedReversalFixture(t *testing.T, conn *sql.DB) (int64, int64, int64) {
	t.Helper()
	stmts := []string{
		`INSERT INTO users(id, username, password_hash, display_name)
		 VALUES(1,'reversal-u','x','U')`,
		`INSERT INTO ledgers(id, name, owner_id) VALUES(1,'冲正测试账本',1)`,
		`INSERT INTO accounts(id, ledger_id, uuid, name, type, open_date)
		 VALUES(1,1,'acc-cash','Assets:Cash','Assets','2026-01-01')`,
		`INSERT INTO accounts(id, ledger_id, uuid, name, type, open_date)
		 VALUES(2,1,'acc-equity','Equity:Opening-Balances','Equity','2026-01-01')`,
	}
	for _, q := range stmts {
		if _, err := conn.Exec(q); err != nil {
			t.Fatalf("插入测试数据失败: %v\nSQL: %s", err, q)
		}
	}
	return 1, 1, 2
}

// reversalTestPostings 是两条借贷平衡的分录快照。
func reversalTestPostings(acc1, acc2 int64) []OpeningPosting {
	return []OpeningPosting{
		{AccountID: acc1, Commodity: "CNY", Amount: "100.00", Position: 0},
		{AccountID: acc2, Commodity: "CNY", Amount: "-100.00", Position: 1},
	}
}

// insertOriginalTxn 在事务内写入原交易与分录，返回自增 id。
func insertOriginalTxn(t *testing.T, tx *sql.Tx, ledgerID int64, meta txnInsert, posts []OpeningPosting) int64 {
	t.Helper()
	id, err := insertTxnTx(tx, ledgerID, meta)
	if err != nil {
		t.Fatalf("写入原交易: %v", err)
	}
	if err := insertPostingsTx(tx, id, posts); err != nil {
		t.Fatalf("写入原分录: %v", err)
	}
	return id
}

// readPostingAmounts 按 position 读取分录金额（CAST 成文本后按 big.Rat 归一化）。
func readPostingAmounts(t *testing.T, tx *sql.Tx, txnID int64) []string {
	t.Helper()
	rows, err := tx.Query(
		`SELECT CAST(amount AS TEXT) FROM postings WHERE transaction_id=? ORDER BY position`, txnID)
	if err != nil {
		t.Fatalf("读取分录: %v", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		rat, err := parseDecimalRat(raw)
		if err != nil {
			t.Fatalf("分录金额非法 %q: %v", raw, err)
		}
		out = append(out, rat.FloatString(5))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// reversalFailingExecer 让 Exec 固定失败，用于校验错误上下文文案。
// markReversedTx 只调用 Exec，不会触发 Query / QueryRow。
type reversalFailingExecer struct{ err error }

func (f reversalFailingExecer) Exec(string, ...any) (sql.Result, error) { return nil, f.err }
func (f reversalFailingExecer) Query(string, ...any) (*sql.Rows, error)  { return nil, f.err }
func (f reversalFailingExecer) QueryRow(string, ...any) *sql.Row          { return nil }

// TestNegateReversalPostingsPrecision 定点十进制取负：高精度无浮点误差、精度兜底。
func TestNegateReversalPostingsPrecision(t *testing.T) {
	posts := []OpeningPosting{
		{AccountID: 1, Commodity: "CNY", Amount: "1234567890.12345", Position: 0},
		{AccountID: 2, Commodity: "CNY", Amount: "-0.001", Position: 1},
	}
	out, err := negateReversalPostings(posts, 5)
	if err != nil {
		t.Fatalf("取负: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("分录数错误: %d", len(out))
	}
	if out[0].Amount != "-1234567890.12345" || out[1].Amount != "0.00100" {
		t.Fatalf("定点取负结果错误: %q / %q", out[0].Amount, out[1].Amount)
	}
	if out[0].AccountID != 1 || out[0].Commodity != "CNY" || out[0].Position != 0 {
		t.Fatalf("非金额字段被破坏: %+v", out[0])
	}

	// precision<=0 按 2 位兜底，与 negateDecimal 同款。
	fallback, err := negateReversalPostings([]OpeningPosting{{Amount: "1.239"}}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if fallback[0].Amount != "-1.24" {
		t.Fatalf("默认精度应为 2 位，实际 %q", fallback[0].Amount)
	}
	if _, err := negateReversalPostings([]OpeningPosting{{Amount: "not-a-number"}}, 2); err == nil {
		t.Fatal("非法金额应返回错误")
	}
}

// TestInsertReversalTxnTxOpeningParity 期初路径：同日期、取负分录、reversal_of、
// tags / opening_* 溯源字段、描述模板与既有实现逐项一致。
func TestInsertReversalTxnTxOpeningParity(t *testing.T) {
	conn := openReversalTestDB(t)
	ledgerID, acc1, acc2 := seedReversalFixture(t, conn)
	tx, err := conn.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()

	posts := reversalTestPostings(acc1, acc2)
	const origUUID = "orig-opening-1"
	origID := insertOriginalTxn(t, tx, ledgerID, txnInsert{
		UUID: origUUID, Date: "2026-01-01", Description: openingTxnDescription,
		Tags: []string{"opening"}, OpeningAccountUUID: "acc-cash",
		OpeningVersion: 1, OpeningKey: "opening:acc-cash:1",
	}, posts)

	rec := OpeningRecord{
		ID: origID, UUID: origUUID, Date: "2026-01-01", Version: 1,
		Commodity: "CNY", Postings: posts,
	}
	src := openingReversalSource(rec, "acc-cash", openingReversalDesc, 2)
	revUUID, revID, err := insertReversalTxnTx(tx, ledgerID, src)
	if err != nil {
		t.Fatalf("生成期初冲正: %v", err)
	}
	if revUUID == "" || revID == 0 {
		t.Fatalf("应返回新 uuid 与自增 id，实际 %q / %d", revUUID, revID)
	}

	var date, flag, desc string
	var tags, revOf, openAcc, openKey, reversedBy sql.NullString
	var openVer sql.NullInt64
	if err := tx.QueryRow(
		`SELECT date, flag, description, tags, reversal_of,
		        opening_account_uuid, opening_version, opening_key, reversed_by
		 FROM transactions WHERE uuid=?`, revUUID,
	).Scan(&date, &flag, &desc, &tags, &revOf, &openAcc, &openVer, &openKey, &reversedBy); err != nil {
		t.Fatalf("读取冲正交易: %v", err)
	}
	if date != "2026-01-01" || flag != "*" || desc != "冲正: 期初余额" {
		t.Fatalf("交易头错误: date=%q flag=%q desc=%q", date, flag, desc)
	}
	if tags.String != `["opening","reversal"]` {
		t.Fatalf("Tags 应保持 [\"opening\",\"reversal\"]，实际 %q", tags.String)
	}
	if revOf.String != origUUID {
		t.Fatalf("reversal_of 应为 %s，实际 %q", origUUID, revOf.String)
	}
	if openAcc.String != "acc-cash" || openVer.Int64 != 1 {
		t.Fatalf("opening_* 溯源错误: account=%q version=%d", openAcc.String, openVer.Int64)
	}
	if openKey.Valid || reversedBy.Valid {
		t.Fatal("冲正交易不应带 opening_key / reversed_by")
	}

	amounts := readPostingAmounts(t, tx, revID)
	if len(amounts) != 2 || amounts[0] != "-100.00000" || amounts[1] != "100.00000" {
		t.Fatalf("分录取负错误: %v", amounts)
	}
}

// TestInsertReversalTxnTxPlainTransaction 普通交易冲正（S6 复用证明）：
// 不带期初专属字段，只生成 reversal_of 与取负分录。
func TestInsertReversalTxnTxPlainTransaction(t *testing.T) {
	conn := openReversalTestDB(t)
	ledgerID, acc1, acc2 := seedReversalFixture(t, conn)
	tx, err := conn.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()

	posts := reversalTestPostings(acc1, acc2)
	const origUUID = "orig-plain-1"
	origID := insertOriginalTxn(t, tx, ledgerID, txnInsert{
		UUID: origUUID, Date: "2026-02-01", Description: "早餐",
	}, posts)

	src := ReversalSource{
		ID: origID, UUID: origUUID, Date: "2026-02-01", Postings: posts,
		Description: "改账冲正", Precision: 2,
	}
	revUUID, revID, err := insertReversalTxnTx(tx, ledgerID, src)
	if err != nil {
		t.Fatalf("生成普通交易冲正: %v", err)
	}

	var desc string
	var tags, revOf, openAcc, openKey sql.NullString
	var openVer sql.NullInt64
	if err := tx.QueryRow(
		`SELECT description, tags, reversal_of,
		        opening_account_uuid, opening_version, opening_key
		 FROM transactions WHERE uuid=?`, revUUID,
	).Scan(&desc, &tags, &revOf, &openAcc, &openVer, &openKey); err != nil {
		t.Fatalf("读取冲正交易: %v", err)
	}
	if desc != "改账冲正" || revOf.String != origUUID {
		t.Fatalf("描述 / reversal_of 错误: %q / %q", desc, revOf.String)
	}
	if strings.Contains(tags.String, "opening") || openAcc.Valid || openKey.Valid {
		t.Fatalf("普通交易冲正不应带期初专属字段: tags=%q account=%v key=%v",
			tags.String, openAcc, openKey)
	}
	// insertTxnTx 的既有语义：未指定版本时 opening_version 写 0（代表「无版本」，非溯源值）。
	if openVer.Valid && openVer.Int64 != 0 {
		t.Fatalf("普通交易冲正不应带期初版本号，实际 %d", openVer.Int64)
	}
	amounts := readPostingAmounts(t, tx, revID)
	if len(amounts) != 2 || amounts[0] != "-100.00000" || amounts[1] != "100.00000" {
		t.Fatalf("分录取负错误: %v", amounts)
	}
}

// TestMarkReversedTxConcurrentConflict 并发保护：RowsAffected()==0 返回稳定码，
// 成功路径写 sync_log 与 updated_at，第二次标记不再追加 sync_log。
func TestMarkReversedTxConcurrentConflict(t *testing.T) {
	conn := openReversalTestDB(t)
	ledgerID, acc1, acc2 := seedReversalFixture(t, conn)
	tx, err := conn.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()

	origID := insertOriginalTxn(t, tx, ledgerID, txnInsert{
		UUID: "orig-mark-1", Date: "2026-01-01", Description: "期初余额",
	}, reversalTestPostings(acc1, acc2))

	in := ReversalMarkInput{
		LedgerID: ledgerID, SourceID: origID, ReversalUUID: "rev-mark-1",
		ExecErrorLabel: "标记旧期初已冲正", ConflictMessage: openingConflictMessage,
		AppendSyncLog: true,
	}
	if err := markReversedTx(tx, in); err != nil {
		t.Fatalf("首次标记: %v", err)
	}
	var marked, updatedAt sql.NullString
	if err := tx.QueryRow(
		`SELECT reversed_by, updated_at FROM transactions WHERE id=?`, origID,
	).Scan(&marked, &updatedAt); err != nil {
		t.Fatal(err)
	}
	if marked.String != "rev-mark-1" || !updatedAt.Valid || updatedAt.String == "" {
		t.Fatalf("应写入 reversed_by 与 updated_at，实际 %q / %q", marked.String, updatedAt.String)
	}
	var syncCount int
	if err := tx.QueryRow(
		`SELECT count(*) FROM sync_log WHERE ledger_id=? AND entity_uuid=? AND op=?`,
		ledgerID, "rev-mark-1", domain.OpCreate,
	).Scan(&syncCount); err != nil {
		t.Fatal(err)
	}
	if syncCount != 1 {
		t.Fatalf("成功标记应写 1 条 create 事件，实际 %d", syncCount)
	}

	err = markReversedTx(tx, in)
	var ce *domain.CodedError
	if !errors.As(err, &ce) {
		t.Fatalf("并发冲突应返回 CodedError，实际 %v", err)
	}
	if ce.Code != domain.CodeOpeningConflict || ce.Message != "期初已被并发修改，请重试" {
		t.Fatalf("稳定码 / 文案错误: %s / %s", ce.Code, ce.Message)
	}
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatal("并发冲突应保留 409 语义")
	}
	if err := tx.QueryRow(
		`SELECT count(*) FROM sync_log WHERE ledger_id=? AND entity_uuid=? AND op=?`,
		ledgerID, "rev-mark-1", domain.OpCreate,
	).Scan(&syncCount); err != nil {
		t.Fatal(err)
	}
	if syncCount != 1 {
		t.Fatalf("冲突路径不应追加 sync_log，实际 %d", syncCount)
	}
}

// TestMarkReversedTxNoSyncLogWhenDisabled 供 S4/S6 自行编排 sync_log 的顺序。
func TestMarkReversedTxNoSyncLogWhenDisabled(t *testing.T) {
	conn := openReversalTestDB(t)
	ledgerID, acc1, acc2 := seedReversalFixture(t, conn)
	tx, err := conn.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()

	origID := insertOriginalTxn(t, tx, ledgerID, txnInsert{
		UUID: "orig-nosync-1", Date: "2026-01-01", Description: "普通交易",
	}, reversalTestPostings(acc1, acc2))
	if err := markReversedTx(tx, ReversalMarkInput{
		LedgerID: ledgerID, SourceID: origID, ReversalUUID: "rev-nosync-1",
		ExecErrorLabel: "标记原交易已冲正", ConflictMessage: openingConflictMessage,
		AppendSyncLog: false,
	}); err != nil {
		t.Fatalf("标记: %v", err)
	}
	var n int
	if err := tx.QueryRow(
		`SELECT count(*) FROM sync_log WHERE ledger_id=? AND entity_uuid=?`,
		ledgerID, "rev-nosync-1",
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("AppendSyncLog=false 时不应写 sync_log，实际 %d", n)
	}
}

// TestMarkReversedTxExecErrorContext 保留各调用点原有的 SQL 失败上下文。
func TestMarkReversedTxExecErrorContext(t *testing.T) {
	cause := errors.New("模拟 SQL 失败")
	failing := reversalFailingExecer{err: cause}
	err := markReversedTx(failing, ReversalMarkInput{
		LedgerID: 1, SourceID: 1, ReversalUUID: "rev-err-1",
		ExecErrorLabel: "标记旧期初已冲正", ConflictMessage: openingConflictMessage,
		AppendSyncLog: true,
	})
	if err == nil {
		t.Fatal("Exec 失败应返回错误")
	}
	if !strings.HasPrefix(err.Error(), "标记旧期初已冲正: 模拟 SQL 失败") {
		t.Fatalf("错误上下文未保留: %v", err)
	}
	if !errors.Is(err, cause) {
		t.Fatal("应保留底层错误供排障")
	}
}
