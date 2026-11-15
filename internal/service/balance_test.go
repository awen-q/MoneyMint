package service

import (
	"database/sql"
	"errors"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"familyledger/internal/db"
	"familyledger/internal/domain"
	"familyledger/internal/export"
	"familyledger/internal/repository"

	"github.com/google/uuid"
)

// balanceFixture 是 S4 校准测试的最小账本：账本期初日期前移 30 天，
// 保证「D=今日、D-1=昨日」能通过下界校验，且不触碰 data/ledger.db。
type balanceFixture struct {
	svc      *Service
	conn     *sql.DB
	ledgerID int64
	cash     AccountCreated
	food     AccountCreated
	d        string
	dMinus1  string
	early    string
	today    string
}

func newBalanceFixture(t *testing.T) balanceFixture {
	t.Helper()
	conn := openTestDB(t)
	svc := New(repository.New(conn))
	ledgerID := seedCommodityLedger(t, conn)

	now := time.Now()
	early := now.AddDate(0, 0, -30).Format("2006-01-02")
	if _, err := conn.Exec(`UPDATE ledgers SET opening_date=? WHERE id=?`, early, ledgerID); err != nil {
		t.Fatalf("前移账本期初日期: %v", err)
	}
	cash, err := svc.CreateAccount(ledgerID, "Assets:Cash", "现金", "Assets", "", "CNY", "", "", "", "")
	if err != nil {
		t.Fatalf("建现金账户: %v", err)
	}
	food, err := svc.CreateAccount(ledgerID, "Expenses:Food", "餐饮", "Expenses", "", "CNY", "", "", "", "")
	if err != nil {
		t.Fatalf("建餐饮账户: %v", err)
	}
	return balanceFixture{
		svc: svc, conn: conn, ledgerID: ledgerID, cash: cash, food: food,
		d: now.Format("2006-01-02"),
		dMinus1: now.AddDate(0, 0, -1).Format("2006-01-02"),
		early: early, today: now.Format("2006-01-02"),
	}
}

func negateForTest(amount string) string {
	if strings.HasPrefix(amount, "-") {
		return strings.TrimPrefix(amount, "-")
	}
	return "-" + amount
}

// addTxn 直接写一笔借贷平衡的普通交易（目标账户 + 对手账户）。
func (fx balanceFixture) addTxn(t *testing.T, date, commodity, amount string) {
	t.Helper()
	res, err := fx.conn.Exec(
		`INSERT INTO transactions(ledger_id, uuid, date, flag, description)
		 VALUES(?, ?, ?, '*', '测试交易')`,
		fx.ledgerID, uuid.NewString(), date,
	)
	if err != nil {
		t.Fatalf("插入交易: %v", err)
	}
	txnID, _ := res.LastInsertId()
	if _, err := fx.conn.Exec(
		`INSERT INTO postings(transaction_id, account_id, commodity, amount, position)
		 VALUES(?, ?, ?, ?, 0), (?, ?, ?, ?, 1)`,
		txnID, fx.cash.ID, commodity, amount,
		txnID, fx.food.ID, commodity, negateForTest(amount),
	); err != nil {
		t.Fatalf("插入分录: %v", err)
	}
}

func amountOf(t *testing.T, items []BalanceAmountView, commodity string) string {
	t.Helper()
	for _, item := range items {
		if item.Commodity == commodity {
			return item.Amount
		}
	}
	return ""
}

func countRows(t *testing.T, conn *sql.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := conn.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("统计行数: %v", err)
	}
	return n
}

