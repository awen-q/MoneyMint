package service

import (
	"fmt"
	"log"
	"time"

	"familyledger/internal/domain"
)

// LedgerView 是账本列表/详情的返回视图（含当前用户角色与期初日期）。
// 0.6.0 起附加行级统计（P1-03，additive；旧客户端忽略新字段即可）。
type LedgerView struct {
	ID               int64  `json:"id"`
	Name             string `json:"name"`
	DefaultCommodity string `json:"default_commodity,omitempty"`
	OpeningDate      string `json:"opening_date"`
	Role             string `json:"role"`
	// MemberCount 是除 owner 外的成员数（D-03 删除门禁口径）。
	MemberCount      int64 `json:"member_count"`
	AccountCount     int64 `json:"account_count"`
	TransactionCount int64 `json:"transaction_count"`
}

// LedgerMemberRef 是 409 ledger_has_members 明细里的成员引用。
// 只包含用户名与显示名，绝不携带密码哈希 / token 等凭据。
type LedgerMemberRef struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}

// ListLedgers 列出当前用户所属的全部有效账本及其角色与统计。
func (s *Service) ListLedgers(userID int64) ([]LedgerView, error) {
	ledgers, err := s.repo.ListLedgersByUser(userID)
	if err != nil {
		return nil, err
	}
	out := make([]LedgerView, 0, len(ledgers))
	for _, l := range ledgers {
		out = append(out, LedgerView{
			ID:               l.ID,
			Name:             l.Name,
			DefaultCommodity: l.DefaultCommodity,
			OpeningDate:      l.OpeningDate,
			Role:             l.Role,
			MemberCount:      l.MemberCount,
			AccountCount:     l.AccountCount,
			TransactionCount: l.TransactionCount,
		})
	}
	return out, nil
}

// LedgerDeleted 判断账本是否已被软删（供鉴权中间件输出稳定码 ledger_deleted）。
func (s *Service) LedgerDeleted(ledgerID int64) (bool, error) {
	return s.repo.LedgerDeleted(ledgerID)
}

// MinActiveLedgerID 返回用户所属、未软删、最小 id 的账本（无则 0）。
// 供鉴权中间件在请求缺失 X-Ledger-Id 时兜底（R3 / AC-1.6）。
func (s *Service) MinActiveLedgerID(userID int64) (int64, error) {
	return s.repo.MinActiveLedgerID(userID)
}

// CreateLedger 创建新账本，创建者成为 owner；期初日期默认今日（FR-01）。
func (s *Service) CreateLedger(userID int64, name, defaultCommodity string) (LedgerView, error) {
	if name == "" {
		return LedgerView{}, domain.Invalidf("账本名称必填")
	}
	id, err := s.repo.CreateLedger(userID, name, defaultCommodity)
	if err != nil {
		return LedgerView{}, err
	}
	// 建账成功后写入默认账户（支出/收入/资产/负债/权益），失败不阻断建账。
	if err := s.repo.SeedDefaultAccounts(id); err != nil {
		return LedgerView{}, err
	}
	l, err := s.repo.LedgerByID(id)
	if err != nil {
		return LedgerView{}, err
	}
	return LedgerView{
		ID:               id,
		Name:             name,
		DefaultCommodity: defaultCommodity,
		OpeningDate:      l.OpeningDate,
		Role:             domain.RoleOwner,
		MemberCount:      l.MemberCount,
		AccountCount:     l.AccountCount,
		TransactionCount: l.TransactionCount,
	}, nil
}

