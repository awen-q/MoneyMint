package handler

import (
	"net/http"
	"strconv"

	"familyledger/internal/domain"
)

// HandleListLedgers 列出当前用户所属的全部账本（含角色）。
func (h *Handler) HandleListLedgers(w http.ResponseWriter, r *http.Request) {
	uid, ok := requireUserID(w, r)
	if !ok {
		return
	}
	ledgers, err := h.svc.ListLedgers(uid)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ledgers": ledgers})
}

// HandleCreateLedger 创建新账本（创建者成为 owner）。
func (h *Handler) HandleCreateLedger(w http.ResponseWriter, r *http.Request) {
	uid, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req struct {
		Name             string `json:"name"`
		DefaultCommodity string `json:"default_commodity"`
	}
	if err := readJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}
	ledger, err := h.svc.CreateLedger(uid, req.Name, req.DefaultCommodity)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, ledger)
}

// HandleUpdateLedger 更新账本名称、默认币种与可选期初日期（仅 owner）。
// opening_date 使用指针区分「未传（不改）」与「显式传值」。
func (h *Handler) HandleUpdateLedger(w http.ResponseWriter, r *http.Request) {
	uid, ok := requireUserID(w, r)
	if !ok {
		return
	}
	ledgerID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, domain.Invalidf("无效的账本 id"))
		return
	}
	var req struct {
		Name             string  `json:"name"`
		DefaultCommodity string  `json:"default_commodity"`
		OpeningDate      *string `json:"opening_date"`
	}
	if err := readJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}
	ledger, err := h.svc.UpdateLedger(uid, ledgerID, req.Name, req.DefaultCommodity, req.OpeningDate)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ledger)
}

// HandleDeleteLedger 软删账本（0.6.0 S1，仅 owner）。
// 成员门禁 / 禁删最后一个账本 / 删除前一致性快照均由 service 层按序保证；
// 前端另需输入账本名确认词（AC-1.3），本端点不接收确认词（设计 §3.5）。
func (h *Handler) HandleDeleteLedger(w http.ResponseWriter, r *http.Request) {
	uid, ok := requireUserID(w, r)
	if !ok {
		return
	}
	ledgerID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || ledgerID <= 0 {
		writeError(w, domain.Invalidf("无效的账本 id"))
		return
	}
	if err := h.svc.DeleteLedger(uid, ledgerID); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
