package repository

// B7 回收站永久删除的仓储层回归：
//
//   - 冲正闭包三态（无配对 / 配对同在回收站 / 配对仍有效）+ 悬空配对 + 连续修改链；
//   - 跨账本隔离（闭包与 DELETE 都必须带 ledger_id 守卫）；
//   - 系统生成交易的三重判定（单笔 409 / 清空整对保留）；
//   - 单事务性（并发兜底 409 与审计写失败都必须整体回滚）；
//   - 600 笔分批（两次跨越 purgeBatchSize=500）；
//   - 幂等探测（sync_log 的 delete 事件）与审计金额摘要。
//
// 这些用例刻意直接操作 SQL 造数据（而不是走 service），因为要构造的正是
// service 层不允许出现的状态：系统交易、半条冲正链、悬空配对。

import (
	"database/sql"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"familyledger/internal/db"
	"familyledger/internal/domain"
)

// purgeTestPosting 是一条测试分录。
type purgeTestPosting struct {
	AccountID int64
	Commodity string
	Amount    string
}

// txnSeed 描述一笔待写入的测试交易（字段与 transactions 列一一对应）。
type txnSeed struct {
	UUID        string
	Description string
	Date        string
	Deleted     bool
	ReversalOf  string
	ReversedBy  string
	OpeningUUID string
	BalanceKey  string
	ImportBatch string
	Postings    []purgeTestPosting
}

// purgeFixture 是永久删除用例的最小数据集：两个账本、三个账户。
type purgeFixture struct {
	store *Store
	// ledger 是主账本（id=1），other 是隔离验证用的第二账本（id=2）。
	ledger int64
	other  int64
	cash   int64
	food   int64
	cashB  int64
}

