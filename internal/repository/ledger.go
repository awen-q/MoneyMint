package repository

import (
	"database/sql"
	"errors"

	"familyledger/internal/domain"
)

// ledgerOpeningDateSQL 是期初日期读出口径（设计 §7.1）：
// 优先 012 列；空值时取 MIN(最早交易, 建账日, 今日)。
const ledgerOpeningDateSQL = `COALESCE(
	NULLIF(l.opening_date, ''),
	MIN(
		COALESCE((SELECT MIN(t.date) FROM transactions t
		          WHERE t.ledger_id=l.id AND t.deleted_at IS NULL), '9999-12-31'),
		COALESCE(date(l.created_at, 'localtime'), date('now', 'localtime')),
		date('now', 'localtime')
	)
)`

// ListLedgersByUser 列出用户所属的全部有效账本及其角色，按账本 id 排序。
//
// 0.6.0：过滤 l.deleted_at IS NULL（软删账本不再返回），并附加三个行级统计
// （P1-03，additive，不新增端点）：除 owner 外成员数 / 有效账户数 / 有效交易数。
func (s *Store) ListLedgersByUser(userID int64) ([]domain.Ledger, error) {
	rows, err := s.db.Query(
		`SELECT l.id, l.name, l.default_commodity, lm.role, `+ledgerOpeningDateSQL+`,
		        COALESCE(l.created_at, ''),
		        (SELECT count(*) FROM ledger_members m2
		          WHERE m2.ledger_id=l.id AND m2.role <> 'owner'),
		        (SELECT count(*) FROM accounts a
		          WHERE a.ledger_id=l.id AND a.deleted_at IS NULL),
		        (SELECT count(*) FROM transactions t2
		          WHERE t2.ledger_id=l.id AND t2.deleted_at IS NULL)
		 FROM ledgers l JOIN ledger_members lm ON lm.ledger_id=l.id
		 WHERE lm.user_id=? AND l.deleted_at IS NULL ORDER BY l.id`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ledgers := []domain.Ledger{}
	for rows.Next() {
		var l domain.Ledger
		var commodity sql.NullString
		if err := rows.Scan(&l.ID, &l.Name, &commodity, &l.Role, &l.OpeningDate, &l.CreatedAt,
			&l.MemberCount, &l.AccountCount, &l.TransactionCount); err != nil {
			return nil, err
		}
		if commodity.Valid {
			l.DefaultCommodity = commodity.String
		}
		ledgers = append(ledgers, l)
	}
	return ledgers, rows.Err()
}

// LedgerByID 按 id 查询有效账本基本信息；软删账本视为不存在。
func (s *Store) LedgerByID(ledgerID int64) (domain.Ledger, error) {
	var l domain.Ledger
	var commodity sql.NullString
	err := s.db.QueryRow(
		`SELECT l.id, l.name, l.default_commodity, `+ledgerOpeningDateSQL+`,
		        COALESCE(l.created_at, '')
		 FROM ledgers l WHERE l.id=? AND l.deleted_at IS NULL`,
		ledgerID,
	).Scan(&l.ID, &l.Name, &commodity, &l.OpeningDate, &l.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Ledger{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Ledger{}, err
	}
	if commodity.Valid {
		l.DefaultCommodity = commodity.String
	}
	return l, nil
}

// LedgerDeleted 判断账本是否已被软删（供稳定码 ledger_deleted 区分「已删除」与「非成员」）。
// 账本不存在时返回 false，与「无权访问」语义一致。
func (s *Store) LedgerDeleted(ledgerID int64) (bool, error) {
	var deleted sql.NullString
	err := s.db.QueryRow(`SELECT deleted_at FROM ledgers WHERE id=?`, ledgerID).Scan(&deleted)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return deleted.Valid && deleted.String != "", nil
}

// CountActiveLedgers 统计用户所属且未软删的账本数（禁删最后一个账本，AC-1.6）。
func (s *Store) CountActiveLedgers(userID int64) (int64, error) {
	var n int64
	err := s.db.QueryRow(
		`SELECT count(*) FROM ledgers l JOIN ledger_members lm ON lm.ledger_id=l.id
		 WHERE lm.user_id=? AND l.deleted_at IS NULL`,
		userID,
	).Scan(&n)
	return n, err
}

// MinActiveLedgerID 返回用户所属、未软删、最小 id 的账本；没有则返回 0。
// 用于请求缺失 X-Ledger-Id 时的回退（R3），不再硬编码 DefaultLedgerID=1。
func (s *Store) MinActiveLedgerID(userID int64) (int64, error) {
	var id sql.NullInt64
	err := s.db.QueryRow(
		`SELECT MIN(l.id) FROM ledgers l JOIN ledger_members lm ON lm.ledger_id=l.id
		 WHERE lm.user_id=? AND l.deleted_at IS NULL`,
		userID,
	).Scan(&id)
	if err != nil {
		return 0, err
	}
	return id.Int64, nil
}

// ListNonOwnerMembers 列出除 owner 外的成员（409 明细用，仅含用户名/显示名）。
// 查询结果不携带密码哈希、token 等凭据。
func (s *Store) ListNonOwnerMembers(ledgerID int64) ([]domain.Member, error) {
	rows, err := s.db.Query(
		`SELECT lm.user_id, u.username, u.display_name, lm.role
		 FROM ledger_members lm JOIN users u ON u.id=lm.user_id
		 WHERE lm.ledger_id=? AND lm.role <> 'owner'
		 ORDER BY u.username`,
		ledgerID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	members := []domain.Member{}
	for rows.Next() {
		var m domain.Member
		if err := rows.Scan(&m.UserID, &m.Username, &m.DisplayName, &m.Role); err != nil {
			return nil, err
		}
		members = append(members, m)
	}
	return members, rows.Err()
}

// SoftDeleteLedger 在单事务内软删账本；返回是否命中未删除的行。
// 采用软删而非硬删，绕开 postings/transactions/accounts 的 FK 顺序依赖（AC-1.7）。
// 不写 sync_log（账本非同步实体）、不轮换 instance_id。
func (s *Store) SoftDeleteLedger(ledgerID int64) (bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.Exec(
		`UPDATE ledgers SET deleted_at=datetime('now'), updated_at=datetime('now')
		 WHERE id=? AND deleted_at IS NULL`,
		ledgerID,
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return n > 0, nil
}

// CreateLedger 事务内创建账本并让创建者成为 owner，返回新账本 id。
// 新账本期初日期默认今日（FR-01）。
func (s *Store) CreateLedger(ownerID int64, name, defaultCommodity string) (int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	res, err := tx.Exec(
		`INSERT INTO ledgers(name, owner_id, default_commodity, opening_date)
		 VALUES(?, ?, NULLIF(?,''), date('now', 'localtime'))`,
		name, ownerID, defaultCommodity,
	)
	if err != nil {
		return 0, err
	}
	ledgerID, _ := res.LastInsertId()
	if _, err := tx.Exec(
		`INSERT INTO ledger_members(ledger_id, user_id, role, invited_by) VALUES(?, ?, 'owner', ?)`,
		ledgerID, ownerID, ownerID,
	); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return ledgerID, nil
}

// UpdateLedger 更新有效账本的名称与默认币种；返回是否命中记录。
// 软删账本不可再改（AC-1.5），service 层另有 requireOwner 兜底。
func (s *Store) UpdateLedger(ledgerID int64, name, defaultCommodity string) (bool, error) {
	res, err := s.db.Exec(
		`UPDATE ledgers SET name=?, default_commodity=NULLIF(?,''), updated_at=datetime('now')
		 WHERE id=? AND deleted_at IS NULL`,
		name, defaultCommodity, ledgerID,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
