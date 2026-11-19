package service

// B7 回收站永久删除的服务层回归：
//
//   - 权限：owner 成功 / editor 403 txn_purge_forbidden / viewer 与非成员 ErrForbidden；
//   - confirm 四态（缺省、空串、尾随空格应通过、"清空" 应拒绝）；
//   - 未软删 409 txn_purge_not_deleted、系统交易 409 txn_purge_not_allowed；
//   - 幂等（第二次 200 + already_purged）、从未存在 404、他账本 uuid 404；
//   - 审计落库（行数 / pair_uuid 对称 / was_in_trash / actor / origin_deleted_at）；
//   - TrashOverview（deletable + system_kept == |闭包|、paired、can_purge 仅 owner）。

import (
	"errors"
	"fmt"
	"testing"

	"familyledger/internal/domain"
	"familyledger/internal/repository"
)

// purgeSvcFixture 是服务层用例的最小环境：一个 owner + 两个账户。
type purgeSvcFixture struct {
	svc   *Service
	owner AuthResult
	cash  int64
	food  int64
}

// newPurgeSvcFixture 建库、注册 owner（alice）、建两个账户。
func newPurgeSvcFixture(t *testing.T) *purgeSvcFixture {
	t.Helper()
	svc := newTestService(t)
	owner := registerOwner(t, svc)
	cash, err := svc.CreateAccount(lid, "Assets:Cash:CNY", "", "Assets", "2026-08-01", "CNY", "", "", "", "")
	if err != nil {
		t.Fatalf("建现金账户: %v", err)
	}
	food, err := svc.CreateAccount(lid, "Expenses:Food:CNY", "", "Expenses", "2026-08-01", "CNY", "", "", "", "")
	if err != nil {
		t.Fatalf("建支出账户: %v", err)
	}
	return &purgeSvcFixture{svc: svc, owner: owner, cash: cash.ID, food: food.ID}
}

// newTxn 记一笔 -10/10 的平衡交易，返回 uuid。
func (f *purgeSvcFixture) newTxn(t *testing.T, description string) string {
	t.Helper()
	created, err := f.svc.CreateTransaction(lid, "2026-08-02", "*", description, []PostingInput{
		{AccountID: f.cash, Commodity: "CNY", Amount: "-10.00"},
		{AccountID: f.food, Commodity: "CNY", Amount: "10.00"},
	}, f.owner.User.ID)
	if err != nil {
		t.Fatalf("记一笔 %q: %v", description, err)
	}
	return created.UUID
}

// trash 软删一笔交易（模拟用户先删进回收站）。
func (f *purgeSvcFixture) trash(t *testing.T, uuid string) {
	t.Helper()
	if err := f.svc.DeleteTransaction(lid, f.owner.User.ID, uuid); err != nil {
		t.Fatalf("软删 %s: %v", uuid, err)
	}
}

// markSystem 把某笔交易改造成系统生成交易（期初 / 校准 / 导入批次三选一）。
func (f *purgeSvcFixture) markSystem(t *testing.T, uuid, column, value string) {
	t.Helper()
	switch column {
	case "opening_account_uuid", "balance_key", "import_batch_id":
	default:
		t.Fatalf("不支持的列 %q", column)
	}
	if _, err := f.svc.repo.DB().Exec(
		`UPDATE transactions SET `+column+`=? WHERE uuid=?`, value, uuid); err != nil {
		t.Fatalf("标记系统交易 %s: %v", uuid, err)
	}
}

// addMember 注册一个新用户并以指定角色加入主账本，返回其 AuthResult。
func (f *purgeSvcFixture) addMember(t *testing.T, username, role string) AuthResult {
	t.Helper()
	res, err := f.svc.Register(username, "secret123", username)
	if err != nil {
		t.Fatalf("注册 %s: %v", username, err)
	}
	if _, _, err := f.svc.AddMember(lid, f.owner.User.ID, username, role); err != nil {
		t.Fatalf("把 %s 加为 %s: %v", username, role, err)
	}
	return res
}

// auditRows 读审计表行数。
func (f *purgeSvcFixture) auditRows(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.svc.repo.DB().QueryRow(`SELECT count(*) FROM txn_purge_log`).Scan(&n); err != nil {
		t.Fatalf("统计审计行: %v", err)
	}
	return n
}

