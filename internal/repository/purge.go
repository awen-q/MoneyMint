package repository

import (
	"database/sql"
	"errors"
	"strings"

	"familyledger/internal/domain"
)

// purgeBatchSize 是 IN 子句单批上限。
//
// SQLite 的绑定变量上限按保守的 999 计（现代版本放宽到 32766，但不能假设部署
// 环境的库版本），取 500 留余量：分批语句里除 id/uuid 外还要带 ledger_id 等标量参数。
const purgeBatchSize = 500

// purgeClosureDepth 是冲正闭包的最大展开深度。
//
// 实际链长 = 1（原交易）+ 连续修改次数；8 只是防环 / 防爆的硬闸，不是业务上限。
const purgeClosureDepth = 8

// purgeAmountNoteMaxItems 是审计金额摘要里最多拼接的分录条数（超出追加省略号）。
// 审计是「删除前长什么样」的快照，不是账单，超过 3 条就没有阅读价值。
const purgeAmountNoteMaxItems = 3

// purgeAmountNoteEllipsis 是分录超长时的截断标记（前面带一个空格，与 `" / "` 分隔符同风格）。
const purgeAmountNoteEllipsis = " …"

// purgeLogFallbackLimit 是 PurgeLogEntries 收到非法 limit 时的默认条数。
// 权威值在 service.purgeLogLimit（产品口径 50），这里只是防御性兜底。
const purgeLogFallbackLimit = 50

// PurgeCandidate 是闭包内一笔交易的「删除前快照」。
//
// 这份快照只服务于永久删除：判定（是否在回收站 / 是否系统交易）、审计写入、
// 响应回显都只从它取数，删除过程中不再回表（行删掉之后回表一律查不到）。
type PurgeCandidate struct {
	ID                 int64
	UUID               string
	Description        string
	DeletedAt          string // 空串 = 未软删（不在回收站）
	OpeningAccountUUID string
	BalanceKey         string
	ImportBatchID      string
	ReversalOf         string // 非空 = 本身是冲正
	ReversedBy         string // 非空 = 已被冲正
	AmountNote         string // 审计用金额摘要（见 attachAmountNotesOn）
}

// InTrash 报告该交易删除前是否已在回收站（= 响应里的 was_in_trash）。
func (c PurgeCandidate) InTrash() bool { return c.DeletedAt != "" }

// IsSystem 是「系统生成交易」的唯一判定口径（三重，任一命中即系统交易）。
//
// 与 service.computeCanEdit 的不可编辑判定同源，但语义独立：
// 期初（opening_account_uuid）/ 校准（balance_key）/ 导入批次（import_batch_id）。
// 这三类交易由系统生成、无法在界面上重建，永久删除后用户没有任何手段补回账目，
// 因此一律拒绝（单笔 409 / 清空模式整对保留）。
func (c PurgeCandidate) IsSystem() bool {
	return c.OpeningAccountUUID != "" || c.BalanceKey != "" || c.ImportBatchID != ""
}

// PurgeMode 决定「闭包命中系统交易」时的处理方式。
type PurgeMode int

const (
	// PurgeModeSingle：单笔永久删除。任一闭包成员是系统交易 → 409 txn_purge_not_allowed（整笔不删）。
	PurgeModeSingle PurgeMode = iota
	// PurgeModeAll：清空回收站。命中系统交易的整对保留，其余继续删。
	PurgeModeAll
)

// PurgeInput 是永久删除的落库输入。
type PurgeInput struct {
	LedgerID int64
	ActorID  int64    // 操作人（写 txn_purge_log.actor_id）
	Seeds    []string // 单笔：[uuid]；清空：回收站全部 uuid
	Mode     PurgeMode
}

// PurgeOutcome 是永久删除的落库结果。
type PurgeOutcome struct {
	Deleted  []PurgeCandidate // 已物理删除（sync_log 与审计已同事务写入）
	Kept     []PurgeCandidate // 因系统判定被保留（仅 PurgeModeAll 可能非空）
	Postings int              // 物理删除的分录行数
	Missing  []string         // 种子中不存在的 uuid（供幂等判定）
}

