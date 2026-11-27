package service

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"familyledger/internal/domain"
	"familyledger/internal/repository"

	"github.com/google/uuid"
)

// PostingView 是交易列表项中分录的返回视图。
type PostingView struct {
	AccountID int64  `json:"account_id"`
	Account   string `json:"account"`
	Commodity string `json:"commodity"`
	Amount    string `json:"amount"`
}

// TransactionView 是交易列表项的返回视图。
//
// 0.6.0 S5/S6 additive：reversed_by / reversal_of / can_edit 为冲正与编辑所需，
// 仅在线列表透出（禁止进 sync/pull loadEntity，AC-5.2）；omitempty 缺省即省略。
// tags 同属列表透出字段：前端标签筛选与交易详情的原生语法片段依赖它；
// 无标签交易按 omitempty 省略，前端 `tags?` 保持 optional。
type TransactionView struct {
	ID            int64         `json:"id"`
	UUID          string        `json:"uuid"` // 批 2：列表透出 uuid（前端软删依赖）
	Date          string        `json:"date"`
	Flag          string        `json:"flag"`
	Description   string        `json:"description"`
	Tags          []string      `json:"tags,omitempty"`
	CreatedByName string        `json:"created_by_name"` // 记账人显示名；无创建者时为空串
	// CreatedAt 是记录写入时间（UTC，`YYYY-MM-DD HH:MM:SS`），详情页「修改记录」
	// 行用它显示冲正是哪天发生的。前端负责转本地时区（core/batch3.ts）。
	// omitempty：老调用方（不含该列的自定义查询）不会凭空多一个空串字段。
	CreatedAt     string        `json:"created_at,omitempty"`
	Postings      []PostingView `json:"postings"`
	ReversedBy    string        `json:"reversed_by,omitempty"` // 非空 = 已被冲正（失效原交易）
	ReversalOf    string        `json:"reversal_of,omitempty"` // 非空 = 本身是冲正交易
	CanEdit       bool          `json:"can_edit,omitempty"`    // 服务端按请求用户计算的编辑许可（AC-5.2）
}

// TransactionCreated 是创建交易的返回。
//
// Idempotent=true 表示本次请求命中了既有幂等键、没有新增交易：
// handler 据此返回 200（新建为 201），uuid/id 与首次成功时一致，
// 客户端可安全重放（AC-23）。为兼容旧前端，该字段作为附加字段输出。
type TransactionCreated struct {
	ID         int64  `json:"id"`
	UUID       string `json:"uuid"`
	Date       string `json:"date"`
	Postings   int    `json:"postings"`
	Idempotent bool   `json:"idempotent"`
}

// ListTransactions 列出账本内所有未删除交易（含分录，内联账户名）。
//
// userID 用于服务端按请求用户计算 can_edit（AC-5.2）：已冲正 / 期初 / 校准 /
// 冲正交易一律不可编辑；owner 可改全账本，editor 仅可改自己记的账。
//
// 不带任何筛选与分页（等价于 GET /api/transactions 不带 query），
// 筛选 / 分页走 ListTransactionsPage。
func (s *Service) ListTransactions(ledgerID, userID int64) ([]TransactionView, error) {
	role, _ := s.repo.RoleOf(ledgerID, userID) // 非成员为空串 → can_edit 全 false
	txns, err := s.repo.ListTransactions(ledgerID)
	if err != nil {
		return nil, err
	}
	out := make([]TransactionView, 0, len(txns))
	for _, t := range txns {
		out = append(out, txnListView(t, role, userID))
	}
	return out, nil
}

// txnListView 把一笔交易的领域模型转换为列表视图（含 can_edit）。
// 全量列表与筛选分页列表共用，保证两条路径的字段口径一致。
func txnListView(t domain.Transaction, role string, userID int64) TransactionView {
	v := TransactionView{
		ID:            t.ID,
		UUID:          t.UUID,
		Date:          t.Date,
		Flag:          t.Flag,
		Description:   t.Description,
		Tags:          t.Tags,
		CreatedByName: t.CreatedByName,
		CreatedAt:     t.CreatedAt,
		Postings:      make([]PostingView, 0, len(t.Postings)),
		ReversedBy:    t.ReversedBy,
		ReversalOf:    t.ReversalOf,
		CanEdit:       computeCanEdit(t, role, userID),
	}
	for _, p := range t.Postings {
		v.Postings = append(v.Postings, PostingView{
			AccountID: p.AccountID,
			Account:   p.AccountName,
			Commodity: p.Commodity,
			Amount:    p.Amount,
		})
	}
	return v
}

// ---------------------------------------------------------------------------
// 交易列表的服务端筛选 + keyset 分页（GET /api/transactions?from=&to=&kind=...）
// ---------------------------------------------------------------------------

// maxTransactionPageLimit 是单页上限（契约 0..200）。超过按 200 处理。
const maxTransactionPageLimit = 200

// dateOnlyRE 是日期参数的合法形状（与前端 filters.ts 的 DATE_RE 一致）。
// 只校验形状，不做日历有效性校验：日期在库里是 'YYYY-MM-DD' 文本，
// 边界比较是字典序，「2026-13-45」这样的形状合法值仍能得到确定结果。
var dateOnlyRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// TransactionListQuery 是 GET /api/transactions 的查询条件，**全部可选**，
// 零值表示「不筛选 + 全量」。字段与 URL query 参数同名（tag 可重复）。
type TransactionListQuery struct {
	From       string   // YYYY-MM-DD，含端点；非法格式忽略该参数
	To         string   // YYYY-MM-DD，含端点；非法格式忽略该参数
	Kind       string   // expense / income / transfer；其它值忽略
	AccountID  int64    // 整数账户 id；0/非法忽略
	CategoryID int64    // 整数账户 id（与 account 同为 postings.account_id 命中）
	Member     string   // 会员显示名子串（大小写不敏感）
	Tags       []string // 可重复；命中任一 tags 元素即算
	Currency   string   // 命中「存在该 commodity 的分录」
	Keyword    string   // q：五路关键词；空串或纯空白视为无筛选
	Limit      int      // 0..200；缺省或 0 = 全量
	Cursor     string   // 不透明串，base64url("date|id")

	// WithSummary 由 ?with=summary 置位：追加「分币种收支汇总」。
	//
	// 必须是**可选**的能力：服务端分页之后，前端对「当前已加载的 20 条」做汇总
	// 是错的（那是 20 条的和，不是全库的和），所以汇总必须由服务端在 SQL 侧
	// 用同一套 WHERE 算出来。不带该参数时响应体一个键都不能多。
	WithSummary bool
}

