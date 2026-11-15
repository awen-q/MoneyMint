package service

import (
	"database/sql"
	"errors"
	"strings"
	"testing"

	"familyledger/internal/domain"
	"familyledger/internal/repository"
)

// TestValidateAccountNameTable C-03 表驱动：合法 / 非法账户全名。
func TestValidateAccountNameTable(t *testing.T) {
	cases := []struct {
		name   string
		atype  string
		wantOK bool
	}{
		{"Assets:Cash", "Assets", true},
		{"Expenses:Food", "Expenses", true},
		{"Expenses:Food:早饭", "Expenses", true},
		{"Expenses:1Food", "Expenses", true},
		{"Equity:Opening-Balances", "Equity", true},
		{"Expenses:餐饮", "Expenses", false},  // 第二段中文
		{"Expenses:food", "Expenses", false},  // 第二段小写开头
		{"餐饮::早餐", "Expenses", false},       // 根非法 + 空段
		{"Expenses:Food:", "Expenses", false}, // 末段为空
		{"Expenses: Foo", "Expenses", false},  // 段内空格
		{"assets:Cash", "Assets", false},      // 根小写
		{"Assets:Cash", "Expenses", false},    // 根与 type 不一致
		{"Assets", "Assets", false},           // 只有一段
		{"", "Assets", false},
	}
	for _, c := range cases {
		err := ValidateAccountName(c.name, c.atype)
		if c.wantOK {
			if err != nil {
				t.Fatalf("%q/%s 应合法，实际 %v", c.name, c.atype, err)
			}
			continue
		}
		if err == nil {
			t.Fatalf("%q/%s 应被拒绝", c.name, c.atype)
		}
		var ce *domain.CodedError
		if !errors.As(err, &ce) || ce.Code != domain.CodeAccountNameInvalid {
			t.Fatalf("%q 应返回 account_name_invalid，实际 %v", c.name, err)
		}
		if !errors.Is(err, domain.ErrInvalid) {
			t.Fatalf("%q 应保留 400 语义", c.name)
		}
	}
}

func seedAccountTestLedgers(t *testing.T, conn *sql.DB) (int64, int64) {
	t.Helper()
	owner := insertUser(t, conn, "acct-owner", false)
	res, err := conn.Exec(
		`INSERT INTO ledgers(name, owner_id, default_commodity) VALUES('账户测试账本', ?, 'CNY')`, owner)
	if err != nil {
		t.Fatal(err)
	}
	ledgerID, _ := res.LastInsertId()
	if _, err := conn.Exec(
		`INSERT INTO ledger_members(ledger_id, user_id, role, invited_by) VALUES(?, ?, 'owner', ?)`,
		ledgerID, owner, owner,
	); err != nil {
		t.Fatal(err)
	}
	res2, err := conn.Exec(
		`INSERT INTO ledgers(name, owner_id, default_commodity) VALUES('别的账本', ?, 'CNY')`, owner)
	if err != nil {
		t.Fatal(err)
	}
	otherID, _ := res2.LastInsertId()
	return ledgerID, otherID
}