// TestBalanceAC31 AC-3.1：确认后「截至 D 日初」累计 == 目标值。
func TestBalanceAC31(t *testing.T) {
	fx := newBalanceFixture(t)
	fx.addTxn(t, fx.early, "CNY", "12000.00")

	preview, err := fx.svc.GetBalanceCalibration(fx.ledgerID, fx.cash.UUID, fx.d)
	if err != nil {
		t.Fatalf("预检: %v", err)
	}
	if got := amountOf(t, preview.Cumulative, "CNY"); got != "12000.00" {
		t.Fatalf("预检累计应为 12000.00，实际 %s", got)
	}
	if preview.Calibration.Exists {
		t.Fatal("首次预检不应有既有校准")
	}

	result, err := fx.svc.SetBalanceCalibration(fx.ledgerID, fx.cash.UUID, BalanceInput{
		AsOfDate: fx.d,
		Targets:  []BalanceTargetInput{{Commodity: "CNY", TargetBalance: "12350.00"}},
	})
	if err != nil {
		t.Fatalf("设置校准: %v", err)
	}
	if result.Status != "created" || result.Version != 1 || result.Date != fx.dMinus1 {
		t.Fatalf("结果错误: %+v", result)
	}
	if len(result.Entries) != 1 || result.Entries[0].Diff != "350.00" {
		t.Fatalf("补记差额应为 +350.00，实际 %+v", result.Entries)
	}

	after, err := fx.svc.GetBalanceCalibration(fx.ledgerID, fx.cash.UUID, fx.d)
	if err != nil {
		t.Fatal(err)
	}
	if got := amountOf(t, after.Cumulative, "CNY"); got != "12350.00" {
		t.Fatalf("校准后截至 D 日初累计应为 12350.00，实际 %s", got)
	}
	if !after.Calibration.Exists || after.Calibration.Version != 1 {
		t.Fatalf("既有校准信息错误: %+v", after.Calibration)
	}
}

// TestBalanceAC32 AC-3.2：D 当日交易不计入累计、不被改写；分录落 D-1；区间为空拒绝不静默前移。
func TestBalanceAC32(t *testing.T) {
	fx := newBalanceFixture(t)
	fx.addTxn(t, fx.early, "CNY", "12000.00")
	fx.addTxn(t, fx.d, "CNY", "-20.00") // D 当日

	preview, err := fx.svc.GetBalanceCalibration(fx.ledgerID, fx.cash.UUID, fx.d)
	if err != nil {
		t.Fatal(err)
	}
	if got := amountOf(t, preview.Cumulative, "CNY"); got != "12000.00" {
		t.Fatalf("D 当日 -20 不得计入日初累计，实际 %s", got)
	}

	result, err := fx.svc.SetBalanceCalibration(fx.ledgerID, fx.cash.UUID, BalanceInput{
		AsOfDate: fx.d,
		Targets:  []BalanceTargetInput{{Commodity: "CNY", TargetBalance: "12100.00"}},
	})
	if err != nil {
		t.Fatalf("设置校准: %v", err)
	}
	if result.Date != fx.dMinus1 {
		t.Fatalf("落账日应为 %s，实际 %s", fx.dMinus1, result.Date)
	}
	if result.Entries[0].Diff != "100.00" {
		t.Fatalf("差额应为 100.00，实际 %s", result.Entries[0].Diff)
	}
	var calibrationDate string
	if err := fx.conn.QueryRow(
		`SELECT date FROM transactions WHERE uuid=?`, result.TransactionUUID,
	).Scan(&calibrationDate); err != nil {
		t.Fatal(err)
	}
	if calibrationDate != fx.dMinus1 {
		t.Fatalf("校准交易落库日期错误: %s", calibrationDate)
	}
	var sameDayAmount string
	if err := fx.conn.QueryRow(
		`SELECT CAST(p.amount AS TEXT) FROM postings p
		 JOIN transactions t ON t.id=p.transaction_id
		 WHERE t.date=? AND p.account_id=?`, fx.d, fx.cash.ID,
	).Scan(&sameDayAmount); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(sameDayAmount, "-20") {
		t.Fatalf("D 当日交易被改写: %s", sameDayAmount)
	}

	// D 太早：D-1 < max(open_date, ledger_opening_date) → 明确拒绝、不静默前移、不落库。
	before := countRows(t, fx.conn, `SELECT count(*) FROM transactions WHERE ledger_id=?`, fx.ledgerID)
	_, err = fx.svc.SetBalanceCalibration(fx.ledgerID, fx.cash.UUID, BalanceInput{
		AsOfDate: fx.early,
		Targets:  []BalanceTargetInput{{Commodity: "CNY", TargetBalance: "12100.00"}},
	})
	var ce *domain.CodedError
	if !errors.As(err, &ce) || ce.Code != domain.CodeBalanceDateTooEarly {
		t.Fatalf("应返回 balance_date_too_early，实际 %v", err)
	}
	after := countRows(t, fx.conn, `SELECT count(*) FROM transactions WHERE ledger_id=?`, fx.ledgerID)
	if after != before {
		t.Fatalf("拒绝路径不得落库：%d → %d", before, after)
	}
}

