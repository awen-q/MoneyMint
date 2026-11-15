package server

// AC-6.1（0.6.0 S5）：导入端点不再豁免账本上下文——
//
//   - 预检 / 执行 / 撤销三个导入端点都必须带 X-Ledger-Id 并通过账本成员校验；
//   - 非成员账本一律 403（middleware 的 /api/import 豁免分支已删除）；
//   - viewer 只读拦截同样适用于导入写端点（由 middleware 统一处理，此处不重复构造 viewer 场景）。
//
// 本文件只新增测试，不改任何产品代码。

import (
	"net/http"
	"strconv"
	"testing"
)

const importHTTPSampleText = `option "title" "导入"
2024-01-01 open Assets:Cash
2024-01-01 open Expenses:Food
2024-02-01 * "支出"
  Assets:Cash 100 CNY
  Expenses:Food -100 CNY
`

func TestImportRequiresLedgerContext(t *testing.T) {
	e := newQAServerEnv(t)
	ledger, err := e.svc.CreateLedger(e.userID, "ImportHolder", "")
	if err != nil {
		t.Fatalf("建账本: %v", err)
	}
	ledgerID := strconv.FormatInt(ledger.ID, 10)

	// 1) 带合法账本上下文 → 200（预检只读，不写库）。
	st, _, raw := e.do(http.MethodPost, "/api/import/beancount/preview?target=current",
		map[string]any{"text": importHTTPSampleText}, ledgerID, e.token)
	if st != http.StatusOK {
		t.Fatalf("合法账本上下文预检应 200，实际 %d: %s", st, raw)
	}

	// 2) 非成员账本 → 403：导入不再豁免账本上下文（AC-6.1）。
	st, _, raw = e.do(http.MethodPost, "/api/import/beancount/preview?target=current",
		map[string]any{"text": importHTTPSampleText}, "999999", e.token)
	if st != http.StatusForbidden {
		t.Fatalf("非成员账本导入预检应 403，实际 %d: %s", st, raw)
	}

	// 3) 执行同样受账本上下文约束。
	st, _, raw = e.do(http.MethodPost, "/api/import/beancount?target=current",
		map[string]any{"text": importHTTPSampleText}, "999999", e.token)
	if st != http.StatusForbidden {
		t.Fatalf("非成员账本导入执行应 403，实际 %d: %s", st, raw)
	}

	// 4) 撤销端点同样受账本上下文约束。
	st, _, raw = e.do(http.MethodPost, "/api/import/beancount/undo?batch_id=imp-x",
		nil, "999999", e.token)
	if st != http.StatusForbidden {
		t.Fatalf("非成员账本撤销应 403，实际 %d: %s", st, raw)
	}
}
