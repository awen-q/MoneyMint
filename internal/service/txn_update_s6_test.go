package service

// 0.6.0 S6 修改交易（T13）服务层回归：AC-5.1 / AC-5.2 / AC-5.3 / AC-5.5 / AC-5.6 / AC-5.8。
//
// 核心不变量：修改 = 冲正 + 新建，绝不原地改（三步单一大事务、3 条 sync_log、
// 原交易保留不软删、净效果 = 改后交易、导出过严格 bean-check）。
//
// 本文件只新增测试，不改任何产品代码。

import (
	"database/sql"
	"errors"
	"math/big"
	"testing"

	"familyledger/internal/beancount"
	"familyledger/internal/domain"
	"familyledger/internal/export"
	"familyledger/internal/repository"
)

// s6Env 是 S6 测试环境：保持 conn 以便直接断言 DB（sync_log / created_by / deleted_at）。
type s6Env struct {
	t       *testing.T
	conn    *sql.DB
	svc     *Service
	owner   int64
	editor  int64
	viewer  int64
	lid     int64
	cashID  int64
	foodID  int64
	cashUID string
	foodUID string
}

func newS6Env(t *testing.T) *s6Env {
	t.Helper()
	conn := openTestDB(t)
	svc := New(repository.New(conn))
	owner := insertUser(t, conn, "alice", false)
	editor := insertUser(t, conn, "bob", false)
	viewer := insertUser(t, conn, "carol", false)
	lid := insertLedger(t, conn, owner, "S6Ledger")
	if _, _, err := svc.AddMember(lid, owner, "bob", domain.RoleEditor); err != nil {
		t.Fatalf("加 editor: %v", err)
	}
	if _, _, err := svc.AddMember(lid, owner, "carol", domain.RoleViewer); err != nil {
		t.Fatalf("加 viewer: %v", err)
	}
	e := &s6Env{t: t, conn: conn, svc: svc, owner: owner, editor: editor, viewer: viewer, lid: lid}
	e.cashID, e.cashUID = e.createAccount("Assets:Cash", "Assets", "")
	e.foodID, e.foodUID = e.createAccount("Expenses:Food", "Expenses", "CNY")
	return e
}

// createAccount 建账户（与既有 S2 契约一致，parent_uuid 空串 = 根账户）。
func (e *s6Env) createAccount(name, typ, commodity string) (int64, string) {
	e.t.Helper()
	acc, err := e.svc.CreateAccount(e.lid, name, "", typ, "2026-01-01", commodity, "", "", "", "")
	if err != nil {
		e.t.Fatalf("create account %s: %v", name, err)
	}
	return acc.ID, acc.UUID
}

// createTxn 记一笔平衡交易，返回 uuid。
func (e *s6Env) createTxn(createdBy int64, date, desc string, cashAmt, foodAmt string) string {
	e.t.Helper()
	created, err := e.svc.CreateTransaction(e.lid, date, "*", desc, []PostingInput{
		{AccountID: e.cashID, Commodity: "CNY", Amount: cashAmt},
		{AccountID: e.foodID, Commodity: "CNY", Amount: foodAmt},
	}, createdBy)
	if err != nil {
		e.t.Fatalf("create txn: %v", err)
	}
	return created.UUID
}

// editTxn 修改交易（金额对：cash / food 等额反号）。
func (e *s6Env) editTxn(userID int64, uuid, date, desc, cashAmt string) (TransactionUpdated, error) {
	e.t.Helper()
	return e.svc.UpdateTransaction(e.lid, userID, uuid, TxnUpdateInput{
		Date: date, Description: desc,
		Postings: []PostingInput{
			{AccountID: e.cashID, Commodity: "CNY", Amount: cashAmt},
			{AccountID: e.foodID, Commodity: "CNY", Amount: negAmount(cashAmt)},
		},
	})
}

// negAmount 取负定点金额（测试辅助，纯字符串翻转经 big.Rat 保证精确）。
func negAmount(s string) string {
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		return s
	}
	return r.Neg(r).FloatString(2)
}

