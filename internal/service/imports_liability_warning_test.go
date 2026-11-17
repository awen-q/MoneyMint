package service

import (
	"strings"
	"testing"

	"familyledger/internal/repository"
)

// TestImportPreviewLiabilityPositiveWarning 验证导入预检的「负债正余额」警告：
//   - 负债账户分录为正（+100）→ Warnings 非空，message 含「疑似符号方向」；
//   - 警告只提示不阻断（Valid 不受影响、不进 Conflicts）；
//   - 正常负数分录（欠款记负）不产生警告；
//   - 结合既有 DB 余额：负债账户已有 -100，再导入 +150 → 导入后 +50 → 警告；
//     再导入 +50（导入后恰为 0）→ 不警告；
//   - 账户在文件中新建（DB 无该账户）同样检查。
func TestImportPreviewLiabilityPositiveWarning(t *testing.T) {
	conn := openTestDB(t)
	owner := insertUser(t, conn, "importer", false)
	ledgerID := insertLedger(t, conn, owner, "HolderLedger")
	svc := New(repository.New(conn))

	// ① 负债分录为正（Liabilities:Card 为文件新建账户）：应警告。
	const positiveText = `option "title" "负债符号测试"

2024-01-01 commodity CNY

2024-01-01 open Assets:Cash
2024-01-01 open Liabilities:Card

2024-02-01 * "信用卡欠款被录成正数"
  Liabilities:Card 100 CNY
  Assets:Cash -100 CNY
`
	prev, err := svc.PreviewImport(ledgerID, owner, positiveText, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("PreviewImport: %v", err)
	}
	if len(prev.Warnings) == 0 {
		t.Fatalf("负债账户导入后余额为正应产生警告，实际 %+v", prev)
	}
	found := false
	for _, w := range prev.Warnings {
		if strings.Contains(w.Message, "疑似符号方向") {
			found = true
		}
		if w.Account != "Liabilities:Card" {
			t.Fatalf("警告账户应为 Liabilities:Card，实际 %q", w.Account)
		}
		if w.Line == 0 {
			t.Fatalf("警告应携带源文件行号，实际 line=0")
		}
	}
	if !found {
		t.Fatalf("警告 message 应含「疑似符号方向」，实际 %+v", prev.Warnings)
	}
	if !prev.Valid {
		t.Fatalf("警告不应阻断导入（Valid 应为 true），冲突 %+v", prev.Conflicts)
	}
	if len(prev.Conflicts) != 0 {
		t.Fatalf("警告不应进 Conflicts，实际 %+v", prev.Conflicts)
	}

	// ② 正常负数分录（欠款记负）：不产生警告。
	const negativeText = `option "title" "负债符号测试"

2024-01-01 commodity CNY

2024-01-01 open Assets:Cash
2024-01-01 open Liabilities:Card

2024-02-01 * "正常刷卡记账"
  Liabilities:Card -100 CNY
  Assets:Cash 100 CNY
`
	prev2, err := svc.PreviewImport(ledgerID, owner, negativeText, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("PreviewImport(负数): %v", err)
	}
	if len(prev2.Warnings) != 0 {
		t.Fatalf("负数分录不应产生警告，实际 %+v", prev2.Warnings)
	}

	// ③ 结合既有 DB 余额：先导入正常负数版本（负债 -100），
	//    再预检 +150 → 导入后 +50 → 警告；+50 → 导入后 0 → 不警告。
	if _, err := svc.ExecuteImport(ledgerID, owner, negativeText, repository.ImportTargetCurrent); err != nil {
		t.Fatalf("导入正常版本: %v", err)
	}
	const overText = `2024-03-01 * "多还再刷回正"
  Liabilities:Card 150 CNY
  Assets:Cash -150 CNY
`
	prev3, err := svc.PreviewImport(ledgerID, owner, overText, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("PreviewImport(叠加正数): %v", err)
	}
	if len(prev3.Warnings) == 0 {
		t.Fatalf("既有 -100 + 本次 +150 = +50 应产生警告")
	}
	if !strings.Contains(prev3.Warnings[0].Message, "疑似符号方向") {
		t.Fatalf("叠加警告 message 应含「疑似符号方向」，实际 %q", prev3.Warnings[0].Message)
	}
	const flatText = `2024-03-01 * "补足至零"
  Liabilities:Card 50 CNY
  Assets:Cash -50 CNY
`
	prev4, err := svc.PreviewImport(ledgerID, owner, flatText, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("PreviewImport(补足至零): %v", err)
	}
	if len(prev4.Warnings) != 0 {
		t.Fatalf("导入后余额为 0 不应警告，实际 %+v", prev4.Warnings)
	}
}

