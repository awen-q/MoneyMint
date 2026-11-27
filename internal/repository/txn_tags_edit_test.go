package repository

import (
	"database/sql"
	"errors"
	"regexp"
	"testing"

	"familyledger/internal/domain"
)

// seedTagEditFixture 建立标签仓储单测所需的最小数据集（用户 / 账本 / 账户 / 一笔带标签交易）。
func seedTagEditFixture(t *testing.T, conn *sql.DB) {
	t.Helper()
	for _, q := range []string{
		`INSERT INTO users(id, username, password_hash, display_name) VALUES(1,'tag-u','x','张三')`,
		`INSERT INTO ledgers(id, name, owner_id) VALUES(1,'标签测试账本',1)`,
		`INSERT INTO accounts(id, ledger_id, uuid, name, type, open_date)
		 VALUES(1,1,'acc-cash','Assets:Cash','Assets','2026-01-01')`,
		`INSERT INTO transactions(id, ledger_id, uuid, date, flag, description, tags)
		 VALUES(1,1,'txn-1','2026-03-01','*','午餐','["餐饮"]')`,
	} {
		if _, err := conn.Exec(q); err != nil {
			t.Fatalf("插入测试数据失败: %v\nSQL: %s", err, q)
		}
	}
}

func tagEditCount(t *testing.T, conn *sql.DB, q string, args ...any) int {
	t.Helper()
	var n int
	if err := conn.QueryRow(q, args...).Scan(&n); err != nil {
		t.Fatalf("查询 %q: %v", q, err)
	}
	return n
}

var tagEditTSRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)

// TestUpdateTagsTx_CASAndAtomicWrites 事务内 CAS 终审 + UPDATE + 审计 + sync_log 同事务；
// 同时锁定「只改 tags / tags_updated_at，uuid 不变，绝不 INSERT 交易、不写 reversed_by」。
func TestUpdateTagsTx_CASAndAtomicWrites(t *testing.T) {
	conn := openReversalTestDB(t)
	seedTagEditFixture(t, conn)
	store := New(conn)

	// CAS 不一致：返回结构化 TagsConflict，不产生任何写入。
	_, err := store.UpdateTagsTx(TagsUpdateInput{
		LedgerID: 1, EntityUUID: "txn-1",
		Tags: []string{"晚餐"}, BaseTags: []string{"不存在"}, ActorID: 1,
	})
	var conflict *TagsConflict
	if !errors.As(err, &conflict) {
		t.Fatalf("CAS 失败应返回 TagsConflict，实际 %v", err)
	}
	if len(conflict.CurrentTags) != 1 || conflict.CurrentTags[0] != "餐饮" {
		t.Fatalf("冲突应回带当前标签，实际 %+v", conflict.CurrentTags)
	}
	if n := tagEditCount(t, conn, `SELECT count(*) FROM tag_edit_log`); n != 0 {
		t.Fatalf("CAS 失败不应写审计，实际 %d", n)
	}
	if n := tagEditCount(t, conn, `SELECT count(*) FROM sync_log`); n != 0 {
		t.Fatalf("CAS 失败不应写 sync_log，实际 %d", n)
	}

	// base_tags 带空白/重复/乱序：规范化后与当前一致，不应误判冲突。
	res, err := store.UpdateTagsTx(TagsUpdateInput{
		LedgerID: 1, EntityUUID: "txn-1",
		Tags: []string{"晚餐"}, BaseTags: []string{" 餐饮 ", "餐饮", ""},
		ActorID: 1, DeviceID: "dev-repo",
	})
	if err != nil {
		var tc *TagsConflict
		if errors.As(err, &tc) {
			t.Fatalf("规范化后 CAS 应通过: %v; current=%q ts=%q", err, tc.CurrentTags, tc.CurrentTagsUpdatedAt)
		}
		t.Fatalf("规范化后 CAS 应通过: %v", err)
	}
	if res.UUID != "txn-1" || len(res.Tags) != 1 || res.Tags[0] != "晚餐" || res.EditID <= 0 {
		t.Fatalf("结果不符: %+v", res)
	}
	if !tagEditTSRE.MatchString(res.TagsUpdatedAt) {
		t.Fatalf("tags_updated_at 格式不符: %q", res.TagsUpdatedAt)
	}

	var tagsRaw, tagsUpdatedAt, reversedBy string
	if err := conn.QueryRow(
		`SELECT COALESCE(tags,''), COALESCE(tags_updated_at,''), COALESCE(reversed_by,'')
		 FROM transactions WHERE uuid='txn-1'`,
	).Scan(&tagsRaw, &tagsUpdatedAt, &reversedBy); err != nil {
		t.Fatalf("回读交易: %v", err)
	}
	if tagsRaw != `["晚餐"]` || tagsUpdatedAt != res.TagsUpdatedAt || reversedBy != "" {
		t.Fatalf("落库不符: tags=%s ts=%s reversed_by=%s", tagsRaw, tagsUpdatedAt, reversedBy)
	}
	if n := tagEditCount(t, conn, `SELECT count(*) FROM transactions WHERE ledger_id=1`); n != 1 {
		t.Fatalf("禁止新增交易行，实际 %d", n)
	}
	if n := tagEditCount(t, conn, `SELECT count(*) FROM tag_edit_log WHERE entity_uuid='txn-1'`); n != 1 {
		t.Fatalf("审计应恰好 1 条，实际 %d", n)
	}
	var oldTags, newTags, actor, device, ts string
	if err := conn.QueryRow(
		`SELECT old_tags, new_tags, actor_id, device_id, ts FROM tag_edit_log WHERE entity_uuid='txn-1'`,
	).Scan(&oldTags, &newTags, &actor, &device, &ts); err != nil {
		t.Fatalf("回读审计: %v", err)
	}
	if oldTags != `["餐饮"]` || newTags != `["晚餐"]` || actor != "1" || device != "dev-repo" || !tagEditTSRE.MatchString(ts) {
		t.Fatalf("审计内容不符: old=%s new=%s actor=%s device=%s ts=%s", oldTags, newTags, actor, device, ts)
	}
	if n := tagEditCount(t, conn,
		`SELECT count(*) FROM sync_log WHERE entity_type=? AND entity_uuid=? AND op=?`,
		domain.EntityTransaction, "txn-1", domain.OpUpdate,
	); n != 1 {
		t.Fatalf("应写且只写一条 sync_log op=update，实际 %d", n)
	}
}

