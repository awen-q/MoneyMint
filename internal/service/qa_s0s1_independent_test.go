package service

// QA 独立回归测试（第二层质量关卡，与工程师自写用例刻意采用不同构造角度）：
//
//   - A-01 / A-02 / AC-5.2：用「真实 SyncPush 请求」证明分拣表里的
//     {OpUpdate, EntityTransaction} 分支确实可达（不是只看代码里有这行）；
//     直接查 sync_log 行数证明该分支不写日志；校验 loadEntity 的 pull payload
//     空 reversed_by 不输出、can_edit / created_by id 绝不出现。
//   - AC-1.3 快照失败：底层注入英文 SQLite 报错，断言用户可见 error 为纯中文
//     （回归 fmt.Errorf("%w") 把英文原文拼进 error 的修复），且「数据一行未变」
//     用全表快照对比而非仅看 deleted_at。
//
// 本文件只新增测试，不改任何产品代码。

import (
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"testing"

	"familyledger/internal/domain"
	"familyledger/internal/repository"
)

// qaSyncEnv 构造一份独立的临时库：注册 owner（自动建默认账本 id=1 + 种子账户），
// 再创建一笔真实交易，返回其 uuid 供 push / pull 使用。
func qaSyncEnv(t *testing.T) (*Service, *sql.DB, int64, string, int64) {
	t.Helper()
	conn := openTestDB(t)
	svc := New(repository.New(conn))
	res, err := svc.Register("qa-sync-owner", "secret123", "QA")
	if err != nil {
		t.Fatalf("注册 owner: %v", err)
	}
	uid := res.User.ID
	const lid = int64(1)

	cash, err := svc.CreateAccount(lid, "Assets:QA:Cash", "", "Assets", "2026-11-01", "CNY", "", "", "", "")
	if err != nil {
		t.Fatalf("建资产账户: %v", err)
	}
	food, err := svc.CreateAccount(lid, "Expenses:QA:Food", "", "Expenses", "2026-11-01", "CNY", "", "", "", "")
	if err != nil {
		t.Fatalf("建支出账户: %v", err)
	}
	if _, err := svc.CreateTransaction(lid, "2026-11-02", "*", "QA早餐", []PostingInput{
		{AccountID: cash.ID, Commodity: "CNY", Amount: "-12.50"},
		{AccountID: food.ID, Commodity: "CNY", Amount: "12.50"},
	}, uid); err != nil {
		t.Fatalf("记一笔: %v", err)
	}
	var uuid string
	if err := conn.QueryRow(`SELECT uuid FROM transactions WHERE ledger_id=? ORDER BY id LIMIT 1`, lid).Scan(&uuid); err != nil {
		t.Fatalf("读取交易 uuid: %v", err)
	}
	return svc, conn, lid, uuid, uid
}

func qaSyncLogCount(t *testing.T, conn *sql.DB, lid int64) int {
	t.Helper()
	var n int
	if err := conn.QueryRow(`SELECT count(*) FROM sync_log WHERE ledger_id=?`, lid).Scan(&n); err != nil {
		t.Fatalf("查 sync_log: %v", err)
	}
	return n
}

func qaPushUpdate(t *testing.T, svc *Service, lid, uid int64, entity string) PushResultOut {
	t.Helper()
	out, err := svc.SyncPush(lid, uid, PushRequest{
		ClientID: "qa-independent",
		Changes: []PushChange{{
			EntityType: domain.EntityTransaction,
			Op:         domain.OpUpdate,
			Entity:     json.RawMessage(entity),
		}},
	})
	if err != nil {
		t.Fatalf("SyncPush 返回错误: %v", err)
	}
	if len(out.Results) != 1 {
		t.Fatalf("期望 1 条逐条结果，实际 %d", len(out.Results))
	}
	return out
}

