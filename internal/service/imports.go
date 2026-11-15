package service

import (
	"fmt"
	"strings"

	"github.com/google/uuid"

	"familyledger/internal/beancount"
	"familyledger/internal/domain"
	"familyledger/internal/repository"
)

// ImportConflict 是导入预检冲突（逐行号与原因），与 repository 同名结构对齐。
type ImportConflict struct {
	Line   int    `json:"line"`
	Type   string `json:"type"` // account_conflict | commodity_conflict | undeclared_account | unbalanced | pad_balance_unsupported
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// PadBalancePreview 是预检中 pad/balance 指令的结构化呈现（含按当前账本重算的差额）。
type PadBalancePreview struct {
	Line         int    `json:"line"`
	Type         string `json:"type"` // pad | balance
	Account      string `json:"account"`
	TargetAmount string `json:"target_amount"`
	Cumulative   string `json:"cumulative"`
	Diff         string `json:"diff"`
}

// ImportPreview 是导入预检结果（只读，不写库）。
//
// Valid=false 且 Errors 非空：文件含不支持语法，整体拒绝（列出全部错误行号）。
// Valid=false 且 Conflicts 非空：文件语法合法，但与目标账本存在冲突（账户/币种/
// pad-balance 不支持等），整体拒绝，逐项列出原因。
// Duplicate=true：target=new 时疑似重复导入（同名账本 + 相同交易数），仅提示，不阻断。
type ImportPreview struct {
	Valid            bool                `json:"valid"`
	Title            string              `json:"title"`
	Target           string              `json:"target"`
	LedgerName       string              `json:"ledger_name"` // target=new 时实际将使用的账本名（去重后）
	NewAccounts      int                 `json:"new_accounts"`
	ReuseAccounts    int                 `json:"reuse_accounts"`
	NewTransactions  int                 `json:"new_transactions"`
	SkipTransactions int                 `json:"skip_transactions"`
	NewCommodities   int                 `json:"new_commodities"`
	PadBalance       []PadBalancePreview `json:"pad_balance"`
	Conflicts        []ImportConflict    `json:"conflicts"`
	Code             string              `json:"code,omitempty"`
	Duplicate        bool                `json:"duplicate,omitempty"`
	Errors           []beancount.ParseError `json:"errors,omitempty"`
	Error            string              `json:"error,omitempty"`
}

// ImportResult 是导入执行结果（current / new 两种模式共用，mode 区分）。
type ImportResult struct {
	Mode                string `json:"mode"` // current | new
	LedgerID            int64  `json:"ledger_id"`
	LedgerName          string `json:"ledger_name"`
	ImportBatchID       string `json:"import_batch_id"`
	CreatedTransactions int    `json:"created_transactions"`
	SkippedTransactions int    `json:"skipped_transactions"`
	ReusedAccounts      int    `json:"reused_accounts"`
	NewAccounts         int    `json:"new_accounts"`
	NewCommodities      int    `json:"new_commodities"`
}

// ImportUndoResult 是批次撤销结果（硬删本批新建实体 + 本批交易，不动复用实体）。
type ImportUndoResult struct {
	RemovedTransactions int `json:"removed_transactions"`
	RemovedPostings     int `json:"removed_postings"`
	RemovedPrices       int `json:"removed_prices"`
	RemovedAccounts     int `json:"removed_accounts"`
	RemovedCommodities  int `json:"removed_commodities"`
}

// normalizeImportTarget 归一化导入目标：仅 "new" 视为新建账本，其余（含空）按
// "current"（导入到当前账本）处理——这是 S5 的主路径。
func normalizeImportTarget(target string) string {
	if target == repository.ImportTargetNew {
		return repository.ImportTargetNew
	}
	return repository.ImportTargetCurrent
}

// newImportBatchID 生成一次性的导入批次标识（撤销时据此精确范围定位本批实体）。
func newImportBatchID() string {
	return "imp-" + uuid.NewString()
}

// PreviewImport 解析 Beancount 文本并给出导入预览（不写库）。
//
// target=current：校验目标账本账户 / 币种冲突、pad/balance 不支持提示、逐笔借贷平衡；
// target=new：沿用既有新建账本路径（账户 / 币种全为新建，pad/balance 导入后展开）。
func (s *Service) PreviewImport(ledgerID, userID int64, text, target string) (*ImportPreview, error) {
	target = normalizeImportTarget(target)
	p, err := beancount.Parse(text)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", domain.ErrInvalid, err.Error())
	}
	prev := &ImportPreview{Title: p.Title, Target: target}
	if len(p.Errors) > 0 {
		prev.Valid = false
		prev.Errors = p.Errors
		prev.Error = "文件含不支持的语法，已整体拒绝"
		return prev, nil
	}
	prev.Valid = true

	a, aerr := s.repo.AnalyzeImport(ledgerID, userID, p, target)
	if aerr != nil {
		return nil, aerr
	}
	applyAnalysis(prev, a)

	if target == repository.ImportTargetNew {
		base := p.Title
		if base == "" {
			base = "导入账本"
		}
		prev.LedgerName = s.repo.UniqueLedgerName(userID, base)
		dup, derr := s.repo.IsDuplicateImport(userID, base, len(p.Transactions))
		if derr == nil {
			prev.Duplicate = dup
		}
	}
	return prev, nil
}