// newPurgeFixture 建一份跑完全部迁移的临时库并写入最小数据集。
func newPurgeFixture(t *testing.T) *purgeFixture {
	t.Helper()
	conn, err := db.Open(
		filepath.Join(t.TempDir(), "purge.db"),
		filepath.Join("..", "..", "schema.sql"),
	)
	if err != nil {
		t.Fatalf("打开测试库: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	mustExec := func(q string, args ...any) {
		t.Helper()
		if _, err := conn.Exec(q, args...); err != nil {
			t.Fatalf("exec %q: %v", q, err)
		}
	}
	mustExec(`INSERT INTO users(id, username, password_hash, display_name) VALUES(1,'purge-a','x','甲')`)
	mustExec(`INSERT INTO users(id, username, password_hash, display_name) VALUES(2,'purge-b','x','乙')`)
	mustExec(`INSERT INTO ledgers(id, name, owner_id) VALUES(1,'账本A',1)`)
	mustExec(`INSERT INTO ledgers(id, name, owner_id) VALUES(2,'账本B',2)`)
	mustExec(`INSERT INTO accounts(id, ledger_id, uuid, name, type, open_date)
	          VALUES(1,1,'acc-cash','Assets:Cash','Assets','2026-01-01')`)
	mustExec(`INSERT INTO accounts(id, ledger_id, uuid, name, type, open_date)
	          VALUES(2,1,'acc-food','Expenses:Food','Expenses','2026-01-01')`)
	mustExec(`INSERT INTO accounts(id, ledger_id, uuid, name, type, open_date)
	          VALUES(3,2,'acc-cash-b','Assets:Cash:B','Assets','2026-01-01')`)
	mustExec(`INSERT INTO accounts(id, ledger_id, uuid, name, type, open_date)
	          VALUES(4,2,'acc-food-b','Expenses:Food:B','Expenses','2026-01-01')`)

	return &purgeFixture{store: New(conn), ledger: 1, other: 2, cash: 1, food: 2, cashB: 3}
}

// balanced 返回一对借贷平衡的分录（主账本）。
func (f *purgeFixture) balanced() []purgeTestPosting {
	return []purgeTestPosting{
		{AccountID: f.cash, Commodity: "CNY", Amount: "-10.00"},
		{AccountID: f.food, Commodity: "CNY", Amount: "10.00"},
	}
}

// balancedOther 返回一对第二账本的平衡分录。
func (f *purgeFixture) balancedOther() []purgeTestPosting {
	return []purgeTestPosting{
		{AccountID: f.cashB, Commodity: "CNY", Amount: "-10.00"},
		{AccountID: 4, Commodity: "CNY", Amount: "10.00"},
	}
}

// insertTxn 直接写一笔交易（含分录），返回自增 id。
func (f *purgeFixture) insertTxn(t *testing.T, ledgerID int64, seed txnSeed) int64 {
	t.Helper()
	date := seed.Date
	if date == "" {
		date = "2026-02-01"
	}
	var deletedAt any
	if seed.Deleted {
		deletedAt = "2026-02-02 10:00:00"
	}
	nilIf := func(s string) any {
		if s == "" {
			return nil
		}
		return s
	}
	res, err := f.store.db.Exec(
		`INSERT INTO transactions
		 (ledger_id, uuid, date, flag, description, deleted_at, reversal_of, reversed_by,
		  opening_account_uuid, balance_key, import_batch_id)
		 VALUES(?, ?, ?, '*', ?, ?, ?, ?, ?, ?, ?)`,
		ledgerID, seed.UUID, date, seed.Description, deletedAt,
		nilIf(seed.ReversalOf), nilIf(seed.ReversedBy),
		nilIf(seed.OpeningUUID), nilIf(seed.BalanceKey), nilIf(seed.ImportBatch),
	)
	if err != nil {
		t.Fatalf("写入交易 %s: %v", seed.UUID, err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("取交易 id: %v", err)
	}
	for i, p := range seed.Postings {
		if _, err := f.store.db.Exec(
			`INSERT INTO postings(transaction_id, account_id, commodity, amount, position)
			 VALUES(?, ?, ?, ?, ?)`,
			id, p.AccountID, p.Commodity, p.Amount, i,
		); err != nil {
			t.Fatalf("写入分录 %s[%d]: %v", seed.UUID, i, err)
		}
	}
	return id
}

// count 是 SELECT count(*) 的测试快捷方式。
func (f *purgeFixture) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := f.store.db.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

// closureUUIDs 取出闭包里的 uuid 列表（按闭包顺序）。
func closureUUIDs(cands []PurgeCandidate) []string {
	out := make([]string, 0, len(cands))
	for _, c := range cands {
		out = append(out, c.UUID)
	}
	return out
}

// hasUUID 判断闭包里是否含某 uuid。
func hasUUID(cands []PurgeCandidate, want string) bool {
	for _, c := range cands {
		if c.UUID == want {
			return true
		}
	}
	return false
}

// TestExpandPurgeClosureStates 覆盖闭包三态与悬空配对（design §9 第 4 条）。
func TestExpandPurgeClosureStates(t *testing.T) {
	t.Run("无配对", func(t *testing.T) {
		f := newPurgeFixture(t)
		f.insertTxn(t, f.ledger, txnSeed{UUID: "a", Deleted: true, Postings: f.balanced()})

		closure, missing, err := f.store.ExpandPurgeClosure(f.ledger, []string{"a"})
		if err != nil {
			t.Fatalf("展开闭包: %v", err)
		}
		if len(missing) != 0 {
			t.Fatalf("不应有缺失种子，实际 %v", missing)
		}
		if len(closure) != 1 || closure[0].UUID != "a" || !closure[0].InTrash() {
			t.Fatalf("无配对闭包应只有 a 且在回收站，实际 %+v", closure)
		}
	})

	t.Run("配对同在回收站", func(t *testing.T) {
		f := newPurgeFixture(t)
		f.insertTxn(t, f.ledger, txnSeed{
			UUID: "a", Deleted: true, ReversedBy: "r", Postings: f.balanced()})
		f.insertTxn(t, f.ledger, txnSeed{
			UUID: "r", Deleted: true, ReversalOf: "a", Postings: f.balanced()})

		closure, _, err := f.store.ExpandPurgeClosure(f.ledger, []string{"a"})
		if err != nil {
			t.Fatalf("展开闭包: %v", err)
		}
		if len(closure) != 2 || !hasUUID(closure, "a") || !hasUUID(closure, "r") {
			t.Fatalf("配对闭包应为 {a,r}，实际 %v", closureUUIDs(closure))
		}
		for _, c := range closure {
			if !c.InTrash() {
				t.Fatalf("两条都应在回收站，%s 不满足", c.UUID)
			}
		}
	})

	t.Run("配对仍有效", func(t *testing.T) {
		f := newPurgeFixture(t)
		f.insertTxn(t, f.ledger, txnSeed{
			UUID: "a", Deleted: true, ReversedBy: "r", Postings: f.balanced()})
		f.insertTxn(t, f.ledger, txnSeed{
			UUID: "r", ReversalOf: "a", Postings: f.balanced()}) // 未软删

		closure, _, err := f.store.ExpandPurgeClosure(f.ledger, []string{"a"})
		if err != nil {
			t.Fatalf("展开闭包: %v", err)
		}
		if len(closure) != 2 {
			t.Fatalf("闭包应为 2 条，实际 %v", closureUUIDs(closure))
		}
		var effective int
		for _, c := range closure {
			if !c.InTrash() {
				effective++
			}
		}
		if effective != 1 {
			t.Fatalf("应有恰好 1 条不在回收站（有效配对成员），实际 %d", effective)
		}
	})

	t.Run("悬空配对只删自己", func(t *testing.T) {
		f := newPurgeFixture(t)
		f.insertTxn(t, f.ledger, txnSeed{
			UUID: "a", Deleted: true, ReversedBy: "ghost", Postings: f.balanced()})

		closure, missing, err := f.store.ExpandPurgeClosure(f.ledger, []string{"a"})
		if err != nil {
			t.Fatalf("悬空配对不应报错: %v", err)
		}
		if len(missing) != 0 {
			t.Fatalf("种子 a 存在，missing 应为空，实际 %v", missing)
		}
		if len(closure) != 1 || closure[0].UUID != "a" {
			t.Fatalf("悬空配对闭包应只有 a，实际 %v", closureUUIDs(closure))
		}

		// 真删一次：只删自己，不报错。
		out, err := f.store.PurgeTransactions(PurgeInput{
			LedgerID: f.ledger, ActorID: 1, Seeds: []string{"a"}, Mode: PurgeModeSingle})
		if err != nil {
			t.Fatalf("悬空配对永久删除: %v", err)
		}
		if len(out.Deleted) != 1 || out.Postings != 2 {
			t.Fatalf("应删 1 笔 2 条分录，实际 %d / %d", len(out.Deleted), out.Postings)
		}
	})
}

// TestExpandPurgeClosureModificationChain A→R1→R2（连续两次修改）闭包 = 3 条且不重复。
func TestExpandPurgeClosureModificationChain(t *testing.T) {
	f := newPurgeFixture(t)
	f.insertTxn(t, f.ledger, txnSeed{
		UUID: "a", Deleted: true, ReversedBy: "r1", Postings: f.balanced()})
	f.insertTxn(t, f.ledger, txnSeed{
		UUID: "r1", ReversalOf: "a", ReversedBy: "r2", Postings: f.balanced()})
	f.insertTxn(t, f.ledger, txnSeed{
		UUID: "r2", ReversalOf: "r1", Postings: f.balanced()})

	// 从链中间出发也必须拉满整条链（否则会删出半条）。
	for _, seed := range []string{"a", "r1", "r2"} {
		closure, _, err := f.store.ExpandPurgeClosure(f.ledger, []string{seed})
		if err != nil {
			t.Fatalf("从 %s 展开闭包: %v", seed, err)
		}
		if len(closure) != 3 {
			t.Fatalf("从 %s 出发闭包应为 3 条（visited 去重），实际 %v", seed, closureUUIDs(closure))
		}
		seen := map[string]bool{}
		for _, c := range closure {
			if seen[c.UUID] {
				t.Fatalf("闭包出现重复项 %s: %v", c.UUID, closureUUIDs(closure))
			}
			seen[c.UUID] = true
		}
	}
}

// TestExpandPurgeClosureCrossLedger 跨账本隔离：B 账本的同名配对交易绝不进闭包、也不被删。
func TestExpandPurgeClosureCrossLedger(t *testing.T) {
	f := newPurgeFixture(t)
	f.insertTxn(t, f.ledger, txnSeed{
		UUID: "a", Deleted: true, ReversedBy: "r", Postings: f.balanced()})
	f.insertTxn(t, f.ledger, txnSeed{
		UUID: "r", ReversalOf: "a", Postings: f.balanced()})
	// 第二账本：uuid 不同（uuid 全局唯一），但配对指针指向主账本的 r。
	f.insertTxn(t, f.other, txnSeed{
		UUID: "b-1", Deleted: true, ReversalOf: "r", Postings: f.balancedOther()})

	closure, _, err := f.store.ExpandPurgeClosure(f.ledger, []string{"a"})
	if err != nil {
		t.Fatalf("展开闭包: %v", err)
	}
	if hasUUID(closure, "b-1") {
		t.Fatalf("第二账本的交易不得进入闭包: %v", closureUUIDs(closure))
	}

	// 反向：从第二账本出发也拉不到主账本的 r。
	closureB, _, err := f.store.ExpandPurgeClosure(f.other, []string{"b-1"})
	if err != nil {
		t.Fatalf("展开第二账本闭包: %v", err)
	}
	if hasUUID(closureB, "r") || hasUUID(closureB, "a") {
		t.Fatalf("跨账本不得互相连带: %v", closureUUIDs(closureB))
	}

	// 真删主账本 → 第二账本的行必须还在（DELETE 带 ledger_id 守卫）。
	if _, err := f.store.PurgeTransactions(PurgeInput{
		LedgerID: f.ledger, ActorID: 1, Seeds: []string{"a"}, Mode: PurgeModeSingle}); err != nil {
		t.Fatalf("永久删除: %v", err)
	}
	if n := f.count(t, `SELECT count(*) FROM transactions WHERE ledger_id=? AND uuid IN ('a','r')`, f.other); n != 0 {
		t.Fatalf("第二账本不应有 a/r 行，实际 %d", n)
	}
	if n := f.count(t, `SELECT count(*) FROM transactions WHERE ledger_id=? AND uuid='b-1'`, f.other); n != 1 {
		t.Fatalf("第二账本的交易被跨账本删掉了")
	}
	if n := f.count(t, `SELECT count(*) FROM postings WHERE transaction_id IN
	        (SELECT id FROM transactions WHERE ledger_id=? AND uuid='b-1')`, f.other); n != 2 {
		t.Fatalf("第二账本的分录被跨账本删掉了，剩 %d 条", n)
	}
}

// TestPlanPurgeSystemSingle 单笔：闭包内任一成员是系统交易 → 409 txn_purge_not_allowed。
func TestPlanPurgeSystemSingle(t *testing.T) {
	cases := []struct {
		name  string
		seed  txnSeed
		label string
	}{
		{"期初", txnSeed{UUID: "a", Deleted: true, OpeningUUID: "acc-cash"}, "opening_account_uuid"},
		{"校准", txnSeed{UUID: "a", Deleted: true, BalanceKey: "balance:acc-cash:v1"}, "balance_key"},
		{"导入批次", txnSeed{UUID: "a", Deleted: true, ImportBatch: "imp-1"}, "import_batch_id"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newPurgeFixture(t)
			seed := tc.seed
			seed.Postings = f.balanced()
			f.insertTxn(t, f.ledger, seed)

			_, err := f.store.PurgeTransactions(PurgeInput{
				LedgerID: f.ledger, ActorID: 1, Seeds: []string{"a"}, Mode: PurgeModeSingle})
			var coded *domain.CodedError
			if !errors.As(err, &coded) {
				t.Fatalf("%s 应返回 CodedError，实际 %v", tc.name, err)
			}
			if coded.Code != domain.CodeTxnPurgeNotAllowed {
				t.Fatalf("%s 错误码应为 txn_purge_not_allowed，实际 %q", tc.name, coded.Code)
			}
			if !errors.Is(err, domain.ErrConflict) {
				t.Fatalf("必须带 ErrConflict 哨兵（否则 handler 会降到 400）: %v", err)
			}
			details, ok := coded.Details.(map[string]any)
			if !ok {
				t.Fatalf("应带 blocked_uuids 明细，实际 %#v", coded.Details)
			}
			if blocked, _ := details["blocked_uuids"].([]string); len(blocked) != 1 || blocked[0] != "a" {
				t.Fatalf("blocked_uuids 应指向 a，实际 %#v", details["blocked_uuids"])
			}
			// 行必须原样保留（判定失败不得写任何东西）。
			if n := f.count(t, `SELECT count(*) FROM transactions WHERE uuid='a'`); n != 1 {
				t.Fatalf("系统交易被删掉了")
			}
			if n := f.count(t, `SELECT count(*) FROM txn_purge_log`); n != 0 {
				t.Fatalf("判定失败不得写审计，实际 %d 行", n)
			}
		})
	}

	t.Run("配对连带命中系统交易也拒绝", func(t *testing.T) {
		f := newPurgeFixture(t)
		// a 是普通交易且已被软删；它的冲正配对 r 是导入批次交易。
		f.insertTxn(t, f.ledger, txnSeed{
			UUID: "a", Deleted: true, ReversedBy: "r", Postings: f.balanced()})
		f.insertTxn(t, f.ledger, txnSeed{
			UUID: "r", ReversalOf: "a", ImportBatch: "imp-9", Postings: f.balanced()})

		_, err := f.store.PurgeTransactions(PurgeInput{
			LedgerID: f.ledger, ActorID: 1, Seeds: []string{"a"}, Mode: PurgeModeSingle})
		var coded *domain.CodedError
		if !errors.As(err, &coded) || coded.Code != domain.CodeTxnPurgeNotAllowed {
			t.Fatalf("配对成员是系统交易时应 409 txn_purge_not_allowed，实际 %v", err)
		}
		if n := f.count(t, `SELECT count(*) FROM transactions WHERE uuid IN ('a','r')`); n != 2 {
			t.Fatalf("被拒绝时两条都必须保留，实际 %d 条", n)
		}
	})
}

// TestPlanPurgeSystemAll 清空：命中系统交易的整对保留，其余照删。
func TestPlanPurgeSystemAll(t *testing.T) {
	f := newPurgeFixture(t)
	// 普通交易（可删）
	f.insertTxn(t, f.ledger, txnSeed{UUID: "n1", Deleted: true, Postings: f.balanced()})
	// 系统交易 + 普通配对（整对保留）
	f.insertTxn(t, f.ledger, txnSeed{
		UUID: "s1", Deleted: true, ReversedBy: "s1r", OpeningUUID: "acc-cash", Postings: f.balanced()})
	f.insertTxn(t, f.ledger, txnSeed{
		UUID: "s1r", Deleted: true, ReversalOf: "s1", Postings: f.balanced()})

	seeds, err := f.store.DeletedTransactionUUIDs(f.ledger)
	if err != nil {
		t.Fatalf("取回收站 uuid: %v", err)
	}
	if len(seeds) != 3 {
		t.Fatalf("回收站应有 3 笔，实际 %d", len(seeds))
	}

	out, err := f.store.PurgeTransactions(PurgeInput{
		LedgerID: f.ledger, ActorID: 1, Seeds: seeds, Mode: PurgeModeAll})
	if err != nil {
		t.Fatalf("清空回收站: %v", err)
	}
	if len(out.Deleted) != 1 || out.Deleted[0].UUID != "n1" {
		t.Fatalf("只应删 n1，实际 %v", closureUUIDs(out.Deleted))
	}
	if len(out.Kept) != 2 || !hasUUID(out.Kept, "s1") || !hasUUID(out.Kept, "s1r") {
		t.Fatalf("系统交易及其配对都应保留，实际 Kept=%v", closureUUIDs(out.Kept))
	}
	if n := f.count(t, `SELECT count(*) FROM transactions WHERE uuid IN ('s1','s1r')`); n != 2 {
		t.Fatalf("保留的整对应仍在库里，实际 %d 条", n)
	}
	if n := f.count(t, `SELECT count(*) FROM transactions WHERE uuid='n1'`); n != 0 {
		t.Fatalf("n1 应已物理删除")
	}
	// 保留项不得写 sync_log delete / 审计。
	if n := f.count(t, `SELECT count(*) FROM sync_log WHERE entity_uuid IN ('s1','s1r') AND op='delete'`); n != 0 {
		t.Fatalf("保留项不得广播 delete，实际 %d 条", n)
	}
	if n := f.count(t, `SELECT count(*) FROM txn_purge_log`); n != 1 {
		t.Fatalf("审计应只有 n1 一行，实际 %d", n)
	}
}

// TestPlanPurgeSystemAllChain 连续修改链里有一笔系统交易 → 整条链保留（不留半条）。
func TestPlanPurgeSystemAllChain(t *testing.T) {
	f := newPurgeFixture(t)
	f.insertTxn(t, f.ledger, txnSeed{
		UUID: "a", Deleted: true, ReversedBy: "r1", Postings: f.balanced()})
	f.insertTxn(t, f.ledger, txnSeed{
		UUID: "r1", ReversalOf: "a", ReversedBy: "r2", Postings: f.balanced()})
	f.insertTxn(t, f.ledger, txnSeed{
		UUID: "r2", Deleted: true, ReversalOf: "r1", ImportBatch: "imp-2", Postings: f.balanced()})

	out, err := f.store.PurgeTransactions(PurgeInput{
		LedgerID: f.ledger, ActorID: 1,
		Seeds: []string{"a", "r2"}, Mode: PurgeModeAll})
	if err != nil {
		t.Fatalf("清空回收站: %v", err)
	}
	if len(out.Deleted) != 0 {
		t.Fatalf("整条链含系统交易，不得删任何一条，实际删了 %v", closureUUIDs(out.Deleted))
	}
	if len(out.Kept) != 3 {
		t.Fatalf("整条链应保留 3 条，实际 %v", closureUUIDs(out.Kept))
	}
}

// TestPurgeTransactionsNotInTrash 单笔：种子存在但未软删 → 409 txn_purge_not_deleted。
func TestPurgeTransactionsNotInTrash(t *testing.T) {
	f := newPurgeFixture(t)
	f.insertTxn(t, f.ledger, txnSeed{UUID: "a", Postings: f.balanced()}) // 未软删

	_, err := f.store.PurgeTransactions(PurgeInput{
		LedgerID: f.ledger, ActorID: 1, Seeds: []string{"a"}, Mode: PurgeModeSingle})
	var coded *domain.CodedError
	if !errors.As(err, &coded) || coded.Code != domain.CodeTxnPurgeNotDeleted {
		t.Fatalf("应 409 txn_purge_not_deleted，实际 %v", err)
	}
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("必须带 ErrConflict 哨兵: %v", err)
	}
	if n := f.count(t, `SELECT count(*) FROM transactions WHERE uuid='a'`); n != 1 {
		t.Fatalf("被拒绝的交易不得被删")
	}
}