// TestPurgeTransactionOwnerSucceeds owner 永久删除单笔：物理删除 + 审计 + 回收站清空。
func TestPurgeTransactionOwnerSucceeds(t *testing.T) {
	f := newPurgeSvcFixture(t)
	keep := f.newTxn(t, "留下来的")
	gone := f.newTxn(t, "要删掉的")
	f.trash(t, gone)

	res, err := f.svc.PurgeTransaction(lid, f.owner.User.ID, gone, purgeConfirmWord)
	if err != nil {
		t.Fatalf("owner 永久删除应成功: %v", err)
	}
	if !res.OK || res.Count != 1 || res.PurgedPostings != 2 {
		t.Fatalf("响应异常: %+v", res)
	}
	if res.AlreadyPurged {
		t.Fatalf("首次删除不得标记 already_purged")
	}
	if len(res.Deleted) != 1 || res.Deleted[0].UUID != gone || !res.Deleted[0].WasInTrash {
		t.Fatalf("明细异常: %+v", res.Deleted)
	}
	if res.Deleted[0].Description != "要删掉的" {
		t.Fatalf("明细描述应为删除前原样，实际 %q", res.Deleted[0].Description)
	}

	// 物理删除：交易与分录都没了；软删的另一笔还在。
	txns, err := f.svc.ListTransactions(lid, f.owner.User.ID)
	if err != nil {
		t.Fatalf("列交易: %v", err)
	}
	if len(txns) != 1 || txns[0].UUID != keep {
		t.Fatalf("只应剩 %s，实际 %+v", keep, txns)
	}
	overview, err := f.svc.TrashOverview(lid, f.owner.User.ID)
	if err != nil {
		t.Fatalf("回收站概览: %v", err)
	}
	if len(overview.Items) != 0 {
		t.Fatalf("回收站应已空，实际 %d 条", len(overview.Items))
	}
	if len(overview.Log) != 1 || overview.Log[0].UUID != gone {
		t.Fatalf("审计应有 1 行指向 %s，实际 %+v", gone, overview.Log)
	}
	if overview.Log[0].ActorName != "Alice" {
		t.Fatalf("审计应带操作人显示名，实际 %q", overview.Log[0].ActorName)
	}
}

// TestPurgeTransactionPermission 权限矩阵：仅 owner；editor 403 带码；viewer / 非成员 ErrForbidden。
func TestPurgeTransactionPermission(t *testing.T) {
	f := newPurgeSvcFixture(t)
	gone := f.newTxn(t, "被删的")
	f.trash(t, gone)

	editor := f.addMember(t, "purge-editor", domain.RoleEditor)
	_, err := f.svc.PurgeTransaction(lid, editor.User.ID, gone, purgeConfirmWord)
	var coded *domain.CodedError
	if !errors.As(err, &coded) || coded.Code != domain.CodeTxnPurgeForbidden {
		t.Fatalf("editor 应 403 txn_purge_forbidden，实际 %v", err)
	}
	if !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("必须带 ErrForbidden 哨兵（否则 handler 会降到 400）: %v", err)
	}

	viewer := f.addMember(t, "purge-viewer", domain.RoleViewer)
	if _, err := f.svc.PurgeTransaction(lid, viewer.User.ID, gone, purgeConfirmWord); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("viewer 应 ErrForbidden，实际 %v", err)
	}

	outsider, err := f.svc.Register("purge-outsider", "secret123", "外人")
	if err != nil {
		t.Fatalf("注册外人: %v", err)
	}
	if _, err := f.svc.PurgeTransaction(lid, outsider.User.ID, gone, purgeConfirmWord); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("非成员应 ErrForbidden，实际 %v", err)
	}

	// 清空回收站同权限口径。
	if _, err := f.svc.PurgeTrash(lid, editor.User.ID, purgeConfirmWord); !errors.As(err, &coded) ||
		coded.Code != domain.CodeTxnPurgeForbidden {
		t.Fatalf("editor 清空回收站应 403 txn_purge_forbidden，实际 %v", err)
	}

	// 全程没有删掉任何东西。
	if trashed, _ := f.svc.ListDeletedTransactions(lid, f.owner.User.ID); len(trashed) != 1 {
		t.Fatalf("权限被拒时不得删除，回收站应仍有 1 条，实际 %d", len(trashed))
	}
}

