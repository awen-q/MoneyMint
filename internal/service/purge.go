package service

import (
	"strings"

	"familyledger/internal/domain"
	"familyledger/internal/repository"
)

// purgeConfirmWord 是永久删除的唯一确认词（两条端点共用）。
//
// 前端「清空回收站」弹层让用户手输「清空」，那是**客户端**的额外关卡，
// 请求体里传的仍然是本词（见 api/client.ts 的 purgeTrash）；服务端只认这一个值，
// 不做同义词 / 模糊匹配——确认机制一旦宽容就等于没有。
const purgeConfirmWord = "删除"

// purgeLogLimit 是回收站页脚「永久删除记录」区块的条数上限（产品口径：最近 50）。
const purgeLogLimit = 50

// PurgeDeletedView 是永久删除响应里的单条明细。
type PurgeDeletedView struct {
	UUID        string `json:"uuid"`
	Description string `json:"description"`
	// WasInTrash=false 表示这笔交易是「因冲正配对连带删除」的有效交易
	// （不在回收站），前端二次确认文案需要提前告知这个数字。
	WasInTrash bool `json:"was_in_trash"`
}

// PurgeResultView 是两条永久删除端点的统一响应体。
type PurgeResultView struct {
	OK             bool               `json:"ok"`
	Count          int                `json:"count"`
	Deleted        []PurgeDeletedView `json:"deleted"`
	PurgedPostings int                `json:"purged_postings"`
	// AlreadyPurged 仅在单笔幂等命中（该 uuid 已被删过、sync_log 有 delete 事件）时出现；
	// 清空回收站命中空表是正常结果，不带本字段。
	AlreadyPurged bool `json:"already_purged,omitempty"`
}

// PurgeSummaryView 是页脚「N 笔可删 / M 笔系统交易保留」的数据源。
//
// 唯一算法：repository.PlanPurge(closure, 回收站全部 uuid, PurgeModeAll)。
// 数字**必须由服务端算**：闭包会把「不在回收站的有效配对交易」拉进来，
// 前端只看得见回收站那几行，自己数出来的 N 一定小于真实删除数。
type PurgeSummaryView struct {
	Deletable  int `json:"deletable"`   // 实际会被物理删除的笔数
	SystemKept int `json:"system_kept"` // 被保留的笔数（含因配对连带保留）
	Paired     int `json:"paired"`      // 其中不在回收站、会随配对一起删的笔数
}

// PurgeLogView 是「永久删除记录」区块的一行（本机审计，全体成员可见）。
type PurgeLogView struct {
	UUID        string `json:"uuid"`
	Description string `json:"description"`
	AmountNote  string `json:"amount_note"`
	WasInTrash  bool   `json:"was_in_trash"`
	ActorName   string `json:"actor_name"`
	PurgedAt    string `json:"purged_at"`
}

// TrashOverview 是 GET /api/transactions/trash 的完整载荷。
type TrashOverview struct {
	Items   []TrashItemView
	Summary PurgeSummaryView
	Log     []PurgeLogView
}

// PurgeTransaction 永久删除单笔（仅 owner）。
//
// 判定顺序（写死，别改）：
//  1. owner（editor → 403 txn_purge_forbidden；非成员 / viewer → ErrForbidden）；
//  2. confirm（空 / 不匹配 → 400 txn_purge_confirm_required）；
//  3. 落库：CodedError 原样向上（not_deleted / not_allowed 均 409）；
//     行不存在时查 sync_log 判幂等：有 delete 事件 → 200 already_purged，否则 404。
//
// 幂等的意义：用户在弱网下连点两次「永久删除」，第二次不该报错——
// 交易本来就已经没了，这正是用户想要的结果。
func (s *Service) PurgeTransaction(ledgerID, userID int64, txnUUID, confirm string) (PurgeResultView, error) {
	role, err := s.LedgerRole(userID, ledgerID)
	if err != nil {
		return PurgeResultView{}, err
	}
	if err := requireOwnerForPurge(role); err != nil {
		return PurgeResultView{}, err
	}
	if err := validatePurgeConfirm(confirm); err != nil {
		return PurgeResultView{}, err
	}
	txnUUID = strings.TrimSpace(txnUUID)
	if txnUUID == "" {
		return PurgeResultView{}, txnNotFound()
	}

	out, err := s.repo.PurgeTransactions(repository.PurgeInput{
		LedgerID: ledgerID,
		ActorID:  userID,
		Seeds:    []string{txnUUID},
		Mode:     repository.PurgeModeSingle,
	})
	if err != nil {
		return PurgeResultView{}, err // not_deleted / not_allowed / 并发 409
	}
	if len(out.Deleted) == 0 {
		// 种子不存在（或已不在本账本）：用 sync_log 上的 delete 事件区分
		// 「早已被永久删除」与「从未存在」，不引入墓碑表。
		exists, err := s.repo.TxnDeleteEventExists(ledgerID, txnUUID)
		if err != nil {
			return PurgeResultView{}, err
		}
		if exists {
			return PurgeResultView{
				OK:            true,
				Count:         0,
				Deleted:       []PurgeDeletedView{},
				AlreadyPurged: true,
			}, nil
		}
		return PurgeResultView{}, txnNotFound()
	}
	return purgeResultView(out), nil
}

