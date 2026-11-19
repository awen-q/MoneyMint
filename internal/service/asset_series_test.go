package service

// T61：资产统计页的年度序列（GET /api/assets/series）。
//
// 六条用例对准最容易错的六处口径，其中前三条是「能红」的：
//  1. 月末边界：2026-01-31 的交易必须出现在 2026-01 点里
//     （把 beforeDate 改成月末当天就会红 —— 曲线整体左移一个月）；
//  2. 年边界：2026-12-31 进 2026-12、2027-01-01 不进 2026；
//  3. 符号：liabilities 保持负号、net 严格相加（取 abs 会让 net 变大，必须红）；
//  4. 关户：已关账户的历史余额仍计入（关户 ≠ 钱消失）；
//  5. 软删：软删交易的金额不计入任何点；
//  6. 空账本：12 个点齐全、全 "0.00"（不是 null、不缺月）。

import (
	"errors"
	"testing"

	"familyledger/internal/domain"
)

// assetSeriesEnv 是序列测试环境：真实 SQLite + 已注册 owner + 默认账户名 → id。
type assetSeriesEnv struct {
	t        *testing.T
	svc      *Service
	uid      int64
	accounts map[string]int64
}

// newAssetSeriesEnv 构造环境并缓存默认账户的 name → id。
func newAssetSeriesEnv(t *testing.T) *assetSeriesEnv {
	t.Helper()
	svc := newTestService(t)
	owner := registerOwner(t, svc)
	e := &assetSeriesEnv{t: t, svc: svc, uid: owner.User.ID, accounts: map[string]int64{}}
	e.reloadAccounts()
	return e
}

// reloadAccounts 重新读取账户列表（新建账户后要刷新映射）。
func (e *assetSeriesEnv) reloadAccounts() {
	e.t.Helper()
	accounts, err := e.svc.ListAccounts(lid, true)
	if err != nil {
		e.t.Fatalf("列出账户: %v", err)
	}
	for _, a := range accounts {
		e.accounts[a.Name] = a.ID
	}
}

// acc 按账户名取 id。
func (e *assetSeriesEnv) acc(name string) int64 {
	e.t.Helper()
	id, ok := e.accounts[name]
	if !ok || id == 0 {
		e.t.Fatalf("账户 %q 不存在", name)
	}
	return id
}

// newAccount 新建一个账户并返回 (id, uuid)。
func (e *assetSeriesEnv) newAccount(name, accountType string) (int64, string) {
	e.t.Helper()
	created, err := e.svc.CreateAccount(lid, name, "", accountType, "2026-01-01", "CNY", "", "", "", "")
	if err != nil {
		e.t.Fatalf("建账户 %q 失败: %v", name, err)
	}
	e.reloadAccounts()
	return created.ID, created.UUID
}

// txn 记一笔账，返回 uuid（软删用）。
func (e *assetSeriesEnv) txn(date, description string, postings ...PostingInput) string {
	e.t.Helper()
	created, err := e.svc.CreateTransaction(lid, date, "*", description, postings, e.uid)
	if err != nil {
		e.t.Fatalf("记账 %q(%s) 失败: %v", description, date, err)
	}
	return created.UUID
}

// series 取某年序列（断言无错、且恒 12 点）。
func (e *assetSeriesEnv) series(year, commodity string) AssetSeriesView {
	e.t.Helper()
	view, err := e.svc.AssetSeries(lid, year, commodity)
	if err != nil {
		e.t.Fatalf("AssetSeries(%s, %q) 失败: %v", year, commodity, err)
	}
	if len(view.Points) != 12 {
		e.t.Fatalf("points 必须恒 12 个，实际 %d 个", len(view.Points))
	}
	return view
}

// point 按月份取点。
func (e *assetSeriesEnv) point(view AssetSeriesView, month string) AssetSeriesPoint {
	e.t.Helper()
	for _, p := range view.Points {
		if p.Month == month {
			return p
		}
	}
	e.t.Fatalf("序列里没有月份 %s", month)
	return AssetSeriesPoint{}
}