// TestBalanceAC33 AC-3.3：多币种差额 + 各币种精度 + 任一失败整事务回滚。
func TestBalanceAC33(t *testing.T) {
	fx := newBalanceFixture(t)
	if _, err := fx.conn.Exec(
		`INSERT INTO commodities(ledger_id, uuid, symbol, name, precision)
		 VALUES(?, 'cmd-usd', 'USD', '美元', 3)`, fx.ledgerID,
	); err != nil {
		t.Fatal(err)
	}
	fx.addTxn(t, fx.early, "CNY", "12000.00")
	fx.addTxn(t, fx.early, "USD", "5.000")

	result, err := fx.svc.SetBalanceCalibration(fx.ledgerID, fx.cash.UUID, BalanceInput{
		AsOfDate: fx.d,
		Targets: []BalanceTargetInput{
			{Commodity: "CNY", TargetBalance: "12350.00"},
			{Commodity: "USD", TargetBalance: "6.500"},
		},
	})
	if err != nil {
		t.Fatalf("多币种校准: %v", err)
	}
	if len(result.Entries) != 2 {
		t.Fatalf("应按币种生成 2 条差额，实际 %+v", result.Entries)
	}
	diffs := map[string]string{}
	for _, e := range result.Entries {
		diffs[e.Commodity] = e.Diff
	}
	if diffs["CNY"] != "350.00" || diffs["USD"] != "1.500" {
		t.Fatalf("按币种精度差额错误: %v", diffs)
	}

	// 每笔校准交易按币种借贷平衡（账户差额 + 权益对手取负），big.Rat 定点求和。
	prows, err := fx.conn.Query(
		`SELECT p.commodity, CAST(p.amount AS TEXT) FROM postings p
		 JOIN transactions t ON t.id=p.transaction_id WHERE t.uuid=?`, result.TransactionUUID)
	if err != nil {
		t.Fatal(err)
	}
	sums := map[string]*big.Rat{}
	for prows.Next() {
		var commodity, amount string
		if err := prows.Scan(&commodity, &amount); err != nil {
			prows.Close()
			t.Fatal(err)
		}
		r, ok := new(big.Rat).SetString(amount)
		if !ok {
			prows.Close()
			t.Fatalf("金额非法 %q", amount)
		}
		if sums[commodity] == nil {
			sums[commodity] = new(big.Rat)
		}
		sums[commodity].Add(sums[commodity], r)
	}
	if err := prows.Err(); err != nil {
		prows.Close()
		t.Fatal(err)
	}
	prows.Close()
	for commodity, sum := range sums {
		if sum.Sign() != 0 {
			t.Fatalf("币种 %s 分录未平衡：%s", commodity, sum.RatString())
		}
	}

	// 直接给 repository 一个非法目标，验证单事务整体回滚（业务行 + sync_log 均不新增）。
	txnBefore := countRows(t, fx.conn, `SELECT count(*) FROM transactions WHERE ledger_id=?`, fx.ledgerID)
	syncBefore := countRows(t, fx.conn, `SELECT count(*) FROM sync_log WHERE ledger_id=?`, fx.ledgerID)
	_, err = repository.New(fx.conn).ApplyBalanceCalibration(fx.ledgerID, repository.BalanceCalibrationInput{
		AccountID: fx.cash.ID, AccountUUID: fx.cash.UUID,
		AsOfDate: fx.d, PostingDate: fx.dMinus1, Description: "余额校准: 测试",
		Targets: []repository.BalanceTarget{
			{Commodity: "CNY", TargetBalance: "100.00", Precision: 2},
			{Commodity: "USD", TargetBalance: "not-a-number", Precision: 3},
		},
	})
	if err == nil {
		t.Fatal("非法金额应导致整事务失败")
	}
	if got := countRows(t, fx.conn, `SELECT count(*) FROM transactions WHERE ledger_id=?`, fx.ledgerID); got != txnBefore {
		t.Fatalf("失败路径交易行数变化：%d → %d", txnBefore, got)
	}
	if got := countRows(t, fx.conn, `SELECT count(*) FROM sync_log WHERE ledger_id=?`, fx.ledgerID); got != syncBefore {
		t.Fatalf("失败路径 sync_log 变化：%d → %d", syncBefore, got)
	}
}

