package service

import (
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"sort"
	"strings"
	"time"

	"familyledger/internal/domain"
	"familyledger/internal/repository"
)

// PostingInput 是创建/推送交易时的分录输入（金额为有符号定点十进制字符串）。
type PostingInput struct {
	AccountID   int64
	AccountUUID string
	Commodity   string
	Amount      string
}

// validateBalance 校验同一交易内按币种分组的金额之和必须为 0（借贷平衡）。
// 使用 big.Rat 做精确十进制求和，避免浮点误差。
func validateBalance(postings []PostingInput) error {
	sums := map[string]*big.Rat{}
	for _, p := range postings {
		r := new(big.Rat)
		if _, ok := r.SetString(p.Amount); !ok {
			return domain.Invalidf("非法金额 %q", p.Amount)
		}
		if _, ok := sums[p.Commodity]; !ok {
			sums[p.Commodity] = new(big.Rat)
		}
		sums[p.Commodity].Add(sums[p.Commodity], r)
	}
	for c, s := range sums {
		if s.Sign() != 0 {
			return domain.Invalidf("交易不平衡：币种 %s 借贷差为 %s，必须为 0", c, s.RatString())
		}
	}
	return nil
}

// validateAccountType 校验账户类型属于 Beancount 五大类。
func validateAccountType(t string) error {
	switch t {
	case domain.TypeAssets, domain.TypeLiabilities, domain.TypeEquity, domain.TypeIncome, domain.TypeExpenses:
		return nil
	default:
		return domain.Invalidf("非法账户类型 %q", t)
	}
}

// ---------------------------------------------------------------------------
// 0.6.0 S4 · 余额校准（design §3.2 签名；本文件既有借贷平衡校验原样保留）
// ---------------------------------------------------------------------------

// 带符号定点十进制金额（目标余额可为负，不接受指数记数法 / 分数）。
var signedAmountRe = regexp.MustCompile(`^[+-]?\d+(?:\.\d+)?$`)

// BalanceTargetInput 是 POST /api/accounts/{uuid}/balance 的单币种目标。
type BalanceTargetInput struct {
	Commodity     string `json:"commodity"`
	TargetBalance string `json:"target_balance"`
}

// BalanceInput 是设置余额校准的请求体。
type BalanceInput struct {
	AsOfDate string               `json:"as_of_date"`
	Targets  []BalanceTargetInput `json:"targets"`
	// UserID 由 handler 从会话注入（不接受客户端传值），用于校准交易 created_by，
	// 使 AC-3.6 版本历史可见操作人；不放进 JSON 契约，service 签名保持不变。
	UserID int64 `json:"-"`
}

// BalanceAmountView 是按币种的金额（预检累计 / 历史差额）。
type BalanceAmountView struct {
	Commodity string `json:"commodity"`
	Amount    string `json:"amount"`
}

// BalanceTargetView 是既有校准的目标余额（带符号）。
type BalanceTargetView struct {
	Commodity    string `json:"commodity"`
	SignedAmount string `json:"signed_amount"`
}

// BalanceHistoryView 是校准版本历史（AC-3.6：v1/v2、操作人、时间、差额原因）。
type BalanceHistoryView struct {
	Version         string              `json:"version"`
	TransactionUUID string              `json:"transaction_uuid"`
	CreatedAt       string              `json:"created_at"`
	CreatedByName   string              `json:"created_by_name"`
	Reversed        bool                `json:"reversed"`
	Entries         []BalanceAmountView `json:"entries"`
}

// BalanceCalibrationView 是 GET 预检中的既有校准信息。
type BalanceCalibrationView struct {
	Exists          bool                 `json:"exists"`
	Date            string               `json:"date"`
	Version         int64                `json:"version"`
	Targets         []BalanceTargetView  `json:"targets"`
	TransactionUUID string               `json:"transaction_uuid"`
	History         []BalanceHistoryView `json:"history"`
}

// BalancePreviewView 是 GET /api/accounts/{uuid}/balance 的响应。
type BalancePreviewView struct {
	AccountUUID string                 `json:"account_uuid"`
	AsOfDate    string                 `json:"as_of_date"`
	Cumulative  []BalanceAmountView    `json:"cumulative"`
	Calibration BalanceCalibrationView `json:"calibration"`
}

// BalanceEntryView 是本次补记的按币种差额。
type BalanceEntryView struct {
	Commodity string `json:"commodity"`
	Diff      string `json:"diff"`
}

// BalanceResult 是 POST /api/accounts/{uuid}/balance 的响应。
type BalanceResult struct {
	Status          string             `json:"status"` // created | updated
	AccountUUID     string             `json:"account_uuid"`
	TransactionUUID string             `json:"transaction_uuid"`
	ReversalUUID    string             `json:"reversal_uuid,omitempty"`
	Version         int64              `json:"version"`
	Date            string             `json:"date"` // D-1
	Entries         []BalanceEntryView `json:"entries"`
}