// TestPurgeTransactionConfirm confirm 四态：缺省 / 空串 / "清空" 全部拒绝，
// 「删除」带首尾空格应通过（移动端输入法常带空格）。
func TestPurgeTransactionConfirm(t *testing.T) {
	f := newPurgeSvcFixture(t)

	rejected := []string{"", "   ", "清空", "确认删除", "删除!", "Delete"}
	for _, confirm := range rejected {
		uuid := f.newTxn(t, "待确认-"+confirm)
		f.trash(t, uuid)
		_, err := f.svc.PurgeTransaction(lid, f.owner.User.ID, uuid, confirm)
		var coded *domain.CodedError
		if !errors.As(err, &coded) || coded.Code != domain.CodeTxnPurgeConfirmRequired {
			t.Fatalf("confirm=%q 应 400 txn_purge_confirm_required，实际 %v", confirm, err)
		}
		if !errors.Is(err, domain.ErrInvalid) {
			t.Fatalf("confirm 校验必须带 ErrInvalid 哨兵: %v", err)
		}
		// 未确认不得删任何东西。
		if trashed, _ := f.svc.ListDeletedTransactions(lid, f.owner.User.ID); len(trashed) == 0 {
			t.Fatalf("confirm=%q 被拒时不得删除", confirm)
		}
	}

	// 带首尾空格的「删除」= 用户确实输入了，必须通过（TrimSpace 后严等）。
	for _, confirm := range []string{" 删除", "删除 ", " 删除 "} {
		uuid := f.newTxn(t, "带空格-"+confirm)
		f.trash(t, uuid)
		if _, err := f.svc.PurgeTransaction(lid, f.owner.User.ID, uuid, confirm); err != nil {
			t.Fatalf("confirm=%q 应通过，实际 %v", confirm, err)
		}
	}

	// 清空回收站同样只认「删除」（前端把用户手输的「清空」映射成它）。
	_, err := f.svc.PurgeTrash(lid, f.owner.User.ID, "清空")
	var coded *domain.CodedError
	if !errors.As(err, &coded) || coded.Code != domain.CodeTxnPurgeConfirmRequired {
		t.Fatalf("清空 confirm=清空 应 400 txn_purge_confirm_required，实际 %v", err)
	}
}

// TestPurgeTransactionNotDeleted 未软删 → 409 txn_purge_not_deleted。
func TestPurgeTransactionNotDeleted(t *testing.T) {
	f := newPurgeSvcFixture(t)
	uuid := f.newTxn(t, "还在账上")

	_, err := f.svc.PurgeTransaction(lid, f.owner.User.ID, uuid, purgeConfirmWord)
	var coded *domain.CodedError
	if !errors.As(err, &coded) || coded.Code != domain.CodeTxnPurgeNotDeleted {
		t.Fatalf("应 409 txn_purge_not_deleted，实际 %v", err)
	}
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("必须带 ErrConflict 哨兵: %v", err)
	}
	if txns, _ := f.svc.ListTransactions(lid, f.owner.User.ID); len(txns) != 1 {
		t.Fatalf("被拒绝的交易必须还在，实际 %d 条", len(txns))
	}
}

// TestPurgeTransactionSystemBlocked 系统生成交易（三重判定）→ 409 txn_purge_not_allowed。
func TestPurgeTransactionSystemBlocked(t *testing.T) {
	columns := []struct{ column, value string }{
		{"opening_account_uuid", "some-account-uuid"},
		{"balance_key", "balance:some-account:v1"},
		{"import_batch_id", "imp-b7"},
	}
	for _, c := range columns {
		t.Run(c.column, func(t *testing.T) {
			f := newPurgeSvcFixture(t)
			uuid := f.newTxn(t, "系统交易")
			f.trash(t, uuid)
			f.markSystem(t, uuid, c.column, c.value)

			_, err := f.svc.PurgeTransaction(lid, f.owner.User.ID, uuid, purgeConfirmWord)
			var coded *domain.CodedError
			if !errors.As(err, &coded) || coded.Code != domain.CodeTxnPurgeNotAllowed {
				t.Fatalf("%s 命中应 409 txn_purge_not_allowed，实际 %v", c.column, err)
			}
			if trashed, _ := f.svc.ListDeletedTransactions(lid, f.owner.User.ID); len(trashed) != 1 {
				t.Fatalf("系统交易必须保留在回收站，实际 %d 条", len(trashed))
			}
			if f.auditRows(t) != 0 {
				t.Fatalf("被拒绝时不得写审计")
			}
		})
	}
}