// UpdateLedger 更新账本名称、默认币种与可选的期初日期（仅 owner）。
//
// openingDate 非 nil 时（PATCH 显式传入）：
//   - 必须是合法 YYYY-MM-DD，且 ≤ 今日、不晚于账本最早非期初交易；
//   - 保存后单事务重建全部有效期初（冲正旧 + 新建新日期），并只下调未关闭账户的 open_date。
func (s *Service) UpdateLedger(userID, ledgerID int64, name, defaultCommodity string, openingDate *string) (LedgerView, error) {
	if name == "" {
		return LedgerView{}, domain.Invalidf("账本名称必填")
	}
	if err := s.requireOwner(ledgerID, userID); err != nil {
		return LedgerView{}, err
	}
	if openingDate != nil {
		d := *openingDate
		if !isISODate(d) {
			return LedgerView{}, domain.Codedf(domain.ErrInvalid, domain.CodeLedgerOpeningDateInvalid,
				"opening_date 需为 YYYY-MM-DD")
		}
		today := time.Now().Format("2006-01-02")
		if d > today {
			return LedgerView{}, domain.Codedf(domain.ErrInvalid, domain.CodeLedgerOpeningDateInvalid,
				"opening_date 不能晚于今日 %s", today)
		}
		earliest, err := s.repo.EarliestNonOpeningTxnDate(ledgerID)
		if err != nil {
			return LedgerView{}, err
		}
		if earliest != "" && d > earliest {
			return LedgerView{}, domain.Codedf(domain.ErrInvalid, domain.CodeLedgerOpeningDateAfterTxn,
				"opening_date 不能晚于账本最早交易 %s", earliest)
		}
	}

	ok, err := s.repo.UpdateLedger(ledgerID, name, defaultCommodity)
	if err != nil {
		return LedgerView{}, err
	}
	if !ok {
		return LedgerView{}, domain.ErrNotFound
	}
	if openingDate != nil {
		if _, err := s.RebuildOpenings(ledgerID, *openingDate); err != nil {
			return LedgerView{}, err
		}
	}

	l, err := s.repo.LedgerByID(ledgerID)
	if err != nil {
		return LedgerView{}, err
	}
	return LedgerView{
		ID:               ledgerID,
		Name:             name,
		DefaultCommodity: l.DefaultCommodity,
		OpeningDate:      l.OpeningDate,
		Role:             domain.RoleOwner,
		MemberCount:      l.MemberCount,
		AccountCount:     l.AccountCount,
		TransactionCount: l.TransactionCount,
	}, nil
}

// DeleteLedger 软删账本（S1 / AC-1.1~1.8，D-03）。
//
// 严格顺序：已删判定 → requireOwner → 除 owner 外成员门禁 → 最后一个有效账本 →
// pre-ledger-delete 一致性快照（VACUUM INTO）→ 单事务软删。
// 快照失败或缺失时直接返回错误，**不动任何数据**；不写 sync_log（账本非同步
// 实体）、不轮换 instance_id（仅 restore 轮换）。
func (s *Service) DeleteLedger(userID, ledgerID int64) error {
	deleted, err := s.repo.LedgerDeleted(ledgerID)
	if err != nil {
		return err
	}
	if deleted {
		return domain.Codedf(domain.ErrForbidden, domain.CodeLedgerDeleted, "账本已删除，无法操作")
	}
	if err := s.requireOwner(ledgerID, userID); err != nil {
		return err
	}

	members, err := s.repo.ListNonOwnerMembers(ledgerID)
	if err != nil {
		return err
	}
	if len(members) > 0 {
		refs := make([]LedgerMemberRef, 0, len(members))
		for _, m := range members {
			refs = append(refs, LedgerMemberRef{Username: m.Username, DisplayName: m.DisplayName})
		}
		return &domain.CodedError{
			Code:     domain.CodeLedgerHasMembers,
			Message:  fmt.Sprintf("还有 %d 位成员，需先移除后再删除账本", len(refs)),
			Details:  map[string]any{"member_count": len(refs), "members": refs},
			Sentinel: domain.ErrConflict,
		}
	}

	active, err := s.repo.CountActiveLedgers(userID)
	if err != nil {
		return err
	}
	if active <= 1 {
		return domain.Codedf(domain.ErrConflict, domain.CodeLastLedger,
			"这是最后一个有效账本，不能删除")
	}

	if s.snapshot == nil {
		return domain.Invalidf("备份功能不可用，无法生成删除前快照，账本未删除")
	}
	if err := s.snapshot("pre-ledger-delete"); err != nil {
		// 底层错误多为英文（SQLite / 文件系统），只落服务端日志；
		// 用户侧一律给中文可读文案，绝不把底层英文报错甩给前端。
		log.Printf("⚠️ 账本 %d 删除前快照失败（数据未改动）: %v", ledgerID, err)
		return domain.Invalidf("生成删除前一致性快照失败，账本未删除，请检查备份配置后重试")
	}

	ok, err := s.repo.SoftDeleteLedger(ledgerID)
	if err != nil {
		return err
	}
	if !ok {
		return domain.ErrNotFound
	}
	return nil
}