// TransactionListResult 是交易列表的服务端筛选 / 分页结果。
//
// Paged 表示请求是否显式给了 limit（>0）。**为 false 时 handler 只能输出
// {"transactions": [...]} 这一个键**——现网有 8 处调用走全量，任何一个
// 多出来的键或默认截断都会改变它们的行为。
type TransactionListResult struct {
	Transactions []TransactionView
	Total        int    // 满足筛选条件的总笔数（不含游标影响）；仅 Paged / Summary 时有效
	HasMore      bool   // 是否还有下一页
	NextCursor   string // 下一页游标；无下一页时为空串
	Paged        bool   // 请求是否显式分页

	// Summary 仅在请求带 with=summary 时非 nil（否则 handler 不输出 summary 键）。
	Summary *TransactionSummary
}

// CommoditySummaryView 是某币种的收支汇总。
//
// 金额是**固定两位定点串**（与前端 core/Money 的 toString() 逐字对齐：
// `toFixed(2)`，不跟账本币种 precision 走）。**不提供跨币种合计金额** ——
// 跨币种求和永远是错的，笔数放在 TransactionSummary.Total。
type CommoditySummaryView struct {
	Commodity string `json:"commodity"`
	Income    string `json:"income"`  // Σ(−Income 分录)，正数
	Expense   string `json:"expense"` // Σ(Expenses 分录)，正数
}

// TransactionSummary 是交易列表的分币种收支汇总（?with=summary）。
type TransactionSummary struct {
	Total       int                    `json:"total"` // 满足筛选条件的交易笔数（不是金额）
	ByCommodity []CommoditySummaryView `json:"by_commodity"`
}

// summaryDecimals 是汇总金额的小数位数。
//
// 固定 2 位而不是读账本币种 precision：前端 summaryByCommodity 的金额出口是
// Money.toString() → `toFixed(2)`，拿 precision 会与前端出现位数差异。
const summaryDecimals = 2

// ListTransactionsPage 按筛选条件列出交易，可选 keyset 分页与分币种汇总。
//
// 所有筛选与游标谓词都下推到 SQL（repository.transactionFilterWhere 单点生成
// WHERE 片段，列表 / COUNT / 汇总共用）：
//   - Limit=0 → 全量，不查 total（Paged=false，响应形状与旧版完全一致）；
//   - Limit>0 → LIMIT limit+1 判 has_more，并单独 COUNT 出 total；
//   - WithSummary → 追加 summary（total 复用同一次 COUNT，金额在 Go 用 big.Rat 累加）。
//
// 游标非法（非 base64 / 缺分隔符 / 非数字）→ 400（domain.ErrInvalid），
// **不静默当第一页**：静默会让用户以为已经翻到头。
func (s *Service) ListTransactionsPage(
	ledgerID, userID int64, in TransactionListQuery,
) (TransactionListResult, error) {
	q, err := buildTransactionQuery(ledgerID, in)
	if err != nil {
		return TransactionListResult{}, err
	}

	role, _ := s.repo.RoleOf(ledgerID, userID)
	txns, hasMore, err := s.repo.ListTransactionsFiltered(q)
	if err != nil {
		return TransactionListResult{}, err
	}

	res := TransactionListResult{
		Transactions: make([]TransactionView, 0, len(txns)),
		HasMore:      hasMore,
		Paged:        q.Limit > 0,
	}
	for _, t := range txns {
		res.Transactions = append(res.Transactions, txnListView(t, role, userID))
	}

	// total 与 summary.total 是同一个数（满足筛选条件的笔数）：只查一次 COUNT。
	if res.Paged || in.WithSummary {
		res.Total, err = s.repo.CountTransactionsFiltered(q)
		if err != nil {
			return TransactionListResult{}, err
		}
	}

	if in.WithSummary {
		byCommodity, err := s.summarizeByCommodity(q)
		if err != nil {
			return TransactionListResult{}, err
		}
		res.Summary = &TransactionSummary{Total: res.Total, ByCommodity: byCommodity}
	}

	if res.Paged && hasMore && len(txns) > 0 {
		last := txns[len(txns)-1]
		res.NextCursor = encodeTransactionCursor(last.Date, last.ID)
	}
	return res, nil
}