// TestPurgeTransactionsWritesAuditAndSyncLog 删除成功时：分录/交易消失，
// sync_log 追加 delete，审计写入删除前快照（含对称 pair_uuid、actor、origin_deleted_at）。
func TestPurgeTransactionsWritesAuditAndSyncLog(t *testing.T) {
	f := newPurgeFixture(t)
	f.insertTxn(t, f.ledger, txnSeed{
		UUID: "a", Deleted: true, ReversedBy: "r", Description: "被修改前的早餐",
		Postings: f.balanced()})
	f.insertTxn(t, f.ledger, txnSeed{
		UUID: "r", ReversalOf: "a", Description: "冲正: 被修改前的早餐", Postings: f.balanced()})

	out, err := f.store.PurgeTransactions(PurgeInput{
		LedgerID: f.ledger, ActorID: 2, Seeds: []string{"a"}, Mode: PurgeModeSingle})
	if err != nil {
		t.Fatalf("永久删除: %v", err)
	}
	if len(out.Deleted) != 2 || out.Postings != 4 {
		t.Fatalf("应删 2 笔 4 条分录，实际 %d / %d", len(out.Deleted), out.Postings)
	}
	if n := f.count(t, `SELECT count(*) FROM transactions WHERE ledger_id=?`, f.ledger); n != 0 {
		t.Fatalf("交易应已物理删除，剩 %d", n)
	}
	if n := f.count(t, `SELECT count(*) FROM postings`); n != 0 {
		t.Fatalf("分录应已物理删除，剩 %d", n)
	}

	// sync_log：每个 uuid 一条 delete。
	for _, uuid := range []string{"a", "r"} {
		if n := f.count(t, `SELECT count(*) FROM sync_log
		     WHERE ledger_id=? AND entity_type='transaction' AND entity_uuid=? AND op='delete'`,
			f.ledger, uuid); n != 1 {
			t.Fatalf("%s 应有一条 delete 事件，实际 %d", uuid, n)
		}
	}

	// 审计：两行，pair_uuid 对称，was_in_trash / origin_deleted_at 正确。
	if n := f.count(t, `SELECT count(*) FROM txn_purge_log WHERE ledger_id=?`, f.ledger); n != 2 {
		t.Fatalf("审计应有 2 行，实际 %d", n)
	}
	readAudit := func(uuid string) (desc, pair, origin string, wasInTrash int, actor int64, amountNote string) {
		t.Helper()
		if err := f.store.db.QueryRow(
			`SELECT description, pair_uuid, origin_deleted_at, was_in_trash, actor_id, amount_note
			 FROM txn_purge_log WHERE uuid=?`, uuid,
		).Scan(&desc, &pair, &origin, &wasInTrash, &actor, &amountNote); err != nil {
			t.Fatalf("读取审计 %s: %v", uuid, err)
		}
		return
	}
	aDesc, aPair, aOrigin, aTrash, aActor, aNote := readAudit("a")
	rDesc, rPair, rOrigin, rTrash, _, _ := readAudit("r")

	if aDesc != "被修改前的早餐" || rDesc != "冲正: 被修改前的早餐" {
		t.Fatalf("审计描述应为删除前原样: %q / %q", aDesc, rDesc)
	}
	if aPair != "r" || rPair != "a" {
		t.Fatalf("pair_uuid 必须对称写（a→r、r→a），实际 %q / %q", aPair, rPair)
	}
	if aTrash != 1 {
		t.Fatalf("a 删除前在回收站，was_in_trash 应为 1，实际 %d", aTrash)
	}
	if rTrash != 0 {
		t.Fatalf("r 是有效配对成员，was_in_trash 应为 0，实际 %d", rTrash)
	}
	if aOrigin == "" {
		t.Fatalf("回收站内的 a 应记录 origin_deleted_at")
	}
	if rOrigin != "" {
		t.Fatalf("有效配对成员 origin_deleted_at 应为空串，实际 %q", rOrigin)
	}
	if aActor != 2 {
		t.Fatalf("actor_id 应为操作人 2，实际 %d", aActor)
	}
	// 金额摘要取自 postings.amount 的 CAST(... AS TEXT)。amount 列是 NUMERIC 亲和类型：
	// '-10.00' 落库后被归一为数值 -10，CAST 回文本即 "-10"。审计里统一**纯字符串补零**到
	// 两位（与回收站页其他金额同口径），但不动符号、不加千分位、不求和、不读币种精度。
	if aNote != "-10.00 CNY / 10.00 CNY" {
		t.Fatalf("金额摘要格式不符：%q", aNote)
	}
}

