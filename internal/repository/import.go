package repository

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strings"

	"familyledger/internal/beancount"
	"familyledger/internal/domain"

	"github.com/google/uuid"
)

// ImportTarget 是导入目标模式。
const (
	// ImportTargetCurrent 导入到「当前账本」：复用既有同名账户 / 币种，写入指定 ledgerID。
	ImportTargetCurrent = "current"
	// ImportTargetNew 沿用既有行为：按 owner 维度新建独立账本。
	ImportTargetNew = "new"
)

// PadBalancePreview 是预检中 pad/balance 指令的结构化呈现（含按当前账本重算的差额）。
type PadBalancePreview struct {
	Line         int    `json:"line"`
	Type         string `json:"type"` // pad | balance
	Account      string `json:"account"`
	TargetAmount string `json:"target_amount"`
	Cumulative   string `json:"cumulative"`
	Diff         string `json:"diff"`
}

// ImportConflict 是一条预检冲突（逐行号与原因）。
type ImportConflict struct {
	Line   int    `json:"line"`
	Type   string `json:"type"` // account_conflict | commodity_conflict | undeclared_account | unbalanced
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// ImportWarning 是一条预检警告（只提示、不阻断导入，不进 Conflicts）。
// 典型场景：负债账户导入后余额为正，疑似符号方向填反。
type ImportWarning struct {
	Line    int    `json:"line"`
	Account string `json:"account"`
	Message string `json:"message"`
}

// ImportAnalysis 是导入预检的只读分析结果（不写库）。
type ImportAnalysis struct {
	Valid            bool                `json:"valid"`
	Code             string              `json:"code,omitempty"`
	Error            string              `json:"error,omitempty"`
	NewAccounts      int                 `json:"new_accounts"`
	ReuseAccounts    int                 `json:"reuse_accounts"`
	NewTransactions  int                 `json:"new_transactions"`
	SkipTransactions int                 `json:"skip_transactions"`
	NewCommodities   int                 `json:"new_commodities"`
	PadBalance       []PadBalancePreview `json:"pad_balance"`
	Conflicts        []ImportConflict    `json:"conflicts"`
	// Warnings 是非阻断性警告清单（additive；如负债正余额疑似符号填反）。
	Warnings []ImportWarning `json:"warnings"`
}

// ImportResult 是导入执行结果（两种模式共用，mode 区分）。
type ImportResult struct {
	Mode              string `json:"mode"` // current | new
	LedgerID          int64  `json:"ledger_id"`
	LedgerName        string `json:"ledger_name"`
	ImportBatchID     string `json:"import_batch_id"`
	CreatedTransactions int  `json:"created_transactions"`
	SkippedTransactions int `json:"skipped_transactions"`
	ReusedAccounts    int    `json:"reused_accounts"`
	NewAccounts       int    `json:"new_accounts"`
	NewCommodities    int    `json:"new_commodities"`
	// NewPrices 是本批实际新建价格行数（QA DEF-2：价格幂等后与 p.Prices 去重结果一致；
	// additive 字段，0.6.0 新增，旧客户端可忽略）。
	NewPrices int `json:"new_prices,omitempty"`
}

// ImportUndoResult 是批次撤销结果（硬删本批新建实体 + 本批交易）。
type ImportUndoResult struct {
	RemovedTransactions int `json:"removed_transactions"`
	RemovedPostings     int `json:"removed_postings"`
	RemovedPrices       int `json:"removed_prices"`
	RemovedAccounts     int `json:"removed_accounts"`
	RemovedCommodities  int `json:"removed_commodities"`
}

// ImportBeancountToLedger 是 S5 执行体：按 target 把一份已通过 beancount.Parse 的
// 结果写入「当前账本」(target=current) 或「新建账本」(target=new)。
//
// 单一大事务（AC-6.10：失败整体回滚）。必须先经 AnalyzeImport 校验通过（同事务内
// 再次校验，保证预检与执行一致）；target=current 遇 pad/balance 整体拒绝
// （import_pad_balance_unsupported）；target=new 的 pad 展开为普通 * 交易、balance
// 转导入后自检。每个交易写 sync_log op=create；不轮换 instance_id；created_by=owner。
//
// 必须传入 Errors 为空的解析结果——本方法不重复做语法校验。
func (s *Store) ImportBeancountToLedger(
	ledgerID, ownerID int64, p *beancount.ParseResult, target, batchID string,
) (*ImportResult, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	switch target {
	case ImportTargetNew:
		// 新建账本：在「当前事务」内先建账本与成员，再写入内容。
		base := p.Title
		if base == "" {
			base = "导入账本"
		}
		name := uniqueLedgerNameTx(tx, ownerID, base)
		res, err := tx.Exec(
			`INSERT INTO ledgers(name, owner_id, default_commodity, opening_date)
			 VALUES(?, ?, NULLIF(?,'') , date('now','localtime'))`,
			name, ownerID, p.Currency,
		)
		if err != nil {
			return nil, fmt.Errorf("建账本: %w", err)
		}
		newLedgerID, _ := res.LastInsertId()
		if _, err := tx.Exec(
			`INSERT INTO ledger_members(ledger_id, user_id, role, invited_by) VALUES(?, ?, 'owner', ?)`,
			newLedgerID, ownerID, ownerID,
		); err != nil {
			return nil, fmt.Errorf("建账本成员: %w", err)
		}
		result, err := s.importIntoLedgerOn(tx, newLedgerID, ownerID, p, batchID, ImportTargetNew)
		if err != nil {
			return nil, err
		}
		result.Mode = ImportTargetNew
		result.LedgerName = name
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return result, nil
	default:
		// target=current（默认）：写入指定 ledgerID。
		result, err := s.importIntoLedgerOn(tx, ledgerID, ownerID, p, batchID, ImportTargetCurrent)
		if err != nil {
			return nil, err
		}
		result.Mode = ImportTargetCurrent
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return result, nil
	}
}

// importIntoLedgerOn 在给定事务内执行导入内容（账户/币种/价格/交易，含 pad/balance
// 处理）。调用方负责建账本（target=new）与提交/回滚。
func (s *Store) importIntoLedgerOn(
	tx *sql.Tx, ledgerID, ownerID int64, p *beancount.ParseResult, batchID, target string,
) (*ImportResult, error) {
	result := &ImportResult{LedgerID: ledgerID, ImportBatchID: batchID}

	// 0) 同事务内再次校验（与 AnalyzeImport 共用同一套口径，保证预检与执行一致）：
	// 借贷不平 / 账户类型与币种限制冲突 / 币种精度冲突 / target=current 含 pad/balance
	// 一律在此拦截，任何写入发生之前（单一大事务整体拒绝，AC-6.10）。
	a, aerr := s.analyzeImportOn(tx, ledgerID, p, target)
	if aerr != nil {
		return nil, aerr
	}
	if !a.Valid {
		reason := "导入预检未通过，已整体拒绝"
		if len(a.Conflicts) > 0 && a.Conflicts[0].Reason != "" {
			reason = a.Conflicts[0].Reason
		}
		code := a.Code
		if code == "" {
			code = domain.CodeImportUnbalanced
		}
		return nil, domain.Codedf(domain.ErrConflict, code, "%s（共 %d 处冲突）", reason, len(a.Conflicts))
	}

	// 1) 账户：建立 name -> id 映射，按目标账本复用或新建。
	acctID := make(map[string]int64, len(p.Accounts))
	newAccounts, reuseAccounts := 0, 0
	for _, a := range p.Accounts {
		existingID, existingUUID, found, closed, aType, restr, err := accountByNameTx(tx, ledgerID, a.Name)
		if err != nil {
			return nil, err
		}
		if found {
			// 复用既有同名账户（AC-6.3）。类型 / 币种限制 / 关闭三处冲突已在
			// AnalyzeImport 预检拦截，这里只做幂等复用；若仍冲突（并发），直接报错。
			if closed {
				return nil, domain.Codedf(domain.ErrConflict, domain.CodeImportAccountConflict,
					"同名账户 %s 已关闭，不能复用", a.Name)
			}
			acctID[a.Name] = existingID
			reuseAccounts++
			_ = existingUUID
			_ = aType
			_ = restr
			continue
		}
		auuid := uuid.NewString()
		res, err := tx.Exec(
			`INSERT INTO accounts(ledger_id, uuid, name, type, open_date, close_date, commodity_restriction)
			 VALUES(?, ?, ?, ?, ?, NULLIF(?,'') , NULLIF(?,'') )`,
			ledgerID, auuid, a.Name, accountType(a.Name), a.OpenDate, a.CloseDate, a.Commodity,
		)
		if err != nil {
			return nil, fmt.Errorf("建账户 %s: %w", a.Name, err)
		}
		id, _ := res.LastInsertId()
		acctID[a.Name] = id
		if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityAccount, auuid, domain.OpCreate); err != nil {
			return nil, err
		}
		// 本批新建（非复用）账户登记 manifest（QA DEF-1：撤销据此精确删）。
		if err := appendBatchEntityTx(tx, ledgerID, batchID, "account", auuid); err != nil {
			return nil, err
		}
		newAccounts++
	}
	result.NewAccounts = newAccounts
	result.ReusedAccounts = reuseAccounts

	// 2) 币种：文件声明的 + 价格涉及的，全部确保存在（按精度声明新建）。
	//    「本批新建」的币种一律登记进 manifest（QA DEF-1：撤销据此精确删）。
	for _, c := range p.Commodities {
		sym := c.Symbol
		if sym == "" {
			sym = c.Name
		}
		if sym == "" {
			continue
		}
		prec := 2
		if v, ok := parsePrecision(c.Prec); ok && v > 0 {
			prec = v
		}
		created, cerr := ensureCommodityWithMetaTx(tx, ledgerID, sym, c.Name, prec)
		if cerr != nil {
			return nil, cerr
		}
		if created {
			// created=true 即本事务全新 INSERT（既有行 / 软删行不会走到这里），
			// 回读 uuid 登记 manifest。
			var cu string
			if err := tx.QueryRow(
				`SELECT uuid FROM commodities WHERE ledger_id=? AND symbol=? AND deleted_at IS NULL`,
				ledgerID, sym,
			).Scan(&cu); err != nil {
				return nil, err
			}
			if err := appendBatchEntityTx(tx, ledgerID, batchID, "commodity", cu); err != nil {
				return nil, err
			}
			result.NewCommodities++
		}
	}
	for _, pr := range p.Prices {
		if err := ensureCommodityBatchOn(tx, ledgerID, pr.Commodity, batchID); err != nil {
			return nil, err
		}
		if err := ensureCommodityBatchOn(tx, ledgerID, pr.Currency, batchID); err != nil {
			return nil, err
		}
	}

	// 3) 价格（QA DEF-2：幂等——按 (ledger_id, commodity, currency, date, rate)
	//    存在性检查，命中即跳过不重插；rate 为 TEXT 全等比对，重复导入同一文件
	//    时字面量一致必然命中。计数如实：跳过的不进 manifest、不写 create 事件）。
	for _, pr := range p.Prices {
		var dup int
		if err := tx.QueryRow(
			`SELECT count(*) FROM prices
			 WHERE ledger_id=? AND commodity=? AND currency=? AND date=? AND rate=?`,
			ledgerID, pr.Commodity, pr.Currency, pr.Date, pr.Amount,
		).Scan(&dup); err != nil {
			return nil, err
		}
		if dup > 0 {
			continue
		}
		puuid := uuid.NewString()
		if _, err := tx.Exec(
			`INSERT INTO prices(ledger_id, uuid, commodity, currency, date, rate, source)
			 VALUES(?, ?, ?, ?, ?, ?, 'import')`,
			ledgerID, puuid, pr.Commodity, pr.Currency, pr.Date, pr.Amount,
		); err != nil {
			return nil, fmt.Errorf("建价格: %w", err)
		}
		if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityPrice, puuid, domain.OpCreate); err != nil {
			return nil, err
		}
		if err := appendBatchEntityTx(tx, ledgerID, batchID, "price", puuid); err != nil {
			return nil, err
		}
		result.NewPrices++
	}

	// 4) 交易 + 分录（逐笔借贷平衡校验 + 确定性幂等去重）。
	for _, t := range p.Transactions {
		// 分录引用的账户必须已声明（文件内声明或既有账本复用）。
		for _, ps := range t.Postings {
			if _, ok := acctID[ps.Account]; !ok {
				return nil, domain.Codedf(domain.ErrConflict, domain.CodeImportAccountConflict,
					"第 %d 行交易引用了未声明的账户 %s", t.Line, ps.Account)
			}
		}
		// 确保各分录币种存在（本批新建的登记 manifest）。
		for _, ps := range t.Postings {
			if ps.Commodity != "" {
				if err := ensureCommodityBatchOn(tx, ledgerID, ps.Commodity, batchID); err != nil {
					return nil, err
				}
			}
		}

		tuuid := uuid.NewString()
		desc := t.Narration
		if t.Payee != "" {
			if desc == "" {
				desc = t.Payee
			} else {
				desc = t.Payee + " " + t.Narration
			}
		}
		flag := t.Flag
		if flag == "" {
			flag = "*"
		}
		txn := domain.Transaction{
			UUID:        tuuid,
			Date:        t.Date,
			Flag:        flag,
			Description: desc,
			Tags:        t.Tags,
			CreatedBy:   ownerID,
		}
		postings := make([]domain.Posting, 0, len(t.Postings))
		for i, ps := range t.Postings {
			postings = append(postings, domain.Posting{
				AccountID: acctID[ps.Account],
				Commodity: ps.Commodity,
				Amount:    ps.Amount,
				Position:  i,
			})
		}
		txn.Postings = postings

		// D-10：确定性 client_request_id，复用 013 索引的 ON CONFLICT DO NOTHING。
		clientRequestID := normalizeImportTxn(t)
		txnID, inserted, err := insertTransactionRowTx(tx, ledgerID, txn, clientRequestID, "", batchID)
		if err != nil {
			return nil, fmt.Errorf("建交易 %s: %w", t.Date, err)
		}
		if !inserted {
			// 命中幂等键：跳过该笔，绝不拿 txnID=0 插分录（R2 防半批）。
			result.SkippedTransactions++
			continue
		}
		if err := insertPostingRowsTx(tx, txnID, postings); err != nil {
			return nil, fmt.Errorf("建分录: %w", err)
		}
		if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityTransaction, tuuid, domain.OpCreate); err != nil {
			return nil, err
		}
		result.CreatedTransactions++
	}

	// 5) pad / balance 处理（仅 target=new 展开；target=current 已预检拒绝）。
	if target == ImportTargetNew {
		if err := s.expandPadBalanceOn(tx, ledgerID, ownerID, p, batchID, result); err != nil {
			return nil, err
		}
	}

	return result, nil
}

