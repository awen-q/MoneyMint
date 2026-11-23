package db

import (
	"database/sql"
	"fmt"
)

// migration015Name 是迁移 015 在 schema_migrations 中的记录名。
const migration015Name = "015_ledger_ops"

// migrate015：0.6.0 账本操作所需的全部新列，合并为单个迁移一次落库。
//
// 设计口径（0.6.0 设计文档 §2，文档已随交付清退，git 历史可查）：
//   - ledgers.deleted_at：账本软删，查询层一律过滤；
//   - commodities.deleted_at：币种软删，抑制自动复活；
//   - transactions.balance_date / balance_key：余额校准元数据（不写 opening_account_uuid）；
//   - transactions.import_batch_id：导入批次撤销（独立列，不塞 tags）。
//
// 不含 edit_key（幂等由「已冲正判定」请求级兜底，Q-06），也不含 supersedes
// （老板裁定砍掉版本链）。全部列可空，旧代码不读新列即行为不变。
// 所有步骤在同一显式事务内完成，任一步失败整体回滚，可安全重跑。
func migrate015(conn *sql.DB) error {
	tx, err := conn.Begin()
	if err != nil {
		return fmt.Errorf("开启 015 事务: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	cols := []struct{ table, name, ddl string }{
		{"ledgers", "deleted_at", "TEXT"},
		{"commodities", "deleted_at", "TEXT"},
		{"transactions", "balance_date", "TEXT"},
		{"transactions", "balance_key", "TEXT"},
		{"transactions", "import_batch_id", "TEXT"},
	}
	for _, c := range cols {
		ok, err := columnExistsTx(tx, c.table, c.name)
		if err != nil {
			return fmt.Errorf("检查 %s.%s: %w", c.table, c.name, err)
		}
		if ok {
			continue
		}
		if _, err := tx.Exec(`ALTER TABLE ` + c.table + ` ADD COLUMN ` + c.name + ` ` + c.ddl); err != nil {
			return fmt.Errorf("新增 %s.%s: %w", c.table, c.name, err)
		}
	}

	indexes := []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_balance_key
		 ON transactions(ledger_id, balance_key)
		 WHERE balance_key IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_txn_import_batch
		 ON transactions(ledger_id, import_batch_id)
		 WHERE import_batch_id IS NOT NULL`,
	}
	for _, idx := range indexes {
		if _, err := tx.Exec(idx); err != nil {
			return fmt.Errorf("创建 015 索引: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("提交 015 事务: %w", err)
	}
	return nil
}
