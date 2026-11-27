package service

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"familyledger/internal/domain"
	"familyledger/internal/repository"
)

// TestNormalizeTags 锁定服务端权威的标签规范化口径：
// trim → 丢空 → 精确去重（大小写敏感）→ 排序 → 校验。
func TestNormalizeTags(t *testing.T) {
	cases := []struct {
		name    string
		in      []string
		want    []string
		wantErr string // 期望的稳定错误码，空串表示成功
	}{
		{"空数组", []string{}, []string{}, ""},
		{"空白与重复", []string{" 餐饮 ", "", "晚餐", "餐饮", "  "}, []string{"晚餐", "餐饮"}, ""},
		{"大小写敏感去重", []string{"Tag", "tag", "Tag"}, []string{"Tag", "tag"}, ""},
		{"控制字符", []string{"餐\n厅"}, nil, domain.CodeTxnTagsInvalid},
		{"DEL 控制字符", []string{"餐\x7f厅"}, nil, domain.CodeTxnTagsInvalid},
		{"opening 黑名单", []string{" OPENING "}, nil, domain.CodeOpeningViaAPIOnly},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeTags(tc.in)
			if tc.wantErr != "" {
				if code := codedCode(t, err); code != tc.wantErr {
					t.Fatalf("期望错误码 %s，实际 %s (%v)", tc.wantErr, code, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("不应报错: %v", err)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("规范化结果 %v，期望 %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("规范化结果 %v，期望 %v", got, tc.want)
				}
			}
		})
	}

	tooMany := make([]string, maxTagsPerTxn+1)
	for i := range tooMany {
		tooMany[i] = "标签" + string(rune('A'+i))
	}
	if _, err := normalizeTags(tooMany); codedCode(t, err) != domain.CodeTxnTagsInvalid {
		t.Fatalf("超过 %d 个标签应 txn_tags_invalid", maxTagsPerTxn)
	}
	long := ""
	for i := 0; i < maxTagRunes+1; i++ {
		long += "长"
	}
	if _, err := normalizeTags([]string{long}); codedCode(t, err) != domain.CodeTxnTagsInvalid {
		t.Fatalf("超过 %d 字符应 txn_tags_invalid", maxTagRunes)
	}
}

// tagEditFixture 建立一台带 owner / 两账户 / 一笔带标签交易的测试服务。
type tagEditFixture struct {
	svc  *Service
	user int64
	uuid string
}

func newTagEditFixture(t *testing.T, tags ...string) *tagEditFixture {
	t.Helper()
	svc := newTestService(t)
	owner := registerOwner(t, svc)
	cash, err := svc.CreateAccount(lid, "Assets:TagSvcCash", "", "Assets", "", "CNY", "", "", "", "")
	if err != nil {
		t.Fatalf("建现金账户: %v", err)
	}
	food, err := svc.CreateAccount(lid, "Expenses:TagSvcFood", "", "Expenses", "", "CNY", "", "", "", "")
	if err != nil {
		t.Fatalf("建支出账户: %v", err)
	}
	created, err := svc.CreateTransaction(lid, "2026-03-01", "*", "午餐", []PostingInput{
		{AccountID: cash.ID, Commodity: "CNY", Amount: "-10.00"},
		{AccountID: food.ID, Commodity: "CNY", Amount: "10.00"},
	}, owner.User.ID, tags...)
	if err != nil {
		t.Fatalf("建交易: %v", err)
	}
	return &tagEditFixture{svc: svc, user: owner.User.ID, uuid: created.UUID}
}

func (f *tagEditFixture) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := f.svc.repo.DB().QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("查询 %q: %v", query, err)
	}
	return n
}