// expandPadBalanceOn 处理 target=new 的 pad / balance（D-11 / C-02 / 主理人裁定 3）：
//   - pad 展开为普通 * 交易，差额 = 目标值(0) − 截至断言日初累计；
//   - balance 转成导入后自检（断言不落库、不导出），不匹配则整体拒绝。
//
// 先计算「正常交易全部写入后」各账户余额（date < '' = 全量），再据此展开。
func (s *Store) expandPadBalanceOn(
	tx *sql.Tx, ledgerID, ownerID int64, p *beancount.ParseResult, batchID string, result *ImportResult,
) error {
	if len(p.PadBalances) == 0 {
		return nil
	}
	balances, err := computeBalancesOn(tx, ledgerID, "")
	if err != nil {
		return err
	}
	// 权益对手方（与期初同源的 Equity:Opening-Balances）。若由本批首次补种，
	// 该账户同样属于「本批新建」，登记 manifest（target=new 撤销时一并精确删）。
	equityDate := p.Title
	if equityDate == "" {
		equityDate = defaultOpeningDateOn(tx, ledgerID)
	}
	_, _, equityFound, _, _, _, err := accountByNameTx(tx, ledgerID, domain.OpeningEquityName)
	if err != nil {
		return err
	}
	equityID, err := ensureOpeningEquityTx(tx, ledgerID, equityDate)
	if err != nil {
		return fmt.Errorf("展开 pad/balance 准备权益账户: %w", err)
	}
	if !equityFound {
		var eu string
		if err := tx.QueryRow(`SELECT uuid FROM accounts WHERE id=?`, equityID).Scan(&eu); err != nil {
			return err
		}
		if err := appendBatchEntityTx(tx, ledgerID, batchID, "account", eu); err != nil {
			return err
		}
	}

	for _, pb := range p.PadBalances {
		aid, _, found, _, _, _, err := accountByNameTx(tx, ledgerID, pb.Account)
		if err != nil {
			return err
		}
		if !found {
			return domain.Codedf(domain.ErrConflict, domain.CodeImportAccountConflict,
				"第 %d 行 %s 引用的账户 %s 未声明", pb.Line, pb.Type, pb.Account)
		}
		acctBal := balances[aid]
		if acctBal == nil {
			acctBal = map[string]*big.Rat{}
		}

		switch pb.Type {
		case "pad":
			// pad 目标为 0：为每个有余额的币种补平至 0。
			for comm, bal := range acctBal {
				diff := new(big.Rat).Neg(bal) // 0 - bal
				if diff.Sign() == 0 {
					continue
				}
				if err := s.insertPadBalanceTxnOn(tx, ledgerID, ownerID, batchID, pb, aid, equityID, comm, diff, result); err != nil {
					return err
				}
			}
		case "balance":
			comm := pb.Commodity
			if comm == "" {
				// 未携带币种：用账户首个有余额的币种，或跳过自检。
				for c := range acctBal {
					comm = c
					break
				}
				if comm == "" {
					continue
				}
			}
			targetRat, err := parseDecimalRat(pb.Amount)
			if err != nil {
				return domain.Codedf(domain.ErrInvalid, domain.CodeImportUnbalanced,
					"第 %d 行 balance 金额非法 %q", pb.Line, pb.Amount)
			}
			actual := acctBal[comm]
			if actual == nil {
				actual = new(big.Rat)
			}
			if actual.Cmp(targetRat) != 0 {
				diff := new(big.Rat).Sub(targetRat, actual)
				return domain.Codedf(domain.ErrConflict, domain.CodeImportUnbalanced,
					"第 %d 行 balance 断言不满足：账户 %s 的 %s 实际余额 %s 与断言 %s 不符（差额 %s）",
					pb.Line, pb.Account, comm, actual.FloatString(2), targetRat.FloatString(2), diff.FloatString(2))
			}
		}
	}
	return nil
}

