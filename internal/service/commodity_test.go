package service

import (
	"database/sql"
	"errors"
	"strings"
	"testing"

	"familyledger/internal/domain"
	"familyledger/internal/export"
	"familyledger/internal/repository"
)

// seedCommodityLedger 建一份含 owner 与默认币种的测试账本。
func seedCommodityLedger(t *testing.T, conn *sql.DB) int64 {
	t.Helper()
	owner := insertUser(t, conn, "cmd-owner", false)
	res, err := conn.Exec(
		`INSERT INTO ledgers(name, owner_id, default_commodity) VALUES('币种测试账本', ?, 'CNY')`, owner)
	if err != nil {
		t.Fatalf("插入账本: %v", err)
	}
	ledgerID, _ := res.LastInsertId()
	if _, err := conn.Exec(
		`INSERT INTO ledger_members(ledger_id, user_id, role, invited_by) VALUES(?, ?, 'owner', ?)`,
		ledgerID, owner, owner,
	); err != nil {
		t.Fatalf("插入 owner 成员: %v", err)
	}
	return ledgerID
}

func commoditySyncLogCount(t *testing.T, conn *sql.DB, ledgerID int64, uuid, op string) int {
	t.Helper()
	var n int
	if err := conn.QueryRow(
		`SELECT count(*) FROM sync_log WHERE ledger_id=? AND entity_uuid=? AND op=?`,
		ledgerID, uuid, op,
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// TestCommodityCRUDAndRestore AC-4.1 / AC-4.3 + 设计 §10-2：
// 新建 / 重名 409 / 零引用删除 / 重复删幂等 404 / 命中软删行恢复原 uuid（绝不 INSERT）。
func TestCommodityCRUDAndRestore(t *testing.T) {
	conn := openTestDB(t)
	ledgerID := seedCommodityLedger(t, conn)
	svc := New(repository.New(conn))

	created, err := svc.CreateCommodity(ledgerID, "USD", "美元", 0)
	if err != nil {
		t.Fatalf("创建币种: %v", err)
	}
	if created.UUID == "" || created.Precision != 2 {
		t.Fatalf("默认 precision=2 / uuid 应生成，实际 %+v", created)
	}
	if n := commoditySyncLogCount(t, conn, ledgerID, created.UUID, domain.OpCreate); n != 1 {
		t.Fatalf("新建应写 1 条 create 同步事件，实际 %d", n)
	}

	list, err := svc.ListCommodities(ledgerID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Symbol != "USD" || list[0].Name != "美元" {
		t.Fatalf("列表错误: %+v", list)
	}

	_, err = svc.CreateCommodity(ledgerID, "USD", "美元", 2)
	var ce *domain.CodedError
	if !errors.As(err, &ce) || ce.Code != domain.CodeCommodityExists {
		t.Fatalf("重名应 409 commodity_exists，实际 %v", err)
	}
	if ce.Details.(map[string]any)["uuid"] != created.UUID {
		t.Fatalf("409 应回显已有 uuid，实际 %#v", ce.Details)
	}

	if err := svc.DeleteCommodity(ledgerID, created.UUID); err != nil {
		t.Fatalf("零引用删除: %v", err)
	}
	if n := commoditySyncLogCount(t, conn, ledgerID, created.UUID, domain.OpDelete); n != 1 {
		t.Fatalf("删除应写 1 条 delete 同步事件，实际 %d", n)
	}
	list, _ = svc.ListCommodities(ledgerID)
	if len(list) != 0 {
		t.Fatalf("软删后列表应为空，实际 %+v", list)
	}
	if err := svc.DeleteCommodity(ledgerID, created.UUID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("重复删应幂等 404，实际 %v", err)
	}

	// 命中软删行 → 恢复原行，返回原 uuid，且不新增 commodities 行。
	restored, err := svc.CreateCommodity(ledgerID, "USD", "美金", 3)
	if err != nil {
		t.Fatalf("恢复软删币种: %v", err)
	}
	if restored.UUID != created.UUID {
		t.Fatalf("必须返回原 uuid，期望 %s 实际 %s", created.UUID, restored.UUID)
	}
	var rows int
	if err := conn.QueryRow(
		`SELECT count(*) FROM commodities WHERE ledger_id=? AND symbol='USD'`, ledgerID,
	).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("恢复不得 INSERT 新行，实际行数 %d", rows)
	}
	if n := commoditySyncLogCount(t, conn, ledgerID, created.UUID, domain.OpCreate); n != 2 {
		t.Fatalf("恢复应再写 1 条 create 事件（累计 2），实际 %d", n)
	}
}

// TestCommodityInUseDetails AC-4.2 / AC-4.5：四类引用分项明细 + 默认币种保护文案。
func TestCommodityInUseDetails(t *testing.T) {
	conn := openTestDB(t)
	ledgerID := seedCommodityLedger(t, conn)
	svc := New(repository.New(conn))

	// ① 默认币种 CNY：删除必须 409，提示先改账本设置。
	cny, err := svc.CreateCommodity(ledgerID, "CNY", "人民币", 2)
	if err != nil {
		t.Fatal(err)
	}
	err = svc.DeleteCommodity(ledgerID, cny.UUID)
	var ce *domain.CodedError
	if !errors.As(err, &ce) || ce.Code != domain.CodeCommodityInUse {
		t.Fatalf("默认币种删除应 409 commodity_in_use，实际 %v", err)
	}
	if !strings.Contains(ce.Message, "请先在账本设置中改默认币种") {
		t.Fatalf("应提示改默认币种，实际 %q", ce.Message)
	}
	details := ce.Details.(map[string]any)
	if details["is_default"] != true {
		t.Fatalf("is_default 明细错误: %#v", details)
	}

	// ② JPY：账户限定币种 + 交易分录 + 价格，三类分项都要出现在 body。
	jpy, err := svc.CreateCommodity(ledgerID, "JPY", "日元", 2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO accounts(ledger_id, uuid, name, type, open_date, commodity_restriction)
		 VALUES(?, 'acc-jpy', 'Assets:JPYCash', 'Assets', '2026-01-01', 'JPY')`, ledgerID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO transactions(ledger_id, uuid, date, flag, description)
		 VALUES(?, 'txn-jpy', '2026-01-02', '*', '日元交易')`, ledgerID,
	); err != nil {
		t.Fatal(err)
	}
	var txnID int64
	if err := conn.QueryRow(
		`SELECT id FROM transactions WHERE ledger_id=? AND uuid='txn-jpy'`, ledgerID,
	).Scan(&txnID); err != nil {
		t.Fatal(err)
	}
	var accID int64
	if err := conn.QueryRow(
		`SELECT id FROM accounts WHERE ledger_id=? AND uuid='acc-jpy'`, ledgerID,
	).Scan(&accID); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO postings(transaction_id, account_id, commodity, amount, position)
		 VALUES(?, ?, 'JPY', '100', 0)`, txnID, accID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO prices(ledger_id, uuid, commodity, currency, date, rate, source)
		 VALUES(?, 'price-jpy', 'JPY', 'CNY', '2026-01-02', '0.05', 'test')`, ledgerID,
	); err != nil {
		t.Fatal(err)
	}

	err = svc.DeleteCommodity(ledgerID, jpy.UUID)
	if !errors.As(err, &ce) || ce.Code != domain.CodeCommodityInUse {
		t.Fatalf("被引用币种删除应 409 commodity_in_use，实际 %v", err)
	}
	details = ce.Details.(map[string]any)
	accounts, ok := details["accounts"].([]string)
	if !ok || len(accounts) != 1 || accounts[0] != "Assets:JPYCash" {
		t.Fatalf("accounts 明细错误: %#v", details["accounts"])
	}
	if details["postings"] != 1 || details["prices"] != 1 || details["is_default"] != false {
		t.Fatalf("postings/prices/is_default 明细错误: %#v", details)
	}
	if !strings.Contains(ce.Message, "个账户") || !strings.Contains(ce.Message, "笔交易分录") || !strings.Contains(ce.Message, "条价格") {
		t.Fatalf("中文可读原因缺失: %q", ce.Message)
	}
}

// TestCommoditySuppressAutoRevive AC-4.4：软删后 ensureCommodityOn 不复活、不多写 create。
func TestCommoditySuppressAutoRevive(t *testing.T) {
	conn := openTestDB(t)
	ledgerID := seedCommodityLedger(t, conn)
	store := repository.New(conn)
	svc := New(store)

	c, err := svc.CreateCommodity(ledgerID, "EUR", "欧元", 4)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteCommodity(ledgerID, c.UUID); err != nil {
		t.Fatal(err)
	}
	before := commoditySyncLogCount(t, conn, ledgerID, c.UUID, domain.OpCreate)

	// 模拟「再记一笔 EUR 交易」时各 repository 调用点汇聚的补建逻辑。
	for i := 0; i < 3; i++ {
		if err := store.EnsureCommodity(ledgerID, "EUR"); err != nil {
			t.Fatalf("EnsureCommodity: %v", err)
		}
	}

	list, err := svc.ListCommodities(ledgerID)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range list {
		if row.Symbol == "EUR" {
			t.Fatal("软删币种被自动复活")
		}
	}
	if after := commoditySyncLogCount(t, conn, ledgerID, c.UUID, domain.OpCreate); after != before {
		t.Fatalf("不应多写 create 同步事件：%d → %d", before, after)
	}
	var name, precision = "", 0
	if err := conn.QueryRow(
		`SELECT COALESCE(name,''), "precision" FROM commodities WHERE ledger_id=? AND symbol='EUR'`, ledgerID,
	).Scan(&name, &precision); err != nil {
		t.Fatal(err)
	}
	if name != "欧元" || precision != 4 {
		t.Fatalf("软删行元数据不得丢失: name=%q precision=%d", name, precision)
	}
}

// TestCommoditySoftDeletedNotExported AC-4.4 / C-07：软删币种不进 .beancount。
func TestCommoditySoftDeletedNotExported(t *testing.T) {
	conn := openTestDB(t)
	ledgerID := seedCommodityLedger(t, conn)
	svc := New(repository.New(conn))

	if _, err := svc.CreateCommodity(ledgerID, "CNY", "人民币", 2); err != nil {
		t.Fatal(err)
	}
	removed, err := svc.CreateCommodity(ledgerID, "GBP", "英镑", 2)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteCommodity(ledgerID, removed.UUID); err != nil {
		t.Fatal(err)
	}
	text, err := export.ExportLedger(conn, ledgerID)
	if err != nil {
		t.Fatalf("导出: %v", err)
	}
	if !strings.Contains(text, "commodity CNY") {
		t.Fatalf("活跃币种应导出: %s", text)
	}
	if strings.Contains(text, "GBP") {
		t.Fatalf("软删币种不得导出: %s", text)
	}
}

// TestValidateCommoditySymbol AC-4.1：symbol 非法一律 400 且中文可读。
func TestValidateCommoditySymbol(t *testing.T) {
	conn := openTestDB(t)
	ledgerID := seedCommodityLedger(t, conn)
	svc := New(repository.New(conn))

	cases := []struct {
		symbol string
		wantOK bool
	}{
		{"USD", true},
		{"USD.CNY", true},
		{"A1", true},
		{"", false},
		{"usd", false},
		{"USD CNY", false},
		{"人民币", false},
		{"1USD", false},
		{strings.Repeat("A", 25), false},
	}
	for _, c := range cases {
		_, err := svc.CreateCommodity(ledgerID, c.symbol, "测试", 2)
		if c.wantOK && err != nil {
			t.Fatalf("symbol %q 应合法，实际 %v", c.symbol, err)
		}
		if !c.wantOK {
			if err == nil {
				t.Fatalf("symbol %q 应被拒绝", c.symbol)
			}
			var ce *domain.CodedError
			if errors.As(err, &ce) {
				t.Fatalf("symbol 非法不应带稳定码: %v", err)
			}
			if strings.Contains(err.Error(), "SQL") || strings.Contains(err.Error(), "constraint") {
				t.Fatalf("不应暴露裸 SQL 错误: %v", err)
			}
		}
	}
}
