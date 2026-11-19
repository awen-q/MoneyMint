package repository

import (
	"strings"

	"familyledger/internal/domain"
)

// TransactionCursor 是 keyset 分页的位置标记：上一页最后一行的 (date, id)。
//
// 用「上一行的值」而非 offset 定位。账本 append-only、可补记任意日期、有软删：
//
//   - 翻页途中补记更晚日期 → offset 整段前移，第二页会重复返回第一页的行；
//   - 翻页途中软删一笔 → offset 整段后移，第二页会漏掉一行。
//
// keyset 谓词 `(t.date, t.id) < (?, ?)`（降序翻页）对这两种插入/删除都免疫。
type TransactionCursor struct {
	Date string // 'YYYY-MM-DD'
	ID   int64  // transactions.id（INTEGER PRIMARY KEY，即 rowid）
}

// TransactionQuery 是交易列表的查询条件。**零值 = 不筛选 + 全量**。
//
// 与 ListTransactions(ledgerID) / ListDeletedTransactions(ledgerID) 的关系：
// 两者签名保持不变（回收站等既有调用零改动），本结构体只服务新的
// 「服务端筛选 + keyset 分页」路径。
type TransactionQuery struct {
	LedgerID int64

	// From / To 是闭区间日期边界（'YYYY-MM-DD' 字典序比较），空串表示该侧不限。
	From string
	To   string

	// Kind 取 domain.KindExpense / KindIncome / KindTransfer，空串表示不筛。
	// 口径必须与前端 filters.ts 的 applyFilters 逐字对齐（见 transactionFilterWhere）。
	Kind string

	// AccountID / CategoryID 命中「该账户出现在任一分录」；0 表示不筛。
	// 两者的后端实现相同，语义差异（资金账户 / 分类账户）由前端口径承担。
	AccountID  int64
	CategoryID int64

	// Member 是会员显示名（users.display_name）的子串，大小写不敏感；空串表示不筛。
	Member string

	// Tags 命中 transactions.tags 的任一元素即算（多个标签之间是 OR）；
	// 空切片表示不筛。
	Tags []string

	// Currency 命中「存在该 commodity 的分录」，空串表示不筛。
	Currency string

	// Keyword 是五路关键词（备注 / 会员名 / 标签 / 账户全名 / 账户展示名），
	// 空串或纯空白表示不筛（**不是**「匹配空」）。
	Keyword string

	// Limit 是单页上限；0 表示不限（全量，保持既有 8 处全量调用的行为）。
	Limit int

	// Cursor 非 nil 时只返回严格位于该位置之后（降序：更早）的行。
	Cursor *TransactionCursor
}

// postingTypeExistsSQL 是「存在一条指定账户类型的分录」子查询片段（1 个占位符）。
//
// kind=expense / kind=income 的口径是**分录命中**（不是整笔二分）：
// 一笔「退款 / 报销」交易可同时命中支出与收入筛选。
const postingTypeExistsSQL = `EXISTS (` +
	`SELECT 1 FROM postings p JOIN accounts a ON a.id = p.account_id` +
	` WHERE p.transaction_id = t.id AND a.type = ?)`

// postingAccountExistsSQL 是「该账户出现在任一分录」子查询片段（1 个占位符）。
const postingAccountExistsSQL = `EXISTS (` +
	`SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND p.account_id = ?)`

// postingCurrencyExistsSQL 是「存在该 commodity 的分录」子查询片段（1 个占位符）。
const postingCurrencyExistsSQL = `EXISTS (` +
	`SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND p.commodity = ?)`

// keywordWhereSQL 是关键词五路匹配的 WHERE 片段：6 个占位符，全部绑定同一模式串。
//
// 命中任一即算：transactions.description / users.display_name / tags 任一元素 /
// 分录账户的 name（Beancount 全名）/ 分录账户的 display_name（展示名）。
//
// tags 走 json_each 逐元素比较（而不是对整列做 LIKE）：整列 LIKE 会把
// 「标签 food」误命中成「标签 seafood」，也会被 JSON 转义字符干扰。
// json_valid 用 CASE 守卫：CASE 保证条件求值顺序，脏行（历史非法 JSON）
// 只会被判为「不命中」，不会让整条查询报 malformed JSON。
const keywordWhereSQL = `(lower(t.description) LIKE ? ESCAPE '\'` +
	` OR lower(COALESCE(u.display_name, '')) LIKE ? ESCAPE '\'` +
	` OR (CASE WHEN json_valid(t.tags) THEN EXISTS (` +
	`SELECT 1 FROM json_each(t.tags) WHERE lower(json_each.value) LIKE ? ESCAPE '\')` +
	` ELSE 0 END)` +
	` OR EXISTS (SELECT 1 FROM postings p JOIN accounts a ON a.id = p.account_id` +
	`   WHERE p.transaction_id = t.id` +
	`     AND (lower(a.name) LIKE ? ESCAPE '\'` +
	`          OR lower(COALESCE(a.display_name, '')) LIKE ? ESCAPE '\'` +
	`          OR lower(COALESCE(NULLIF(a.display_name, ''), a.name)) LIKE ? ESCAPE '\')))`

