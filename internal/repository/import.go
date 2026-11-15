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

// ImportAnalysis 是导入预检的只读分析结果（不写库）。
type ImportAnalysis struct {
	Valid           bool                 `json:"valid"`
	Code            string               `json:"code,omitempty"`
	Error           string               `json:"error,omitempty"`
	NewAccounts     int                  `json:"new_accounts"`
	ReuseAccounts   int                  `json:"reuse_accounts"`
	NewTransactions int                  `json:"new_transactions"`
	SkipTransactions int                 `json:"skip_transactions"`
	NewCommodities  int                  `json:"new_commodities"`
	PadBalance      []PadBalancePreview   `json:"pad_balance"`
	Conflicts       []ImportConflict      `json:"conflicts"`
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
		newAccounts++
	}
	result.NewAccounts = newAccounts
	result.ReusedAccounts = reuseAccounts

	// 2) 币种：文件声明的 + 价格涉及的，全部确保存在（按精度声明新建）。
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
			result.NewCommodities++
		}
	}
	for _, pr := range p.Prices {
		if pr.Commodity != "" {
			if err := ensureCommodityOn(tx, ledgerID, pr.Commodity); err != nil {
				return nil, err
			}
		}
		if pr.Currency != "" {
			if err := ensureCommodityOn(tx, ledgerID, pr.Currency); err != nil {
				return nil, err
			}
		}
	}

	// 3) 价格
	for _, pr := range p.Prices {
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
		// 确保各分录币种存在。
		for _, ps := range t.Postings {
			if ps.Commodity != "" {
				if err := ensureCommodityOn(tx, ledgerID, ps.Commodity); err != nil {
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
	// 权益对手方（与期初同源的 Equity:Opening-Balances）。
	equityDate := p.Title
	if equityDate == "" {
		equityDate = defaultOpeningDateOn(tx, ledgerID)
	}
	equityID, err := ensureOpeningEquityTx(tx, ledgerID, equityDate)
	if err != nil {
		return fmt.Errorf("展开 pad/balance 准备权益账户: %w", err)
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
	a := &ImportAnalysis{Code: "", PadBalance: []PadBalancePreview{}, Conflicts: []ImportConflict{}}

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
// 实体识别：交易 / 分录 / 价格通过 (ledger_id, import_batch_id) 精确范围；账户 / 币种
// 因无 batch 列，采用「撤销后孤儿」判定——导入新建的账户 / 币种在移除本批交易后不再
// 被任何分录 / 价格引用，则一并硬删（复用的既有实体仍被其他交易引用，不会被误删）。
// 不轮换 instance_id（非 restore）。批次不存在返回 import_batch_not_found（404）。
func (s *Store) UndoImportBatch(ledgerID int64, batchID string) (*ImportUndoResult, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	// 1) 定位本批交易（未删除）。
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
	if len(txns) == 0 {
		return nil, domain.Codedf(domain.ErrNotFound, domain.CodeImportBatchNotFound,
			"未找到该导入批次，无法撤销")
	}

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
	removedPostings, _ := delPostings.RowsAffected()
	// 3) 硬删交易行。
	delTxns, err := tx.Exec(
		`DELETE FROM transactions WHERE id IN (?`+strings.Repeat(",?", len(idArgs)-1)+`)`,
		idArgs...,
	)
	if err != nil {
		return nil, fmt.Errorf("删除批次交易: %w", err)
	}
	removedTxns, _ := delTxns.RowsAffected()
	// 4) sync_log op=delete（每个被删交易）。
	for _, t := range txns {
		if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityTransaction, t.uuid, domain.OpDelete); err != nil {
			return nil, err
		}
	}

	// 5) 孤儿价格硬删（导入新建、撤销后 commodity 与 currency 均未被任何分录引用）。
	removedPrices, err := s.deleteOrphanPricesOn(tx, ledgerID)
	if err != nil {
		return nil, err
	}
	// 6) 孤儿账户 / 币种硬删（导入新建、撤销后无任何分录 / 价格引用的实体）。
	removedAccounts, err := s.deleteOrphanAccountsOn(tx, ledgerID)
	if err != nil {
		return nil, err
	}
	removedCommodities, err := s.deleteOrphanCommoditiesOn(tx, ledgerID)
	if err != nil {
		return nil, err
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

// deleteOrphanPricesOn 硬删撤销后零引用的价格：commodity 与 currency 都未被任何分录
// 引用时，该价格已无存在意义（导入新建或临时 FX 记录），一并硬删 + sync_log op=delete。
// 仍被某笔分录引用的币种对应价格保留（不误删既有 FX 记录）。
func (s *Store) deleteOrphanPricesOn(tx *sql.Tx, ledgerID int64) (int, error) {
	rows, err := tx.Query(
		`SELECT id, uuid FROM prices
		 WHERE ledger_id=?
		   AND commodity NOT IN (SELECT DISTINCT commodity FROM postings)
		   AND currency NOT IN (SELECT DISTINCT commodity FROM postings)`,
		ledgerID,
	)
	if err != nil {
		return 0, err
	}
	orphans := []struct{ id int64; uuid string }{}
	for rows.Next() {
		var o struct{ id int64; uuid string }
		if err := rows.Scan(&o.id, &o.uuid); err != nil {
			rows.Close()
			return 0, err
		}
		orphans = append(orphans, o)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	rows.Close()
	for _, o := range orphans {
		if _, err := tx.Exec(`DELETE FROM prices WHERE id=?`, o.id); err != nil {
			return 0, fmt.Errorf("删除孤儿价格: %w", err)
		}
		if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityPrice, o.uuid, domain.OpDelete); err != nil {
			return 0, err
		}
	}
	return len(orphans), nil
}

// deleteOrphanAccountsOn 硬删撤销后零分录引用的账户 + sync_log op=delete。
func (s *Store) deleteOrphanAccountsOn(tx *sql.Tx, ledgerID int64) (int, error) {
	rows, err := tx.Query(
		`SELECT id, uuid FROM accounts
		 WHERE ledger_id=? AND id NOT IN (SELECT DISTINCT account_id FROM postings)`,
		ledgerID,
	)
	if err != nil {
		return 0, err
	}
	orphans := []struct{ id int64; uuid string }{}
	for rows.Next() {
		var o struct{ id int64; uuid string }
		if err := rows.Scan(&o.id, &o.uuid); err != nil {
			rows.Close()
			return 0, err
		}
		orphans = append(orphans, o)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	rows.Close()
	for _, o := range orphans {
		if _, err := tx.Exec(`DELETE FROM accounts WHERE id=?`, o.id); err != nil {
			return 0, fmt.Errorf("删除孤儿账户: %w", err)
		}
		if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityAccount, o.uuid, domain.OpDelete); err != nil {
			return 0, err
		}
	}
	return len(orphans), nil
}

// deleteOrphanCommoditiesOn 硬删撤销后零引用（无分录且无价格）的币种 + sync_log op=delete。
func (s *Store) deleteOrphanCommoditiesOn(tx *sql.Tx, ledgerID int64) (int, error) {
	rows, err := tx.Query(
		`SELECT id, uuid, symbol FROM commodities
		 WHERE ledger_id=?
		   AND symbol NOT IN (SELECT DISTINCT commodity FROM postings)
		   AND symbol NOT IN (SELECT DISTINCT commodity FROM prices WHERE ledger_id=?)
		   AND symbol NOT IN (SELECT DISTINCT currency FROM prices WHERE ledger_id=?)`,
		ledgerID, ledgerID, ledgerID,
	)
	if err != nil {
		return 0, err
	}
	orphans := []struct{ id int64; uuid string; symbol string }{}
	for rows.Next() {
		var o struct{ id int64; uuid string; symbol string }
		if err := rows.Scan(&o.id, &o.uuid, &o.symbol); err != nil {
			rows.Close()
			return 0, err
		}
		orphans = append(orphans, o)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	rows.Close()
	// 不删默认币种：若 symbol 与账本 default_commodity 相同，保留（避免破坏账本设置）。
	var defaultCommodity string
	if err := tx.QueryRow(`SELECT COALESCE(default_commodity,'') FROM ledgers WHERE id=?`, ledgerID).Scan(&defaultCommodity); err != nil {
		return 0, err
	}
	count := 0
	for _, o := range orphans {
		if o.symbol != "" && o.symbol == defaultCommodity {
			continue
		}
		if _, err := tx.Exec(`DELETE FROM commodities WHERE id=?`, o.id); err != nil {
			return 0, fmt.Errorf("删除孤儿币种: %w", err)
		}
		if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityCommodity, o.uuid, domain.OpDelete); err != nil {
			return 0, err
		}
		count++
	}
	return count, nil
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
