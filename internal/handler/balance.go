package handler

import (
	"net/http"

	"familyledger/internal/auth"
	"familyledger/internal/domain"
	"familyledger/internal/service"
)

// HandleGetBalance 读取「截至 D 日初」的余额校准预检
// （GET /api/accounts/{uuid}/balance?as_of_date=D，viewer 可读）。
func (h *Handler) HandleGetBalance(w http.ResponseWriter, r *http.Request) {
	ledgerID, ok := auth.LedgerID(r.Context())
	if !ok {
		writeError(w, domain.ErrForbidden)
		return
	}
	view, err := h.svc.GetBalanceCalibration(
		ledgerID, r.PathValue("uuid"), r.URL.Query().Get("as_of_date"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// HandleSetBalance 设置/修正余额校准（POST /api/accounts/{uuid}/balance，非 viewer）。
// viewer 的写拦截由 authMiddleware 统一保证，本层不重复鉴权。
func (h *Handler) HandleSetBalance(w http.ResponseWriter, r *http.Request) {
	ledgerID, ok := auth.LedgerID(r.Context())
	if !ok {
		writeError(w, domain.ErrForbidden)
		return
	}
	var req struct {
		AsOfDate string `json:"as_of_date"`
		Targets  []struct {
			Commodity     string `json:"commodity"`
			TargetBalance string `json:"target_balance"`
		} `json:"targets"`
	}
	if err := readJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}
	targets := make([]service.BalanceTargetInput, 0, len(req.Targets))
	for _, t := range req.Targets {
		targets = append(targets, service.BalanceTargetInput{
			Commodity: t.Commodity, TargetBalance: t.TargetBalance,
		})
	}
	userID := int64(0)
	if uid, ok := auth.UserID(r.Context()); ok {
		userID = uid
	}
	result, err := h.svc.SetBalanceCalibration(ledgerID, r.PathValue("uuid"), service.BalanceInput{
		AsOfDate: req.AsOfDate, Targets: targets, UserID: userID,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
