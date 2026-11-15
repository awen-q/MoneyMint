package service

import (
	"errors"
	"fmt"
	"strings"

	"familyledger/internal/domain"

	"github.com/google/uuid"
)

// CommodityView 是币种视图。
//
// Used / IsDefault 用 omitempty：GET 列表为 true 时输出，POST 新建（必为 false）
// 只输出 {uuid,symbol,name,precision} 四字段，满足设计 §3.5 #5 的响应契约。
// 前端按「可选 + 容忍旧响应」声明为 field?: boolean，消费处一律 === true 判真。
type CommodityView struct {
	UUID      string `json:"uuid"`
	Symbol    string `json:"symbol"`
	Name      string `json:"name"`
	Precision int    `json:"precision"`
	Used      bool   `json:"used,omitempty"`
	IsDefault bool   `json:"is_default,omitempty"`
}

// validateCommoditySymbol 校验 Beancount commodity 符号（AC-4.1）。
// 规则：首字符大写 ASCII 字母，其余为大写字母 / 数字 / . _ - '，长度不超过 24。
// 非法一律给中文可读原因，不把 SQL 约束错误甩给用户。
func validateCommoditySymbol(symbol string) error {
	if symbol == "" {
		return domain.Invalidf("币种代码不能为空")
	}
	if len(symbol) > 24 {
		return domain.Invalidf("币种代码 %q 过长（最多 24 个字符）", symbol)
	}
	for i := 0; i < len(symbol); i++ {
		ch := symbol[i]
		upper := ch >= 'A' && ch <= 'Z'
		digit := ch >= '0' && ch <= '9'
		extra := ch == '.' || ch == '_' || ch == '-' || ch == '\''
		if i == 0 {
			if !upper {
				return domain.Invalidf("币种代码 %q 不合法：须以大写字母开头", symbol)
			}
			continue
		}
		if !upper && !digit && !extra {
			return domain.Invalidf("币种代码 %q 不合法：只能包含大写字母、数字与 . _ - '", symbol)
		}
	}
	return nil
}

// ListCommodities 列出账本内未软删币种及其引用状态（GET /api/commodities）。
func (s *Service) ListCommodities(ledgerID int64) ([]CommodityView, error) {
	rows, err := s.repo.ListCommodities(ledgerID)
	if err != nil {
		return nil, err
	}
	out := make([]CommodityView, 0, len(rows))
	for _, r := range rows {
		out = append(out, CommodityView{
			UUID:      r.UUID,
			Symbol:    r.Symbol,
			Name:      r.Name,
			Precision: r.Precision,
			Used:      r.Used,
			IsDefault: r.IsDefault,
		})
	}
	return out, nil
}

