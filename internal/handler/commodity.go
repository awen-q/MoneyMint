package handler

import (
	"net/http"

	"familyledger/internal/auth"
	"familyledger/internal/domain"
)

// HandleListCommodities 列出账本内币种及其引用状态（GET /api/commodities，viewer 可读）。
func (h *Handler) HandleListCommodities(w http.ResponseWriter, r *http.Request) {
	ledgerID, ok := auth.LedgerID(r.Context())
	if !ok {
		writeError(w, domain.ErrForbidden)
		return
	}
	commodities, err := h.svc.ListCommodities(ledgerID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"commodities": commodities})
}

// HandleCreateCommodity 新增币种（POST /api/commodities，非 viewer）。
// viewer 写拦截由 authMiddleware 统一保证，本层不重复鉴权。
func (h *Handler) HandleCreateCommodity(w http.ResponseWriter, r *http.Request) {
	ledgerID, ok := auth.LedgerID(r.Context())
	if !ok {
		writeError(w, domain.ErrForbidden)
		return
	}
	var req struct {
		Symbol    string `json:"symbol"`
		Name      string `json:"name"`
		Precision int    `json:"precision"`
	}
	if err := readJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}
	view, err := h.svc.CreateCommodity(ledgerID, req.Symbol, req.Name, req.Precision)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, view)
}

// HandleDeleteCommodity 软删币种（DELETE /api/commodities/{uuid}，非 viewer）。
// 重复删除由 service 返回 ErrNotFound，writeError 统一映射为幂等 404。
func (h *Handler) HandleDeleteCommodity(w http.ResponseWriter, r *http.Request) {
	ledgerID, ok := auth.LedgerID(r.Context())
	if !ok {
		writeError(w, domain.ErrForbidden)
		return
	}
	if err := h.svc.DeleteCommodity(ledgerID, r.PathValue("uuid")); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