// balanceContext 是两处日期校验共用后的上下文，保证 AC-3.7「两处原因一致」。
type balanceContext struct {
	account     domain.Account
	openingDate string
	lowerBound  string
	postingDate string
}

// validateBalanceContext 集中校验账户与 as_of_date（GET 预检 / POST 设置共用）：
//   - 账户存在、未关闭、类型 ∈ Assets/Liabilities/Equity；
//   - D 为合法 YYYY-MM-DD、≥ 账本期初日期、≥ 账户 open_date、≤ 今日；
//   - 落账日 D-1 必须 ≥ max(账户 open_date, 账本期初日期)，否则明确拒绝、不静默前移。
//
// balance_date_invalid 与 balance_date_too_early 的文案都点明同一条下界
// 「不早于 max(账户开户日, 账本期初日期)」，满足 AC-3.7「两处一致的可读原因」。
func (s *Service) validateBalanceContext(ledgerID int64, accountUUID, asOfDate string) (balanceContext, error) {
	acc, err := s.repo.AccountByUUID(ledgerID, accountUUID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return balanceContext{}, domain.Codedf(domain.ErrNotFound, domain.CodeAccountNotFound, "账户不存在")
		}
		return balanceContext{}, err
	}
	if acc.CloseDate != "" {
		return balanceContext{}, domain.Codedf(domain.ErrConflict, domain.CodeAccountClosed,
			"账户已关闭，无法设置余额校准")
	}
	if acc.Type != domain.TypeAssets && acc.Type != domain.TypeLiabilities && acc.Type != domain.TypeEquity {
		return balanceContext{}, domain.Invalidf("仅资产 / 负债 / 权益账户支持余额校准")
	}

	openingDate, err := s.repo.LedgerOpeningDate(ledgerID)
	if err != nil {
		return balanceContext{}, err
	}
	today := time.Now().Format("2006-01-02")
	if openingDate == "" || openingDate > today {
		openingDate = today
	}
	lower := acc.OpenDate
	if lower == "" || openingDate > lower {
		lower = openingDate
	}

	invalidReason := fmt.Sprintf(
		"指定日期不合法或超出允许范围：须为 YYYY-MM-DD，且不早于 max(账户开户日 %s, 账本期初日期 %s)、不晚于今日 %s",
		acc.OpenDate, openingDate, today)
	parsed, err := time.Parse("2006-01-02", asOfDate)
	if err != nil || !isoDateRe.MatchString(asOfDate) {
		return balanceContext{}, domain.Codedf(domain.ErrInvalid, domain.CodeBalanceDateInvalid, "%s", invalidReason)
	}
	if asOfDate < lower || asOfDate > today {
		return balanceContext{}, domain.Codedf(domain.ErrInvalid, domain.CodeBalanceDateInvalid, "%s", invalidReason)
	}

	postingDate := parsed.AddDate(0, 0, -1).Format("2006-01-02")
	if postingDate < lower {
		return balanceContext{}, domain.Codedf(domain.ErrInvalid, domain.CodeBalanceDateTooEarly,
			"指定日期过早，无法在开户日 / 账本期初日期之后生成补平分录：D-1（%s）须不早于 max(账户开户日 %s, 账本期初日期 %s)",
			postingDate, acc.OpenDate, openingDate)
	}
	return balanceContext{
		account: acc, openingDate: openingDate, lowerBound: lower, postingDate: postingDate,
	}, nil
}

