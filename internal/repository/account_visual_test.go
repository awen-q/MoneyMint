package repository

// 账户展示字段更新（批 II）repository 层单事务回归：
//   - UPDATE 三列落库 + 恰好一条 sync_log(op=update)；
//   - RowsAffected==0（不存在 / 跨账本 uuid）回滚且不写日志；
//   - 已关户账户可改（仅排除软删行）；
//   - 空串经 NULLIF 落 NULL（清除语义）。

import (
	"database/sql"
	"path/filepath"
	"testing"

	"familyledger/internal/db"
)

// visualFixture 是展示字段更新的最小数据集：账本 1 一条账户，账本 2 一条。
type visualFixture struct {
	store *Store
	conn  *sql.DB
}

func newVisualFixture(t *testing.T) *visualFixture {
	t.Helper()
	conn, err := db.Open(
		filepath.Join(t.TempDir(), "visual.db"),
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
	mustExec(`INSERT INTO users(id, username, password_hash, display_name) VALUES(1,'vis-a','x','甲')`)
	mustExec(`INSERT INTO ledgers(id, name, owner_id) VALUES(1,'账本A',1)`)
	mustExec(`INSERT INTO ledgers(id, name, owner_id) VALUES(2,'账本B',1)`)
	mustExec(`INSERT INTO accounts(id, ledger_id, uuid, name, type, open_date, display_name, icon, color)
		 VALUES(1,1,'u-vis','Assets:Bank','Assets','2026-01-01','储蓄银行','💰','#112233')`)
	mustExec(`INSERT INTO accounts(id, ledger_id, uuid, name, type, open_date)
		 VALUES(2,2,'u-other','Assets:Other','Assets','2026-01-01')`)
	return &visualFixture{store: New(conn), conn: conn}
}

func (f *visualFixture) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := f.conn.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

func TestUpdateAccountVisualPersistsAndLogs(t *testing.T) {
	f := newVisualFixture(t)

	updated, err := f.store.UpdateAccountVisual(1, "u-vis", "招商储蓄", "🏦", "#1F7A4D")
	if err != nil {
		t.Fatalf("更新展示字段: %v", err)
	}
	if !updated {
		t.Fatalf("存在行应返回 true")
	}
	var displayName, icon, color string
	if err := f.conn.QueryRow(
		`SELECT display_name, icon, color FROM accounts WHERE uuid='u-vis'`,
	).Scan(&displayName, &icon, &color); err != nil {
		t.Fatalf("读回账户: %v", err)
	}
	if displayName != "招商储蓄" || icon != "🏦" || color != "#1F7A4D" {
		t.Fatalf("三列应全量落库，实际 %s/%s/%s", displayName, icon, color)
	}
	// 恰好一条 op=update 日志（UPDATE 与 sync_log 同事务）。
	if n := f.count(t, `SELECT count(*) FROM sync_log WHERE ledger_id=1 AND entity_type='account' AND op='update'`); n != 1 {
		t.Fatalf("应恰有 1 条 update 日志，实际 %d", n)
	}
}

func TestUpdateAccountVisualClearsViaEmptyString(t *testing.T) {
	f := newVisualFixture(t)
	if _, err := f.store.UpdateAccountVisual(1, "u-vis", "", "", ""); err != nil {
		t.Fatalf("清除: %v", err)
	}
	var n int
	if err := f.conn.QueryRow(
		`SELECT count(*) FROM accounts WHERE uuid='u-vis' AND display_name IS NULL AND icon IS NULL AND color IS NULL`,
	).Scan(&n); err != nil {
		t.Fatalf("查询: %v", err)
	}
	if n != 1 {
		t.Fatalf("空串应经 NULLIF 落 NULL（清除），命中行数 %d", n)
	}
}

func TestUpdateAccountVisualRollsBackOnMissingOrForeign(t *testing.T) {
	f := newVisualFixture(t)

	// 不存在的 uuid：RowsAffected==0 → 回滚、不写日志、返回 false。
	updated, err := f.store.UpdateAccountVisual(1, "no-such-uuid", "x", "", "")
	if err != nil || updated {
		t.Fatalf("不存在 uuid 应返回 false 且无错，实际 %v / %v", updated, err)
	}
	// 跨账本 uuid 同样 0 行。
	updated, err = f.store.UpdateAccountVisual(2, "u-vis", "x", "", "")
	if err != nil || updated {
		t.Fatalf("跨账本 uuid 应返回 false，实际 %v / %v", updated, err)
	}
	if n := f.count(t, `SELECT count(*) FROM sync_log`); n != 0 {
		t.Fatalf("0 行更新不得写 sync_log，实际 %d", n)
	}
	var icon string
	if err := f.conn.QueryRow(`SELECT icon FROM accounts WHERE uuid='u-vis'`).Scan(&icon); err != nil {
		t.Fatalf("读回: %v", err)
	}
	if icon != "💰" {
		t.Fatalf("回滚后原值不得被改，实际 %q", icon)
	}
}

func TestUpdateAccountVisualClosedAccountAllowed(t *testing.T) {
	f := newVisualFixture(t)
	if _, err := f.conn.Exec(`UPDATE accounts SET close_date='2026-06-01' WHERE uuid='u-vis'`); err != nil {
		t.Fatalf("关户: %v", err)
	}
	updated, err := f.store.UpdateAccountVisual(1, "u-vis", "关户后改名", "", "")
	if err != nil || !updated {
		t.Fatalf("已关户账户应可改展示字段，实际 %v / %v", updated, err)
	}
}
