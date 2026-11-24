package service

// 账户展示字段（批 II）service 层校验矩阵：
//   - validateAccountVisual：icon 7/8/9 码点边界、ZWJ emoji、空串放行（清除）、
//     color 合法 / 非法、create 路径同步接入回归；
//   - UpdateAccountVisual：全 nil 400、键缺失回填现值（不清空）、trim 与清除、
//     不存在 / 跨账本 → 404 account_not_found。

import (
	"errors"
	"strings"
	"testing"

	"familyledger/internal/domain"
	"familyledger/internal/repository"
)

func strp(s string) *string { return &s }

func TestValidateAccountVisualIconLength(t *testing.T) {
	cases := []struct {
		name  string
		icon  string
		valid bool
	}{
		{"空串（清除）", "", true},
		{"7 码点", "🍖🍖🍖🍖🍖🍖🍖", true},
		{"8 码点（边界）", "🍖🍖🍖🍖🍖🍖🍖🍖", true},
		{"9 码点", "🍖🍖🍖🍖🍖🍖🍖🍖🍖", false},
		{"ZWJ 家族 emoji 按 1 码点", "\U0001F468\u200D\U0001F469\u200D\U0001F467", true},
		{"ASCII 8 字符", "12345678", true},
		{"ASCII 9 字符", "123456789", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateAccountVisual(tc.icon, "")
			if tc.valid && err != nil {
				t.Fatalf("icon %q 应合法，实际 %v", tc.icon, err)
			}
			if !tc.valid {
				if err == nil {
					t.Fatalf("icon %q 应非法", tc.icon)
				}
				if !strings.Contains(err.Error(), "图标") {
					t.Fatalf("错误文案应提及图标，实际 %v", err)
				}
				// 稳定码：经 errors.As 解出 CodedError 断言 code 字段。
				var coded *domain.CodedError
				if !errors.As(err, &coded) || coded.Code != domain.CodeAccountVisualInvalid {
					t.Fatalf("应携带稳定码 %s，实际 %v", domain.CodeAccountVisualInvalid, err)
				}
			}
		})
	}
}

func TestValidateAccountVisualColor(t *testing.T) {
	valid := []string{"#1F7A4D", "#abcdef", "#ABCDEF", "#000000", "#ffffff"}
	for _, color := range valid {
		if err := validateAccountVisual("", color); err != nil {
			t.Fatalf("color %q 应合法，实际 %v", color, err)
		}
	}
	invalid := []string{"1F7A4D", "#1F7A4", "#1F7A4DD", "rgb(0,0,0)", "#GGGGGG", " #1F7A4D"}
	for _, color := range invalid {
		if err := validateAccountVisual("", color); err == nil {
			t.Fatalf("color %q 应非法", color)
		}
	}
	// 空串语义是「清除」，validateAccountVisual 必须放行。
	if err := validateAccountVisual("", ""); err != nil {
		t.Fatalf("空串应放行，实际 %v", err)
	}
	if err := validateAccountVisual("", "#GGGGGG"); err == nil {
		t.Fatalf("#GGGGGG 应非法")
	} else if !strings.Contains(err.Error(), "颜色") {
		t.Fatalf("错误文案应提及颜色，实际 %v", err)
	}
}

// TestCreateAccountRejectsInvalidVisual create 路径同步接入回归：此前 create 对
// icon/color 不设防，本批收紧；非法 icon / color 一律 400 account_visual_invalid。
// 冒烟脚本不传 icon/color 不受影响（不传 = 空串 = 放行）。
func TestCreateAccountRejectsInvalidVisual(t *testing.T) {
	svc := newTestService(t)
	registerOwner(t, svc)
	created, err := svc.CreateAccount(lid, "Expenses:VisualOk", "合法", "Expenses",
		"", "", "", "", "", "")
	if err != nil {
		t.Fatalf("不传视觉字段应创建成功，实际 %v", err)
	}
	if created.Icon != "" || created.Color != "" {
		t.Fatalf("未传视觉字段回显应为空，实际 %s/%s", created.Icon, created.Color)
	}

	_, err = svc.CreateAccount(lid, "Expenses:VisualIcon", "长图标", "Expenses",
		"", "", "123456789", "", "", "")
	if err == nil {
		t.Fatalf("9 码点 icon 应被 create 拒绝")
	}
	var codedIcon *domain.CodedError
	if !errors.As(err, &codedIcon) || codedIcon.Code != domain.CodeAccountVisualInvalid {
		t.Fatalf("错误应携带稳定码 %s（错误体：%v）", domain.CodeAccountVisualInvalid, err)
	}

	_, err = svc.CreateAccount(lid, "Expenses:VisualColor", "坏颜色", "Expenses",
		"", "", "", "#12G45Z", "", "")
	if err == nil {
		t.Fatalf("非法 color 应被 create 拒绝")
	}
}