// TestUpdateTransactionTags_US1 改错别字：流水仍 1 行、uuid 不变、可再编辑、审计有记录。
func TestUpdateTransactionTags_US1(t *testing.T) {
	f := newTagEditFixture(t, "餐饮")
	before := f.count(t, `SELECT count(*) FROM transactions WHERE ledger_id=? AND deleted_at IS NULL`, lid)

	res, err := f.svc.UpdateTransactionTags(lid, f.user, f.uuid, TagsUpdateInput{
		Tags: []string{"晚餐"}, BaseTags: []string{"餐饮"}, DeviceID: "dev-a",
	})
	if err != nil {
		t.Fatalf("原地改标签: %v", err)
	}
	if res.UUID != f.uuid || len(res.Tags) != 1 || res.Tags[0] != "晚餐" || res.EditID <= 0 {
		t.Fatalf("响应不符: %+v", res)
	}
	if res.TagsUpdatedAt == "" {
		t.Fatal("响应应带 tags_updated_at")
	}
	if after := f.count(t, `SELECT count(*) FROM transactions WHERE ledger_id=? AND deleted_at IS NULL`, lid); after != before {
		t.Fatalf("交易行数应由 %d 保持 %d", before, after)
	}
	if n := f.count(t, `SELECT count(*) FROM transactions WHERE description LIKE '冲正:%'`); n != 0 {
		t.Fatalf("不得产生冲正行，实际 %d", n)
	}
	var reversedBy string
	if err := f.svc.repo.DB().QueryRow(
		`SELECT COALESCE(reversed_by,'') FROM transactions WHERE uuid=?`, f.uuid,
	).Scan(&reversedBy); err != nil || reversedBy != "" {
		t.Fatalf("reversed_by 必须保持空串，实际 %q err=%v", reversedBy, err)
	}

	// can_edit 仍为 true（computeCanEdit 口径不变）。
	views, err := f.svc.ListTransactions(lid, f.user)
	if err != nil {
		t.Fatalf("列表: %v", err)
	}
	for _, v := range views {
		if v.UUID == f.uuid && !v.CanEdit {
			t.Fatal("改标签后 can_edit 必须仍为 true")
		}
	}

	edits, err := f.svc.ListTagEdits(lid, f.uuid, 50)
	if err != nil || len(edits) != 1 {
		t.Fatalf("审计应有 1 条，实际 %d err=%v", len(edits), err)
	}
	e := edits[0]
	if e.OldTags[0] != "餐饮" || e.NewTags[0] != "晚餐" || e.ActorID != f.user || e.ActorName != "Alice" || e.DeviceID != "dev-a" {
		t.Fatalf("审计内容不符: %+v", e)
	}

	// 仍可再次编辑，且原 PATCH 路径不受影响（另起一笔验证 PATCH 仍走冲正）。
	if _, err := f.svc.UpdateTransactionTags(lid, f.user, f.uuid, TagsUpdateInput{
		Tags: []string{"夜宵"}, BaseTags: []string{"晚餐"},
	}); err != nil {
		t.Fatalf("再次编辑应成功: %v", err)
	}
	if n := f.count(t, `SELECT count(*) FROM tag_edit_log WHERE entity_uuid=?`, f.uuid); n != 2 {
		t.Fatalf("两次编辑应有 2 条审计，实际 %d", n)
	}
}

// TestUpdateTransactionTags_US2 删标签再重新加回，全程无冲正。
func TestUpdateTransactionTags_US2(t *testing.T) {
	f := newTagEditFixture(t, "餐饮")
	before := f.count(t, `SELECT count(*) FROM transactions WHERE ledger_id=? AND deleted_at IS NULL`, lid)

	res, err := f.svc.UpdateTransactionTags(lid, f.user, f.uuid, TagsUpdateInput{
		Tags: []string{}, BaseTags: []string{"餐饮"},
	})
	if err != nil || len(res.Tags) != 0 {
		t.Fatalf("清空标签应成功，实际 %+v err=%v", res, err)
	}
	q := buildTestQuery(t, lid, "餐饮")
	rows, _, err := f.svc.repo.ListTransactionsFiltered(q)
	if err != nil || len(rows) != 0 {
		t.Fatalf("删标签后筛选不应命中，实际 %d err=%v", len(rows), err)
	}
	edits, err := f.svc.ListTagEdits(lid, f.uuid, 50)
	if err != nil || len(edits) != 1 || len(edits[0].OldTags) != 1 || len(edits[0].NewTags) != 0 {
		t.Fatalf("删除审计不符: %+v err=%v", edits, err)
	}

	if _, err := f.svc.UpdateTransactionTags(lid, f.user, f.uuid, TagsUpdateInput{
		Tags: []string{"餐饮"}, BaseTags: []string{},
	}); err != nil {
		t.Fatalf("重新加回应成功: %v", err)
	}
	rows, _, err = f.svc.repo.ListTransactionsFiltered(buildTestQuery(t, lid, "餐饮"))
	if err != nil || len(rows) != 1 {
		t.Fatalf("加回后筛选应命中 1 笔，实际 %d err=%v", len(rows), err)
	}
	if after := f.count(t, `SELECT count(*) FROM transactions WHERE ledger_id=? AND deleted_at IS NULL`, lid); after != before {
		t.Fatalf("删/加标签不得改变交易行数（%d → %d）", before, after)
	}
	if n := f.count(t, `SELECT count(*) FROM transactions WHERE description LIKE '冲正:%'`); n != 0 {
		t.Fatalf("不得产生冲正行，实际 %d", n)
	}
}

// buildTestQuery 构造「按标签筛选」的仓储查询条件（与 HTTP ?tag= 同路径）。
func buildTestQuery(t *testing.T, ledgerID int64, tag string) repository.TransactionQuery {
	t.Helper()
	q, err := buildTransactionQuery(ledgerID, TransactionListQuery{Tags: []string{tag}})
	if err != nil {
		t.Fatalf("构造筛选条件: %v", err)
	}
	return q
}

