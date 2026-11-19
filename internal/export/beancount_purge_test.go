package export

// B7 永久删除与导出的关系（AC-B7-1 及其反向断言）。
//
// 两条用例一起把「导出字节不变」的边界钉成文档化行为：
//
//  1. 普通交易（无冲正配对）：软删 → 永久删除 → 导出**逐字节相同**。
//     软删那一刻该行就已退出导出（导出按 deleted_at IS NULL 过滤），
//     永久删除只是把已经不可见的行物理清掉。
//  2. 被修改过、且冲正配对仍有效：软删 → 永久删除 → 导出**确实变化**，
//     且变化恰好是「冲正那一笔」。这是产品已裁定的连带语义（只删一半会让
//     账本净额错 / 留下永远无法编辑的孤儿冲正），不是缺陷。
//     若哪天有人把连带「优化」成只删种子，这条用例会红。

import (
	"database/sql"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"familyledger/internal/db"
	"familyledger/internal/repository"
)

// purgeExportEnv 是导出一致性用例的最小环境。
type purgeExportEnv struct {
	conn  *sql.DB
	store *repository.Store
}

// newPurgeExportEnv 建库并写入最小数据集（1 个账本、1 个币种、2 个账户）。
func newPurgeExportEnv(t *testing.T) *purgeExportEnv {
	t.Helper()
	conn, err := db.Open(
		filepath.Join(t.TempDir(), "export-purge.db"),
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
	mustExec(`INSERT INTO users(id, username, password_hash, display_name) VALUES(1,'export-u','x','甲')`)
	mustExec(`INSERT INTO ledgers(id, name, owner_id) VALUES(1,'导出账本',1)`)
	mustExec(`INSERT INTO commodities(ledger_id, uuid, symbol, name, precision)
	          VALUES(1,'cmd-cny','CNY','人民币',2)`)
	mustExec(`INSERT INTO accounts(id, ledger_id, uuid, name, type, open_date)
	          VALUES(1,1,'acc-cash','Assets:Cash:CNY','Assets','2026-01-01')`)
	mustExec(`INSERT INTO accounts(id, ledger_id, uuid, name, type, open_date)
	          VALUES(2,1,'acc-food','Expenses:Food','Expenses','2026-01-01')`)

	return &purgeExportEnv{conn: conn, store: repository.New(conn)}
}

// insertTxn 写一笔交易与两条分录，返回交易 id。
func (e *purgeExportEnv) insertTxn(
	t *testing.T, uuid, date, description, reversalOf, reversedBy, amount string,
) int64 {
	t.Helper()
	nilIf := func(s string) any {
		if s == "" {
			return nil
		}
		return s
	}
	res, err := e.conn.Exec(
		`INSERT INTO transactions(ledger_id, uuid, date, flag, description, reversal_of, reversed_by)
		 VALUES(1, ?, ?, '*', ?, ?, ?)`,
		uuid, date, description, nilIf(reversalOf), nilIf(reversedBy),
	)
	if err != nil {
		t.Fatalf("写入交易 %s: %v", uuid, err)
	}
	id, _ := res.LastInsertId()
	// 借贷两条：现金取负、支出取正（amount 传正数）。
	neg := strings.TrimPrefix(amount, "-")
	if _, err := e.conn.Exec(
		`INSERT INTO postings(transaction_id, account_id, commodity, amount, position)
		 VALUES(?, 1, 'CNY', ?, 0)`, id, "-"+neg); err != nil {
		t.Fatalf("写入分录 1（%s）: %v", uuid, err)
	}
	if _, err := e.conn.Exec(
		`INSERT INTO postings(transaction_id, account_id, commodity, amount, position)
		 VALUES(?, 2, 'CNY', ?, 1)`, id, neg); err != nil {
		t.Fatalf("写入分录 2（%s）: %v", uuid, err)
	}
	return id
}

// export 导出当前账本文本。
func (e *purgeExportEnv) export(t *testing.T) string {
	t.Helper()
	text, err := ExportLedger(e.conn, 1)
	if err != nil {
		t.Fatalf("导出: %v", err)
	}
	return text
}

// purge 走真实的仓储层永久删除（单笔模式）。
func (e *purgeExportEnv) purge(t *testing.T, uuid string) {
	t.Helper()
	if _, err := e.store.PurgeTransactions(repository.PurgeInput{
		LedgerID: 1, ActorID: 1, Seeds: []string{uuid}, Mode: repository.PurgeModeSingle,
	}); err != nil {
		t.Fatalf("永久删除 %s: %v", uuid, err)
	}
}

// softDelete 走真实的仓储层软删（回收站）。
func (e *purgeExportEnv) softDelete(t *testing.T, uuid string) {
	t.Helper()
	ok, err := e.store.SoftDeleteTransaction(1, uuid)
	if err != nil || !ok {
		t.Fatalf("软删 %s: ok=%v err=%v", uuid, ok, err)
	}
}

// TestPurgeKeepsExportBytes AC-B7-1：普通交易（无冲正配对）软删 → 永久删除，
// 导出文本**逐字节相同**。
func TestPurgeKeepsExportBytes(t *testing.T) {
	e := newPurgeExportEnv(t)
	e.insertTxn(t, "keep-1", "2026-02-01", "午饭", "", "", "10.00")
	e.insertTxn(t, "to-delete", "2026-02-02", "待删的支出", "", "", "25.00")

	// 软删前：两笔都在导出里（作为对照，避免「导出本来就是空串」这种假通过）。
	beforeSoftDelete := e.export(t)
	if !strings.Contains(beforeSoftDelete, "待删的支出") {
		t.Fatalf("软删前导出应含待删交易: %q", beforeSoftDelete)
	}

	e.softDelete(t, "to-delete")
	afterSoftDelete := e.export(t)
	if strings.Contains(afterSoftDelete, "待删的支出") {
		t.Fatalf("软删后导出不应含该交易: %q", afterSoftDelete)
	}

	e.purge(t, "to-delete")
	afterPurge := e.export(t)
	if afterPurge != afterSoftDelete {
		t.Fatalf("AC-B7-1 失败：永久删除普通交易后导出字节应完全相同\n--- 软删后 ---\n%s\n--- 永久删除后 ---\n%s",
			afterSoftDelete, afterPurge)
	}
	// 剩下的交易仍在（证明比较的不是两份空串）。
	if !strings.Contains(afterPurge, "午饭") {
		t.Fatalf("另一笔交易必须仍在导出里: %q", afterPurge)
	}
}

// TestPurgeChangesExportWhenPairAlive 反向断言：被修改过且冲正配对仍有效时，
// 永久删除会连带删掉冲正交易 → 导出确实变化，且差异恰好是那一笔。
func TestPurgeChangesExportWhenPairAlive(t *testing.T) {
	e := newPurgeExportEnv(t)
	e.insertTxn(t, "keep-1", "2026-02-01", "午饭", "", "", "10.00")
	// A：被修改过的原交易（金额 100，已失效）→ 软删进回收站。
	e.insertTxn(t, "orig", "2026-02-03", "早餐", "", "reversal", "100.00")
	// R：冲正交易（金额 -100，仍有效）。
	e.insertTxn(t, "reversal", "2026-02-03", "冲正: 早餐", "orig", "", "100.00")

	e.softDelete(t, "orig")
	before := e.export(t)
	if strings.Contains(before, `"早餐"`) {
		t.Fatalf("软删后的原交易不应出现在导出里: %q", before)
	}
	if !strings.Contains(before, "冲正: 早餐") {
		t.Fatalf("软删后冲正交易仍应有效并出现在导出里: %q", before)
	}

	e.purge(t, "orig")
	after := e.export(t)

	if after == before {
		t.Fatalf("配对成员仍有效时永久删除必须改变导出（连带删除冲正交易），实际字节相同:\n%s", after)
	}
	if strings.Contains(after, "冲正: 早餐") {
		t.Fatalf("连带删除后冲正交易不应再出现在导出里:\n%s", after)
	}
	if !strings.Contains(after, "午饭") {
		t.Fatalf("与闭包无关的交易不得受牵连: %q", after)
	}

	// 差异必须**只**来自冲正那笔：把 before 中属于冲正的 3 行（头 + 2 条分录）摘掉，
	// 剩下的内容应与 after 完全相同。
	removed, kept := diffLines(before, after)
	if len(removed) != 3 {
		t.Fatalf("差异应恰为冲正交易的 3 行（头 + 2 分录），实际移除 %d 行：%v", len(removed), removed)
	}
	for _, line := range removed {
		if !strings.Contains(line, "冲正: 早餐") && !strings.Contains(line, "100.00") {
			t.Fatalf("差异行不属于冲正交易: %q（全部差异 %v）", line, removed)
		}
	}
	if len(kept) != 0 {
		t.Fatalf("永久删除不应新增任何导出行，实际新增：%v", kept)
	}
}

// diffLines 返回「before 有、after 没有」与「after 有、before 没有」的行（多重集差）。
// 空白行不参与比较：块间空行随交易增减而变化，不是「内容」。
func diffLines(before, after string) (removed, added []string) {
	count := func(text string) map[string]int {
		out := map[string]int{}
		for _, line := range strings.Split(text, "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			out[line]++
		}
		return out
	}
	beforeLines, afterLines := count(before), count(after)
	for line, n := range beforeLines {
		for i := 0; i < n-afterLines[line]; i++ {
			removed = append(removed, line)
		}
	}
	for line, n := range afterLines {
		for i := 0; i < n-beforeLines[line]; i++ {
			added = append(added, line)
		}
	}
	sort.Strings(removed)
	sort.Strings(added)
	return removed, added
}
