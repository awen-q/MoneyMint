package export

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"familyledger/internal/db"
)

// seedTagsExportFixture 建一笔带中文标签的平衡交易，供导出回归使用。
func seedTagsExportFixture(t *testing.T, dir string) *sql.DB {
	t.Helper()
	conn, err := db.Open(filepath.Join(dir, "test.db"), filepath.Join("..", "..", "schema.sql"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	mustExec := func(q string, args ...any) {
		t.Helper()
		if _, err := conn.Exec(q, args...); err != nil {
			t.Fatalf("exec %q: %v", q, err)
		}
	}
	mustExec(`INSERT INTO users(id, username, password_hash, display_name) VALUES(1,'u','x','U')`)
	mustExec(`INSERT INTO ledgers(id, name, owner_id) VALUES(1,'标签导出账本',1)`)
	mustExec(`INSERT INTO commodities(ledger_id, uuid, symbol, name, precision) VALUES(1,'cmd-1','CNY','人民币',2)`)
	mustExec(`INSERT INTO accounts(id, ledger_id, uuid, name, type, open_date) VALUES(1,1,'acc-1','Assets:Cash:CNY','Assets','2026-08-01')`)
	mustExec(`INSERT INTO accounts(id, ledger_id, uuid, name, type, open_date) VALUES(2,1,'acc-2','Expenses:Food','Expenses','2026-08-01')`)
	mustExec(`INSERT INTO transactions(id, ledger_id, uuid, date, flag, description, tags)
	          VALUES(1,1,'txn-1','2026-08-02','*','午餐','["餐饮"]')`)
	mustExec(`INSERT INTO postings(transaction_id, account_id, commodity, amount, position) VALUES(1,1,'CNY','-38.50',0)`)
	mustExec(`INSERT INTO postings(transaction_id, account_id, commodity, amount, position) VALUES(1,2,'CNY','38.50',1)`)
	return conn
}

// TestExport_AfterTagEdit US1 导出回归：
// 原地改标签前后导出只差一行 tags: "..." 的值，交易条数不变，写的是元数据行而非 #tag，
// 且导出文本能被 bean-check 校验通过。
func TestExport_AfterTagEdit(t *testing.T) {
	dir := t.TempDir()
	conn := seedTagsExportFixture(t, dir)

	before, err := ExportLedger(conn, 1)
	if err != nil {
		t.Fatalf("导出（改前）: %v", err)
	}
	if !strings.Contains(before, `tags: "餐饮"`) {
		t.Fatalf("改前导出应含 tags 元数据行，实际：\n%s", before)
	}
	if n := strings.Count(before, `2026-08-02 * "午餐"`); n != 1 {
		t.Fatalf("改前交易头行应恰好 1 条，实际 %d", n)
	}

	// 模拟注解层原地 UPDATE：只动 tags + tags_updated_at，不新增/冲正任何行。
	if _, err := conn.Exec(
		`UPDATE transactions SET tags=?, tags_updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
		 WHERE uuid='txn-1'`,
		`["晚餐"]`,
	); err != nil {
		t.Fatalf("原地改标签: %v", err)
	}
	after, err := ExportLedger(conn, 1)
	if err != nil {
		t.Fatalf("导出（改后）: %v", err)
	}
	if !strings.Contains(after, `tags: "晚餐"`) {
		t.Fatalf("改后导出应反映当前标签，实际：\n%s", after)
	}
	if strings.Contains(after, "餐饮") {
		t.Fatalf("改后导出不应残留旧标签，实际：\n%s", after)
	}
	if n := strings.Count(after, `2026-08-02 * "午餐"`); n != 1 {
		t.Fatalf("改标签不得改变交易条数，实际 %d 条", n)
	}
	for _, banned := range []string{"#餐饮", "#tag", " #"} {
		if strings.Contains(after, banned) {
			t.Fatalf("标签必须以 tags: \"...\" 元数据行导出，禁止 %q：\n%s", banned, after)
		}
	}

	beanFile := filepath.Join(dir, "after.bean")
	if err := os.WriteFile(beanFile, []byte(after), 0o644); err != nil {
		t.Fatalf("写导出文件: %v", err)
	}
	runBeanCheck(t, beanFile)
}

// TestExport_AfterDeleteTags US2 导出回归：清空标签后无 tags 元数据行，
// 交易头行仍在、bean-check 仍通过。
func TestExport_AfterDeleteTags(t *testing.T) {
	dir := t.TempDir()
	conn := seedTagsExportFixture(t, dir)
	if _, err := conn.Exec(
		`UPDATE transactions SET tags=NULL, tags_updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE uuid='txn-1'`,
	); err != nil {
		t.Fatalf("清空标签: %v", err)
	}
	text, err := ExportLedger(conn, 1)
	if err != nil {
		t.Fatalf("导出: %v", err)
	}
	if strings.Contains(text, "tags:") {
		t.Fatalf("空标签不应输出 tags 元数据行，实际：\n%s", text)
	}
	if n := strings.Count(text, `2026-08-02 * "午餐"`); n != 1 {
		t.Fatalf("清空标签后交易头行应仍为 1 条，实际 %d", n)
	}
	beanFile := filepath.Join(dir, "empty.bean")
	if err := os.WriteFile(beanFile, []byte(text), 0o644); err != nil {
		t.Fatalf("写导出文件: %v", err)
	}
	runBeanCheck(t, beanFile)
}