// GetBalanceCalibration 返回「截至 D 日初（前一日日终）」的累计、既有校准与版本历史。
// 累计口径为 date < D（C-01，不含 D 当日），由 ComputeBalancesBefore 单一口径提供。
func (s *Service) GetBalanceCalibration(ledgerID int64, accountUUID, asOfDate string) (BalancePreviewView, error) {
	ctx, err := s.validateBalanceContext(ledgerID, accountUUID, asOfDate)
	if err != nil {
		return BalancePreviewView{}, err
	}
	balances, err := s.repo.ComputeBalancesBefore(ledgerID, asOfDate)
	if err != nil {
		return BalancePreviewView{}, err
	}
	cumulative := balances[ctx.account.ID]
	if cumulative == nil {
		cumulative = map[string]*big.Rat{}
	}

	codes := make([]string, 0, len(cumulative))
	for code := range cumulative {
		codes = append(codes, code)
	}
	sort.Strings(codes)

	view := BalancePreviewView{
		AccountUUID: accountUUID,
		AsOfDate:    asOfDate,
		Cumulative:  make([]BalanceAmountView, 0, len(codes)),
		Calibration: BalanceCalibrationView{
			Targets: []BalanceTargetView{}, History: []BalanceHistoryView{},
		},
	}
	for _, code := range codes {
		prec, err := s.repo.CommodityPrecision(ledgerID, code)
		if err != nil {
			return BalancePreviewView{}, err
		}
		if prec <= 0 {
			prec = 2
		}
		view.Cumulative = append(view.Cumulative, BalanceAmountView{
			Commodity: code, Amount: cumulative[code].FloatString(prec),
		})
	}

	history, err := s.repo.BalanceCalibrationHistory(ledgerID, ctx.account.ID, accountUUID, asOfDate)
	if err != nil {
		return BalancePreviewView{}, err
	}
	for _, rec := range history {
		entries := make([]BalanceAmountView, 0, len(rec.Entries))
		for _, e := range rec.Entries {
			entries = append(entries, BalanceAmountView{Commodity: e.Commodity, Amount: e.Diff})
		}
		view.Calibration.History = append(view.Calibration.History, BalanceHistoryView{
			Version:         fmt.Sprintf("v%d", rec.Version),
			TransactionUUID: rec.UUID,
			CreatedAt:       rec.CreatedAt,
			CreatedByName:   rec.CreatedByName,
			Reversed:        rec.Reversed,
			Entries:         entries,
		})
		if !rec.Reversed {
			view.Calibration.Exists = true
			view.Calibration.Date = rec.BalanceDate
			view.Calibration.Version = rec.Version
			view.Calibration.TransactionUUID = rec.UUID
		}
	}
	if view.Calibration.Exists {
		// 校准分录落在 D-1（< D），故当前累计即上一次设定的目标值。
		for _, c := range view.Cumulative {
			view.Calibration.Targets = append(view.Calibration.Targets, BalanceTargetView{
				Commodity: c.Commodity, SignedAmount: c.Amount,
			})
		}
	}
	return view, nil
}

// SetBalanceCalibration 校验目标并单事务写入校准（design §3.2 签名）。
// 描述固定中文模板「余额校准: 截至D日初」（Q-02），不写 tags、不写 opening_account_uuid。
func (s *Service) SetBalanceCalibration(ledgerID int64, accountUUID string, in BalanceInput) (BalanceResult, error) {
	ctx, err := s.validateBalanceContext(ledgerID, accountUUID, in.AsOfDate)
	if err != nil {
		return BalanceResult{}, err
	}
	if len(in.Targets) == 0 {
		return BalanceResult{}, domain.Invalidf("请至少设置一个币种的目标余额")
	}

	seen := make(map[string]bool, len(in.Targets))
	targets := make([]repository.BalanceTarget, 0, len(in.Targets))
	for _, item := range in.Targets {
		commodity := strings.TrimSpace(item.Commodity)
		if commodity == "" {
			return BalanceResult{}, domain.Invalidf("目标余额的币种不能为空")
		}
		if seen[commodity] {
			return BalanceResult{}, domain.Invalidf("币种 %s 的目标余额重复", commodity)
		}
		seen[commodity] = true
		raw := strings.TrimSpace(item.TargetBalance)
		if !signedAmountRe.MatchString(raw) {
			return BalanceResult{}, domain.Invalidf("目标余额 %q 不是合法的定点十进制金额", raw)
		}
		r, ok := new(big.Rat).SetString(raw)
		if !ok {
			return BalanceResult{}, domain.Invalidf("目标余额 %q 格式非法", raw)
		}
		prec, err := s.repo.CommodityPrecision(ledgerID, commodity)
		if err != nil {
			return BalanceResult{}, err
		}
		if prec <= 0 {
			prec = 2
		}
		targets = append(targets, repository.BalanceTarget{
			Commodity: commodity, TargetBalance: r.FloatString(prec), Precision: prec,
		})
	}

	description := fmt.Sprintf("余额校准: 截至%s日初", in.AsOfDate)
	applied, err := s.repo.ApplyBalanceCalibration(ledgerID, repository.BalanceCalibrationInput{
		AccountID:   ctx.account.ID,
		AccountUUID: accountUUID,
		AsOfDate:    in.AsOfDate,
		PostingDate: ctx.postingDate,
		Targets:     targets,
		Description: description,
		UserID:      in.UserID,
	})
	if err != nil {
		return BalanceResult{}, err
	}
	entries := make([]BalanceEntryView, 0, len(applied.Entries))
	for _, e := range applied.Entries {
		entries = append(entries, BalanceEntryView{Commodity: e.Commodity, Diff: e.Diff})
	}
	return BalanceResult{
		Status:          applied.Status,
		AccountUUID:     accountUUID,
		TransactionUUID: applied.TransactionUUID,
		ReversalUUID:    applied.ReversalUUID,
		Version:         applied.Version,
		Date:            applied.Date,
		Entries:         entries,
	}, nil
}