// insertPadBalanceTxnOn 写入一笔 pad 展开交易（账户 ± 差额 / 权益 ∓ 差额，普通 *）。
func (s *Store) insertPadBalanceTxnOn(
	tx *sql.Tx, ledgerID, ownerID int64, batchID string, pb beancount.PadBalance,
	accountID, equityID int64, commodity string, diff *big.Rat, result *ImportResult,
) error {
	prec := 2
	// 取账户币种精度（如有），否则 2 位兜底。
	if p, err := commodityPrecisionTx(tx, ledgerID, commodity); err == nil && p > 0 {
		prec = p
	}
	diffStr := diff.FloatString(prec)
	equityStr := new(big.Rat).Neg(diff).FloatString(prec)

	tuuid := uuid.NewString()
	desc := fmt.Sprintf("导入补平: %s 截至%s", pb.Account, pb.Date)
	// pad/balance 展开交易的幂等键：账户 + 日期 + 类型 + 金额，避免重复导入重复展开。
	clientRequestID := "import:" + hex.EncodeToString(sha256Of(fmt.Sprintf("pad:%s:%s:%s:%s", pb.Account, pb.Date, commodity, diffStr)))
	txn := domain.Transaction{
		UUID:        tuuid,
		Date:        pb.Date,
		Flag:        "*",
		Description: desc,
		CreatedBy:   ownerID,
	}
	// 复用 insertTransactionRowTx 的账本级事务与幂等写入（不写 tags，普通 * 交易）。
	txnID, inserted, err := insertTransactionRowTx(tx, ledgerID, txn, clientRequestID, "", batchID)
	if err != nil {
		return fmt.Errorf("写入 pad/balance 展开交易: %w", err)
	}
	if !inserted {
		result.SkippedTransactions++
		return nil
	}
	postings := []domain.Posting{
		{AccountID: accountID, Commodity: commodity, Amount: diffStr, Position: 0},
		{AccountID: equityID, Commodity: commodity, Amount: equityStr, Position: 1},
	}
	if err := insertPostingRowsTx(tx, txnID, postings); err != nil {
		return fmt.Errorf("写入 pad/balance 展开分录: %w", err)
	}
	if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityTransaction, tuuid, domain.OpCreate); err != nil {
		return err
	}
	result.CreatedTransactions++
	return nil
}

// AnalyzeImport 是导入预检（只读，不写库）：返回冲突清单与计数，并决定 valid / code。
// 与 ImportBeancountToLedger 共用同一套校验口径（执行时在同一事务内再次校验）。
func (s *Store) AnalyzeImport(
	ledgerID, ownerID int64, p *beancount.ParseResult, target string,
) (*ImportAnalysis, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	return s.analyzeImportOn(tx, ledgerID, p, target)
}

// analyzeImportOn 在给定只读事务上执行预检分析。
func (s *Store) analyzeImportOn(
	tx *sql.Tx, ledgerID int64, p *beancount.ParseResult, target string,
) (*ImportAnalysis, error) {
	a := &ImportAnalysis{
		Code:       "",
		PadBalance: []PadBalancePreview{},
		Conflicts:  []ImportConflict{},
		Warnings:   []ImportWarning{},
	}

	// 逐笔借贷平衡校验（P0，C-07 定点口径，禁浮点）。
	for _, t := range p.Transactions {
		imbalance, ok := transactionImbalance(t)
		if !ok {
			a.Conflicts = append(a.Conflicts, ImportConflict{
				Line: t.Line, Type: "unbalanced", Name: t.Date,
				Reason: "交易金额非法",
			})
			continue
		}
		for comm, v := range imbalance {
			if v.Cmp(new(big.Rat)) != 0 {
				a.Conflicts = append(a.Conflicts, ImportConflict{
					Line: t.Line, Type: "unbalanced", Name: comm,
					Reason: fmt.Sprintf("币种 %s 借贷不平，差额 %s", comm, v.FloatString(2)),
				})
			}
		}
	}

	switch target {
	case ImportTargetNew:
		// 新建账本：无既有账本可冲突；pad/balance 累计为 0（导入后展开）。
		a.NewAccounts = len(p.Accounts)
		a.NewCommodities = len(p.Commodities)
		a.NewTransactions = len(p.Transactions)
		s.fillPadBalancePreviewNew(a, p)
	default:
		// target=current：校验账户 / 币种冲突与 pad/balance 累计差额。
		s.analyzeCurrentConflictsOn(tx, a, ledgerID, p)
	}

	// 负债正余额警告（只警告不阻断，不进 Conflicts）：结合既有 DB 余额与本次
	// 解析分录，计算每个 Liabilities 账户的「导入后余额」，任一币种 > 0 即提示。
	warnings, werr := s.analyzeLiabilityWarningsOn(tx, ledgerID, p, target)
	if werr != nil {
		return nil, werr
	}
	a.Warnings = warnings

	a.Valid = len(a.Conflicts) == 0
	if !a.Valid {
		// 优先用首个冲突推导一个汇总稳定码，便于前端区分展示。
		a.Code = summarizeConflictCode(a.Conflicts)
	}
	return a, nil
}