// syncLogTail 读取基线之后的 transaction 同步事件（按 id 升序）。
func (e *s6Env) syncLogTail(baseline int64) [][2]string {
	e.t.Helper()
	rows, err := e.conn.Query(
		`SELECT op, entity_uuid FROM sync_log
		 WHERE ledger_id=? AND entity_type='transaction' AND id > ? ORDER BY id`,
		e.lid, baseline)
	if err != nil {
		e.t.Fatalf("query sync_log: %v", err)
	}
	defer rows.Close()
	out := [][2]string{}
	for rows.Next() {
		var op, u string
		if err := rows.Scan(&op, &u); err != nil {
			e.t.Fatalf("scan sync_log: %v", err)
		}
		out = append(out, [2]string{op, u})
	}
	if err := rows.Err(); err != nil {
		e.t.Fatalf("sync_log rows: %v", err)
	}
	return out
}

// syncLogBaseline 返回当前最大 sync_log id（后续事件以此为界）。
func (e *s6Env) syncLogBaseline() int64 {
	e.t.Helper()
	var id sql.NullInt64
	if err := e.conn.QueryRow(`SELECT MAX(id) FROM sync_log`).Scan(&id); err != nil {
		e.t.Fatalf("query sync_log max: %v", err)
	}
	if !id.Valid {
		return 0
	}
	return id.Int64
}

func (e *s6Env) txnIntegrity(uuid string) (deleted bool, createdBy int64, ledgerID int64) {
	e.t.Helper()
	var del sql.NullString
	if err := e.conn.QueryRow(
		`SELECT deleted_at, COALESCE(created_by, 0), ledger_id FROM transactions WHERE uuid=?`,
		uuid).Scan(&del, &createdBy, &ledgerID); err != nil {
		e.t.Fatalf("query txn %s: %v", uuid, err)
	}
	deleted = del.Valid
	return deleted, createdBy, ledgerID
}

func (e *s6Env) assertCode(err error, code string) {
	e.t.Helper()
	if err == nil {
		e.t.Fatalf("应返回错误（%s），实际 nil", code)
	}
	var ce *domain.CodedError
	if !errors.As(err, &ce) || ce.Code != code {
		e.t.Fatalf("错误码应为 %s，实际 %v", code, err)
	}
}

// TestS6_UpdateTransactionThreeStepTxn AC-5.1：三步事务 + 3 条 sync_log
// （冲正 create + 原交易 update + 新交易 create）+ 三 uuid 响应、无 version。
func TestS6_UpdateTransactionThreeStepTxn(t *testing.T) {
	e := newS6Env(t)
	aUUID := e.createTxn(e.owner, "2026-02-01", "早餐", "-12.50", "12.50")
	base := e.syncLogBaseline()

	res, err := e.editTxn(e.owner, aUUID, "2026-02-02", "早餐（改）", "-20.00")
	if err != nil {
		t.Fatalf("UpdateTransaction: %v", err)
	}
	if res.OriginalUUID != aUUID || res.ReversalUUID == "" || res.NewUUID == "" {
		t.Fatalf("响应应含三 uuid：%+v", res)
	}
	if res.ReversalUUID == aUUID || res.NewUUID == aUUID || res.ReversalUUID == res.NewUUID {
		t.Fatalf("三 uuid 必须互不相同: %+v", res)
	}

	// 3 条 sync_log（顺序：冲正 create → 原交易 update → 新交易 create），不新增 op。
	events := e.syncLogTail(base)
	if len(events) != 3 {
		t.Fatalf("应恰好 3 条 sync_log，实际 %d: %v", len(events), events)
	}
	want := [][2]string{
		{domain.OpCreate, res.ReversalUUID},
		{domain.OpUpdate, aUUID},
		{domain.OpCreate, res.NewUUID},
	}
	for i, w := range want {
		if events[i][0] != w[0] || events[i][1] != w[1] {
			t.Fatalf("sync_log[%d] 应为 %v，实际 %v", i, w, events[i])
		}
	}

	// 原交易保留不软删（deleted_at IS NULL），三笔均活。
	for _, u := range []string{aUUID, res.ReversalUUID, res.NewUUID} {
		if deleted, _, _ := e.txnIntegrity(u); deleted {
			t.Fatalf("交易 %s 不得软删（破坏净效果）", u)
		}
	}

	// 列表口径：原交易带 reversed_by、冲正带 reversal_of（AC-5.5 徽章数据源）。
	txns, err := e.svc.ListTransactions(e.lid, e.owner)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	byUUID := map[string]TransactionView{}
	for _, v := range txns {
		byUUID[v.UUID] = v
	}
	if got := byUUID[aUUID]; got.ReversedBy != res.ReversalUUID || got.ReversalOf != "" {
		t.Fatalf("原交易应 reversed_by=冲正 uuid，实际 %+v", got)
	}
	if got := byUUID[res.ReversalUUID]; got.ReversalOf != aUUID || got.ReversedBy != "" {
		t.Fatalf("冲正交易应 reversal_of=原 uuid，实际 %+v", got)
	}
	if got := byUUID[res.NewUUID]; got.ReversedBy != "" || got.ReversalOf != "" {
		t.Fatalf("改后交易应为普通交易，实际 %+v", got)
	}
}