// TestBalanceAC34 AC-3.4：不写 opening_account_uuid，两套并存互不误读。
func TestBalanceAC34(t *testing.T) {
	fx := newBalanceFixture(t)
	result, err := fx.svc.SetBalanceCalibration(fx.ledgerID, fx.cash.UUID, BalanceInput{
		AsOfDate: fx.d,
		Targets:  []BalanceTargetInput{{Commodity: "CNY", TargetBalance: "500.00"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var openingAccount, balanceDate, balanceKey, tags sql.NullString
	if err := fx.conn.QueryRow(
		`SELECT opening_account_uuid, balance_date, balance_key, tags
		 FROM transactions WHERE uuid=?`, result.TransactionUUID,
	).Scan(&openingAccount, &balanceDate, &balanceKey, &tags); err != nil {
		t.Fatal(err)
	}
	if openingAccount.Valid {
		t.Fatal("校准交易绝不能写 opening_account_uuid")
	}
	if balanceDate.String != fx.d || !strings.HasPrefix(balanceKey.String, "balance:") {
		t.Fatalf("独立列错误: date=%q key=%q", balanceDate.String, balanceKey.String)
	}
	if tags.Valid && tags.String != "" {
		t.Fatalf("校准交易不应写 tags（Q-02）: %q", tags.String)
	}
	// 校准本身不改 ledgers.opening_date、不触发 RebuildOpenings。
	var openingDate string
	if err := fx.conn.QueryRow(
		`SELECT opening_date FROM ledgers WHERE id=?`, fx.ledgerID,
	).Scan(&openingDate); err != nil {
		t.Fatal(err)
	}
	if openingDate != fx.early {
		t.Fatalf("校准不得改 ledgers.opening_date：期望 %s 实际 %s", fx.early, openingDate)
	}
	if opening, err := fx.svc.GetOpening(fx.ledgerID, fx.cash.UUID); err != nil || opening.HasOpening {
		t.Fatalf("GetOpening 不应误读校准交易: %+v err=%v", opening, err)
	}
	// 校准交易会被 EarliestNonOpeningTxnDate 计入（AC-3.4 明确要求）。
	earliest, err := repository.New(fx.conn).EarliestNonOpeningTxnDate(fx.ledgerID)
	if err != nil {
		t.Fatal(err)
	}
	if earliest != fx.dMinus1 {
		t.Fatalf("校准交易应计入最早非期初交易日期，期望 %s 实际 %s", fx.dMinus1, earliest)
	}
	// 主动重建期初不得平移 / 重建校准交易。
	if _, err := repository.New(fx.conn).RebuildAllOpenings(fx.ledgerID, fx.early); err != nil {
		t.Fatalf("重建期初: %v", err)
	}
	var cnt int
	var date string
	if err := fx.conn.QueryRow(
		`SELECT count(*), COALESCE(MIN(date),'') FROM transactions WHERE uuid=?`, result.TransactionUUID,
	).Scan(&cnt, &date); err != nil {
		t.Fatal(err)
	}
	if cnt != 1 || date != fx.dMinus1 {
		t.Fatalf("校准交易被 RebuildAllOpenings 平移/重建: cnt=%d date=%s", cnt, date)
	}
}

// TestBalanceAC35 AC-3.5：导出普通 * 交易、无 balance/pad 指令，且过严格 bean-check。
func TestBalanceAC35(t *testing.T) {
	fx := newBalanceFixture(t)
	fx.addTxn(t, fx.early, "CNY", "12000.00")
	_, err := fx.svc.SetBalanceCalibration(fx.ledgerID, fx.cash.UUID, BalanceInput{
		AsOfDate: fx.d,
		Targets:  []BalanceTargetInput{{Commodity: "CNY", TargetBalance: "12350.00"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	text, err := export.ExportLedger(fx.conn, fx.ledgerID)
	if err != nil {
		t.Fatalf("导出: %v", err)
	}
	if !strings.Contains(text, "余额校准: 截至") {
		t.Fatalf("导出应包含校准交易: %s", text)
	}
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "balance ") || strings.HasPrefix(trimmed, "pad ") {
			t.Fatalf("导出不得含 balance/pad 指令: %s", line)
		}
	}
	python := filepath.Join("..", "..", ".venv", "Scripts", "python.exe")
	if _, err := os.Stat(python); err != nil {
		t.Fatalf("项目 .venv 校验器不可用: %v", err)
	}
	outPath := filepath.Join(t.TempDir(), "balance.beancount")
	if err := os.WriteFile(outPath, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(python, "-m", "beancount.scripts.check", outPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("bean-check 未通过: %v\n%s\n导出文本:\n%s", err, out, text)
	}
}

// TestBalanceAC36 AC-3.6：同 D 二次设置 → 冲正旧 + 新建，版本递增，复用 T08 内核。
func TestBalanceAC36(t *testing.T) {
	fx := newBalanceFixture(t)
	first, err := fx.svc.SetBalanceCalibration(fx.ledgerID, fx.cash.UUID, BalanceInput{
		AsOfDate: fx.d,
		Targets:  []BalanceTargetInput{{Commodity: "CNY", TargetBalance: "1000.00"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := fx.svc.SetBalanceCalibration(fx.ledgerID, fx.cash.UUID, BalanceInput{
		AsOfDate: fx.d,
		Targets:  []BalanceTargetInput{{Commodity: "CNY", TargetBalance: "1200.00"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.Status != "updated" || second.Version != 2 || second.ReversalUUID == "" {
		t.Fatalf("二次设置应冲正 + 版本递增: %+v", second)
	}
	var reversedBy string
	if err := fx.conn.QueryRow(
		`SELECT COALESCE(reversed_by,'') FROM transactions WHERE uuid=?`, first.TransactionUUID,
	).Scan(&reversedBy); err != nil {
		t.Fatal(err)
	}
	if reversedBy == "" {
		t.Fatal("旧校准必须标记失效（只减不删）")
	}
	var revOf string
	if err := fx.conn.QueryRow(
		`SELECT COALESCE(reversal_of,'') FROM transactions WHERE uuid=?`, second.ReversalUUID,
	).Scan(&revOf); err != nil {
		t.Fatal(err)
	}
	if revOf != first.TransactionUUID {
		t.Fatalf("冲正交易 reversal_of 应指向 v1，实际 %s", revOf)
	}
	// 三条校准相关 sync_log create：v1 + 冲正 + v2（按 uuid 精确核对，
	// 避免把建账户 / 补种权益 / 补建币种的既有 create 事件计入）。
	for _, txnUUID := range []string{first.TransactionUUID, second.ReversalUUID, second.TransactionUUID} {
		if n := countRows(t, fx.conn,
			`SELECT count(*) FROM sync_log WHERE ledger_id=? AND entity_uuid=? AND op=?`,
			fx.ledgerID, txnUUID, domain.OpCreate); n != 1 {
			t.Fatalf("校准/冲正交易 %s 应写 1 条 create 事件，实际 %d", txnUUID, n)
		}
	}
	preview, err := fx.svc.GetBalanceCalibration(fx.ledgerID, fx.cash.UUID, fx.d)
	if err != nil {
		t.Fatal(err)
	}
	if len(preview.Calibration.History) != 2 {
		t.Fatalf("版本历史应有 v1/v2，实际 %+v", preview.Calibration.History)
	}
	if !preview.Calibration.History[0].Reversed || preview.Calibration.History[1].Reversed {
		t.Fatalf("历史失效标记错误: %+v", preview.Calibration.History)
	}
	if got := amountOf(t, preview.Cumulative, "CNY"); got != "1200.00" {
		t.Fatalf("二次校准后累计应为 1200.00，实际 %s", got)
	}
}

// TestBalanceAC37 AC-3.7：两类日期错误文案一致（同一下界表述）。
func TestBalanceAC37(t *testing.T) {
	fx := newBalanceFixture(t)
	cases := []struct {
		date string
		code string
	}{
		{"2026/01/01", domain.CodeBalanceDateInvalid},
		{fx.today + "-x", domain.CodeBalanceDateInvalid},
		{time.Now().AddDate(0, 0, 1).Format("2006-01-02"), domain.CodeBalanceDateInvalid},
		{fx.early, domain.CodeBalanceDateTooEarly},
	}
	for _, c := range cases {
		_, err := fx.svc.SetBalanceCalibration(fx.ledgerID, fx.cash.UUID, BalanceInput{
			AsOfDate: c.date,
			Targets:  []BalanceTargetInput{{Commodity: "CNY", TargetBalance: "100.00"}},
		})
		var ce *domain.CodedError
		if !errors.As(err, &ce) || ce.Code != c.code {
			t.Fatalf("日期 %q 期望 %s，实际 %v", c.date, c.code, err)
		}
		if !strings.Contains(ce.Message, "不早于 max(账户开户日") {
			t.Fatalf("日期 %q 文案未点明同一下界: %s", c.date, ce.Message)
		}
	}
}

// TestBalanceAC38 AC-3.8：sync_log 与业务行同事务、不轮换 instance_id、失败不写 sync_log。
func TestBalanceAC38(t *testing.T) {
	fx := newBalanceFixture(t)
	instanceBefore, err := db.GetInstanceID(fx.conn)
	if err != nil {
		t.Fatal(err)
	}
	syncBefore := countRows(t, fx.conn, `SELECT count(*) FROM sync_log WHERE ledger_id=?`, fx.ledgerID)
	result, err := fx.svc.SetBalanceCalibration(fx.ledgerID, fx.cash.UUID, BalanceInput{
		AsOfDate: fx.d,
		Targets:  []BalanceTargetInput{{Commodity: "CNY", TargetBalance: "800.00"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	instanceAfter, err := db.GetInstanceID(fx.conn)
	if err != nil {
		t.Fatal(err)
	}
	if instanceBefore != instanceAfter {
		t.Fatalf("校准不得轮换 instance_id: %s → %s", instanceBefore, instanceAfter)
	}
	// 校准交易与 sync_log 同事务（权益账户补种也会写一条 account create，
	// 故按 uuid 精确核对校准交易自身的事件）。
	if n := countRows(t, fx.conn,
		`SELECT count(*) FROM sync_log WHERE ledger_id=? AND entity_uuid=? AND op=?`,
		fx.ledgerID, result.TransactionUUID, domain.OpCreate); n != 1 {
		t.Fatalf("校准交易应恰好写 1 条 create 事件，实际 %d", n)
	}
	syncAfter := countRows(t, fx.conn, `SELECT count(*) FROM sync_log WHERE ledger_id=?`, fx.ledgerID)
	if syncAfter <= syncBefore {
		t.Fatalf("成功路径应新增 sync_log：%d → %d", syncBefore, syncAfter)
	}
	_, err = fx.svc.SetBalanceCalibration(fx.ledgerID, fx.cash.UUID, BalanceInput{
		AsOfDate: "bad-date",
		Targets:  []BalanceTargetInput{{Commodity: "CNY", TargetBalance: "100.00"}},
	})
	if err == nil {
		t.Fatal("非法日期应失败")
	}
	if got := countRows(t, fx.conn, `SELECT count(*) FROM sync_log WHERE ledger_id=?`, fx.ledgerID); got != syncAfter {
		t.Fatalf("失败路径不得写 sync_log：%d → %d", syncAfter, got)
	}
}

// TestBalanceEquityClosed Q-11：权益账户已关闭 → 独立码 opening_equity_closed。
func TestBalanceEquityClosed(t *testing.T) {
	fx := newBalanceFixture(t)
	if _, err := fx.conn.Exec(
		`INSERT INTO accounts(ledger_id, uuid, name, type, open_date, close_date)
		 VALUES(?, 'eq-closed', ?, 'Equity', ?, ?)`,
		fx.ledgerID, domain.OpeningEquityName, fx.early, fx.early,
	); err != nil {
		t.Fatal(err)
	}
	_, err := fx.svc.SetBalanceCalibration(fx.ledgerID, fx.cash.UUID, BalanceInput{
		AsOfDate: fx.d,
		Targets:  []BalanceTargetInput{{Commodity: "CNY", TargetBalance: "100.00"}},
	})
	var ce *domain.CodedError
	if !errors.As(err, &ce) || ce.Code != domain.CodeOpeningEquityClosed {
		t.Fatalf("应返回 opening_equity_closed，实际 %v", err)
	}
	if !strings.Contains(ce.Message, "请先在账户页恢复该账户") {
		t.Fatalf("Q-11 文案错误: %s", ce.Message)
	}
}