// TestUpdateTagsTx_AtomicityOnAuditFailure 审计写入失败时整笔回滚：
// 标签不得改、sync_log 不得写。这是「审计与同步同事务」的核心回归。
func TestUpdateTagsTx_AtomicityOnAuditFailure(t *testing.T) {
	conn := openReversalTestDB(t)
	seedTagEditFixture(t, conn)
	if _, err := conn.Exec(`DROP TABLE tag_edit_log`); err != nil {
		t.Fatalf("模拟审计表不可用: %v", err)
	}
	store := New(conn)

	_, err := store.UpdateTagsTx(TagsUpdateInput{
		LedgerID: 1, EntityUUID: "txn-1",
		Tags: []string{"晚餐"}, BaseTags: []string{"餐饮"}, ActorID: 1,
	})
	if err == nil {
		t.Fatal("审计表不存在时整体写入应失败")
	}
	var tagsRaw string
	if err := conn.QueryRow(`SELECT COALESCE(tags,'') FROM transactions WHERE uuid='txn-1'`).Scan(&tagsRaw); err != nil {
		t.Fatalf("回读交易: %v", err)
	}
	if tagsRaw != `["餐饮"]` {
		t.Fatalf("审计失败时标签必须回滚，实际 %s", tagsRaw)
	}
	if n := tagEditCount(t, conn, `SELECT count(*) FROM sync_log`); n != 0 {
		t.Fatalf("审计失败时不得写 sync_log，实际 %d", n)
	}
}

