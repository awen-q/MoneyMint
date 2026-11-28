package handler

import (
	"bytes"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"familyledger/internal/domain"
)

// captureSlogForHandler 临时替换 slog 默认 logger，测试结束还原。
// handler 包无 t.Parallel，全局替换安全。
func captureSlogForHandler(t *testing.T) *bytes.Buffer {
	t.Helper()
	prev := slog.Default()
	buf := &bytes.Buffer{}
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return buf
}

// TestWriteErrorLogsUnmappedError 验证未知错误（落到 statusOf 默认 400）留下一条 ERROR，
// 且响应体与状态码不变（纯副作用）。
func TestWriteErrorLogsUnmappedError(t *testing.T) {
	buf := captureSlogForHandler(t)
	w := httptest.NewRecorder()

	WriteError(w, errors.New("db exploded"))

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "db exploded") {
		t.Fatalf("响应体应原样含错误文本，实际 %q", w.Body.String())
	}
	line := buf.String()
	for _, want := range []string{"level=ERROR", "msg=http.error", "event=http.error", "db exploded"} {
		if !strings.Contains(line, want) {
			t.Fatalf("日志缺少 %q，实际:\n%s", want, line)
		}
	}
}

// TestWriteErrorDoesNotLogExpectedBusinessErrors 验证已知业务错误不记 ERROR，
// 避免把正常 4xx / 客户端校验失败变成日志噪声。
func TestWriteErrorDoesNotLogExpectedBusinessErrors(t *testing.T) {
	cases := []struct {
		name string
		err  error
	}{
		{"not_found", domain.ErrNotFound},
		{"conflict", domain.ErrConflict},
		{"unauthorized", domain.ErrUnauthorized},
		{"forbidden", domain.ErrForbidden},
		{"invalid", domain.Invalidf("参数错了")},
		{"coded", domain.Codedf(domain.ErrInvalid, "bad_code", "带码校验失败")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			buf := captureSlogForHandler(t)
			w := httptest.NewRecorder()
			WriteError(w, tc.err)
			if strings.Contains(buf.String(), "level=ERROR") {
				t.Fatalf("%s 不应记 ERROR:\n%s", tc.name, buf.String())
			}
		})
	}
}