// analyzeCurrentConflictsOn 计算 target=current 的账户 / 币种冲突与 pad/balance 累计。
func (s *Store) analyzeCurrentConflictsOn(tx *sql.Tx, a *ImportAnalysis, ledgerID int64, p *beancount.ParseResult) {
	// 先收集文件中「声明」的账户名集合（pad/balance 引用来源之一）。
	declared := make(map[string]bool, len(p.Accounts))
	for _, acc := range p.Accounts {
		declared[acc.Name] = true
	}

	for _, acc := range p.Accounts {
		existingID, _, found, closed, aType, restr, err := accountByNameTx(tx, ledgerID, acc.Name)
		if err != nil {
			a.Conflicts = append(a.Conflicts, ImportConflict{
				Line: 0, Type: "account_conflict", Name: acc.Name, Reason: "账户查询失败",
			})
			continue
		}
		if found {
			reuseAccounts := &a.ReuseAccounts
			*reuseAccounts++
			_ = existingID
			// 类型冲突 / 币种限制冲突 / 已关闭 → 整体拒绝（C-04 / AC-6.3）。
			fileType := accountType(acc.Name)
			if aType != fileType {
				a.Conflicts = append(a.Conflicts, ImportConflict{
					Line: 0, Type: "account_conflict", Name: acc.Name,
					Reason: fmt.Sprintf("类型冲突：账本为 %s，文件为 %s", aType, fileType),
				})
			}
			// 币种限制不一致（账本为空 / 文件为空 / 两者不同）即冲突。
			if restr != acc.Commodity {
				a.Conflicts = append(a.Conflicts, ImportConflict{
					Line: 0, Type: "account_conflict", Name: acc.Name,
					Reason: fmt.Sprintf("币种限制冲突：账本为 %q，文件为 %q", restr, acc.Commodity),
				})
			}
			if closed {
				a.Conflicts = append(a.Conflicts, ImportConflict{
					Line: 0, Type: "account_conflict", Name: acc.Name,
					Reason: "同名账户已关闭，不能复用（C-04）",
				})
			}
		} else {
			a.NewAccounts++
		}
	}

	for _, c := range p.Commodities {
		sym := c.Symbol
		if sym == "" {
			sym = c.Name
		}
		if sym == "" {
			continue
		}
		prec := 2
		if v, ok := parsePrecision(c.Prec); ok && v > 0 {
			prec = v
		}
		// 存在性（含软删）与精度一并查询：未登记走默认 2 位，不视为冲突。
		var existingPrec, cnt int
		err := tx.QueryRow(
			`SELECT COALESCE((SELECT "precision" FROM commodities WHERE ledger_id=? AND symbol=? AND deleted_at IS NULL),2), `+
				`(SELECT count(*) FROM commodities WHERE ledger_id=? AND symbol=?)`,
			ledgerID, sym, ledgerID, sym,
		).Scan(&existingPrec, &cnt)
		if err != nil {
			a.Conflicts = append(a.Conflicts, ImportConflict{
				Line: 0, Type: "commodity_conflict", Name: sym, Reason: "币种查询失败",
			})
			continue
		}
		if cnt > 0 {
			if existingPrec != prec {
				a.Conflicts = append(a.Conflicts, ImportConflict{
					Line: 0, Type: "commodity_conflict", Name: sym,
					Reason: fmt.Sprintf("精度冲突：账本为 %d 位，文件为 %d 位", existingPrec, prec),
				})
			}
		} else {
			a.NewCommodities++
		}
	}

	// pad/balance：累计差额（按当前账本重算）+ 未声明账户冲突（AC-6.8）。
	for _, pb := range p.PadBalances {
		aid, _, found, _, _, _, err := accountByNameTx(tx, ledgerID, pb.Account)
		if err != nil {
			a.Conflicts = append(a.Conflicts, ImportConflict{
				Line: pb.Line, Type: "undeclared_account", Name: pb.Account, Reason: "账户查询失败",
			})
			continue
		}
		if !found && !declared[pb.Account] {
			a.Conflicts = append(a.Conflicts, ImportConflict{
				Line: pb.Line, Type: "undeclared_account", Name: pb.Account,
				Reason: "pad/balance 引用了未声明的账户",
			})
			continue
		}
		// 计算截至断言日初累计（date < pb.Date），含既有交易与已生效校准。
		var cum map[string]*big.Rat
		if found {
			cum, err = accountBalanceBeforeOn(tx, ledgerID, aid, pb.Date)
			if err != nil {
				cum = map[string]*big.Rat{}
			}
		} else {
			cum = map[string]*big.Rat{}
		}
		s.appendPadBalancePreview(a, tx, ledgerID, pb, cum)
	}

	// target=current 不支持 pad/balance：整体拒绝（import_pad_balance_unsupported）。
	// 上方仍计算了累计差额并填入预览，便于前端提示「改用新建账本模式或展开为普通交易」。
	if len(p.PadBalances) > 0 {
		a.Conflicts = append(a.Conflicts, ImportConflict{
			Line:   0,
			Type:   "pad_balance_unsupported",
			Name:   "",
			Reason: "当前账本模式不支持 pad/balance 指令，请改用新建账本模式，或将其展开为普通交易后重导",
		})
	}

	// 重复导入去重预测：按确定性 client_request_id 比对既有交易。
	for _, t := range p.Transactions {
		crID := normalizeImportTxn(t)
		exists, err := txnExistsByClientRequestIDTx(tx, ledgerID, crID)
		if err != nil {
			a.NewTransactions++
			continue
		}
		if exists {
			a.SkipTransactions++
		} else {
			a.NewTransactions++
		}
	}
}