// TestUpdateTagsTx_ClientOpDedup P1 去重键命中：直接返回既有 edit_id，
// 不重复写审计、不重复写 sync_log，也不改动当前 tags。
func TestUpdateTagsTx_ClientOpDedup(t *testing.T) {
	conn := openReversalTestDB(t)
	seedTagEditFixture(t, conn)
	store := New(conn)

	first, err := store.UpdateTagsTx(TagsUpdateInput{
		LedgerID: 1, EntityUUID: "txn-1",
		Tags: []string{"甲"}, BaseTags: []string{"餐饮"},
		ActorID: 1, ClientOpID: "dev-1:batch-9",
	})
	if err != nil {
		t.Fatalf("首次写入: %v", err)
	}
	second, err := store.UpdateTagsTx(TagsUpdateInput{
		LedgerID: 1, EntityUUID: "txn-1",
		Tags: []string{"乙"}, BaseTags: []string{"甲"},
		ActorID: 1, ClientOpID: "dev-1:batch-9",
	})
	if err != nil {
		t.Fatalf("重复批次应幂等返回: %v", err)
	}
	if second.EditID != first.EditID {
		t.Fatalf("去重命中应返回既有 edit_id=%d，实际 %d", first.EditID, second.EditID)
	}
	if n := tagEditCount(t, conn, `SELECT count(*) FROM tag_edit_log`); n != 1 {
		t.Fatalf("去重命中不应新增审计，实际 %d", n)
	}
	if n := tagEditCount(t, conn, `SELECT count(*) FROM sync_log`); n != 1 {
		t.Fatalf("去重命中不应新增 sync_log，实际 %d", n)
	}
	var tagsRaw string
	if err := conn.QueryRow(`SELECT COALESCE(tags,'') FROM transactions WHERE uuid='txn-1'`).Scan(&tagsRaw); err != nil {
		t.Fatalf("回读交易: %v", err)
	}
	if tagsRaw != `["甲"]` {
		t.Fatalf("去重命中不应再改标签，实际 %s", tagsRaw)
	}
}

// TestTagEditsByUUID_DescendingAndLimit 倒序 + 服务端限量 + actor_name JOIN。
func TestTagEditsByUUID_DescendingAndLimit(t *testing.T) {
	conn := openReversalTestDB(t)
	seedTagEditFixture(t, conn)
	for i := 0; i < 5; i++ {
		if _, err := conn.Exec(
			`INSERT INTO tag_edit_log(ledger_id, entity_uuid, action, old_tags, new_tags, actor_id, ts)
			 VALUES(1, 'txn-1', 'replace', '[]', ?, 1, ?)`,
			`["标签`+string(rune('A'+i))+`"]`, "2026-11-27T09:31:12.345Z",
		); err != nil {
			t.Fatalf("插入审计 %d: %v", i, err)
		}
	}
	store := New(conn)
	edits, err := store.TagEditsByUUID(1, "txn-1", 3)
	if err != nil {
		t.Fatalf("读取审计: %v", err)
	}
	if len(edits) != 3 {
		t.Fatalf("应最多 3 条，实际 %d", len(edits))
	}
	for i := 1; i < len(edits); i++ {
		if edits[i-1].ID <= edits[i].ID {
			t.Fatalf("审计应 id DESC 倒序，实际 %+v", edits)
		}
	}
	if edits[0].ActorName != "张三" || edits[0].Action != "replace" || len(edits[0].NewTags) != 1 {
		t.Fatalf("审计 JOIN / 解析不符: %+v", edits[0])
	}

	// limit<=0 回落为 50；其他账本/交易隔离。
	all, err := store.TagEditsByUUID(1, "txn-1", 0)
	if err != nil || len(all) != 5 {
		t.Fatalf("缺省上限应取 50 条，实际 %d err=%v", len(all), err)
	}
	other, err := store.TagEditsByUUID(1, "other-txn", 50)
	if err != nil || len(other) != 0 {
		t.Fatalf("不同 uuid 应隔离，实际 %d err=%v", len(other), err)
	}
}