// summarizeByCommodity 计算「分币种收支汇总」，口径逐字对齐前端
// frontend/src/core/search.ts 的 summaryByCommodity：
//
//  1. **符号口径**（Beancount 借方为正）：expense = Σ(Expenses 分录)，
//     income = Σ(−Income 分录)，两者对外都为正数；**不取 abs** —— 符号错了要暴露，
//     不能被静默抹平。
//  2. **归零粒度是「日期 × 币种」的桶**：先按 (date, commodity) 分桶累加，
//     **逐桶**把负数净额归零，最后再按币种合并已归零的桶。若改成「按币种一次性
//     累加后归零」，同一个月里「day1 支出 100、day2 纯退款 50」会得到 50，
//     而账单页月合计是 100 —— 同一账本两个数字。
//  3. **不跨币种求和**：输出按币种分行，币种按字典序排序，不提供合计金额。
//     币种集合来自**全部分录**（转账 / 期初只登记币种、不贡献金额）。
//  4. 金额累加用 big.Rat（禁用 SQL SUM）：amount 以 CAST(... AS TEXT) 取原样
//     十进制串，避免 REAL 累加把 0.1 + 0.2 变成 0.30000000000000004。
//  5. **汇总永远是「筛选条件的全集」，与 cursor 无关**（传入的 q 不含游标谓词）。
//     如果让汇总跟着游标走，用户翻到第二页会看到金额变小，进而以为「钱变少了」——
//     这是比不显示更糟的误导。翻页只影响 transactions，不影响 total / summary。
func (s *Service) summarizeByCommodity(q repository.TransactionQuery) ([]CommoditySummaryView, error) {
	postings, err := s.repo.PostingAmountsFiltered(q)
	if err != nil {
		return nil, err
	}

	// totals 以「出现过的币种」为键：只要某币种在命中交易里有一条分录，
	// 它就出现在汇总里（金额可能全 0），与前端 counts 的口径一致。
	totals := make(map[string]*summaryBucket, len(postings))
	// buckets 以「日期 × 币种」为键，用于逐桶归零。
	buckets := make(map[summaryBucketKey]*summaryBucket, len(postings))

	for _, p := range postings {
		if _, ok := totals[p.Commodity]; !ok {
			totals[p.Commodity] = newSummaryBucket()
		}
		if p.AccountType != domain.TypeExpenses && p.AccountType != domain.TypeIncome {
			continue // 资金 / 权益分录只登记币种，不计入收支
		}
		amount := parseSummaryAmount(p.Amount)
		key := summaryBucketKey{date: p.Date, commodity: p.Commodity}
		bucket := buckets[key]
		if bucket == nil {
			bucket = newSummaryBucket()
			buckets[key] = bucket
		}
		if p.AccountType == domain.TypeExpenses {
			bucket.expense.Add(bucket.expense, amount)
		} else {
			// Income 分录在 Beancount 口径下为负，取反后收入对外恒为正。
			bucket.income.Sub(bucket.income, amount)
		}
	}

	// 逐桶归零后再按币种合并（归零粒度见 doc 第 2 条）。
	for key, bucket := range buckets {
		total := totals[key.commodity]
		total.expense.Add(total.expense, nonNegativeRat(bucket.expense))
		total.income.Add(total.income, nonNegativeRat(bucket.income))
	}

	commodities := make([]string, 0, len(totals))
	for commodity := range totals {
		commodities = append(commodities, commodity)
	}
	sort.Strings(commodities) // 字典序（币种代码是 ASCII，顺序确定）

	out := make([]CommoditySummaryView, 0, len(commodities))
	for _, commodity := range commodities {
		total := totals[commodity]
		out = append(out, CommoditySummaryView{
			Commodity: commodity,
			Income:    total.income.FloatString(summaryDecimals),
			Expense:   total.expense.FloatString(summaryDecimals),
		})
	}
	return out, nil
}

// summaryBucketKey 是「日期 × 币种」的归零桶键。
type summaryBucketKey struct {
	date      string
	commodity string
}

// summaryBucket 是某一维度的收支累计器（big.Rat 精确累加）。
type summaryBucket struct {
	expense *big.Rat
	income  *big.Rat
}

// newSummaryBucket 构造一个归零的累计器。
func newSummaryBucket() *summaryBucket {
	return &summaryBucket{expense: new(big.Rat), income: new(big.Rat)}
}

// nonNegativeRat 把负数净额归零（与前端 positiveOf 一致：对外不展示负的收支）。
// 返回新对象，避免共享状态。
func nonNegativeRat(r *big.Rat) *big.Rat {
	if r.Sign() < 0 {
		return new(big.Rat)
	}
	return new(big.Rat).Set(r)
}

// parseSummaryAmount 把分录金额解析为精确有理数；非法金额按 0 处理
// （与前端 moneyOf 一致：一条脏数据不该让整页汇总失败）。
func parseSummaryAmount(raw string) *big.Rat {
	r, ok := new(big.Rat).SetString(strings.TrimSpace(raw))
	if !ok {
		return new(big.Rat)
	}
	return r
}

// buildTransactionQuery 把 HTTP 层的原始查询条件规范化为仓储查询条件。
//
// 容错口径（与前端 filters.ts 的 parse 行为一致）：
//   - from / to 形状非法 → 忽略该参数（不报错）；合法则去空白后使用；
//   - kind 不在三支白名单内 → 忽略（含 'all'）；
//   - account / category <= 0 → 不筛；
//   - tag 去空白、丢弃空串；
//   - cursor 非空则必须可解析，否则返回 ErrInvalid（→ 400）。
func buildTransactionQuery(ledgerID int64, in TransactionListQuery) (repository.TransactionQuery, error) {
	q := repository.TransactionQuery{LedgerID: ledgerID}

	if from := strings.TrimSpace(in.From); dateOnlyRE.MatchString(from) {
		q.From = from
	}
	if to := strings.TrimSpace(in.To); dateOnlyRE.MatchString(to) {
		q.To = to
	}
	switch kind := strings.TrimSpace(in.Kind); kind {
	case domain.KindExpense, domain.KindIncome, domain.KindTransfer:
		q.Kind = kind
	}
	if in.AccountID > 0 {
		q.AccountID = in.AccountID
	}
	if in.CategoryID > 0 {
		q.CategoryID = in.CategoryID
	}
	q.Member = strings.TrimSpace(in.Member)
	for _, tag := range in.Tags {
		if tag = strings.TrimSpace(tag); tag != "" {
			q.Tags = append(q.Tags, tag)
		}
	}
	q.Currency = strings.TrimSpace(in.Currency)
	if keyword := strings.TrimSpace(in.Keyword); keyword != "" {
		q.Keyword = keyword
	}
	q.Limit = clampTransactionLimit(in.Limit)
	if cursor := strings.TrimSpace(in.Cursor); cursor != "" {
		decoded, err := decodeTransactionCursor(cursor)
		if err != nil {
			return repository.TransactionQuery{}, err
		}
		q.Cursor = &decoded
	}
	return q, nil
}