// ExecuteImport 执行导入：解析 → 校验 → 单一大事务写入（current 当前账本 / new 新建账本）。
//
// 解析或语法错误在 service 层直接拒绝；语义冲突由 repo 在执行事务内再次校验，
// 保证预检与执行一致。每个批次分配独立 import_batch_id，便于后续撤销。
func (s *Service) ExecuteImport(ledgerID, userID int64, text, target string) (*ImportResult, error) {
	target = normalizeImportTarget(target)
	p, err := beancount.Parse(text)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", domain.ErrInvalid, err.Error())
	}
	if len(p.Errors) > 0 {
		return nil, domain.Invalidf("文件含不支持的语法，已整体拒绝")
	}
	batchID := newImportBatchID()
	res, err := s.repo.ImportBeancountToLedger(ledgerID, userID, p, target, batchID)
	if err != nil {
		return nil, err
	}
	return &ImportResult{
		Mode:                res.Mode,
		LedgerID:            res.LedgerID,
		LedgerName:          res.LedgerName,
		ImportBatchID:       res.ImportBatchID,
		CreatedTransactions: res.CreatedTransactions,
		SkippedTransactions: res.SkippedTransactions,
		ReusedAccounts:      res.ReusedAccounts,
		NewAccounts:         res.NewAccounts,
		NewCommodities:      res.NewCommodities,
	}, nil
}

// UndoImportBatch 撤销一次导入：仅回滚本批新建实体（账户/币种）与本批交易/分录，
// 不动复用的既有账户/币种/价格。批次不存在返回 404（import_batch_not_found）。
func (s *Service) UndoImportBatch(ledgerID, userID int64, batchID string) (*ImportUndoResult, error) {
	_ = userID // 鉴权在 handler/middleware 层完成，service 仅按 ledgerID 范围操作
	if strings.TrimSpace(batchID) == "" {
		return nil, domain.Invalidf("batch_id 不能为空")
	}
	r, err := s.repo.UndoImportBatch(ledgerID, batchID)
	if err != nil {
		return nil, err
	}
	return &ImportUndoResult{
		RemovedTransactions: r.RemovedTransactions,
		RemovedPostings:     r.RemovedPostings,
		RemovedPrices:       r.RemovedPrices,
		RemovedAccounts:     r.RemovedAccounts,
		RemovedCommodities:  r.RemovedCommodities,
	}, nil
}

// applyAnalysis 把 repo 的只读分析结果映射到 service 预检响应（计数 / 冲突 / pad/balance）。
func applyAnalysis(prev *ImportPreview, a *repository.ImportAnalysis) {
	prev.Valid = a.Valid
	prev.Code = a.Code
	prev.NewAccounts = a.NewAccounts
	prev.ReuseAccounts = a.ReuseAccounts
	prev.NewTransactions = a.NewTransactions
	prev.SkipTransactions = a.SkipTransactions
	prev.NewCommodities = a.NewCommodities

	prev.PadBalance = make([]PadBalancePreview, 0, len(a.PadBalance))
	for _, pb := range a.PadBalance {
		prev.PadBalance = append(prev.PadBalance, PadBalancePreview{
			Line:         pb.Line,
			Type:         pb.Type,
			Account:      pb.Account,
			TargetAmount: pb.TargetAmount,
			Cumulative:   pb.Cumulative,
			Diff:         pb.Diff,
		})
	}
	prev.Conflicts = make([]ImportConflict, 0, len(a.Conflicts))
	for _, c := range a.Conflicts {
		prev.Conflicts = append(prev.Conflicts, ImportConflict{
			Line:   c.Line,
			Type:   c.Type,
			Name:   c.Name,
			Reason: c.Reason,
		})
	}
}