// PurgeLogRow 是审计表的一行（storage → service 的载体）。
type PurgeLogRow struct {
	UUID        string
	Description string
	AmountNote  string
	WasInTrash  bool
	ActorName   string
	PurgedAt    string
}

// ExpandPurgeClosure 从种子 uuid 出发做冲正配对闭包展开（只读，严格限 ledger_id）。
//
// 返回闭包（visited 去重；种子及其 BFS 顺序在前）与缺失的种子 uuid。
// 悬空配对（reversed_by 指向不存在的 uuid）只是「展开不出下一层」，不报错：
// 账本历史里存在被删掉一半的冲正链，此时唯一正确的行为是只删自己。
func (s *Store) ExpandPurgeClosure(ledgerID int64, seeds []string) ([]PurgeCandidate, []string, error) {
	return expandPurgeClosureOn(s.db, ledgerID, seeds)
}

// PlanPurge 是「闭包 → 删哪些 / 保留哪些」的纯函数（可单测，无 I/O）。
//
// 单笔模式额外做两条校验，均返回 domain.CodedError：
//   - 种子未软删 → 409 txn_purge_not_deleted
//   - 闭包内有系统交易（含被配对连带）→ 409 txn_purge_not_allowed
//
// 清空模式不做「未软删」校验：种子本来就只有回收站里的交易，而被连带拉进闭包的
// 有效配对成员**应当**一并删除（见 design 坑 1：只删一半会让账本净额错、或留下孤儿冲正）。
//
// 清空模式的保留口径是「连通分量」而不是「单个配对」：闭包内按冲正配对边求连通分量，
// 只要某个分量里有一笔系统交易，整条链一起保留。连续修改 A→R1→R2 时若只保留 A、R1
// 而删掉 R2，会留下一条净额被改变的半条链——保留范围宁大勿小。
func PlanPurge(closure []PurgeCandidate, seeds []string, mode PurgeMode) (targets, kept []PurgeCandidate, err error) {
	switch mode {
	case PurgeModeSingle:
		// 1) 种子必须存在且在回收站（不存在由调用方按幂等 / 404 处理，这里跳过）。
		found := make(map[string]PurgeCandidate, len(closure))
		for _, c := range closure {
			found[c.UUID] = c
		}
		for _, seed := range seeds {
			if seed == "" {
				continue
			}
			c, ok := found[seed]
			if !ok {
				continue
			}
			if !c.InTrash() {
				return nil, nil, domain.Codedf(domain.ErrConflict, domain.CodeTxnPurgeNotDeleted,
					"这笔交易不在回收站，无法永久删除")
			}
		}
		// 2) 闭包内不得含系统交易（含被配对连带进来的那条）。
		blocked := make([]string, 0, 1)
		for _, c := range closure {
			if c.IsSystem() {
				blocked = append(blocked, c.UUID)
			}
		}
		if len(blocked) > 0 {
			return nil, nil, &domain.CodedError{
				Sentinel: domain.ErrConflict,
				Code:     domain.CodeTxnPurgeNotAllowed,
				Message:  "系统生成的交易（期初 / 校准 / 导入批次）不能永久删除",
				Details:  map[string]any{"blocked_uuids": blocked},
			}
		}
		return append([]PurgeCandidate(nil), closure...), nil, nil

	case PurgeModeAll:
		components := purgeComponents(closure)
		blockedComponents := make(map[int]struct{})
		for _, c := range closure {
			if c.IsSystem() {
				blockedComponents[components[c.UUID]] = struct{}{}
			}
		}
		targets = make([]PurgeCandidate, 0, len(closure))
		kept = make([]PurgeCandidate, 0, len(blockedComponents))
		for _, c := range closure {
			if _, blocked := blockedComponents[components[c.UUID]]; blocked {
				kept = append(kept, c)
				continue
			}
			targets = append(targets, c)
		}
		return targets, kept, nil

	default:
		// 未知模式按最保守处理：什么都不删（宁可让用户重试，也不能误删）。
		return nil, append([]PurgeCandidate(nil), closure...), nil
	}
}