// TestAssetSeriesMonthEndBoundary 用例 1（能红）：
// 2026-01-31 当天的交易必须出现在 2026-01 的月末末值里。
//
// 月末末值口径是「次月 1 日日初」（t.date < '2026-02-01'）。若实现写成
// beforeDate = '2026-01-31'（月末当天），这笔交易会被漏掉 → 1 月显示 0.00，
// 整条曲线左移一个月，而且不报任何错。
func TestAssetSeriesMonthEndBoundary(t *testing.T) {
	e := newAssetSeriesEnv(t)
	cash := e.acc("Assets:Cash")
	equity := e.acc("Equity:Opening-Balances")

	// 1 月 31 日（月末当天）存入 500。
	e.txn("2026-01-31", "月末存入", post(cash, "500.00", "CNY"), post(equity, "-500.00", "CNY"))

	view := e.series("2026", "CNY")
	jan := e.point(view, "2026-01")
	if jan.Assets != "500.00" {
		t.Fatalf("2026-01-31 的交易必须计入 1 月（月末末值=次月1日日初），实际 assets=%q", jan.Assets)
	}
	if jan.Net != "500.00" {
		t.Fatalf("1 月 net 应为 500.00，实际 %q", jan.Net)
	}
	// 余额结转到年底：2 月及之后都必须延续 500（不能因为没交易就掉回 0）。
	for _, month := range []string{"2026-02", "2026-06", "2026-12"} {
		if got := e.point(view, month).Assets; got != "500.00" {
			t.Fatalf("%s 应结转 500.00，实际 %q", month, got)
		}
	}
}

// TestAssetSeriesYearBoundary 用例 2（能红）：
// 2026-12-31 进 2026-12 点，2027-01-01 **不进** 2026 的任何点。
func TestAssetSeriesYearBoundary(t *testing.T) {
	e := newAssetSeriesEnv(t)
	cash := e.acc("Assets:Cash")
	equity := e.acc("Equity:Opening-Balances")

	e.txn("2026-12-31", "年末存入", post(cash, "700.00", "CNY"), post(equity, "-700.00", "CNY"))
	e.txn("2027-01-01", "次日元旦", post(cash, "1000.00", "CNY"), post(equity, "-1000.00", "CNY"))

	view := e.series("2026", "CNY")
	if len(view.Points) != 12 {
		t.Fatalf("应恰好 12 个点，实际 %d 个", len(view.Points))
	}
	if first, last := view.Points[0].Month, view.Points[11].Month; first != "2026-01" || last != "2026-12" {
		t.Fatalf("月份应覆盖 2026-01~2026-12，实际 %s~%s", first, last)
	}
	if dec := e.point(view, "2026-12"); dec.Assets != "700.00" {
		t.Fatalf("2026-12-31 的交易必须计入 12 月，实际 assets=%q", dec.Assets)
	}
	// 2027-01-01 的交易不得出现在 2026 的任何点里。
	for _, p := range view.Points {
		if p.Assets != "700.00" && p.Assets != "0.00" {
			t.Fatalf("%s 出现了 2026 年之外的数据（assets=%q）", p.Month, p.Assets)
		}
		if p.Assets == "1700.00" {
			t.Fatalf("%s 把 2027-01-01 的交易算进了 2026", p.Month)
		}
	}

	// 次年序列：1 月带上年结转 + 元旦那笔。
	next := e.series("2027", "CNY")
	if jan := e.point(next, "2027-01"); jan.Assets != "1700.00" {
		t.Fatalf("2027-01 应含上年结转 700 + 元旦 1000 = 1700.00，实际 %q", jan.Assets)
	}
}

// TestAssetSeriesSigns 用例 3（能红）：liabilities 保持负号，net 严格相加。
//
// 若实现把 liabilities 取绝对值，net 会变成 10000+3000=13000（错），
// 而正确值是 10000+(-3000)=7000。
func TestAssetSeriesSigns(t *testing.T) {
	e := newAssetSeriesEnv(t)
	cash := e.acc("Assets:Cash")
	mortgage := e.acc("Liabilities:Mortgage")
	equity := e.acc("Equity:Opening-Balances")

	// 存款 10000（资产为正）。
	e.txn("2026-03-01", "存款", post(cash, "10000.00", "CNY"), post(equity, "-10000.00", "CNY"))
	// 房贷负债 3000：负债账户贷方为负，对手方记权益。
	e.txn("2026-03-02", "房贷", post(mortgage, "-3000.00", "CNY"), post(equity, "3000.00", "CNY"))

	mar := e.point(e.series("2026", "CNY"), "2026-03")
	if mar.Assets != "10000.00" {
		t.Fatalf("assets 应为 10000.00，实际 %q", mar.Assets)
	}
	if mar.Liabilities != "-3000.00" {
		t.Fatalf("liabilities 必须保持负号（禁止 abs），实际 %q", mar.Liabilities)
	}
	if mar.Net != "7000.00" {
		t.Fatalf("net = assets + liabilities = 7000.00（取 abs 会得到 13000.00），实际 %q", mar.Net)
	}
}