// TestS6_UpdateTransactionNetEffectBeanCheck AC-5.5：三笔组合净效果 = 改后交易，
// 导出可解析并过严格 bean-check。
func TestS6_UpdateTransactionNetEffectBeanCheck(t *testing.T) {
	e := newS6Env(t)
	aUUID := e.createTxn(e.owner, "2026-02-01", "购物", "-100.00", "100.00")
	res, err := e.editTxn(e.owner, aUUID, "2026-02-01", "购物（改）", "-30.00")
	if err != nil {
		t.Fatalf("edit: %v", err)
	}
	_ = res

	// 净效果：原 -100 与冲正 +100 相抵，改后 -30 生效。
	if got := accountByID(t, e.svc, e.cashID).Balances["CNY"]; got != "-30.00" {
		t.Fatalf("cash 净余额应为 -30.00，实际 %q", got)
	}
	if got := accountByID(t, e.svc, e.foodID).Balances["CNY"]; got != "30.00" {
		t.Fatalf("food 净余额应为 30.00，实际 %q", got)
	}

	// 导出三笔组合可解析、逐币种净效果 = 改后交易。
	out, err := export.ExportLedger(e.conn, e.lid)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	parsed, perr := beancount.Parse(out)
	if perr != nil || len(parsed.Errors) > 0 {
		t.Fatalf("导出文本应可解析: %v %+v", perr, parsed.Errors)
	}
	if len(parsed.Transactions) != 3 {
		t.Fatalf("导出应含 3 笔交易（原+冲正+改后），实际 %d", len(parsed.Transactions))
	}
	cashNet := new(big.Rat)
	for _, txn := range parsed.Transactions {
		for _, p := range txn.Postings {
			if p.Account != "Assets:Cash" {
				continue
			}
			v, ok := new(big.Rat).SetString(p.Amount)
			if !ok {
				t.Fatalf("导出金额非法 %q", p.Amount)
			}
			cashNet.Add(cashNet, v)
		}
	}
	if cashNet.FloatString(2) != "-30.00" {
		t.Fatalf("导出三笔组合 cash 净效果应为 -30.00，实际 %s", cashNet.FloatString(2))
	}

	if cmd := beanCheckCmd(t, writeTemp(t, "s6-net-*.beancount", out)); cmd != nil {
		if outp, berr := cmd.CombinedOutput(); berr != nil {
			t.Fatalf("bean-check 失败: %v\n%s", berr, string(outp))
		}
	} else {
		t.Logf("环境未安装 bean-check，跳过")
	}
}