// txnListColumns 是交易列表/单条读取共用的列清单（顺序即 Scan 顺序）。
const txnListColumns = `t.id, t.uuid, t.date, t.flag, t.description, t.tags,
		COALESCE(t.created_by, 0), COALESCE(u.display_name, '') AS created_by_name, t.deleted_at,
		COALESCE(t.reversal_of, ''), COALESCE(t.opening_account_uuid, ''),
		COALESCE(t.opening_version, 0), COALESCE(t.opening_key, ''),
		COALESCE(t.reversed_by, '')`

// ListTransactionsFiltered 列出满足筛选条件的未删除交易（含分录）。
//
// 返回 hasMore 表示「还有下一页」：内部按 limit+1 取行，多取的一条用于判定，
// 返回前已截掉（因此 len(txns) <= q.Limit）。Limit=0 时不限行数，hasMore=false。
//
// 所有筛选（时间窗 / kind / 账户 / 会员 / 标签 / 币种 / 关键词）与游标谓词
// 全部下推到 SQL —— 不允许「先全量捞出来再在 Go 里过滤」，那等于没做分页。
func (s *Store) ListTransactionsFiltered(q TransactionQuery) ([]domain.Transaction, bool, error) {
	where, args := transactionFilterWhere(q)

	// 游标谓词单独追加：它不属于「筛选条件」，COUNT(*) 不能带它（total 是
	// 满足筛选条件的总笔数，与翻到第几页无关）。
	if q.Cursor != nil {
		where += ` AND (t.date < ? OR (t.date = ? AND t.id < ?))`
		args = append(args, q.Cursor.Date, q.Cursor.Date, q.Cursor.ID)
	}

	sqlText := `SELECT ` + txnListColumns + `
		 FROM transactions t
		 LEFT JOIN users u ON t.created_by = u.id
		 WHERE ` + where + `
		 ORDER BY t.date DESC, t.id DESC`
	// 分页时多取一条判 has_more；LIMIT 参数走占位符，不拼进字符串。
	if q.Limit > 0 {
		sqlText += ` LIMIT ?`
		args = append(args, q.Limit+1)
	}

	rows, err := s.db.Query(sqlText, args...)
	if err != nil {
		return nil, false, err
	}
	txns := []domain.Transaction{}
	for rows.Next() {
		t, err := scanTransactionRow(rows)
		if err != nil {
			rows.Close()
			return nil, false, err
		}
		txns = append(txns, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, false, err
	}

	hasMore := false
	if q.Limit > 0 && len(txns) > q.Limit {
		txns = txns[:q.Limit]
		hasMore = true
	}
	if err := s.attachPostings(txns); err != nil {
		return nil, false, err
	}
	return txns, hasMore, nil
}

// CountTransactionsFiltered 统计满足筛选条件的未删除交易笔数。
//
// 与 ListTransactionsFiltered 共用 transactionFilterWhere，保证列表与 total
// 的口径永远一致（两处各写一遍 WHERE 必然漂移）。
func (s *Store) CountTransactionsFiltered(q TransactionQuery) (int, error) {
	where, args := transactionFilterWhere(q)
	var n int
	err := s.db.QueryRow(
		`SELECT count(*) FROM transactions t
		 LEFT JOIN users u ON t.created_by = u.id
		 WHERE `+where, args...,
	).Scan(&n)
	return n, err
}

// PostingAmount 是一条分录的原始金额，供上层做「分币种收支汇总」。
//
// **amount 是 CAST(... AS TEXT) 的原样十进制串，不是 SUM 结果。** amount 列是
// NUMERIC 亲和性，十进制字符串落库会变成 REAL；SQL 侧 SUM() 得到的是浮点数
// （0.1 + 0.2 = 0.30000000000000004），误差会直接进用户的钱。所以本方法只负责
// 取行，累加一律由上层用 big.Rat 精确完成。
type PostingAmount struct {
	Date        string // 交易日期（汇总按「日期 × 币种」分桶归零）
	Commodity   string // 分录币种
	AccountType string // 账户类型（Expenses / Income 参与收支累计，其余只登记币种）
	Amount      string // CAST(p.amount AS TEXT)，原样十进制串
}

// PostingAmountsFiltered 取出满足筛选条件的交易的全部原始分录金额（不求和）。
//
// 与列表 / COUNT 共用 transactionFilterWhere：汇总口径与列表口径必须同源，
// 「列表 3 条、汇总全账本」是这类功能最典型的 bug 形态。
//
// 返回**全部**分录（不只 Expenses/Income）：转账、期初等交易虽然不贡献收支金额，
// 但它们使用的币种仍要出现在汇总的币种列表里（与前端 summaryByCommodity 一致：
// 只有转账的币种会以 expense/income 全 0 的行出现）。
func (s *Store) PostingAmountsFiltered(q TransactionQuery) ([]PostingAmount, error) {
	where, args := transactionFilterWhere(q)
	rows, err := s.db.Query(
		`SELECT t.date, p.commodity, a.type, CAST(p.amount AS TEXT)
		 FROM transactions t
		 JOIN postings p ON p.transaction_id = t.id
		 JOIN accounts a ON a.id = p.account_id
		 LEFT JOIN users u ON t.created_by = u.id
		 WHERE `+where+`
		 ORDER BY t.date, p.commodity`,
		args...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []PostingAmount{}
	for rows.Next() {
		var p PostingAmount
		if err := rows.Scan(&p.Date, &p.Commodity, &p.AccountType, &p.Amount); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// transactionFilterWhere 是交易筛选 WHERE 片段的**唯一**生成器。
//
// 列表（ListTransactionsFiltered）与计数（CountTransactionsFiltered）都调用它，
// 因此 total 与列表口径不可能漂移。片段只含 `?` 占位符，**绝不拼接用户输入**。
func transactionFilterWhere(q TransactionQuery) (string, []any) {
	conds := []string{"t.ledger_id = ?", "t.deleted_at IS NULL"}
	args := []any{q.LedgerID}

	if q.From != "" {
		conds = append(conds, "t.date >= ?")
		args = append(args, q.From)
	}
	if q.To != "" {
		conds = append(conds, "t.date <= ?")
		args = append(args, q.To)
	}

	// kind 三支与前端 filters.ts 的 applyFilters 逐字对齐。
	switch q.Kind {
	case domain.KindExpense:
		// 分录命中：存在一条 type='Expenses' 分录。不是整笔二分。
		conds = append(conds, postingTypeExistsSQL)
		args = append(args, domain.TypeExpenses)
	case domain.KindIncome:
		// 分录命中：存在一条 type='Income' 分录。
		conds = append(conds, postingTypeExistsSQL)
		args = append(args, domain.TypeIncome)
	case domain.KindTransfer:
		// 整笔判定：不含 Equity / Expenses / Income 任何分录，且至少一条分录。
		// 期初交易（含 Equity 分录）不属于 transfer。
		conds = append(conds,
			`EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id)`,
			`NOT EXISTS (SELECT 1 FROM postings p JOIN accounts a ON a.id = p.account_id`+
				` WHERE p.transaction_id = t.id AND a.type IN (?, ?, ?))`)
		args = append(args, domain.TypeEquity, domain.TypeExpenses, domain.TypeIncome)
	}

	if q.AccountID > 0 {
		conds = append(conds, postingAccountExistsSQL)
		args = append(args, q.AccountID)
	}
	if q.CategoryID > 0 {
		conds = append(conds, postingAccountExistsSQL)
		args = append(args, q.CategoryID)
	}

	if q.Member != "" {
		conds = append(conds, `lower(COALESCE(u.display_name, '')) LIKE ? ESCAPE '\'`)
		args = append(args, likeContainsFold(q.Member))
	}

	if len(q.Tags) > 0 {
		placeholders := make([]string, len(q.Tags))
		for i, tag := range q.Tags {
			placeholders[i] = "?"
			args = append(args, tag)
		}
		// 命中任一标签即算；json_valid 用 CASE 守卫（理由见 keywordWhereSQL）。
		conds = append(conds, `(CASE WHEN json_valid(t.tags) THEN EXISTS (`+
			`SELECT 1 FROM json_each(t.tags) WHERE json_each.value IN (`+
			strings.Join(placeholders, ",")+`)) ELSE 0 END)`)
	}

	if q.Currency != "" {
		conds = append(conds, postingCurrencyExistsSQL)
		args = append(args, q.Currency)
	}

	if keyword := strings.TrimSpace(q.Keyword); keyword != "" {
		pattern := likeContainsFold(keyword)
		conds = append(conds, keywordWhereSQL)
		// keywordWhereSQL 内含 6 个占位符，绑定同一模式串。
		for i := 0; i < 6; i++ {
			args = append(args, pattern)
		}
	}

	return strings.Join(conds, " AND "), args
}

// likeContainsFold 把用户输入转成「大小写不敏感的子串匹配」LIKE 模式。
//
// 先 TrimSpace（与前端 normalize 的 trim 一致：纯空白等于不筛），再 toLower，
// 最后转义 LIKE 通配符 —— 否则 `q=%` 会匹配所有行。
func likeContainsFold(s string) string {
	return "%" + escapeLikePattern(strings.ToLower(strings.TrimSpace(s))) + "%"
}

// escapeLikePattern 转义 LIKE 模式中的通配符（配合 SQL 的 ESCAPE '\'）。
func escapeLikePattern(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 8)
	for _, r := range s {
		switch r {
		case '\\', '%', '_':
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}