// clampTransactionLimit 把 limit 规范到 0..maxTransactionPageLimit。
// <=0 表示全量（缺省即全量，不允许「默认 20」）；超过上限按上限截断。
func clampTransactionLimit(limit int) int {
	if limit <= 0 {
		return 0
	}
	if limit > maxTransactionPageLimit {
		return maxTransactionPageLimit
	}
	return limit
}

// encodeTransactionCursor 生成不透明游标：base64url("date|id")，无填充。
func encodeTransactionCursor(date string, id int64) string {
	raw := date + "|" + strconv.FormatInt(id, 10)
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// decodeTransactionCursor 解析游标。任何异常（非 base64 / 缺分隔符 / 日期形状
// 非法 / id 非数字）都返回 ErrInvalid，由 handler 映射 400。
func decodeTransactionCursor(encoded string) (repository.TransactionCursor, error) {
	bad := domain.Invalidf("分页游标无效，请从第一页重新加载")
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		// 兼容带 '=' 填充的 URL-safe base64（RawURLEncoding 拒绝填充）。
		padded, paddedErr := base64.URLEncoding.DecodeString(encoded)
		if paddedErr != nil {
			return repository.TransactionCursor{}, bad
		}
		payload = padded
	}
	parts := strings.Split(string(payload), "|")
	if len(parts) != 2 || !dateOnlyRE.MatchString(parts[0]) {
		return repository.TransactionCursor{}, bad
	}
	id, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || id <= 0 {
		return repository.TransactionCursor{}, bad
	}
	return repository.TransactionCursor{Date: parts[0], ID: id}, nil
}

// computeCanEdit 是 can_edit 的唯一判定口径（AC-5.2 / AC-5.3，服务端权威）：
// D-15 已冲正判定优先于角色；期初 / 校准 / 冲正交易走专用端点不可编辑；
// owner 可改全账本（created_by=0 由 owner 兜底），editor 仅可改自己记的账。
// 前端显隐不是安全边界，PATCH 由 UpdateTransaction 独立复核。
func computeCanEdit(t domain.Transaction, role string, userID int64) bool {
	if t.ReversedBy != "" {
		return false
	}
	if t.OpeningAccountUUID != "" || t.BalanceKey != "" || t.ReversalOf != "" {
		return false
	}
	if role == domain.RoleOwner {
		return true
	}
	return role == domain.RoleEditor && t.CreatedBy != 0 && t.CreatedBy == userID
}

// CreateTransaction 创建一笔不可变交易（在线，postings 用 account_id 引用）。
// 先做借贷平衡校验，再在事务内落库并补建币种。
// tags 中禁止出现 opening：期初只能走专用端点，防止绕过方向/币种/唯一性校验。
//
// 不带幂等键的旧调用路径（离线 push 走 sync 包，不经过这里）。
func (s *Service) CreateTransaction(ledgerID int64, date, flag, description string, postings []PostingInput, createdBy int64, tags ...string) (TransactionCreated, error) {
	return s.createTransaction(ledgerID, "", date, flag, description, postings, createdBy, tags)
}

// CreateTransactionIdempotent 在线创建交易，带可选客户端幂等键（G-04 / AC-23）。
//
// 幂等键来源：HTTP 层优先取 Idempotency-Key 头，其次 body 的 client_request_id；
// 空串表示调用方不要求幂等（保持旧行为）。
//
// 语义：
//   - 首次成功 → 新建（handler 返回 201）；
//   - 重复提交且未删除、内容一致 → 返回既有 uuid/id 且 Idempotent=true（200）；
//   - 命中已软删交易 → 409 idempotency_key_deleted（换新键重提）；
//   - 同键不同内容 → 409 idempotency_payload_mismatch。
func (s *Service) CreateTransactionIdempotent(
	ledgerID int64, clientRequestID, date, flag, description string,
	postings []PostingInput, createdBy int64, tags ...string,
) (TransactionCreated, error) {
	key, err := normalizeClientRequestID(clientRequestID)
	if err != nil {
		return TransactionCreated{}, err
	}
	return s.createTransaction(ledgerID, key, date, flag, description, postings, createdBy, tags)
}

// validateTxnPayload 是在线创建与修改交易共用的载荷校验（N-02：同一口径）：
// 禁 opening 标签（期初只能走专用端点）、至少 2 条分录、引用账户未关闭（AC-28
// 服务端半边）、逐币种借贷平衡（big.Rat 定点）。
func (s *Service) validateTxnPayload(ledgerID int64, postings []PostingInput, tags []string) error {
	if containsTag(tags, "opening") {
		return domain.Codedf(domain.ErrInvalid, domain.CodeOpeningViaAPIOnly,
			"期初余额请通过账户期初专用端点设置")
	}
	if len(postings) < 2 {
		return domain.Invalidf("一笔交易至少需要 2 条分录")
	}
	seenAccounts := make(map[int64]bool, len(postings))
	for _, p := range postings {
		if seenAccounts[p.AccountID] {
			continue
		}
		seenAccounts[p.AccountID] = true
		acc, err := s.repo.AccountByID(ledgerID, p.AccountID)
		if err != nil {
			return err
		}
		if acc.CloseDate != "" {
			msg := fmt.Sprintf("账户已关闭，不能记账: %s", acc.Name)
			return domain.Codedf(domain.ErrConflict, domain.CodeAccountClosed, "%s", msg)
		}
	}
	return validateBalance(postings)
}