// TestS6_UpdateTransactionGuards AC-5.6：编辑禁止清单（冲正 / 校准 / 期初）+
// 不平载荷拒绝 + 不修改 uuid / created_by / ledger_id。
func TestS6_UpdateTransactionGuards(t *testing.T) {
	e := newS6Env(t)

	// ① 冲正交易不可编辑：先改一笔，再改它的冲正交易。
	aUUID := e.createTxn(e.owner, "2026-02-01", "午餐", "-15.00", "15.00")
	res, err := e.editTxn(e.owner, aUUID, "2026-02-01", "午餐（改）", "-18.00")
	if err != nil {
		t.Fatalf("edit: %v", err)
	}
	_, err = e.editTxn(e.owner, res.ReversalUUID, "2026-02-01", "x", "-1.00")
	e.assertCode(err, domain.CodeTxnNotEditable)

	// ② 校准交易不可编辑（balance_key 非空）。
	balRes, err := e.svc.SetBalanceCalibration(e.lid, e.cashUID, BalanceInput{
		AsOfDate: "2026-02-10",
		Targets:  []BalanceTargetInput{{Commodity: "CNY", TargetBalance: "0.00"}},
		UserID:   e.owner,
	})
	if err != nil {
		t.Fatalf("calibrate: %v", err)
	}
	_, err = e.editTxn(e.owner, balRes.TransactionUUID, "2026-02-10", "x", "-1.00")
	e.assertCode(err, domain.CodeTxnNotEditable)

	// ③ 期初交易不可编辑（opening_account_uuid 非空）。期初仅资产/负债账户可设。
	loanID, loanUID := e.createAccount("Liabilities:Loan", "Liabilities", "CNY")
	_ = loanID
	openRes, err := e.svc.SetOpening(e.lid, loanUID, OpeningInput{
		Amount: "50.00", Direction: "owe", Commodity: "CNY", Date: "2026-02-01",
	})
	if err != nil {
		t.Fatalf("opening: %v", err)
	}
	_, err = e.editTxn(e.owner, openRes.TransactionUUID, "2026-01-01", "x", "-1.00")
	e.assertCode(err, domain.CodeTxnNotEditable)

	// ④ 不平载荷拒绝且零副作用。
	bUUID := e.createTxn(e.owner, "2026-02-03", "晚餐", "-8.00", "8.00")
	base := e.syncLogBaseline()
	_, err = e.svc.UpdateTransaction(e.lid, e.owner, bUUID, TxnUpdateInput{
		Date: "2026-02-03", Description: "不平",
		Postings: []PostingInput{
			{AccountID: e.cashID, Commodity: "CNY", Amount: "-10.00"},
			{AccountID: e.foodID, Commodity: "CNY", Amount: "5.00"},
		},
	})
	if err == nil {
		t.Fatalf("不平载荷应被拒绝")
	}
	if len(e.syncLogTail(base)) != 0 {
		t.Fatalf("拒绝后不得产生任何 sync_log / 写入")
	}

	// ⑤ 载荷禁 opening 标签。
	_, err = e.svc.UpdateTransaction(e.lid, e.owner, bUUID, TxnUpdateInput{
		Date: "2026-02-03", Description: "x", Tags: []string{"opening"},
		Postings: []PostingInput{
			{AccountID: e.cashID, Commodity: "CNY", Amount: "-1.00"},
			{AccountID: e.foodID, Commodity: "CNY", Amount: "1.00"},
		},
	})
	e.assertCode(err, domain.CodeOpeningViaAPIOnly)

	// ⑥ 不修改 uuid / created_by / ledger_id：改后交易由服务端生成新 uuid、
	// created_by=操作人、ledger_id 不变（AC-5.6）。
	cUUID := e.createTxn(e.owner, "2026-02-04", "交通", "-4.00", "4.00")
	res2, err := e.editTxn(e.owner, cUUID, "2026-02-04", "交通（改）", "-6.00")
	if err != nil {
		t.Fatalf("edit: %v", err)
	}
	deleted, createdBy, ledID := e.txnIntegrity(res2.NewUUID)
	if res2.NewUUID == cUUID {
		t.Fatalf("改后交易必须使用新 uuid")
	}
	if deleted || createdBy != e.owner || ledID != e.lid {
		t.Fatalf("改后交易元数据错误: deleted=%v created_by=%d ledger=%d", deleted, createdBy, ledID)
	}
	// 冲正交易同样必须带操作人（AC-5.6 的同一诉求）。
	// 此前 txnInsert 没有 created_by 列，冲正一律落 NULL：普通交易有值、
	// 冲正没有，同一次操作一半有操作人一半没有。这条断言锁住该缺口。
	if revDeleted, revCreatedBy, revLedID := e.txnIntegrity(res2.ReversalUUID); revDeleted ||
		revCreatedBy != e.owner || revLedID != e.lid {
		t.Fatalf("冲正交易元数据错误: deleted=%v created_by=%d ledger=%d",
			revDeleted, revCreatedBy, revLedID)
	}
}