// PurgeTrash 清空回收站（仅 owner）。
//
// 判定顺序：owner → confirm → 回收站 uuid 作种子 → PurgeModeAll（系统交易整对保留）。
// 空回收站直接返回 `{ok:true,count:0,deleted:[],purged_postings:0}`，
// **不带** already_purged：空回收站是正常结果，不是幂等命中，前端不该提示「已被删除」。
func (s *Service) PurgeTrash(ledgerID, userID int64, confirm string) (PurgeResultView, error) {
	role, err := s.LedgerRole(userID, ledgerID)
	if err != nil {
		return PurgeResultView{}, err
	}
	if err := requireOwnerForPurge(role); err != nil {
		return PurgeResultView{}, err
	}
	if err := validatePurgeConfirm(confirm); err != nil {
		return PurgeResultView{}, err
	}

	seeds, err := s.repo.DeletedTransactionUUIDs(ledgerID)
	if err != nil {
		return PurgeResultView{}, err
	}
	if len(seeds) == 0 {
		return PurgeResultView{OK: true, Count: 0, Deleted: []PurgeDeletedView{}}, nil
	}

	out, err := s.repo.PurgeTransactions(repository.PurgeInput{
		LedgerID: ledgerID,
		ActorID:  userID,
		Seeds:    seeds,
		Mode:     repository.PurgeModeAll,
	})
	if err != nil {
		return PurgeResultView{}, err
	}
	return purgeResultView(out), nil
}

// TrashOverview 组装回收站列表 + 可删统计 + 最近审计（一次请求）。
//
// 为什么三个东西挤在一个 GET 上：端点总数被规格钉死（41→43，两条都给了删除动作），
// 不给审计留独立路由；而回收站页本来就要拉列表，一次往返取回三样且三者同源
// （同一份闭包、同一次 PlanPurge），不会出现「列表说 3 笔、弹层说 5 笔」。
//
// can_purge / is_system / pair_uuid 都是 additive 字段，全 false / 空时被 omitempty
// 省略，旧响应形状不变。
func (s *Service) TrashOverview(ledgerID, userID int64) (TrashOverview, error) {
	items, err := s.ListDeletedTransactions(ledgerID, userID)
	if err != nil {
		return TrashOverview{}, err
	}

	seeds := make([]string, 0, len(items))
	for _, item := range items {
		seeds = append(seeds, item.UUID)
	}

	closure, _, err := s.repo.ExpandPurgeClosure(ledgerID, seeds)
	if err != nil {
		return TrashOverview{}, err
	}
	targets, kept, err := repository.PlanPurge(closure, seeds, repository.PurgeModeAll)
	if err != nil {
		return TrashOverview{}, err
	}

	summary := PurgeSummaryView{Deletable: len(targets), SystemKept: len(kept)}
	deletable := make(map[string]struct{}, len(targets))
	for _, c := range targets {
		deletable[c.UUID] = struct{}{}
		if !c.InTrash() {
			// 不在回收站但会被连带删除的笔数（确认弹层的第二行提示）
			summary.Paired++
		}
	}

	pairs := repository.PurgePairMap(closure)
	candidates := make(map[string]repository.PurgeCandidate, len(closure))
	for _, c := range closure {
		candidates[c.UUID] = c
	}

	role, _ := s.repo.RoleOf(ledgerID, userID)
	for i := range items {
		c, ok := candidates[items[i].UUID]
		if !ok {
			continue // 理论上不可能：列表项就是闭包种子
		}
		items[i].IsSystem = c.IsSystem()
		items[i].PairUUID = pairs[c.UUID]
		// 单笔入口与「清空」共用同一份可删判定：闭包内任何一笔是系统交易，
		// 这个入口对该条目就不可用（否则用户点下去只会拿到 409）。
		_, ok = deletable[items[i].UUID]
		items[i].CanPurge = role == domain.RoleOwner && ok
	}

	log, err := s.PurgeLog(ledgerID)
	if err != nil {
		return TrashOverview{}, err
	}
	return TrashOverview{Items: items, Summary: summary, Log: log}, nil
}

