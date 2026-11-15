package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

// TestMigrate015FreshDB 新库首次建库：015 记录一次，5 列与 2 索引就绪，
// 且不含 edit_key / supersedes；重复执行迁移保持幂等。
func TestMigrate015FreshDB(t *testing.T) {
	conn := openTestDB(t)

	if n := queryInt(t, conn, `SELECT count(*) FROM schema_migrations WHERE name=?`, migration015Name); n != 1 {
		t.Fatalf("新库应记录 015 一次，实际 %d", n)
	}

	for _, c := range []struct{ table, col string }{
		{"ledgers", "deleted_at"},
		{"commodities", "deleted_at"},
		{"transactions", "balance_date"},
		{"transactions", "balance_key"},
		{"transactions", "import_batch_id"},
	} {
		ok, err := columnExists(conn, c.table, c.col)
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			t.Fatalf("%s 缺少列 %s", c.table, c.col)
		}
	}

	for _, idx := range []string{"idx_txn_balance_key", "idx_txn_import_batch"} {
		if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); c != 1 {
			t.Fatalf("索引 %s 不存在", idx)
		}
	}

	// 明确不落库的两列：edit_key（Q-06 不落库）、supersedes（版本链已裁剪）。
	for _, col := range []string{"edit_key", "supersedes"} {
		ok, err := columnExists(conn, "transactions", col)
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			t.Fatalf("015 不应包含 transactions.%s", col)
		}
	}

	if err := ApplyMigrations(conn); err != nil {
		t.Fatalf("重复执行迁移应幂等，实际报错: %v", err)
	}
	if n := queryInt(t, conn, `SELECT count(*) FROM schema_migrations WHERE name=?`, migration015Name); n != 1 {
		t.Fatalf("重复执行后 015 记录数应为 1，实际 %d", n)
	}
}

// TestMigrate015LegacyDB 模拟「只有初始 schema、未跑任何迁移」的旧库：
// 015 需自行 ALTER TABLE 加列并建索引，且可安全重跑。
func TestMigrate015LegacyDB(t *testing.T) {
	dir := t.TempDir()
	conn, err := sql.Open("sqlite", filepath.Join(dir, "legacy.db"))
	if err != nil {
		t.Fatalf("打开旧库: %v", err)
	}
	conn.SetMaxOpenConns(1)
	t.Cleanup(func() { conn.Close() })

	schema, err := os.ReadFile(filepath.Join("..", "..", "schema.sql"))
	if err != nil {
		t.Fatalf("读取 schema.sql: %v", err)
	}
	if _, err := conn.Exec(string(schema)); err != nil {
		t.Fatalf("写入初始 schema: %v", err)
	}

	for _, col := range []string{"balance_date", "balance_key", "import_batch_id"} {
		ok, err := columnExists(conn, "transactions", col)
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			t.Fatalf("旧库不应已有列 %s", col)
		}
	}

	if err := ApplyMigrations(conn); err != nil {
		t.Fatalf("旧库升级失败: %v", err)
	}
	for _, c := range []struct{ table, col string }{
		{"ledgers", "deleted_at"},
		{"commodities", "deleted_at"},
		{"transactions", "balance_date"},
		{"transactions", "balance_key"},
		{"transactions", "import_batch_id"},
	} {
		ok, err := columnExists(conn, c.table, c.col)
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			t.Fatalf("升级后仍缺少列 %s.%s", c.table, c.col)
		}
	}
	for _, idx := range []string{"idx_txn_balance_key", "idx_txn_import_batch"} {
		if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); c != 1 {
			t.Fatalf("升级后索引 %s 不存在", idx)
		}
	}

	// 再次执行（模拟重启 / 重复部署）不得报错。
	if err := ApplyMigrations(conn); err != nil {
		t.Fatalf("幂等重跑失败: %v", err)
	}
}