// TestS6_UpdateTransactionPermissionMatrix AC-5.3 / AC-5.8：权限矩阵四类
//（owner 全账本 / editor 本人 / editor 他人 / viewer）+ created_by=0 owner 兜底
// + PATCH 服务端独立校验（不经 handler 直调 service 仍拦截）。
func TestS6_UpdateTransactionPermissionMatrix(t *testing.T) {
	e := newS6Env(t)

	// owner 改 editor 记的账 → OK。
	bobTxn := e.createTxn(e.editor, "2026-02-01", "bob 记", "-5.00", "5.00")
	if _, err := e.editTxn(e.owner, bobTxn, "2026-02-01", "owner 改", "-6.00"); err != nil {
		t.Fatalf("owner 应可改全账本: %v", err)
	}

	// editor 改自己的账 → OK，且改后 created_by=editor。
	bobTxn2 := e.createTxn(e.editor, "2026-02-02", "bob 记 2", "-7.00", "7.00")
	res, err := e.editTxn(e.editor, bobTxn2, "2026-02-02", "bob 改", "-9.00")
	if err != nil {
		t.Fatalf("editor 应可改自己的账: %v", err)
	}
	if _, createdBy, _ := e.txnIntegrity(res.NewUUID); createdBy != e.editor {
		t.Fatalf("改后交易 created_by 应为操作人 editor，实际 %d", createdBy)
	}
	// 冲正交易同理应为 editor —— 与上面新交易同源。
	// 若冲正从「当前会话」取值而非 in.CreatedBy，这里会暴露错记。
	if _, revCreatedBy, _ := e.txnIntegrity(res.ReversalUUID); revCreatedBy != e.editor {
		t.Fatalf("冲正交易 created_by 应为操作人 editor，实际 %d", revCreatedBy)
	}

	// editor 改 owner 记的账 → 403 txn_edit_forbidden。
	ownerTxn := e.createTxn(e.owner, "2026-02-03", "owner 记", "-3.00", "3.00")
	_, err = e.editTxn(e.editor, ownerTxn, "2026-02-03", "x", "-1.00")
	e.assertCode(err, domain.CodeTxnEditForbidden)

	// viewer 改任何账 → 403（服务端独立校验，前端显隐不是安全边界）。
	_, err = e.editTxn(e.viewer, ownerTxn, "2026-02-03", "x", "-1.00")
	e.assertCode(err, domain.CodeTxnEditForbidden)

	// 非成员 → 403。
	stranger := insertUser(t, e.conn, "dave", false)
	_, err = e.editTxn(stranger, ownerTxn, "2026-02-03", "x", "-1.00")
	e.assertCode(err, domain.CodeTxnEditForbidden)

	// created_by=0（离线 push 无创建者）→ 仅 owner 可改。
	anonTxn := e.createTxn(0, "2026-02-04", "离线", "-2.00", "2.00")
	_, err = e.editTxn(e.editor, anonTxn, "2026-02-04", "x", "-1.00")
	e.assertCode(err, domain.CodeTxnEditForbidden)
	if _, err := e.editTxn(e.owner, anonTxn, "2026-02-04", "owner 兜底", "-2.50"); err != nil {
		t.Fatalf("owner 应可改 created_by=0 的交易: %v", err)
	}
}

// TestS6_RetryEditHitsReversed409 AC-5.6：重试幂等 409 兜底——对已冲正原交易
// 再次提交修改（不落 edit_key / 不复用幂等键）直接 409 txn_already_reversed，
// 绝不产生第二套冲正。
func TestS6_RetryEditHitsReversed409(t *testing.T) {
	e := newS6Env(t)
	aUUID := e.createTxn(e.owner, "2026-02-01", "首次", "-10.00", "10.00")
	if _, err := e.editTxn(e.owner, aUUID, "2026-02-01", "改一次", "-11.00"); err != nil {
		t.Fatalf("首次修改: %v", err)
	}
	base := e.syncLogBaseline()
	_, err := e.editTxn(e.owner, aUUID, "2026-02-01", "重试", "-12.00")
	e.assertCode(err, domain.CodeTxnAlreadyReversed)
	// 不带 latest_uuid 字段（结构体无该字段即为不携带）+ 无任何写入。
	if len(e.syncLogTail(base)) != 0 {
		t.Fatalf("409 兜底不得产生写入")
	}
}