// purgeHookBeforeDeleteTransactions 是「删交易之前的最后一个可注入点」，生产环境恒为 nil。
//
// 存在的唯一理由：让「闭包里的一笔在『读到删』之间被并发删掉」这条 409 + 整事务
// 回滚路径可以被**确定性**地测到。本库是单连接 SQLite（MaxOpenConns=1），真心
// 构造并发只能得到 flaky 测试；而这条路径恰恰是「删一半也报成功」的唯一防线。
var purgeHookBeforeDeleteTransactions func(tx *sql.Tx)

// PurgeTransactions 在单一大事务内完成：读闭包 → 裁决 → 删分录 → 删交易 → 写 sync_log → 写审计。
//
// 顺序不可调换（两条硬理由）：
//  1. 先删 postings 再删 transactions：transactions 删除会触发 postings 的
//     ON DELETE CASCADE，先删交易就拿不到分录行数（purged_postings 只能是 0）；
//     更重要的是换 Postgres 或某次部署忘了开 FK 时，行为会分叉成「留孤儿」和「没孤儿」两种。
//  2. sync_log 与审计必须和业务删除同事务：只删行不写事件，其他设备永远拉不到这条删除。
//
// 并发兜底：删完交易的 RowsAffected 必须等于目标数，否则整事务回滚并返回 409
// （不带错误码，前端回落到「重新加载回收站」文案）。
func (s *Store) PurgeTransactions(in PurgeInput) (PurgeOutcome, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return PurgeOutcome{}, err
	}
	defer func() { _ = tx.Rollback() }()

	// 1) 闭包（只读，严格限 ledger_id）
	closure, missing, err := expandPurgeClosureOn(tx, in.LedgerID, in.Seeds)
	if err != nil {
		return PurgeOutcome{}, err
	}
	// 2) 审计金额摘要（只读，一次 IN 查询，禁止 N+1）
	if err := attachAmountNotesOn(tx, closure); err != nil {
		return PurgeOutcome{}, err
	}
	// 3) 裁决（纯函数；CodedError 直接向上，defer 回滚）
	targets, kept, err := PlanPurge(closure, in.Seeds, in.Mode)
	if err != nil {
		return PurgeOutcome{}, err
	}
	out := PurgeOutcome{Deleted: targets, Kept: kept, Missing: missing}
	// 4) 无目标：不写任何东西（清空空回收站 / 全部被系统判定保留）
	if len(targets) == 0 {
		return out, nil
	}

	// 5) 分录（先删）
	ids := make([]int64, 0, len(targets))
	for _, c := range targets {
		ids = append(ids, c.ID)
	}
	postings, err := deletePostingsByTxnIDs(tx, ids)
	if err != nil {
		return PurgeOutcome{}, err
	}
	// 6) 交易（带 ledger_id 守卫）
	if purgeHookBeforeDeleteTransactions != nil {
		purgeHookBeforeDeleteTransactions(tx)
	}
	affected, err := deleteTransactionsByIDs(tx, in.LedgerID, ids)
	if err != nil {
		return PurgeOutcome{}, err
	}
	if affected != int64(len(targets)) {
		// 有交易在「读到删」之间被并发改动（他端物理删除 / 换库）。整体回滚，
		// 让用户重新加载回收站后再点一次，绝不「删掉一部分就报成功」。
		return PurgeOutcome{}, &domain.CodedError{
			Sentinel: domain.ErrConflict,
			Message:  "有交易已被并发改动，请重新加载回收站后再试",
		}
	}
	out.Postings = postings

	// 7) 同步事件：每个目标一条 op=delete（sync_log 没有 (ledger,entity,op) 唯一约束，
	//    同一 uuid 可以有多条 delete —— 这正是「永久删除幂等」零成本的前提）。
	pairs := purgePairMap(closure)
	for _, c := range targets {
		if _, err := appendSyncLogOn(tx, in.LedgerID, domain.EntityTransaction, c.UUID, domain.OpDelete); err != nil {
			return PurgeOutcome{}, err
		}
		// 8) 审计（只写不删、不参与同步）
		if err := insertPurgeLogOn(tx, in.LedgerID, in.ActorID, c, pairs[c.UUID]); err != nil {
			return PurgeOutcome{}, err
		}
	}

	if err := tx.Commit(); err != nil {
		return PurgeOutcome{}, err
	}
	return out, nil
}