// TestPurgeTransactionsAmountNote 审计金额摘要：最多 3 条，超出追加 " …"，不做求和。
func TestPurgeTransactionsAmountNote(t *testing.T) {
	f := newPurgeFixture(t)
	f.insertTxn(t, f.ledger, txnSeed{
		UUID: "multi", Deleted: true,
		Postings: []purgeTestPosting{
			{AccountID: f.cash, Commodity: "CNY", Amount: "-10.00"},
			{AccountID: f.food, Commodity: "CNY", Amount: "6.00"},
			{AccountID: f.food, Commodity: "CNY", Amount: "4.00"},
			{AccountID: f.cash, Commodity: "USD", Amount: "-1.00"},
			{AccountID: f.food, Commodity: "USD", Amount: "1.00"},
		},
	})
	if _, err := f.store.PurgeTransactions(PurgeInput{
		LedgerID: f.ledger, ActorID: 1, Seeds: []string{"multi"}, Mode: PurgeModeSingle}); err != nil {
		t.Fatalf("永久删除: %v", err)
	}
	var note string
	if err := f.store.db.QueryRow(`SELECT amount_note FROM txn_purge_log WHERE uuid='multi'`).Scan(&note); err != nil {
		t.Fatalf("读取金额摘要: %v", err)
	}
	// 最多 3 条 + " …"；金额是 CAST(... AS TEXT) 后再补两位小数。
	want := "-10.00 CNY / 6.00 CNY / 4.00 CNY …"
	if note != want {
		t.Fatalf("金额摘要应为 %q，实际 %q", want, note)
	}
}