// createTransaction 是 CreateTransaction / CreateTransactionIdempotent 的公共实现。
func (s *Service) createTransaction(
	ledgerID int64, clientRequestID, date, flag, description string,
	postings []PostingInput, createdBy int64, tags []string,
) (TransactionCreated, error) {
	if err := s.validateTxnPayload(ledgerID, postings, tags); err != nil {
		return TransactionCreated{}, err
	}
	if flag == "" {
		flag = "*"
	}
	if date == "" {
		date = time.Now().Format("2006-01-02")
	}

	txn := domain.Transaction{
		UUID:        uuid.NewString(),
		Date:        date,
		Flag:        flag,
		Description: description,
		Tags:        append([]string(nil), tags...),
		CreatedBy:   createdBy,
		Postings:    make([]domain.Posting, 0, len(postings)),
	}
	for i, p := range postings {
		txn.Postings = append(txn.Postings, domain.Posting{
			AccountID: p.AccountID,
			Commodity: p.Commodity,
			Amount:    p.Amount,
			Position:  i,
		})
	}

	payloadHash := transactionPayloadHash(date, flag, description, postings)
	res, err := s.repo.CreateTransactionIdempotent(ledgerID, txn, clientRequestID, payloadHash)
	if err != nil {
		return TransactionCreated{}, err
	}
	if res.Created {
		return TransactionCreated{
			ID: res.ID, UUID: res.UUID, Date: res.Date,
			Postings: res.Postings, Idempotent: false,
		}, nil
	}
	// 命中既有幂等键：先判软删，再判内容是否一致。
	if res.Deleted {
		return TransactionCreated{}, domain.Codedf(domain.ErrConflict, domain.CodeIdempotencyKeyDeleted,
			"该幂等键对应的交易已被删除，请生成新的幂等键后重试")
	}
	if res.Hash != "" && res.Hash != payloadHash {
		return TransactionCreated{}, domain.Codedf(domain.ErrConflict, domain.CodeIdempotencyPayloadMismatch,
			"该幂等键已用于另一笔内容不同的交易，请生成新的幂等键后重试")
	}
	return TransactionCreated{
		ID: res.ID, UUID: res.UUID, Date: res.Date,
		Postings: res.Postings, Idempotent: true,
	}, nil
}

// maxClientRequestIDLen 是幂等键的长度上限（防止把任意长文本写进索引）。
const maxClientRequestIDLen = 200

// normalizeClientRequestID 规范化并校验客户端幂等键。
// 去掉首尾空白；空串合法（表示不启用幂等）；控制字符与超长直接拒绝。
func normalizeClientRequestID(raw string) (string, error) {
	key := strings.TrimSpace(raw)
	if key == "" {
		return "", nil
	}
	if len(key) > maxClientRequestIDLen {
		return "", domain.Invalidf("client_request_id 不能超过 %d 个字符", maxClientRequestIDLen)
	}
	for _, r := range key {
		if r < 0x20 || r == 0x7f {
			return "", domain.Invalidf("client_request_id 不能包含控制字符")
		}
	}
	return key, nil
}

// transactionPayloadHash 计算规范化后的请求内容哈希，用于识别「同键不同内容」。
//
// 规范化范围：date / flag / description / 分录（账户 id、币种、金额）。
// 金额用 big.Rat 转成精确规范值再参与哈希，避免 "10.00" 与 "10.0" 被误判为不同内容；
// 该值仅用于比较，不参与存储与展示（金额仍以原始十进制字符串落库）。
func transactionPayloadHash(date, flag, description string, postings []PostingInput) string {
	var b strings.Builder
	b.WriteString("fambean-txn-v1\x00")
	b.WriteString(date)
	b.WriteByte(0)
	b.WriteString(flag)
	b.WriteByte(0)
	b.WriteString(description)
	b.WriteByte(0)
	for _, p := range postings {
		b.WriteString(strconv.FormatInt(p.AccountID, 10))
		b.WriteByte(0)
		b.WriteString(p.Commodity)
		b.WriteByte(0)
		b.WriteString(normalizeAmountForHash(p.Amount))
		b.WriteByte(0)
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:])
}

// normalizeAmountForHash 把十进制金额字符串转成精确规范形式；解析失败时退回去空白原值。
func normalizeAmountForHash(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return s
	}
	if r, ok := new(big.Rat).SetString(s); ok {
		return r.RatString()
	}
	return s
}

// TrashPostingView 是回收站分录视图：account 保留 Beancount 全名，
// account_display 是给人看的账户名（「现金」）。
type TrashPostingView struct {
	Account        string `json:"account"`
	AccountDisplay string `json:"account_display"`
	Commodity      string `json:"commodity"`
	Amount         string `json:"amount"`
}

// TrashItemView 是回收站条目视图（在普通交易视图上加删除时间）。
// 0.6.0 S6 additive：can_restore 由服务端按请求用户角色计算（viewer 恒 false，
// 仍可查看回收站），前端据此显隐恢复按钮。
//
// B7 additive（永久删除）：can_purge / is_system / pair_uuid 三者都是
// 「假值即省略」，旧响应形状不变。can_purge 不能复用 can_restore——
// can_restore 是 owner+editor，永久删除只有 owner。
type TrashItemView struct {
	UUID          string             `json:"uuid"`
	Date          string             `json:"date"`
	Flag          string             `json:"flag"`
	Description   string             `json:"description"`
	Tags          []string           `json:"tags"`
	DeletedAt     string             `json:"deleted_at"`
	CreatedByName string             `json:"created_by_name"`
	Postings      []TrashPostingView `json:"postings"`
	CanRestore    bool               `json:"can_restore,omitempty"`

	// CanPurge 表示当前用户能否永久删除这一笔（owner 且闭包判定可删；
	// 系统交易、或配对含系统交易 → false）。
	CanPurge bool `json:"can_purge,omitempty"`
	// IsSystem 表示三重系统判定命中（期初 / 校准 / 导入批次），前端用于
	// 「系统交易保留」标记——不显示删除入口，但要说明为什么没有。
	IsSystem bool `json:"is_system,omitempty"`
	// PairUUID 是冲正配对另一条的 uuid（无配对为空）。
	// 非空且该配对不在回收站时，删除会连带删掉它，确认弹层必须写清楚。
	PairUUID string `json:"pair_uuid,omitempty"`
}