// CreateCommodity 新增币种（POST /api/commodities，AC-4.1）。
//
// 三种分支严格按序：
//  1. 同 symbol 活跃行已存在 → 409 commodity_exists，回显已有 uuid；
//  2. 命中软删行 → 恢复原行（保留原 uuid、更新 name/precision、写 sync_log
//     op=create），绝不 INSERT（表级 UNIQUE(ledger_id,symbol)）；
//  3. 全新 symbol → INSERT + sync_log op=create。
//
// 本版不提供 precision 修改（D-06），未传 / 非正数一律默认 2。
func (s *Service) CreateCommodity(ledgerID int64, symbol, name string, precision int) (CommodityView, error) {
	symbol = strings.TrimSpace(symbol)
	name = strings.TrimSpace(name)
	if err := validateCommoditySymbol(symbol); err != nil {
		return CommodityView{}, err
	}
	if precision <= 0 {
		precision = 2
	}

	existing, err := s.repo.CommoditySymbolExists(ledgerID, symbol)
	if err != nil {
		return CommodityView{}, err
	}
	if existing != "" {
		return CommodityView{}, &domain.CodedError{
			Code:     domain.CodeCommodityExists,
			Message:  fmt.Sprintf("币种 %s 已存在", symbol),
			Details:  map[string]any{"uuid": existing},
			Sentinel: domain.ErrConflict,
		}
	}

	_, found, err := s.repo.SoftCommodityBySymbol(ledgerID, symbol)
	if err != nil {
		return CommodityView{}, err
	}
	if found {
		restored, err := s.repo.RestoreCommodity(ledgerID, symbol, name, precision)
		if err != nil {
			// QA DEF-3：事务外读到软删行后，RestoreCommodity 事务内按
			// deleted_at IS NOT NULL 重读却已无行——并发下输了竞态（该行已被
			// 其他请求恢复 / 重建为活跃行）。此刻币种实际已存在，语义回落为
			// 409 commodity_exists（与分支 1 同码）；404 只保留给「真不存在」。
			// 并发下无数据损坏（表级 UNIQUE 恒 1 行），仅修正错误码语义。
			if errors.Is(err, domain.ErrNotFound) {
				existingUUID, gerr := s.repo.CommoditySymbolExists(ledgerID, symbol)
				if gerr != nil {
					return CommodityView{}, gerr
				}
				details := map[string]any{}
				if existingUUID != "" {
					details["uuid"] = existingUUID
				}
				return CommodityView{}, &domain.CodedError{
					Code:     domain.CodeCommodityExists,
					Message:  fmt.Sprintf("币种 %s 已存在", symbol),
					Details:  details,
					Sentinel: domain.ErrConflict,
				}
			}
			return CommodityView{}, err
		}
		return CommodityView{
			UUID:      restored.UUID,
			Symbol:    restored.Symbol,
			Name:      restored.Name,
			Precision: restored.Precision,
		}, nil
	}

	c := domain.Commodity{
		UUID:      uuid.NewString(),
		Symbol:    symbol,
		Name:      strings.TrimSpace(name),
		Precision: precision,
	}
	if err := s.repo.InsertCommodity(ledgerID, c); err != nil {
		if errors.Is(err, domain.ErrConflict) {
			return CommodityView{}, &domain.CodedError{
				Code:     domain.CodeCommodityExists,
				Message:  fmt.Sprintf("币种 %s 已存在", symbol),
				Sentinel: domain.ErrConflict,
			}
		}
		return CommodityView{}, err
	}
	return CommodityView{
		UUID: c.UUID, Symbol: c.Symbol, Name: c.Name, Precision: c.Precision,
	}, nil
}

// DeleteCommodity 删除币种（DELETE /api/commodities/{uuid}，AC-4.2 / AC-4.3）。
//
// 被引用时返回 409 commodity_in_use，body 分项列出账户 / 分录 / 价格 / 默认币种，
// 并给出中文可读原因（默认币种明确提示先改账本设置，AC-4.5）；不返回裸 SQL 错误、
// 不静默删。重复删除（uuid 已软删 / 不存在）由 ErrNotFound 映射为幂等 404。
func (s *Service) DeleteCommodity(ledgerID int64, commodityUUID string) error {
	c, err := s.repo.CommodityByUUID(ledgerID, commodityUUID)
	if err != nil {
		return err
	}
	usage, err := s.repo.CommodityUsage(ledgerID, c.Symbol)
	if err != nil {
		return err
	}
	if usage.InUse() {
		parts := make([]string, 0, 4)
		if usage.AccountCount > 0 {
			example := ""
			if len(usage.Accounts) > 0 {
				example = fmt.Sprintf("（如 %s）", usage.Accounts[0])
			}
			parts = append(parts, fmt.Sprintf("%d 个账户设为限定币种%s", usage.AccountCount, example))
		}
		if usage.Postings > 0 {
			parts = append(parts, fmt.Sprintf("%d 笔交易分录", usage.Postings))
		}
		if usage.Prices > 0 {
			parts = append(parts, fmt.Sprintf("%d 条价格", usage.Prices))
		}
		if usage.IsDefault {
			parts = append(parts, "当前账本默认币种（请先在账本设置中改默认币种）")
		}
		accounts := usage.Accounts
		if accounts == nil {
			accounts = []string{}
		}
		return &domain.CodedError{
			Code:     domain.CodeCommodityInUse,
			Message:  fmt.Sprintf("币种 %s 仍被引用：%s", c.Symbol, strings.Join(parts, "、")),
			Details: map[string]any{
				"accounts":   accounts,
				"postings":   usage.Postings,
				"prices":     usage.Prices,
				"is_default": usage.IsDefault,
			},
			Sentinel: domain.ErrConflict,
		}
	}
	deleted, err := s.repo.SoftDeleteCommodity(ledgerID, commodityUUID)
	if err != nil {
		return err
	}
	if !deleted {
		return domain.ErrNotFound
	}
	return nil
}