// TestPurgeTransactionsRollbackOnConcurrentChange 并发兜底：
// 闭包里有一笔在「读到删」之间消失 → affected != len(targets) → 409 + 整事务回滚。
func TestPurgeTransactionsRollbackOnConcurrentChange(t *testing.T) {
	f := newPurgeFixture(t)
	f.insertTxn(t, f.ledger, txnSeed{UUID: "a", Deleted: true, Postings: f.balanced()})
	f.insertTxn(t, f.ledger, txnSeed{UUID: "b", Deleted: true, Postings: f.balanced()})

	// 模拟「另一个写者抢在我们 DELETE 之前删掉了 b」：在事务内先删 b。
	purgeHookBeforeDeleteTransactions = func(tx *sql.Tx) {
		if _, err := tx.Exec(`DELETE FROM transactions WHERE uuid='b'`); err != nil {
			t.Fatalf("注入并发删除: %v", err)
		}
	}
	t.Cleanup(func() { purgeHookBeforeDeleteTransactions = nil })

	_, err := f.store.PurgeTransactions(PurgeInput{
		LedgerID: f.ledger, ActorID: 1, Seeds: []string{"a", "b"}, Mode: PurgeModeAll})
	var coded *domain.CodedError
	if !errors.As(err, &coded) {
		t.Fatalf("应返回 CodedError，实际 %v", err)
	}
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("并发兜底必须带 ErrConflict 哨兵（→409）: %v", err)
	}
	if coded.Code != "" {
		t.Fatalf("本批不为并发兜底新增错误码（规格错误码字典 = 5 个），实际 %q", coded.Code)
	}

	// 整事务回滚：a（以及 b 的那次「外部删除」）都必须还在，
	// 且分录、sync_log、审计一条都没写。
	if n := f.count(t, `SELECT count(*) FROM transactions WHERE ledger_id=?`, f.ledger); n != 2 {
		t.Fatalf("回滚后两笔交易都应存在，实际 %d 笔", n)
	}
	if n := f.count(t, `SELECT count(*) FROM postings`); n != 4 {
		t.Fatalf("回滚后分录应完好（4 条），实际 %d", n)
	}
	if n := f.count(t, `SELECT count(*) FROM sync_log WHERE entity_type='transaction' AND op='delete'`); n != 0 {
		t.Fatalf("回滚后不得有 delete 事件，实际 %d 条", n)
	}
	if n := f.count(t, `SELECT count(*) FROM txn_purge_log`); n != 0 {
		t.Fatalf("回滚后不得有审计，实际 %d 行", n)
	}
}

