package handler

import (
	"net/http"

	"familyledger/internal/auth"
	"familyledger/internal/domain"
)

// HandleAssetSeries 返回资产统计页的年度分币种资产 / 负债 / 净资产月度序列
// （GET /api/assets/series?year=YYYY&commodity=CNY，viewer 可读）。
//
// year 必填、commodity 缺省取账本 default_commodity；金额为定点两位字符串。
// 参数校验（年份形状 / 区间 / 缺省币种解析）在 service 层统一完成。
func (h *Handler) HandleAssetSeries(w http.ResponseWriter, r *http.Request) {
	ledgerID, ok := auth.LedgerID(r.Context())
	if !ok {
		writeError(w, domain.ErrForbidden)
		return
	}
	query := r.URL.Query()
	view, err := h.svc.AssetSeries(ledgerID, query.Get("year"), query.Get("commodity"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}