// TestCreateAccountParentValidation D-04 / AC-2.2：父校验 5 类失败 + 成功路径。
// 传了非空 parent_uuid 校验失败必须拒绝，绝不静默忽略降级为根。
func TestCreateAccountParentValidation(t *testing.T) {
	conn := openTestDB(t)
	ledgerID, otherID := seedAccountTestLedgers(t, conn)
	svc := New(repository.New(conn))

	parent, err := svc.CreateAccount(ledgerID, "Expenses:Food", "餐饮", "Expenses", "", "", "", "", "", "")
	if err != nil {
		t.Fatalf("建父账户: %v", err)
	}

	// 成功：父子同类型、父未关闭。
	child, err := svc.CreateAccount(ledgerID, "Expenses:Food:Snack", "零食", "Expenses",
		"", "", "", "", parent.UUID, "")
	if err != nil {
		t.Fatalf("增加下级: %v", err)
	}
	if child.ParentUUID != parent.UUID {
		t.Fatalf("parent_uuid 应落库为 %s，实际 %s", parent.UUID, child.ParentUUID)
	}

	countAccounts := func() int {
		var n int
		if err := conn.QueryRow(`SELECT count(*) FROM accounts WHERE ledger_id=?`, ledgerID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	before := countAccounts()

	// ① 父不存在。
	_, err = svc.CreateAccount(ledgerID, "Expenses:Food:NoParent", "无父", "Expenses",
		"", "", "", "", "uuid-missing", "")
	var ce *domain.CodedError
	if !errors.As(err, &ce) || ce.Code != domain.CodeParentNotFound {
		t.Fatalf("父不存在应 parent_not_found，实际 %v", err)
	}

	// ② 父属于别的账本。
	otherParent, err := svc.CreateAccount(otherID, "Expenses:Other", "别账本", "Expenses", "", "", "", "", "", "")
	if err != nil {
		t.Fatalf("建跨账本父账户: %v", err)
	}
	_, err = svc.CreateAccount(ledgerID, "Expenses:Food:Cross", "跨账本", "Expenses",
		"", "", "", "", otherParent.UUID, "")
	if !errors.As(err, &ce) || ce.Code != domain.CodeParentNotFound {
		t.Fatalf("跨账本父应 parent_not_found，实际 %v", err)
	}

	// ③ 父类型不同。
	_, err = svc.CreateAccount(ledgerID, "Assets:Bank", "银行", "Assets",
		"", "", "", "", parent.UUID, "")
	if !errors.As(err, &ce) || ce.Code != domain.CodeParentTypeMismatch {
		t.Fatalf("父子类型不同应 parent_type_mismatch，实际 %v", err)
	}
	if !errors.Is(ce, domain.ErrConflict) || !strings.Contains(ce.Message, "类型不匹配") {
		t.Fatalf("类型不匹配应 409 + 中文原因，实际 %v", err)
	}

	// ④ 父已关闭（Beancount close）。
	if _, err := conn.Exec(
		`UPDATE accounts SET close_date='2026-11-01' WHERE uuid=?`, parent.UUID,
	); err != nil {
		t.Fatal(err)
	}
	_, err = svc.CreateAccount(ledgerID, "Expenses:Food:Closed", "父关闭", "Expenses",
		"", "", "", "", parent.UUID, "")
	if err == nil || !strings.Contains(err.Error(), "已关闭") {
		t.Fatalf("父已关闭应拒绝并给可读原因，实际 %v", err)
	}

	// ⑤ 父已软删。
	if _, err := conn.Exec(
		`UPDATE accounts SET close_date=NULL, deleted_at=datetime('now') WHERE uuid=?`, parent.UUID,
	); err != nil {
		t.Fatal(err)
	}
	_, err = svc.CreateAccount(ledgerID, "Expenses:Food:Deleted", "父软删", "Expenses",
		"", "", "", "", parent.UUID, "")
	if !errors.As(err, &ce) || ce.Code != domain.CodeParentNotFound {
		t.Fatalf("父已软删应 parent_not_found，实际 %v", err)
	}

	if after := countAccounts(); after != before {
		t.Fatalf("父校验失败不得落库：%d → %d", before, after)
	}
}

// TestCreateAccountNameExistsIncludingClosed C-04 / AC-2.4：
// 重名含已关闭账户，close 后不可重建同名。
func TestCreateAccountNameExistsIncludingClosed(t *testing.T) {
	conn := openTestDB(t)
	ledgerID, _ := seedAccountTestLedgers(t, conn)
	svc := New(repository.New(conn))

	cash, err := svc.CreateAccount(ledgerID, "Assets:Cash", "现金", "Assets", "", "", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteAccount(ledgerID, cash.UUID); err != nil {
		t.Fatalf("关户（余额为 0）: %v", err)
	}
	_, err = svc.CreateAccount(ledgerID, "Assets:Cash", "现金2", "Assets", "", "", "", "", "", "")
	var ce *domain.CodedError
	if !errors.As(err, &ce) || ce.Code != domain.CodeAccountNameExists {
		t.Fatalf("关闭后同名重建应 409 account_name_exists，实际 %v", err)
	}
	if !errors.Is(ce, domain.ErrConflict) {
		t.Fatal("重名应保留 409 语义")
	}
}