// TestPurgeTransactionsRollbackOnAuditFailure 单事务性：
// 审计写失败（这里把审计表删掉制造）时，物理删除必须整体回滚。
func TestPurgeTransactionsRollbackOnAuditFailure(t *testing.T) {
	f := newPurgeFixture(t)
	f.insertTxn(t, f.ledger, txnSeed{UUID: "a", Deleted: true, Postings: f.balanced()})
	if _, err := f.store.db.Exec(`DROP TABLE txn_purge_log`); err != nil {
		t.Fatalf("移除审计表: %v", err)
	}

	if _, err := f.store.PurgeTransactions(PurgeInput{
		LedgerID: f.ledger, ActorID: 1, Seeds: []string{"a"}, Mode: PurgeModeSingle}); err == nil {
		t.Fatalf("审计写失败时应返回错误")
	}
	if n := f.count(t, `SELECT count(*) FROM transactions WHERE uuid='a'`); n != 1 {
		t.Fatalf("审计失败时交易必须回滚回来")
	}
	if n := f.count(t, `SELECT count(*) FROM postings`); n != 2 {
		t.Fatalf("审计失败时分录必须回滚回来，实际 %d 条", n)
	}
	if n := f.count(t, `SELECT count(*) FROM sync_log WHERE op='delete'`); n != 0 {
		t.Fatalf("审计失败时不得留下 delete 事件，实际 %d 条", n)
	}
}

