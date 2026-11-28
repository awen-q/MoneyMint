package service

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

// captureSlog 临时把 slog 默认 logger 指向内存 buffer，测试结束还原。
// 本包无 t.Parallel，全局替换不会与其他测试竞争。
func captureSlog(t *testing.T) *bytes.Buffer {
	t.Helper()
	prev := slog.Default()
	buf := &bytes.Buffer{}
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return buf
}

// TestSyncPushRejectLogsFields 验证逐条拒绝时服务端留下可 grep 的 WARN，
// 且字段与前端 PushResult 对齐（ledger/user/client/index/entity/op/uuid/code/err）。
// 纯副作用：不改变拒绝结果与计数。
func TestSyncPushRejectLogsFields(t *testing.T) {
	svc := newTestService(t)
	res := registerOwner(t, svc)
	buf := captureSlog(t)

	// 账户推送缺少 uuid/name/type → Invalidf，无稳定码 → 应记 code=internal。
	push, err := svc.SyncPush(lid, res.User.ID, PushRequest{
		ClientID: "reject-log-device",
		Changes: []PushChange{{
			EntityType: "account",
			Op:         "create",
			Entity:     mustJSON(t, map[string]any{"name": ""}),
		}},
	})
	if err != nil {
		t.Fatalf("SyncPush: %v", err)
	}
	if len(push.Results) != 1 || push.Results[0].Status != "error" {
		t.Fatalf("应有一条 error 结果，实际 %+v", push.Results)
	}
	if push.Accepted != 0 {
		t.Fatalf("accepted = %d, want 0", push.Accepted)
	}

	line := buf.String()
	for _, want := range []string{
		"level=WARN",
		"msg=sync.push.reject",
		"event=sync.push.reject",
		"client_id=reject-log-device",
		"index=0",
		"entity_type=account",
		"op=create",
		"code=internal",
	} {
		if !strings.Contains(line, want) {
			t.Fatalf("日志缺少 %q，实际:\n%s", want, line)
		}
	}
	// 服务端权威字段：ledger_id / user_id 必须出现（值为非负整数）。
	if !strings.Contains(line, "ledger_id=") || !strings.Contains(line, "user_id=") {
		t.Fatalf("日志缺少 ledger_id/user_id:\n%s", line)
	}
}

// TestSyncPushIdempotentSkipDoesNotLogReject 验证幂等跳过 / 自然键合并
// 走成功分支，不会被误记为 reject（否则日志会爆炸且误导）。
func TestSyncPushIdempotentSkipDoesNotLogReject(t *testing.T) {
	svc := newTestService(t)
	res := registerOwner(t, svc)
	accounts, err := svc.ListAccounts(lid, false)
	if err != nil || len(accounts) < 1 {
		t.Fatalf("默认账户: %v", err)
	}
	acc := accounts[0]
	entity := mustJSON(t, map[string]any{
		"uuid": acc.UUID, "name": acc.Name, "type": acc.Type, "open_date": "2026-01-01",
	})

	buf := captureSlog(t)
	// 同 uuid 已存在 → 幂等跳过，accepted=false 但 status=ok，不记 reject。
	push, err := svc.SyncPush(lid, res.User.ID, PushRequest{
		ClientID: "idem-device",
		Changes:  []PushChange{{EntityType: "account", Op: "create", Entity: entity}},
	})
	if err != nil {
		t.Fatalf("SyncPush: %v", err)
	}
	if len(push.Results) != 1 || push.Results[0].Status != "ok" {
		t.Fatalf("应幂等跳过（status=ok），实际 %+v", push.Results)
	}
	if strings.Contains(buf.String(), "sync.push.reject") {
		t.Fatalf("幂等跳过不应记 reject:\n%s", buf.String())
	}
}