// TestQA_A01_UpdateBranchReachable 用真实 push 请求证明 A-01 分支可达、
// 标记落库、不写 sync_log、重复推送幂等，且 pull 下发 reversed_by。
func TestQA_A01_UpdateBranchReachable(t *testing.T) {
	svc, conn, lid, uuid, uid := qaSyncEnv(t)
	before := qaSyncLogCount(t, conn, lid)

	entity := `{"uuid":"` + uuid + `","reversed_by":"rev-qa-1"}`
	out := qaPushUpdate(t, svc, lid, uid, entity)
	r := out.Results[0]
	if r.Status != "ok" || !r.Accepted {
		t.Fatalf("A-01 分支应可达且接受（证明分拣表含 {OpUpdate,EntityTransaction}），实际 status=%q accepted=%v err=%q",
			r.Status, r.Accepted, r.Error)
	}

	var marked string
	if err := conn.QueryRow(`SELECT COALESCE(reversed_by,'') FROM transactions WHERE ledger_id=? AND uuid=?`, lid, uuid).Scan(&marked); err != nil {
		t.Fatal(err)
	}
	if marked != "rev-qa-1" {
		t.Fatalf("reversed_by 应落库为 rev-qa-1，实际 %q", marked)
	}
	if got := qaSyncLogCount(t, conn, lid); got != before {
		t.Fatalf("A-01 分支不应写 sync_log：before=%d after=%d", before, got)
	}

	// 重复推送幂等：不报错、accepted=false、仍不写 sync_log。
	dup := qaPushUpdate(t, svc, lid, uid, entity)
	if dup.Results[0].Status != "ok" || dup.Results[0].Accepted {
		t.Fatalf("重复推送应幂等跳过（ok + accepted=false），实际 %+v", dup.Results[0])
	}
	if got := qaSyncLogCount(t, conn, lid); got != before {
		t.Fatalf("重复推送不应写 sync_log：before=%d after=%d", before, got)
	}

	// A-02：pull 的 transaction payload 实时 loadEntity，非空 reversed_by 才输出。
	pull, err := svc.SyncPull(lid, 0, "qa-independent")
	if err != nil {
		t.Fatalf("SyncPull: %v", err)
	}
	var payload map[string]any
	found := false
	for _, c := range pull.Changes {
		if c.EntityType != domain.EntityTransaction {
			continue
		}
		var head struct{ UUID string `json:"uuid"` }
		_ = json.Unmarshal(c.Entity, &head)
		if head.UUID != uuid {
			continue
		}
		found = true
		if err := json.Unmarshal(c.Entity, &payload); err != nil {
			t.Fatalf("解析 pull payload: %v", err)
		}
	}
	if !found {
		t.Fatal("pull 未返回该交易的变更")
	}
	if payload["reversed_by"] != "rev-qa-1" {
		t.Fatalf("pull payload 应带 reversed_by=rev-qa-1，实际 %v", payload["reversed_by"])
	}
}

// TestQA_A01_RejectsOtherFields 带其它字段（description / amount / date）必须拒绝，
// reversed_by 为空也必须拒绝；任何拒绝都不得改动数据、不得写 sync_log。
func TestQA_A01_RejectsOtherFields(t *testing.T) {
	svc, conn, lid, uuid, uid := qaSyncEnv(t)
	before := qaSyncLogCount(t, conn, lid)

	cases := []struct {
		name   string
		entity string
		want   string
	}{
		{"夹带 description", `{"uuid":"` + uuid + `","reversed_by":"rev-x","description":"篡改"}`, "description"},
		{"夹带 amount", `{"uuid":"` + uuid + `","reversed_by":"rev-x","amount":"999.00"}`, "amount"},
		{"夹带 postings", `{"uuid":"` + uuid + `","reversed_by":"rev-x","postings":[]}`, "postings"},
		{"reversed_by 为空", `{"uuid":"` + uuid + `","reversed_by":""}`, "非空"},
		{"缺 reversed_by", `{"uuid":"` + uuid + `"}`, "非空"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := qaPushUpdate(t, svc, lid, uid, tc.entity)
			r := out.Results[0]
			if r.Status != "error" {
				t.Fatalf("应拒绝，实际 status=%q accepted=%v", r.Status, r.Accepted)
			}
			if !strings.Contains(r.Error, "reversed_by") && !strings.Contains(r.Error, tc.want) {
				t.Fatalf("拒绝原因应可读且指向 reversed_by/非法字段，实际 %q", r.Error)
			}
			var marked string
			if err := conn.QueryRow(`SELECT COALESCE(reversed_by,'') FROM transactions WHERE ledger_id=? AND uuid=?`, lid, uuid).Scan(&marked); err != nil {
				t.Fatal(err)
			}
			if marked != "" {
				t.Fatalf("被拒绝的 update 不得改动数据，reversed_by=%q", marked)
			}
			if got := qaSyncLogCount(t, conn, lid); got != before {
				t.Fatalf("被拒绝的 update 不得写 sync_log：before=%d after=%d", before, got)
			}
		})
	}
}

