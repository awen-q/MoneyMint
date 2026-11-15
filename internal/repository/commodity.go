package repository

import (
	"database/sql"
	"errors"
	"fmt"

	"familyledger/internal/domain"

	"github.com/google/uuid"
)

// CommodityListRow 是币种列表行（设计 §3.5 #4），含 used / is_default 聚合。
// Used 表示「被账户 / 分录 / 价格引用或是默认币种」，与删除门禁同口径。
type CommodityListRow struct {
	UUID      string
	Symbol    string
	Name      string
	Precision int
	Used      bool
	IsDefault bool
}

// CommodityUsageView 是某币种的 4 类引用分项明细（AC-4.2 删除门禁 409 用）。
// Accounts 只放示例账户名（最多 5 条），AccountCount 是完整数量。
type CommodityUsageView struct {
	Accounts     []string
	AccountCount int
	Postings     int
	Prices       int
	IsDefault    bool
}

// InUse 返回 4 类引用中是否任一命中。
func (u CommodityUsageView) InUse() bool {
	return u.AccountCount > 0 || u.Postings > 0 || u.Prices > 0 || u.IsDefault
}

// CommodityByUUID 按 uuid 查询未软删币种；软删行视为不存在。
func (s *Store) CommodityByUUID(ledgerID int64, uuid string) (domain.Commodity, error) {
	var c domain.Commodity
	var name sql.NullString
	err := s.db.QueryRow(
		`SELECT uuid, symbol, name, "precision" FROM commodities
		 WHERE ledger_id=? AND uuid=? AND deleted_at IS NULL`,
		ledgerID, uuid,
	).Scan(&c.UUID, &c.Symbol, &name, &c.Precision)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Commodity{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Commodity{}, err
	}
	c.Name = name.String
	return c, nil
}

// CommodityUUIDExists 判断账本内是否已存在该 uuid 的未软删币种。
func (s *Store) CommodityUUIDExists(ledgerID int64, uuid string) (bool, error) {
	var n int
	if err := s.db.QueryRow(
		`SELECT count(*) FROM commodities WHERE ledger_id=? AND uuid=? AND deleted_at IS NULL`,
		ledgerID, uuid,
	).Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}

// CommoditySymbolExists 返回同 symbol 的未软删币种 uuid；不存在返回空串。
func (s *Store) CommoditySymbolExists(ledgerID int64, symbol string) (string, error) {
	var existing string
	err := s.db.QueryRow(
		`SELECT uuid FROM commodities WHERE ledger_id=? AND symbol=? AND deleted_at IS NULL`,
		ledgerID, symbol,
	).Scan(&existing)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return existing, err
}

// SoftCommodityBySymbol 返回同 symbol 的已软删行；不存在返回 found=false。
// 用于 POST /api/commodities 命中软删行时「恢复原行」而非 INSERT
// （表级 UNIQUE(ledger_id,symbol) 使同名 INSERT 必撞唯一约束，设计 §10-2）。
func (s *Store) SoftCommodityBySymbol(ledgerID int64, symbol string) (domain.Commodity, bool, error) {
	var c domain.Commodity
	var name sql.NullString
	err := s.db.QueryRow(
		`SELECT uuid, symbol, name, "precision" FROM commodities
		 WHERE ledger_id=? AND symbol=? AND deleted_at IS NOT NULL`,
		ledgerID, symbol,
	).Scan(&c.UUID, &c.Symbol, &name, &c.Precision)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Commodity{}, false, nil
	}
	if err != nil {
		return domain.Commodity{}, false, err
	}
	c.Name = name.String
	return c, true, nil
}

// EnsureCommodity 若账本内尚无该币种则补一条默认记录（precision=2）。
// 已软删的同名币种由 ensureCommodityOn 静默跳过，绝不自动复活（AC-4.4）。
func (s *Store) EnsureCommodity(ledgerID int64, symbol string) error {
	if symbol == "" {
		return domain.Invalidf("commodity 不能为空")
	}
	return ensureCommodityOn(s.db, ledgerID, symbol)
}

// RestoreCommodity 恢复软删行：清 deleted_at、按请求更新 name/precision，
// 保留原 uuid，写 sync_log op=create（与业务行同事务），绝不 INSERT。
// name 为空表示沿用原 name；precision<=0 表示沿用原精度（本版不改进精度，D-06）。
func (s *Store) RestoreCommodity(ledgerID int64, symbol, name string, precision int) (domain.Commodity, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return domain.Commodity{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var c domain.Commodity
	var oldName sql.NullString
	err = tx.QueryRow(
		`SELECT uuid, symbol, name, "precision" FROM commodities
		 WHERE ledger_id=? AND symbol=? AND deleted_at IS NOT NULL`,
		ledgerID, symbol,
	).Scan(&c.UUID, &c.Symbol, &oldName, &c.Precision)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Commodity{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Commodity{}, err
	}
	if name == "" {
		name = oldName.String
	}
	if precision > 0 {
		c.Precision = precision
	}
	if _, err := tx.Exec(
		`UPDATE commodities SET deleted_at=NULL, name=?, "precision"=?, updated_at=datetime('now')
		 WHERE ledger_id=? AND symbol=? AND deleted_at IS NOT NULL`,
		name, c.Precision, ledgerID, symbol,
	); err != nil {
		return domain.Commodity{}, err
	}
	if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityCommodity, c.UUID, domain.OpCreate); err != nil {
		return domain.Commodity{}, err
	}
	if err := tx.Commit(); err != nil {
		return domain.Commodity{}, err
	}
	c.Name = name
	return c, nil
}