// trashItemView 把一笔已软删的领域交易转换为回收站视图。
//
// ListDeletedTransactions 与 TrashOverview 共用（避免两处 Scan / 字段映射各自漂移）；
// can_purge / is_system / pair_uuid 需要闭包信息，由 TrashOverview 事后回填，
// 单条映射保持纯函数、无 I/O。
func trashItemView(t domain.Transaction, canRestore, canPurge bool) TrashItemView {
	v := TrashItemView{
		UUID:          t.UUID,
		Date:          t.Date,
		Flag:          t.Flag,
		Description:   t.Description,
		Tags:          t.Tags,
		DeletedAt:     t.DeletedAt,
		CreatedByName: t.CreatedByName,
		Postings:      make([]TrashPostingView, 0, len(t.Postings)),
		CanRestore:    canRestore,
		CanPurge:      canPurge,
	}
	for _, p := range t.Postings {
		display := p.AccountDisplay
		if display == "" {
			display = p.AccountName
		}
		v.Postings = append(v.Postings, TrashPostingView{
			Account:        p.AccountName,
			AccountDisplay: display,
			Commodity:      p.Commodity,
			Amount:         p.Amount,
		})
	}
	return v
}

// ListDeletedTransactions 列出回收站（已软删交易），按删除时间倒序。
// viewer 仍可查看回收站（GET 放行），can_restore=false 仅隐藏恢复按钮。
//
// 对外行为保持不变（B7 起 HTTP 层改走 TrashOverview 以获得 summary / audit）：
// can_purge 恒 false 且 omitempty，is_system / pair_uuid 不填，响应字节不变。
func (s *Service) ListDeletedTransactions(ledgerID, userID int64) ([]TrashItemView, error) {
	role, _ := s.repo.RoleOf(ledgerID, userID)
	canRestore := role == domain.RoleOwner || role == domain.RoleEditor
	txns, err := s.repo.ListDeletedTransactions(ledgerID)
	if err != nil {
		return nil, err
	}
	out := make([]TrashItemView, 0, len(txns))
	for _, t := range txns {
		out = append(out, trashItemView(t, canRestore, false))
	}
	return out, nil
}

// RestoreTransaction 从回收站恢复一笔交易。
//
// 恢复前校验引用账户：已关闭账户不允许再被记账引用，若交易的任一科目已关闭，
// 直接拒绝并告知是哪个账户，而不是恢复出一条账本内不可再创建的脏数据。
// userID 用于服务端角色复核（viewer 只读，AC-5.8；与 middleware 双保险）。
func (s *Service) RestoreTransaction(ledgerID, userID int64, uuid string) error {
	role, err := s.LedgerRole(userID, ledgerID)
	if err != nil {
		return err
	}
	if role == "" || role == domain.RoleViewer {
		return domain.ErrForbidden
	}
	closed, err := s.repo.ClosedAccountsOfTransaction(ledgerID, uuid)
	if err != nil {
		return err
	}
	if len(closed) > 0 {
		return domain.Invalidf("交易引用的账户「%s」已关闭，无法恢复（可先重新开启该账户或改为冲正）", strings.Join(closed, "」「"))
	}
	restored, err := s.repo.RestoreTransaction(ledgerID, uuid)
	if err != nil {
		return err
	}
	if !restored {
		return domain.ErrNotFound
	}
	return nil
}

// DeleteTransaction 软删一笔交易（userID 按 design §3.2 统一签名传入；
// 删除为账本级写操作、无 creator 限制，viewer 写拦截由 middleware 承担，
// 行为与 S6 前一致）。
func (s *Service) DeleteTransaction(ledgerID, userID int64, uuid string) error {
	_ = userID
	deleted, err := s.repo.SoftDeleteTransaction(ledgerID, uuid)
	if err != nil {
		return err
	}
	if !deleted {
		return domain.ErrNotFound
	}
	return nil
}

// ---------------------------------------------------------------------------
// 修改交易（0.6.0 S6 / T13：修改 = 冲正 + 新建，绝不原地改）
// ---------------------------------------------------------------------------

// TxnUpdateInput 是修改交易的请求载荷，按在线 create 契约镜像
// （date / flag / description / tags / postings），design 未另行定义。
// 禁止修改 uuid / created_by / ledger_id（AC-5.6）：三者由服务端掌控，
// 新交易 uuid 由服务端新生成、created_by 固定为当前请求用户。
type TxnUpdateInput struct {
	Date        string
	Flag        string
	Description string
	Tags        []string
	Postings    []PostingInput
}

// TransactionUpdated 是修改交易的响应（三 uuid，无 version 字段，AC-5.1）。
type TransactionUpdated struct {
	OriginalUUID string `json:"original_uuid"`
	ReversalUUID string `json:"reversal_uuid"`
	NewUUID      string `json:"new_uuid"`
}