// TestQA_A02_EmptyReversedByNotEmitted 空值不输出，且 pull 实体绝不出现
// can_edit / created_by（AC-5.2：权限只加在在线 TransactionView）。
func TestQA_A02_EmptyReversedByNotEmitted(t *testing.T) {
	svc, _, lid, uuid, _ := qaSyncEnv(t)
	pull, err := svc.SyncPull(lid, 0, "qa-empty")
	if err != nil {
		t.Fatalf("SyncPull: %v", err)
	}
	found := false
	for _, c := range pull.Changes {
		if c.EntityType != domain.EntityTransaction {
			continue
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(c.Entity, &m); err != nil {
			t.Fatal(err)
		}
		var head struct{ UUID string `json:"uuid"` }
		_ = json.Unmarshal(c.Entity, &head)
		if head.UUID != uuid {
			continue
		}
		found = true
		if _, ok := m["reversed_by"]; ok {
			t.Fatalf("空 reversed_by 不应出现在 pull payload，实际 %s", string(c.Entity))
		}
		for _, forbidden := range []string{"can_edit", "can_restore", "created_by", "user_id"} {
			if _, ok := m[forbidden]; ok {
				t.Fatalf("pull 实体不应出现 %s（权限只加在线视图），实际 %s", forbidden, string(c.Entity))
			}
		}
		// created_by_name 是既有允许字段，用它确认 payload 确实是 transaction 实体。
		if _, ok := m["postings"]; !ok {
			t.Fatalf("pull 实体应含 postings，实际 %s", string(c.Entity))
		}
	}
	if !found {
		t.Fatal("pull 未返回该交易的变更")
	}
}

// TestQA_NoNewOpType 不新增同步 op 类型、不升协议版本：
// 既有四种 op 取值不变；任何未登记的 op 都不会被分拣表执行
// （静默忽略、不写 sync_log、不改动数据），不会意外扩展同步语义。
func TestQA_NoNewOpType(t *testing.T) {
	svc, conn, lid, uuid, uid := qaSyncEnv(t)
	if domain.OpCreate != "create" || domain.OpDelete != "delete" ||
		domain.OpClose != "close" || domain.OpUpdate != "update" {
		t.Fatal("既有 op 取值被改动，疑似升协议版本")
	}
	before := qaSyncLogCount(t, conn, lid)
	out, err := svc.SyncPush(lid, uid, PushRequest{ClientID: "qa-op", Changes: []PushChange{{
		EntityType: domain.EntityTransaction,
		Op:         "merge",
		Entity:     json.RawMessage(`{"uuid":"` + uuid + `","reversed_by":"rev-x"}`),
	}}})
	if err != nil {
		t.Fatalf("SyncPush: %v", err)
	}
	// 分拣表只登记既有四种 op：非法 op 不会进入 apply，也不产生任何逐条结果。
	if len(out.Results) != 0 || out.Accepted != 0 {
		t.Fatalf("非法 op 不应被执行，实际 results=%+v accepted=%d", out.Results, out.Accepted)
	}
	var marked string
	if err := conn.QueryRow(`SELECT COALESCE(reversed_by,'') FROM transactions WHERE ledger_id=? AND uuid=?`, lid, uuid).Scan(&marked); err != nil {
		t.Fatal(err)
	}
	if marked != "" {
		t.Fatalf("非法 op 不得改动数据，reversed_by=%q", marked)
	}
	if got := qaSyncLogCount(t, conn, lid); got != before {
		t.Fatalf("非法 op 不得写 sync_log：%d -> %d", before, got)
	}
}

// qaLedgerRows 读取账本表全量快照，用于「数据一行未变」的严格对比。
func qaLedgerRows(t *testing.T, conn *sql.DB) string {
	t.Helper()
	rows, err := conn.Query(`SELECT id, name, COALESCE(default_commodity,''), COALESCE(deleted_at,'') FROM ledgers ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var sb strings.Builder
	for rows.Next() {
		var id int64
		var name, commodity, deleted string
		if err := rows.Scan(&id, &name, &commodity, &deleted); err != nil {
			t.Fatal(err)
		}
		sb.WriteString(jsonNumber(id) + "|" + name + "|" + commodity + "|" + deleted + "\n")
	}
	return sb.String()
}

func jsonNumber(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func qaCount(t *testing.T, conn *sql.DB, table string) int {
	t.Helper()
	var n int
	if err := conn.QueryRow(`SELECT count(*) FROM ` + table).Scan(&n); err != nil {
		t.Fatalf("查 %s 行数: %v", table, err)
	}
	return n
}

var qaASCIIRe = regexp.MustCompile(`[A-Za-z]`)

// TestQA_SnapshotFailureChineseOnly 回归 fmt.Errorf("%w") 修复：
// 底层英文 SQLite 错误只进日志，用户可见 error 必须纯中文，且数据一行未变。
func TestQA_SnapshotFailureChineseOnly(t *testing.T) {
	conn := openTestDB(t)
	svc := New(repository.New(conn))
	owner := insertUser(t, conn, "qa-owner", false)
	if _, err := svc.CreateLedger(owner, "装修", "CNY"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateLedger(owner, "家庭日常", "CNY"); err != nil {
		t.Fatal(err)
	}

	beforeRows := qaLedgerRows(t, conn)
	beforeTxn := qaCount(t, conn, "transactions")
	beforeAcc := qaCount(t, conn, "accounts")
	beforeSync := qaCount(t, conn, "sync_log")

	// 模拟真实备份失败：英文原文（正是修复前会被 %w 拼进用户 error 的内容）。
	svc.ConfigureSnapshot(func(trigger string) error {
		return errors.New("SQLITE_CANTOPEN: unable to open database file (14)")
	})

	err := svc.DeleteLedger(owner, 1)
	if err == nil {
		t.Fatal("快照失败应返回错误")
	}
	msg := err.Error()
	if qaASCIIRe.MatchString(msg) {
		t.Fatalf("用户可见 error 必须是纯中文，不得含英文原文，实际 %q", msg)
	}
	for _, leak := range []string{"SQLITE", "unable", "database", "disk", "VACUUM", "14"} {
		if strings.Contains(msg, leak) {
			t.Fatalf("用户可见 error 泄漏了底层英文/错误号 %q：%q", leak, msg)
		}
	}
	if !strings.Contains(msg, "快照") || !strings.Contains(msg, "未删除") {
		t.Fatalf("错误文案应说明「快照失败、账本未删除」，实际 %q", msg)
	}
	if !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("快照失败应保留 ErrInvalid 语义（400），实际 %v", err)
	}

	// 数据一行未变：账本全表快照 + 交易/账户/sync_log 行数均不变。
	if got := qaLedgerRows(t, conn); got != beforeRows {
		t.Fatalf("账本表发生了变化：\nbefore=%s\nafter =%s", beforeRows, got)
	}
	if got := qaCount(t, conn, "transactions"); got != beforeTxn {
		t.Fatalf("transactions 行数变化：%d -> %d", beforeTxn, got)
	}
	if got := qaCount(t, conn, "accounts"); got != beforeAcc {
		t.Fatalf("accounts 行数变化：%d -> %d", beforeAcc, got)
	}
	if got := qaCount(t, conn, "sync_log"); got != beforeSync {
		t.Fatalf("sync_log 行数变化：%d -> %d", beforeSync, got)
	}
}

// TestQA_EngineNilChineseOnly LEDGER_BACKUP_ENABLED=false（engine=nil，
// 未注入 snapshot）时同样给出纯中文错误且不动任何数据。
func TestQA_EngineNilChineseOnly(t *testing.T) {
	conn := openTestDB(t)
	svc := New(repository.New(conn)) // 刻意不调用 ConfigureSnapshot
	owner := insertUser(t, conn, "qa-owner2", false)
	if _, err := svc.CreateLedger(owner, "装修", "CNY"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateLedger(owner, "家庭日常", "CNY"); err != nil {
		t.Fatal(err)
	}
	beforeRows := qaLedgerRows(t, conn)

	err := svc.DeleteLedger(owner, 1)
	if err == nil {
		t.Fatal("未注入快照实现时应明确拒绝删除")
	}
	if qaASCIIRe.MatchString(err.Error()) {
		t.Fatalf("用户可见 error 必须是纯中文，实际 %q", err.Error())
	}
	if !strings.Contains(err.Error(), "备份") || !strings.Contains(err.Error(), "未删除") {
		t.Fatalf("错误文案应说明备份不可用且账本未删除，实际 %q", err.Error())
	}
	if got := qaLedgerRows(t, conn); got != beforeRows {
		t.Fatalf("账本表发生了变化：\nbefore=%s\nafter =%s", beforeRows, got)
	}
}