// TxnDeleteEventExists 判断该 uuid 是否在 sync_log 留下过 transaction 的 delete 事件。
//
// 零成本幂等：物理删后行已不存在，不引入 purge 专属墓碑表——软删时已经写过一条
// delete 事件，永久删除只是再写一条。restore 之后仍然为真（历史事件不删），
// 于是「删 → 恢复 → 再永久删」也能正常走完整流程，不会被误判成幂等命中，
// 因为那时行还在、根本走不到本函数。
//
// 性能：sync_log 只有 idx_synclog_ledger_seq(ledger_id, id)，本查询要扫该账本的
// 整条日志。家庭账本量级（几千～几万行）可接受；若日志过万，另开迁移建
// `idx_synclog_entity(ledger_id, entity_uuid, op)`（不要顺手塞进本批）。
func (s *Store) TxnDeleteEventExists(ledgerID int64, entityUUID string) (bool, error) {
	if entityUUID == "" {
		return false, nil
	}
	var one int
	err := s.db.QueryRow(
		`SELECT 1 FROM sync_log
		 WHERE ledger_id=? AND entity_type='transaction' AND entity_uuid=? AND op='delete'
		 LIMIT 1`,
		ledgerID, entityUUID, domain.OpDelete,
	).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// PurgeLogEntries 读取本机审计最近 limit 条（按 id 倒序，带操作人显示名）。
//
// 审计对**全体成员可见**（含 viewer）：只有操作入口是 owner-only。
// 操作人已注销时 display_name 为空串（LEFT JOIN，不丢审计行）。
func (s *Store) PurgeLogEntries(ledgerID int64, limit int) ([]PurgeLogRow, error) {
	if limit <= 0 {
		limit = purgeLogFallbackLimit
	}
	rows, err := s.db.Query(
		`SELECT l.uuid, l.description, l.amount_note, l.was_in_trash,
		        COALESCE(u.display_name, ''), l.purged_at
		 FROM txn_purge_log l
		 LEFT JOIN users u ON u.id = l.actor_id
		 WHERE l.ledger_id=?
		 ORDER BY l.id DESC
		 LIMIT ?`,
		ledgerID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]PurgeLogRow, 0, limit)
	for rows.Next() {
		var row PurgeLogRow
		// was_in_trash 是 INTEGER：扫进 int 再 !=0，不直接扫 bool
		// （modernc.org/sqlite 对整型 → bool 的隐式转换不做保证）。
		var wasInTrash int
		if err := rows.Scan(&row.UUID, &row.Description, &row.AmountNote, &wasInTrash,
			&row.ActorName, &row.PurgedAt); err != nil {
			return nil, err
		}
		row.WasInTrash = wasInTrash != 0
		out = append(out, row)
	}
	return out, rows.Err()
}

// PurgePairMap 返回闭包内的冲正配对映射（uuid → 配对成员 uuid，对称）。
//
// 仅供 service 组装 can_purge / pair_uuid（回收站列表）与审计 pair_uuid 使用。
// 链式修改 A→R1→R2 时一条 uuid 只会记住**第一个**配对（闭包按 id 升序处理），
// 配对关系本身在链上是多值的，审计与列表只展示一条（展示字段，不参与任何判定）。
func PurgePairMap(closure []PurgeCandidate) map[string]string {
	return purgePairMap(closure)
}