// TestUpdateTags_DedupReplay 锁定 P1 去重分支前移（方案 §4.2）的核心语义：
// 首次 PUT 已成功落库但响应在网络中丢失时，客户端用同一 client_op_id + 旧
// base_tags 重试，即使 base 已与当前 tags 不符，也必须命中去重分支幂等返回
// 既有 edit_id，而不是先撞 CAS（409）。审计 / sync_log 均只写 1 条。
// 同时验证：换一个 op id（真实并发冲突）仍返回 TagsConflict（HTTP 409），
// 证明前移没有吞掉真实冲突。
func TestUpdateTags_DedupReplay(t *testing.T) {
	conn := openReversalTestDB(t)
	seedTagEditFixture(t, conn)
	store := New(conn)

	const opID = "dev-replay:batch-1"

	// ① 首次落库：tags 从 ["餐饮"] → ["甲"]，审计 + sync_log 各 1 条。
	first, err := store.UpdateTagsTx(TagsUpdateInput{
		LedgerID: 1, EntityUUID: "txn-1",
		Tags: []string{"甲"}, BaseTags: []string{"餐饮"},
		ActorID: 1, DeviceID: "dev-replay", ClientOpID: opID,
	})
	if err != nil {
		t.Fatalf("首次写入: %v", err)
	}
	if first.EditID <= 0 {
		t.Fatalf("首次写入应返回有效 edit_id，实际 %d", first.EditID)
	}

	// ② 响应丢失重放：同 op id + 过期 base_tags（仍是首次前的 ["餐饮"]）。
	// 若去重仍在 CAS 之后，这里会返回 TagsConflict（409）；前移后必须幂等成功。
	replay, err := store.UpdateTagsTx(TagsUpdateInput{
		LedgerID: 1, EntityUUID: "txn-1",
		Tags: []string{"甲"}, BaseTags: []string{"餐饮"}, // 故意用旧快照
		ActorID: 1, DeviceID: "dev-replay", ClientOpID: opID,
	})
	if err != nil {
		var tc *TagsConflict
		if errors.As(err, &tc) {
			t.Fatalf("同 op id 重放不应撞 CAS（当前 tags=%q ts=%q）", tc.CurrentTags, tc.CurrentTagsUpdatedAt)
		}
		t.Fatalf("同 op id 重放应幂等成功: %v", err)
	}
	if replay.EditID != first.EditID {
		t.Fatalf("重放应返回既有 edit_id=%d，实际 %d", first.EditID, replay.EditID)
	}
	if len(replay.Tags) != 1 || replay.Tags[0] != "甲" {
		t.Fatalf("重放应回显当前 tags=[\"甲\"]，实际 %+v", replay.Tags)
	}
	if replay.TagsUpdatedAt != first.TagsUpdatedAt {
		t.Fatalf("重放不得推进 tags_updated_at（%q → %q）", first.TagsUpdatedAt, replay.TagsUpdatedAt)
	}

	// ③ 审计 / sync_log 各只 1 条；标签、交易行数不变。
	if n := tagEditCount(t, conn, `SELECT count(*) FROM tag_edit_log WHERE entity_uuid='txn-1'`); n != 1 {
		t.Fatalf("重放不应写第二条审计，实际 %d", n)
	}
	if n := tagEditCount(t, conn,
		`SELECT count(*) FROM sync_log WHERE entity_type=? AND entity_uuid=? AND op=?`,
		domain.EntityTransaction, "txn-1", domain.OpUpdate,
	); n != 1 {
		t.Fatalf("重放不应写第二条 sync_log，实际 %d", n)
	}
	if n := tagEditCount(t, conn, `SELECT count(*) FROM transactions WHERE ledger_id=1`); n != 1 {
		t.Fatalf("交易行数必须保持 1，实际 %d", n)
	}
	var tagsRaw string
	if err := conn.QueryRow(`SELECT COALESCE(tags,'') FROM transactions WHERE uuid='txn-1'`).Scan(&tagsRaw); err != nil {
		t.Fatalf("回读交易: %v", err)
	}
	if tagsRaw != `["甲"]` {
		t.Fatalf("重放不得改动当前 tags，实际 %s", tagsRaw)
	}

	// ④ 真实并发冲突：换 op id + 仍用过期 base → 必须是 TagsConflict（HTTP 409）。
	_, err = store.UpdateTagsTx(TagsUpdateInput{
		LedgerID: 1, EntityUUID: "txn-1",
		Tags: []string{"乙"}, BaseTags: []string{"餐饮"},
		ActorID: 1, ClientOpID: "dev-replay:batch-2",
	})
	var conflict *TagsConflict
	if !errors.As(err, &conflict) {
		t.Fatalf("新 op id + 过期 base 应仍返回 TagsConflict（409），实际 %v", err)
	}
	if len(conflict.CurrentTags) != 1 || conflict.CurrentTags[0] != "甲" {
		t.Fatalf("冲突应回带当前 tags=[\"甲\"]，实际 %+v", conflict.CurrentTags)
	}
	if n := tagEditCount(t, conn, `SELECT count(*) FROM tag_edit_log`); n != 1 {
		t.Fatalf("真实冲突不得写审计，实际 %d", n)
	}
}

