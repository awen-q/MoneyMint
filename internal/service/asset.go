package service

// 资产统计（B6）的服务端序列：GET /api/assets/series。
//
// 为什么放在服务端算：B6 的年度三线（资产 / 负债 / 净资产）原本由前端重放全部
// 交易得出，账本一大就慢，而且与服务端余额口径存在两条独立实现。这里复用
// repository 的余额口径（postingsBalanceWhere）一次算出 12 个月末末值。
//
// 口径三条（改之前先看这里）：
//  1. **月末末值 = 「次月 1 日日初」**：见 repository.BalancesByMonth 的注释，
//     `t.date < beforeDate` 不含当日，所以 1 月的值要截至 2 月 1 日。
//  2. **符号原样**：assets 为 ΣAssets（正），liabilities 为 ΣLiabilities（负，
//     **不取 abs**），net = assets + liabilities 严格相加（AC-12）。
//  3. **禁浮点、禁跨币种求和**：big.Rat 累加、输出定点两位字符串；只统计
//     commodity 匹配的分录，不提供任何跨币种合计字段。

import (
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"

	"familyledger/internal/domain"
)

// AssetSeriesPoint 是资产统计页的一个月点。
//
// 金额一律**定点两位字符串**（不是 JSON number）：浮点会把 0.1+0.2 的误差
// 直接带进曲线，而且 JSON number 在超小额 / 大额时会被前端浮点化。
type AssetSeriesPoint struct {
	Month       string `json:"month"`       // "YYYY-MM"
	Assets      string `json:"assets"`      // ΣAssets，正
	Liabilities string `json:"liabilities"` // ΣLiabilities，负（不取 abs）
	Net         string `json:"net"`         // assets + liabilities，严格相加
}

// AssetSeriesView 是 GET /api/assets/series 的响应。points **恒 12 个**
// （没有交易的月份也出现，值为 "0.00"）：前端画线不能缺点，缺了会断线或压缩横轴。
type AssetSeriesView struct {
	Commodity string             `json:"commodity"`
	Points    []AssetSeriesPoint `json:"points"`
}

// assetSeriesMonths 是固定的点数（一年 12 个月）。
const assetSeriesMonths = 12

// assetSeriesDecimals 是输出金额的小数位数。
const assetSeriesDecimals = 2

// yearOnlyRE 是年份参数的合法形状（四位数字）。
var yearOnlyRE = regexp.MustCompile(`^\d{4}$`)

const (
	// assetSeriesMinYear / assetSeriesMaxYear 是允许的年份闭区间。
	//
	// 上限取 9998 而不是 9999：月度扫描的上界是「次年 1 月 1 日」，用
	// "%04d-01-01" 格式化 year+1；9999 会写出 5 位年份 "10000-01-01"，
	// 而 SQLite 里 t.date 是 'YYYY-MM-DD' 文本、比较是字典序 —— 5 位年份会
	// 把整个比较关系打乱（"10000-01-01" < "2026-01-01"），序列会静默变全 0。
	assetSeriesMinYear = 1000
	assetSeriesMaxYear = 9998
)

// AssetSeries 计算某年 1..12 月的资产 / 负债 / 净资产月末末值。
//
// year 为四位年份字符串（必填，非法 → 400）；commodity 缺省取账本
// default_commodity（账本未设置且未显式指定 → 400，绝不猜一个币种出来）。
func (s *Service) AssetSeries(ledgerID int64, year string, commodity string) (AssetSeriesView, error) {
	rawYear := strings.TrimSpace(year)
	if !yearOnlyRE.MatchString(rawYear) {
		return AssetSeriesView{}, domain.Invalidf("year 必须是四位年份（如 2026）")
	}
	yearValue, err := strconv.Atoi(rawYear)
	if err != nil || yearValue < assetSeriesMinYear || yearValue > assetSeriesMaxYear {
		return AssetSeriesView{}, domain.Invalidf(
			"year 需在 %d~%d 之间", assetSeriesMinYear, assetSeriesMaxYear)
	}

	code := strings.TrimSpace(commodity)
	if code == "" {
		ledger, err := s.repo.LedgerByID(ledgerID)
		if err != nil {
			return AssetSeriesView{}, err
		}
		code = strings.TrimSpace(ledger.DefaultCommodity)
	}
	if code == "" {
		return AssetSeriesView{}, domain.Invalidf("账本未设置默认币种，请显式指定 commodity")
	}

	monthly, err := s.repo.BalancesByMonth(ledgerID, yearValue, code)
	if err != nil {
		return AssetSeriesView{}, err
	}

	points := make([]AssetSeriesPoint, 0, assetSeriesMonths)
	for _, m := range monthly {
		assets := m.Assets
		liabilities := m.Liabilities
		if assets == nil {
			assets = new(big.Rat)
		}
		if liabilities == nil {
			liabilities = new(big.Rat)
		}
		// net 用严格相加（AC-12）—— 绝不对 liabilities 取 abs。
		net := new(big.Rat).Add(assets, liabilities)
		points = append(points, AssetSeriesPoint{
			Month:       m.Month,
			Assets:      assets.FloatString(assetSeriesDecimals),
			Liabilities: liabilities.FloatString(assetSeriesDecimals),
			Net:         net.FloatString(assetSeriesDecimals),
		})
	}

	// 兜底补齐到 12 个点：repository 保证 12 个，但「恒 12 点」是前端画线的硬
	// 前提（缺月会断线），所以在服务边界再守一道，绝不把缺点响应发出去。
	for len(points) < assetSeriesMonths {
		points = append(points, AssetSeriesPoint{
			Month:       fmt.Sprintf("%04d-%02d", yearValue, len(points)+1),
			Assets:      "0.00",
			Liabilities: "0.00",
			Net:         "0.00",
		})
	}
	return AssetSeriesView{Commodity: code, Points: points}, nil
}