// DeletedTransactionUUIDs 返回回收站内全部交易 uuid（按删除时间倒序，与列表同序）。
//
// 清空回收站只需要种子 uuid：走 ListDeletedTransactions 会把全部分录一并装载，
// 600 笔时纯属浪费（而且分录马上要被删掉）。
func (s *Store) DeletedTransactionUUIDs(ledgerID int64) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT uuid FROM transactions
		 WHERE ledger_id=? AND deleted_at IS NOT NULL
		 ORDER BY deleted_at DESC, id DESC`,
		ledgerID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]string, 0, 32)
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// 包内辅助
// ---------------------------------------------------------------------------

// expandPurgeClosureOn 是 ExpandPurgeClosure 的 execer 版本（事务内外复用）。
//
// BFS：每一层把 frontier 里的 uuid 批量读出来，再把它们的配对边（reversal_of 与
// reversed_by，对称边）作为下一层 frontier。visited 去重保证环不会放大；
// depth 上限 purgeClosureDepth 只是硬闸。
func expandPurgeClosureOn(e execer, ledgerID int64, seeds []string) ([]PurgeCandidate, []string, error) {
	uniqueSeeds := make([]string, 0, len(seeds))
	seen := make(map[string]struct{}, len(seeds))
	for _, s := range seeds {
		if s == "" {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		uniqueSeeds = append(uniqueSeeds, s)
	}

	closure := make([]PurgeCandidate, 0, len(uniqueSeeds))
	visited := make(map[string]struct{}, len(uniqueSeeds))
	var missing []string

	frontier := uniqueSeeds
	for depth := 0; depth < purgeClosureDepth && len(frontier) > 0; depth++ {
		cands, err := loadPurgeCandidatesOn(e, ledgerID, frontier)
		if err != nil {
			return nil, nil, err
		}
		if depth == 0 {
			// 种子缺失只在第一层记录：深层缺失是「悬空配对」，属于正常历史数据。
			present := make(map[string]struct{}, len(cands))
			for _, c := range cands {
				present[c.UUID] = struct{}{}
			}
			for _, s := range uniqueSeeds {
				if _, ok := present[s]; !ok {
					missing = append(missing, s)
				}
			}
		}

		next := make([]string, 0, len(cands)*2)
		queued := make(map[string]struct{}, len(cands)*2)
		for _, c := range cands {
			if _, ok := visited[c.UUID]; ok {
				continue
			}
			visited[c.UUID] = struct{}{}
			closure = append(closure, c)
			for _, pair := range []string{c.ReversalOf, c.ReversedBy} {
				if pair == "" {
					continue
				}
				if _, ok := visited[pair]; ok {
					continue
				}
				if _, ok := queued[pair]; ok {
					continue
				}
				queued[pair] = struct{}{}
				next = append(next, pair)
			}
		}
		frontier = next
	}
	return closure, missing, nil
}

// loadPurgeCandidatesOn 按 uuid 批量读闭包候选行（含系统判定列与配对列）。
//
// **必须带 ledger_id**：transactions.uuid 全局唯一，但闭包一旦漏掉账本条件，
// A 账本的删除会连带删掉 B 账本的交易。
func loadPurgeCandidatesOn(e execer, ledgerID int64, uuids []string) ([]PurgeCandidate, error) {
	out := make([]PurgeCandidate, 0, len(uuids))
	for _, chunk := range chunkStrings(uuids, purgeBatchSize) {
		args := make([]any, 0, len(chunk)+1)
		args = append(args, ledgerID)
		for _, u := range chunk {
			args = append(args, u)
		}
		rows, err := e.Query(
			`SELECT id, uuid, description,
			        COALESCE(deleted_at, ''),
			        COALESCE(opening_account_uuid, ''), COALESCE(balance_key, ''),
			        COALESCE(import_batch_id, ''), COALESCE(reversal_of, ''),
			        COALESCE(reversed_by, '')
			 FROM transactions
			 WHERE ledger_id = ? AND uuid IN (`+placeholders(len(chunk))+`)
			 ORDER BY id`,
			args...,
		)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var c PurgeCandidate
			if err := rows.Scan(&c.ID, &c.UUID, &c.Description, &c.DeletedAt,
				&c.OpeningAccountUUID, &c.BalanceKey, &c.ImportBatchID,
				&c.ReversalOf, &c.ReversedBy); err != nil {
				rows.Close()
				return nil, err
			}
			out = append(out, c)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	return out, nil
}

// attachAmountNotesOn 批量回填 AmountNote（一次 IN 查询，禁止 N+1）。
//
// 规则（design §4.4）：取每个交易按 position 排序的前 3 条分录，拼成
// `"amount commodity"`，分录之间 `" / "`，超出追加 `" …"`。
// 不做跨币种求和、不做符号归一——审计是「删除前长什么样」，不是「花了多少钱」。
func attachAmountNotesOn(e execer, cands []PurgeCandidate) error {
	if len(cands) == 0 {
		return nil
	}
	ids := make([]int64, len(cands))
	for i := range cands {
		ids[i] = cands[i].ID
	}
	parts := make(map[int64][]string, len(cands))
	truncated := make(map[int64]bool)

	for _, chunk := range chunkInt64(ids, purgeBatchSize) {
		rows, err := e.Query(
			`SELECT p.transaction_id, CAST(p.amount AS TEXT), p.commodity
			 FROM postings p
			 WHERE p.transaction_id IN (`+placeholders(len(chunk))+`)
			 ORDER BY p.transaction_id, p.position`,
			int64Args(chunk)...,
		)
		if err != nil {
			return err
		}
		for rows.Next() {
			var txnID int64
			var amount, commodity string
			if err := rows.Scan(&txnID, &amount, &commodity); err != nil {
				rows.Close()
				return err
			}
			if len(parts[txnID]) >= purgeAmountNoteMaxItems {
				truncated[txnID] = true
				continue
			}
			parts[txnID] = append(parts[txnID], padAuditAmount(amount)+" "+commodity)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
	}

	for i := range cands {
		note := strings.Join(parts[cands[i].ID], " / ")
		if truncated[cands[i].ID] {
			note += purgeAmountNoteEllipsis
		}
		cands[i].AmountNote = note
	}
	return nil
}

// padAuditAmount 把 audit 金额补到两位小数（**纯字符串补零**）。
//
// 为什么需要：postings.amount 是 NUMERIC 亲和，'−10.00' 落库即归一为 −10，
// CAST 回文本就是 "-10"；而回收站页其他金额都是 "-10.00"。同一个页面出现两种
// 金额写法，用户会当成两个口径。所以审计里统一补到两位。
//
// 边界（刻意保守）：
//   - 不动符号、不加千分位、不四舍五入、**不读币种精度**（那不是 formatMoney）；
//   - 已有 ≥2 位小数一律原样保留（precision=4 的币种 "0.0001" 不能被补成 "0.00"）；
//   - 形如 "1.0e+15" 的指数写法不动（含小数点的尾巴长度 ≥2 自然跳过）。
func padAuditAmount(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return s
	}
	dot := strings.IndexByte(s, '.')
	if dot < 0 {
		return s + ".00"
	}
	switch frac := len(s) - dot - 1; {
	case frac == 0:
		return s + "00"
	case frac == 1:
		return s + "0"
	default:
		return s
	}
}

// deletePostingsByTxnIDs 分批删分录，返回删除行数。
//
// 必须先于 deleteTransactionsByIDs 执行（见 PurgeTransactions 注释）。
func deletePostingsByTxnIDs(tx *sql.Tx, ids []int64) (int, error) {
	total := 0
	for _, chunk := range chunkInt64(ids, purgeBatchSize) {
		res, err := tx.Exec(
			`DELETE FROM postings WHERE transaction_id IN (`+placeholders(len(chunk))+`)`,
			int64Args(chunk)...,
		)
		if err != nil {
			return 0, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return 0, err
		}
		total += int(n)
	}
	return total, nil
}

// deleteTransactionsByIDs 分批删交易（带 ledger_id 守卫），返回删除行数。
func deleteTransactionsByIDs(tx *sql.Tx, ledgerID int64, ids []int64) (int64, error) {
	var total int64
	for _, chunk := range chunkInt64(ids, purgeBatchSize) {
		args := make([]any, 0, len(chunk)+1)
		args = append(args, ledgerID)
		args = append(args, int64Args(chunk)...)
		res, err := tx.Exec(
			`DELETE FROM transactions WHERE ledger_id=? AND id IN (`+placeholders(len(chunk))+`)`,
			args...,
		)
		if err != nil {
			return 0, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return 0, err
		}
		total += n
	}
	return total, nil
}

// insertPurgeLogOn 写一条审计（同一事务内）。
func insertPurgeLogOn(tx execer, ledgerID, actorID int64, c PurgeCandidate, pairUUID string) error {
	wasInTrash := 0
	if c.InTrash() {
		wasInTrash = 1
	}
	_, err := tx.Exec(
		`INSERT INTO txn_purge_log
		 (ledger_id, uuid, description, amount_note, was_in_trash, pair_uuid,
		  actor_id, purged_at, origin_deleted_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
		ledgerID, c.UUID, c.Description, c.AmountNote, wasInTrash, pairUUID, actorID, c.DeletedAt,
	)
	return err
}