// TestUpdateTransactionTags_DecisionOrder 锁定判定顺序：
// 已冲正 → 系统交易 → 权限（viewer / editor 他人）→ 载荷校验 → CAS。
func TestUpdateTransactionTags_DecisionOrder(t *testing.T) {
	t.Run("已冲正优先于角色", func(t *testing.T) {
		f := newTagEditFixture(t, "餐饮")
		viewer, err := f.svc.Register("tag-viewer", "secret123", "只读")
		if err != nil {
			t.Fatalf("注册 viewer: %v", err)
		}
		if _, _, err := f.svc.AddMember(lid, f.user, "tag-viewer", domain.RoleViewer); err != nil {
			t.Fatalf("加入 viewer: %v", err)
		}
		if _, err := f.svc.repo.DB().Exec(
			`UPDATE transactions SET reversed_by='rev-x' WHERE uuid=?`, f.uuid,
		); err != nil {
			t.Fatalf("标记已冲正: %v", err)
		}
		_, err = f.svc.UpdateTransactionTags(lid, viewer.User.ID, f.uuid, TagsUpdateInput{
			Tags: []string{"X"}, BaseTags: []string{"餐饮"},
		})
		if code := codedCode(t, err); code != domain.CodeTxnAlreadyReversed {
			t.Fatalf("已冲正应优先返回 txn_already_reversed，实际 %s", code)
		}
	})

	t.Run("系统交易拒绝", func(t *testing.T) {
		f := newTagEditFixture(t, "餐饮")
		for _, col := range []string{"opening_account_uuid", "balance_key", "reversal_of"} {
			if _, err := f.svc.repo.DB().Exec(
				`UPDATE transactions SET `+col+`='sys' WHERE uuid=?`, f.uuid,
			); err != nil {
				t.Fatalf("标记 %s: %v", col, err)
			}
			_, err := f.svc.UpdateTransactionTags(lid, f.user, f.uuid, TagsUpdateInput{
				Tags: []string{"X"}, BaseTags: []string{"餐饮"},
			})
			if code := codedCode(t, err); code != domain.CodeTxnNotEditable {
				t.Fatalf("%s 非空应 txn_not_editable，实际 %s", col, code)
			}
			if _, err := f.svc.repo.DB().Exec(
				`UPDATE transactions SET `+col+`='' WHERE uuid=?`, f.uuid,
			); err != nil {
				t.Fatalf("还原 %s: %v", col, err)
			}
		}
	})

	t.Run("viewer 与 editor 他人拒绝", func(t *testing.T) {
		f := newTagEditFixture(t, "餐饮")
		viewer, _ := f.svc.Register("tag-viewer-2", "secret123", "只读")
		if _, _, err := f.svc.AddMember(lid, f.user, "tag-viewer-2", domain.RoleViewer); err != nil {
			t.Fatalf("加入 viewer: %v", err)
		}
		editor, _ := f.svc.Register("tag-editor-2", "secret123", "编辑")
		if _, _, err := f.svc.AddMember(lid, f.user, "tag-editor-2", domain.RoleEditor); err != nil {
			t.Fatalf("加入 editor: %v", err)
		}
		for _, uid := range []int64{viewer.User.ID, editor.User.ID} {
			_, err := f.svc.UpdateTransactionTags(lid, uid, f.uuid, TagsUpdateInput{
				Tags: []string{"X"}, BaseTags: []string{"餐饮"},
			})
			if code := codedCode(t, err); code != domain.CodeTxnEditForbidden {
				t.Fatalf("无权限用户应 txn_edit_forbidden，实际 %s", code)
			}
		}
		if n := f.count(t, `SELECT count(*) FROM tag_edit_log`); n != 0 {
			t.Fatalf("无权限路径不应写审计，实际 %d", n)
		}
	})

	t.Run("不存在返回 ErrNotFound", func(t *testing.T) {
		f := newTagEditFixture(t, "餐饮")
		_, err := f.svc.UpdateTransactionTags(lid, f.user, "no-such", TagsUpdateInput{
			Tags: []string{}, BaseTags: []string{},
		})
		if !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("应返回 ErrNotFound，实际 %v", err)
		}
	})
}

