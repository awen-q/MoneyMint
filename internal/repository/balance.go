package repository

import (
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"

	"familyledger/internal/domain"

	"github.com/google/uuid"
)

// postingsBalanceWhere 是「余额口径」的统一 WHERE 片段（不含日期上界）。
//
// computeBalancesOn（时点余额：账户卡 / 校准预检）与 BalancesByMonth（资产月度
// 序列）必须逐字同源，任何一处复制粘贴出第二份 WHERE 都会分叉——典型后果是
// 「账户卡余额」与「资产曲线」对同一账本给出两个数字，而且两边都不报错。
//
// 语义要点（两条都别改）：
//   - `a.deleted_at IS NULL`：软删账户的历史不参与（账户已不存在）；
//   - **没有 `a.close_date IS NULL`**：关户 ≠ 钱消失，已关账户的历史余额仍计入
//     （与资产页「关户仍列出」同一条理由）。
//   - `t.deleted_at IS NULL`：软删交易不计入。
const postingsBalanceWhere = ` WHERE a.ledger_id=? AND a.deleted_at IS NULL AND t.deleted_at IS NULL`

// computeBalancesOn 是 ComputeBalances / ComputeBalancesBefore 的共同私有实现
// （Q-08「单一口径源」）：beforeDate 为空表示无日期上界；非空时只累计
// t.date < beforeDate 的分录，即「截至该日日初」、不含当日（C-01）。
//
// 返回 big.Rat 精确值，禁止浮点；调用方按需格式化为定点十进制字符串。
func computeBalancesOn(e execer, ledgerID int64, beforeDate string) (map[int64]map[string]*big.Rat, error) {
	query := `SELECT p.account_id, p.commodity, CAST(p.amount AS TEXT)
		 FROM postings p
		 JOIN accounts a ON a.id=p.account_id
		 JOIN transactions t ON t.id=p.transaction_id` + postingsBalanceWhere
	args := []any{ledgerID}
	if beforeDate != "" {
		query += ` AND t.date < ?`
		args = append(args, beforeDate)
	}
	rows, err := e.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	acc := map[int64]map[string]*big.Rat{}
	for rows.Next() {
		var aid int64
		var comm, amt string
		if err := rows.Scan(&aid, &comm, &amt); err != nil {
			return nil, err
		}
		r := new(big.Rat)
		if _, ok := r.SetString(amt); !ok {
			return nil, fmt.Errorf("数据库金额非法: %q", amt)
		}
		if _, ok := acc[aid]; !ok {
			acc[aid] = map[string]*big.Rat{}
		}
		if _, ok := acc[aid][comm]; !ok {
			acc[aid][comm] = new(big.Rat)
		}
		acc[aid][comm].Add(acc[aid][comm], r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return acc, nil
}

// ComputeBalances 返回 map[accountID]map[commodity]定点十进制字符串（两位）。
// 0.6.0 S4：内部改走 computeBalancesOn 的无上界分支，对外行为原样保留。
func (s *Store) ComputeBalances(ledgerID int64) (map[int64]map[string]string, error) {
	acc, err := computeBalancesOn(s.db, ledgerID, "")
	if err != nil {
		return nil, err
	}
	out := map[int64]map[string]string{}
	for aid, m := range acc {
		mm := map[string]string{}
		for c, v := range m {
			mm[c] = v.FloatString(2)
		}
		out[aid] = mm
	}
	return out, nil
}

// ComputeBalancesBefore 返回截至 beforeDate 日初（date < beforeDate）的余额，
// 值为 big.Rat 精确有理数（S4 校准预检 / S5 导入预检共用，Q-08）。
func (s *Store) ComputeBalancesBefore(ledgerID int64, beforeDate string) (map[int64]map[string]*big.Rat, error) {
	return computeBalancesOn(s.db, ledgerID, beforeDate)
}

// MonthlyBalance 是某月的资产 / 负债累计末值（big.Rat 精确值，禁止浮点）。
//
// liab 保持分录原样符号（Liabilities 分录为负）—— 绝不取 abs：资产统计页的
// `net = assets + liabilities` 要的是「ΣAssets + ΣLiabilities」这个严格相加
// 口径（AC-12），把负债取成绝对值会让净资产凭空变大。
type MonthlyBalance struct {
	Month       string   // "YYYY-MM"
	Assets      *big.Rat // Σ Assets 分录
	Liabilities *big.Rat // Σ Liabilities 分录（负数）
}

// BalancesByMonth 返回指定年份 1..12 月的资产 / 负债月末末值（恒 12 个点）。
//
// **月末末值 = 「次月 1 日日初」**（本接口最容易错的一处：错了不报错，只会让
// 整条曲线整体错一个月）。computeBalancesOn 的 beforeDate 语义是
// `t.date < beforeDate`，即「截至该日日初、不含当日」，所以：
//   - 「2026-01 的值」= 截至 2026-02-01 日初（**含** 2026-01-31 全天交易），
//   - 「2026-12 的值」= 截至 2027-01-01 日初（**含** 2026-12-31 全天交易）。
//
// 传 "2026-01-31" 会漏掉 1 月 31 日当天的全部交易 —— 曲线整体左移一个月。
//
// 实现只发一次查询（`t.date < 次年 1 月 1 日`，含该年之前的全部历史，与
// computeBalancesOn 同一个 WHERE 前缀 postingsBalanceWhere），然后在 Go 里按
// 日期推进累加，每跨过一个月边界就把当前累计**快照**一次；不做 12 次全表扫。
//
// 只统计 commodity 匹配的分录：其它币种的账户余额不进本序列（前端另有单列
// 口径），本方法也**不提供跨币种合计**。
func (s *Store) BalancesByMonth(ledgerID int64, year int, commodity string) ([]MonthlyBalance, error) {
	nextYearStart := fmt.Sprintf("%04d-01-01", year+1)
	rows, err := s.db.Query(
		`SELECT t.date, a.type, CAST(p.amount AS TEXT)
		 FROM postings p
		 JOIN accounts a ON a.id=p.account_id
		 JOIN transactions t ON t.id=p.transaction_id`+postingsBalanceWhere+`
		   AND t.date < ?
		   AND p.commodity = ?
		   AND a.type IN (?, ?)
		 ORDER BY t.date`,
		ledgerID, nextYearStart, commodity, domain.TypeAssets, domain.TypeLiabilities,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	baseOrdinal := year*12 + 1 // 该年 1 月的月份序数
	assets := new(big.Rat)
	liabilities := new(big.Rat)
	points := make([]MonthlyBalance, 0, 12)
	next := 0 // 下一个待封存的月份下标（0 = 1 月）

	seal := func() {
		points = append(points, MonthlyBalance{
			Month:       fmt.Sprintf("%04d-%02d", year, next+1),
			Assets:      new(big.Rat).Set(assets),
			Liabilities: new(big.Rat).Set(liabilities),
		})
		next++
	}

	for rows.Next() {
		var date, accountType, amount string
		if err := rows.Scan(&date, &accountType, &amount); err != nil {
			return nil, err
		}
		ordinal, err := monthOrdinal(date)
		if err != nil {
			return nil, err
		}
		// 当前行已进入更晚的月份 → 先把尚未封存的月份按「截至上月月末」封存。
		// 封存发生在累加之前，因此边界日的交易一定落在它自己那个月里。
		for next < 12 && ordinal >= baseOrdinal+next+1 {
			seal()
		}
		r := new(big.Rat)
		if _, ok := r.SetString(amount); !ok {
			return nil, fmt.Errorf("数据库金额非法: %q", amount)
		}
		if accountType == domain.TypeAssets {
			assets.Add(assets, r)
		} else {
			liabilities.Add(liabilities, r)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// 年内没有后续交易的月份：余额结转到年底（曲线平坦段，前端不能缺点）。
	for next < 12 {
		seal()
	}
	return points, nil
}

// monthOrdinal 把 'YYYY-MM-DD' 转成「年×12+月」的单调序数，用于月份边界比较。
func monthOrdinal(date string) (int, error) {
	if len(date) < 7 || date[4] != '-' {
		return 0, fmt.Errorf("数据库交易日期非法: %q", date)
	}
	year, err := strconv.Atoi(date[:4])
	if err != nil {
		return 0, fmt.Errorf("数据库交易日期非法: %q", date)
	}
	month, err := strconv.Atoi(date[5:7])
	if err != nil || month < 1 || month > 12 {
		return 0, fmt.Errorf("数据库交易日期非法: %q", date)
	}
	return year*12 + month, nil
}

// AccountBalanceRats 返回某账户按币种精确汇总的余额（big.Rat，禁止浮点）。
// 仅统计账本内未删除交易；账户自身已关闭不影响历史余额计算。
func (s *Store) AccountBalanceRats(ledgerID int64, accountUUID string) (map[string]*big.Rat, error) {
	return accountBalanceRatsOn(s.db, ledgerID, accountUUID)
}

// accountBalanceRatsOn 在给定执行器（db 或事务）上汇总账户余额。
func accountBalanceRatsOn(e execer, ledgerID int64, accountUUID string) (map[string]*big.Rat, error) {
	rows, err := e.Query(
		`SELECT p.commodity, CAST(p.amount AS TEXT)
		 FROM postings p
		 JOIN accounts a ON a.id=p.account_id
		 JOIN transactions t ON t.id=p.transaction_id
		 WHERE a.ledger_id=? AND a.uuid=? AND a.deleted_at IS NULL AND t.deleted_at IS NULL`,
		ledgerID, accountUUID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	sums := map[string]*big.Rat{}
	for rows.Next() {
		var comm, amt string
		if err := rows.Scan(&comm, &amt); err != nil {
			return nil, err
		}
		r := new(big.Rat)
		if _, ok := r.SetString(amt); !ok {
			return nil, fmt.Errorf("数据库金额非法: %q", amt)
		}
		if _, ok := sums[comm]; !ok {
			sums[comm] = new(big.Rat)
		}
		sums[comm].Add(sums[comm], r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return sums, nil
}

// commodityPrecisionMapOn 读取账本币种精度表；未出现的币种由调用方按 2 位兜底。
func commodityPrecisionMapOn(e execer, ledgerID int64) (map[string]int, error) {
	rows, err := e.Query(
		`SELECT symbol, "precision" FROM commodities WHERE ledger_id=?`, ledgerID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var sym string
		var p int
		if err := rows.Scan(&sym, &p); err != nil {
			return nil, err
		}
		out[sym] = p
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// 0.6.0 S4 · 余额校准（AC-3.1~3.8）
// ---------------------------------------------------------------------------

// BalanceTarget 是用户设置的「截至 D 日初」目标余额（带符号定点十进制字符串）。
type BalanceTarget struct {
	Commodity     string
	TargetBalance string
	Precision     int
}

// BalanceEntry 是按币种的补记差额。
type BalanceEntry struct {
	Commodity string
	Diff      string
}

// BalanceCalibrationInput 是单事务写入校准所需的全部输入（service 层已校验日期/权限）。
type BalanceCalibrationInput struct {
	AccountID    int64
	AccountUUID  string
	AsOfDate     string // D
	PostingDate  string // D-1
	Targets      []BalanceTarget
	Description  string // 固定中文模板：余额校准: 截至D日初
	UserID       int64  // 操作人（写 created_by，供 AC-3.6 版本历史展示）
}

// BalanceCalibrationResult 是 ApplyBalanceCalibration 的结果。
type BalanceCalibrationResult struct {
	Status          string // created | updated
	TransactionUUID string
	ReversalUUID    string // 首次为空
	Version         int64
	Date            string // D-1
	Entries         []BalanceEntry
}

// BalanceCalibrationRecord 是一条校准交易（含历史版本信息，AC-3.6）。
type BalanceCalibrationRecord struct {
	ID              int64
	UUID            string
	TransactionDate string // D-1
	BalanceDate     string // D
	BalanceKey      string
	Version         int64
	CreatedAt       string
	CreatedByName   string
	Reversed        bool
	Entries         []BalanceEntry // 该账户分录（差额原因）
}

func balanceKeyPrefix(accountUUID string) string {
	return "balance:" + accountUUID + ":v"
}

// balanceKeyVersion 从 balance:{uuid}:v{n} 解析版本号；非法键返回 0。
func balanceKeyVersion(key string) int64 {
	i := strings.LastIndex(key, ":v")
	if i < 0 {
		return 0
	}
	var v int64
	if _, err := fmt.Sscanf(key[i+2:], "%d", &v); err != nil {
		return 0
	}
	return v
}

// BalanceCalibrationHistory 返回某账户在指定 D 的全部校准交易（含已冲正版本），按 id 升序。
// 校准交易靠独立列 balance_date / balance_key 识别，绝不写 opening_account_uuid（AC-3.4）。
func (s *Store) BalanceCalibrationHistory(ledgerID, accountID int64, accountUUID, asOfDate string) ([]BalanceCalibrationRecord, error) {
	return balanceCalibrationHistoryOn(s.db, ledgerID, accountID, accountUUID, asOfDate)
}

func balanceCalibrationHistoryOn(e execer, ledgerID, accountID int64, accountUUID, asOfDate string) ([]BalanceCalibrationRecord, error) {
	rows, err := e.Query(
		`SELECT t.id, t.uuid, t.date, COALESCE(t.balance_date,''), COALESCE(t.balance_key,''),
		        COALESCE(t.created_at,''), COALESCE(u.display_name, u.username, ''),
		        COALESCE(t.reversed_by,'')
		 FROM transactions t LEFT JOIN users u ON t.created_by=u.id
		 WHERE t.ledger_id=? AND t.balance_date=? AND t.balance_key LIKE ?
		   AND t.deleted_at IS NULL
		 ORDER BY t.id`,
		ledgerID, asOfDate, balanceKeyPrefix(accountUUID)+"%",
	)
	if err != nil {
		return nil, err
	}
	out := []BalanceCalibrationRecord{}
	for rows.Next() {
		var rec BalanceCalibrationRecord
		var key, reversedBy string
		if err := rows.Scan(&rec.ID, &rec.UUID, &rec.TransactionDate, &rec.BalanceDate, &key,
			&rec.CreatedAt, &rec.CreatedByName, &reversedBy); err != nil {
			rows.Close()
			return nil, err
		}
		rec.BalanceKey = key
		rec.Version = balanceKeyVersion(key)
		rec.Reversed = reversedBy != ""
		rec.Entries = []BalanceEntry{}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// 单连接(MaxOpenConns=1)下不能同时持有两个结果集，故主查询关闭后再逐条读分录。
	for i := range out {
		posts, err := e.Query(
			`SELECT p.commodity, CAST(p.amount AS TEXT) FROM postings p
			 WHERE p.transaction_id=? AND p.account_id=? ORDER BY p.position`,
			out[i].ID, accountID,
		)
		if err != nil {
			return nil, err
		}
		for posts.Next() {
			var commodity, amount string
			if err := posts.Scan(&commodity, &amount); err != nil {
				posts.Close()
				return nil, err
			}
			rat, err := parseDecimalRat(amount)
			if err != nil {
				posts.Close()
				return nil, err
			}
			out[i].Entries = append(out[i].Entries, BalanceEntry{
				Commodity: commodity, Diff: rat.FloatString(2),
			})
		}
		if err := posts.Err(); err != nil {
			posts.Close()
			return nil, err
		}
		posts.Close()
	}
	return out, nil
}

// nextBalanceVersionOn 返回该账户下一个校准版本号：历史校准行数 + 1。
// 限定 balance_key 前缀而非 balance_date，避免不同 D 撞同一个 v{n} 唯一索引。
func nextBalanceVersionOn(e execer, ledgerID int64, accountUUID string) (int64, error) {
	var n int64
	// 不过滤 deleted_at：balance_key 的部分唯一索引对软删行同样生效，
	// 若漏算软删校准会导致新 key 撞唯一索引、整事务失败。
	err := e.QueryRow(
		`SELECT count(*) FROM transactions
		 WHERE ledger_id=? AND balance_key LIKE ?`,
		ledgerID, balanceKeyPrefix(accountUUID)+"%",
	).Scan(&n)
	return n + 1, err
}

// loadAllPostingsOn 读取一笔交易的全部分录（冲正旧校准用，含权益对手方）。
func loadAllPostingsOn(e execer, txnID int64) ([]OpeningPosting, error) {
	rows, err := e.Query(
		`SELECT p.account_id, p.commodity, CAST(p.amount AS TEXT), p.position
		 FROM postings p WHERE p.transaction_id=? ORDER BY p.position`, txnID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []OpeningPosting{}
	for rows.Next() {
		var p OpeningPosting
		if err := rows.Scan(&p.AccountID, &p.Commodity, &p.Amount, &p.Position); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ApplyBalanceCalibration 在单事务内完成余额校准（AC-3.1~3.8）：
//  1. 复用 ensureOpeningEquityTx 取 Equity:Opening-Balances；已关闭换独立码
//     opening_equity_closed（Q-11）；
//  2. 同 (账户, D) 已生效校准 → 复用 S3/T08 冲正内核生成同日取负冲正 +
//     markReversedTx 标记失效（含 sync_log），旧交易只减不删（AC-3.6）；
//  3. 用 computeBalancesOn 计算截至 D 日初累计（此时旧校准与其冲正相抵，
//     得到自然累计；C-01 不含 D 当日）；
//  4. 差额 = 目标 − 累计，按币种精度定点生成「账户 ± 差额 / 权益 ∓ 差额」；
//  5. 新校准交易 date=D-1，balance_date=D、balance_key=balance:{uuid}:v{n}，
//     描述固定中文模板、不写 tags、不写 opening_account_uuid（D-05 / Q-02）；
//  6. sync_log op=create 与业务行同事务，COMMIT 后返回。
//
// 任一币种失败 / 任一步报错整体回滚；不触发 RebuildOpenings、不改 ledgers.opening_date、
// 不轮换 instance_id。
func (s *Store) ApplyBalanceCalibration(ledgerID int64, in BalanceCalibrationInput) (BalanceCalibrationResult, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return BalanceCalibrationResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	equityID, err := ensureOpeningEquityTx(tx, ledgerID, in.PostingDate)
	if err != nil {
		var ce *domain.CodedError
		if errors.As(err, &ce) && ce.Code == domain.CodeAccountClosed {
			return BalanceCalibrationResult{}, domain.Codedf(domain.ErrConflict,
				domain.CodeOpeningEquityClosed,
				"期初余额权益账户已关闭，无法生成校准分录，请先在账户页恢复该账户")
		}
		return BalanceCalibrationResult{}, err
	}

	history, err := balanceCalibrationHistoryOn(tx, ledgerID, in.AccountID, in.AccountUUID, in.AsOfDate)
	if err != nil {
		return BalanceCalibrationResult{}, err
	}

	precisionByCommodity := make(map[string]int, len(in.Targets))
	maxPrecision := 2
	for _, target := range in.Targets {
		prec := target.Precision
		if prec <= 0 {
			prec = 2
		}
		precisionByCommodity[target.Commodity] = prec
		if prec > maxPrecision {
			maxPrecision = prec
		}
	}

	// ② 冲正旧校准（只处理一条未失效版本；正常业务最多一条）。
	var reversalUUID string
	for _, rec := range history {
		if rec.Reversed {
			continue
		}
		oldPosts, err := loadAllPostingsOn(tx, rec.ID)
		if err != nil {
			return BalanceCalibrationResult{}, err
		}
		src := ReversalSource{
			ID:                   rec.ID,
			UUID:                 rec.UUID,
			Date:                 rec.TransactionDate,
			Postings:             oldPosts,
			Description:          "冲正: " + in.Description,
			Precision:            maxPrecision,
			PrecisionByCommodity: precisionByCommodity,
		}
		revUUID, _, err := insertReversalTxnTx(tx, ledgerID, src)
		if err != nil {
			return BalanceCalibrationResult{}, err
		}
		if err := markReversedTx(tx, ReversalMarkInput{
			LedgerID:        ledgerID,
			SourceID:        rec.ID,
			ReversalUUID:    revUUID,
			ExecErrorLabel:  "标记旧余额校准已冲正",
			ConflictMessage: "余额校准已被并发修改，请重试",
			AppendSyncLog:   true,
		}); err != nil {
			return BalanceCalibrationResult{}, err
		}
		reversalUUID = revUUID
		break
	}

	// ③ 截至 D 日初累计（date < D，含旧校准与其冲正，净效果为自然累计）。
	balances, err := computeBalancesOn(tx, ledgerID, in.AsOfDate)
	if err != nil {
		return BalanceCalibrationResult{}, err
	}
	cumulative := balances[in.AccountID]
	if cumulative == nil {
		cumulative = map[string]*big.Rat{}
	}

	// ④ 差额写入：按币种分别处理，big.Rat 定点运算，禁浮点。
	posts := make([]OpeningPosting, 0, len(in.Targets)*2)
	entries := make([]BalanceEntry, 0, len(in.Targets))
	var position int64 = 0
	for _, target := range in.Targets {
		prec := target.Precision
		if prec <= 0 {
			prec = 2
		}
		targetRat, err := parseDecimalRat(target.TargetBalance)
		if err != nil {
			return BalanceCalibrationResult{}, fmt.Errorf("目标余额非法 %q: %w", target.TargetBalance, err)
		}
		current := cumulative[target.Commodity]
		if current == nil {
			current = new(big.Rat)
		}
		diff := new(big.Rat).Sub(targetRat, current)
		diffStr := diff.FloatString(prec)
		equityStr := new(big.Rat).Neg(diff).FloatString(prec)
		posts = append(posts,
			OpeningPosting{AccountID: in.AccountID, Commodity: target.Commodity, Amount: diffStr, Position: position},
			OpeningPosting{AccountID: equityID, Commodity: target.Commodity, Amount: equityStr, Position: position + 1},
		)
		entries = append(entries, BalanceEntry{Commodity: target.Commodity, Diff: diffStr})
		position += 2
	}

	// ⑤ 新校准交易（独立列承载身份，不写 opening_account_uuid / tags）。
	version, err := nextBalanceVersionOn(tx, ledgerID, in.AccountUUID)
	if err != nil {
		return BalanceCalibrationResult{}, err
	}
	key := fmt.Sprintf("%s%d", balanceKeyPrefix(in.AccountUUID), version)
	newUUID := uuid.NewString()
	newID, err := insertTxnTx(tx, ledgerID, txnInsert{
		UUID:        newUUID,
		Date:        in.PostingDate,
		Description: in.Description,
		BalanceDate: in.AsOfDate,
		BalanceKey:  key,
	})
	if err != nil {
		return BalanceCalibrationResult{}, err
	}
	if err := insertPostingsTx(tx, newID, posts); err != nil {
		return BalanceCalibrationResult{}, err
	}
	// 写入操作人（created_by），供版本历史展示（AC-3.6）；与业务行同事务。
	if in.UserID > 0 {
		if _, err := tx.Exec(`UPDATE transactions SET created_by=? WHERE id=?`, in.UserID, newID); err != nil {
			return BalanceCalibrationResult{}, err
		}
	}
	if _, err := appendSyncLogOn(tx, ledgerID, domain.EntityTransaction, newUUID, domain.OpCreate); err != nil {
		return BalanceCalibrationResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return BalanceCalibrationResult{}, err
	}

	status := "created"
	if reversalUUID != "" {
		status = "updated"
	}
	return BalanceCalibrationResult{
		Status:          status,
		TransactionUUID: newUUID,
		ReversalUUID:    reversalUUID,
		Version:         version,
		Date:            in.PostingDate,
		Entries:         entries,
	}, nil
}
