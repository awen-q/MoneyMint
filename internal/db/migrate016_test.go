package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

// TestMigrate016FreshDB 新库首次建库：016 记录一次，manifest 表与两个索引就绪；
// 重复执行迁移保持幂等。
func TestMigrate016FreshDB(t *testing.T) {
	conn := openTestDB(t)

	if n := queryInt(t, conn, `SELECT count(*) FROM schema_migrations WHERE name=?`, migration016Name); n != 1 {
		t.Fatalf("新库应记录 016 一次，实际 %d", n)
	}

	if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='import_batch_entities'`); c != 1 {
		t.Fatalf("表 import_batch_entities 不存在")
	}
	for _, idx := range []string{"idx_ibe_batch", "idx_ibe_unique"} {
		if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); c != 1 {
			t.Fatalf("索引 %s 不存在", idx)
		}
	}

	// 唯一索引语义：同批次同类型同实体只允许一行。
	if _, err := conn.Exec(
		`INSERT INTO import_batch_entities(ledger_id, batch_id, entity_type, entity_uuid)
		 VALUES(1, 'imp-x', 'account', 'u1')`); err != nil {
		t.Fatalf("首次登记应成功: %v", err)
	}
	if _, err := conn.Exec(
		`INSERT INTO import_batch_entities(ledger_id, batch_id, entity_type, entity_uuid)
		 VALUES(1, 'imp-x', 'account', 'u1')`); err == nil {
		t.Fatalf("重复登记应被唯一索引拒绝")
	}
	// 同批次不同类型 / 不同实体允许并存。
	if _, err := conn.Exec(
		`INSERT INTO import_batch_entities(ledger_id, batch_id, entity_type, entity_uuid)
		 VALUES(1, 'imp-x', 'commodity', 'u1')`); err != nil {
		t.Fatalf("同 uuid 不同类型应允许: %v", err)
	}
	if _, err := conn.Exec(
		`INSERT INTO import_batch_entities(ledger_id, batch_id, entity_type, entity_uuid)
		 VALUES(1, 'imp-x', 'account', 'u2')`); err != nil {
		t.Fatalf("同批次不同实体应允许: %v", err)
	}

	if err := ApplyMigrations(conn); err != nil {
		t.Fatalf("重复执行迁移应幂等，实际报错: %v", err)
	}
	if n := queryInt(t, conn, `SELECT count(*) FROM schema_migrations WHERE name=?`, migration016Name); n != 1 {
		t.Fatalf("重复执行后 016 记录数应为 1，实际 %d", n)
	}
}

// TestMigrate016LegacyDB 模拟「只有初始 schema、未跑任何迁移」的旧库：
// 016 需自行建表与索引，且可安全重跑。
func TestMigrate016LegacyDB(t *testing.T) {
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

	if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='import_batch_entities'`); c != 0 {
		t.Fatalf("旧库不应已有 import_batch_entities 表")
	}

	if err := ApplyMigrations(conn); err != nil {
		t.Fatalf("旧库升级失败: %v", err)
	}
	if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='import_batch_entities'`); c != 1 {
		t.Fatalf("升级后缺少 import_batch_entities 表")
	}
	for _, idx := range []string{"idx_ibe_batch", "idx_ibe_unique"} {
		if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); c != 1 {
			t.Fatalf("升级后索引 %s 不存在", idx)
		}
	}

	// 再次执行（模拟重启 / 重复部署）不得报错。
	if err := ApplyMigrations(conn); err != nil {
		t.Fatalf("幂等重跑失败: %v", err)
	}
}

// TestMigrate016IdempotentRerun 删除迁移记录后重跑：表结构不重复，已登记的
// manifest 数据不丢失（CREATE TABLE IF NOT EXISTS 语义）。
func TestMigrate016IdempotentRerun(t *testing.T) {
	conn := openTestDB(t)
	if _, err := conn.Exec(
		`INSERT INTO import_batch_entities(ledger_id, batch_id, entity_type, entity_uuid)
		 VALUES(1, 'imp-keep', 'account', 'u-keep')`); err != nil {
		t.Fatalf("插入保留数据: %v", err)
	}

	if _, err := conn.Exec(`DELETE FROM schema_migrations WHERE name=?`, migration016Name); err != nil {
		t.Fatalf("删除 016 迁移记录: %v", err)
	}
	if err := ApplyMigrations(conn); err != nil {
		t.Fatalf("重跑 016 失败: %v", err)
	}

	if n := queryInt(t, conn, `SELECT count(*) FROM schema_migrations WHERE name=?`, migration016Name); n != 1 {
		t.Fatalf("重跑后 016 记录数应为 1，实际 %d", n)
	}
	for _, idx := range []string{"idx_ibe_batch", "idx_ibe_unique"} {
		if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); c != 1 {
			t.Fatalf("重跑后索引 %s 数量异常: %d", idx, c)
		}
	}
	if got := queryInt(t, conn, `SELECT count(*) FROM import_batch_entities WHERE batch_id='imp-keep' AND entity_uuid='u-keep'`); got != 1 {
		t.Fatalf("重跑后已有 manifest 数据丢失，行数 %d", got)
	}
}