func TestUpdateAccountVisualMatrix(t *testing.T) {
	svc := newTestService(t)
	registerOwner(t, svc)
	created, err := svc.CreateAccount(lid, "Assets:Bank:Visual", "银行", "Assets",
		"", "", "", "", "", "")
	if err != nil {
		t.Fatalf("建账户: %v", err)
	}

	// 全 nil → 400（不是「无操作成功」）。
	_, err = svc.UpdateAccountVisual(lid, created.UUID, AccountVisualUpdate{})
	if err == nil {
		t.Fatalf("全 nil 应 400")
	}

	// 单键修改：只传 icon，display_name / color 必须回填现值不被清空。
	if _, err := svc.UpdateAccountVisual(lid, created.UUID, AccountVisualUpdate{
		DisplayName: strp("储蓄银行"), Color: strp("#1F7A4D"),
	}); err != nil {
		t.Fatalf("预置展示字段: %v", err)
	}
	updated, err := svc.UpdateAccountVisual(lid, created.UUID, AccountVisualUpdate{
		Icon: strp("🏦"),
	})
	if err != nil {
		t.Fatalf("单键修改应 200，实际 %v", err)
	}
	if updated.Icon != "🏦" || updated.DisplayName != "储蓄银行" || updated.Color != "#1F7A4D" {
		t.Fatalf("键缺失字段应回填现值，实际 %+v", updated)
	}

	// display_name trim 后应用；trim 后空串 = 清除。
	updated, err = svc.UpdateAccountVisual(lid, created.UUID, AccountVisualUpdate{
		DisplayName: strp("  招商储蓄  "),
	})
	if err != nil {
		t.Fatalf("trim 应用: %v", err)
	}
	if updated.DisplayName != "招商储蓄" {
		t.Fatalf("display_name 应 trim，实际 %q", updated.DisplayName)
	}
	updated, err = svc.UpdateAccountVisual(lid, created.UUID, AccountVisualUpdate{
		DisplayName: strp("   "),
	})
	if err != nil || updated.DisplayName != "" {
		t.Fatalf("trim 后空串应清除，实际 %v / %+v", err, updated)
	}

	// 显式空串清除 icon / color。
	updated, err = svc.UpdateAccountVisual(lid, created.UUID, AccountVisualUpdate{
		Icon: strp(""), Color: strp(""),
	})
	if err != nil {
		t.Fatalf("清除应成功: %v", err)
	}
	if updated.Icon != "" || updated.Color != "" {
		t.Fatalf("显式空串应清除，实际 %+v", updated)
	}

	// 修改后的非法值拒绝（现值合法不代表新值放行）。
	_, err = svc.UpdateAccountVisual(lid, created.UUID, AccountVisualUpdate{Icon: strp("123456789")})
	if err == nil {
		t.Fatalf("非法新 icon 应 400")
	}
	_, err = svc.UpdateAccountVisual(lid, created.UUID, AccountVisualUpdate{Color: strp("blue")})
	if err == nil {
		t.Fatalf("非法新 color 应 400")
	}
}

// TestUpdateAccountVisualNotFoundAndClosed 不存在 / 跨账本 → 404 account_not_found；
// 已关户账户可改（纯展示字段）。
func TestUpdateAccountVisualNotFoundAndClosed(t *testing.T) {
	conn := openTestDB(t)
	svc := New(repository.New(conn))
	ledgerID, otherID := seedAccountTestLedgers(t, conn)

	created, err := svc.CreateAccount(ledgerID, "Assets:Bank:VC", "银行", "Assets",
		"", "", "", "", "", "")
	if err != nil {
		t.Fatalf("建账户: %v", err)
	}

	// 不存在的 uuid → 404 account_not_found。
	_, err = svc.UpdateAccountVisual(ledgerID, "no-such-uuid", AccountVisualUpdate{Icon: strp("🏦")})
	if err == nil {
		t.Fatalf("不存在 uuid 应 404")
	}
	var codedNF *domain.CodedError
	if !errors.As(err, &codedNF) || codedNF.Code != domain.CodeAccountNotFound {
		t.Fatalf("错误应携带稳定码 %s，实际 %v", domain.CodeAccountNotFound, err)
	}

	// 跨账本 uuid → 404。
	_, err = svc.UpdateAccountVisual(otherID, created.UUID, AccountVisualUpdate{Icon: strp("🏦")})
	if err == nil {
		t.Fatalf("跨账本 uuid 应 404")
	}
	var codedX *domain.CodedError
	if !errors.As(err, &codedX) || codedX.Code != domain.CodeAccountNotFound {
		t.Fatalf("跨账本应同样映射 account_not_found，实际 %v", err)
	}

	// 关户后仍可改展示字段（repo 仅排除软删行）。
	if err := svc.DeleteAccount(ledgerID, created.UUID); err != nil {
		t.Fatalf("关户: %v", err)
	}
	updated, err := svc.UpdateAccountVisual(ledgerID, created.UUID, AccountVisualUpdate{Icon: strp("🏦")})
	if err != nil {
		t.Fatalf("关户账户应可改展示字段，实际 %v", err)
	}
	if updated.Icon != "🏦" {
		t.Fatalf("关户后 icon 应生效，实际 %+v", updated)
	}
}