// InsertCommodity 创建币种并写 sync_log op=create。
// 同 symbol 若存在软删行（表级 UNIQUE 仍占用该 symbol），复用该行并采用请求中的
// uuid/name/precision，避免裸 UNIQUE 约束错误（离线 sync/push 兼容）；活跃行已存在
// 则返回 domain.ErrConflict，由 service 先行判为 409 commodity_exists。
func (s *Store) InsertCommodity(ledgerID int64, c domain.Commodity) error {
	if c.UUID == "" {
		c.UUID = uuid.NewString()
	}
	if c.Precision <= 0 {
		c.Precision = 2
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var existingUUID string
	var deleted sql.NullString
	err = tx.QueryRow(
		`SELECT uuid, deleted_at FROM commodities WHERE ledger_id=? AND symbol=?`,
		ledgerID, c.Symbol,
	).Scan(&existingUUID, &deleted)
	switch {
	case err == nil && deleted.Valid && deleted.String != "":
		// 软删行：复用并采用请求中的身份与元数据（离线 push 的 uuid 得到接纳）。
		if _, err := tx.Exec(
			`UPDATE commodities SET uuid=?, name=?, "precision"=?, deleted_at=NULL, updated_at=datetime('now')
			 WHERE ledger_id=? AND symbol=?`,
			c.UUID, c.Name, c.Precision, ledgerID, c.Symbol,
		); err != nil {
			return fmt.Errorf("恢复币种失败: %w", err)
		}
	case err == nil:
		return domain.ErrConflict
	case errors.Is(err, sql.ErrNoRows):
		if _, err := tx.Exec(
			`INSERT INTO commodities(ledger_id, uuid, symbol, name, precision)
			 VALUES(?, ?, ?, ?, ?)`,
			ledgerID, c.UUID, c.Symbol, c.Name, c.Precision,
		); err != nil {
			return fmt.Errorf("创建币种失败: %w", err)
		}
	default:
		return err
	}
	if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityCommodity, c.UUID, domain.OpCreate); err != nil {
		return err
	}
	return tx.Commit()
}

