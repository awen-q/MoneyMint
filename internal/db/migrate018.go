package db

import (
	"database/sql"
	"fmt"
)

// migration018Name 是迁移 018 在 schema_migrations 中的记录名。
const migration018Name = "018_txn_tag_edit_log"

// migrate018：标签原地更新的注解层地基（P0）。
//
// 与迁移 017（B7 回收站永久删除审计）同构：单事务、CREATE TABLE IF NOT EXISTS、
// 不动 schema.sql、在 migrate.go 的 migrations 末尾追加，可安全重跑。
//
// 差异（也是本次改动的边界）：
//   - tag_edit_log 是**服务端权威**审计：只写不删、按需 GET 给账本成员看，
//     不写 sync_log、不进 loadEntity、不进主流水；
//   - transactions 增一列 tags_updated_at，默认空串 —— 旧数据零回填，
//     历史「冲正: XXX」行不识别、不合并、不重写（决策 5）。
//
// DDL 严格照实施方案 §4.1 落地：
//
//	tag_edit_log(
//	  id           INTEGER PRIMARY KEY AUTOINCREMENT,
//	  ledger_id    INTEGER NOT NULL,
//	  entity_uuid  TEXT NOT NULL,                  -- 交易 uuid（不可变身份）
//	  action       TEXT NOT NULL,                  -- P0 恒 'replace'
//	  old_tags     TEXT NOT NULL DEFAULT '[]',     -- JSON 数组字符串
//	  new_tags     TEXT NOT NULL DEFAULT '[]',
//	  actor_id     INTEGER NOT NULL,               -- 服务端 user id
//	  device_id    TEXT NOT NULL DEFAULT '',
//	  client_op_id TEXT NOT NULL DEFAULT '',       -- P1 离线批次去重键
//	  ts           TEXT NOT NULL                   -- strftime('%Y-%m-%dT%H:%M:%fZ','now')
//	)
//
// 索引 idx_tag_edit_log_txn(ledger_id, entity_uuid, id DESC) 供二级面板倒序分页；
// 部分唯一索引 uniq_tag_edit_op(ledger_id, client_op_id) WHERE client_op_id <> ''
// 为 P1 离线批次去重预留，P0 在线调用 client_op_id 恒为空串，不占唯一键。
//
// SQLite 的 ALTER TABLE ADD COLUMN 不是幂等的，因此加列前先在**同一事务内**
// 用 PRAGMA table_info 检查列是否已存在；这样删除 schema_migrations 记录后
// 重跑本迁移也不会报错（与 011/013 的 columnExists 口径一致）。
func migrate018(conn *sql.DB) error {
	tx, err := conn.Begin()
	if err != nil {
		return fmt.Errorf("开启 018 事务: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	const ddl = `CREATE TABLE IF NOT EXISTS tag_edit_log (
		id           INTEGER PRIMARY KEY AUTOINCREMENT,
		ledger_id    INTEGER NOT NULL,
		entity_uuid  TEXT    NOT NULL,
		action       TEXT    NOT NULL,
		old_tags     TEXT    NOT NULL DEFAULT '[]',
		new_tags     TEXT    NOT NULL DEFAULT '[]',
		actor_id     INTEGER NOT NULL,
		device_id    TEXT    NOT NULL DEFAULT '',
		client_op_id TEXT    NOT NULL DEFAULT '',
		ts           TEXT    NOT NULL
	)`
	if _, err := tx.Exec(ddl); err != nil {
		return fmt.Errorf("创建 tag_edit_log: %w", err)
	}

	for _, idx := range []string{
		`CREATE INDEX IF NOT EXISTS idx_tag_edit_log_txn
		 ON tag_edit_log(ledger_id, entity_uuid, id DESC)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uniq_tag_edit_op
		 ON tag_edit_log(ledger_id, client_op_id) WHERE client_op_id <> ''`,
	} {
		if _, err := tx.Exec(idx); err != nil {
			return fmt.Errorf("创建 018 索引: %w", err)
		}
	}

	exists, err := columnExistsOnTx(tx, "transactions", "tags_updated_at")
	if err != nil {
		return err
	}
	if !exists {
		if _, err := tx.Exec(
			`ALTER TABLE transactions ADD COLUMN tags_updated_at TEXT NOT NULL DEFAULT ''`,
		); err != nil {
			return fmt.Errorf("添加 transactions.tags_updated_at: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("提交 018 事务: %w", err)
	}
	return nil
}

// columnExistsOnTx 是 columnExists 的事务内版本。
//
// 迁移 018 的 DDL 全部放在一个显式事务里，不能用 conn.Query（会另取连接，
// 与当前事务看到的 schema 不一致，且 MaxOpenConns=1 时会自锁）；PRAGMA
// table_info 在 *sql.Tx 上执行即可读到本事务内的列定义。
func columnExistsOnTx(tx *sql.Tx, table, col string) (bool, error) {
	rows, err := tx.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notnull, pk int
		var name, ctype string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return false, err
		}
		if name == col {
			return true, rows.Err()
		}
	}
	return false, rows.Err()
}