// PurgeLog 读取最近审计（供 TrashOverview 与测试复用）。
//
// 可见性：审计对全体成员可见（含 viewer）；只有操作入口是 owner-only。
func (s *Service) PurgeLog(ledgerID int64) ([]PurgeLogView, error) {
	rows, err := s.repo.PurgeLogEntries(ledgerID, purgeLogLimit)
	if err != nil {
		return nil, err
	}
	out := make([]PurgeLogView, 0, len(rows))
	for _, row := range rows {
		out = append(out, PurgeLogView{
			UUID:        row.UUID,
			Description: row.Description,
			AmountNote:  row.AmountNote,
			WasInTrash:  row.WasInTrash,
			ActorName:   row.ActorName,
			PurgedAt:    row.PurgedAt,
		})
	}
	return out, nil
}

// requireOwnerForPurge 是永久删除的唯一权限口径（与 middleware 的 viewer 拦截双保险）。
//
// 非成员 / viewer 走 ErrForbidden（middleware 已先拦成 403「只读成员无写权限」）；
// editor 走 403 txn_purge_forbidden —— editor 能记账、能软删，但不能永久删除：
// 物理删除不可回滚，只有对账本负最终责任的 owner 能做。
func requireOwnerForPurge(role string) error {
	switch role {
	case domain.RoleOwner:
		return nil
	case domain.RoleEditor:
		return domain.Codedf(domain.ErrForbidden, domain.CodeTxnPurgeForbidden,
			"只有账本 owner 可以永久删除")
	default:
		return domain.ErrForbidden
	}
}

// validatePurgeConfirm 校验确认词；空 / 不匹配统一 400 txn_purge_confirm_required。
//
// 取 TrimSpace 后严等：移动端输入法常在词尾带一个全角空格 / 换行，
// 那仍然是用户明确输入的「删除」，不该被判成未确认；但「清空」「确定」一律拒绝。
func validatePurgeConfirm(confirm string) error {
	if strings.TrimSpace(confirm) == purgeConfirmWord {
		return nil
	}
	return domain.Codedf(domain.ErrInvalid, domain.CodeTxnPurgeConfirmRequired,
		"永久删除需要确认：请在确认框中输入「删除」")
}

// purgeResultView 把落库结果转成对外视图。
// Deleted 始终是非 nil 空切片（前端 `v-for` 与 JSON 形状稳定）。
func purgeResultView(out repository.PurgeOutcome) PurgeResultView {
	view := PurgeResultView{
		OK:             true,
		Count:          len(out.Deleted),
		Deleted:        make([]PurgeDeletedView, 0, len(out.Deleted)),
		PurgedPostings: out.Postings,
	}
	for _, c := range out.Deleted {
		view.Deleted = append(view.Deleted, PurgeDeletedView{
			UUID:        c.UUID,
			Description: c.Description,
			WasInTrash:  c.InTrash(),
		})
	}
	return view
}

// txnNotFound 构造 404 txn_not_found（从未存在 / 属于其他账本）。
func txnNotFound() error {
	return domain.Codedf(domain.ErrNotFound, domain.CodeTxnNotFound, "交易不存在")
}
