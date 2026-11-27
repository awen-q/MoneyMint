package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

// TestMigrate018FreshDB 新库首次建库：018 记录一次，审计表 + 2 索引 + 新列就绪；
// 重复执行迁移保持幂等。
func TestMigrate018FreshDB(t *testing.T) {
	conn := openTestDB(t)

	if n := queryInt(t, conn, `SELECT count(*) FROM schema_migrations WHERE name=?`, migration018Name); n != 1 {
		t.Fatalf("新库应记录 018 一次，实际 %d", n)
	}
	if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='tag_edit_log'`); c != 1 {
		t.Fatalf("表 tag_edit_log 不存在（count=%d）", c)
	}
	for _, idx := range []string{"idx_tag_edit_log_txn", "uniq_tag_edit_op"} {
		if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); c != 1 {
			t.Fatalf("索引 %s 不存在（count=%d）", idx, c)
		}
	}
	assertTagsUpdatedAtColumn(t, conn)

	if err := ApplyMigrations(conn); err != nil {
		t.Fatalf("重复执行迁移应幂等，实际报错: %v", err)
	}
	if n := queryInt(t, conn, `SELECT count(*) FROM schema_migrations WHERE name=?`, migration018Name); n != 1 {
		t.Fatalf("重复执行后 018 记录数应为 1，实际 %d", n)
	}
}

// TestMigrate018LegacyDB 模拟「只有初始 schema、未跑任何迁移」的旧库：
// 018 需自行建表、建索引、加列，且可安全重跑。旧数据零回填（决策 5）。
func TestMigrate018LegacyDB(t *testing.T) {
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
	if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='tag_edit_log'`); c != 0 {
		t.Fatalf("旧库不应已有 tag_edit_log 表")
	}

	if err := ApplyMigrations(conn); err != nil {
		t.Fatalf("旧库升级失败: %v", err)
	}
	if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='tag_edit_log'`); c != 1 {
		t.Fatalf("升级后缺少 tag_edit_log 表")
	}
	assertTagsUpdatedAtColumn(t, conn)
	// 旧行默认空串，不是 NULL、不是当前时间。
	var ts string
	if err := conn.QueryRow(`SELECT tags_updated_at FROM transactions LIMIT 1`).Scan(&ts); err == nil && ts != "" {
		t.Fatalf("旧数据不应回填 tags_updated_at，实际 %q", ts)
	}
	if err := ApplyMigrations(conn); err != nil {
		t.Fatalf("幂等重跑失败: %v", err)
	}
}

// TestMigrate018IdempotentRerun 删除迁移记录后重跑：表/索引/列都不重复，
// 已有审计数据不丢失。这是 ALTER TABLE 幂等性的关键回归。
func TestMigrate018IdempotentRerun(t *testing.T) {
	conn := openTestDB(t)
	if _, err := conn.Exec(
		`INSERT INTO tag_edit_log(ledger_id, entity_uuid, action, old_tags, new_tags, actor_id, ts)
		 VALUES(1, 'keep-uuid', 'replace', '["甲"]', '["乙"]', 1, '2026-11-27T09:31:12.345Z')`,
	); err != nil {
		t.Fatalf("插入保留审计行: %v", err)
	}
	if _, err := conn.Exec(`DELETE FROM schema_migrations WHERE name=?`, migration018Name); err != nil {
		t.Fatalf("删除 018 迁移记录: %v", err)
	}
	if err := ApplyMigrations(conn); err != nil {
		t.Fatalf("重跑 018 失败（ALTER TABLE 未幂等？）: %v", err)
	}
	if n := queryInt(t, conn, `SELECT count(*) FROM schema_migrations WHERE name=?`, migration018Name); n != 1 {
		t.Fatalf("重跑后 018 记录数应为 1，实际 %d", n)
	}
	assertTagsUpdatedAtColumn(t, conn)
	if n := queryInt(t, conn, `SELECT count(*) FROM tag_edit_log WHERE entity_uuid='keep-uuid'`); n != 1 {
		t.Fatalf("重跑后审计数据丢失，行数 %d", n)
	}
	for _, idx := range []string{"idx_tag_edit_log_txn", "uniq_tag_edit_op"} {
		if c := queryInt(t, conn, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); c != 1 {
			t.Fatalf("重跑后索引 %s 数量异常: %d", idx, c)
		}
	}
}

// TestMigrate018UniqueClientOp 部分唯一索引：非空 client_op_id 同账本只能出现一次；
// 空串不占唯一键（P0 在线每次都是独立操作，允许多条审计）。
func TestMigrate018UniqueClientOp(t *testing.T) {
	conn := openTestDB(t)
	insert := func(op string) error {
		_, err := conn.Exec(
			`INSERT INTO tag_edit_log(ledger_id, entity_uuid, action, old_tags, new_tags, actor_id, client_op_id, ts)
			 VALUES(1, 'u', 'replace', '[]', '["甲"]', 1, ?, '2026-11-27T09:31:12.345Z')`, op)
		return err
	}
	if err := insert("dev-1:batch-1"); err != nil {
		t.Fatalf("首次带 client_op_id 插入应成功: %v", err)
	}
	if err := insert("dev-1:batch-1"); err == nil {
		t.Fatalf("重复 client_op_id 应被唯一索引拒绝")
	}
	if err := insert(""); err != nil {
		t.Fatalf("空 client_op_id 插入应成功: %v", err)
	}
	if err := insert(""); err != nil {
		t.Fatalf("空 client_op_id 应允许重复: %v", err)
	}
	if n := queryInt(t, conn, `SELECT count(*) FROM tag_edit_log WHERE client_op_id=''`); n != 2 {
		t.Fatalf("空 client_op_id 审计应有 2 条，实际 %d", n)
	}
}

// assertTagsUpdatedAtColumn 断言列存在、默认值为空串（NOT NULL DEFAULT ''）。
func assertTagsUpdatedAtColumn(t *testing.T, conn *sql.DB) {
	t.Helper()
	rows, err := conn.Query(`PRAGMA table_info(transactions)`)
	if err != nil {
		t.Fatalf("读取 transactions 列信息: %v", err)
	}
	defer rows.Close()
	found := false
	for rows.Next() {
		var cid, notnull, pk int
		var name, ctype string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			t.Fatalf("扫描列信息: %v", err)
		}
		if name == "tags_updated_at" {
			found = true
			if notnull != 1 {
				t.Fatalf("tags_updated_at 应为 NOT NULL")
			}
			if !dflt.Valid || dflt.String != "''" {
				t.Fatalf("tags_updated_at 默认值应为空串，实际 %+v", dflt)
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("遍历列信息: %v", err)
	}
	if !found {
		t.Fatalf("transactions 缺少 tags_updated_at 列")
	}
}