// TestS6_CanEditInView AC-5.2：can_edit 服务端按请求用户计算、已冲正判定优先于
// 角色、改后交易可续改。
func TestS6_CanEditInView(t *testing.T) {
	e := newS6Env(t)
	aUUID := e.createTxn(e.owner, "2026-02-01", "原始", "-10.00", "10.00")

	// 编辑前：owner / 本人 editor 可编辑；viewer 与 editor 不可编辑他人交易。
	views, err := e.svc.ListTransactions(e.lid, e.owner)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if !views[0].CanEdit {
		t.Fatalf("owner 应 can_edit=true")
	}
	bobViews, _ := e.svc.ListTransactions(e.lid, e.editor)
	if bobViews[0].CanEdit {
		t.Fatalf("editor 对他人交易应 can_edit=false")
	}
	carolViews, _ := e.svc.ListTransactions(e.lid, e.viewer)
	if carolViews[0].CanEdit {
		t.Fatalf("viewer 应 can_edit=false")
	}

	// 编辑后：原交易已冲正 → 即便是 owner 也 can_edit=false（D-15 优先于角色）；
	// 冲正交易不可编辑；改后交易可续改。
	res, err := e.editTxn(e.owner, aUUID, "2026-02-01", "改", "-11.00")
	if err != nil {
		t.Fatalf("edit: %v", err)
	}
	after, _ := e.svc.ListTransactions(e.lid, e.owner)
	byUUID := map[string]TransactionView{}
	for _, v := range after {
		byUUID[v.UUID] = v
	}
	if byUUID[aUUID].CanEdit {
		t.Fatalf("已冲正原交易应 can_edit=false（判定优先于角色）")
	}
	if byUUID[res.ReversalUUID].CanEdit {
		t.Fatalf("冲正交易应 can_edit=false")
	}
	if !byUUID[res.NewUUID].CanEdit {
		t.Fatalf("改后交易应 can_edit=true（可续改）")
	}

	// 续改：改后交易可再次进入三步事务。
	res2, err := e.editTxn(e.owner, res.NewUUID, "2026-02-01", "再改", "-13.00")
	if err != nil {
		t.Fatalf("改后交易应可续改: %v", err)
	}
	if res2.OriginalUUID != res.NewUUID {
		t.Fatalf("续改的 original_uuid 应为上一版改后交易")
	}
}

// TestS6_TrashCanRestore AC-5.8：回收站三签名 + can_restore 显隐 +
// viewer 仍可查看回收站（但不能恢复）。
func TestS6_TrashCanRestore(t *testing.T) {
	e := newS6Env(t)
	aUUID := e.createTxn(e.owner, "2026-02-01", "待删", "-10.00", "10.00")
	if err := e.svc.DeleteTransaction(e.lid, e.owner, aUUID); err != nil {
		t.Fatalf("delete: %v", err)
	}

	// owner / editor：可见且 can_restore=true。
	for _, uid := range []int64{e.owner, e.editor} {
		trash, err := e.svc.ListDeletedTransactions(e.lid, uid)
		if err != nil || len(trash) != 1 {
			t.Fatalf("回收站应 1 条: err=%v n=%d", err, len(trash))
		}
		if !trash[0].CanRestore {
			t.Fatalf("uid %d 应 can_restore=true", uid)
		}
	}
	// viewer：仍可查看回收站，但 can_restore=false。
	trash, err := e.svc.ListDeletedTransactions(e.lid, e.viewer)
	if err != nil || len(trash) != 1 {
		t.Fatalf("viewer 应仍可查看回收站: err=%v n=%d", err, len(trash))
	}
	if trash[0].CanRestore {
		t.Fatalf("viewer 应 can_restore=false")
	}

	// 服务端恢复复核：viewer 直接调 service 也被拒（双保险）。
	if err := e.svc.RestoreTransaction(e.lid, e.viewer, aUUID); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("viewer 恢复应 403，实际 %v", err)
	}
	if err := e.svc.RestoreTransaction(e.lid, e.editor, aUUID); err != nil {
		t.Fatalf("editor 恢复应成功: %v", err)
	}
}
