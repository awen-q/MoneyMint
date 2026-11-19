package db

import (
	"database/sql"
	"fmt"
)

// migration017Name 是迁移 017 在 schema_migrations 中的记录名。
const migration017Name = "017_txn_purge_log"

// migrate017：回收站「永久删除」审计表（B7）。
//
// 背景：永久删除是物理删除（postings 与 transactions 都被 DELETE），删完之后
// 账本里没有任何痕迹可用于事后追溯「谁在什么时候删了哪一笔、金额是多少」。
// 本迁移只建一张**本机审计表**，把「删除前长什么样」冻结下来。
//
// 表结构（幂等 CREATE TABLE IF NOT EXISTS，不改 schema.sql）：
//
//	txn_purge_log(
//	  id                INTEGER PRIMARY KEY AUTOINCREMENT,  -- 本机单调序号（审计倒序即按它）
//	  ledger_id         INTEGER NOT NULL,                   -- 账本范围
//	  uuid              TEXT    NOT NULL,                   -- 被删交易 uuid
//	  description       TEXT    NOT NULL DEFAULT '',        -- 删除前的描述
//	  amount_note       TEXT    NOT NULL DEFAULT '',        -- 删除前的分录金额摘要（纯展示）
//	  was_in_trash      INTEGER NOT NULL DEFAULT 1,         -- 删除前是否在回收站
//	  pair_uuid         TEXT    NOT NULL DEFAULT '',        -- 冲正配对成员 uuid（对称写）
//	  actor_id          INTEGER NOT NULL,                    -- 操作人 user id
//	  purged_at         TEXT    NOT NULL,                    -- datetime('now')，与 deleted_at 同格式
//	  origin_deleted_at TEXT    NOT NULL DEFAULT ''          -- 删除前的 deleted_at（配对成员为空）
//	)
//
// 索引 idx_purge_log_ledger(ledger_id, id DESC)：页脚「永久删除记录」按账本取最近 N 条。
//
// 三条设计约束（与同步协议彻底解耦）：
//  1. 审计**只写不删**：本表不跟随账本/交易任何生命周期，不提供清理接口；
//  2. **不参与同步**：不写 sync_log、不进 SyncPull，其他设备看不到本机审计；
//  3. **不随 instance_id 轮换清理**：一个库的删除历史就是这个库的属性。
//
// 兼容性：017 之前创建的库没有删除历史，升级后审计区块为空（前端隐藏该区块），
// 不做任何回填——历史删除记录已无从考证，编造比空白更糟。
//
// 全部步骤在同一显式事务内完成（与 016 同构），可安全重跑。
func migrate017(conn *sql.DB) error {
	tx, err := conn.Begin()
	if err != nil {
		return fmt.Errorf("开启 017 事务: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	const ddl = `CREATE TABLE IF NOT EXISTS txn_purge_log (
		id                INTEGER PRIMARY KEY AUTOINCREMENT,
		ledger_id         INTEGER NOT NULL,
		uuid              TEXT NOT NULL,
		description       TEXT NOT NULL DEFAULT '',
		amount_note       TEXT NOT NULL DEFAULT '',
		was_in_trash      INTEGER NOT NULL DEFAULT 1,
		pair_uuid         TEXT NOT NULL DEFAULT '',
		actor_id          INTEGER NOT NULL,
		purged_at         TEXT NOT NULL,
		origin_deleted_at TEXT NOT NULL DEFAULT ''
	)`
	if _, err := tx.Exec(ddl); err != nil {
		return fmt.Errorf("创建 txn_purge_log: %w", err)
	}

	const idx = `CREATE INDEX IF NOT EXISTS idx_purge_log_ledger
	 ON txn_purge_log(ledger_id, id DESC)`
	if _, err := tx.Exec(idx); err != nil {
		return fmt.Errorf("创建 017 索引: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("提交 017 事务: %w", err)
	}
	return nil
}