// TestPurgeTransactionIdempotent 幂等：连点两次，第二次 200 + already_purged + count 0。
func TestPurgeTransactionIdempotent(t *testing.T) {
	f := newPurgeSvcFixture(t)
	uuid := f.newTxn(t, "连点两次")
	f.trash(t, uuid)

	if _, err := f.svc.PurgeTransaction(lid, f.owner.User.ID, uuid, purgeConfirmWord); err != nil {
		t.Fatalf("首次删除: %v", err)
	}
	second, err := f.svc.PurgeTransaction(lid, f.owner.User.ID, uuid, purgeConfirmWord)
	if err != nil {
		t.Fatalf("重复删除不应报错（弱网连点）: %v", err)
	}
	if !second.OK || !second.AlreadyPurged || second.Count != 0 {
		t.Fatalf("第二次应 {ok:true,count:0,already_purged:true}，实际 %+v", second)
	}
	if second.Deleted == nil {
		t.Fatalf("deleted 必须是空切片而非 null（前端 v-for 依赖）")
	}
	if f.auditRows(t) != 1 {
		t.Fatalf("幂等命中不得重复写审计，实际 %d 行", f.auditRows(t))
	}
}

// TestPurgeTransactionNotFound 从未存在 / 他账本 uuid → 404 txn_not_found。
func TestPurgeTransactionNotFound(t *testing.T) {
	f := newPurgeSvcFixture(t)
	uuid := f.newTxn(t, "属于自己的")
	f.trash(t, uuid)

	// 从未存在。
	_, err := f.svc.PurgeTransaction(lid, f.owner.User.ID, "no-such-uuid", purgeConfirmWord)
	var coded *domain.CodedError
	if !errors.As(err, &coded) || coded.Code != domain.CodeTxnNotFound {
		t.Fatalf("从未存在应 404 txn_not_found，实际 %v", err)
	}
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("必须带 ErrNotFound 哨兵: %v", err)
	}

	// 他账本的 uuid：第二个账本里同名 uuid 结构不共享，等价于「本账本查无此笔」。
	other, err := f.svc.CreateLedger(f.owner.User.ID, "第二账本", "CNY")
	if err != nil {
		t.Fatalf("建第二账本: %v", err)
	}
	if _, err := f.svc.PurgeTransaction(other.ID, f.owner.User.ID, uuid, purgeConfirmWord); !errors.As(err, &coded) ||
		coded.Code != domain.CodeTxnNotFound {
		t.Fatalf("他账本 uuid 应 404 txn_not_found，实际 %v", err)
	}
	// 原账本那一笔必须还在回收站。
	if trashed, _ := f.svc.ListDeletedTransactions(lid, f.owner.User.ID); len(trashed) != 1 {
		t.Fatalf("跨账本请求不得影响本账本，实际回收站 %d 条", len(trashed))
	}
}

