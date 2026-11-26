package repository

// 导入时建立 parent_uuid 父子关系的回归。
//
// 背景：导入执行段原先的 INSERT 只写 7 列、不含 parent_uuid，于是导入进来的
// 账户父子关系全丢，只存在于 name 的冒号里（账本 `一家三口` 的 12 个三级账户
// parent_uuid 全为 NULL）。前端 core/accounts.ts 的 buildAccountTree 有冒号兜底
// 能正确显示，但后端按 parent_uuid 做导出/统计/排序时会漏。
//
// 本文件锁两条：
// 1. 同一批导入内的父子（父必须先于子落库，才能拿到父 uuid）；
// 2. 父账户在导入前已存在（复用账户也必须进 name→uuid 映射表）。

import (
	"database/sql"
	"path/filepath"
	"testing"

	"familyledger/internal/beancount"
	"familyledger/internal/db"
)

// newImportParentFixture 建一份跑完全部迁移的临时库，含 1 个用户 + 1 个空账本。
func newImportParentFixture(t *testing.T) (*Store, *sql.DB, int64, int64) {
	t.Helper()
	conn, err := db.Open(
		filepath.Join(t.TempDir(), "import-parent.db"),
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
	const ownerID, ledgerID = int64(1), int64(1)
	mustExec(`INSERT INTO users(id, username, password_hash, display_name) VALUES(1,'imp-a','x','甲')`)
	mustExec(`INSERT INTO ledgers(id, name, owner_id) VALUES(1,'一家三口',1)`)
	return New(conn), conn, ledgerID, ownerID
}

// parentUUIDOf 读某账户的 parent_uuid；NULL 返回空串。
func parentUUIDOf(t *testing.T, conn *sql.DB, ledgerID int64, name string) string {
	t.Helper()
	var parent sql.NullString
	err := conn.QueryRow(
		`SELECT parent_uuid FROM accounts WHERE ledger_id=? AND name=?`, ledgerID, name,
	).Scan(&parent)
	if err != nil {
		t.Fatalf("查 %s 的 parent_uuid: %v", name, err)
	}
	if !parent.Valid {
		return ""
	}
	return parent.String
}

// uuidOf 读某账户的 uuid。
func uuidOf(t *testing.T, conn *sql.DB, ledgerID int64, name string) string {
	t.Helper()
	var u string
	if err := conn.QueryRow(
		`SELECT uuid FROM accounts WHERE ledger_id=? AND name=?`, ledgerID, name,
	).Scan(&u); err != nil {
		t.Fatalf("查 %s 的 uuid: %v", name, err)
	}
	return u
}

// 同一批导入内：父先于子落库，子级 parent_uuid 指向父；无父者作根（NULL）。
// 注意 beancount 里刻意把 `Expenses:Food:Dining` 写在 `Expenses:Food` 之前，
// 锁住"顺序不保证父先于子、必须显式按层级排序"这件事。
const importSameBatchBeancount = `option "title" "一家三口"
option "operating_currency" "CNY"

2026-01-01 open Expenses:Food:Dining
2026-01-01 open Expenses:Food:Groceries
2026-01-01 open Expenses:Food
2026-01-01 open Expenses:Housing:Mortgage
2026-01-01 open Assets:Cash

2026-01-05 * "午餐"
  Expenses:Food:Dining   10.00 CNY
  Assets:Cash           -10.00 CNY
`

func TestImportSetsParentUUIDFromNameHierarchy(t *testing.T) {
	store, conn, ledgerID, ownerID := newImportParentFixture(t)

	parsed, perr := beancount.Parse(importSameBatchBeancount)
	if perr != nil {
		t.Fatalf("解析 beancount: %v", perr)
	}
	if len(parsed.Errors) != 0 {
		t.Fatalf("解析有错误，用例前提不成立: %+v", parsed.Errors)
	}

	if _, err := store.ImportBeancountToLedger(
		ledgerID, ownerID, parsed, ImportTargetCurrent, "batch-parent-1",
	); err != nil {
		t.Fatalf("导入失败: %v", err)
	}

	foodUUID := uuidOf(t, conn, ledgerID, "Expenses:Food")
	if foodUUID == "" {
		t.Fatal("Expenses:Food 应已建出")
	}

	// 子级挂到父上。注意 `Expenses:Food:Dining` 在文件里比父更早 open，
	// 若实现未按层级排序，这里会是 NULL。
	if got := parentUUIDOf(t, conn, ledgerID, "Expenses:Food:Dining"); got != foodUUID {
		t.Errorf("Expenses:Food:Dining 的 parent_uuid 应为 %s，实际 %q", foodUUID, got)
	}
	if got := parentUUIDOf(t, conn, ledgerID, "Expenses:Food:Groceries"); got != foodUUID {
		t.Errorf("Expenses:Food:Groceries 的 parent_uuid 应为 %s，实际 %q", foodUUID, got)
	}

	// 父本身是根。
	if got := parentUUIDOf(t, conn, ledgerID, "Expenses:Food"); got != "" {
		t.Errorf("Expenses:Food 自身应为根（parent_uuid 为 NULL），实际 %q", got)
	}

	// 孤儿作根：`Expenses:Housing` 不在本账本，不自动创建父账户，落 NULL。
	if got := parentUUIDOf(t, conn, ledgerID, "Expenses:Housing:Mortgage"); got != "" {
		t.Errorf("Expenses:Housing:Mortgage 无父可挂，应为 NULL（孤儿作根），实际 %q", got)
	}
	var housingCount int
	if err := conn.QueryRow(
		`SELECT COUNT(*) FROM accounts WHERE ledger_id=? AND name='Expenses:Housing'`, ledgerID,
	).Scan(&housingCount); err != nil {
		t.Fatalf("查 Expenses:Housing: %v", err)
	}
	if housingCount != 0 {
		t.Errorf("不应自动创建缺失的父账户 Expenses:Housing，实际建了 %d 条", housingCount)
	}
}

// 父账户在本次导入前已存在：复用账户也必须进 name→uuid 映射，
// 否则本批新建的子级查不到父，父子关系照样丢。
const importReuseParentBeancount = `option "title" "一家三口"
option "operating_currency" "CNY"

2026-01-01 open Expenses:Food:Dining
2026-01-01 open Assets:Cash

2026-01-06 * "下馆子"
  Expenses:Food:Dining   25.00 CNY
  Assets:Cash           -25.00 CNY
`

func TestImportChildBindsToPreexistingParent(t *testing.T) {
	store, conn, ledgerID, ownerID := newImportParentFixture(t)

	// 先手工建父账户（模拟用户在记账前已建好「饮食」）。
	const preexistingFoodUUID = "uuid-preexisting-food"
	if _, err := conn.Exec(
		`INSERT INTO accounts(ledger_id, uuid, name, type, open_date)
		 VALUES(?, ?, 'Expenses:Food', 'Expenses', '2026-01-01')`,
		ledgerID, preexistingFoodUUID,
	); err != nil {
		t.Fatalf("预置 Expenses:Food: %v", err)
	}

	parsed, perr := beancount.Parse(importReuseParentBeancount)
	if perr != nil {
		t.Fatalf("解析 beancount: %v", perr)
	}
	if len(parsed.Errors) != 0 {
		t.Fatalf("解析有错误，用例前提不成立: %+v", parsed.Errors)
	}

	if _, err := store.ImportBeancountToLedger(
		ledgerID, ownerID, parsed, ImportTargetCurrent, "batch-parent-2",
	); err != nil {
		t.Fatalf("导入失败: %v", err)
	}

	// 子级应指向"预置的父"的 uuid，且不重复建父。
	if got := parentUUIDOf(t, conn, ledgerID, "Expenses:Food:Dining"); got != preexistingFoodUUID {
		t.Errorf("Expenses:Food:Dining 的 parent_uuid 应为既有父 %s，实际 %q", preexistingFoodUUID, got)
	}
	var foodCount int
	if err := conn.QueryRow(
		`SELECT COUNT(*) FROM accounts WHERE ledger_id=? AND name='Expenses:Food'`, ledgerID,
	).Scan(&foodCount); err != nil {
		t.Fatalf("统计 Expenses:Food: %v", err)
	}
	if foodCount != 1 {
		t.Errorf("Expenses:Food 应仍只有 1 条（复用而非新建），实际 %d 条", foodCount)
	}
}

// ─────────── 复用账户的 parent_uuid「只补空」自愈 ───────────

// countSyncUpdates 统计某账户在 sync_log 里的 op=update 条数。
func countSyncUpdates(t *testing.T, conn *sql.DB, ledgerID int64, entityUUID string) int {
	t.Helper()
	var n int
	if err := conn.QueryRow(
		`SELECT COUNT(*) FROM sync_log WHERE ledger_id=? AND entity_type='account' AND entity_uuid=? AND op='update'`,
		ledgerID, entityUUID,
	).Scan(&n); err != nil {
		t.Fatalf("统计 sync_log update: %v", err)
	}
	return n
}

// 只含三级账户的导入文件：父 `Expenses:Food` 已存在于库中，但本批不声明它。
const importSelfHealBeancount = `option "title" "一家三口"
option "operating_currency" "CNY"

2026-01-01 open Expenses:Food:Dining
2026-01-01 open Assets:Cash

2026-01-07 * "下馆子"
  Expenses:Food:Dining   30.00 CNY
  Assets:Cash           -30.00 CNY
`

func TestImportSelfHealsEmptyParentUUIDOnReusedAccount(t *testing.T) {
	store, conn, ledgerID, ownerID := newImportParentFixture(t)

	const foodUUID = "uuid-seed-food"
	const diningUUID = "uuid-seed-dining"
	if _, err := conn.Exec(
		`INSERT INTO accounts(ledger_id, uuid, name, type, open_date) VALUES(?,?,'Expenses:Food','Expenses','2026-01-01')`,
		ledgerID, foodUUID,
	); err != nil {
		t.Fatalf("预置 Expenses:Food: %v", err)
	}
	// 子级先存在，但 parent_uuid 为 NULL（老板账本的真实形态）。
	if _, err := conn.Exec(
		`INSERT INTO accounts(ledger_id, uuid, name, type, open_date) VALUES(?,?,'Expenses:Food:Dining','Expenses','2026-01-01')`,
		ledgerID, diningUUID,
	); err != nil {
		t.Fatalf("预置 Expenses:Food:Dining: %v", err)
	}
	if got := parentUUIDOf(t, conn, ledgerID, "Expenses:Food:Dining"); got != "" {
		t.Fatalf("前置条件：Dining 的 parent_uuid 应为空，实际 %q", got)
	}

	parsed, perr := beancount.Parse(importSelfHealBeancount)
	if perr != nil {
		t.Fatalf("解析 beancount: %v", perr)
	}
	if _, err := store.ImportBeancountToLedger(
		ledgerID, ownerID, parsed, ImportTargetCurrent, "batch-heal-1",
	); err != nil {
		t.Fatalf("导入失败: %v", err)
	}

	if got := parentUUIDOf(t, conn, ledgerID, "Expenses:Food:Dining"); got != foodUUID {
		t.Errorf("自愈后 Dining 的 parent_uuid 应为 %s，实际 %q", foodUUID, got)
	}
	// 父不应因引用而被新建。
	var foodCount int
	if err := conn.QueryRow(
		`SELECT COUNT(*) FROM accounts WHERE ledger_id=? AND name='Expenses:Food'`, ledgerID,
	).Scan(&foodCount); err != nil {
		t.Fatalf("统计 Expenses:Food: %v", err)
	}
	if foodCount != 1 {
		t.Errorf("Expenses:Food 应仍只有 1 条，实际 %d 条", foodCount)
	}
}

func TestImportSelfHealDoesNotOverwriteExistingParent(t *testing.T) {
	store, conn, ledgerID, ownerID := newImportParentFixture(t)

	const foodUUID = "uuid-ow-food"
	const otherUUID = "uuid-ow-other"
	const diningUUID = "uuid-ow-dining"
	mustInsert := func(uuidStr, name, parentUUID string) {
		t.Helper()
		var err error
		if parentUUID == "" {
			_, err = conn.Exec(
				`INSERT INTO accounts(ledger_id, uuid, name, type, open_date) VALUES(?,?,?,'Expenses','2026-01-01')`,
				ledgerID, uuidStr, name,
			)
		} else {
			_, err = conn.Exec(
				`INSERT INTO accounts(ledger_id, uuid, name, type, open_date, parent_uuid) VALUES(?,?,?,'Expenses','2026-01-01',?)`,
				ledgerID, uuidStr, name, parentUUID,
			)
		}
		if err != nil {
			t.Fatalf("预置 %s: %v", name, err)
		}
	}
	mustInsert(foodUUID, "Expenses:Food", "")
	mustInsert(otherUUID, "Expenses:Other", "")
	// Dining 已被人为挂到 Expenses:Other 下（非空）——自愈不得覆盖。
	mustInsert(diningUUID, "Expenses:Food:Dining", otherUUID)

	parsed, perr := beancount.Parse(importSelfHealBeancount)
	if perr != nil {
		t.Fatalf("解析 beancount: %v", perr)
	}
	if _, err := store.ImportBeancountToLedger(
		ledgerID, ownerID, parsed, ImportTargetCurrent, "batch-heal-2",
	); err != nil {
		t.Fatalf("导入失败: %v", err)
	}

	if got := parentUUIDOf(t, conn, ledgerID, "Expenses:Food:Dining"); got != otherUUID {
		t.Errorf("已设置的父关系不应被覆盖：期望仍为 %s，实际 %q", otherUUID, got)
	}
	// 未生效 → 不应写 update。
	if n := countSyncUpdates(t, conn, ledgerID, diningUUID); n != 0 {
		t.Errorf("parent_uuid 非空时不应写 sync_log update，实际 %d 条", n)
	}
}

func TestImportSelfHealWritesSyncLogOnceAndIsIdempotent(t *testing.T) {
	store, conn, ledgerID, ownerID := newImportParentFixture(t)

	const foodUUID = "uuid-sync-food"
	const diningUUID = "uuid-sync-dining"
	if _, err := conn.Exec(
		`INSERT INTO accounts(ledger_id, uuid, name, type, open_date) VALUES(?,?,'Expenses:Food','Expenses','2026-01-01')`,
		ledgerID, foodUUID,
	); err != nil {
		t.Fatalf("预置 Expenses:Food: %v", err)
	}
	if _, err := conn.Exec(
		`INSERT INTO accounts(ledger_id, uuid, name, type, open_date) VALUES(?,?,'Expenses:Food:Dining','Expenses','2026-01-01')`,
		ledgerID, diningUUID,
	); err != nil {
		t.Fatalf("预置 Expenses:Food:Dining: %v", err)
	}

	importOnce := func(batch string) {
		t.Helper()
		parsed, perr := beancount.Parse(importSelfHealBeancount)
		if perr != nil {
			t.Fatalf("解析 beancount: %v", perr)
		}
		if _, err := store.ImportBeancountToLedger(
			ledgerID, ownerID, parsed, ImportTargetCurrent, batch,
		); err != nil {
			t.Fatalf("导入失败（%s）: %v", batch, err)
		}
	}

	// 第一次：parent_uuid 为空 → 自愈生效 → 写一条 update。
	importOnce("batch-sync-1")
	if got := parentUUIDOf(t, conn, ledgerID, "Expenses:Food:Dining"); got != foodUUID {
		t.Fatalf("首次导入后 parent_uuid 应为 %s，实际 %q", foodUUID, got)
	}
	if n := countSyncUpdates(t, conn, ledgerID, diningUUID); n != 1 {
		t.Fatalf("自愈生效时应写 1 条 sync_log update，实际 %d 条", n)
	}

	// 第二次：parent_uuid 已非空 → 幂等，不再写 update。
	importOnce("batch-sync-2")
	if n := countSyncUpdates(t, conn, ledgerID, diningUUID); n != 1 {
		t.Errorf("parent_uuid 已非空时不应重复写 update，实际 %d 条", n)
	}
}
