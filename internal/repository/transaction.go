package repository

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"

	"familyledger/internal/domain"
)

// ListTransactions 列出账本内所有未删除交易（含分录），按日期、id 倒序。
func (s *Store) ListTransactions(ledgerID int64) ([]domain.Transaction, error) {
	return s.listTransactions(ledgerID, false)
}

// ListDeletedTransactions 列出回收站内的交易（已软删），按删除时间、id 倒序。
//
// 与 ListTransactions 共用同一套装载逻辑，只是筛选条件相反——回收站不引入新表，
// 依赖 002_delete_semantics 引入的 deleted_at。
func (s *Store) ListDeletedTransactions(ledgerID int64) ([]domain.Transaction, error) {
	return s.listTransactions(ledgerID, true)
}

// listTransactions 是两条列表查询的共同实现（deleted=false 取未删、true 取已删）。
func (s *Store) listTransactions(ledgerID int64, deleted bool) ([]domain.Transaction, error) {
	where := "t.deleted_at IS NULL"
	order := "t.date DESC, t.id DESC"
	if deleted {
		where = "t.deleted_at IS NOT NULL"
		order = "t.deleted_at DESC, t.id DESC"
	}
	rows, err := s.db.Query(
		`SELECT `+txnListColumns+`
		 FROM transactions t
		 LEFT JOIN users u ON t.created_by = u.id
		 WHERE t.ledger_id=? AND `+where+` ORDER BY `+order,
		ledgerID,
	)
	if err != nil {
		return nil, err
	}
	txns := []domain.Transaction{}
	for rows.Next() {
		t, err := scanTransactionRow(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		txns = append(txns, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if err := s.attachPostings(txns); err != nil {
		return nil, err
	}
	return txns, nil
}

// scanTransactionRow 按 txnListColumns 的列顺序扫描一行交易主表记录。
// 列表查询与筛选查询共用，避免两处 Scan 顺序各自漂移。
func scanTransactionRow(rows *sql.Rows) (domain.Transaction, error) {
	var t domain.Transaction
	var tags sql.NullString
	var deletedAt sql.NullString
	if err := rows.Scan(
		&t.ID, &t.UUID, &t.Date, &t.Flag, &t.Description, &tags,
		&t.CreatedBy, &t.CreatedByName, &deletedAt,
		&t.ReversalOf, &t.OpeningAccountUUID, &t.OpeningVersion, &t.OpeningKey,
		&t.ReversedBy, &t.CreatedAt,
	); err != nil {
		return domain.Transaction{}, err
	}
	t.Tags = parseTags(tags)
	if deletedAt.Valid {
		t.DeletedAt = deletedAt.String
	}
	return t, nil
}

// attachPostings 按交易 id 批量装载分录并回填到各交易的 Postings。
//
// 一次 IN 查询装卸所有分录（避免 N+1）；分录顺序由 position 保证稳定，
// 与 Beancount 导出顺序一致。
func (s *Store) attachPostings(txns []domain.Transaction) error {
	if len(txns) == 0 {
		return nil
	}
	ids := make([]int64, len(txns))
	for i := range txns {
		ids[i] = txns[i].ID
	}
	query, args, err := sqlArgsIn(ids)
	if err != nil {
		return err
	}
	prows, err := s.db.Query(
		`SELECT p.transaction_id, p.account_id, a.uuid, a.name,
		        COALESCE(NULLIF(a.display_name, ''), a.name) AS display,
		        p.commodity, CAST(p.amount AS TEXT), p.position
		 FROM postings p JOIN accounts a ON a.id=p.account_id
		 WHERE p.transaction_id `+query+` ORDER BY p.transaction_id, p.position`,
		args...,
	)
	if err != nil {
		return err
	}
	defer prows.Close()

	byTxn := map[int64][]domain.Posting{}
	for prows.Next() {
		var tid int64
		var p domain.Posting
		if err := prows.Scan(&tid, &p.AccountID, &p.AccountUUID, &p.AccountName, &p.AccountDisplay, &p.Commodity, &p.Amount, &p.Position); err != nil {
			return err
		}
		byTxn[tid] = append(byTxn[tid], p)
	}
	if err := prows.Err(); err != nil {
		return err
	}
	for i := range txns {
		txns[i].Postings = byTxn[txns[i].ID]
	}
	return nil
}

// MarkTransactionReversed 把一笔交易标记为「已冲正」，仅当尚未被标记时生效。
//
// A-01：供同步 push 的 transaction op=update 兜底分支使用（不新增 op、不升协议
// 版本）。服务端三步修改事务会自行写 sync_log，这里**不写** sync_log，避免
// 旧客户端 / 运维工具重放 op=update 时重复广播。返回本次是否真正更新：
// 已处于冲正态或 uuid 不存在时返回 false，保持幂等。
func (s *Store) MarkTransactionReversed(ledgerID int64, uuid, reversalUUID string) (bool, error) {
	res, err := s.db.Exec(
		`UPDATE transactions SET reversed_by=?
		 WHERE ledger_id=? AND uuid=?
		   AND (reversed_by IS NULL OR reversed_by='')`,
		reversalUUID, ledgerID, uuid,
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// TransactionUpdateInput 是修改交易（冲正 + 新建）的落库输入。
// 权限与「不可编辑」判定在 service 层完成；本方法在同一事务内做 CAS 终审。
type TransactionUpdateInput struct {
	LedgerID     int64
	OriginalUUID string
	NewUUID      string // service 预生成（新交易绝不复用原 uuid）
	Date         string
	Flag         string
	Description  string
	Tags         []string
	Postings     []domain.Posting
	CreatedBy    int64
}

// TransactionUpdateResult 是修改交易的落库结果（三 uuid，无 version 字段）。
type TransactionUpdateResult struct {
	OriginalUUID string
	ReversalUUID string
	NewUUID      string
}

// UpdateTransaction 修改交易（0.6.0 S6，design §4.1）：单一大事务内完成
//
//  1. 事务内重读原交易并 CAS 终审（已冲正 → 409 txn_already_reversed）；
//  2. 内核生成冲正交易（分录逐条取负、reversal_of=原 uuid）→ sync_log op=create；
//  3. UPDATE 原交易 SET reversed_by（保留不软删，导出净效果=改后交易）→ sync_log op=update；
//  4. 新建改后交易（新 uuid、普通交易、created_by=uid）→ sync_log op=create。
//
// 任一步失败整体回滚（AC-5.1）。原交易不软删（export 以 deleted_at IS NULL 过滤，
// 软删会破坏净效果）。禁止复用 client_request_id（AGENTS §7：幂等由「重试命中
// 已冲正判定 → 409」兜底），新交易 clientRequestID 传空串。
func (s *Store) UpdateTransaction(in TransactionUpdateInput) (*TransactionUpdateResult, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	// 1) 事务内重读原交易（并发终审：service 判定后到本事务之间原交易可能被冲正）。
	var origID int64
	var origDate, origDesc, reversedBy, openingUUID, balanceKey, reversalOf string
	var origTags sql.NullString
	err = tx.QueryRow(
		`SELECT id, date, description, tags,
		        COALESCE(reversed_by, ''), COALESCE(opening_account_uuid, ''),
		        COALESCE(balance_key, ''), COALESCE(reversal_of, '')
		 FROM transactions
		 WHERE ledger_id=? AND uuid=? AND deleted_at IS NULL`,
		in.LedgerID, in.OriginalUUID,
	).Scan(&origID, &origDate, &origDesc, &origTags,
		&reversedBy, &openingUUID, &balanceKey, &reversalOf)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, domain.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if reversedBy != "" {
		return nil, domain.Codedf(domain.ErrConflict, domain.CodeTxnAlreadyReversed,
			"该交易已被冲正，请修改最新版本")
	}
	// service 已拦截，这里兜底：期初 / 校准 / 冲正交易一律不可编辑。
	if openingUUID != "" || balanceKey != "" || reversalOf != "" {
		return nil, domain.Codedf(domain.ErrConflict, domain.CodeTxnNotEditable,
			"期初 / 冲正 / 校准交易不能修改")
	}

	// 2) 冲正交易（S3 内核）：多币种精度映射由账本币种表提供，缺省 2 位。
	posts, err := loadAllPostingsOn(tx, origID)
	if err != nil {
		return nil, err
	}
	precMap, err := commodityPrecisionMapOn(tx, in.LedgerID)
	if err != nil {
		return nil, err
	}
	revUUID, _, err := insertReversalTxnTx(tx, in.LedgerID, ReversalSource{
		ID:                   origID,
		UUID:                 in.OriginalUUID,
		Date:                 origDate,
		Postings:             posts,
		Description:          "冲正: " + origDesc,
		PrecisionByCommodity: precMap,
		// 冲正是本次「修改交易」操作的一部分，发起人 = 当前操作人，
		// 与新交易的 CreatedBy 同源（下方 newTxn.CreatedBy 用的就是它）。
		CreatedBy: in.CreatedBy,
	})
	if err != nil {
		return nil, err
	}
	// 冲正交易的 create 事件：由本方法显式写入（内核 markReversedTx 关闭 AppendSyncLog）。
	if _, err := appendSyncLogOn(tx, in.LedgerID, domain.EntityTransaction, revUUID, domain.OpCreate); err != nil {
		return nil, err
	}

	// 3) 标记原交易已冲正（CAS；保留不软删）。sync_log op=update 指向原交易 uuid。
	if err := markReversedTx(tx, ReversalMarkInput{
		LedgerID:        in.LedgerID,
		SourceID:        origID,
		ReversalUUID:    revUUID,
		ExecErrorLabel:  "标记原交易已冲正",
		ConflictMessage: "该交易已被冲正，请修改最新版本",
		ConflictCode:    domain.CodeTxnAlreadyReversed,
		AppendSyncLog:   false,
	}); err != nil {
		return nil, err
	}
	if _, err := appendSyncLogOn(tx, in.LedgerID, domain.EntityTransaction, in.OriginalUUID, domain.OpUpdate); err != nil {
		return nil, err
	}

	// 4) 新建改后交易（新 uuid、普通交易、created_by=uid、不复用幂等键）。
	newTxn := domain.Transaction{
		UUID:        in.NewUUID,
		Date:        in.Date,
		Flag:        in.Flag,
		Description: in.Description,
		Tags:        in.Tags,
		CreatedBy:   in.CreatedBy,
		Postings:    in.Postings,
	}
	newID, inserted, err := insertTransactionRowTx(tx, in.LedgerID, newTxn, "", "", "")
	if err != nil {
		return nil, err
	}
	if !inserted {
		// 新 uuid 撞车（uuid.NewString() 理论上不可能），按冲突处理并整体回滚。
		return nil, domain.Codedf(domain.ErrConflict, domain.CodeTxnNotEditable,
			"新交易标识冲突，请重试")
	}
	for _, p := range in.Postings {
		if err := ensureCommodityOn(tx, in.LedgerID, p.Commodity); err != nil {
			return nil, err
		}
	}
	if err := insertPostingRowsTx(tx, newID, in.Postings); err != nil {
		return nil, err
	}
	if _, err := appendSyncLogOn(tx, in.LedgerID, domain.EntityTransaction, in.NewUUID, domain.OpCreate); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &TransactionUpdateResult{
		OriginalUUID: in.OriginalUUID,
		ReversalUUID: revUUID,
		NewUUID:      in.NewUUID,
	}, nil
}

// TransactionByUUID 按 uuid 查询单笔未删除交易（含分录，引用账户 uuid）。
// 0.6.0 S6：补读 balance_date / balance_key（additive），供「交易不可编辑」判定。
func (s *Store) TransactionByUUID(ledgerID int64, uuid string) (domain.Transaction, error) {
	var t domain.Transaction
	var tags sql.NullString
	err := s.db.QueryRow(
		`SELECT t.id, t.uuid, t.date, t.flag, t.description, t.tags, COALESCE(t.created_by, 0),
		        COALESCE(u.display_name, '') AS created_by_name,
		        COALESCE(t.reversal_of, ''), COALESCE(t.opening_account_uuid, ''),
		        COALESCE(t.opening_version, 0), COALESCE(t.opening_key, ''),
		        COALESCE(t.reversed_by, ''),
		        COALESCE(t.balance_date, ''), COALESCE(t.balance_key, ''),
		        COALESCE(t.tags_updated_at, '')
		 FROM transactions t
		 LEFT JOIN users u ON t.created_by = u.id
		 WHERE t.ledger_id=? AND t.uuid=? AND t.deleted_at IS NULL`,
		ledgerID, uuid,
	).Scan(&t.ID, &t.UUID, &t.Date, &t.Flag, &t.Description, &tags, &t.CreatedBy, &t.CreatedByName,
		&t.ReversalOf, &t.OpeningAccountUUID, &t.OpeningVersion, &t.OpeningKey, &t.ReversedBy,
		&t.BalanceDate, &t.BalanceKey, &t.TagsUpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Transaction{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Transaction{}, err
	}
	t.Tags = parseTags(tags)

	prows, err := s.db.Query(
		`SELECT p.account_id, a.uuid, a.name, p.commodity, CAST(p.amount AS TEXT), p.position
		 FROM postings p JOIN accounts a ON a.id=p.account_id
		 WHERE p.transaction_id=? ORDER BY p.position`, t.ID,
	)
	if err != nil {
		return domain.Transaction{}, err
	}
	defer prows.Close()
	for prows.Next() {
		var p domain.Posting
		if err := prows.Scan(&p.AccountID, &p.AccountUUID, &p.AccountName, &p.Commodity, &p.Amount, &p.Position); err != nil {
			return domain.Transaction{}, err
		}
		t.Postings = append(t.Postings, p)
	}
	return t, prows.Err()
}

// parseTags 把 tags 列的 JSON 字符串解析为标签切片（NULL/空/非法 → 空切片）。
func parseTags(tags sql.NullString) []string {
	if !tags.Valid || tags.String == "" {
		return nil
	}
	var out []string
	if err := json.Unmarshal([]byte(tags.String), &out); err != nil || out == nil {
		return nil
	}
	return out
}

// marshalTags 把标签切片序列化为 JSON 字符串（空/nil → NULL）。
func marshalTags(tags []string) any {
	if len(tags) == 0 {
		return nil
	}
	b, err := json.Marshal(tags)
	if err != nil {
		return nil
	}
	return string(b)
}

// CreateTransaction 在线创建一笔不可变交易：在事务内补建币种、写交易与分录、追加 sync_log。
// 返回新交易 id。uuid 由 service 层预生成（保证全局唯一）。
func (s *Store) CreateTransaction(ledgerID int64, txn domain.Transaction) (int64, error) {
	id, _, err := s.saveTransaction(ledgerID, txn, false)
	return id, err
}

// SavePushTransaction 幂等保存离线推送的交易：uuid 已存在则跳过（created=false）。
func (s *Store) SavePushTransaction(ledgerID int64, txn domain.Transaction) (bool, error) {
	_, created, err := s.saveTransaction(ledgerID, txn, true)
	return created, err
}

// IdempotentCreateResult 是 CreateTransactionIdempotent 的落库结果。
//
// Created=false 表示幂等键已存在（本次未新增任何行）：
//   - Deleted=true：命中的交易已软删（调用方映射 409 idempotency_key_deleted）；
//   - Hash 非空且与本次请求哈希不同：同一键被用于不同内容
//     （调用方映射 409 idempotency_payload_mismatch）。
type IdempotentCreateResult struct {
	ID       int64
	UUID     string
	Date     string
	Postings int
	Created  bool
	Deleted  bool
	Hash     string
}

// CreateTransactionIdempotent 在线创建交易，带可选客户端幂等键（G-04 / AC-23）。
//
// 关键点：绝不「先查后写」——并发重复提交只有唯一索引能挡住。
// 这里先 INSERT ... ON CONFLICT(ledger_id, client_request_id)
// （WHERE 谓词必须与部分索引一致，否则 SQLite 报 no matching unique index），
// RowsAffected=0 时在同一事务内回查既有行。
// 业务行 + postings + sync_log 始终在同一事务内提交。
func (s *Store) CreateTransactionIdempotent(
	ledgerID int64, txn domain.Transaction, clientRequestID, payloadHash string,
) (IdempotentCreateResult, error) {
	if clientRequestID == "" {
		id, err := s.CreateTransaction(ledgerID, txn)
		if err != nil {
			return IdempotentCreateResult{}, err
		}
		return IdempotentCreateResult{
			ID: id, UUID: txn.UUID, Date: txn.Date,
			Postings: len(txn.Postings), Created: true,
		}, nil
	}

	tx, err := s.db.Begin()
	if err != nil {
		return IdempotentCreateResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	txnID, inserted, err := insertTransactionRowTx(tx, ledgerID, txn, clientRequestID, payloadHash, "")
	if err != nil {
		return IdempotentCreateResult{}, err
	}
	if !inserted {
		// 幂等命中：回查既有行（含已软删），由 service 判断 200 / 409。
		res, err := lookupIdempotentTx(tx, ledgerID, clientRequestID)
		if err != nil {
			return IdempotentCreateResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return IdempotentCreateResult{}, err
		}
		return res, nil
	}

	// 只在真正新建时补建币种，避免重放请求产生多余的 commodity create 同步事件。
	for _, p := range txn.Postings {
		if err := ensureCommodityOn(tx, ledgerID, p.Commodity); err != nil {
			return IdempotentCreateResult{}, err
		}
	}
	if err := insertPostingRowsTx(tx, txnID, txn.Postings); err != nil {
		return IdempotentCreateResult{}, err
	}
	if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityTransaction, txn.UUID, domain.OpCreate); err != nil {
		return IdempotentCreateResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return IdempotentCreateResult{}, err
	}
	return IdempotentCreateResult{
		ID: txnID, UUID: txn.UUID, Date: txn.Date,
		Postings: len(txn.Postings), Created: true,
	}, nil
}

// lookupIdempotentTx 按 (ledger_id, client_request_id) 读取既有交易。
// 使用 COALESCE 保证已软删行也能读到；行一定存在（唯一索引刚刚拒绝插入）。
func lookupIdempotentTx(tx *sql.Tx, ledgerID int64, clientRequestID string) (IdempotentCreateResult, error) {
	var res IdempotentCreateResult
	var deletedAt, hash sql.NullString
	err := tx.QueryRow(
		`SELECT id, uuid, date, deleted_at, COALESCE(client_payload_hash, '')
		 FROM transactions WHERE ledger_id=? AND client_request_id=?`,
		ledgerID, clientRequestID,
	).Scan(&res.ID, &res.UUID, &res.Date, &deletedAt, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return IdempotentCreateResult{}, fmt.Errorf("幂等键 %q 冲突但回查不到既有交易", clientRequestID)
	}
	if err != nil {
		return IdempotentCreateResult{}, err
	}
	res.Deleted = deletedAt.Valid
	res.Hash = hash.String
	if err := tx.QueryRow(
		`SELECT count(*) FROM postings WHERE transaction_id=?`, res.ID,
	).Scan(&res.Postings); err != nil {
		return IdempotentCreateResult{}, err
	}
	return res, nil
}

// saveTransaction 是 CreateTransaction / SavePushTransaction 的公共实现。
func (s *Store) saveTransaction(ledgerID int64, txn domain.Transaction, idempotent bool) (int64, bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, false, err
	}
	defer tx.Rollback()

	if idempotent {
		var n int
		if err := tx.QueryRow(
			`SELECT count(*) FROM transactions WHERE ledger_id=? AND uuid=?`,
			ledgerID, txn.UUID,
		).Scan(&n); err != nil {
			return 0, false, err
		}
		if n > 0 {
			_ = tx.Commit()
			return 0, false, nil // 已存在（幂等）
		}
	}

	for _, p := range txn.Postings {
		if err := ensureCommodityOn(tx, ledgerID, p.Commodity); err != nil {
			return 0, false, err
		}
	}

	// 在线/离线 push 路径都不带 client_request_id：由 service 保证冲正/期初
	// 沿用 opening_key，不复用本幂等键（语义不同，混用会吞掉合法交易）。
	txnID, _, err := insertTransactionRowTx(tx, ledgerID, txn, "", "", "")
	if err != nil {
		return 0, false, err
	}
	if err := insertPostingRowsTx(tx, txnID, txn.Postings); err != nil {
		return 0, false, err
	}
	if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityTransaction, txn.UUID, domain.OpCreate); err != nil {
		return 0, false, err
	}
	if err := tx.Commit(); err != nil {
		return 0, false, err
	}
	return txnID, true, nil
}

// insertTransactionRowTx 写入交易主行，返回 (id, 是否插入)。
//
// clientRequestID 非空时附带部分唯一索引的 upsert 谓词：重复提交时
// ON CONFLICT DO NOTHING 命中，inserted=false，由调用方回查既有行。
func insertTransactionRowTx(
	tx *sql.Tx, ledgerID int64, txn domain.Transaction, clientRequestID, payloadHash, importBatchID string,
) (int64, bool, error) {
	var createdBy any
	if txn.CreatedBy != 0 {
		createdBy = txn.CreatedBy
	}
	res, err := tx.Exec(
		`INSERT INTO transactions
		 (ledger_id, uuid, date, flag, description, tags, created_by, reversal_of,
		  client_request_id, client_payload_hash, import_batch_id)
		 VALUES(?, ?, ?, ?, ?, ?, ?, NULLIF(?,''), NULLIF(?,''), NULLIF(?,''), NULLIF(?,''))
		 ON CONFLICT(ledger_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING`,
		ledgerID, txn.UUID, txn.Date, txn.Flag, txn.Description, marshalTags(txn.Tags),
		createdBy, txn.ReversalOf, clientRequestID, payloadHash, importBatchID,
	)
	if err != nil {
		return 0, false, fmt.Errorf("写入交易失败: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, false, err
	}
	if n == 0 {
		return 0, false, nil
	}
	id, _ := res.LastInsertId()
	return id, true, nil
}

// insertPostingRowsTx 写入分录（币种补建由调用方按需提前完成）。
func insertPostingRowsTx(tx *sql.Tx, txnID int64, postings []domain.Posting) error {
	for i, p := range postings {
		if _, err := tx.Exec(
			`INSERT INTO postings(transaction_id, account_id, commodity, amount, position)
			 VALUES(?, ?, ?, ?, ?)`,
			txnID, p.AccountID, p.Commodity, p.Amount, i,
		); err != nil {
			return fmt.Errorf("写入分录失败(账户 %d): %w", p.AccountID, err)
		}
	}
	return nil
}

// RestoreTransaction 从回收站恢复一笔交易：清空 deleted_at，并写 sync_log op=create
// 让其他设备重新拉回这笔交易（客户端只认 create/delete/update/close 四种 op，
// 恢复复用 create 语义，不引入新 op，旧客户端也能正确合并）。
// 幂等：不存在或未删除返回 false。
//
// 「业务 UPDATE + sync_log 追加」在同一事务内：若 sync_log 写失败而 UPDATE 已生效，
// 其他设备永远拉不到这笔恢复，账本会出现「本地可见、远端不可见」的静默不一致。
func (s *Store) RestoreTransaction(ledgerID int64, uuid string) (bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.Exec(
		`UPDATE transactions SET deleted_at=NULL
		 WHERE ledger_id=? AND uuid=? AND deleted_at IS NOT NULL`,
		ledgerID, uuid,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return false, nil
	}
	if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityTransaction, uuid, domain.OpCreate); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

// ClosedAccountsOfTransaction 返回该交易分录引用到的「已关闭」账户名。
//
// 恢复前必须检查：记账不允许引用已关闭账户（0.4-A 起的约束），
// 否则恢复出来的交易会是一条账本内无法新建、却能通过导出校验的脏数据。
// 返回展示名优先（「现金」比 `Assets:Cash` 更适合直接弹给用户看）。
func (s *Store) ClosedAccountsOfTransaction(ledgerID int64, uuid string) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT DISTINCT COALESCE(NULLIF(a.display_name, ''), a.name) AS label
		 FROM postings p
		 JOIN transactions t ON t.id = p.transaction_id
		 JOIN accounts a ON a.id = p.account_id
		 WHERE t.ledger_id=? AND t.uuid=? AND a.close_date IS NOT NULL
		 ORDER BY label`,
		ledgerID, uuid,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// SoftDeleteTransaction 软删一笔交易并写 sync_log delete。幂等：已删/不存在返回 false。
//
// 与 RestoreTransaction 同理：UPDATE 与 sync_log 必须同事务，
// 否则删除对本地生效、其他设备却收不到 delete 事件。
func (s *Store) SoftDeleteTransaction(ledgerID int64, uuid string) (bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.Exec(
		`UPDATE transactions SET deleted_at=datetime('now')
		 WHERE ledger_id=? AND uuid=? AND deleted_at IS NULL`,
		ledgerID, uuid,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return false, nil
	}
	if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityTransaction, uuid, domain.OpDelete); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

// CloseAccountChecked 在事务内校验余额并关闭账户（Beancount close 语义）。
// 余额非 0 时不关闭，返回按币种的差额明细（调用方映射为 409）；
// 余额为 0 时置 close_date、写 sync_log op=close。
// 返回：closed=true 表示本次成功关闭；closed=false 且 diffs 为空表示不存在/已关闭（幂等）。
func (s *Store) CloseAccountChecked(ledgerID int64, uuid string) (bool, []domain.BalanceDiff, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var closeDate sql.NullString
	err = tx.QueryRow(
		`SELECT close_date FROM accounts
		 WHERE ledger_id=? AND uuid=? AND deleted_at IS NULL`,
		ledgerID, uuid,
	).Scan(&closeDate)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil, nil
	}
	if err != nil {
		return false, nil, err
	}
	if closeDate.Valid {
		return false, nil, nil // 已关闭：幂等
	}

	sums, err := accountBalanceRatsOn(tx, ledgerID, uuid)
	if err != nil {
		return false, nil, err
	}
	prec, err := commodityPrecisionMapOn(tx, ledgerID)
	if err != nil {
		return false, nil, err
	}
	var diffs []domain.BalanceDiff
	for commodity, sum := range sums {
		if sum.Sign() == 0 {
			continue
		}
		p := prec[commodity]
		if p <= 0 {
			p = 2
		}
		diffs = append(diffs, domain.BalanceDiff{Commodity: commodity, Amount: sum.FloatString(p)})
	}
	if len(diffs) > 0 {
		sortDiffByCommodity(diffs)
		return false, diffs, nil // 未提交，事务回滚；账户保持打开
	}

	res, err := tx.Exec(
		`UPDATE accounts SET close_date=date('now'), updated_at=datetime('now')
		 WHERE ledger_id=? AND uuid=? AND close_date IS NULL AND deleted_at IS NULL`,
		ledgerID, uuid,
	)
	if err != nil {
		return false, nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return false, nil, nil // 并发已关闭
	}
	if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityAccount, uuid, domain.OpClose); err != nil {
		return false, nil, err
	}
	if err := tx.Commit(); err != nil {
		return false, nil, err
	}
	return true, nil, nil
}

// sqlArgsIn 为 IN 子句生成占位符与参数。
func sqlArgsIn(ids []int64) (string, []any, error) {
	if len(ids) == 0 {
		return "", nil, errors.New("empty ids")
	}
	ph := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		ph[i] = "?"
		args[i] = id
	}
	return "IN (" + strings.Join(ph, ",") + ")", args, nil
}

// ---------------------------------------------------------------------------
// 标签原地更新（注解层；与经济事实冲正路径物理隔离）
// ---------------------------------------------------------------------------
//
// 本段是 P0 唯一新增的交易写入通道。红线：
//   - UPDATE 的 SET 列表只允许 tags 与 tags_updated_at；
//   - uuid 不变、绝不 INSERT 交易、绝不写 reversed_by / deleted_at / postings；
//   - 审计行与 sync_log op=update 必须与 UPDATE 在同一事务内提交。

// TagsUpdateInput 是标签原地更新的落库输入。
//
// Tags / BaseTags 由 service 层规范化（权威口径）；BaseTags 用于事务内 CAS 终审，
// 防止 service 判定之后、本事务开始之前原交易被改（TOCTOU）。
// ClientOpID 为 P1 离线批次去重键，P0 在线调用传空串。
type TagsUpdateInput struct {
	LedgerID   int64
	EntityUUID string
	Tags       []string
	BaseTags   []string
	ActorID    int64
	DeviceID   string
	ClientOpID string
}

// TagsUpdateResult 是标签原地更新的落库结果。
type TagsUpdateResult struct {
	UUID          string
	Tags          []string
	TagsUpdatedAt string
	EditID        int64 // tag_edit_log.id
}

// TagsConflict 表示事务内 CAS 终审失败（当前标签集合已变）。
// service 把它映射为 409 txn_tags_conflict，并把两个字段回给客户端供重试。
type TagsConflict struct {
	CurrentTags          []string
	CurrentTagsUpdatedAt string
}

// Error 实现 error 接口。
func (e *TagsConflict) Error() string { return "标签已被他人更新" }

// UpdateTagsTx 在单一事务内完成「CAS 终审 → 原地 UPDATE → 审计 → sync_log」。
//
// 判定顺序与 UpdateTransaction 逐字同序：已冲正 → 系统交易 → CAS → 落库；
// 权限与载荷校验在 service 层完成，这里只做并发终审（不重复判定角色）。
// 任一步失败整体回滚，绝不会产生「标签改了但没审计 / 没同步」的半成品。
func (s *Store) UpdateTagsTx(in TagsUpdateInput) (*TagsUpdateResult, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	// 1) 事务内重读原交易（含全部不可编辑身份列）。
	var id int64
	var tagsRaw sql.NullString
	var tagsUpdatedAt, reversedBy, openingUUID, balanceKey, reversalOf string
	err = tx.QueryRow(
		`SELECT id, tags, COALESCE(tags_updated_at, ''),
		        COALESCE(reversed_by, ''), COALESCE(opening_account_uuid, ''),
		        COALESCE(balance_key, ''), COALESCE(reversal_of, '')
		 FROM transactions
		 WHERE ledger_id=? AND uuid=? AND deleted_at IS NULL`,
		in.LedgerID, in.EntityUUID,
	).Scan(&id, &tagsRaw, &tagsUpdatedAt, &reversedBy, &openingUUID, &balanceKey, &reversalOf)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, domain.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if reversedBy != "" {
		return nil, domain.Codedf(domain.ErrConflict, domain.CodeTxnAlreadyReversed,
			"该交易已被冲正，请修改最新版本")
	}
	if openingUUID != "" || balanceKey != "" || reversalOf != "" {
		return nil, domain.Codedf(domain.ErrConflict, domain.CodeTxnNotEditable,
			"期初 / 冲正 / 校准交易不能修改")
	}

	// 2) CAS 终审：两侧都用与 service 相同的规范化规则，避免调用方
	// 传来的快照带空白/乱序/重复时造成伪冲突（service 通常已规范化，这里
	// 再归一化一次是防御性冗余，不是安全边界的替代）。
	curTags := normalizeTagsForCAS(parseTags(tagsRaw))
	baseTags := normalizeTagsForCAS(in.BaseTags)
	if !slices.Equal(curTags, baseTags) {
		return nil, &TagsConflict{CurrentTags: curTags, CurrentTagsUpdatedAt: tagsUpdatedAt}
	}

	// 2.1) P1 去重预留：client_op_id 命中则不重复写审计 / sync_log。
	// P0 在线调用恒传空串，走不到这里。
	if in.ClientOpID != "" {
		var existingID int64
		err := tx.QueryRow(
			`SELECT id FROM tag_edit_log WHERE ledger_id=? AND client_op_id=?`,
			in.LedgerID, in.ClientOpID,
		).Scan(&existingID)
		if err == nil {
			if err := tx.Commit(); err != nil {
				return nil, err
			}
			return &TagsUpdateResult{
				UUID: in.EntityUUID, Tags: curTags,
				TagsUpdatedAt: tagsUpdatedAt, EditID: existingID,
			}, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
	}

	// 3) 原地 UPDATE：SET 列表只有 tags + tags_updated_at（代码审查红线）。
	target := append([]string(nil), in.Tags...)
	res, err := tx.Exec(
		`UPDATE transactions SET tags=?, tags_updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
		 WHERE id=? AND (reversed_by IS NULL OR reversed_by='')`,
		marshalTags(target), id,
	)
	if err != nil {
		return nil, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n == 0 {
		// 并发：本事务重读之后、UPDATE 之前原交易被冲正或被他人改标签。
		return nil, &TagsConflict{CurrentTags: curTags, CurrentTagsUpdatedAt: tagsUpdatedAt}
	}
	var updatedAt string
	if err := tx.QueryRow(`SELECT tags_updated_at FROM transactions WHERE id=?`, id).Scan(&updatedAt); err != nil {
		return nil, err
	}

	// 4) 审计（old→new，服务端归因 actor_id）。空数组落库为 '[]' 而非 NULL，
	// 保证 tag_edit_log 的 NOT NULL DEFAULT '[]' 契约、响应始终是 []。
	editRes, err := tx.Exec(
		`INSERT INTO tag_edit_log
		 (ledger_id, entity_uuid, action, old_tags, new_tags, actor_id, device_id, client_op_id, ts)
		 VALUES(?, ?, 'replace', ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
		in.LedgerID, in.EntityUUID, marshalTagsJSON(curTags), marshalTagsJSON(target),
		in.ActorID, in.DeviceID, in.ClientOpID,
	)
	if err != nil {
		return nil, err
	}
	editID, err := editRes.LastInsertId()
	if err != nil {
		return nil, err
	}

	// 5) 出站同步意图：op=update 指向原 uuid；payload 在 pull 时由 loadEntity 现取现组装。
	if _, err := appendSyncLogOn(tx, in.LedgerID, domain.EntityTransaction, in.EntityUUID, domain.OpUpdate); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &TagsUpdateResult{
		UUID: in.EntityUUID, Tags: target,
		TagsUpdatedAt: updatedAt, EditID: editID,
	}, nil
}

// normalizeTagsForCAS 是仓库层的 CAS 规范化，规则与 service.canonicalTags 逐字一致：
// trim → 丢空 → 精确去重（大小写敏感）→ 排序。不做长度/黑名单校验——库里的
// 历史标签可能不符合新规则，校验失败会让 CAS 永远无法通过。
func normalizeTagsForCAS(tags []string) []string {
	out := make([]string, 0, len(tags))
	seen := make(map[string]bool, len(tags))
	for _, t := range tags {
		t = strings.TrimSpace(t)
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

// marshalTagsJSON 把标签数组序列化为 JSON 字符串；空数组落库为 '[]'。
// 与 marshalTags（空→NULL，用于 transactions.tags）不同：审计列是 NOT NULL。
func marshalTagsJSON(tags []string) string {
	if len(tags) == 0 {
		return "[]"
	}
	b, err := json.Marshal(tags)
	if err != nil {
		return "[]"
	}
	return string(b)
}

// TagEditsByUUID 按 uuid 倒序取标签编辑审计（默认最多 50 条，与 B7 purge_log 同口径）。
// 审计不写 sync_log、不进 loadEntity，只在二级面板按需 GET。
func (s *Store) TagEditsByUUID(ledgerID int64, uuid string, limit int) ([]domain.TagEditLog, error) {
	if limit <= 0 || limit > 50 {
		limit = 50
	}
	rows, err := s.db.Query(
		`SELECT l.id, l.ledger_id, l.entity_uuid, l.action, l.old_tags, l.new_tags,
		        l.actor_id, COALESCE(u.display_name, ''), l.device_id, l.client_op_id, l.ts
		 FROM tag_edit_log l LEFT JOIN users u ON l.actor_id=u.id
		 WHERE l.ledger_id=? AND l.entity_uuid=?
		 ORDER BY l.id DESC LIMIT ?`,
		ledgerID, uuid, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.TagEditLog{}
	for rows.Next() {
		var e domain.TagEditLog
		var oldRaw, newRaw sql.NullString
		if err := rows.Scan(&e.ID, &e.LedgerID, &e.EntityUUID, &e.Action, &oldRaw, &newRaw,
			&e.ActorID, &e.ActorName, &e.DeviceID, &e.ClientOpID, &e.Ts); err != nil {
			return nil, err
		}
		e.OldTags = parseTags(oldRaw)
		e.NewTags = parseTags(newRaw)
		if e.OldTags == nil {
			e.OldTags = []string{}
		}
		if e.NewTags == nil {
			e.NewTags = []string{}
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