// ListCommodities 列出账本内未软删币种，并聚合 used / is_default（设计 §3.5 #4）。
// used 口径与删除门禁一致：默认币种 / 账户限定币种 / 交易分录 / 价格任一命中即 true。
// 各查询串行执行并即时关闭 rows，避免单连接(MaxOpenConns=1)下同时持有两结果集死锁。
func (s *Store) ListCommodities(ledgerID int64) ([]CommodityListRow, error) {
	var def sql.NullString
	if err := s.db.QueryRow(
		`SELECT default_commodity FROM ledgers WHERE id=? AND deleted_at IS NULL`, ledgerID,
	).Scan(&def); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	defaultSymbol := def.String

	out := []CommodityListRow{}
	rows, err := s.db.Query(
		`SELECT uuid, symbol, name, "precision" FROM commodities
		 WHERE ledger_id=? AND deleted_at IS NULL ORDER BY symbol`, ledgerID,
	)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var r CommodityListRow
		var name sql.NullString
		if err := rows.Scan(&r.UUID, &r.Symbol, &name, &r.Precision); err != nil {
			rows.Close()
			return nil, err
		}
		r.Name = name.String
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	accountCounts := map[string]int{}
	rows, err = s.db.Query(
		`SELECT commodity_restriction, count(*) FROM accounts
		 WHERE ledger_id=? AND deleted_at IS NULL
		   AND commodity_restriction IS NOT NULL AND commodity_restriction<>''
		 GROUP BY commodity_restriction`, ledgerID,
	)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var sym string
		var n int
		if err := rows.Scan(&sym, &n); err != nil {
			rows.Close()
			return nil, err
		}
		accountCounts[sym] = n
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	postingCounts := map[string]int{}
	rows, err = s.db.Query(
		`SELECT p.commodity, count(*) FROM postings p
		 JOIN transactions t ON t.id=p.transaction_id
		 WHERE t.ledger_id=? GROUP BY p.commodity`, ledgerID,
	)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var sym string
		var n int
		if err := rows.Scan(&sym, &n); err != nil {
			rows.Close()
			return nil, err
		}
		postingCounts[sym] = n
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	priceCounts := map[string]int{}
	rows, err = s.db.Query(`SELECT commodity, currency FROM prices WHERE ledger_id=?`, ledgerID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var commodity, currency string
		if err := rows.Scan(&commodity, &currency); err != nil {
			rows.Close()
			return nil, err
		}
		priceCounts[commodity]++
		if currency != commodity {
			priceCounts[currency]++
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	for i := range out {
		sym := out[i].Symbol
		out[i].IsDefault = sym == defaultSymbol
		out[i].Used = out[i].IsDefault || accountCounts[sym] > 0 || postingCounts[sym] > 0 || priceCounts[sym] > 0
	}
	return out, nil
}

// CommodityUsage 做 AC-4.2 的 4 类引用检查：
// ① accounts.commodity_restriction ② postings.commodity
// ③ prices.commodity / prices.currency ④ ledgers.default_commodity。
// 任一命中由 service 组装 409 commodity_in_use，绝不返回裸 SQL 错误、不静默删。
func (s *Store) CommodityUsage(ledgerID int64, symbol string) (CommodityUsageView, error) {
	var u CommodityUsageView

	var def sql.NullString
	if err := s.db.QueryRow(
		`SELECT default_commodity FROM ledgers WHERE id=? AND deleted_at IS NULL`, ledgerID,
	).Scan(&def); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return u, err
	}
	u.IsDefault = def.String == symbol

	rows, err := s.db.Query(
		`SELECT name FROM accounts
		 WHERE ledger_id=? AND deleted_at IS NULL AND commodity_restriction=? ORDER BY name`,
		ledgerID, symbol,
	)
	if err != nil {
		return u, err
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return u, err
		}
		u.AccountCount++
		if len(u.Accounts) < 5 {
			u.Accounts = append(u.Accounts, name)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return u, err
	}
	rows.Close()

	if err := s.db.QueryRow(
		`SELECT count(*) FROM postings p JOIN transactions t ON t.id=p.transaction_id
		 WHERE t.ledger_id=? AND p.commodity=?`,
		ledgerID, symbol,
	).Scan(&u.Postings); err != nil {
		return u, err
	}
	if err := s.db.QueryRow(
		`SELECT count(*) FROM prices WHERE ledger_id=? AND (commodity=? OR currency=?)`,
		ledgerID, symbol, symbol,
	).Scan(&u.Prices); err != nil {
		return u, err
	}
	return u, nil
}

// SoftDeleteCommodity 软删币种并写 sync_log op=delete（与业务行同事务）。
// 返回是否命中未软删行；未命中（不存在 / 已删）由 service 映射为幂等 404。
func (s *Store) SoftDeleteCommodity(ledgerID int64, commodityUUID string) (bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.Exec(
		`UPDATE commodities SET deleted_at=datetime('now'), updated_at=datetime('now')
		 WHERE ledger_id=? AND uuid=? AND deleted_at IS NULL`,
		ledgerID, commodityUUID,
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	if n == 0 {
		return false, nil
	}
	if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityCommodity, commodityUUID, domain.OpDelete); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

// ensureCommodityOn 在给定 executor（db 或 tx）上幂等补建币种。
//
// AC-4.4 抑制自动复活（重点）：
//   - 活跃行存在 → 跳过；
//   - 仅存在软删行 → 静默跳过（不复活、不 INSERT、不写 sync_log op=create）；
//   - 两者皆无 → 才 INSERT。
//
// 所有补建调用点（transaction / opening / account / import）都汇聚到本函数，
// 因此改这一处即可覆盖 PRD AC-4.4 列出的全部调用点，不存在第二处绕过。
func ensureCommodityOn(e execer, ledgerID int64, symbol string) error {
	var active, soft int
	if err := e.QueryRow(
		`SELECT
		   (SELECT count(*) FROM commodities WHERE ledger_id=? AND symbol=? AND deleted_at IS NULL),
		   (SELECT count(*) FROM commodities WHERE ledger_id=? AND symbol=? AND deleted_at IS NOT NULL)`,
		ledgerID, symbol, ledgerID, symbol,
	).Scan(&active, &soft); err != nil {
		return err
	}
	if active > 0 || soft > 0 {
		return nil
	}
	cuuid := uuid.NewString()
	if _, err := e.Exec(
		`INSERT INTO commodities(ledger_id, uuid, symbol, name, precision)
		 VALUES(?, ?, ?, ?, 2)`,
		ledgerID, cuuid, symbol, symbol,
	); err != nil {
		return err
	}
	if _, err := appendSyncLogOn(e, ledgerID, domain.EntityCommodity, cuuid, domain.OpCreate); err != nil {
		return err
	}
	return nil
}