// analyzeLiabilityWarningsOn 计算负债正余额警告（只读，禁浮点，parseDecimalRat 累加）。
//
// 口径：
//   - 账户类型一律由账户名前缀推断（accountType）：beancount.ParseResult 的
//     Account 结构无 type 字段，本系统账户类型与名称前缀强绑定，且复用账户的
//     「文件类型 vs 账本类型」一致性已由冲突检查兜底，故按前缀判断不会误报；
//   - 「导入后余额」= 既有 DB 余额（computeBalancesOn，仅 target=current）+
//     本次解析分录按币种累加；任一币种 > 0 即生成一条警告；
//   - target=new 时目标账本尚不存在（余额为空），只按本次分录累加——预检路径
//     传入的是当前账本 id，直接算 DB 余额会拿错账本，必须跳过；
//   - 账户在文件中新建（DB 无该账户）同样检查（DB 余额按 0 处理）；
//   - 余额为 0 或负不警告；金额非法的分录已由借贷平衡检查报冲突，此处跳过。
func (s *Store) analyzeLiabilityWarningsOn(
	tx *sql.Tx, ledgerID int64, p *beancount.ParseResult, target string,
) ([]ImportWarning, error) {
	// 本次分录按「负债账户 × 币种」累加（ Liability 之外的分录不参与）。
	fileDelta := map[string]map[string]*big.Rat{}
	firstLine := map[string]int{}
	for _, t := range p.Transactions {
		for _, ps := range t.Postings {
			if accountType(ps.Account) != domain.TypeLiabilities {
				continue
			}
			r, err := parseDecimalRat(ps.Amount)
			if err != nil {
				continue // 非法金额已在借贷平衡检查中报 unbalanced 冲突
			}
			if fileDelta[ps.Account] == nil {
				fileDelta[ps.Account] = map[string]*big.Rat{}
				firstLine[ps.Account] = t.Line
			}
			if fileDelta[ps.Account][ps.Commodity] == nil {
				fileDelta[ps.Account][ps.Commodity] = new(big.Rat)
			}
			fileDelta[ps.Account][ps.Commodity].Add(fileDelta[ps.Account][ps.Commodity], r)
		}
	}
	if len(fileDelta) == 0 {
		return []ImportWarning{}, nil
	}

	// 既有 DB 余额：仅 target=current（写入当前账本）才与现有余额叠加。
	dbBalances := map[int64]map[string]*big.Rat{}
	if target != ImportTargetNew {
		var err error
		dbBalances, err = computeBalancesOn(tx, ledgerID, "")
		if err != nil {
			return nil, err
		}
	}

	// 既有账户 id（新建账户 DB 无余额，按 0 处理）。
	existingID := map[string]int64{}
	for name := range fileDelta {
		id, _, found, _, _, _, err := accountByNameTx(tx, ledgerID, name)
		if err != nil {
			return nil, err
		}
		if found {
			existingID[name] = id
		}
	}

	warnings := []ImportWarning{}
	for name, comms := range fileDelta {
		after := map[string]*big.Rat{}
		if id, ok := existingID[name]; ok {
			for comm, bal := range dbBalances[id] {
				after[comm] = new(big.Rat).Set(bal)
			}
		}
		for comm, v := range comms {
			if after[comm] == nil {
				after[comm] = new(big.Rat)
			}
			after[comm].Add(after[comm], v)
		}
		for _, comm := range sortedKeys(after) {
			if after[comm].Sign() > 0 {
				warnings = append(warnings, ImportWarning{
					Line:    firstLine[name],
					Account: name,
					Message: fmt.Sprintf(
						"负债账户 %s 导入后余额为正（%s %s），疑似符号方向填反（本系统欠款应为负数），请核对源文件",
						name, comm, after[comm].FloatString(2),
					),
				})
			}
		}
	}
	// 按账户名 + 消息排序，保证同一输入的警告顺序确定（map 遍历无序）。
	sort.Slice(warnings, func(i, j int) bool {
		if warnings[i].Account != warnings[j].Account {
			return warnings[i].Account < warnings[j].Account
		}
		return warnings[i].Message < warnings[j].Message
	})
	return warnings, nil
}

// sortedKeys 返回 map 的 key 升序切片（遍历确定性辅助，禁依赖 map 顺序）。
func sortedKeys(m map[string]*big.Rat) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// appendPadBalancePreview 把单条 pad/balance 的累计 / 差额填入预览（target=current）。
func (s *Store) appendPadBalancePreview(
	a *ImportAnalysis, tx execer, ledgerID int64, pb beancount.PadBalance, cum map[string]*big.Rat,
) {
	if pb.Type == "balance" {
		comm := pb.Commodity
		if comm == "" {
			// 未携带币种：取账户首个有累计的币种。
			for c := range cum {
				comm = c
				break
			}
		}
		targetRat, err := parseDecimalRat(pb.Amount)
		if err != nil {
			targetRat = new(big.Rat)
		}
		actual := cum[comm]
		if actual == nil {
			actual = new(big.Rat)
		}
		diff := new(big.Rat).Sub(targetRat, actual)
		prec := 2
		if p, e := commodityPrecisionTx(tx, ledgerID, comm); e == nil && p > 0 {
			prec = p
		}
		a.PadBalance = append(a.PadBalance, PadBalancePreview{
			Line: pb.Line, Type: pb.Type, Account: pb.Account,
			TargetAmount: targetRat.FloatString(prec),
			Cumulative:   actual.FloatString(prec),
			Diff:         diff.FloatString(prec),
		})
		return
	}
	// pad：目标为 0，逐币种列差额（会把现有余额拉到 0 的后果）。
	if len(cum) == 0 {
		a.PadBalance = append(a.PadBalance, PadBalancePreview{
			Line: pb.Line, Type: pb.Type, Account: pb.Account,
			TargetAmount: "0", Cumulative: "0", Diff: "0",
		})
		return
	}
	for comm, bal := range cum {
		diff := new(big.Rat).Neg(bal)
		prec := 2
		if p, e := commodityPrecisionTx(tx, ledgerID, comm); e == nil && p > 0 {
			prec = p
		}
		a.PadBalance = append(a.PadBalance, PadBalancePreview{
			Line: pb.Line, Type: pb.Type, Account: pb.Account,
			TargetAmount: "0",
			Cumulative:   bal.FloatString(prec),
			Diff:         diff.FloatString(prec),
		})
	}
}

// fillPadBalancePreviewNew 填充 target=new 的 pad/balance 预览（累计为 0）。
func (s *Store) fillPadBalancePreviewNew(a *ImportAnalysis, p *beancount.ParseResult) {
	for _, pb := range p.PadBalances {
		if pb.Type == "balance" {
			a.PadBalance = append(a.PadBalance, PadBalancePreview{
				Line: pb.Line, Type: pb.Type, Account: pb.Account,
				TargetAmount: pb.Amount, Cumulative: "0", Diff: pb.Amount,
			})
			continue
		}
		a.PadBalance = append(a.PadBalance, PadBalancePreview{
			Line: pb.Line, Type: pb.Type, Account: pb.Account,
			TargetAmount: "0", Cumulative: "0", Diff: "0",
		})
	}
}