// UpdateTransaction 修改一笔交易：判定（已冲正 → 不可编辑 → 权限）通过后，
// 在单一大事务内「冲正原交易 + 新建改后交易」（AC-5.1，design §4.1）。
//
// 判定顺序（D-15：已冲正判定优先于角色）：
//  1. reversed_by 非空 → 409 txn_already_reversed（响应不带 latest_uuid——无版本链）；
//  2. 期初 / 校准 / 冲正交易 → 409 txn_not_editable（走各自专用端点）；
//  3. 权限：owner 改全账本；created_by==uid 且非 viewer 可改；否则 403
//     txn_edit_forbidden（created_by=0 由 owner 兜底；服务端独立校验防绕过）。
//
// 幂等兜底（AC-5.6）：不落 edit_key / 不复用 client_request_id，重试命中的
// 请求会因原交易已处于冲正态直接 409 txn_already_reversed，绝不产生第二套冲正。
func (s *Service) UpdateTransaction(
	ledgerID, userID int64, txnUUID string, in TxnUpdateInput,
) (TransactionUpdated, error) {
	orig, err := s.repo.TransactionByUUID(ledgerID, txnUUID)
	if err != nil {
		return TransactionUpdated{}, err // ErrNotFound → 404
	}

	// 1) D-15：已冲正判定优先于角色。
	if orig.ReversedBy != "" {
		return TransactionUpdated{}, domain.Codedf(domain.ErrConflict, domain.CodeTxnAlreadyReversed,
			"该交易已被冲正，请修改最新版本")
	}
	// 2) 期初 / 校准 / 冲正交易走专用端点。
	if orig.OpeningAccountUUID != "" || orig.BalanceKey != "" || orig.ReversalOf != "" {
		return TransactionUpdated{}, domain.Codedf(domain.ErrConflict, domain.CodeTxnNotEditable,
			"期初 / 冲正 / 校准交易不能修改")
	}
	// 3) 权限（服务端独立校验，前端显隐不是安全边界，AC-5.3）。
	role, err := s.LedgerRole(userID, ledgerID)
	if err != nil {
		return TransactionUpdated{}, err
	}
	if role == "" || role == domain.RoleViewer {
		return TransactionUpdated{}, domain.Codedf(domain.ErrForbidden, domain.CodeTxnEditForbidden,
			"无权修改该交易")
	}
	if role != domain.RoleOwner && orig.CreatedBy != userID {
		return TransactionUpdated{}, domain.Codedf(domain.ErrForbidden, domain.CodeTxnEditForbidden,
			"只能修改自己记的账，或由账本 owner 修改")
	}

	// 4) 载荷校验（与在线创建同一口径，N-02）。
	if err := s.validateTxnPayload(ledgerID, in.Postings, in.Tags); err != nil {
		return TransactionUpdated{}, err
	}
	date := strings.TrimSpace(in.Date)
	if date == "" {
		date = time.Now().Format("2006-01-02")
	}
	flag := in.Flag
	if flag == "" {
		flag = "*"
	}
	postings := make([]domain.Posting, 0, len(in.Postings))
	for i, p := range in.Postings {
		postings = append(postings, domain.Posting{
			AccountID: p.AccountID,
			Commodity: p.Commodity,
			Amount:    p.Amount,
			Position:  i,
		})
	}

	res, err := s.repo.UpdateTransaction(repository.TransactionUpdateInput{
		LedgerID:     ledgerID,
		OriginalUUID: txnUUID,
		NewUUID:      uuid.NewString(),
		Date:         date,
		Flag:         flag,
		Description:  in.Description,
		Tags:         append([]string(nil), in.Tags...),
		Postings:     postings,
		CreatedBy:    userID,
	})
	if err != nil {
		return TransactionUpdated{}, err
	}
	return TransactionUpdated{
		OriginalUUID: res.OriginalUUID,
		ReversalUUID: res.ReversalUUID,
		NewUUID:      res.NewUUID,
	}, nil
}

// ---------------------------------------------------------------------------
// 标签原地更新（注解层；P0 唯一新增的交易写入通道）
// ---------------------------------------------------------------------------
//
// 与经济事实 PATCH 物理隔离：这里只改 tags 一列（+ tags_updated_at），
// uuid 不变、不生成冲正行、不打 reversed_by，因此可以反复编辑。
// 判定顺序与 UpdateTransaction 逐字同序：已冲正 → 系统交易 → 权限 → 载荷校验 → CAS → 落库。

// 标签上限（实施方案 §3.1；防止导出元数据行失控）。
const (
	maxTagsPerTxn = 32
	maxTagRunes   = 64
)