// TestImportPreviewLiabilityWarningTargetNewAndMultiCurrency 补边界：
//   - target=new：跳过既有 DB 余额叠加（目标账本尚不存在），只按本次分录判断；
//   - 多币种混合：负币种不警告、正币种才警告（逐币种独立判断）。
func TestImportPreviewLiabilityWarningTargetNewAndMultiCurrency(t *testing.T) {
	conn := openTestDB(t)
	owner := insertUser(t, conn, "importer2", false)
	ledgerID := insertLedger(t, conn, owner, "TargetNewLedger")
	svc := New(repository.New(conn))

	// ① 先往当前账本导入正数版本，使 Liabilities:Card 既有 DB 余额为 +100。
	const positiveText = `option "title" "负债符号测试"
2024-01-01 commodity CNY
2024-01-01 open Assets:Cash
2024-01-01 open Liabilities:Card
2024-02-01 * "信用卡欠款被录成正数"
  Liabilities:Card 100 CNY
  Assets:Cash -100 CNY
`
	if _, err := svc.ExecuteImport(ledgerID, owner, positiveText, repository.ImportTargetCurrent); err != nil {
		t.Fatalf("导入正数版本: %v", err)
	}

	// ② target=current 预检 -50：DB 叠加后 +50 → 应警告（对照组，验证 DB 余额确实存在）。
	const partialText = `2024-03-01 * "只还一半"
  Liabilities:Card -50 CNY
  Assets:Cash 50 CNY
`
	prevCur, err := svc.PreviewImport(ledgerID, owner, partialText, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("PreviewImport(current): %v", err)
	}
	if len(prevCur.Warnings) == 0 {
		t.Fatalf("target=current 既有 +100 + 本次 -50 = +50 应产生警告")
	}

	// ③ 同一文件改 target=new：跳过 DB 叠加，-50 为负 → 不应警告。
	prevNew, err := svc.PreviewImport(ledgerID, owner, partialText, repository.ImportTargetNew)
	if err != nil {
		t.Fatalf("PreviewImport(new): %v", err)
	}
	if len(prevNew.Warnings) != 0 {
		t.Fatalf("target=new 不应叠加既有 DB 余额，实际 %+v", prevNew.Warnings)
	}

	// ④ 多币种混合：CNY 记负（欠款，正常）+ USD 记正（方向反了）→ 仅 USD 告警。
	const multiText = `option "title" "多币种负债"
2024-01-01 commodity CNY
2024-01-01 commodity USD
2024-01-01 open Assets:Cash
2024-01-01 open Liabilities:Card
2024-02-01 * "CNY 正常欠款 + USD 方向填反"
  Liabilities:Card -100 CNY
  Assets:Cash 100 CNY
  Liabilities:Card 200 USD
  Assets:Cash -200 USD
`
	prevMulti, err := svc.PreviewImport(ledgerID, owner, multiText, repository.ImportTargetCurrent)
	if err != nil {
		t.Fatalf("PreviewImport(多币种): %v", err)
	}
	if len(prevMulti.Warnings) != 1 {
		t.Fatalf("多币种混合应恰好产生 1 条警告（仅 USD），实际 %+v", prevMulti.Warnings)
	}
	if !strings.Contains(prevMulti.Warnings[0].Message, "USD") {
		t.Fatalf("警告应针对 USD，实际 %q", prevMulti.Warnings[0].Message)
	}
	if !prevMulti.Valid || len(prevMulti.Conflicts) != 0 {
		t.Fatalf("警告不应阻断导入，Valid=%v Conflicts=%+v", prevMulti.Valid, prevMulti.Conflicts)
	}
}