// UndoImportBatch 撤销一次导入（AC-6.9）：单一大事务，只回滚本批新建实体，
// 不动复用的既有账户 / 币种 / 价格；硬删本批交易与其分录，并写 sync_log op=delete。
//
// 实体识别（QA DEF-1 根治，迁移 016 manifest 方案）：
//   - 交易 / 分录通过 (ledger_id, import_batch_id) 精确范围；
//   - 价格 / 账户 / 币种按 import_batch_entities 清单精确删——导入事务内已把
//     「本批新建（非复用）」实体逐条登记，撤销不再做任何「孤儿判定」全账本扫描；
//   - 护栏：清单内实体若仍被本批之外的数据引用（如后续批次按 name 复用了本批
//     新建的账户），保留不删、不计入 removed_*、不写 sync_log op=delete；
//   - 引用检查一律 join transactions 按 ledger 定界，且不过滤 deleted_at
//     （软删引用计入，与 S2 CommodityUsage 的保守口径一致）；
//   - 默认币种（ledgers.default_commodity）加一道兜底保护，绝不删。
//
// 兼容性：016 之前的历史批次无清单行，撤销只删交易与分录，实体一律保留
// （安全降级：宁可不删，不误删）。撤销完成后本批 manifest 行一并清理。
// 批次定位为「manifest 有行 OR 交易有行」（QA 二轮 DEF-4）：幂等去重后零交易的
// 空批次同样可撤销（只清 manifest 实体，removed_transactions / removed_postings
// 如实为 0）；两者皆空才是真不存在，维持 404 import_batch_not_found。
// 不轮换 instance_id（非 restore）。
func (s *Store) UndoImportBatch(ledgerID int64, batchID string) (*ImportUndoResult, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	// 1) 批次定位：「manifest 有行 OR 交易有行」（QA 二轮 DEF-4 修复）。
	//    「幂等去重后零交易」的空批次合法存在（其新建价格 / 币种已登记 manifest），
	//    必须同样可撤销；两者皆空才是真不存在的批次（维持 404 import_batch_not_found）。
	rows, err := tx.Query(
		`SELECT id, uuid FROM transactions WHERE ledger_id=? AND import_batch_id=? AND deleted_at IS NULL`,
		ledgerID, batchID,
	)
	if err != nil {
		return nil, err
	}
	type batchTxn struct {
		id  int64
		uuid string
	}
	txns := []batchTxn{}
	for rows.Next() {
		var b batchTxn
		if err := rows.Scan(&b.id, &b.uuid); err != nil {
			rows.Close()
			return nil, err
		}
		txns = append(txns, b)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	var manifestRows int
	if err := tx.QueryRow(
		`SELECT count(*) FROM import_batch_entities WHERE ledger_id=? AND batch_id=?`,
		ledgerID, batchID,
	).Scan(&manifestRows); err != nil {
		return nil, err
	}
	if len(txns) == 0 && manifestRows == 0 {
		return nil, domain.Codedf(domain.ErrNotFound, domain.CodeImportBatchNotFound,
			"未找到该导入批次，无法撤销")
	}

	// 2)~4) 硬删本批交易与分录 + sync_log（空批次无交易，整段跳过，
	//       removed_transactions / removed_postings 如实为 0）。
	var removedTxns, removedPostings int64
	if len(txns) > 0 {
		idArgs := make([]any, 0, len(txns))
		for _, t := range txns {
			idArgs = append(idArgs, t.id)
		}
		// 2) 硬删分录（先清引用；postings.account_id / transaction_id 外键无级联）。
		delPostings, err := tx.Exec(
			`DELETE FROM postings WHERE transaction_id IN (?`+strings.Repeat(",?", len(idArgs)-1)+`)`,
			idArgs...,
		)
		if err != nil {
			return nil, fmt.Errorf("删除批次分录: %w", err)
		}
		removedPostings, _ = delPostings.RowsAffected()
		// 3) 硬删交易行。
		delTxns, err := tx.Exec(
			`DELETE FROM transactions WHERE id IN (?`+strings.Repeat(",?", len(idArgs)-1)+`)`,
			idArgs...,
		)
		if err != nil {
			return nil, fmt.Errorf("删除批次交易: %w", err)
		}
		removedTxns, _ = delTxns.RowsAffected()
		// 4) sync_log op=delete（每个被删交易）。
		for _, t := range txns {
			if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityTransaction, t.uuid, domain.OpDelete); err != nil {
				return nil, err
			}
		}
	}

	// 5) 价格：按 manifest 精确删（本批新建；QA DEF-2：不再做引用分析）。
	removedPrices, err := s.deleteBatchPricesOn(tx, ledgerID, batchID)
	if err != nil {
		return nil, err
	}
	// 6) 账户：按 manifest 精确删（护栏：仍被本批之外分录引用则保留）。
	removedAccounts, err := s.deleteBatchAccountsOn(tx, ledgerID, batchID)
	if err != nil {
		return nil, err
	}
	// 7) 币种：按 manifest 精确删（护栏：外部分录 / 剩余价格 / 账户限定 / 默认币种）。
	//    顺序在价格与账户之后，护栏看到的是清理后的剩余引用。
	removedCommodities, err := s.deleteBatchCommoditiesOn(tx, ledgerID, batchID)
	if err != nil {
		return nil, err
	}
	// 8) 清理本批 manifest 行（撤销完成后清单使命结束）。
	if _, err := tx.Exec(
		`DELETE FROM import_batch_entities WHERE ledger_id=? AND batch_id=?`,
		ledgerID, batchID,
	); err != nil {
		return nil, fmt.Errorf("清理批次清单: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &ImportUndoResult{
		RemovedTransactions: int(removedTxns),
		RemovedPostings:     int(removedPostings),
		RemovedPrices:       removedPrices,
		RemovedAccounts:     removedAccounts,
		RemovedCommodities:  removedCommodities,
	}, nil
}

// ---------------------------------------------------------------------------
// 批次撤销的 manifest 精确删（迁移 016，QA DEF-1/DEF-2 取代旧孤儿扫描）
// ---------------------------------------------------------------------------

// appendBatchEntityTx 把一个「本批新建」实体登记进 import_batch_entities（同事务）。
// INSERT OR IGNORE + 唯一索引 (batch_id, entity_type, entity_uuid)：同一批次重复登记
// 不阻断导入。batchID 为空（异常路径）时静默跳过——宁缺清单，不可错登记。
func appendBatchEntityTx(tx execer, ledgerID int64, batchID, entityType, entityUUID string) error {
	if batchID == "" || entityUUID == "" {
		return nil
	}
	if _, err := tx.Exec(
		`INSERT OR IGNORE INTO import_batch_entities(ledger_id, batch_id, entity_type, entity_uuid)
		 VALUES(?, ?, ?, ?)`,
		ledgerID, batchID, entityType, entityUUID,
	); err != nil {
		return fmt.Errorf("登记批次实体 %s/%s: %w", entityType, entityUUID, err)
	}
	return nil
}

// batchEntityUUIDsTx 取某批次某类实体的 manifest uuid 清单（按登记顺序）。
func batchEntityUUIDsTx(tx execer, ledgerID int64, batchID, entityType string) ([]string, error) {
	rows, err := tx.Query(
		`SELECT entity_uuid FROM import_batch_entities
		 WHERE ledger_id=? AND batch_id=? AND entity_type=? ORDER BY id`,
		ledgerID, batchID, entityType,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	uuids := []string{}
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			return nil, err
		}
		uuids = append(uuids, u)
	}
	return uuids, rows.Err()
}

// deleteBatchPricesOn 按 manifest 硬删本批新建价格（QA DEF-2：价格只来自本批清单，
// 不做引用分析——导入价格均为 source='import' 的文件声明，撤批即随批走）。
// 行不存在（并发已清）时跳过，不计入、不写事件。
func (s *Store) deleteBatchPricesOn(tx *sql.Tx, ledgerID int64, batchID string) (int, error) {
	uuids, err := batchEntityUUIDsTx(tx, ledgerID, batchID, "price")
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, u := range uuids {
		res, err := tx.Exec(`DELETE FROM prices WHERE ledger_id=? AND uuid=?`, ledgerID, u)
		if err != nil {
			return 0, fmt.Errorf("删除批次价格: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			continue
		}
		if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityPrice, u, domain.OpDelete); err != nil {
			return 0, err
		}
		removed++
	}
	return removed, nil
}

