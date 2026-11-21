package repository

// 分类排序批量落库回归（P0）：
//   - sort_order 真落库，顺序 = 提交顺序；
//   - 每条写一条 sync_log(op=update)，水位按提交顺序递增；
//   - 跨账本 uuid / sync_log 写失败时整批回滚（全成全败）；
//   - 单条 UpdateAccountSortOrder 对不存在的 uuid 保持幂等（不写日志）。

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	"familyledger/internal/db"
	"familyledger/internal/domain"
)

// sortOrderFixture 是本文件用的最小数据集：账本 1 三条账户，账本 2 一条。
type sortOrderFixture struct {
	store *Store
	conn  *sql.DB
}

func newSortOrderFixture(t *testing.T) *sortOrderFixture {
	t.Helper()
	conn, err := db.Open(
		filepath.Join(t.TempDir(), "sort-order.db"),
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
	mustExec(`INSERT INTO users(id, username, password_hash, display_name) VALUES(1,'sort-a','x','甲')`)
	mustExec(`INSERT INTO users(id, username, password_hash, display_name) VALUES(2,'sort-b','x','乙')`)
	mustExec(`INSERT INTO ledgers(id, name, owner_id) VALUES(1,'账本A',1)`)
	mustExec(`INSERT INTO ledgers(id, name, owner_id) VALUES(2,'账本B',2)`)
	for _, row := range []struct {
		id, ledger int64
		uuid, name string
	}{
		{1, 1, "u-a", "Expenses:A"},
		{2, 1, "u-b", "Expenses:B"},
		{3, 1, "u-c", "Expenses:C"},
		{4, 2, "u-other", "Expenses:Other"},
	} {
		mustExec(
			`INSERT INTO accounts(id, ledger_id, uuid, name, type, open_date)
			 VALUES(?, ?, ?, ?, 'Expenses', '2026-01-01')`,
			row.id, row.ledger, row.uuid, row.name,
		)
	}
	return &sortOrderFixture{store: New(conn), conn: conn}
}

func (f *sortOrderFixture) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := f.conn.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

func (f *sortOrderFixture) orderOf(t *testing.T, uuid string) int64 {
	t.Helper()
	var n int64
	if err := f.conn.QueryRow(`SELECT sort_order FROM accounts WHERE uuid=?`, uuid).Scan(&n); err != nil {
		t.Fatalf("读取 %s 的 sort_order: %v", uuid, err)
	}
	return n
}

// TestUpdateAccountSortOrdersPersistsAndLogs 正常批量：顺序=提交顺序，
// sync_log 每条一条 op=update、水位递增且按 ledger_id 隔离。
func TestUpdateAccountSortOrdersPersistsAndLogs(t *testing.T) {
	f := newSortOrderFixture(t)
	orders := []AccountSortOrderItem{
		{UUID: "u-c", SortOrder: 0},
		{UUID: "u-a", SortOrder: 1},
		{UUID: "u-b", SortOrder: 2},
	}

	updated, err := f.store.UpdateAccountSortOrders(1, orders)
	if err != nil {
		t.Fatalf("批量排序: %v", err)
	}
	if updated != 3 {
		t.Fatalf("应更新 3 条，实际 %d", updated)
	}
	for _, item := range orders {
		if got := f.orderOf(t, item.UUID); got != item.SortOrder {
			t.Fatalf("%s 的 sort_order 应为 %d，实际 %d", item.UUID, item.SortOrder, got)
		}
	}
	if got := f.orderOf(t, "u-other"); got != 0 {
		t.Fatalf("第二账本账户不得被改到，实际 %d", got)
	}

	if n := f.count(t, `SELECT count(*) FROM sync_log WHERE ledger_id=1 AND entity_type='account' AND op='update'`); n != 3 {
		t.Fatalf("应有 3 条 update 日志，实际 %d", n)
	}
	if n := f.count(t, `SELECT count(*) FROM sync_log WHERE entity_uuid='u-other'`); n != 0 {
		t.Fatalf("不得为第二账本写日志，实际 %d", n)
	}
	rows, err := f.conn.Query(
		`SELECT entity_uuid FROM sync_log WHERE ledger_id=1 AND op='update' ORDER BY id`,
	)
	if err != nil {
		t.Fatalf("读取 sync_log: %v", err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var uuid string
		if err := rows.Scan(&uuid); err != nil {
			t.Fatalf("扫描 sync_log: %v", err)
		}
		got = append(got, uuid)
	}
	if len(got) != 3 || got[0] != "u-c" || got[1] != "u-a" || got[2] != "u-b" {
		t.Fatalf("sync_log 水位应按提交顺序递增，实际 %v", got)
	}

	// 重放同一批：顺序保持不变（日志允许再追加，同步引擎按水位去重）。
	if _, err := f.store.UpdateAccountSortOrders(1, orders); err != nil {
		t.Fatalf("重放批量排序: %v", err)
	}
	for _, item := range orders {
		if got := f.orderOf(t, item.UUID); got != item.SortOrder {
			t.Fatalf("重放后 %s 顺序漂移：期望 %d，实际 %d", item.UUID, item.SortOrder, got)
		}
	}
}

// TestUpdateAccountSortOrdersRollbackOnForeignUUID 非本账本 uuid：
// 0 行命中 → 400 语义的 ErrInvalid，整批回滚（含先前已改的行与日志）。
func TestUpdateAccountSortOrdersRollbackOnForeignUUID(t *testing.T) {
	f := newSortOrderFixture(t)
	orders := []AccountSortOrderItem{
		{UUID: "u-b", SortOrder: 7},
		{UUID: "u-other", SortOrder: 0},
		{UUID: "u-a", SortOrder: 8},
	}

	_, err := f.store.UpdateAccountSortOrders(1, orders)
	if err == nil {
		t.Fatalf("跨账本 uuid 应报错")
	}
	if !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("应返回 ErrInvalid（→400），实际 %v", err)
	}
	if got := f.orderOf(t, "u-b"); got != 0 {
		t.Fatalf("整批回滚后 u-b 应恢复原顺序，实际 %d", got)
	}
	if n := f.count(t, `SELECT count(*) FROM sync_log`); n != 0 {
		t.Fatalf("整批回滚不得留下 sync_log，实际 %d", n)
	}
}

// TestUpdateAccountSortOrdersRollbackOnSyncLogFailure 日志写失败：
// 事务内 UPDATE 必须回滚，杜绝「本地顺序变了、其他端收不到」的静默漂移。
func TestUpdateAccountSortOrdersRollbackOnSyncLogFailure(t *testing.T) {
	f := newSortOrderFixture(t)
	if _, err := f.conn.Exec(`DROP TABLE sync_log`); err != nil {
		t.Fatalf("移除 sync_log: %v", err)
	}
	_, err := f.store.UpdateAccountSortOrders(1, []AccountSortOrderItem{
		{UUID: "u-a", SortOrder: 2},
		{UUID: "u-b", SortOrder: 1},
	})
	if err == nil {
		t.Fatalf("sync_log 写失败时应报错")
	}
	if got := f.orderOf(t, "u-a"); got != 0 {
		t.Fatalf("日志写失败后 u-a 必须回滚，实际 %d", got)
	}
	if got := f.orderOf(t, "u-b"); got != 0 {
		t.Fatalf("日志写失败后 u-b 必须回滚，实际 %d", got)
	}
}

// TestUpdateAccountSortOrderMissingUUIDIsNoop 单条方法对不存在 uuid 幂等：
// 不报错、不写日志（批量路径才把 0 行当校验失败）。
func TestUpdateAccountSortOrderMissingUUIDIsNoop(t *testing.T) {
	f := newSortOrderFixture(t)
	if err := f.store.UpdateAccountSortOrder(1, "u-ghost", 3); err != nil {
		t.Fatalf("单条幂等更新: %v", err)
	}
	if n := f.count(t, `SELECT count(*) FROM sync_log`); n != 0 {
		t.Fatalf("不存在账户不应写日志，实际 %d", n)
	}
}