// TestPurgeTransactionsBatch600 分批：600 笔（跨越 purgeBatchSize=500 两次）全部删净。
func TestPurgeTransactionsBatch600(t *testing.T) {
	f := newPurgeFixture(t)

	const total = 600
	tx, err := f.store.db.Begin()
	if err != nil {
		t.Fatalf("开启批量写入事务: %v", err)
	}
	for i := 0; i < total; i++ {
		res, err := tx.Exec(
			`INSERT INTO transactions(ledger_id, uuid, date, flag, description, deleted_at)
			 VALUES(?, ?, '2026-02-01', '*', ?, '2026-02-02 10:00:00')`,
			f.ledger, "bulk-"+strconv.Itoa(i), "批量"+strconv.Itoa(i),
		)
		if err != nil {
			_ = tx.Rollback()
			t.Fatalf("写入第 %d 笔: %v", i, err)
		}
		id, _ := res.LastInsertId()
		for pos, p := range f.balanced() {
			if _, err := tx.Exec(
				`INSERT INTO postings(transaction_id, account_id, commodity, amount, position)
				 VALUES(?, ?, ?, ?, ?)`, id, p.AccountID, p.Commodity, p.Amount, pos); err != nil {
				_ = tx.Rollback()
				t.Fatalf("写入第 %d 笔分录: %v", i, err)
			}
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("提交批量写入: %v", err)
	}

	seeds, err := f.store.DeletedTransactionUUIDs(f.ledger)
	if err != nil {
		t.Fatalf("取回收站 uuid: %v", err)
	}
	if len(seeds) != total {
		t.Fatalf("回收站应有 %d 笔，实际 %d", total, len(seeds))
	}

	out, err := f.store.PurgeTransactions(PurgeInput{
		LedgerID: f.ledger, ActorID: 1, Seeds: seeds, Mode: PurgeModeAll})
	if err != nil {
		t.Fatalf("批量永久删除: %v", err)
	}
	if len(out.Deleted) != total {
		t.Fatalf("应删 %d 笔，实际 %d", total, len(out.Deleted))
	}
	if out.Postings != total*2 {
		t.Fatalf("purged_postings 应为 %d，实际 %d", total*2, out.Postings)
	}
	if n := f.count(t, `SELECT count(*) FROM transactions WHERE ledger_id=?`, f.ledger); n != 0 {
		t.Fatalf("交易应删净，剩 %d", n)
	}
	if n := f.count(t, `SELECT count(*) FROM postings`); n != 0 {
		t.Fatalf("分录应删净，剩 %d", n)
	}
	if n := f.count(t, `SELECT count(*) FROM txn_purge_log WHERE ledger_id=?`, f.ledger); n != total {
		t.Fatalf("审计应有 %d 行，实际 %d", total, n)
	}
}

// TestPurgeTransactionsIdempotentOnMissing 第二次删同一 uuid：不报错，Deleted 为空、
// Missing 命中（幂等判定由 service 基于 TxnDeleteEventExists 完成）。
func TestPurgeTransactionsIdempotentOnMissing(t *testing.T) {
	f := newPurgeFixture(t)
	f.insertTxn(t, f.ledger, txnSeed{UUID: "a", Deleted: true, Postings: f.balanced()})

	if _, err := f.store.PurgeTransactions(PurgeInput{
		LedgerID: f.ledger, ActorID: 1, Seeds: []string{"a"}, Mode: PurgeModeSingle}); err != nil {
		t.Fatalf("首次永久删除: %v", err)
	}

	out, err := f.store.PurgeTransactions(PurgeInput{
		LedgerID: f.ledger, ActorID: 1, Seeds: []string{"a"}, Mode: PurgeModeSingle})
	if err != nil {
		t.Fatalf("重复永久删除不应报错: %v", err)
	}
	if len(out.Deleted) != 0 {
		t.Fatalf("重复删除不应再有 Deleted，实际 %v", closureUUIDs(out.Deleted))
	}
	if len(out.Missing) != 1 || out.Missing[0] != "a" {
		t.Fatalf("Missing 应命中 a，实际 %v", out.Missing)
	}
	// sync_log 允许多条 delete（没有唯一约束），但本次不该新增。
	if n := f.count(t, `SELECT count(*) FROM sync_log WHERE entity_uuid='a' AND op='delete'`); n != 1 {
		t.Fatalf("重复删除不应新增 delete 事件，实际 %d 条", n)
	}
}

// TestTxnDeleteEventExists 幂等探测：软删后为真；恢复后仍为真（历史事件只增不删）。
func TestTxnDeleteEventExists(t *testing.T) {
	f := newPurgeFixture(t)
	f.insertTxn(t, f.ledger, txnSeed{UUID: "a", Postings: f.balanced()})

	if ok, err := f.store.TxnDeleteEventExists(f.ledger, "a"); err != nil || ok {
		t.Fatalf("软删前不应有 delete 事件：%v / %v", ok, err)
	}
	if _, err := f.store.SoftDeleteTransaction(f.ledger, "a"); err != nil {
		t.Fatalf("软删: %v", err)
	}
	if ok, err := f.store.TxnDeleteEventExists(f.ledger, "a"); err != nil || !ok {
		t.Fatalf("软删后应有 delete 事件：%v / %v", ok, err)
	}

	// 恢复：行回到有效态，但历史 delete 事件不删（审计只写不删）。
	if _, err := f.store.RestoreTransaction(f.ledger, "a"); err != nil {
		t.Fatalf("恢复: %v", err)
	}
	if ok, err := f.store.TxnDeleteEventExists(f.ledger, "a"); err != nil || !ok {
		t.Fatalf("恢复后历史 delete 事件仍应存在：%v / %v", ok, err)
	}

	// 空 uuid 直接判否（不查库）。
	if ok, err := f.store.TxnDeleteEventExists(f.ledger, ""); err != nil || ok {
		t.Fatalf("空 uuid 应为 false：%v / %v", ok, err)
	}
	// 账本隔离：第二账本查不到。
	if ok, _ := f.store.TxnDeleteEventExists(f.other, "a"); ok {
		t.Fatalf("delete 事件应按 ledger_id 隔离")
	}
}

// TestPlaceholdersAndChunk 纯函数：占位符与分块边界。
func TestPlaceholdersAndChunk(t *testing.T) {
	if got := placeholders(0); got != "" {
		t.Fatalf("placeholders(0) 应为空串，实际 %q", got)
	}
	if got := placeholders(1); got != "?" {
		t.Fatalf("placeholders(1) = %q", got)
	}
	if got := placeholders(3); got != "?,?,?" {
		t.Fatalf("placeholders(3) = %q", got)
	}
	ids := make([]int64, 1201)
	for i := range ids {
		ids[i] = int64(i)
	}
	chunks := chunkInt64(ids, purgeBatchSize)
	if len(chunks) != 3 {
		t.Fatalf("1201 个 id 按 500 切应得 3 块，实际 %d", len(chunks))
	}
	if len(chunks[0]) != 500 || len(chunks[1]) != 500 || len(chunks[2]) != 201 {
		t.Fatalf("分块大小不符：%d/%d/%d", len(chunks[0]), len(chunks[1]), len(chunks[2]))
	}
	if got := chunkInt64(nil, purgeBatchSize); got != nil {
		t.Fatalf("空切片应返回 nil，实际 %v", got)
	}
	if got := chunkStrings([]string{"a", "b"}, 0); len(got) != 1 || strings.Join(got[0], ",") != "a,b" {
		t.Fatalf("size<=0 应按 purgeBatchSize 单块，实际 %v", got)
	}
}

// TestPadAuditAmount 审计金额补零：只在「小数位不足两位」时补，绝不改动既有精度。
func TestPadAuditAmount(t *testing.T) {
	cases := []struct{ in, want string }{
		{"-10", "-10.00"},
		{"10", "10.00"},
		{"0", "0.00"},
		{"-10.5", "-10.50"},    // 一位小数补一个 0（符号不动）
		{"10.00", "10.00"},     // 已两位原样
		{"0.0001", "0.0001"},   // precision=4 的币种不得被截成 0.00
		{"10.", "10.00"},       // 小数点后为空
		{"1.0e+15", "1.0e+15"}, // 指数写法不动
		{" 8.5 ", "8.50"},      // 前后空白先 trim
		{"", ""},               // 空串原样
	}
	for _, c := range cases {
		if got := padAuditAmount(c.in); got != c.want {
			t.Fatalf("padAuditAmount(%q) = %q，期望 %q", c.in, got, c.want)
		}
	}
}