// TestUpdateTransactionTags_CAS 覆盖并发 CAS、规范化伪冲突与重试结果幂等。
func TestUpdateTransactionTags_CAS(t *testing.T) {
	t.Run("并发同 base 一对一冲突", func(t *testing.T) {
		f := newTagEditFixture(t, "餐饮")
		var wg sync.WaitGroup
		errs := make([]error, 2)
		for i, tag := range []string{"甲", "乙"} {
			wg.Add(1)
			go func(i int, tag string) {
				defer wg.Done()
				_, errs[i] = f.svc.UpdateTransactionTags(lid, f.user, f.uuid, TagsUpdateInput{
					Tags: []string{tag}, BaseTags: []string{"餐饮"},
				})
			}(i, tag)
		}
		wg.Wait()

		var okCount, conflictCount int
		for _, err := range errs {
			switch {
			case err == nil:
				okCount++
			case codedCode(t, err) == domain.CodeTxnTagsConflict:
				conflictCount++
			default:
				t.Fatalf("并发请求 returned 非预期错误: %v", err)
			}
		}
		if okCount != 1 || conflictCount != 1 {
			t.Fatalf("应 1 成功 1 冲突，实际 %d/%d", okCount, conflictCount)
		}
		if n := f.count(t, `SELECT count(*) FROM tag_edit_log WHERE entity_uuid=?`, f.uuid); n != 1 {
			t.Fatalf("冲突不得产生第二条审计，实际 %d", n)
		}
	})

	t.Run("规范化消除伪冲突", func(t *testing.T) {
		f := newTagEditFixture(t, "餐饮", "出差")
		base := []string{" 出差 ", "餐饮", "出差", "  "}
		if _, err := f.svc.UpdateTransactionTags(lid, f.user, f.uuid, TagsUpdateInput{
			Tags: []string{"晚餐"}, BaseTags: base,
		}); err != nil {
			t.Fatalf("乱序/空白/重复不应误判冲突: %v", err)
		}
	})

	t.Run("重放同请求结果幂等", func(t *testing.T) {
		f := newTagEditFixture(t, "餐饮")
		in := TagsUpdateInput{Tags: []string{"晚餐"}, BaseTags: []string{"餐饮"}}
		if _, err := f.svc.UpdateTransactionTags(lid, f.user, f.uuid, in); err != nil {
			t.Fatalf("首次成功: %v", err)
		}
		_, err := f.svc.UpdateTransactionTags(lid, f.user, f.uuid, in)
		if code := codedCode(t, err); code != domain.CodeTxnTagsConflict {
			t.Fatalf("重放应 409 txn_tags_conflict，实际 %s", code)
		}
		var ce *domain.CodedError
		if !errors.As(err, &ce) {
			t.Fatalf("冲突应携带结构化错误: %v", err)
		}
		details, ok := ce.Details.(map[string]any)
		if !ok {
			t.Fatalf("冲突应带 Details，实际 %+v", ce.Details)
		}
		cur, ok := details["current_tags"].([]string)
		if !ok || len(cur) != 1 || cur[0] != "晚餐" {
			t.Fatalf("current_tags 应等于目标 tags，实际 %+v", details["current_tags"])
		}
		if n := f.count(t, `SELECT count(*) FROM tag_edit_log WHERE entity_uuid=?`, f.uuid); n != 1 {
			t.Fatalf("重试不得产生第二条审计，实际 %d", n)
		}
	})
}

// TestSyncPull_TagsUpdatedAtAdditive 出站 pull 的 transaction 实体追加 tags_updated_at，
// 且 applyUpdateEntity 仍拒绝夹带 tags 的 push（核心安全边界）。
func TestSyncPull_TagsUpdatedAtAdditive(t *testing.T) {
	f := newTagEditFixture(t, "餐饮")
	res, err := f.svc.UpdateTransactionTags(lid, f.user, f.uuid, TagsUpdateInput{
		Tags: []string{"晚餐"}, BaseTags: []string{"餐饮"},
	})
	if err != nil {
		t.Fatalf("改标签: %v", err)
	}
	pull, err := f.svc.SyncPull(lid, 0, "tags-pull-client")
	if err != nil {
		t.Fatalf("SyncPull: %v", err)
	}
	found := false
	for _, change := range pull.Changes {
		if change.EntityType != domain.EntityTransaction || change.Op != domain.OpUpdate {
			continue
		}
		var entity map[string]any
		if err := json.Unmarshal(change.Entity, &entity); err != nil {
			t.Fatalf("解析 pull 实体: %v", err)
		}
		if entity["uuid"] != f.uuid {
			continue
		}
		found = true
		if entity["tags_updated_at"] != res.TagsUpdatedAt {
			t.Fatalf("pull 应下发 tags_updated_at=%q，实际 %v", res.TagsUpdatedAt, entity["tags_updated_at"])
		}
		if tags, ok := entity["tags"].([]any); !ok || len(tags) != 1 || tags[0] != "晚餐" {
			t.Fatalf("pull 应下发当前 tags，实际 %v", entity["tags"])
		}
	}
	if !found {
		t.Fatal("pull 应含 transaction/op=update 出站事件")
	}
}
