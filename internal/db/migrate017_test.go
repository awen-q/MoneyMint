package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

// TestMigrate017FreshDB 新库首次建库：017 记录一次，审计表与索引就绪，
// DDL 逐字对齐定稿（含各列默认值），重复执行迁移保持幂等。
func TestMigrate017FreshDB(t *testing.T) {
	conn := openTestDB(t)

	if n := queryInt(t, conn, `SELECT count(*) FROM schema_migrations WHERE name=?`, migration017Name); n != 1 {
		t.Fatalf("新库应记录 017 一次，实际 %d", n)
	}
	if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='txn_purge_log'`); c != 1 {
		t.Fatalf("表 txn_purge_log 不存在")
	}
	if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name='idx_purge_log_ledger'`); c != 1 {
		t.Fatalf("索引 idx_purge_log_ledger 不存在")
	}

	// 列必须齐全且顺序稳定（审计读取按列名，不按位置；这里钉住「一列都不许少」）。
	for _, col := range []string{
		"id", "ledger_id", "uuid", "description", "amount_note", "was_in_trash",
		"pair_uuid", "actor_id", "purged_at", "origin_deleted_at",
	} {
		ok, err := columnExists(conn, "txn_purge_log", col)
		if err != nil {
			t.Fatalf("检查列 %s: %v", col, err)
		}
		if !ok {
			t.Fatalf("txn_purge_log 缺少列 %s", col)
		}
	}

	// 默认值：was_in_trash 默认 1、description/amount_note/pair_uuid/origin_deleted_at 默认空串。
	if _, err := conn.Exec(
		`INSERT INTO txn_purge_log(ledger_id, uuid, actor_id, purged_at)
		 VALUES(1, 'u-min', 7, '2026-02-01 03:04:05')`); err != nil {
		t.Fatalf("最小列插入应成功（其余列必须有默认值）: %v", err)
	}
	var desc, note, pair, origin string
	var wasInTrash int
	if err := conn.QueryRow(
		`SELECT description, amount_note, pair_uuid, origin_deleted_at, was_in_trash
		 FROM txn_purge_log WHERE uuid='u-min'`,
	).Scan(&desc, &note, &pair, &origin, &wasInTrash); err != nil {
		t.Fatalf("读取默认值: %v", err)
	}
	if desc != "" || note != "" || pair != "" || origin != "" {
		t.Fatalf("文本列默认值应为空串，实际 %q/%q/%q/%q", desc, note, pair, origin)
	}
	if wasInTrash != 1 {
		t.Fatalf("was_in_trash 默认值应为 1，实际 %d", wasInTrash)
	}

	// 重跑幂等（服务重启 / 重复部署）。
	if err := ApplyMigrations(conn); err != nil {
		t.Fatalf("重复执行迁移应幂等，实际报错: %v", err)
	}
	if n := queryInt(t, conn, `SELECT count(*) FROM schema_migrations WHERE name=?`, migration017Name); n != 1 {
		t.Fatalf("重复执行后 017 记录数应为 1，实际 %d", n)
	}
	if n := queryInt(t, conn, `SELECT count(*) FROM txn_purge_log WHERE uuid='u-min'`); n != 1 {
		t.Fatalf("重跑不得丢审计行，实际 %d 行", n)
	}
}

// TestMigrate017LegacyDB 模拟「只有初始 schema、未跑任何迁移」的旧库：
// 017 需自行建表与索引，且可安全重跑；升级前的历史删除记录不回填（无从考证）。
func TestMigrate017LegacyDB(t *testing.T) {
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

	if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='txn_purge_log'`); c != 0 {
		t.Fatalf("旧库不应已有 txn_purge_log 表")
	}

	if err := ApplyMigrations(conn); err != nil {
		t.Fatalf("旧库升级失败: %v", err)
	}
	if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='txn_purge_log'`); c != 1 {
		t.Fatalf("升级后缺少 txn_purge_log 表")
	}
	if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name='idx_purge_log_ledger'`); c != 1 {
		t.Fatalf("升级后缺少 idx_purge_log_ledger 索引")
	}
	// 不回填：审计区块应如实为空，而不是凭空多出记录。
	if n := queryInt(t, conn, `SELECT count(*) FROM txn_purge_log`); n != 0 {
		t.Fatalf("升级不回填历史删除记录，实际 %d 行", n)
	}

	// 再次执行（模拟重启 / 重复部署）不得报错。
	if err := ApplyMigrations(conn); err != nil {
		t.Fatalf("幂等重跑失败: %v", err)
	}
}

// TestMigrate017IdempotentRerun 删除迁移记录后重跑：表结构不重复，
// 已写入的审计行不丢（CREATE TABLE IF NOT EXISTS 语义）。
//
// 「审计只写不删」是产品口径：重跑迁移绝不能成为清空审计的副作用。
func TestMigrate017IdempotentRerun(t *testing.T) {
	conn := openTestDB(t)
	if _, err := conn.Exec(
		`INSERT INTO txn_purge_log(ledger_id, uuid, description, amount_note, was_in_trash,
		                           pair_uuid, actor_id, purged_at, origin_deleted_at)
		 VALUES(1, 'u-keep', '被删的描述', '-1.00 CNY / 1.00 CNY', 0, 'u-pair', 2,
		        '2026-02-01 00:00:00', '')`); err != nil {
		t.Fatalf("插入保留数据: %v", err)
	}

	if _, err := conn.Exec(`DELETE FROM schema_migrations WHERE name=?`, migration017Name); err != nil {
		t.Fatalf("删除 017 迁移记录: %v", err)
	}
	if err := ApplyMigrations(conn); err != nil {
		t.Fatalf("重跑 017 失败: %v", err)
	}

	if n := queryInt(t, conn, `SELECT count(*) FROM schema_migrations WHERE name=?`, migration017Name); n != 1 {
		t.Fatalf("重跑后 017 记录数应为 1，实际 %d", n)
	}
	if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name='idx_purge_log_ledger'`); c != 1 {
		t.Fatalf("重跑后索引数量异常: %d", c)
	}
	var desc, pair string
	var wasInTrash int
	if err := conn.QueryRow(
		`SELECT description, pair_uuid, was_in_trash FROM txn_purge_log WHERE uuid='u-keep'`,
	).Scan(&desc, &pair, &wasInTrash); err != nil {
		t.Fatalf("重跑后审计行丢失: %v", err)
	}
	if desc != "被删的描述" || pair != "u-pair" || wasInTrash != 0 {
		t.Fatalf("重跑后审计行内容被改动: %q/%q/%d", desc, pair, wasInTrash)
	}
}