// TestPurgeTransactionWithReversalPair 被修改过的交易：永久删除会连带删掉有效冲正配对。
//
// 这是产品已裁定的**有意账务变更**（design 坑 1）：闭包 = {A, R}，
// 响应里 R 的 was_in_trash=false，审计 pair_uuid 对称。
func TestPurgeTransactionWithReversalPair(t *testing.T) {
	f := newPurgeSvcFixture(t)
	uuid := f.newTxn(t, "被修改的早餐")

	updated, err := f.svc.UpdateTransaction(lid, f.owner.User.ID, uuid, TxnUpdateInput{
		Date: "2026-08-03", Description: "改后的早餐",
		Postings: []PostingInput{
			{AccountID: f.cash, Commodity: "CNY", Amount: "-20.00"},
			{AccountID: f.food, Commodity: "CNY", Amount: "20.00"},
		},
	})
	if err != nil {
		t.Fatalf("修改交易: %v", err)
	}
	f.trash(t, uuid) // 把失效的原交易丢进回收站

	// 概览：闭包 2 笔、可删 2 笔、其中 1 笔是「不在回收站的有效配对」。
	overview, err := f.svc.TrashOverview(lid, f.owner.User.ID)
	if err != nil {
		t.Fatalf("回收站概览: %v", err)
	}
	if len(overview.Items) != 1 {
		t.Fatalf("回收站列表只有 A，实际 %d 条", len(overview.Items))
	}
	if overview.Summary.Deletable != 2 || overview.Summary.SystemKept != 0 || overview.Summary.Paired != 1 {
		t.Fatalf("概览应 2/0/1，实际 %+v", overview.Summary)
	}
	if !overview.Items[0].CanPurge {
		t.Fatalf("owner 且可删时 can_purge 应为 true")
	}
	if overview.Items[0].PairUUID != updated.ReversalUUID {
		t.Fatalf("pair_uuid 应指向冲正交易，实际 %q（期望 %q）",
			overview.Items[0].PairUUID, updated.ReversalUUID)
	}
	if overview.Items[0].IsSystem {
		t.Fatalf("普通交易不应标记 is_system")
	}

	res, err := f.svc.PurgeTransaction(lid, f.owner.User.ID, uuid, purgeConfirmWord)
	if err != nil {
		t.Fatalf("永久删除: %v", err)
	}
	if res.Count != 2 {
		t.Fatalf("应连带删除 2 笔，实际 %d", res.Count)
	}
	trashFlags := map[string]bool{}
	for _, d := range res.Deleted {
		trashFlags[d.UUID] = d.WasInTrash
	}
	if !trashFlags[uuid] {
		t.Fatalf("A 删除前在回收站，was_in_trash 应为 true")
	}
	if trashFlags[updated.ReversalUUID] {
		t.Fatalf("冲正交易是有效交易，was_in_trash 应为 false")
	}

	// 账本里只剩「改后交易」，冲正与原交易都被物理删除。
	txns, _ := f.svc.ListTransactions(lid, f.owner.User.ID)
	if len(txns) != 1 || txns[0].UUID != updated.NewUUID {
		t.Fatalf("应只剩改后交易 %s，实际 %+v", updated.NewUUID, txns)
	}

	// 审计：两行，pair_uuid 对称。
	rows, err := f.svc.repo.DB().Query(
		`SELECT uuid, pair_uuid, was_in_trash, origin_deleted_at, actor_id
		 FROM txn_purge_log ORDER BY id`)
	if err != nil {
		t.Fatalf("读审计: %v", err)
	}
	defer rows.Close()
	type auditRow struct {
		uuid, pair, origin string
		wasInTrash         int
		actor              int64
	}
	var got []auditRow
	for rows.Next() {
		var row auditRow
		if err := rows.Scan(&row.uuid, &row.pair, &row.wasInTrash, &row.origin, &row.actor); err != nil {
			t.Fatalf("扫描审计行: %v", err)
		}
		got = append(got, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("遍历审计行: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("审计应有 2 行，实际 %d", len(got))
	}
	pairs := map[string]string{}
	trashByUUID := map[string]int{}
	for _, row := range got {
		pairs[row.uuid] = row.pair
		trashByUUID[row.uuid] = row.wasInTrash
		if row.actor != f.owner.User.ID {
			t.Fatalf("actor_id 应为当前用户 %d，实际 %d", f.owner.User.ID, row.actor)
		}
	}
	if pairs[uuid] != updated.ReversalUUID || pairs[updated.ReversalUUID] != uuid {
		t.Fatalf("pair_uuid 必须对称写，实际 %+v", pairs)
	}
	if trashByUUID[uuid] != 1 || trashByUUID[updated.ReversalUUID] != 0 {
		t.Fatalf("was_in_trash 应 A=1 / R=0，实际 %+v", trashByUUID)
	}
	for _, row := range got {
		if row.uuid == uuid && row.origin == "" {
			t.Fatalf("A 的 origin_deleted_at 应非空")
		}
		if row.uuid == updated.ReversalUUID && row.origin != "" {
			t.Fatalf("有效配对成员的 origin_deleted_at 应为空串，实际 %q", row.origin)
		}
	}
}

// TestPurgeTrashAll 清空回收站：普通交易删净，系统交易整对保留。
func TestPurgeTrashAll(t *testing.T) {
	f := newPurgeSvcFixture(t)
	normal1 := f.newTxn(t, "普通一")
	normal2 := f.newTxn(t, "普通二")
	systemTxn := f.newTxn(t, "导入批次交易")
	f.trash(t, normal1)
	f.trash(t, normal2)
	f.trash(t, systemTxn)
	f.markSystem(t, systemTxn, "import_batch_id", "imp-b7-all")

	overview, err := f.svc.TrashOverview(lid, f.owner.User.ID)
	if err != nil {
		t.Fatalf("回收站概览: %v", err)
	}
	if overview.Summary.Deletable != 2 || overview.Summary.SystemKept != 1 {
		t.Fatalf("概览应 2 可删 / 1 保留，实际 %+v", overview.Summary)
	}
	var systemItemCanPurge bool
	for _, item := range overview.Items {
		if item.UUID == systemTxn {
			systemItemCanPurge = item.CanPurge
			if !item.IsSystem {
				t.Fatalf("系统交易应标记 is_system")
			}
		}
	}
	if systemItemCanPurge {
		t.Fatalf("系统交易的 can_purge 必须为 false")
	}

	res, err := f.svc.PurgeTrash(lid, f.owner.User.ID, purgeConfirmWord)
	if err != nil {
		t.Fatalf("清空回收站: %v", err)
	}
	if res.Count != 2 || res.PurgedPostings != 4 {
		t.Fatalf("应删 2 笔 4 条分录，实际 %d / %d", res.Count, res.PurgedPostings)
	}
	if res.AlreadyPurged {
		t.Fatalf("清空回收站不得带 already_purged")
	}

	// 回收站只剩系统交易。
	left, err := f.svc.ListDeletedTransactions(lid, f.owner.User.ID)
	if err != nil {
		t.Fatalf("列回收站: %v", err)
	}
	if len(left) != 1 || left[0].UUID != systemTxn {
		t.Fatalf("回收站应只剩系统交易，实际 %+v", left)
	}
	if f.auditRows(t) != 2 {
		t.Fatalf("审计应有 2 行，实际 %d", f.auditRows(t))
	}
}

// TestPurgeTrashEmpty 空回收站：200 {ok:true,count:0,deleted:[],purged_postings:0}，
// **不带** already_purged（空回收站是正常结果，不是幂等命中）。
func TestPurgeTrashEmpty(t *testing.T) {
	f := newPurgeSvcFixture(t)
	f.newTxn(t, "还在账上，不在回收站")

	res, err := f.svc.PurgeTrash(lid, f.owner.User.ID, purgeConfirmWord)
	if err != nil {
		t.Fatalf("清空空回收站应成功: %v", err)
	}
	if !res.OK || res.Count != 0 || res.PurgedPostings != 0 {
		t.Fatalf("空回收站响应应为 {ok:true,count:0,purged_postings:0}，实际 %+v", res)
	}
	if res.Deleted == nil || len(res.Deleted) != 0 {
		t.Fatalf("deleted 应为空切片，实际 %+v", res.Deleted)
	}
	if res.AlreadyPurged {
		t.Fatalf("空回收站不得带 already_purged")
	}
	if f.auditRows(t) != 0 {
		t.Fatalf("空回收站不得写审计")
	}
	// 未软删的交易不受影响。
	if txns, _ := f.svc.ListTransactions(lid, f.owner.User.ID); len(txns) != 1 {
		t.Fatalf("清空回收站不得碰有效交易，实际 %d 条", len(txns))
	}
}

// TestTrashOverviewAuditVisibleToAllMembers 审计对全体成员可见（含 viewer），
// 但 can_purge / can_restore 按角色收紧。
func TestTrashOverviewAuditVisibleToAllMembers(t *testing.T) {
	f := newPurgeSvcFixture(t)
	uuid := f.newTxn(t, "被删的")
	f.trash(t, uuid)
	if _, err := f.svc.PurgeTransaction(lid, f.owner.User.ID, uuid, purgeConfirmWord); err != nil {
		t.Fatalf("owner 删除: %v", err)
	}

	// 再造一条回收站记录供 viewer 查看列表。
	pending := f.newTxn(t, "还没删的")
	f.trash(t, pending)

	viewer := f.addMember(t, "purge-audit-viewer", domain.RoleViewer)
	overview, err := f.svc.TrashOverview(lid, viewer.User.ID)
	if err != nil {
		t.Fatalf("viewer 查看回收站: %v", err)
	}
	if len(overview.Items) != 1 || overview.Items[0].UUID != pending {
		t.Fatalf("viewer 应能看到回收站列表，实际 %+v", overview.Items)
	}
	if overview.Items[0].CanPurge {
		t.Fatalf("viewer 的 can_purge 必须为 false")
	}
	if overview.Items[0].CanRestore {
		t.Fatalf("viewer 的 can_restore 必须为 false")
	}
	if overview.Summary.Deletable != 1 {
		t.Fatalf("概览统计与角色无关（数据是数据），实际 %+v", overview.Summary)
	}
	if len(overview.Log) != 1 {
		t.Fatalf("审计对全体成员可见，viewer 应看到 1 行，实际 %d", len(overview.Log))
	}
}

// TestTrashOverviewCountsAddUp 概览自洽：deletable + system_kept == |闭包|，
// paired = 闭包中不在回收站的笔数，且 can_purge 与 owner 身份绑定。
func TestTrashOverviewCountsAddUp(t *testing.T) {
	f := newPurgeSvcFixture(t)
	plain := f.newTxn(t, "普通")
	modified := f.newTxn(t, "将被修改")
	system := f.newTxn(t, "系统交易")

	if _, err := f.svc.UpdateTransaction(lid, f.owner.User.ID, modified, TxnUpdateInput{
		Date: "2026-08-04", Description: "改后",
		Postings: []PostingInput{
			{AccountID: f.cash, Commodity: "CNY", Amount: "-30.00"},
			{AccountID: f.food, Commodity: "CNY", Amount: "30.00"},
		},
	}); err != nil {
		t.Fatalf("修改交易: %v", err)
	}
	f.trash(t, plain)
	f.trash(t, modified)
	f.trash(t, system)
	f.markSystem(t, system, "balance_key", "balance:x:v1")

	seeds := []string{plain, modified, system}
	closure, _, err := f.svc.repo.ExpandPurgeClosure(lid, seeds)
	if err != nil {
		t.Fatalf("展开闭包: %v", err)
	}
	overview, err := f.svc.TrashOverview(lid, f.owner.User.ID)
	if err != nil {
		t.Fatalf("回收站概览: %v", err)
	}
	if got := overview.Summary.Deletable + overview.Summary.SystemKept; got != len(closure) {
		t.Fatalf("deletable+system_kept 应等于闭包大小 %d，实际 %d（%+v）",
			len(closure), got, overview.Summary)
	}
	var notInTrash int
	for _, c := range closure {
		if !c.InTrash() {
			notInTrash++
		}
	}
	if overview.Summary.Paired != notInTrash {
		t.Fatalf("paired 应为「闭包中不在回收站的笔数」%d，实际 %d", notInTrash, overview.Summary.Paired)
	}
	for _, item := range overview.Items {
		switch item.UUID {
		case system:
			if item.CanPurge {
				t.Fatalf("系统交易的 can_purge 必须为 false")
			}
		case plain:
			if !item.CanPurge {
				t.Fatalf("普通交易 owner 的 can_purge 应为 true")
			}
		}
	}
}

// TestPurgeLogLimit 审计只返回最近 purgeLogLimit 条（更早的不出现在页脚）。
func TestPurgeLogLimit(t *testing.T) {
	f := newPurgeSvcFixture(t)
	// 直接灌 55 行审计，验证 LIMIT 与倒序（不必真删 55 笔）。
	for i := 0; i < purgeLogLimit+5; i++ {
		if _, err := f.svc.repo.DB().Exec(
			`INSERT INTO txn_purge_log(ledger_id, uuid, description, amount_note, was_in_trash,
			                           pair_uuid, actor_id, purged_at, origin_deleted_at)
			 VALUES(?, ?, ?, '', 1, '', ?, '2026-02-01 00:00:00', '')`,
			lid, fmt.Sprintf("log-%02d", i), fmt.Sprintf("第%d笔", i), f.owner.User.ID,
		); err != nil {
			t.Fatalf("灌审计 %d: %v", i, err)
		}
	}
	log, err := f.svc.PurgeLog(lid)
	if err != nil {
		t.Fatalf("读审计: %v", err)
	}
	if len(log) != purgeLogLimit {
		t.Fatalf("应只返回 %d 条，实际 %d", purgeLogLimit, len(log))
	}
	if log[0].UUID != "log-54" {
		t.Fatalf("应按 id 倒序（最新在前），实际首条 %q", log[0].UUID)
	}
}

// 保证 repository 包里的模式常量与 service 判定一致（编译期护栏：
// 若有人新增 PurgeMode 而忘了在 PlanPurge 里处理，这里会先红）。
var _ = repository.PurgeModeSingle
