package repository

import (
	"fmt"

	"familyledger/internal/domain"

	"github.com/google/uuid"
)

// openingConflictMessage 是标记原交易已冲正时并发保护失败的固定文案。
// 期初两处调用点共用，供 S4 / S6 复用时可改传自己的冲突文案。
const openingConflictMessage = "期初已被并发修改，请重试"

// ReversalSource 是生成冲正交易所需的「原交易快照 + 写入选项」。
//
// 期初专属元数据全部为可选字段，且刻意与 domain.Transaction 解耦：
//   - 期初冲正（既有 opening.go 行为）：Tags=["opening","reversal"]、
//     OpeningAccountUUID / OpeningVersion 用于溯源、Precision 为币种精度、
//     Description 为 openingReversalDesc；
//   - 普通交易冲正（S4 校准 / S6 修改交易）：Tags 留空、Opening* 留空，
//     只生成 reversal_of = 原 uuid 与逐条取负的分录。
//
// 不用 design §1 S3 建议的 `src domain.Transaction`：该类型不含 precision，
// 且其 Tags 是「原交易」的标签（期初为 ["opening"]）而非「冲正交易」的标签
// （["opening","reversal"]），硬套会丢字段或改变既有 SQL 写入值。
// Postings 复用 OpeningPosting 这一既有分录快照载体（只取
// AccountID / Commodity / Amount / Position 四项），避免为内核再造第二套分录结构。
type ReversalSource struct {
	ID       int64
	UUID     string
	Date     string
	Postings []OpeningPosting

	Description        string
	Tags               []string
	Precision          int
	OpeningAccountUUID string
	OpeningVersion     int64

	// PrecisionByCommodity 是可选的多币种精度映射（0.6.0 S4）。
	// 不传（nil）时全部按 Precision 统一格式化，与 T08 原行为逐字一致；
	// 传入时按分录 commodity 取对应精度，保证多币种冲正不丢精度（AC-3.3）。
	PrecisionByCommodity map[string]int
}

// negateReversalPostings 把分录金额逐条取负并按给定精度格式化（纯函数）。
// 走 parseDecimalRat + big.Rat.Neg + FloatString，定点十进制、禁止浮点；
// precision <= 0 时按 2 处理，与 negateDecimal 同款兜底。
func negateReversalPostings(posts []OpeningPosting, precision int) ([]OpeningPosting, error) {
	return negateReversalPostingsByCommodity(posts, precision, nil)
}

// negateReversalPostingsByCommodity 是取负的统一实现：byCommodity 命中该币种时
// 用其精度，否则回落到 precision。nil 映射等价于 T08 原有单一精度行为。
func negateReversalPostingsByCommodity(
	posts []OpeningPosting, precision int, byCommodity map[string]int,
) ([]OpeningPosting, error) {
	if precision <= 0 {
		precision = 2
	}
	out := make([]OpeningPosting, 0, len(posts))
	for _, p := range posts {
		neg, err := parseDecimalRat(p.Amount)
		if err != nil {
			return nil, fmt.Errorf("冲正金额非法 %q: %w", p.Amount, err)
		}
		prec := precision
		if byCommodity != nil {
			if byPrec, ok := byCommodity[p.Commodity]; ok && byPrec > 0 {
				prec = byPrec
			}
		}
		out = append(out, OpeningPosting{
			AccountID: p.AccountID,
			Commodity: p.Commodity,
			Amount:    neg.Neg(neg).FloatString(prec),
			Position:  p.Position,
		})
	}
	return out, nil
}

// insertReversalTxnTx 生成一条冲正交易：同日期、分录逐条取负、
// reversal_of = 原交易 uuid，返回新交易 uuid 与自增 id。
//
// SQL 完全复用既有 insertTxnTx / insertPostingsTx（含 NULLIF 与 flag='*'），
// 金额一律走 big.Rat 定点运算，禁止浮点。
// 不复用 client_request_id（013 幂等键语义不同），不写任何版本链字段。
func insertReversalTxnTx(tx execer, ledgerID int64, src ReversalSource) (string, int64, error) {
	revUUID := uuid.NewString()
	revID, err := insertTxnTx(tx, ledgerID, txnInsert{
		UUID:               revUUID,
		Date:               src.Date,
		Description:        src.Description,
		Tags:               src.Tags,
		ReversalOf:         src.UUID,
		OpeningAccountUUID: src.OpeningAccountUUID,
		OpeningVersion:     src.OpeningVersion,
	})
	if err != nil {
		return "", 0, err
	}
	posts, err := negateReversalPostingsByCommodity(
		src.Postings, src.Precision, src.PrecisionByCommodity)
	if err != nil {
		return "", 0, err
	}
	if err := insertPostingsTx(tx, revID, posts); err != nil {
		return "", 0, err
	}
	return revUUID, revID, nil
}

// ReversalMarkInput 是「标记原交易已冲正」的输入。
type ReversalMarkInput struct {
	LedgerID     int64
	SourceID     int64
	ReversalUUID string

	// ExecErrorLabel 保留各调用点原有的 SQL 失败上下文
	// （ApplyOpening 为「标记旧期初已冲正」，RebuildAllOpenings 为「标记期初 %s 已冲正」）。
	ExecErrorLabel string
	// ConflictMessage 是 RowsAffected()==0 时随 CodeOpeningConflict 返回的中文文案。
	ConflictMessage string
	// AppendSyncLog 控制是否在同一事务内追加 sync_log op=create。
	// 期初与 S4 校准两条路径均为 true；S6 可自行编排 sync_log。
	AppendSyncLog bool
}

// markReversedTx 把原交易标记为已冲正（CAS 并发保护），并在同一事务内
// 可选追加 sync_log op=create。执行顺序严格为：
// UPDATE → RowsAffected 检查 → sync_log，与既有期初实现逐字一致。
//
// 注意：本函数与 transaction.go 的 MarkTransactionReversed 是两套语义，切勿合并——
// 后者是 S0 A-01 按 uuid 幂等标记、不写 sync_log、不带并发冲突码、不更新 updated_at。
func markReversedTx(tx execer, in ReversalMarkInput) error {
	res, err := tx.Exec(
		`UPDATE transactions SET reversed_by=?, updated_at=datetime('now')
		 WHERE id=? AND (reversed_by IS NULL OR reversed_by='')`,
		in.ReversalUUID, in.SourceID,
	)
	if err != nil {
		return fmt.Errorf("%s: %w", in.ExecErrorLabel, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return domain.Codedf(domain.ErrConflict, domain.CodeOpeningConflict, "%s", in.ConflictMessage)
	}
	if in.AppendSyncLog {
		if _, err := appendSyncLogOn(tx, in.LedgerID, domain.EntityTransaction, in.ReversalUUID, domain.OpCreate); err != nil {
			return err
		}
	}
	return nil
}
