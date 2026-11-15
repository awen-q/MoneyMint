package handler

import (
	"io"
	"net/http"
	"strings"
)

// 导入端点（Beancount → 当前账本 / 新建账本）。
//
// 自 S5 起导入不再豁免账本上下文（AC-6.1）：请求必须带 X-Ledger-Id（缺失回退该用户
// 所属最小有效账本），并由 middleware 校验账本成员身份与 viewer 只读（非 GET 一律 403）。
// target 经查询参数 ?target=current|new 指定，默认 current（导入到当前账本）；
// 撤销经 ?batch_id= 指定要回滚的导入批次。
//
// 两种提交形态都支持（同 S5 前）：JSON {"text"} / multipart file / 原始文本体。

// HandleImportPreview 解析 Beancount 文本并给出导入预览（只读，不写库）。
//
// 返回 200 + {valid, title, target, ledger_name?, new_accounts, reuse_accounts,
// new_transactions, skip_transactions, new_commodities, pad_balance[], conflicts[],
// code?, duplicate?, errors?}。valid=false 时：
//   - errors 非空 = 文件含不支持语法，整体拒绝（列出全部错误行号）；
//   - conflicts 非空 = 与目标账本存在冲突（账户/币种/pad-balance 不支持等），逐项列出。
func (h *Handler) HandleImportPreview(w http.ResponseWriter, r *http.Request) {
	uid, ok := requireUserID(w, r)
	if !ok {
		return
	}
	ledgerID, ok := requireLedgerID(w, r)
	if !ok {
		return
	}
	text, ok := h.receiveBeancountText(w, r)
	if !ok {
		return
	}
	target := r.URL.Query().Get("target")
	prev, err := h.svc.PreviewImport(ledgerID, uid, text, target)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, prev)
}

// HandleImport 执行导入：解析 → 校验 → 单一大事务写入（current 当前账本 / new 新建账本）。
//
// 成功后返回 {mode, ledger_id, ledger_name, import_batch_id, created_transactions,
// skipped_transactions, reused_accounts, new_accounts, new_commodities}。
// 同名账本自动加序号（target=new），绝不覆盖既有数据（RK-M2-05：导入是「新建」不是「替换」）。
func (h *Handler) HandleImport(w http.ResponseWriter, r *http.Request) {
	uid, ok := requireUserID(w, r)
	if !ok {
		return
	}
	ledgerID, ok := requireLedgerID(w, r)
	if !ok {
		return
	}
	text, ok := h.receiveBeancountText(w, r)
	if !ok {
		return
	}
	target := r.URL.Query().Get("target")
	res, err := h.svc.ExecuteImport(ledgerID, uid, text, target)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// HandleImportUndo 撤销一次导入（AC-6.9）：仅回滚本批新建实体与本批交易，不动复用实体。
//
// 通过 ?batch_id= 指定要撤销的导入批次；批次不存在返回 404（import_batch_not_found）。
// 撤销是写操作，viewer 只读被 middleware 拦截（非 GET 一律 403）。
func (h *Handler) HandleImportUndo(w http.ResponseWriter, r *http.Request) {
	uid, ok := requireUserID(w, r)
	if !ok {
		return
	}
	ledgerID, ok := requireLedgerID(w, r)
	if !ok {
		return
	}
	batchID := strings.TrimSpace(r.URL.Query().Get("batch_id"))
	res, err := h.svc.UndoImportBatch(ledgerID, uid, batchID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// receiveBeancountText 从 JSON 体 / multipart 文件 / 原始体中取出 Beancount 文本。
// 失败时已写好响应，返回值 ok=false，调用方不应再写响应。
func (h *Handler) receiveBeancountText(w http.ResponseWriter, r *http.Request) (string, bool) {
	ct := r.Header.Get("Content-Type")
	switch {
	case strings.HasPrefix(ct, "application/json"):
		var body struct {
			Text string `json:"text"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "请求体不是合法 JSON（需 {\"text\": \"...\"}）",
			})
			return "", false
		}
		if strings.TrimSpace(body.Text) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "text 不能为空"})
			return "", false
		}
		return body.Text, true
	case strings.HasPrefix(ct, "multipart/form-data"):
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "表单解析失败（上限 32 MB）"})
			return "", false
		}
		f, _, err := r.FormFile("file")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少上传文件字段 file"})
			return "", false
		}
		defer f.Close()
		raw, err := io.ReadAll(f)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "读取上传文件失败"})
			return "", false
		}
		if strings.TrimSpace(string(raw)) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "上传文件内容为空"})
			return "", false
		}
		return string(raw), true
	default:
		// 原始文本请求体（如 curl 直接 POST 文件内容）
		raw, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "读取请求体失败"})
			return "", false
		}
		if strings.TrimSpace(string(raw)) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请求体不能为空"})
			return "", false
		}
		return string(raw), true
	}
}