// deleteBatchAccountsOn 按 manifest 硬删本批新建账户（QA DEF-1 根治）。
//
// 护栏：账户仍被任何分录引用则保留不删——典型场景是后续批次（或在线记账）按
// name 复用了本批新建的账户。此时本批交易与分录已在同事务先删，剩余命中即
// 「本批之外」的引用；不过滤 deleted_at（软删交易的分录计入引用，保守口径），
// join transactions 把范围定界在本账本内。被保留的账户不计入 removed_accounts、
// 不写 sync_log op=delete。
func (s *Store) deleteBatchAccountsOn(tx *sql.Tx, ledgerID int64, batchID string) (int, error) {
	uuids, err := batchEntityUUIDsTx(tx, ledgerID, batchID, "account")
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, u := range uuids {
		var id int64
		err := tx.QueryRow(`SELECT id FROM accounts WHERE ledger_id=? AND uuid=?`, ledgerID, u).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			continue // 行已不在：不计入、不写事件
		}
		if err != nil {
			return 0, err
		}
		var refs int
		if err := tx.QueryRow(
			`SELECT count(*) FROM postings p JOIN transactions t ON t.id=p.transaction_id
			 WHERE t.ledger_id=? AND p.account_id=?`,
			ledgerID, id,
		).Scan(&refs); err != nil {
			return 0, err
		}
		if refs > 0 {
			continue // 仍被外部引用：保留（复用方交易不受影响）
		}
		res, err := tx.Exec(`DELETE FROM accounts WHERE ledger_id=? AND uuid=?`, ledgerID, u)
		if err != nil {
			return 0, fmt.Errorf("删除批次账户: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			continue
		}
		if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityAccount, u, domain.OpDelete); err != nil {
			return 0, err
		}
		removed++
	}
	return removed, nil
}

// deleteBatchCommoditiesOn 按 manifest 硬删本批新建币种（QA DEF-1 根治）。
//
// 四道护栏（任一命中即保留）：
//  0. symbol = ledgers.default_commodity（默认币种兜底保护，绝不删）；
//  1. 仍被任何分录引用（本批分录已删；软删计入；join transactions 定界本账本）；
//  2. 仍被任何剩余价格引用（本批价格已先删，剩余即外部价格）；
//  3. 仍被账户限定币种引用（commodity_restriction；本批删除的账户已先行清理，
//     剩余命中即保留账户的限定）。
//
// 被保留的币种不计入 removed_commodities、不写 sync_log op=delete。
func (s *Store) deleteBatchCommoditiesOn(tx *sql.Tx, ledgerID int64, batchID string) (int, error) {
	uuids, err := batchEntityUUIDsTx(tx, ledgerID, batchID, "commodity")
	if err != nil {
		return 0, err
	}
	var defaultCommodity string
	if err := tx.QueryRow(
		`SELECT COALESCE(default_commodity,'') FROM ledgers WHERE id=?`, ledgerID,
	).Scan(&defaultCommodity); err != nil {
		return 0, err
	}
	removed := 0
	for _, u := range uuids {
		var symbol string
		err := tx.QueryRow(
			`SELECT symbol FROM commodities WHERE ledger_id=? AND uuid=?`, ledgerID, u,
		).Scan(&symbol)
		if errors.Is(err, sql.ErrNoRows) {
			continue // 行已不在：不计入、不写事件
		}
		if err != nil {
			return 0, err
		}
		if symbol != "" && symbol == defaultCommodity {
			continue // 护栏 0：默认币种
		}
		var postingRefs, priceRefs, acctRefs int
		if err := tx.QueryRow(
			`SELECT count(*) FROM postings p JOIN transactions t ON t.id=p.transaction_id
			 WHERE t.ledger_id=? AND p.commodity=?`,
			ledgerID, symbol,
		).Scan(&postingRefs); err != nil {
			return 0, err
		}
		if err := tx.QueryRow(
			`SELECT count(*) FROM prices WHERE ledger_id=? AND (commodity=? OR currency=?)`,
			ledgerID, symbol, symbol,
		).Scan(&priceRefs); err != nil {
			return 0, err
		}
		if err := tx.QueryRow(
			`SELECT count(*) FROM accounts WHERE ledger_id=? AND commodity_restriction=?`,
			ledgerID, symbol,
		).Scan(&acctRefs); err != nil {
			return 0, err
		}
		if postingRefs > 0 || priceRefs > 0 || acctRefs > 0 {
			continue // 护栏 1~3：仍被引用，保留
		}
		res, err := tx.Exec(`DELETE FROM commodities WHERE ledger_id=? AND uuid=?`, ledgerID, u)
		if err != nil {
			return 0, fmt.Errorf("删除批次币种: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			continue
		}
		if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityCommodity, u, domain.OpDelete); err != nil {
			return 0, err
		}
		removed++
	}
	return removed, nil
}

// ---------------------------------------------------------------------------
// 导入私有辅助
// ---------------------------------------------------------------------------

// accountByNameTx 按 name 查询账本内账户（含关闭与软删判断）。
func accountByNameTx(
	tx execer, ledgerID int64, name string,
) (id int64, uuidStr string, found, closed bool, aType, restr string, err error) {
	var closeDate, restrNull, del sql.NullString
	err = tx.QueryRow(
		`SELECT id, uuid, type, commodity_restriction, close_date, deleted_at
		 FROM accounts WHERE ledger_id=? AND name=?`,
		ledgerID, name,
	).Scan(&id, &uuidStr, &aType, &restrNull, &closeDate, &del)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", false, false, "", "", nil
	}
	if err != nil {
		return 0, "", false, false, "", "", err
	}
	if restrNull.Valid {
		restr = restrNull.String
	}
	closed = closeDate.Valid
	return id, uuidStr, true, closed, aType, restr, nil
}

