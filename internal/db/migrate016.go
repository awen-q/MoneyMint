package db

import (
	"database/sql"
	"fmt"
)

// migration016Name 是迁移 016 在 schema_migrations 中的记录名。
const migration016Name = "016_import_batch_manifest"

// migrate016：导入批次实体清单表（QA DEF-1 根治，老板批准的 manifest 方案）。
//
// 背景：015 只把批次身份落在 transactions.import_batch_id 上，accounts/commodities/
// prices 无批次标记，撤销（undo）只能靠「撤销后零引用」的全账本扫描判定孤儿——
// 该判定在既有种子账户 / 默认币种上会误判（QA 复现：removed_accounts=35、默认币种
// CNY 被删）。016 新建 import_batch_entities 清单表，导入事务内为「本批新建（非复用）」
// 的账户 / 币种 / 价格逐条登记，撤销改为按清单精确删，从根上消灭越界硬删。
//
// 表结构（幂等 CREATE TABLE IF NOT EXISTS，不改 schema.sql）：
//
//	import_batch_entities(
//	  id          INTEGER PRIMARY KEY AUTOINCREMENT,
//	  ledger_id   INTEGER NOT NULL,          -- 账本范围
//	  batch_id    TEXT    NOT NULL,          -- import_batch_id（"imp-" + uuid）
//	  entity_type TEXT    NOT NULL,          -- account | commodity | price
//	  entity_uuid TEXT    NOT NULL,          -- 实体 uuid
//	  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
//	)
//
// 索引：
//   - idx_ibe_batch  (ledger_id, batch_id)：撤销按批次取清单；
//   - idx_ibe_unique (batch_id, entity_type, entity_uuid)：唯一，兜底重复登记
//     （导入用 INSERT OR IGNORE，重放不阻断）。
//
// 兼容性：016 之前创建的历史批次没有清单行，撤销时只按 import_batch_id 删交易与
// 分录，不再做任何实体扫描（安全降级：宁可不删，也不误删）。
// 全部步骤在同一显式事务内完成，可安全重跑。
func migrate016(conn *sql.DB) error {
	tx, err := conn.Begin()
	if err != nil {
		return fmt.Errorf("开启 016 事务: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	const ddl = `CREATE TABLE IF NOT EXISTS import_batch_entities (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		ledger_id   INTEGER NOT NULL,
		batch_id    TEXT    NOT NULL,
		entity_type TEXT    NOT NULL,
		entity_uuid TEXT    NOT NULL,
		created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
	)`
	if _, err := tx.Exec(ddl); err != nil {
		return fmt.Errorf("创建 import_batch_entities: %w", err)
	}

	indexes := []string{
		`CREATE INDEX IF NOT EXISTS idx_ibe_batch
		 ON import_batch_entities(ledger_id, batch_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_ibe_unique
		 ON import_batch_entities(batch_id, entity_type, entity_uuid)`,
	}
	for _, idx := range indexes {
		if _, err := tx.Exec(idx); err != nil {
			return fmt.Errorf("创建 016 索引: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("提交 016 事务: %w", err)
	}
	return nil
}