// canonicalTags 是标签数组的纯规范化：TrimSpace → 丢空 → 精确去重（大小写敏感）
// → 排序（Unicode 码点序）。不做校验，供 CAS 比较历史值使用。
func canonicalTags(tags []string) []string {
	out := make([]string, 0, len(tags))
	seen := make(map[string]bool, len(tags))
	for _, t := range tags {
		t = strings.TrimSpace(t)
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

// normalizeTags 是服务端权威的标签规范化 + 校验（前端必须对齐同一套规则）：
//  1. trim → 丢空 → 精确去重 → 排序（canonicalTags）；
//  2. 数量 ≤ 32、单个标签 ≤ 64 字符、不含控制字符（<0x20 / 0x7f）；
//  3. opening 黑名单（与在线 create 同口径，走 opening_via_api_only）。
//
// 返回规范化后的最终值，前端以响应回显为准。
func normalizeTags(tags []string) ([]string, error) {
	out := canonicalTags(tags)
	if len(out) > maxTagsPerTxn {
		return nil, domain.Codedf(domain.ErrTxnTagsInvalid, domain.CodeTxnTagsInvalid,
			"标签最多 %d 个", maxTagsPerTxn)
	}
	for _, t := range out {
		if utf8.RuneCountInString(t) > maxTagRunes {
			return nil, domain.Codedf(domain.ErrTxnTagsInvalid, domain.CodeTxnTagsInvalid,
				"单个标签不能超过 %d 个字符", maxTagRunes)
		}
		for _, r := range t {
			if r < 0x20 || r == 0x7f {
				return nil, domain.Codedf(domain.ErrTxnTagsInvalid, domain.CodeTxnTagsInvalid,
					"标签不能包含控制字符")
			}
		}
	}
	if containsTag(out, "opening") {
		return nil, domain.Codedf(domain.ErrInvalid, domain.CodeOpeningViaAPIOnly,
			"期初余额请通过账户期初专用端点设置")
	}
	return out, nil
}

// TagsUpdateInput 是 PUT /api/transactions/{uuid}/tags 的 service 输入。
// BaseTags 是客户端看到时的快照，必填且可为 []；DeviceID / ClientOpID 供审计与 P1 去重。
type TagsUpdateInput struct {
	Tags       []string
	BaseTags   []string
	DeviceID   string
	ClientOpID string
}

// TagEditResult 是原地改标签的响应（回显服务端规范化后的最终值）。
// EditID 复用 tag_edit_log.id，供前端编辑记录面板定位与 P1 去重，不是版本链。
type TagEditResult struct {
	UUID          string   `json:"uuid"`
	Tags          []string `json:"tags"`
	TagsUpdatedAt string   `json:"tags_updated_at"`
	EditID        int64    `json:"edit_id"`
}

// TagEditItem 是二级「编辑记录」面板中的一条审计。
type TagEditItem struct {
	ID        int64    `json:"id"`
	Action    string   `json:"action"`
	OldTags   []string `json:"old_tags"`
	NewTags   []string `json:"new_tags"`
	ActorID   int64    `json:"actor_id"`
	ActorName string   `json:"actor_name"`
	DeviceID  string   `json:"device_id"`
	Ts        string   `json:"ts"`
}

// tagsConflictError 构造 409 txn_tags_conflict，并把服务端当前值回给客户端，
// 使前端可以直接用 current_tags 作为新 base 重放（不必先刷新整页）。
func tagsConflictError(current []string, updatedAt string) error {
	if current == nil {
		current = []string{}
	}
	return &domain.CodedError{
		Code:     domain.CodeTxnTagsConflict,
		Message:  "标签已被他人更新，请刷新后重试",
		Sentinel: domain.ErrTxnTagsConflict,
		Details: map[string]any{
			"current_tags":           current,
			"current_tags_updated_at": updatedAt,
		},
	}
}

// UpdateTransactionTags 原地更新一笔交易的标签（uuid 不变、无冲正、可再次编辑）。
//
// 判定顺序与 UpdateTransaction 逐字同序（D-15：已冲正优先于角色）：
//  1. reversed_by 非空 → 409 txn_already_reversed；
//  2. 期初 / 校准 / 冲正交易 → 409 txn_not_editable；
//  3. 权限：owner 全账本；created_by==uid 且非 viewer 可改；否则 403 txn_edit_forbidden；
//  4. 载荷校验：normalizeTags（超量/超长/控制字符/ opening）；
//  5. CAS：canonicalTags(base_tags) == canonicalTags(current.tags)，否则 409 txn_tags_conflict；
//  6. 落库：repository.UpdateTagsTx 在同一事务内重判 CAS、UPDATE、审计、sync_log。
//
// service 层判定只是快速失败，真正的安全边界在 repository 事务内。
func (s *Service) UpdateTransactionTags(
	ledgerID, userID int64, txnUUID string, in TagsUpdateInput,
) (TagEditResult, error) {
	orig, err := s.repo.TransactionByUUID(ledgerID, txnUUID)
	if err != nil {
		return TagEditResult{}, err // ErrNotFound → 404
	}

	// 1) D-15：已冲正优先于角色判定。
	if orig.ReversedBy != "" {
		return TagEditResult{}, domain.Codedf(domain.ErrConflict, domain.CodeTxnAlreadyReversed,
			"该交易已被冲正，请修改最新版本")
	}
	// 2) 系统交易走专用端点，标签端一律拒绝。
	if orig.OpeningAccountUUID != "" || orig.BalanceKey != "" || orig.ReversalOf != "" {
		return TagEditResult{}, domain.Codedf(domain.ErrConflict, domain.CodeTxnNotEditable,
			"期初 / 冲正 / 校准交易不能修改标签")
	}
	// 3) 权限：复用与 UpdateTransaction 完全相同的口径（computeCanEdit 的写侧版本）。
	role, err := s.LedgerRole(userID, ledgerID)
	if err != nil {
		return TagEditResult{}, err
	}
	if role == "" || role == domain.RoleViewer {
		return TagEditResult{}, domain.Codedf(domain.ErrForbidden, domain.CodeTxnEditForbidden,
			"无权修改该交易")
	}
	if role != domain.RoleOwner && orig.CreatedBy != userID {
		return TagEditResult{}, domain.Codedf(domain.ErrForbidden, domain.CodeTxnEditForbidden,
			"只能修改自己记的账，或由账本 owner 修改")
	}

	// 4) 载荷校验（服务端权威规范化；无效标签 → 400）。
	tags, err := normalizeTags(in.Tags)
	if err != nil {
		return TagEditResult{}, err
	}
	// 5) 快速失败式 CAS。base_tags 是快照，不对其做长度/黑名单校验，
	// 仅按同一套规则规范化后比较集合，避免「乱序/空白/重复」造成伪冲突。
	base := canonicalTags(in.BaseTags)
	current := canonicalTags(orig.Tags)
	if !slices.Equal(base, current) {
		return TagEditResult{}, tagsConflictError(current, orig.TagsUpdatedAt)
	}

	// 6) 落库：事务内再判一次 CAS，UPDATE + 审计 + sync_log 同事务提交。
	res, err := s.repo.UpdateTagsTx(repository.TagsUpdateInput{
		LedgerID:   ledgerID,
		EntityUUID: txnUUID,
		Tags:       tags,
		BaseTags:   base,
		ActorID:    userID,
		DeviceID:   in.DeviceID,
		ClientOpID: in.ClientOpID,
	})
	if err != nil {
		var conflict *repository.TagsConflict
		if errors.As(err, &conflict) {
			return TagEditResult{}, tagsConflictError(conflict.CurrentTags, conflict.CurrentTagsUpdatedAt)
		}
		return TagEditResult{}, err
	}
	outTags := res.Tags
	if outTags == nil {
		outTags = []string{}
	}
	return TagEditResult{
		UUID: res.UUID, Tags: outTags,
		TagsUpdatedAt: res.TagsUpdatedAt, EditID: res.EditID,
	}, nil
}

// ListTagEdits 返回二级编辑记录（倒序，服务端限量 50 条）。
// viewer 可读：审计只读、不触及经济事实，鉴权由 middleware 的账本成员校验承担。
func (s *Service) ListTagEdits(ledgerID int64, uuid string, limit int) ([]TagEditItem, error) {
	logs, err := s.repo.TagEditsByUUID(ledgerID, uuid, limit)
	if err != nil {
		return nil, err
	}
	out := make([]TagEditItem, 0, len(logs))
	for _, l := range logs {
		oldTags, newTags := l.OldTags, l.NewTags
		if oldTags == nil {
			oldTags = []string{}
		}
		if newTags == nil {
			newTags = []string{}
		}
		out = append(out, TagEditItem{
			ID: l.ID, Action: l.Action,
			OldTags: oldTags, NewTags: newTags,
			ActorID: l.ActorID, ActorName: l.ActorName,
			DeviceID: l.DeviceID, Ts: l.Ts,
		})
	}
	return out, nil
}
