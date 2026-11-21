package service

// 分类排序 service 层回归（P0）：校验拒绝 + 跨端 pull 拿到 sort_order。
//
// 同步协议零改动：批量提交只写 sync_log(op=update)，对端 SyncPull 的 payload
// 已含 sort_order；本测试钉住「顺序变更真的能跨端重排」这条链路。

import (
	"encoding/json"
	"errors"
	"testing"

	"familyledger/internal/domain"
)

func TestUpdateAccountSortOrdersValidation(t *testing.T) {
	svc := newTestService(t)
	registerOwner(t, svc)

	cases := []struct {
		name   string
		orders []AccountSortOrderItem
	}{
		{"空列表", nil},
		{"空 uuid", []AccountSortOrderItem{{UUID: "", SortOrder: 0}}},
		{"负序号", []AccountSortOrderItem{{UUID: "u-a", SortOrder: -1}}},
		{"重复 uuid", []AccountSortOrderItem{
			{UUID: "u-a", SortOrder: 0},
			{UUID: "u-a", SortOrder: 1},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.UpdateAccountSortOrders(lid, tc.orders)
			if !errors.Is(err, domain.ErrInvalid) {
				t.Fatalf("应返回 ErrInvalid（→400），实际 %v", err)
			}
		})
	}
}

// TestSortOrderChangesArePullable A 端排序落库后，B 端 pull 拿到三条 op=update，
// payload 带 sort_order 且水位递增（对端按 seq 应用即可重排）。
// TestOfflinePushSortOrderIsPullable 离线端重放 op=update（只带 uuid + sort_order）
// 经 push 落库后，对端 pull 能拿到同一顺序；重放只推进水位，不产生回环写。
func TestOfflinePushSortOrderIsPullable(t *testing.T) {
	svc := newTestService(t)
	owner := registerOwner(t, svc)
	created, err := svc.CreateAccount(lid, "Expenses:SortOffline", "", domain.TypeExpenses, "", "", "", "", "", "")
	if err != nil {
		t.Fatalf("建账户: %v", err)
	}

	payload, err := json.Marshal(map[string]any{"uuid": created.UUID, "sort_order": 5})
	if err != nil {
		t.Fatalf("构造 push payload: %v", err)
	}
	push, err := svc.SyncPush(lid, owner.User.ID, PushRequest{
		ClientID: "offline-a",
		Since:    0,
		Changes: []PushChange{{
			EntityType: domain.EntityAccount,
			Op:         domain.OpUpdate,
			Entity:     payload,
		}},
	})
	if err != nil {
		t.Fatalf("离线 push: %v", err)
	}
	if push.Accepted != 1 {
		t.Fatalf("应接受 1 条 update，实际 %d: %+v", push.Accepted, push.Results)
	}

	pull, err := svc.SyncPull(lid, 0, "peer-b")
	if err != nil {
		t.Fatalf("对端 pull: %v", err)
	}
	found := false
	for _, change := range pull.Changes {
		if change.EntityType != domain.EntityAccount || change.Op != domain.OpUpdate {
			continue
		}
		var entity struct {
			UUID      string `json:"uuid"`
			SortOrder int64  `json:"sort_order"`
		}
		if err := json.Unmarshal(change.Entity, &entity); err != nil {
			t.Fatalf("解析 pull payload: %v", err)
		}
		if entity.UUID == created.UUID && entity.SortOrder == 5 {
			found = true
		}
	}
	if !found {
		t.Fatalf("对端未 pull 到 sort_order=5 的账户更新")
	}
}

func TestSortOrderChangesArePullable(t *testing.T) {
	svc := newTestService(t)
	registerOwner(t, svc)

	created := make([]string, 0, 3)
	for _, name := range []string{"Expenses:SortX", "Expenses:SortY", "Expenses:SortZ"} {
		a, err := svc.CreateAccount(lid, name, "", domain.TypeExpenses, "", "", "", "", "", "")
		if err != nil {
			t.Fatalf("建账户 %s: %v", name, err)
		}
		created = append(created, a.UUID)
	}

	orders := []AccountSortOrderItem{
		{UUID: created[2], SortOrder: 0},
		{UUID: created[0], SortOrder: 1},
		{UUID: created[1], SortOrder: 2},
	}
	updated, err := svc.UpdateAccountSortOrders(lid, orders)
	if err != nil {
		t.Fatalf("批量排序: %v", err)
	}
	if updated != int64(len(orders)) {
		t.Fatalf("应更新 %d 条，实际 %d", len(orders), updated)
	}

	pull, err := svc.SyncPull(lid, 0, "peer-b")
	if err != nil {
		t.Fatalf("对端 pull: %v", err)
	}
	var accountUpdates []SyncChangeOut
	for _, change := range pull.Changes {
		if change.EntityType == domain.EntityAccount && change.Op == domain.OpUpdate {
			accountUpdates = append(accountUpdates, change)
		}
	}
	if len(accountUpdates) != len(orders) {
		t.Fatalf("对端应收到 %d 条账户 update，实际 %d", len(orders), len(accountUpdates))
	}
	for i, change := range accountUpdates {
		if i > 0 && change.Seq <= accountUpdates[i-1].Seq {
			t.Fatalf("水位必须递增：%v", accountUpdates)
		}
		var entity struct {
			UUID      string `json:"uuid"`
			SortOrder int64  `json:"sort_order"`
		}
		if err := json.Unmarshal(change.Entity, &entity); err != nil {
			t.Fatalf("解析 pull payload: %v", err)
		}
		want := orders[i]
		if entity.UUID != want.UUID || entity.SortOrder != want.SortOrder {
			t.Fatalf("第 %d 条 pull 应为 %+v，实际 %+v", i, want, entity)
		}
	}
}