// TestAssetSeriesClosedAccountHistory 用例 4：已关账户的历史余额仍计入。
//
// 关户（close_date 非空）≠ 钱消失：与资产页「关户仍列出」同一条理由。
// 若查询里加了 `a.close_date IS NULL`，1 月的 1000 会凭空消失。
func TestAssetSeriesClosedAccountHistory(t *testing.T) {
	e := newAssetSeriesEnv(t)
	equity := e.acc("Equity:Opening-Balances")
	oldID, oldUUID := e.newAccount("Assets:OldAccount", domain.TypeAssets)

	e.txn("2026-01-15", "老账户存入", post(oldID, "1000.00", "CNY"), post(equity, "-1000.00", "CNY"))
	e.txn("2026-02-15", "老账户清空", post(oldID, "-1000.00", "CNY"), post(equity, "1000.00", "CNY"))

	// 余额已归零 → 关户成功（关闭要求余额为 0）。
	if err := e.svc.DeleteAccount(lid, oldUUID); err != nil {
		t.Fatalf("关户失败: %v", err)
	}
	closed, err := e.svc.ListAccounts(lid, true)
	if err != nil {
		t.Fatalf("列账户: %v", err)
	}
	found := false
	for _, a := range closed {
		if a.ID == oldID {
			found = true
			if a.CloseDate == "" {
				t.Fatalf("账户应已置 close_date（关户 ≠ 软删）")
			}
		}
	}
	if !found {
		t.Fatalf("关户后账户仍应出现在 include_closed 列表里")
	}

	view := e.series("2026", "CNY")
	if jan := e.point(view, "2026-01"); jan.Assets != "1000.00" {
		t.Fatalf("已关账户的历史余额仍须计入 1 月（关户 ≠ 钱消失），实际 %q", jan.Assets)
	}
	if feb := e.point(view, "2026-02"); feb.Assets != "0.00" {
		t.Fatalf("2 月清空后应为 0.00，实际 %q", feb.Assets)
	}
}

// TestAssetSeriesExcludesSoftDeleted 用例 5：软删交易的金额不计入任何点。
func TestAssetSeriesExcludesSoftDeleted(t *testing.T) {
	e := newAssetSeriesEnv(t)
	cash := e.acc("Assets:Cash")
	equity := e.acc("Equity:Opening-Balances")

	uuid := e.txn("2026-05-10", "待删的存入", post(cash, "900.00", "CNY"), post(equity, "-900.00", "CNY"))
	if err := e.svc.DeleteTransaction(lid, e.uid, uuid); err != nil {
		t.Fatalf("软删交易失败: %v", err)
	}

	view := e.series("2026", "CNY")
	for _, p := range view.Points {
		if p.Assets != "0.00" || p.Liabilities != "0.00" || p.Net != "0.00" {
			t.Fatalf("软删交易不得计入 %s：%+v", p.Month, p)
		}
	}
}

// TestAssetSeriesEmptyLedger 用例 6：空账本仍返回 12 个点、全 "0.00"（非 null）。
func TestAssetSeriesEmptyLedger(t *testing.T) {
	e := newAssetSeriesEnv(t)

	view := e.series("2026", "")
	if view.Commodity != "CNY" {
		t.Fatalf("commodity 缺省应取账本 default_commodity（CNY），实际 %q", view.Commodity)
	}
	if len(view.Points) != 12 {
		t.Fatalf("空账本也必须 12 个点，实际 %d 个", len(view.Points))
	}
	for i, p := range view.Points {
		want := fmtMonth(2026, i+1)
		if p.Month != want {
			t.Fatalf("第 %d 个点月份应为 %s，实际 %s", i, want, p.Month)
		}
		if p.Assets != "0.00" || p.Liabilities != "0.00" || p.Net != "0.00" {
			t.Fatalf("空账本 %s 应全为 \"0.00\"（不是 null / 空串），实际 %+v", p.Month, p)
		}
	}
}

// TestAssetSeriesInvalidYear 是参数校验的守门用例：year 非法一律 400（ErrInvalid），
// 不静默回退到「今年」——静默回退会让用户看到的曲线与请求参数不符。
func TestAssetSeriesInvalidYear(t *testing.T) {
	e := newAssetSeriesEnv(t)

	for _, year := range []string{"", "26", "20261", "abcd", "2026-01", "0999", "9999"} {
		_, err := e.svc.AssetSeries(lid, year, "CNY")
		if err == nil {
			t.Fatalf("year=%q 应报参数错误", year)
		}
		if !errors.Is(err, domain.ErrInvalid) {
			t.Fatalf("year=%q 应为 ErrInvalid（→ 400），实际 %v", year, err)
		}
	}
}

// fmtMonth 生成 "YYYY-MM"（测试内自足，不依赖被测代码）。
func fmtMonth(year, month int) string {
	return string(rune('0'+year/1000)) +
		string(rune('0'+(year/100)%10)) +
		string(rune('0'+(year/10)%10)) +
		string(rune('0'+year%10)) + "-" +
		string(rune('0'+month/10)) + string(rune('0'+month%10))
}