// accountBalanceBeforeOn 计算某账户截至 beforeDate 日初（date < beforeDate）的按币种余额。
func accountBalanceBeforeOn(e execer, ledgerID, accountID int64, beforeDate string) (map[string]*big.Rat, error) {
	rows, err := e.Query(
		`SELECT p.commodity, CAST(p.amount AS TEXT)
		 FROM postings p JOIN transactions t ON t.id=p.transaction_id
		 WHERE p.account_id=? AND t.ledger_id=? AND t.deleted_at IS NULL AND t.date < ?`,
		accountID, ledgerID, beforeDate,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sum := map[string]*big.Rat{}
	for rows.Next() {
		var comm, amt string
		if err := rows.Scan(&comm, &amt); err != nil {
			return nil, err
		}
		r, err := parseDecimalRat(amt)
		if err != nil {
			return nil, err
		}
		if _, ok := sum[comm]; !ok {
			sum[comm] = new(big.Rat)
		}
		sum[comm].Add(sum[comm], r)
	}
	return sum, rows.Err()
}

// defaultOpeningDateOn 返回账本的期初日期（用于 pad/balance 展开交易的记账日兜底）。
// 账本无 opening_date 时返回空串，由调用方依赖数据库默认（date('now','localtime')）。
func defaultOpeningDateOn(e execer, ledgerID int64) string {
	var d sql.NullString
	if err := e.QueryRow(
		`SELECT COALESCE(opening_date,'') FROM ledgers WHERE id=?`, ledgerID,
	).Scan(&d); err != nil {
		return ""
	}
	if d.Valid {
		return d.String
	}
	return ""
}

// txnExistsByClientRequestIDTx 判断账本内是否已存在同幂等键的未删除交易（去重预测）。
func txnExistsByClientRequestIDTx(tx execer, ledgerID int64, clientRequestID string) (bool, error) {
	var n int
	err := tx.QueryRow(
		`SELECT count(*) FROM transactions WHERE ledger_id=? AND client_request_id=? AND deleted_at IS NULL`,
		ledgerID, clientRequestID,
	).Scan(&n)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// ensureCommodityWithMetaTx 确保币种存在；不存在则按 name/precision 新建（导入用，保留文件精度）。
// 返回 (created, err)：已存在（含软删）时 created=false 且不重建、不写 create 事件。
func ensureCommodityWithMetaTx(tx execer, ledgerID int64, symbol, name string, precision int) (bool, error) {
	var active, soft int
	if err := tx.QueryRow(
		`SELECT
		   (SELECT count(*) FROM commodities WHERE ledger_id=? AND symbol=? AND deleted_at IS NULL),
		   (SELECT count(*) FROM commodities WHERE ledger_id=? AND symbol=? AND deleted_at IS NOT NULL)`,
		ledgerID, symbol, ledgerID, symbol,
	).Scan(&active, &soft); err != nil {
		return false, err
	}
	if active > 0 || soft > 0 {
		// 已存在（或软删）：不重建、不写 create 事件（参考 ensureCommodityOn 口径）。
		return false, nil
	}
	if name == "" {
		name = symbol
	}
	cuuid := uuid.NewString()
	if _, err := tx.Exec(
		`INSERT INTO commodities(ledger_id, uuid, symbol, name, precision)
		 VALUES(?, ?, ?, ?, ?)`,
		ledgerID, cuuid, symbol, name, precision,
	); err != nil {
		return false, err
	}
	if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityCommodity, cuuid, domain.OpCreate); err != nil {
		return false, err
	}
	return true, nil
}

// commodityExistsTx 判断账本内该 symbol 是否已有行（含软删——ensureCommodityOn
// 对软删行抑制复活的判定口径，本函数与其共用）。
func commodityExistsTx(tx execer, ledgerID int64, symbol string) (bool, error) {
	var n int
	if err := tx.QueryRow(
		`SELECT count(*) FROM commodities WHERE ledger_id=? AND symbol=?`,
		ledgerID, symbol,
	).Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}

// ensureCommodityBatchOn 导入路径专用：确保币种存在，并把「本批新建」的币种登记进
// manifest（QA DEF-1：撤销据此精确删，取代孤儿扫描）。
//   - 调 ensureCommodityOn 前先查行数（含软删）：无任何行时 ensureCommodityOn 必然
//     全新 INSERT → 回读 uuid 登记 manifest；
//   - 既有活跃 / 软删行：ensureCommodityOn 跳过（软删行抑制复活，AC-4.4），
//     不属本批新建，不登记。
func ensureCommodityBatchOn(tx execer, ledgerID int64, symbol, batchID string) error {
	if symbol == "" {
		return nil
	}
	existed, err := commodityExistsTx(tx, ledgerID, symbol)
	if err != nil {
		return err
	}
	if existed {
		return nil
	}
	if err := ensureCommodityOn(tx, ledgerID, symbol); err != nil {
		return err
	}
	var cu string
	if err := tx.QueryRow(
		`SELECT uuid FROM commodities WHERE ledger_id=? AND symbol=? AND deleted_at IS NULL`,
		ledgerID, symbol,
	).Scan(&cu); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			// 并发竞态兜底：判定后行又被他人建（理论上单写者不会发生），不登记。
			return nil
		}
		return err
	}
	return appendBatchEntityTx(tx, ledgerID, batchID, "commodity", cu)
}

// transactionImbalance 返回一笔交易按币种的分组差额；ok=false 表示金额非法。
func transactionImbalance(t beancount.Transaction) (map[string]*big.Rat, bool) {
	sum := map[string]*big.Rat{}
	for _, p := range t.Postings {
		r, err := parseDecimalRat(p.Amount)
		if err != nil {
			return nil, false
		}
		if _, ok := sum[p.Commodity]; !ok {
			sum[p.Commodity] = new(big.Rat)
		}
		sum[p.Commodity].Add(sum[p.Commodity], r)
	}
	return sum, true
}

// normalizeImportTxn 生成交易的确定性幂等键：对规范化文本做 sha256（D-10）。
func normalizeImportTxn(t beancount.Transaction) string {
	parts := []string{t.Date, t.Flag, t.Payee, t.Narration}
	posts := make([]string, 0, len(t.Postings))
	for _, p := range t.Postings {
		posts = append(posts, p.Account+"|"+p.Amount+"|"+p.Commodity)
	}
	sort.Strings(posts)
	raw := strings.Join(parts, "|") + "#" + strings.Join(posts, "#")
	return "import:" + hex.EncodeToString(sha256Of(raw))
}

// sha256Of 计算输入字符串的 sha256 摘要（纯函数，返回切片便于 hex 编码）。
func sha256Of(s string) []byte {
	sum := sha256.Sum256([]byte(s))
	return sum[:]
}

// parsePrecision 解析币种精度字符串（"2" → 2）；非法返回 (0, false)。
func parsePrecision(s string) (int, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int(c-'0')
	}
	if n < 0 || n > 18 {
		return 0, false
	}
	return n, true
}

// summarizeConflictCode 从冲突清单推导一个汇总稳定码（用于预检响应 code 字段）。
func summarizeConflictCode(conflicts []ImportConflict) string {
	for _, c := range conflicts {
		switch c.Type {
		case "undeclared_account", "account_conflict":
			return domain.CodeImportAccountConflict
		case "commodity_conflict":
			return domain.CodeImportUnbalanced // 与 commodity 相关，复用导入族码
		case "unbalanced":
			return domain.CodeImportUnbalanced
		case "pad_balance_unsupported":
			return domain.CodeImportPadBalance
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// 既有公开方法（保持兼容：新建账本路径 + 去重账本名 + 重复检测）
// ---------------------------------------------------------------------------

// UniqueLedgerName 返回 owner 维度下去重后的账本名（只读，供预检展示）。
func (s *Store) UniqueLedgerName(ownerID int64, base string) string {
	if base == "" {
		base = "导入账本"
	}
	return uniqueLedgerNameTx(s.db, ownerID, base)
}

// IsDuplicateImport 判断是否存在「同名账本 + 相同交易数」，用作疑似重复导入提示。
// 不阻断导入（用户可能确实想导入两次）。
func (s *Store) IsDuplicateImport(ownerID int64, base string, txnCount int) (bool, error) {
	if base == "" {
		base = "导入账本"
	}
	var n int
	err := s.db.QueryRow(
		`SELECT count(*) FROM ledgers l
		 JOIN (SELECT ledger_id, count(*) c FROM transactions GROUP BY ledger_id) t
		   ON t.ledger_id = l.id
		 WHERE l.owner_id=? AND l.name=? AND t.c=?`,
		ownerID, base, txnCount,
	).Scan(&n)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// uniqueLedgerNameTx 在事务/连接上计算去重账本名：base 已存在则追加 " (2)"、" (3)"…
func uniqueLedgerNameTx(e execer, ownerID int64, base string) string {
	name := base
	n := 2
	for {
		var cnt int
		if err := e.QueryRow(
			`SELECT count(*) FROM ledgers WHERE owner_id=? AND name=?`, ownerID, name,
		).Scan(&cnt); err != nil || cnt == 0 {
			return name
		}
		name = fmt.Sprintf("%s (%d)", base, n)
		n++
	}
}

// accountType 从 Beancount 账户名推断五大类（前缀匹配，默认 Expenses）。
func accountType(name string) string {
	switch {
	case strings.HasPrefix(name, "Assets:"):
		return domain.TypeAssets
	case strings.HasPrefix(name, "Liabilities:"):
		return domain.TypeLiabilities
	case strings.HasPrefix(name, "Equity:"):
		return domain.TypeEquity
	case strings.HasPrefix(name, "Income:"):
		return domain.TypeIncome
	default:
		return domain.TypeExpenses
	}
}