// TestMigrate015PartialIndexes 校验两个部分索引的语义：
// balance_key 同账本唯一、跨账本可重复、NULL 不受约束；import_batch_id 非唯一。
func TestMigrate015PartialIndexes(t *testing.T) {
	conn := openTestDB(t)
	// 本用例只验证索引，不依赖账本/用户外键数据。
	if _, err := conn.Exec(`PRAGMA foreign_keys=OFF`); err != nil {
		t.Fatalf("关闭外键: %v", err)
	}

	insert := func(uuid string, ledgerID int64, balanceKey, batchID any) error {
		_, err := conn.Exec(
			`INSERT INTO transactions(ledger_id, uuid, date, flag, description, balance_key, import_batch_id)
			 VALUES(?, ?, '2026-08-01', '*', 'test', ?, ?)`,
			ledgerID, uuid, balanceKey, batchID,
		)
		return err
	}

	if err := insert("b1", 1, "balance:acc-1:v1", "imp-1"); err != nil {
		t.Fatalf("首次插入应成功: %v", err)
	}
	if err := insert("b2", 1, "balance:acc-1:v1", "imp-1"); err == nil {
		t.Fatalf("同账本同 balance_key 应被唯一索引拒绝")
	}
	if err := insert("b3", 2, "balance:acc-1:v1", "imp-1"); err != nil {
		t.Fatalf("不同账本同 balance_key 应允许: %v", err)
	}
	if err := insert("b4", 1, nil, "imp-1"); err != nil {
		t.Fatalf("NULL balance_key 应允许: %v", err)
	}
	if err := insert("b5", 1, nil, "imp-1"); err != nil {
		t.Fatalf("多条 NULL balance_key 应允许: %v", err)
	}
	if err := insert("b6", 1, "balance:acc-1:v2", "imp-1"); err != nil {
		t.Fatalf("同批次应允许多笔交易（import_batch_id 非唯一）: %v", err)
	}
	if n := queryInt(t, conn, `SELECT count(*) FROM transactions WHERE import_batch_id='imp-1'`); n != 5 {
		t.Fatalf("imp-1 批次应有 5 笔，实际 %d", n)
	}
}

// TestMigrate015IdempotentRerun 删除迁移记录后重跑：列/索引不重复，已有数据不丢失。
func TestMigrate015IdempotentRerun(t *testing.T) {
	conn := openTestDB(t)
	if _, err := conn.Exec(`PRAGMA foreign_keys=OFF`); err != nil {
		t.Fatalf("关闭外键: %v", err)
	}
	if _, err := conn.Exec(
		`INSERT INTO transactions(ledger_id, uuid, date, flag, description, balance_key, import_batch_id)
		 VALUES(1, 'keep-1', '2026-08-01', '*', '保留数据', 'balance:acc-1:v1', 'imp-1')`,
	); err != nil {
		t.Fatalf("插入保留数据: %v", err)
	}

	if _, err := conn.Exec(`DELETE FROM schema_migrations WHERE name=?`, migration015Name); err != nil {
		t.Fatalf("删除 015 迁移记录: %v", err)
	}
	if err := ApplyMigrations(conn); err != nil {
		t.Fatalf("重跑 015 失败: %v", err)
	}

	if n := queryInt(t, conn, `SELECT count(*) FROM schema_migrations WHERE name=?`, migration015Name); n != 1 {
		t.Fatalf("重跑后 015 记录数应为 1，实际 %d", n)
	}
	for _, idx := range []string{"idx_txn_balance_key", "idx_txn_import_batch"} {
		if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); c != 1 {
			t.Fatalf("重跑后索引 %s 数量异常: %d", idx, c)
		}
	}
	if got := queryText(t, conn, `SELECT COALESCE(balance_key,'') FROM transactions WHERE uuid='keep-1'`); got != "balance:acc-1:v1" {
		t.Fatalf("重跑后已有 balance_key 数据丢失: %q", got)
	}
	if got := queryText(t, conn, `SELECT COALESCE(import_batch_id,'') FROM transactions WHERE uuid='keep-1'`); got != "imp-1" {
		t.Fatalf("重跑后已有 import_batch_id 数据丢失: %q", got)
	}
}