// purgePairMap 构建闭包内的对称配对映射（uuid → 配对成员 uuid）。
//
// 数据上配对边是双向写的（A.reversed_by=R 且 R.reversal_of=A），但历史数据可能
// 只写了一侧；两条边都读一遍并**对称补齐**，保证审计里 A 记 R、R 也记 A。
func purgePairMap(closure []PurgeCandidate) map[string]string {
	inClosure := make(map[string]struct{}, len(closure))
	for _, c := range closure {
		inClosure[c.UUID] = struct{}{}
	}
	pairs := make(map[string]string, len(closure))
	link := func(a, b string) {
		if a == "" || b == "" || a == b {
			return
		}
		if _, exists := pairs[a]; !exists {
			pairs[a] = b
		}
		if _, exists := pairs[b]; !exists {
			pairs[b] = a
		}
	}
	for _, c := range closure {
		if _, ok := inClosure[c.ReversalOf]; c.ReversalOf != "" && ok {
			link(c.UUID, c.ReversalOf)
		}
		if _, ok := inClosure[c.ReversedBy]; c.ReversedBy != "" && ok {
			link(c.UUID, c.ReversedBy)
		}
	}
	return pairs
}

// purgeComponents 把闭包按「冲正配对边」切成连通分量，返回 uuid → 分量代表。
//
// 并查集：链 A→R1→R2 会落在同一个分量里，从而「含系统交易的分量整体保留」
// 不会切出半条链。
func purgeComponents(closure []PurgeCandidate) map[string]int {
	index := make(map[string]int, len(closure))
	for i, c := range closure {
		index[c.UUID] = i
	}
	parent := make([]int, len(closure))
	for i := range parent {
		parent[i] = i
	}
	var find func(int) int
	find = func(x int) int {
		for parent[x] != x {
			parent[x] = parent[parent[x]]
			x = parent[x]
		}
		return x
	}
	union := func(a, b int) {
		ra, rb := find(a), find(b)
		if ra != rb {
			parent[rb] = ra
		}
	}
	for _, c := range closure {
		self := index[c.UUID]
		for _, pair := range []string{c.ReversalOf, c.ReversedBy} {
			if pair == "" {
				continue
			}
			if j, ok := index[pair]; ok {
				union(self, j)
			}
		}
	}
	out := make(map[string]int, len(closure))
	for i, c := range closure {
		out[c.UUID] = find(i)
	}
	return out
}

