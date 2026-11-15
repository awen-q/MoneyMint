package service

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"

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
type TransactionView struct {
	ID            int64         `json:"id"`
	UUID          string        `json:"uuid"` // 批 2：列表透出 uuid（前端软删依赖）
	Date          string        `json:"date"`
	Flag          string        `json:"flag"`
	Description   string        `json:"description"`
	CreatedByName string        `json:"created_by_name"` // 记账人显示名；无创建者时为空串
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
func (s *Service) ListTransactions(ledgerID, userID int64) ([]TransactionView, error) {
	role, _ := s.repo.RoleOf(ledgerID, userID) // 非成员为空串 → can_edit 全 false
	txns, err := s.repo.ListTransactions(ledgerID)
	if err != nil {
		return nil, err
	}
	out := make([]TransactionView, 0, len(txns))
	for _, t := range txns {
		v := TransactionView{
			ID:            t.ID,
			UUID:          t.UUID,
			Date:          t.Date,
			Flag:          t.Flag,
			Description:   t.Description,
			CreatedByName: t.CreatedByName,
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
		out = append(out, v)
	}
	return out, nil
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
}

// ListDeletedTransactions 列出回收站（已软删交易），按删除时间倒序。
// viewer 仍可查看回收站（GET 放行），can_restore=false 仅隐藏恢复按钮。
func (s *Service) ListDeletedTransactions(ledgerID, userID int64) ([]TrashItemView, error) {
	role, _ := s.repo.RoleOf(ledgerID, userID)
	canRestore := role == domain.RoleOwner || role == domain.RoleEditor
	txns, err := s.repo.ListDeletedTransactions(ledgerID)
	if err != nil {
		return nil, err
	}
	out := make([]TrashItemView, 0, len(txns))
	for _, t := range txns {
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
		out = append(out, v)
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