// TestTagEditOpUniqueIndex 迁移 018 的部分唯一索引 uniq_tag_edit_op 保证
// (ledger_id, client_op_id) 重复写入必然失败；空 op id 不受约束（P0 在线可写多条）。
func TestTagEditOpUniqueIndex(t *testing.T) {
	conn := openReversalTestDB(t)
	seedTagEditFixture(t, conn)
	insert := func(opID string) error {
		_, err := conn.Exec(
			`INSERT INTO tag_edit_log
			 (ledger_id, entity_uuid, action, old_tags, new_tags, actor_id, client_op_id, ts)
			 VALUES(1, 'txn-1', 'replace', '[]', '["甲"]', 1, ?, '2026-11-27T09:31:12.345Z')`,
			opID,
		)
		return err
	}
	if err := insert("dev-idx:batch-1"); err != nil {
		t.Fatalf("首次插入: %v", err)
	}
	if err := insert("dev-idx:batch-1"); err == nil {
		t.Fatal("同 (ledger_id, client_op_id) 必须被部分唯一索引拒绝")
	}
	if err := insert(""); err != nil {
		t.Fatalf("空 op id 首次插入: %v", err)
	}
	if err := insert(""); err != nil {
		t.Fatalf("空 op id 二次插入仍应成功（被 WHERE client_op_id <> '' 排除）: %v", err)
	}
	if n := tagEditCount(t, conn, `SELECT count(*) FROM tag_edit_log`); n != 3 {
		t.Fatalf("应恰好 3 条审计（1 + 2 条空 op id），实际 %d", n)
	}
}

// TestTagEditByClientOpID 去重短路读方法：命中回显审计行 id/new_tags/ts；
// 未命中与空 op id 都返回 (nil, nil)，不能误判为命中。
func TestTagEditByClientOpID(t *testing.T) {
	conn := openReversalTestDB(t)
	seedTagEditFixture(t, conn)
	store := New(conn)

	miss, err := store.TagEditByClientOpID(1, "dev-lookup:none")
	if err != nil || miss != nil {
		t.Fatalf("未命中应返回 (nil, nil)，实际 %+v err=%v", miss, err)
	}
	empty, err := store.TagEditByClientOpID(1, "")
	if err != nil || empty != nil {
		t.Fatalf("空 op id 应返回 (nil, nil)，实际 %+v err=%v", empty, err)
	}

	first, err := store.UpdateTagsTx(TagsUpdateInput{
		LedgerID: 1, EntityUUID: "txn-1",
		Tags: []string{"甲", "乙"}, BaseTags: []string{"餐饮"},
		ActorID: 1, ClientOpID: "dev-lookup:batch-1",
	})
	if err != nil {
		t.Fatalf("首次写入: %v", err)
	}
	got, err := store.TagEditByClientOpID(1, "dev-lookup:batch-1")
	if err != nil || got == nil {
		t.Fatalf("命中查询: %v got=%+v", err, got)
	}
	if got.ID != first.EditID || got.EntityUUID != "txn-1" {
		t.Fatalf("命中回显 id/uuid 不符: %+v", got)
	}
	if len(got.NewTags) != 2 || got.NewTags[0] != "甲" || got.NewTags[1] != "乙" {
		t.Fatalf("命中应回显审计行 new_tags，实际 %+v", got.NewTags)
	}
	if !tagEditTSRE.MatchString(got.Ts) {
		t.Fatalf("ts 格式不符: %q", got.Ts)
	}
}