// placeholders 生成 n 个以逗号连接的 '?'（n<=0 返回空串）。
//
// 自己写而不用既有的 sqlArgsIn：后者只产出 `IN (...)` 片段、不接受前缀参数，
// 硬套会与 `ledger_id=?` 打架。
func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat("?,", n-1) + "?"
}

// chunkInt64 按 size 切块（size<=0 时按 purgeBatchSize）。
func chunkInt64(ids []int64, size int) [][]int64 {
	if len(ids) == 0 {
		return nil
	}
	if size <= 0 {
		size = purgeBatchSize
	}
	out := make([][]int64, 0, (len(ids)+size-1)/size)
	for start := 0; start < len(ids); start += size {
		end := start + size
		if end > len(ids) {
			end = len(ids)
		}
		out = append(out, ids[start:end])
	}
	return out
}

// chunkStrings 按 size 切块（size<=0 时按 purgeBatchSize）。
func chunkStrings(values []string, size int) [][]string {
	if len(values) == 0 {
		return nil
	}
	if size <= 0 {
		size = purgeBatchSize
	}
	out := make([][]string, 0, (len(values)+size-1)/size)
	for start := 0; start < len(values); start += size {
		end := start + size
		if end > len(values) {
			end = len(values)
		}
		out = append(out, values[start:end])
	}
	return out
}

// int64Args 把 id 切片转成 Exec/Query 的变参。
func int64Args(ids []int64) []any {
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	return args
}
